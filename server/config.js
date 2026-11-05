import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const stunServers = list(process.env.STUN_SERVERS);

export const ROOT_DIR = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  uploadToken: process.env.UPLOAD_TOKEN || '',
  allowedOrigins: process.env.ALLOWED_ORIGINS || '*',
  trustProxy: bool(process.env.TRUST_PROXY, true),

  demoFallback: bool(process.env.DEMO_FALLBACK, true),
  demoFps: Math.min(15, Math.max(2, int(process.env.DEMO_FPS, 8))),
  jpegQuality: Math.min(95, Math.max(40, int(process.env.JPEG_QUALITY, 80))),
  defaultWidth: int(process.env.FRAME_WIDTH, 320),
  defaultHeight: int(process.env.FRAME_HEIGHT, 240),
  defaultFormat: process.env.FRAME_FORMAT || 'rgb565le',
  maxFrameBytes: int(process.env.MAX_FRAME_BYTES, 2 * 1024 * 1024),
  frameStaleMs: int(process.env.FRAME_STALE_MS, 5000),

  maxWebRtcPeers: Math.min(12, Math.max(1, int(process.env.MAX_WEBRTC_PEERS, 4))),
  metered: {
    domain: (process.env.METERED_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    apiKey: process.env.METERED_API_KEY || '',
    region: process.env.METERED_REGION || '',
    ttlMs: int(process.env.METERED_TTL_MS, 30 * 60 * 1000),
  },
  stunServers: stunServers.length
    ? stunServers
    : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],

  logRequests: bool(process.env.LOG_REQUESTS, false),
};

export function hasUploadAuth() {
  return Boolean(config.uploadToken);
}
