import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { frameHub } from './frameHub.js';

let weriftPromise = null;
let iceCache = null;
const peers = new Map();

async function loadWerift() {
  if (!weriftPromise) {
    weriftPromise = import('werift').catch((error) => {
      weriftPromise = null;
      throw error;
    });
  }
  return weriftPromise;
}

/**
 * Returns ICE servers for both the browser and the server peer.
 * Metered credentials are fetched server-side so the API key never reaches the
 * browser. When no Metered app is configured we fall back to public STUN.
 */
export async function getIceConfig({ force = false } = {}) {
  if (!force && iceCache && Date.now() - iceCache.at < config.metered.ttlMs) return iceCache;

  let result = null;

  if (config.metered.domain && config.metered.apiKey) {
    try {
      const url = new URL(`https://${config.metered.domain}/api/v1/turn/credentials`);
      url.searchParams.set('apiKey', config.metered.apiKey);
      if (config.metered.region) url.searchParams.set('region', config.metered.region);

      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = await response.json();
      const iceServers = (Array.isArray(body) ? body : [])
        .filter((item) => item && item.urls)
        .map((item) => ({
          urls: item.urls,
          ...(item.username ? { username: item.username } : {}),
          ...(item.credential ? { credential: item.credential } : {}),
        }));

      if (!iceServers.length) throw new Error('empty credential response');
      result = { iceServers, source: 'metered', turn: true };
    } catch (error) {
      console.warn(`[webrtc] Metered TURN unavailable (${error.message}); using STUN`);
    }
  }

  if (!result) {
    result = {
      iceServers: config.stunServers.map((urls) => ({ urls })),
      source: 'stun',
      turn: false,
    };
  }

  iceCache = { ...result, at: Date.now() };
  return iceCache;
}

function cleanupPeer(peer, reason = 'closed') {
  if (!peer || peer.closed) return;
  peer.closed = true;
  peers.delete(peer.id);

  if (peer.timer) clearInterval(peer.timer);
  if (peer.guard) clearTimeout(peer.guard);
  if (peer.statusTimer) clearInterval(peer.statusTimer);
  peer.timer = null;
  peer.guard = null;
  peer.statusTimer = null;

  try {
    peer.channel?.close?.();
  } catch {
    /* already closed */
  }
  try {
    peer.pc?.close?.();
  } catch {
    /* already closed */
  }

  if (reason !== 'shutdown') {
    console.log(`[webrtc] peer ${peer.id.slice(0, 8)} closed (${reason}), sent=${peer.sent}`);
  }
}

function sendFrame(peer, frame) {
  const channel = peer.channel;
  if (!channel || channel.readyState !== 'open') return;
  if (typeof channel.bufferedAmount === 'number' && channel.bufferedAmount > 1_000_000) return;

  const header = Buffer.allocUnsafe(12);
  header.writeUInt32BE(frame.seq >>> 0, 0);
  header.writeDoubleBE(frame.ts, 4);
  const payload = Buffer.concat([header, frame.jpeg], header.length + frame.jpeg.length);

  try {
    channel.send(payload);
    peer.lastSeq = frame.seq;
    peer.sent += 1;
    peer.lastSentAt = Date.now();
  } catch (error) {
    cleanupPeer(peer, `send failed: ${error.message}`);
  }
}

function startSending(peer) {
  if (peer.timer) return;
  if (peer.guard) {
    clearTimeout(peer.guard);
    peer.guard = null;
  }

  peer.timer = setInterval(() => {
    const frame = frameHub.latest;
    if (!frame || frame.seq === peer.lastSeq) return;
    sendFrame(peer, frame);
  }, 80);
  peer.timer.unref?.();

  peer.statusTimer = setInterval(() => {
    if (peer.channel?.readyState !== 'open') return;
    try {
      peer.channel.send(
        JSON.stringify({
          type: 'status',
          sent: peer.sent,
          source: frameHub.latest?.source || 'none',
          ts: Date.now(),
        }),
      );
    } catch {
      /* channel closing */
    }
  }, 5000);
  peer.statusTimer.unref?.();

  if (frameHub.isLive()) sendFrame(peer, frameHub.latest);
}

export async function createWebRtcPeer(offer, meta = {}) {
  if (!offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || !offer.sdp.includes('m=application')) {
    const error = new Error('Invalid WebRTC offer: a data-channel (m=application) offer is required');
    error.statusCode = 400;
    throw error;
  }
  if (peers.size >= config.maxWebRtcPeers) {
    const error = new Error(`WebRTC peer limit reached (${config.maxWebRtcPeers})`);
    error.statusCode = 429;
    throw error;
  }

  const { RTCPeerConnection } = await loadWerift();
  const ice = await getIceConfig();
  const pc = new RTCPeerConnection({ iceServers: ice.iceServers });

  const peer = {
    id: randomUUID(),
    pc,
    channel: null,
    timer: null,
    statusTimer: null,
    guard: null,
    createdAt: Date.now(),
    ip: meta.ip || null,
    sent: 0,
    lastSeq: -1,
    lastSentAt: 0,
    closed: false,
  };
  peers.set(peer.id, peer);

  const wireChannel = (channel) => {
    peer.channel = channel;
    channel.onopen = () => {
      console.log(`[webrtc] peer ${peer.id.slice(0, 8)} channel open`);
      startSending(peer);
    };
    channel.onclose = () => cleanupPeer(peer, 'data channel closed');
    channel.onerror = (event) => cleanupPeer(peer, `data channel error${event?.error ? `: ${event.error}` : ''}`);
    if (channel.readyState === 'open') startSending(peer);
  };

  pc.ondatachannel = (event) => wireChannel(event.channel);

  try {
    pc.connectionStateChange?.watch?.((state) => {
      if (state === 'failed' || state === 'closed') cleanupPeer(peer, `pc ${state}`);
    });
  } catch {
    /* optional watcher */
  }

  peer.guard = setTimeout(() => {
    if (!peer.channel) cleanupPeer(peer, 'no data channel after 60s');
  }, 60_000);
  peer.guard.unref?.();

  try {
    await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const local = pc.localDescription;
    if (!local?.sdp) throw new Error('Failed to produce an SDP answer');

    console.log(`[webrtc] peer ${peer.id.slice(0, 8)} answered via ${ice.source}`);
    return {
      id: peer.id,
      type: local.type || 'answer',
      sdp: local.sdp,
      ice: ice.source,
      turn: ice.turn,
    };
  } catch (error) {
    cleanupPeer(peer, `negotiation failed: ${error.message}`);
    throw error;
  }
}

export function closeWebRtcPeer(id) {
  const peer = peers.get(id);
  if (!peer) return false;
  cleanupPeer(peer, 'client closed');
  return true;
}

export function getWebRtcStats() {
  return {
    active: peers.size,
    max: config.maxWebRtcPeers,
    peers: [...peers.values()].map((peer) => ({
      id: peer.id,
      createdAt: new Date(peer.createdAt).toISOString(),
      sent: peer.sent,
      lastSentAt: peer.lastSentAt ? new Date(peer.lastSentAt).toISOString() : null,
      channel: peer.channel?.readyState || 'none',
    })),
  };
}

export function closeAllWebRtcPeers() {
  for (const peer of [...peers.values()]) cleanupPeer(peer, 'shutdown');
}

export async function isWebRtcAvailable() {
  try {
    await loadWerift();
    return true;
  } catch {
    return false;
  }
}
