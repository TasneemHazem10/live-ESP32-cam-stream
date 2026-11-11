#!/usr/bin/env node
/**
 * Verifies the exact request the ESP32-CAM firmware sends:
 *
 *   POST /api/upload-frame?w=320&h=240&format=rgb565le&device=ESP32-CAM-RHYX
 *   Content-Type: application/octet-stream
 *   body: 153,600 bytes = 320 * 240 * 2 (RGB565, little-endian)
 *
 * It draws eight colour bars, uploads them, downloads the relay's JPEG and
 * checks that every bar came back with the right colour. A swapped red/blue
 * result means the byte order is wrong (rgb565be vs rgb565le).
 *
 *   node tools/esp-post-check.js
 *   SERVER_URL=https://mirsad-live.onrender.com node tools/esp-post-check.js
 */

import jpeg from 'jpeg-js';

const BASE = (process.env.SERVER_URL || process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const W = 320;
const H = 240;
const DEVICE = process.env.DEVICE_ID || 'ESP32-CAM-RHYX';

// r, g, b, expected name
const BARS = [
  [255, 255, 255, 'white'],
  [255, 255, 0, 'yellow'],
  [0, 255, 255, 'cyan'],
  [0, 255, 0, 'green'],
  [255, 0, 255, 'magenta'],
  [255, 0, 0, 'red'],
  [0, 0, 255, 'blue'],
  [0, 0, 0, 'black'],
];

function rgb565le(buffer) {
  const barWidth = W / BARS.length;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = BARS[Math.min(BARS.length - 1, Math.floor(x / barWidth))];
      const value = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
      const i = (y * W + x) * 2;
      buffer[i] = value & 0xff;         // low byte first = little-endian
      buffer[i + 1] = (value >> 8) & 0xff;
    }
  }
  return buffer;
}

function classify(r, g, b) {
  const near = (a, b2) => Math.abs(a - b2) < 40;
  if (near(r, 255) && near(g, 255) && near(b, 255)) return 'white';
  if (near(r, 255) && near(g, 255) && near(b, 0)) return 'yellow';
  if (near(r, 0) && near(g, 255) && near(b, 255)) return 'cyan';
  if (near(r, 0) && near(g, 255) && near(b, 0)) return 'green';
  if (near(r, 255) && near(g, 0) && near(b, 255)) return 'magenta';
  if (near(r, 255) && near(g, 0) && near(b, 0)) return 'red';
  if (near(r, 0) && near(g, 0) && near(b, 255)) return 'blue';
  if (near(r, 0) && near(g, 0) && near(b, 0)) return 'black';
  return `rgb(${r},${g},${b})`;
}

async function main() {
  const payload = rgb565le(Buffer.alloc(W * H * 2));
  console.log(`POST ${BASE}/api/upload-frame  (${payload.length} bytes, ${W}x${H} rgb565le)`);

  const url = `${BASE}/api/upload-frame?w=${W}&h=${H}&format=rgb565le&device=${encodeURIComponent(DEVICE)}`;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-device-id': DEVICE,
      'x-frame-width': String(W),
      'x-frame-height': String(H),
      'x-frame-format': 'rgb565le',
    },
    body: payload,
  });
  const body = await res.json().catch(() => ({}));
  console.log(`  -> HTTP ${res.status} in ${Date.now() - started} ms`, JSON.stringify(body));

  if (!res.ok) throw new Error(`Upload rejected: HTTP ${res.status} ${body.message || ''}`);

  const frameRes = await fetch(`${BASE}/api/frame.jpg?t=${Date.now()}`, { cache: 'no-store' });
  if (!frameRes.ok) throw new Error(`No frame available: HTTP ${frameRes.status}`);
  const jpegBuffer = Buffer.from(await frameRes.arrayBuffer());
  const img = jpeg.decode(jpegBuffer, { useTArray: true });

  console.log(`  JPEG: ${img.width}x${img.height}, ${jpegBuffer.length} bytes`);

  const barWidth = img.width / BARS.length;
  let failures = 0;
  for (let i = 0; i < BARS.length; i++) {
    const x = Math.floor(i * barWidth + barWidth / 2);
    const y = Math.floor(img.height / 2);
    const o = (y * img.width + x) * 4;
    const actual = classify(img.data[o], img.data[o + 1], img.data[o + 2]);
    const expected = BARS[i][3];
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`  bar ${i} x=${x}: expected ${expected.padEnd(8)} got ${actual.padEnd(8)} ${ok ? 'OK' : 'MISMATCH'}`);
  }

  if (img.width !== W || img.height !== H) {
    failures++;
    console.log(`  size mismatch: expected ${W}x${H}`);
  }

  if (failures) {
    console.error(`\nFAILED (${failures} check(s)). If red and blue are swapped, use ?format=rgb565be.`);
    process.exit(1);
  }
  console.log('\nPASS - relay decoded the firmware payload correctly.');
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});
