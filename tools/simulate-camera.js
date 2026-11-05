#!/usr/bin/env node
/**
 * Generates a synthetic 320x240 RGB565 scene and pushes it to the relay at a
 * configurable frame rate. Useful for testing the full ingestion -> JPEG ->
 * WebSocket/MJPEG/WebRTC path without physical hardware.
 *
 *   npm run sim:camera
 *   SERVER_URL=http://localhost:3000 FPS=12 npm run sim:camera
 */

const BASE = (process.env.SERVER_URL || process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const WIDTH = Math.max(16, Math.min(1280, Number(process.env.WIDTH) || 320));
const HEIGHT = Math.max(16, Math.min(960, Number(process.env.HEIGHT) || 240));
const FPS = Math.max(1, Math.min(20, Number(process.env.FPS) || 10));
const TOKEN = process.env.UPLOAD_TOKEN || '';
const DEVICE = process.env.DEVICE_ID || 'SIMULATOR-CAM';
const INTERVAL = Math.round(1000 / FPS);
const ENDPOINT = `${BASE}/api/upload-frame?w=${WIDTH}&h=${HEIGHT}&format=rgb565le&device=${encodeURIComponent(DEVICE)}`;

const clamp = (value) => (value < 0 ? 0 : value > 255 ? 255 : value | 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function renderScene(t) {
  const buffer = Buffer.allocUnsafe(WIDTH * HEIGHT * 2);
  const horizon = HEIGHT * 0.62;
  const sunX = WIDTH * 0.7;
  const sunY = HEIGHT * 0.28;
  const sunR = Math.max(14, WIDTH * 0.09);

  let offset = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    const ny = y / HEIGHT;
    const inWater = y > horizon;
    const depth = inWater ? (y - horizon) / (HEIGHT - horizon) : 0;

    for (let x = 0; x < WIDTH; x += 1) {
      let r;
      let g;
      let b;

      if (!inWater) {
        r = 4 + 12 * ny;
        g = 8 + 26 * ny;
        b = 26 + 62 * ny;

        const aurora =
          Math.sin(x * 0.026 + t * 1.5) *
          Math.sin(y * 0.021 - t * 0.9 + Math.sin(x * 0.011 + t) * 1.8);
        const glow = Math.max(0, aurora) ** 3;
        r += glow * 40;
        g += glow * 160;
        b += glow * 135;

        const dx = x - sunX;
        const dy = y - sunY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < sunR) {
          const k = 1 - distance / sunR;
          r += 245 * k;
          g += 150 * k;
          b += 52 * k;
        } else if (distance < sunR * 1.7) {
          const k = 1 - (distance - sunR) / (sunR * 0.7);
          r += 52 * k;
          g += 24 * k;
          b += 12 * k;
        }

        const star = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        if (star - Math.floor(star) > 0.9982) {
          r += 70;
          g += 82;
          b += 100;
        }
      } else {
        const ripple =
          Math.sin((y - horizon) * 0.34 - t * 2.6 + Math.sin(x * 0.05 + t) * 2.2) *
          (4 + 22 * depth);
        r = 2 + 7 * depth + ripple * 0.1;
        g = 18 + 54 * depth + ripple * 0.4;
        b = 56 + 136 * depth + ripple;

        const reflection =
          Math.exp(-(((x - sunX) / (26 + depth * 70)) ** 2)) * (1 - depth * 0.4);
        r += 200 * reflection;
        g += 106 * reflection;
        b += 40 * reflection;

        if ((y - horizon) % 24 < 1 && depth > 0.08) {
          r += 7;
          g += 26;
          b += 32;
        }
      }

      const vx = (x / WIDTH - 0.5) * 2;
      const vy = (y / HEIGHT - 0.5) * 2;
      const vignette = 1 - Math.min(1, (vx * vx + vy * vy) * 0.24);
      r *= vignette;
      g *= vignette;
      b *= vignette;

      const pixel = ((clamp(r) >> 3) << 11) | ((clamp(g) >> 2) << 5) | (clamp(b) >> 3);
      buffer.writeUInt16LE(pixel, offset);
      offset += 2;
    }
  }

  return buffer;
}

async function postFrame(frame) {
  const headers = {
    'content-type': 'application/octet-stream',
    'x-device-id': DEVICE,
  };
  if (TOKEN) headers['x-upload-token'] = TOKEN;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: frame,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${text.slice(0, 140)}`);
  }
  return response.json();
}

async function main() {
  console.log('');
  console.log('  MIRSAD synthetic camera');
  console.log(`  ➜  relay   ${BASE}`);
  console.log(`  ➜  frame   ${WIDTH}x${HEIGHT} RGB565 LE (${WIDTH * HEIGHT * 2} bytes)`);
  console.log(`  ➜  target  ${FPS} fps`);
  console.log('');

  let sent = 0;
  let failed = 0;
  let bytes = 0;
  let consecutive = 0;
  let stopped = false;
  let lastReport = Date.now();
  let lastCount = 0;

  process.on('SIGINT', () => {
    stopped = true;
  });

  let frameIndex = 0;
  while (!stopped) {
    const started = Date.now();
    const frame = renderScene(frameIndex * 0.08);
    frameIndex += 1;

    try {
      await postFrame(frame);
      sent += 1;
      bytes += frame.length;
      consecutive = 0;
    } catch (error) {
      failed += 1;
      consecutive += 1;
      if (failed === 1 || consecutive % 10 === 0) {
        console.warn(`  ! upload failed (${consecutive}x): ${error.message}`);
      }
      if (consecutive >= 20) {
        console.error('  ! 20 consecutive failures — is the server running?');
        process.exitCode = 1;
        break;
      }
    }

    if (Date.now() - lastReport >= 2000) {
      const seconds = (Date.now() - lastReport) / 1000;
      const actualFps = ((sent - lastCount) / seconds).toFixed(1);
      const mbps = ((bytes * 8) / 1_000_000 / ((Date.now() - lastReport) / 1000)).toFixed(2);
      console.log(`  ✓ sent=${sent} failed=${failed} fps=${actualFps} wire≈${mbps} Mbps`);
      lastReport = Date.now();
      lastCount = sent;
      bytes = 0;
    }

    const elapsed = Date.now() - started;
    await sleep(Math.max(2, INTERVAL - elapsed));
  }

  console.log(`\n  stopped. sent=${sent} failed=${failed}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
