import { randomUUID } from 'node:crypto';
import { AccessToken, DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
import { config, hasLiveKit } from './config.js';

/**
 * LiveKit replaces the hosted relay for media. The Node process never touches
 * the video frames: it only signs short-lived join tokens, and forwards sensor
 * telemetry into the room data channel so remote dashboards stay live too.
 */

const ROOM = config.livekit.room;
const TOKEN_TTL = config.livekit.ttlSeconds;

let roomClient = null;
let lastBroadcastError = '';

export function liveKitStatus() {
  return {
    enabled: hasLiveKit(),
    url: config.livekit.url || null,
    room: ROOM,
  };
}

function browserUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('ws://')) return `wss://${url.slice(5)}`;
  if (url.startsWith('http://')) return `wss://${url.slice(7)}`;
  if (url.startsWith('wss://') || url.startsWith('https://')) return url;
  return `wss://${url}`;
}

function apiUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('wss://')) return `https://${url.slice(6)}`;
  if (url.startsWith('ws://')) return `http://${url.slice(5)}`;
  return url;
}

function cleanIdentity(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/**
 * @param {{ identity?: string, role?: 'publisher'|'viewer', name?: string }} options
 * @returns {Promise<{ token: string, url: string, room: string, identity: string, role: string, ttl: number }>}
 */
export async function createLiveKitToken({ identity, role = 'viewer', name } = {}) {
  if (!hasLiveKit()) {
    const error = new Error('LiveKit is not configured on this server');
    error.statusCode = 503;
    error.code = 'livekit_not_configured';
    throw error;
  }

  const publisher = role === 'publisher';
  const id = cleanIdentity(
    identity,
    `${publisher ? 'camera' : 'viewer'}-${randomUUID().slice(0, 8)}`,
  );

  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: id,
    name: cleanIdentity(name, id),
    ttl: TOKEN_TTL,
  });

  token.addGrant({
    room: ROOM,
    roomJoin: true,
    canPublish: publisher,
    canSubscribe: true,
    canPublishData: publisher,
    // Viewers only receive, so they cannot accidentally publish a second feed.
  });

  return {
    token: await token.toJwt(),
    url: browserUrl(config.livekit.url),
    room: ROOM,
    identity: id,
    role: publisher ? 'publisher' : 'viewer',
    ttl: TOKEN_TTL,
  };
}

function client() {
  if (!hasLiveKit()) return null;
  if (!roomClient) {
    roomClient = new RoomServiceClient(apiUrl(config.livekit.url), config.livekit.apiKey, config.livekit.apiSecret);
  }
  return roomClient;
}

/**
 * Mirror a sensor record into the LiveKit room data channel. Remote viewers
 * (mobile, another city, GitHub Pages) therefore get live sensors even though
 * the Node relay is only running on the laptop.
 */
export async function broadcastSensor(record) {
  const service = client();
  if (!service || !record) return;

  const payload = new TextEncoder().encode(
    JSON.stringify({
      type: 'sensor',
      deviceId: record.deviceId,
      readings: record.readings,
      ts: record.ts,
      source: record.source,
      demo: record.demo,
    }),
  );

  try {
    await service.sendData(ROOM, payload, DataPacket_Kind.RELIABLE, { topic: 'sensors' });
    lastBroadcastError = '';
  } catch (error) {
    // "room not found" is normal until a browser/camera joins; log only once.
    const message = error?.message || String(error);
    if (message !== lastBroadcastError) {
      lastBroadcastError = message;
      console.warn('[livekit] sensor broadcast skipped:', message);
    }
  }
}
