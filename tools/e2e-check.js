#!/usr/bin/env node
/**
 * End-to-end HTTP / WebSocket / MJPEG smoke test.
 *
 *   npm start            # in one terminal
 *   npm run test:e2e     # in another
 */

import WebSocket from 'ws';

const BASE = (process.env.SERVER_URL || process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.UPLOAD_TOKEN || '';
const WS_BASE = BASE.replace(/^http/, 'ws');
const results = [];
let failures = 0;

const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;

function authHeaders(extra = {}) {
  return TOKEN ? { ...extra, 'x-upload-token': TOKEN } : extra;
}

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms, detail });
    console.log(`  ${green('PASS')}  ${name} ${dim(`${ms}ms`)}${detail ? dim(` — ${detail}`) : ''}`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error: error.message });
    console.log(`  ${red('FAIL')}  ${name}\n        ${red(error.message)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rgb565Frame(width = 64, height = 48) {
  const buffer = Buffer.allocUnsafe(width * height * 2);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const r = Math.round((x / width) * 255);
      const g = Math.round((y / height) * 255);
      const b = Math.round(((x + y) / (width + height)) * 255);
      const pixel = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
      buffer.writeUInt16LE(pixel, offset);
      offset += 2;
    }
  }
  return buffer;
}

async function expectOk(path) {
  const response = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  return response;
}

async function main() {
  console.log('');
  console.log('  MIRSAD end-to-end check');
  console.log(`  ➜  ${BASE}`);
  console.log('');

  await test('GET /healthz reports ready', async () => {
    const response = await expectOk('/healthz');
    assert(response.ok, `HTTP ${response.status}`);
    const body = await response.json();
    assert(body.ok === true, 'healthz did not return ok=true');
    return `camera=${body.camera} sensors=${body.sensors}`;
  });

  await test('GET /api/status exposes camera, sensors and WebRTC', async () => {
    const response = await expectOk('/api/status');
    assert(response.ok, `HTTP ${response.status}`);
    const body = await response.json();
    assert(body.ok === true, 'missing ok flag');
    assert(body.camera && typeof body.camera.fps === 'number', 'camera status missing');
    assert(body.sensors && typeof body.sensors.history === 'number', 'sensor status missing');
    assert(body.webrtc && body.webrtc.transport === 'datachannel', 'WebRTC transport missing');
    return `${body.camera.width}x${body.camera.height} @ ${body.camera.fps} fps, ICE=${body.webrtc.iceSource}`;
  });

  let uploadedSeq = 0;
  await test('POST /api/upload-frame converts RGB565 to JPEG', async () => {
    const width = 64;
    const height = 48;
    const frame = rgb565Frame(width, height);
    const response = await fetch(
      `${BASE}/api/upload-frame?w=${width}&h=${height}&format=rgb565le&device=E2E-TEST`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/octet-stream' }),
        body: frame,
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = await response.json().catch(() => ({}));
    assert(response.ok && body.ok, `HTTP ${response.status}: ${body.message || 'upload failed'}`);
    assert(body.width === width && body.height === height, 'dimension echo mismatch');
    assert(body.jpegBytes > 100, 'JPEG output is suspiciously small');
    uploadedSeq = body.seq;
    return `seq=${body.seq} jpeg=${body.jpegBytes}B`;
  });

  await test('GET /api/frame.jpg returns the latest JPEG', async () => {
    const response = await expectOk('/api/frame.jpg');
    assert(response.ok, `HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    assert(type.includes('image/jpeg'), `unexpected content-type: ${type}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert(buffer[0] === 0xff && buffer[1] === 0xd8, 'missing JPEG SOI marker');
    assert(buffer.length > 100, 'JPEG is empty');
    assert(response.headers.get('x-frame-seq'), 'missing X-Frame-Seq header');
    return `${buffer.length}B, seq=${response.headers.get('x-frame-seq')}`;
  });

  await test('POST /api/sensors accepts live telemetry', async () => {
    const response = await fetch(`${BASE}/api/sensors`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        deviceId: 'E2E-SENSOR',
        readings: {
          temperature: 24.7,
          humidity: 51.2,
          soil: 38,
          light: 72,
          airQuality: 21,
          motion: false,
          pressure: 1011.4,
          battery: 88,
          rssi: -58,
        },
      }),
    });
    const body = await response.json().catch(() => ({}));
    assert(response.ok && body.ok, `HTTP ${response.status}: ${body.message || 'sensor rejected'}`);
    assert(body.deviceId === 'E2E-SENSOR', 'device id not echoed');
    assert(body.readings.temperature === 24.7, 'temperature not stored');
    return `device=${body.deviceId}`;
  });

  await test('GET /api/sensors/latest returns normalized readings', async () => {
    const response = await expectOk('/api/sensors/latest');
    assert(response.ok, `HTTP ${response.status}`);
    const body = await response.json();
    assert(body.ok && body.readings, 'missing readings');
    assert(body.readings.temperature === 24.7, 'latest reading is not the one just posted');
    return `temperature=${body.readings.temperature} humidity=${body.readings.humidity}`;
  });

  await test('GET /api/sensors/history returns chart points', async () => {
    const response = await expectOk('/api/sensors/history?limit=20');
    assert(response.ok, `HTTP ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body.points) && body.points.length > 0, 'history is empty');
    assert(body.points.every((point) => Number.isFinite(point.t)), 'points missing timestamps');
    return `${body.points.length} points`;
  });

  await test('GET /api/rtc/config returns ICE servers', async () => {
    const response = await expectOk('/api/rtc/config');
    assert(response.ok, `HTTP ${response.status}`);
    const body = await response.json();
    assert(body.ok === true, 'missing ok flag');
    assert(body.available === true, 'werift is not available');
    assert(Array.isArray(body.iceServers) && body.iceServers.length > 0, 'no ICE servers');
    return `${body.iceServers.length} servers, source=${body.source}`;
  });

  await test('WebSocket /ws/frames streams a binary JPEG', async () => {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${WS_BASE}/ws/frames`);
      socket.binaryType = 'arraybuffer';
      let textFrames = 0;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('timed out waiting for a binary frame'));
      }, 10_000);

      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          textFrames += 1;
          return;
        }
        clearTimeout(timer);
        const buffer = Buffer.from(data);
        if (buffer.length < 100 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
          socket.terminate();
          reject(new Error('binary message is not a JPEG'));
          return;
        }
        socket.close();
        resolve(`${buffer.length}B after ${textFrames} control message(s)`);
      });

      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  });

  await test('WebSocket /ws/sensors sends a hello packet', async () => {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${WS_BASE}/ws/sensors`);
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('timed out waiting for sensor hello'));
      }, 8000);

      socket.on('message', (data) => {
        try {
          const message = JSON.parse(String(data));
          if (message.type !== 'hello') return;
          clearTimeout(timer);
          socket.close();
          const count = Array.isArray(message.history) ? message.history.length : 0;
          resolve(`hello with ${count} history point(s)`);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });

      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  });

  await test('GET /stream.mjpeg emits a multipart JPEG frame', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${BASE}/stream.mjpeg`, { signal: controller.signal });
      assert(response.ok, `HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      assert(type.includes('multipart/x-mixed-replace'), `unexpected content-type: ${type}`);
      const reader = response.body.getReader();
      let received = Buffer.alloc(0);
      while (received.length < 512) {
        const { value, done } = await reader.read();
        if (done) break;
        received = Buffer.concat([received, Buffer.from(value)]);
      }
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
      const text = received.toString('latin1');
      assert(text.includes('Content-Type: image/jpeg'), 'no JPEG part header');
      assert(received.includes(Buffer.from([0xff, 0xd8])), 'no JPEG SOI marker');
      return `${received.length}B first chunk`;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });

  await test('Unknown API routes return structured 404 JSON', async () => {
    const response = await expectOk('/api/does-not-exist');
    assert(response.status === 404, `expected 404, got ${response.status}`);
    const body = await response.json();
    assert(body.ok === false && body.error === 'not_found', 'unexpected 404 body');
    return 'structured error';
  });

  console.log('');
  const passed = results.filter((result) => result.ok).length;
  if (failures) {
    console.log(`  ${red(`✖ ${failures} failed`)}, ${passed}/${results.length} passed\n`);
    process.exitCode = 1;
  } else {
    console.log(`  ${green(`✔ all ${passed} checks passed`)}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
