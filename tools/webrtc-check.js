#!/usr/bin/env node
/**
 * WebRTC data-channel end-to-end check.
 *
 *   npm start             # in one terminal
 *   npm run test:webrtc   # in another
 *
 * Uses the same `werift` implementation as the relay so the test verifies the
 * full offer/answer handshake, ICE or TURN connectivity and the 12-byte binary
 * frame header (uint32 BE sequence + float64 BE server timestamp) followed by a
 * valid JPEG.
 */

import { RTCPeerConnection } from 'werift';

const BASE = (process.env.SERVER_URL || process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.UPLOAD_TOKEN || '';
const startedAt = Date.now();

function authHeaders(extra = {}) {
  return TOKEN ? { ...extra, 'x-upload-token': TOKEN } : extra;
}

/** A tiny deterministic RGB565 frame so the check does not need a real camera. */
function testRgb565(width = 64, height = 48) {
  const data = Buffer.allocUnsafe(width * height * 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const r = Math.round((x / (width - 1)) * 31);
      const g = Math.round((y / (height - 1)) * 63);
      const pixel = (r << 11) | (g << 5) | 20;
      data.writeUInt16LE(pixel, (y * width + x) * 2);
    }
  }
  return data;
}

/**
 * Keep the relay fed while the check waits for a second WebRTC frame.
 *
 * Uses the camera endpoint, not /api/laptop/frame: that route is deliberately
 * restricted to the relay's own machine, so it returns 403 when this check runs
 * against Render. /api/upload-frame is the same path the ESP32-CAM uses.
 */
function startFramePump() {
  const frame = testRgb565();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    fetch(`${BASE}/api/upload-frame?device=WEBRTC-TEST&w=64&h=48&format=rgb565le`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/octet-stream' }),
      body: frame,
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, 200);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data);
  return null;
}

async function main() {
  console.log('');
  console.log('  MIRSAD WebRTC data-channel check');
  console.log(`  ➜  ${BASE}`);
  if (process.env.METERED_DOMAIN) console.log(`  ➜  Metered app: ${process.env.METERED_DOMAIN}`);
  console.log('');

  const configResponse = await fetch(`${BASE}/api/rtc/config`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert(configResponse.ok, `/api/rtc/config returned HTTP ${configResponse.status}`);
  const rtcConfig = await configResponse.json();
  assert(rtcConfig.ok === true, 'RTC config did not return ok=true');
  assert(rtcConfig.available === true, 'werift is not available on the server');
  assert(Array.isArray(rtcConfig.iceServers) && rtcConfig.iceServers.length > 0, 'no ICE servers advertised');

  const ice = rtcConfig.iceServers
    .map((entry) => (Array.isArray(entry.urls) ? entry.urls[0] : entry.urls))
    .filter(Boolean);
  const hasTurn = ice.some((url) => /^turns?:/i.test(url));
  console.log(
    `  ${green('PASS')}  ICE configuration ${dim(`${ice.length} server(s), source=${rtcConfig.source}${hasTurn ? ', TURN active' : ', STUN only'}`)}`,
  );

  const pc = new RTCPeerConnection({ iceServers: rtcConfig.iceServers });
  const channel = pc.createDataChannel('frames', { ordered: false, maxRetransmits: 0 });
  let answerId = null;
  let binaryFrames = 0;
  let textMessages = 0;
  let firstFrame = null;
  let stopPump = null;

  const framePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a binary camera frame')), 20_000);
    const done = (frame) => {
      clearTimeout(timer);
      resolve(frame);
    };

    channel.onmessage = (event) => {
      const data = asBuffer(event?.data);
      if (!data) return;

      // JSON status packets are text; a frame always starts with the 12-byte
      // binary header whose first bytes are the sequence number.
      const looksLikeJson = data.length > 0 && data[0] === 0x7b; // '{'
      if (looksLikeJson) {
        textMessages += 1;
        return;
      }

      binaryFrames += 1;
      if (!firstFrame && data.length >= 13) {
        firstFrame = data;
        done(data);
      }
    };
  });

  const openPromise = withTimeout(
    new Promise((resolve) => {
      if (channel.readyState === 'open') return resolve();
      channel.onopen = () => resolve();
    }),
    20_000,
    'timed out waiting for the WebRTC data channel to open',
  );

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const local = pc.localDescription;
    assert(local?.sdp, 'client failed to produce a local SDP offer');
    assert(local.sdp.includes('m=application'), 'offer is missing the data-channel media section');
    assert(local.sdp.includes('candidate'), 'offer was not ICE-gathered');

    const offerResponse = await fetch(`${BASE}/api/rtc/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: local.type || 'offer', sdp: local.sdp }),
      signal: AbortSignal.timeout(20_000),
    });
    const answer = await offerResponse.json().catch(() => ({}));
    assert(
      offerResponse.ok && answer.ok && answer.sdp,
      `signalling failed (HTTP ${offerResponse.status}): ${answer.message || 'no SDP answer'}`,
    );
    answerId = answer.id || null;
    assert(answer.type === 'answer', `unexpected SDP answer type: ${answer.type}`);
    assert(answer.sdp.includes('m=application'), 'answer is missing the data-channel media section');
    console.log(
      `  ${green('PASS')}  Offer/answer negotiated ${dim(`peer=${String(answerId).slice(0, 8)} via ${answer.ice}`)}`,
    );

    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await openPromise;
    console.log(`  ${green('PASS')}  Data channel "${channel.label}" opened`);

    // Feed the relay from this process: the real deployment gets frames from
    // the laptop webcam, but the check must also pass on a headless machine.
    stopPump = startFramePump();

    const frame = await framePromise;
    const seq = frame.readUInt32BE(0);
    const timestamp = frame.readDoubleBE(4);
    const jpeg = frame.subarray(12);

    assert(jpeg.length > 100, `JPEG payload is too small (${jpeg.length} bytes)`);
    assert(jpeg[0] === 0xff && jpeg[1] === 0xd8, 'payload does not start with a JPEG SOI marker');
    assert(jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9, 'payload is missing the JPEG EOI marker');
    assert(seq > 0, `sequence number is invalid (${seq})`);
    assert(timestamp > 1_500_000_000_000 && timestamp < Date.now() + 60_000, `timestamp is implausible (${timestamp})`);

    const latency = Math.max(0, Math.round(Date.now() - timestamp));
    console.log(
      `  ${green('PASS')}  Binary frame received ${dim(`seq=${seq}, jpeg=${jpeg.length}B, header=12B, age=${latency}ms, text-packet(s)=${textMessages}`)}`,
    );

    // Give the relay a moment to send a second frame and verify the stream is live.
    const second = await withTimeout(
      new Promise((resolve) => {
        const previous = binaryFrames;
        const tick = setInterval(() => {
          if (binaryFrames > previous) {
            clearInterval(tick);
            resolve(true);
          }
        }, 50);
        setTimeout(() => {
          clearInterval(tick);
          resolve(false);
        }, 4000);
      }),
      5000,
      'second frame check timed out',
    );
    assert(second, 'only one frame arrived; the live fan-out is not running');
    console.log(`  ${green('PASS')}  Stream is live ${dim(`${binaryFrames} frames received`)}`);

    console.log('');
    console.log(
      `  ${green(`✔ WebRTC data channel verified in ${Date.now() - startedAt}ms`)}${hasTurn ? '' : dim(' (STUN mode)')}\n`,
    );
  } finally {
    stopPump?.();
    try {
      channel.close();
    } catch {
      /* already closed */
    }
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    if (answerId) {
      await fetch(`${BASE}/api/rtc/peer/${encodeURIComponent(answerId)}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(`\n  ${red('✖ WebRTC check failed')}\n    ${red(error.message)}\n`);
  process.exitCode = 1;
});
