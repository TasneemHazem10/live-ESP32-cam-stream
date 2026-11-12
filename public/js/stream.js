import { absoluteUrl, api, wsUrl } from './runtime.js';

const WS_MAX_RECONNECTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Browsers throttle setTimeout/setInterval in hidden tabs down to ~1 frame per
// second (and ~1 per minute after a while). That makes the phone's view freeze
// whenever the laptop tab is in the background. This worker is driven by the
// camera track itself (via MediaStreamTrackProcessor) instead of a timer, so
// the relay keeps receiving a smooth stream while the laptop tab is hidden.
const PUBLISH_WORKER_SOURCE = `
let canvas = null;
let ctx = null;
let lastSent = 0;
let stopped = false;

async function pump(data) {
  const { readable, endpoint, device, maxWidth, quality, interval } = data;
  const reader = readable.getReader();
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || stopped) break;
      if (!frame) continue;
      try {
        const vw = frame.displayWidth || frame.width || 0;
        const vh = frame.displayHeight || frame.height || 0;
        const now = performance.now();
        // Throttle uploads to the requested interval but always drain frames
        // so the track never backs up.
        if (!vw || !vh || now - lastSent < interval) {
          frame.close();
          continue;
        }
        const scale = Math.min(1, maxWidth / vw);
        const w = Math.max(2, Math.round(vw * scale));
        const h = Math.max(2, Math.round(vh * scale));
        if (!canvas) {
          canvas = new OffscreenCanvas(w, h);
          ctx = canvas.getContext('2d', { alpha: false });
        }
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.drawImage(frame, 0, 0, w, h);
        frame.close();
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        if (!blob) continue;
        lastSent = performance.now();
        const res = await fetch(
          endpoint + '?device=' + encodeURIComponent(device) + '&w=' + w + '&h=' + h,
          { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob, cache: 'no-store' },
        );
        if (res.ok) {
          postMessage({ type: 'frame' });
        } else {
          const payload = await res.json().catch(() => ({}));
          postMessage({ type: 'error', status: res.status, message: payload.message || 'HTTP ' + res.status });
          if (res.status === 403 || res.status === 404) break;
        }
      } catch (error) {
        try { frame.close(); } catch (e) {}
        postMessage({ type: 'error', message: String((error && error.message) || error) });
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'start') {
    pump(data).catch((error) => postMessage({ type: 'error', message: String((error && error.message) || error) }));
  } else if (data.type === 'stop') {
    stopped = true;
  }
};
`;

let livekitLoader = null;

/** Load the LiveKit browser SDK from the local relay (no CDN needed). */
function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if (livekitLoader) return livekitLoader;

  livekitLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = api('/vendor/livekit-client.umd.js');
    script.async = true;
    script.onload = () => {
      if (window.LivekitClient) resolve(window.LivekitClient);
      else reject(new Error('LiveKit SDK did not initialise'));
    };
    script.onerror = () => reject(new Error('Could not load the LiveKit SDK'));
    document.head.appendChild(script);
  });

  return livekitLoader;
}

async function fetchLiveKitToken(role, label) {
  const identity = `${role}-${label || ''}${Math.random().toString(36).slice(2, 9)}`;
  const response = await fetch(
    api(`/api/livekit/token?role=${encodeURIComponent(role)}&identity=${encodeURIComponent(identity)}`),
    { cache: 'no-store' },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) {
    throw new Error(payload.message || `LiveKit token request failed (HTTP ${response.status})`);
  }
  return payload;
}

export class LiveStream {
  constructor({ onFrame, onState, onStats, onError, onSensor } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onState = onState || (() => {});
    this.onStats = onStats || (() => {});
    this.onError = onError || (() => {});
    this.onSensor = onSensor || (() => {});

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
    this.firstFrameTimer = null;
    this.rtcPeerId = null;

    // LiveKit / laptop camera state
    this.lkRoom = null;
    this.lkPublisherRoom = null;
    this.lkVideo = null;
    this.lkRaf = null;
    this.lkLastPaint = 0;
    this.lkReconnects = 0;
    this.lkReconnectTimer = null;
    this.localStream = null;
    this.localVideo = null;

    // Laptop → relay JPEG publisher (lets every other device watch this webcam)
    this.publishTimer = null;
    this.publishWorker = null;
    this.publishCanvas = null;
    this.publishCtx = null;
    this.publishBusy = false;
    this.publishStopped = true;
    this.publishFailures = 0;
    this.publishFrames = 0;

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
    this.lkReconnects = 0;
    this.lastStateKey = '';
    this.setState('connecting');

    this.statsTimer = setInterval(() => this.reportStats(run), 1000);

    // The camera belongs to this laptop, not to the selected transport. Keep
    // publishing it in the background while the laptop previews another mode.
    if (this.localStream && this.localVideo) {
      this.startRelayPublisher(this.localVideo, run);
    }

    if (mode === 'camera') {
      this.startLocalCamera(run).catch((error) => this.fail(error, run));
    } else if (mode === 'livekit') {
      this.startLiveKit(run).catch((error) => this.fail(error, run));
    } else if (mode === 'webrtc') {
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
    if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
    this.statsTimer = null;
    this.reconnectTimer = null;
    this.mjpegTimer = null;
    this.pollTimer = null;
    this.firstFrameTimer = null;

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

    // Keep the laptop camera sharing alive across viewer/transport switches;
    // only the viewer connection and local preview pump are stopped here.
    this.stopViewer();

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
      code: error?.code || error?.name || 'stream_error',
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

    // A socket can open while no frames arrive (the camera is off). If no
    // binary frame shows up shortly after connecting, report it so the UI can
    // keep the "waiting" panel instead of pretending to be live.
    this.firstFrameTimer = setTimeout(() => {
      if (!this.started || run !== this.runId) return;
      if (this.frameCount > 0) return;
      this.fail(
        { code: 'ws_no_frames', message: 'WebSocket connected but no frames arrived' },
        run,
      );
    }, 4000);

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
      if (this.firstFrameTimer) {
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = null;
      }
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
      if (this.firstFrameTimer) {
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = null;
      }
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

    // Serverless hosts buffer long-lived multipart responses, so the <img>
    // may never fire load even though the request returns HTTP 200. If the
    // first frame does not paint, let the app fall back to HTTP polling.
    this.firstFrameTimer = setTimeout(() => {
      if (!this.started || run !== this.runId || loads > 0) return;
      this.fail(
        { code: 'mjpeg_no_frames', message: 'MJPEG connected but no frames arrived' },
        run,
      );
    }, 5000);

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

      let received = false;
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
        received = true;
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
          // Poll at ~5 fps while frames flow; back off to ~1 Hz while the camera
          // is off so an idle dashboard does not hammer the relay.
          this.pollTimer = setTimeout(tick, received ? 200 : 1000);
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

  /* ------------------------------------------------------------------ */
  /* Laptop camera + LiveKit                                            */
  /* ------------------------------------------------------------------ */

  stopWorkerPublisher() {
    if (this.publishWorker) {
      try {
        this.publishWorker.postMessage({ type: 'stop' });
        this.publishWorker.terminate();
      } catch {
        /* ignore */
      }
      this.publishWorker = null;
    }
  }

  stopRelayPublisher() {
    this.stopWorkerPublisher();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.publishBusy = false;
    this.publishStopped = true;
    this.publishFailures = 0;
    if (this.publishCanvas) {
      this.publishCanvas.width = 0;
      this.publishCanvas.height = 0;
    }
    this.publishCanvas = null;
    this.publishCtx = null;
  }

  /**
   * Publish the camera track from a worker so it keeps running at full speed
   * while the laptop dashboard tab is hidden. Returns false when the browser
   * does not support the track processor, so the caller can fall back.
   */
  startWorkerPublisher(video, run) {
    const track = video?.srcObject?.getVideoTracks?.()[0];
    if (!track) return false;
    if (
      typeof MediaStreamTrackProcessor !== 'function' ||
      typeof Worker !== 'function' ||
      typeof OffscreenCanvas !== 'function'
    ) {
      return false;
    }

    let readable;
    try {
      const processor = new MediaStreamTrackProcessor({ track });
      readable = processor.readable;
    } catch {
      return false;
    }
    if (!readable || typeof readable.getReader !== 'function') return false;

    let worker;
    let url;
    try {
      const blob = new Blob([PUBLISH_WORKER_SOURCE], { type: 'text/javascript' });
      url = URL.createObjectURL(blob);
      worker = new Worker(url);
    } catch {
      if (url) URL.revokeObjectURL(url);
      return false;
    }

    this.publishWorker = worker;
    this.publishStopped = false;
    this.publishFailures = 0;
    this.publishFrames = 0;

    worker.onmessage = (event) => {
      if (!this.started || run !== this.runId || this.publishStopped) return;
      const data = event.data || {};
      if (data.type === 'frame') {
        this.publishFailures = 0;
        this.publishFrames += 1;
        return;
      }
      if (data.type !== 'error') return;
      this.publishFailures += 1;
      const fatal = data.status === 403 || data.status === 404;
      if (fatal) {
        this.publishStopped = true;
        this.stopWorkerPublisher();
      }
      if (this.publishFailures === 3 || fatal) {
        this.onError({
          code: 'relay_publish_failed',
          message: data.message || 'Relay rejected the camera frame',
          mode: 'camera',
          soft: !fatal,
        });
      }
    };

    worker.onerror = () => {
      // Worker failed to start; fall back to the timer publisher next time.
      if (!this.publishStopped) {
        this.stopWorkerPublisher();
      }
    };

    try {
      worker.postMessage(
        {
          type: 'start',
          readable,
          endpoint: absoluteUrl(api('/api/laptop/frame')),
          device: 'LAPTOP-CAM',
          maxWidth: 640,
          quality: 0.65,
          interval: 200,
        },
        [readable],
      );
    } catch {
      this.stopWorkerPublisher();
      return false;
    }
    return true;
  }

  /** Stop the viewer connection and the local render pump, not the camera. */
  stopViewer() {
    if (this.lkRaf) cancelAnimationFrame(this.lkRaf);
    if (this.lkReconnectTimer) clearTimeout(this.lkReconnectTimer);
    this.lkRaf = null;
    this.lkReconnectTimer = null;

    if (this.lkVideo) {
      this.lkVideo.pause?.();
      this.lkVideo.srcObject = null;
      this.lkVideo.remove();
    }
    this.lkVideo = null;

    if (this.lkRoom) {
      try {
        this.lkRoom.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.lkRoom = null;
    this.lkLastPaint = 0;
  }

  /** Explicitly release the laptop camera and stop sharing it. */
  stopCamera() {
    this.stopRelayPublisher();

    if (this.lkPublisherRoom) {
      try {
        this.lkPublisherRoom.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.lkPublisherRoom = null;

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this.localStream = null;

    if (this.localVideo) {
      this.localVideo.pause?.();
      this.localVideo.srcObject = null;
      this.localVideo.remove();
    }
    this.localVideo = null;
  }

  get cameraActive() {
    return Boolean(this.localStream);
  }

  handleLiveKitData(payload) {
    try {
      let bytes = payload;
      if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload);
      if (!(bytes instanceof Uint8Array)) return;
      const message = JSON.parse(new TextDecoder().decode(bytes));
      if (message?.type === 'sensor' && message.readings) {
        this.onSensor(message);
      }
    } catch {
      /* ignore malformed data */
    }
  }

  startLiveKitPump(run, source) {
    if (this.lkRaf) cancelAnimationFrame(this.lkRaf);
    const pump = (now) => {
      if (!this.started || run !== this.runId) return;
      const element = source || this.lkVideo || this.localVideo;
      if (element && element.readyState >= 2 && element.videoWidth) {
        // ~25 fps is plenty for the dashboard canvas and keeps CPU cool.
        if (!this.lkLastPaint || now - this.lkLastPaint > 40) {
          this.lkLastPaint = now;
          this.emitFrame(
            element,
            {
              width: element.videoWidth,
              height: element.videoHeight,
              ts: Date.now(),
              source: 'live',
            },
            'image',
          );
        }
      }
      this.lkRaf = requestAnimationFrame(pump);
    };
    this.lkRaf = requestAnimationFrame(pump);
  }

  attachLiveKitVideo(track, run) {
    const LivekitClient = window.LivekitClient;
    if (!this.lkVideo) {
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', 'true');
      video.style.cssText =
        'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;inset-inline-start:-10px;';
      document.body.appendChild(video);
      this.lkVideo = video;
    }

    track.attach(this.lkVideo);
    this.lastSource = 'live';
    this.lkVideo.play().catch(() => {});
    // Some browsers only expose frames after metadata loads.
    this.lkVideo.addEventListener('loadeddata', () => {
      if (run === this.runId) this.startLiveKitPump(run, this.lkVideo);
    }, { once: true });
    this.startLiveKitPump(run, this.lkVideo);
  }

  async startLiveKit(run) {
    if (!this.started || run !== this.runId) return;

    const configResponse = await fetch(api('/api/livekit/config'), { cache: 'no-store' });
    const config = await configResponse.json().catch(() => ({}));
    if (!config.enabled) {
      throw Object.assign(new Error('LiveKit is not configured on the server'), {
        code: 'livekit_not_configured',
      });
    }

    const LivekitClient = await loadLiveKit();
    if (!this.started || run !== this.runId) return;

    const info = await fetchLiveKitToken('viewer', 'viewer-');
    if (!this.started || run !== this.runId) return;

    const room = new LivekitClient.Room({
      adaptiveStream: false,
      dynacast: false,
    });
    this.lkRoom = room;
    this.lastSource = 'live';

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      if (run !== this.runId) return;
      if (track.kind === 'video' || track.kind === LivekitClient.Track.Kind.Video) {
        this.attachLiveKitVideo(track, run);
      }
    });

    room.on(LivekitClient.RoomEvent.DataReceived, (payload) => {
      if (run !== this.runId) return;
      this.handleLiveKitData(payload);
    });

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      if (run !== this.runId || !this.started) return;
      this.connected = false;
      this.scheduleLiveKitReconnect(run);
    });

    await room.connect(info.url, info.token, { autoSubscribe: true });
    if (!this.started || run !== this.runId) {
      try {
        room.disconnect();
      } catch {
        /* ignore */
      }
      return;
    }

    this.lkReconnects = 0;
    this.setState('connecting');
  }

  scheduleLiveKitReconnect(run) {
    if (!this.started || run !== this.runId || this.lkReconnectTimer) return;
    this.lkReconnects += 1;
    if (this.lkReconnects > 4) {
      this.fail({ code: 'livekit_failed', message: 'LiveKit connection lost' }, run);
      return;
    }
    this.setState('reconnecting');
    this.lkReconnectTimer = setTimeout(() => {
      this.lkReconnectTimer = null;
      if (!this.started || run !== this.runId) return;
      this.startLiveKit(run).catch((error) => this.fail(error, run));
    }, 2200);
  }

  /**
   * Publish the laptop webcam to the relay as JPEG frames.
   *
   * The local preview already renders from the <video> element. This loop only
   * exists so phones and other computers can watch the same camera through the
   * relay transport they already use (WebSocket / MJPEG / polling / WebRTC).
   * It is intentionally lightweight: ~5 fps at up to 640 px wide.
   */
  startRelayPublisher(video, run) {
    this.stopRelayPublisher();
    if (!this.started || run !== this.runId) return;

    // Track-driven worker first: it keeps publishing while the tab is hidden.
    if (this.startWorkerPublisher(video, run)) return;

    // Fallback for browsers without MediaStreamTrackProcessor/OffscreenCanvas.
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    this.publishCanvas = canvas;
    this.publishCtx = ctx;
    this.publishStopped = false;
    this.publishFailures = 0;
    this.publishFrames = 0;

    const schedule = (delay) => {
      if (!this.started || run !== this.runId || this.publishStopped) return;
      this.publishTimer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (!this.started || run !== this.runId || this.publishStopped) return;
      if (this.publishBusy) {
        schedule(80);
        return;
      }
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
        schedule(150);
        return;
      }

      const maxWidth = 640;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const width = Math.max(2, Math.round(video.videoWidth * scale));
      const height = Math.max(2, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(video, 0, 0, width, height);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.65));
      if (!this.started || run !== this.runId || this.publishStopped) return;
      if (!blob) {
        schedule(250);
        return;
      }

      this.publishBusy = true;
      try {
        const response = await fetch(
          api(`/api/laptop/frame?device=LAPTOP-CAM&w=${width}&h=${height}`),
          {
            method: 'POST',
            headers: { 'content-type': 'image/jpeg' },
            body: blob,
            cache: 'no-store',
          },
        );

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw Object.assign(
            new Error(payload.message || `Relay rejected the frame (HTTP ${response.status})`),
            { status: response.status },
          );
        }

        this.publishFailures = 0;
        this.publishFrames += 1;
        schedule(200); // ~5 fps
      } catch (error) {
        if (!this.started || run !== this.runId || this.publishStopped) return;
        this.publishFailures += 1;

        // A rejected origin or a permanently missing route cannot recover;
        // keep the local preview but stop hammering the relay.
        const fatal = error.status === 403 || error.status === 404 || this.publishFailures >= 12;
        if (this.publishFailures === 3 || (fatal && this.publishFailures > 3)) {
          this.onError({
            code: 'relay_publish_failed',
            message: error.message,
            mode: 'camera',
            soft: !fatal,
          });
        }
        if (fatal) {
          this.publishStopped = true;
          return;
        }
        schedule(Math.min(4000, 300 * 2 ** (this.publishFailures - 1)));
      } finally {
        this.publishBusy = false;
      }
    };

    schedule(400);
  }

  async startLocalCamera(run) {
    if (!this.started || run !== this.runId) return;

    // Already sharing this laptop camera: only resume the local preview.
    if (this.localStream && this.localVideo) {
      this.lastSource = 'live';
      await this.localVideo.play().catch(() => {});
      this.startLiveKitPump(run, this.localVideo);
      this.setState('connected');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not expose a camera (getUserMedia unavailable)');
    }

    const media = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 },
        facingMode: 'user',
      },
    });

    if (!this.started || run !== this.runId) {
      for (const track of media.getTracks()) track.stop();
      return;
    }

    this.localStream = media;
    this.lastSource = 'live';

    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.srcObject = media;
    video.style.cssText =
      'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;inset-inline-start:-10px;';
    document.body.appendChild(video);
    this.localVideo = video;

    await video.play().catch(() => {});
    this.startLiveKitPump(run, video);

    // Share this laptop camera with the relay so every other device on the
    // network (and any remote viewer using WebSocket/MJPEG) sees the same feed.
    this.startRelayPublisher(video, run);
    this.setState('connected');

    // Local preview and LAN sharing already work. Publishing to LiveKit is
    // optional and only fails softly when the API secret is missing.
    this.publishLocalCamera(media, run).catch((error) => {
      this.onError({
        code: 'livekit_publish_failed',
        message: error.message,
        mode: 'camera',
        soft: true,
      });
    });
  }

  async publishLocalCamera(media, run) {
    const configResponse = await fetch(api('/api/livekit/config'), { cache: 'no-store' });
    const config = await configResponse.json().catch(() => ({}));
    if (!config.enabled) return false;

    const LivekitClient = await loadLiveKit();
    if (!this.started || run !== this.runId) return false;

    const info = await fetchLiveKitToken('publisher', 'camera-');
    const room = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });
    // Keep the publisher room separate from the viewer room so switching the
    // laptop to LiveKit viewer mode never disconnects the shared camera.
    if (this.lkPublisherRoom) {
      try {
        this.lkPublisherRoom.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.lkPublisherRoom = room;

    room.on(LivekitClient.RoomEvent.DataReceived, (payload) => {
      if (!this.started) return;
      this.handleLiveKitData(payload);
    });
    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      if (this.started) this.setState('reconnecting');
    });

    await room.connect(info.url, info.token, { autoSubscribe: false });

    const videoTrack = media.getVideoTracks()[0];
    if (videoTrack) {
      await room.localParticipant.publishTrack(videoTrack, {
        name: 'camera',
        simulcast: false,
      });
    }
    return true;
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

