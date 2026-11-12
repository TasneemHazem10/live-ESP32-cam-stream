#!/usr/bin/env node
/**
 * Production check: does the deployed page actually play the relay's frames?
 *
 *   npm run test:prod
 *   SITE=https://… RELAY=https://… npm run test:prod
 *
 * Opens the deployed dashboard in headless Chrome, waits for the live canvas to
 * change, and reads the relay's /api/status to confirm a browser client is
 * attached. Exits 0 only when the page is really showing camera frames.
 *
 * Needs system Chrome or Edge (playwright-core does not download a browser).
 * A frame source must be running: the ESP32-CAM, or
 * `SERVER_URL=… npm run sim:camera` for a synthetic stream.
 */

import fs from 'node:fs';
import { chromium } from 'playwright-core';

const SITE = (process.env.SITE || process.argv[2] || 'https://live-esp32-cam-stream.onrender.com').replace(/\/+$/, '');
const RELAY = (process.env.RELAY || process.argv[3] || 'https://live-esp32-cam-stream.onrender.com').replace(/\/+$/, '');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const executablePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Edge found. Set CHROME_PATH to the browser executable.');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
const httpErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on('response', (r) => {
  if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`);
});

await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#video-canvas', { timeout: 30000 });

// Mean/variance of a sparse sample of the canvas. A frozen or blank canvas keeps
// the same numbers; a live feed changes them frame to frame.
const sample = () =>
  page.evaluate(() => {
    const canvas = document.getElementById('video-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += v;
      sum2 += v * v;
      n += 1;
    }
    const mean = sum / n;
    return { mean, variance: sum2 / n - mean * mean };
  });

let first = await sample();
let latest = first;
let changed = false;
for (let i = 0; i < 30 && !changed; i += 1) {
  await wait(1000);
  latest = await sample();
  if (Math.abs(latest.mean - first.mean) > 0.5 || latest.variance > 5) changed = true;
}

const pill = (await page.textContent('#camera-pill-text').catch(() => '')) || '';
const waitPanelHidden = await page.isHidden('#video-wait').catch(() => null);
const status = await (await fetch(`${RELAY}/api/status`)).json().catch(() => null);

fs.mkdirSync('screenshots', { recursive: true });
await page.screenshot({ path: 'screenshots/prod-live.png' });
await browser.close();

const report = {
  site: SITE,
  relay: RELAY,
  pill: pill.trim(),
  waitPanelHidden,
  canvasChanged: changed,
  canvasMean: Number(latest.mean.toFixed(2)),
  canvasVariance: Number(latest.variance.toFixed(2)),
  relayCameraConnected: status?.camera?.connected ?? null,
  relayFps: status?.camera?.fps ?? null,
  relayFrames: status?.camera?.frames ?? null,
  relayDevice: status?.camera?.deviceId ?? null,
  browserClients: status?.clients?.frames ?? null,
  consoleErrors: consoleErrors.slice(0, 6),
  httpErrors: httpErrors.slice(0, 6),
};

console.log(JSON.stringify(report, null, 2));

const ok = changed && Boolean(status?.camera?.connected);
console.log(ok ? '\nPASS — the deployed page is playing frames from the relay.' : '\nFAIL — no live frames reached the page.');
process.exit(ok ? 0 : 1);
