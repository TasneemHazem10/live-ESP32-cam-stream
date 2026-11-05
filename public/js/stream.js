import { api, wsUrl } from './runtime.js';

const WS_MAX_RECONNECTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LiveStream {
  constructor({ onFrame, onState, onStats, onError } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onState = onState || (() => {});
    this.onStats = onStats || (() => {});
    this.onError = onError || (() => {});

    this.mode = 'ws';
    this.started = false;
    this.runId = 0;
    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.mjpegImg = null;
    this.mjpegTimer = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.statsTimer = null;
    this.rtcPeerId = null;

    this.decoding = false;
    this.pendingFrame = null;
    this.wsMeta = null;

    this.frameCount = 0;
    this.byteCount = 0;
    this.lastFrameCount = 0;
    this.lastByteCount = 0;
    this.lastStatsAt = performance.now();
    this.clockOffset = 0;
    this.hasClock = false;
    this.latency = null;
    this.lastSource = 'none';
    this.connected = false;
    this.reconnectAttempts = 0;
    this.lastStateKey = '';
  }

  setClockOffset(offset) {
    if (Number.isFinite(offset)) {
      this.clockOffset = offset;
      this.hasClock = true;
    }
  }

  start(mode = 'ws') {
    this.stop();
    this.started = true;
    this.mode = mode;
    this.runId += 1;
    const run = this.runId;

    this.frameCount = 0;
    this.byteCount = 0;
    this.lastFrameCount = 0;
    this.lastByteCount = 0;
    this.lastStatsAt = performance.now();
    this.latency = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.lastStateKey = '';
    this.setState('connecting');

    this.statsTimer = setInterval(() => this.reportStats(run), 1000);

    if (mode === 'webrtc') {
      this.startWebRtc(run).catch((error) => this.fail(error, run));
    } else if (mode === 'mjpeg') {
      this.startMjpeg(run);
    } else if (mode === 'poll') {
      this.startPolling(run);
    } else {
      this.startWebSocket(run);
    }
  }

  stop() {
    this.started = false;
    this.runId += 1;
    this.connected = false;

    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.mjpegTimer) clearInterval(this.mjpegTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.statsTimer = null;
    this.reconnectTimer = null;
    this.mjpegTimer = null;
    this.pollTimer = null;

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;

    if (this.dc) {
      this.dc.onmessage = null;
      this.dc.onopen = null;
      this.dc.onclose = null;
      try {
        this.dc.close();
      } catch {
        /* ignore */
      }
    }
    this.dc = null;

    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.pc = null;

    if (this.rtcPeerId) {
      fetch(api(`/api/rtc/peer/${encodeURIComponent(this.rtcPeerId)}`), { method: 'DELETE' }).catch(() => {});
      this.rtcPeerId = null;
    }

    if (this.mjpegImg) {
      this.mjpegImg.onload = null;
      this.mjpegImg.onerror = null;
      this.mjpegImg.src = '';
      this.mjpegImg.remove();
    }
    this.mjpegImg = null;

    this.decoding = false;
    this.pendingFrame = null;
    this.wsMeta = null;
  }

  setState(phase, source = this.lastSource) {
    const key = `${phase}:${source}:${this.mode}`;
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.onState({
      phase,
      source,
      mode: this.mode,
      connected: this.connected,
    });
  }

  fail(error, run) {
    if (!this.started || run !== this.runId) return;
    this.connected = false;
    this.setState('error');
    this.onError({
      code: error?.code || 'stream_error',
      message: error?.message || String(error),
      mode: this.mode,
    });
  }

  reportStats(run) {
    if (!this.started || run !== this.runId) return;
    const now = performance.now();
    const dt = Math.max(0.2, (now - this.lastStatsAt) / 1000);
    const fps = (this.frameCount - this.lastFrameCount) / dt;
    const bitrateKbps = Math.round(((this.byteCount - this.lastByteCount) * 8) / 1000 / dt);

    this.lastFrameCount = this.frameCount;
    this.lastByteCount = this.byteCount;
    this.lastStatsAt = now;

    this.onStats({
      fps: Math.round(fps * 10) / 10,
      latency: this.latency,
      bitrateKbps: Math.max(0, bitrateKbps),
      frames: this.frameCount,
      mode: this.mode,
      connected: this.connected,
      source: this.lastSource,
    });
  }

  emitFrame(bitmap, meta = {}, kind = 'bitmap') {
    if (!this.started) return;
    const source = meta.source || this.lastSource;
    if (source && source !== 'none') this.lastSource = source;

    this.frameCount += 1;
    this.connected = true;

    if (Number.isFinite(meta.ts) && this.hasClock) {
      const value = Date.now() + this.clockOffset - meta.ts;
      if (value >= 0 && value < 60_000) {
        this.latency = this.latency === null ? value : this.latency * 0.72 + value * 0.28;
      }
    }

    try {
      this.onFrame(bitmap, { ...meta, source: this.lastSource });
    } finally {
      if (kind === 'bitmap') bitmap.close?.();
    }

    this.setState('connected', this.lastSource);
  }

  /* ------------------------------------------------------------------ */
  /* WebSocket                                                           */
  /* ------------------------------------------------------------------ */

  startWebSocket(run) {
    if (!this.started || run !== this.runId) return;

    const socket = new WebSocket(wsUrl('/ws/frames'));
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      if (run !== this.runId) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.setState('connected');
    };

    socket.onmessage = (event) => {
      if (run !== this.runId) return;
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'hello') {
            this.setClockOffset(message.serverTime - Date.now());
            if (message.camera?.source) this.lastSource = message.camera.source;
          } else if (message.type === 'frame') {
            this.wsMeta = message;
            if (message.source) this.lastSource = message.source;
          }
        } catch {
          /* ignore malformed text */
        }
        return;
      }

      if (!(event.data instanceof ArrayBuffer)) return;
      this.byteCount += event.data.byteLength;
      this.queueDecode(event.data, this.wsMeta, run);
    };

    socket.onerror = () => {
      if (run !== this.runId) return;
      this.scheduleReconnect(run);
    };

    socket.onclose = () => {
      if (run !== this.runId) return;
      this.connected = false;
      this.scheduleReconnect(run);
    };
  }

  scheduleReconnect(run) {
    if (!this.started || run !== this.runId) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;

    if (this.reconnectAttempts > WS_MAX_RECONNECTS) {
      this.fail({ code: 'ws_failed', message: 'WebSocket relay unreachable' }, run);
      return;
    }

    this.setState('reconnecting');
    const delay = Math.min(8000, 700 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startWebSocket(run);
    }, delay);
  }

  async queueDecode(buffer, meta, run) {
    if (!this.started || run !== this.runId) return;

    if (this.decoding) {
      // Keep only the newest frame while the decoder is busy.
      this.pendingFrame = { buffer, meta };
      return;
    }

    this.decoding = true;
    let current = { buffer, meta };

    while (current && this.started && run === this.runId) {
      try {
        const blob = new Blob([current.buffer], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        if (!this.started || run !== this.runId) {
          bitmap.close?.();
          break;
        }
        this.emitFrame(bitmap, current.meta || {}, 'bitmap');
      } catch (error) {
        this.fail({ code: 'decode_failed', message: `JPEG decode failed: ${error.message}` }, run);
        break;
      }
      current = this.pendingFrame;
      this.pendingFrame = null;
    }

    this.decoding = false;
  }

  /* ------------------------------------------------------------------ */
  /* MJPEG                                                               */
  /* ------------------------------------------------------------------ */

  startMjpeg(run) {
    if (!this.started || run !== this.runId) return;

    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;inset-inline-start:-10px;';
    document.body.appendChild(image);
    this.mjpegImg = image;

    let loads = 0;
    image.onload = () => {
      if (run !== this.runId || !this.started) return;
      loads += 1;
      this.emitFrame(image, {
        width: image.naturalWidth,
        height: image.naturalHeight,
        ts: Date.now(),
        source: this.lastSource === 'demo' ? 'live' : this.lastSource,
      }, 'image');
    };

    image.onerror = () => {
      if (run !== this.runId || !this.started) return;
      this.connected = false;
      this.setState('reconnecting');
      setTimeout(() => {
        if (run === this.runId && this.started) image.src = api(`/stream.mjpeg?t=${Date.now()}`);
      }, 1500);
    };

    image.src = api(`/stream.mjpeg?t=${Date.now()}`);

    // Safari/older engines do not always fire `load` for multipart images.
    // If that happens, paint the current image on a timer instead.
    setTimeout(() => {
      if (run !== this.runId || !this.started || loads >= 2) return;
      this.mjpegTimer = setInterval(() => {
        if (run !== this.runId || !this.started) return;
        if (image.complete && image.naturalWidth > 0) {
          this.emitFrame(image, {
            width: image.naturalWidth,
            height: image.naturalHeight,
            ts: Date.now(),
            source: this.lastSource,
          }, 'image');
        }
      }, 100);
    }, 1800);
  }

  /* ------------------------------------------------------------------ */
  /* HTTP polling                                                        */
  /* ------------------------------------------------------------------ */

  startPolling(run) {
    if (!this.started || run !== this.runId) return;

    const tick = async () => {
      if (!this.started || run !== this.runId) return;

      try {
        const response = await fetch(api(`/api/frame.jpg?t=${Date.now()}`), { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        const headerTime = Number(response.headers.get('x-frame-time'));
        const source = response.headers.get('x-frame-source') || this.lastSource;
        this.byteCount += blob.size;

        const bitmap = await createImageBitmap(blob);
        if (!this.started || run !== this.runId) {
          bitmap.close?.();
          return;
        }
        this.lastSource = source;
        this.emitFrame(bitmap, {
          width: bitmap.width,
          height: bitmap.height,
          ts: Number.isFinite(headerTime) && headerTime > 0 ? headerTime : Date.now(),
          source,
        }, 'bitmap');
      } catch {
        this.connected = false;
        this.setState('reconnecting');
      } finally {
        if (this.started && run === this.runId) {
          this.pollTimer = setTimeout(tick, 140);
        }
      }
    };

    tick();
  }

  /* ------------------------------------------------------------------ */
  /* WebRTC                                                              */
  /* ------------------------------------------------------------------ */

  async startWebRtc(run) {
    if (!this.started || run !== this.runId) return;

    const configResponse = await fetch(api('/api/rtc/config'), { cache: 'no-store' });
    if (!configResponse.ok) throw new Error(`WebRTC config failed (HTTP ${configResponse.status})`);
    const rtcConfig = await configResponse.json();
    if (!rtcConfig.available) throw new Error('WebRTC is not available on this server');

    const pc = new RTCPeerConnection({
      iceServers: rtcConfig.iceServers || [],
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;

    const channel = pc.createDataChannel('frames', { ordered: false, maxRetransmits: 0 });
    channel.binaryType = 'arraybuffer';
    this.dc = channel;

    let receivedAny = false;
    const frameGuard = setTimeout(() => {
      if (run !== this.runId || receivedAny) return;
      this.fail({ code: 'rtc_no_frames', message: 'WebRTC connected but no frames arrived' }, run);
    }, 20_000);

    channel.onopen = () => {
      if (run !== this.runId) return;
      this.connected = true;
      this.setState('connected');
    };

    channel.onclose = () => {
      if (run !== this.runId) return;
      this.connected = false;
      this.setState('reconnecting');
    };

    channel.onmessage = (event) => {
      if (run !== this.runId) return;
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'status' && message.source) this.lastSource = message.source;
          if (Number.isFinite(message.ts)) this.setClockOffset(message.ts - Date.now());
        } catch {
          /* ignore */
        }
        return;
      }

      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 13) return;
      const view = new DataView(event.data);
      const seq = view.getUint32(0);
      const ts = view.getFloat64(4);
      const jpeg = event.data.slice(12);
      receivedAny = true;
      clearTimeout(frameGuard);
      this.byteCount += event.data.byteLength;
      this.queueDecode(jpeg, { ts, seq, source: this.lastSource }, run);
    };

    pc.onconnectionstatechange = () => {
      if (run !== this.runId) return;
      if (pc.connectionState === 'failed') {
        this.fail({ code: 'rtc_failed', message: 'WebRTC connection failed' }, run);
      } else if (pc.connectionState === 'disconnected') {
        this.connected = false;
        this.setState('reconnecting');
      } else if (pc.connectionState === 'connected') {
        this.connected = true;
        this.setState('connected');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc, 6000);

    if (!this.started || run !== this.runId) return;

    const response = await fetch(api('/api/rtc/offer'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp,
      }),
    });
    const answer = await response.json();
    if (!response.ok || !answer.sdp) {
      throw new Error(answer.message || `WebRTC signalling failed (HTTP ${response.status})`);
    }

    this.rtcPeerId = answer.id || null;
    await pc.setRemoteDescription({ type: answer.type || 'answer', sdp: answer.sdp });

    if (rtcConfig.turn === false) {
      this.onError({
        code: 'turn_missing',
        message: 'Metered TURN is not configured; using STUN only',
        mode: 'webrtc',
        soft: true,
      });
    }
  }

  waitForIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      function check() {
        if (pc.iceGatheringState === 'complete') done();
      }
      pc.addEventListener('icegatheringstatechange', check);
    });
  }
}

