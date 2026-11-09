import { config } from './config.js';

/**
 * Shared frame store for serverless deployments.
 *
 * A normal long-running relay (laptop, Render, Railway, Docker, VPS) keeps the
 * newest frame in `frameHub` memory and every request reaches that same
 * process. Vercel does not work that way: each HTTPS request can land on a
 * different function instance, and each instance has its own memory. The
 * camera would upload to instance A while the browser reads from instance B,
 * which is why the public dashboard stayed on "waiting for camera" even while
 * frames were being accepted.
 *
 * Vercel Runtime Cache is a regional cache shared by all function instances in
 * the same region and available on every Vercel plan. We write the latest JPEG
 * there during an upload and read it back from whichever instance serves the
 * browser. Outside Vercel this module is a no-op, so the local relay keeps
 * using the in-process hub with zero overhead.
 */

const NAMESPACE = (process.env.FRAME_CACHE_NAMESPACE || 'mirsad-live').slice(0, 64);
const FRAME_KEY = 'latest-frame-v1';
const TTL_SECONDS = Math.max(
  60,
  Math.min(24 * 60 * 60, Number.parseInt(process.env.FRAME_CACHE_TTL, 10) || 15 * 60),
);
// Do not write every single upload to the cache. The camera can send 10 fps,
// while 4 shared writes/second are plenty for the browser poller and keep the
// free-plan cache write budget under control.
const MIN_WRITE_INTERVAL_MS = Math.max(
  0,
  Math.min(5000, Number.parseInt(process.env.FRAME_CACHE_WRITE_MS, 10) || 250),
);

export const sharedFramesEnabled = Boolean(
  process.env.VERCEL || String(process.env.FRAME_STORE || '').toLowerCase() === 'vercel',
);

let cachePromise = null;
let lastWriteAt = 0;
let lastWriteErrorAt = 0;
let lastReadErrorAt = 0;

function warnOnce(kind, error) {
  const now = Date.now();
  if (kind === 'write') {
    if (now - lastWriteErrorAt < 15_000) return;
    lastWriteErrorAt = now;
  } else {
    if (now - lastReadErrorAt < 15_000) return;
    lastReadErrorAt = now;
  }
  console.error(`[frame-store] ${kind} failed: ${error?.message || error}`);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runtimeCache() {
  if (!sharedFramesEnabled) return null;
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        const { getCache } = await import('@vercel/functions');
        return getCache({ namespace: NAMESPACE });
      } catch (error) {
        warnOnce('read', error);
        return null;
      }
    })();
  }
  return cachePromise;
}

function normalizeRecord(value) {
  if (!value) return null;
  let record = value;
  if (typeof record === 'string') {
    try {
      record = JSON.parse(record);
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== 'object' || typeof record.jpeg !== 'string') return null;
  return record;
}

/**
 * Persist the newest JPEG + metadata for the other Vercel instances.
 * Returns true when this frame actually reached the shared cache.
 */
export async function saveSharedFrame(frame, { force = false } = {}) {
  if (!sharedFramesEnabled) return false;
  if (!frame?.jpeg?.length) return false;

  const now = Date.now();
  if (!force && now - lastWriteAt < MIN_WRITE_INTERVAL_MS) return false;

  const cache = await runtimeCache();
  if (!cache) return false;

  const payload = {
    v: 1,
    seq: frame.seq,
    ts: frame.ts || now,
    width: frame.width || config.defaultWidth,
    height: frame.height || config.defaultHeight,
    bytes: frame.bytes || frame.jpeg.length,
    source: frame.source === 'demo' ? 'demo' : 'live',
    deviceId: frame.deviceId || null,
    jpeg: frame.jpeg.toString('base64'),
  };

  try {
    await withTimeout(
      cache.set(FRAME_KEY, payload, {
        ttl: TTL_SECONDS,
        name: 'mirsad-latest-camera-frame',
        tags: ['mirsad-camera-frame'],
      }),
      2000,
      'cache.set',
    );
    lastWriteAt = now;
    return true;
  } catch (error) {
    warnOnce('write', error);
    return false;
  }
}

/**
 * Read the newest shared frame. Returns the same shape as `frameHub.latest`
 * (plus a real Buffer for the JPEG bytes), or null when no camera frame has
 * been written yet.
 */
export async function loadSharedFrame() {
  if (!sharedFramesEnabled) return null;

  const cache = await runtimeCache();
  if (!cache) return null;

  try {
    const value = await withTimeout(cache.get(FRAME_KEY), 1500, 'cache.get');
    const record = normalizeRecord(value);
    if (!record) return null;
    const jpeg = Buffer.from(record.jpeg, 'base64');
    if (!jpeg.length) return null;
    return {
      seq: Number(record.seq) || 0,
      ts: Number(record.ts) || 0,
      width: Number(record.width) || config.defaultWidth,
      height: Number(record.height) || config.defaultHeight,
      bytes: Number(record.bytes) || jpeg.length,
      jpeg,
      source: record.source === 'demo' ? 'demo' : 'live',
      demo: record.source === 'demo',
      deviceId: record.deviceId || null,
    };
  } catch (error) {
    warnOnce('read', error);
    return null;
  }
}
