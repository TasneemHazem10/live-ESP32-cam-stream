import jpeg from 'jpeg-js';
import { config } from './config.js';
import { rgb565ToRgba } from './rgb565.js';

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/**
 * Keeps the newest camera frame in memory and fans it out to every client.
 *
 * Frames are stored as JPEG because that is the only format browsers can paint
 * cheaply at 10-15 fps. The hub also owns the optional synthetic "demo signal"
 * so the product page is alive before the ESP32 is powered on.
 */
export class FrameHub {
  constructor() {
    this.latest = null;
    this.seq = 0;
    this.frames = 0;
    this.realFrames = 0;
    this.frameTimes = [];
    this.byteLog = [];
    this.lastRealAt = 0;
    this.listeners = new Set();
    this.subscribers = new Set();
    this.rgba = null;
    this.demoTimer = null;
    this.demoTime = 0;
    this.demoWidth = config.defaultWidth;
    this.demoHeight = config.defaultHeight;
    this.startedAt = Date.now();
  }

  start() {
    if (!config.demoFallback || this.demoTimer) return;
    const interval = Math.max(60, Math.round(1000 / config.demoFps));
    this.demoTimer = setInterval(() => this.renderDemoIfNeeded(), interval);
    this.demoTimer.unref?.();
  }

  stop() {
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = null;
    for (const sub of this.subscribers) sub.close();
    this.subscribers.clear();
    this.listeners.clear();
  }

  onFrame(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribe() {
    const queue = [];
    let waiter = null;
    let closed = false;

    const settle = (value) => {
      if (!waiter) return false;
      const current = waiter;
      waiter = null;
      if (current.timer) clearTimeout(current.timer);
      current.resolve(value);
      return true;
    };

    const sub = {
      push: (frame) => {
        if (closed) return;
        if (!settle(frame)) {
          if (queue.length >= 2) queue.shift();
          queue.push(frame);
        }
      },
      next: (timeoutMs = 8000) =>
        new Promise((resolve) => {
          if (closed) return resolve(null);
          if (queue.length) return resolve(queue.shift());

          const entry = { resolve, timer: null };
          entry.timer = setTimeout(() => {
            if (waiter === entry) waiter = null;
            resolve(null);
          }, timeoutMs);
          entry.timer.unref?.();
          waiter = entry;
        }),
      close: () => {
        if (closed) return;
        closed = true;
        settle(null);
        queue.length = 0;
        this.subscribers.delete(sub);
      },
    };

    this.subscribers.add(sub);
    return sub;
  }

  publish(jpegBuffer, meta = {}) {
    const now = Date.now();
    const width = meta.width || config.defaultWidth;
    const height = meta.height || config.defaultHeight;
    const frame = {
      seq: this.seq + 1,
      ts: now,
      width,
      height,
      bytes: jpegBuffer.length,
      jpeg: jpegBuffer,
      source: meta.source || 'live',
      demo: (meta.source || 'live') === 'demo',
      deviceId: meta.deviceId || null,
    };

    this.seq = frame.seq;
    this.frames += 1;
    this.latest = frame;

    if (frame.source === 'live') {
      this.realFrames += 1;
      this.lastRealAt = now;
    }

    this.frameTimes.push(now);
    if (this.frameTimes.length > 45) this.frameTimes.shift();

    this.byteLog.push({ t: now, bytes: frame.bytes });
    const cutoff = now - 3000;
    while (this.byteLog.length && this.byteLog[0].t < cutoff) this.byteLog.shift();

    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch (error) {
        console.error('[frames] listener failed:', error.message);
      }
    }
    for (const sub of this.subscribers) sub.push(frame);

    return frame;
  }

  ingestJpeg(jpegBuffer, meta = {}) {
    if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer.length < 64) {
      throw new Error('JPEG payload is empty or too small');
    }
    return this.publish(jpegBuffer, meta);
  }

  ingestRgb565(raw, options = {}) {
    const width = Number(options.width) || config.defaultWidth;
    const height = Number(options.height) || config.defaultHeight;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16) {
      throw new Error('Invalid frame dimensions');
    }
    if (width * height > 2_000_000) throw new Error('Frame dimensions are too large');

    const expected = width * height * 2;
    if (raw.length < expected) {
      throw new Error(`Expected ${expected} RGB565 bytes, received ${raw.length}`);
    }

    const needed = width * height * 4;
    if (!this.rgba || this.rgba.length !== needed) this.rgba = Buffer.allocUnsafe(needed);

    const rgba = rgb565ToRgba(raw, width, height, {
      bigEndian: Boolean(options.bigEndian),
      flipX: Boolean(options.flipX),
      flipY: Boolean(options.flipY),
      rgba: this.rgba,
    });

    const encoded = jpeg.encode(
      { data: rgba, width, height },
      config.jpegQuality,
    );

    return this.publish(encoded.data, {
      width,
      height,
      source: options.source || 'live',
      deviceId: options.deviceId,
    });
  }

  getFps() {
    if (this.frameTimes.length < 2) return 0;
    const first = this.frameTimes[0];
    const last = this.frameTimes[this.frameTimes.length - 1];
    if (last <= first) return 0;
    return (this.frameTimes.length - 1) / ((last - first) / 1000);
  }

  getBitrateKbps() {
    if (!this.byteLog.length) return 0;
    const now = Date.now();
    const span = Math.max(1000, now - this.byteLog[0].t);
    const bytes = this.byteLog.reduce((sum, entry) => sum + entry.bytes, 0);
    return (bytes * 8) / span;
  }

  getAgeMs() {
    return this.latest ? Math.max(0, Date.now() - this.latest.ts) : null;
  }

  isLive() {
    return Boolean(
      this.latest &&
        this.latest.source === 'live' &&
        this.getAgeMs() < config.frameStaleMs,
    );
  }

  getStatus() {
    const age = this.getAgeMs();
    const live = this.isLive();
    const demo = Boolean(this.latest && this.latest.source === 'demo' && age < 10_000);
    return {
      connected: live,
      source: live ? 'live' : demo ? 'demo' : 'none',
      demo,
      width: this.latest?.width || config.defaultWidth,
      height: this.latest?.height || config.defaultHeight,
      fps: Number(this.getFps().toFixed(1)),
      bitrateKbps: Math.round(this.getBitrateKbps()),
      frames: this.frames,
      realFrames: this.realFrames,
      lastFrameAt: this.latest ? new Date(this.latest.ts).toISOString() : null,
      ageMs: age,
      jpegBytes: this.latest?.bytes || 0,
      deviceId: this.latest?.deviceId || null,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  renderDemoIfNeeded() {
    if (!config.demoFallback) return;
    if (Date.now() - this.lastRealAt < 4000) return;

    const width = this.demoWidth;
    const height = this.demoHeight;
    const needed = width * height * 4;
    if (!this.demoRgba || this.demoRgba.length !== needed) this.demoRgba = Buffer.allocUnsafe(needed);

    this.demoTime += 0.055;
    const t = this.demoTime;
    const data = this.demoRgba;
    const horizon = height * 0.6;
    const orbX = width * 0.73;
    const orbY = height * 0.29;

    for (let y = 0; y < height; y += 1) {
      const ny = y / height;
      const onWater = y > horizon;
      const depth = onWater ? (y - horizon) / (height - horizon) : 0;
      const scan = y % 3 === 0 ? 0.94 : 1;
      const vx = (x0) => (x0 / width - 0.5) * 2;

      for (let x = 0; x < width; x += 1) {
        let r;
        let g;
        let b;

        if (!onWater) {
          r = 4 + 16 * (y / horizon);
          g = 9 + 36 * (y / horizon);
          b = 32 + 84 * (y / horizon);

          const aurora =
            Math.sin(x * 0.022 + t * 1.35) *
            Math.sin(y * 0.019 - t * 0.8 + Math.sin(x * 0.009 + t) * 1.7);
          const glow = Math.max(0, aurora) ** 3;
          r += glow * 36;
          g += glow * 150;
          b += glow * 128;

          const cloud =
            Math.sin(x * 0.018 + t * 0.6 + y * 0.01) +
            Math.sin(x * 0.031 - t * 0.35);
          r += Math.max(0, cloud) * 10;
          g += Math.max(0, cloud) * 12;
          b += Math.max(0, cloud) * 18;

          const star = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
          if (star - Math.floor(star) > 0.9975) {
            r += 70;
            g += 80;
            b += 95;
          }

          const dx = x - orbX;
          const dy = y - orbY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 31) {
            const k = 1 - distance / 31;
            r += 235 * k;
            g += 150 * k;
            b += 58 * k;
          } else if (distance < 50) {
            const k = 1 - (distance - 31) / 19;
            r += 55 * k;
            g += 26 * k;
            b += 14 * k;
          }
        } else {
          const ripple =
            Math.sin((y - horizon) * 0.32 - t * 2.2 + Math.sin(x * 0.045 + t) * 2) *
            (4 + 20 * depth);
          r = 2 + 8 * depth + ripple * 0.1;
          g = 20 + 52 * depth + ripple * 0.45;
          b = 58 + 132 * depth + ripple;

          const reflection = Math.exp(-(((x - orbX) / (26 + depth * 55)) ** 2)) * (1 - depth * 0.45);
          r += 190 * reflection;
          g += 100 * reflection;
          b += 38 * reflection;

          const horizonGlow = Math.exp(-(((y - horizon) / 10) ** 2));
          r += 18 * horizonGlow;
          g += 52 * horizonGlow;
          b += 70 * horizonGlow;

          if ((y - horizon) % 22 < 1 && depth > 0.08) {
            r += 8;
            g += 28;
            b += 34;
          }
        }

        const vx2 = vx(x);
        const vy2 = (y / height - 0.5) * 2;
        const vignette = 1 - Math.min(1, (vx2 * vx2 + vy2 * vy2) * 0.24);
        const grain = (Math.sin(x * 12.9898 + y * 78.233 + t * 40) * 43758.5453) % 1;
        const noise = grain * 6 - 3;
        const i = (y * width + x) * 4;
        data[i] = clamp255(r * vignette * scan + noise);
        data[i + 1] = clamp255(g * vignette * scan + noise);
        data[i + 2] = clamp255(b * vignette * scan + noise);
        data[i + 3] = 255;
      }
    }

    const encoded = jpeg.encode({ data, width, height }, Math.max(55, config.jpegQuality - 12));
    this.publish(encoded.data, { width, height, source: 'demo', deviceId: 'SIMULATED-CAM' });
  }
}

export const frameHub = new FrameHub();
