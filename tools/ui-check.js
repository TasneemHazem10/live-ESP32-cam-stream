#!/usr/bin/env node
/**
 * Browser UI end-to-end check with Playwright + the locally installed Chrome.
 *
 *   npm start           # in one terminal
 *   npm run test:ui     # in another
 *
 * Verifies the live canvas, all eight vision effects, intensity/mirror/grid
 * controls, PNG snapshot download, transport switching (WebSocket, WebRTC,
 * MJPEG, HTTP polling), Arabic/English switching, sensor cards + telemetry
 * chart, TURN/status pills, the mobile menu, and horizontal-overflow hygiene.
 *
 * Screenshots are written to ./screenshots so the result can be reviewed later.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const BASE = (process.env.SERVER_URL || process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const results = [];
let failures = 0;

const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  throw new Error('Chrome/Edge was not found. Set CHROME_PATH to a Chromium executable.');
}

function attachErrorTracking(page, errors) {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // External font/CDN failures are not application errors.
    if (/fonts\.(googleapis|gstatic)\.com|ERR_(BLOCKED|CONNECTION|NETWORK|NAME)/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  page.on('crash', () => errors.push('page crashed'));
}

async function waitForReady(page, timeout = 25_000) {
  await page.waitForFunction(
    () => window.__MIRSAD__?.ready === true && window.__MIRSAD__.state.frameReady === true,
    undefined,
    { timeout },
  );
}

async function state(page) {
  return page.evaluate(() => window.__MIRSAD__.state);
}

async function waitForState(page, predicate, message, timeout = 20_000, arg = undefined) {
  try {
    await page.waitForFunction(predicate, arg, { timeout, polling: 100 });
  } catch {
    const snapshot = await state(page).catch(() => null);
    throw new Error(`${message} (state: ${JSON.stringify(snapshot)})`);
  }
}

async function canvasLooksAlive(page, selector) {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas) return { ok: false, reason: 'canvas missing' };
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { ok: false, reason: 'no 2d context' };
    const { width, height } = canvas;
    if (!width || !height) return { ok: false, reason: 'canvas has no size' };
    const { data } = ctx.getImageData(0, 0, width, height);
    const colours = new Set();
    let lit = 0;
    let samples = 0;
    const step = Math.max(1, Math.floor((width * height) / 1200));
    for (let pixel = 0; pixel < width * height; pixel += step) {
      const i = pixel * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma > 16) lit += 1;
      colours.add(`${r >> 4},${g >> 4},${b >> 4}`);
      samples += 1;
    }
    return {
      ok: colours.size > 10 && lit / samples > 0.08,
      colours: colours.size,
      litRatio: Number((lit / samples).toFixed(3)),
      size: `${width}x${height}`,
    };
  }, selector);
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const offenders = [];
    const viewport = window.innerWidth;

    // html has `overflow-x: clip`, so decorative orbs may paint outside their
    // box without creating a scrollable page. Measure the real scroll range:
    const before = window.scrollX;
    window.scrollTo(100000, window.scrollY);
    const movedRight = Math.abs(window.scrollX - before);
    window.scrollTo(-100000, window.scrollY);
    const movedLeft = Math.abs(window.scrollX - before);
    window.scrollTo(before, window.scrollY);

    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.right > viewport + 2 || rect.left < -2) {
        const style = getComputedStyle(element);
        if (style.position === 'fixed') continue;
        offenders.push(`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.classList.length ? `.${[...element.classList].slice(0, 2).join('.')}` : ''} (${Math.round(rect.left)}→${Math.round(rect.right)})`);
        if (offenders.length >= 5) break;
      }
    }
    return {
      overflow: root.scrollWidth - viewport,
      bodyOverflow: body.scrollWidth - viewport,
      scrollable: Math.max(movedRight, movedLeft) > 1,
      viewport,
      scrollWidth: root.scrollWidth,
      offenders,
    };
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const executablePath = findChrome();

  console.log('');
  console.log('  MIRSAD browser UI check');
  console.log(`  ➜  ${BASE}`);
  console.log(`  ➜  ${executablePath}`);
  console.log('');

  const browser = await chromium.launch({ executablePath, headless: true });

  try {
    /* ------------------------------------------------------------------ */
    /* Desktop                                                             */
    /* ------------------------------------------------------------------ */

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
      locale: 'ar-EG',
      timezoneId: 'Asia/Riyadh',
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    const errors = [];
    attachErrorTracking(page, errors);

    const consoleMessages = [];
    page.on('console', (message) => consoleMessages.push(message.text()));

    await test('page loads with Arabic-first RTL and boot diagnostics', async () => {
      const response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      assert(response?.ok(), `HTTP ${response?.status()}`);
      await page.waitForFunction(() => window.__MIRSAD__?.ready === true, undefined, { timeout: 20_000 });
      const info = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        title: document.title,
        effects: window.__MIRSAD__.effects.length,
        endpoint: document.getElementById('upload-endpoint')?.textContent || '',
      }));
      assert(info.lang === 'ar' && info.dir === 'rtl', `expected ar/rtl, got ${info.lang}/${info.dir}`);
      assert(info.effects === 8, `expected 8 effects, got ${info.effects}`);
      assert(info.endpoint.endsWith('/api/upload-frame'), `bad endpoint: ${info.endpoint}`);
      return `${info.lang}/${info.dir}, "${info.title.slice(0, 42)}…"`;
    });

    await test('live demo frames render into the studio canvas', async () => {
      await waitForReady(page);
      const live = await canvasLooksAlive(page, '#video-canvas');
      assert(live.ok, `canvas appears blank (${JSON.stringify(live)})`);
      const info = await state(page);
      assert(info.phase === 'connected', `stream phase is ${info.phase}`);
      assert(info.frameReady === true, 'frameReady is false');
      return `${live.size}, ${live.colours} colour buckets, ${live.litRatio} lit`;
    });

    await test('hero preview canvas also renders frames', async () => {
      const live = await canvasLooksAlive(page, '#hero-canvas');
      assert(live.ok, `hero canvas appears blank (${JSON.stringify(live)})`);
      return `${live.size}, ${live.colours} colour buckets`;
    });

    await test('all eight vision effects switch and report state', async () => {
      const effects = await page.evaluate(() => window.__MIRSAD__.effects);
      assert(effects.length === 8, `expected 8 effects, got ${effects.length}`);
      for (const id of effects) {
        await page.locator(`.effect-item[data-effect="${id}"]`).click();
        await waitForState(page, (expected) => window.__MIRSAD__.state.effect === expected, `effect ${id} did not activate`, 4000, id);
        const checked = await page.locator(`.effect-item[data-effect="${id}"]`).getAttribute('aria-checked');
        assert(checked === 'true', `effect ${id} aria-checked=${checked}`);
      }
      await page.locator('.effect-item[data-effect="water"]').click();
      await page.waitForTimeout(250);
      const hud = await page.locator('#hud-effect').textContent();
      assert(hud && hud.trim().length > 0, 'HUD effect label is empty');
      return `${effects.join(', ')} · HUD="${hud.trim()}"`;
    });

    await test('intensity, mirror and grid controls update the UI', async () => {
      await page.locator('#intensity').evaluate((input) => {
        input.value = '45';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForTimeout(120);
      const intensity = await page.locator('#intensity-value').textContent();
      const intensityState = (await state(page)).intensity;
      assert(intensity?.trim() === '45%', `intensity label is ${intensity}`);
      assert(Math.abs(intensityState - 0.45) < 0.001, `intensity state is ${intensityState}`);

      await page.locator('#mirror-btn').click();
      await page.waitForTimeout(120);
      assert(await page.locator('#video-wrap').evaluate((el) => el.classList.contains('is-mirrored')), 'mirror class missing');
      assert((await state(page)).mirror === true, 'mirror state is false');
      assert((await page.locator('#mirror-btn').getAttribute('aria-pressed')) === 'true', 'mirror aria-pressed missing');

      await page.locator('#grid-btn').click();
      await page.waitForTimeout(120);
      assert(await page.locator('#video-grid').evaluate((el) => el.classList.contains('is-on')), 'grid class missing');
      assert((await state(page)).grid === true, 'grid state is false');

      await page.locator('#mirror-btn').click();
      await page.locator('#grid-btn').click();
      return '45%, mirror on/off, grid on/off';
    });

    await test('snapshot downloads a real PNG', async () => {
      await page.locator('.effect-item[data-effect="thermal"]').click();
      await page.waitForTimeout(200);
      await waitForReady(page);
      const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
      await page.locator('#snapshot-btn').click();
      const download = await downloadPromise;
      const suggested = download.suggestedFilename();
      assert(/^mirsad-thermal-.*\.png$/i.test(suggested), `unexpected filename: ${suggested}`);
      const target = path.join(SHOTS, 'snapshot-test.png');
      await download.saveAs(target);
      const stat = fs.statSync(target);
      assert(stat.size > 1000, `snapshot is only ${stat.size} bytes`);
      return `${suggested} (${stat.size} bytes)`;
    });

    await test('WebSocket, WebRTC, MJPEG and HTTP transports all deliver frames', async () => {
      const transitions = [];
      for (const mode of ['webrtc', 'mjpeg', 'poll', 'ws']) {
        await page.locator(`.mode-btn[data-mode="${mode}"]`).click();
        await waitForState(
          page,
          (expected) => {
            const info = window.__MIRSAD__.state;
            return info.mode === expected && info.streamConnected === true && info.frameReady === true;
          },
          `${mode} transport did not deliver frames`,
          25_000,
          mode,
        );
        const info = await state(page);
        transitions.push(`${mode}:${info.phase}`);
        await page.waitForTimeout(250);
      }
      return transitions.join(' → ');
    });

    await test('sensor cards and telemetry chart receive live demo readings', async () => {
      await page.waitForFunction(
        () => {
          const cards = document.querySelectorAll('.sensor-card');
          const values = [...document.querySelectorAll('.sensor-card .sensor-value b')];
          return cards.length >= 6 && values.filter((node) => node.textContent !== '--').length >= 6;
        },
        undefined,
        { timeout: 25_000 },
      );
      const info = await state(page);
      assert(info.sensorKeys.length >= 6, `only ${info.sensorKeys.length} sensor cards`);
      assert(info.chartPoints > 0, 'telemetry chart has no points');
      const labels = await page.locator('.sensor-card .sensor-label').allTextContents();
      const values = await page.locator('.sensor-card .sensor-value').allTextContents();
      const chart = await page.evaluate(() => {
        const canvas = document.getElementById('sensor-chart');
        const ctx = canvas.getContext('2d');
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] + data[i + 1] + data[i + 2] > 40) lit += 1;
        return { width: canvas.width, height: canvas.height, lit };
      });
      assert(chart.lit > 20, `chart canvas is blank (${chart.lit} lit pixels)`);
      return `${info.sensorKeys.length} cards · ${labels.slice(0, 3).join(' / ')} = ${values.slice(0, 3).join(' / ')} · ${info.chartPoints} points`;
    });

    await test('TURN, camera and server pills report live state', async () => {
      await page.waitForFunction(
        () => (document.getElementById('server-pill-text')?.textContent || '').length > 0,
        undefined,
        { timeout: 10_000 },
      );
      const pills = await page.evaluate(() => ({
        turn: document.getElementById('turn-pill-text')?.textContent?.trim(),
        turnTitle: document.getElementById('turn-pill')?.getAttribute('title') || '',
        camera: document.getElementById('camera-pill-text')?.textContent?.trim(),
        server: document.getElementById('server-pill-text')?.textContent?.trim(),
        source: document.getElementById('source-badge')?.textContent?.trim(),
      }));
      assert(pills.turn, 'TURN pill is empty');
      assert(pills.camera, 'camera pill is empty');
      assert(pills.server, 'server pill is empty');
      assert(pills.source === 'DEMO' || pills.source === 'LIVE', `unexpected source badge: ${pills.source}`);
      return `TURN=${pills.turn}, camera=${pills.camera}, server=${pills.server}, source=${pills.source}`;
    });

    await test('language toggles between Arabic RTL and English LTR', async () => {
      const initial = await page.evaluate(() => document.documentElement.lang);
      await page.locator('#lang-toggle').click();
      await page.waitForFunction(
        (previous) => document.documentElement.lang !== previous,
        initial,
        { timeout: 5000 },
      );
      const after = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        label: document.querySelector('#lang-toggle .lang-label')?.textContent,
        nav: document.querySelector('#main-nav a')?.textContent,
      }));
      assert(after.lang === 'en' && after.dir === 'ltr', `expected en/ltr, got ${after.lang}/${after.dir}`);
      assert(after.label === 'ع', `toggle label is ${after.label}`);

      await page.locator('#lang-toggle').click();
      await page.waitForFunction(() => document.documentElement.lang === 'ar', undefined, { timeout: 5000 });
      const restored = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        nav: document.querySelector('#main-nav a')?.textContent,
      }));
      assert(restored.lang === 'ar' && restored.dir === 'rtl', `expected ar/rtl, got ${restored.lang}/${restored.dir}`);
      return `ar→en→ar · English nav="${after.nav}" · Arabic nav="${restored.nav}"`;
    });

    await test('desktop layout has no horizontal overflow', async () => {
      const report = await horizontalOverflow(page);
      assert(!report.scrollable, `page can scroll horizontally (${report.overflow}px)`);
      assert(report.overflow <= 1, `page overflows by ${report.overflow}px: ${report.offenders.join(', ')}`);
      return `${report.viewport}px viewport, scrollWidth=${report.scrollWidth}, not scrollable`;
    });

    await test('page and firmware downloads are healthy', async () => {
      const checks = [
        '/firmware/esp32cam-streamer/esp32cam-streamer.ino',
        '/firmware/esp32-sensor-node/esp32-sensor-node.ino',
        '/assets/favicon.svg',
        '/css/styles.css',
      ];
      for (const route of checks) {
        const response = await page.request.get(`${BASE}${route}`);
        assert(response.ok(), `${route} returned HTTP ${response.status()}`);
        if (route.endsWith('.ino')) {
          const body = await response.text();
          assert(body.includes('#include') || body.includes('void setup'), `${route} does not look like firmware`);
        }
      }
      return `${checks.length} assets and both firmware sketches downloaded`;
    });

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-home.png'), fullPage: true });
    await page.locator('#studio').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-studio.png') });

    await test('no uncaught browser errors during the desktop run', async () => {
      const relevant = errors.filter((entry) => !/favicon|net::ERR_/i.test(entry));
      assert(relevant.length === 0, relevant.join(' | '));
      return `${consoleMessages.length} console message(s), 0 errors`;
    });

    await context.close();

    /* ------------------------------------------------------------------ */
    /* Mobile                                                              */
    /* ------------------------------------------------------------------ */

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      acceptDownloads: true,
      locale: 'ar-EG',
      timezoneId: 'Asia/Riyadh',
    });
    const mobile = await mobileContext.newPage();
    const mobileErrors = [];
    attachErrorTracking(mobile, mobileErrors);

    await test('mobile layout loads, menu opens and nothing overflows', async () => {
      await mobile.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForReady(mobile);

      const menuVisible = await mobile.locator('#menu-toggle').isVisible();
      assert(menuVisible, 'mobile menu button is not visible');
      await mobile.locator('#menu-toggle').click();
      await mobile.waitForTimeout(250);
      const opened = await mobile.evaluate(() => ({
        open: document.getElementById('main-nav')?.classList.contains('is-open'),
        expanded: document.getElementById('menu-toggle')?.getAttribute('aria-expanded'),
      }));
      assert(opened.open === true, 'mobile nav did not open');
      assert(opened.expanded === 'true', 'aria-expanded was not set');

      await mobile.locator('#main-nav a[href="#sensors"]').click();
      await mobile.waitForTimeout(350);

      const report = await horizontalOverflow(mobile);
      assert(!report.scrollable, `mobile page can scroll horizontally (${report.overflow}px)`);
      assert(report.overflow <= 1, `mobile page overflows by ${report.overflow}px: ${report.offenders.join(', ')}`);

      const live = await canvasLooksAlive(mobile, '#video-canvas');
      assert(live.ok, `mobile canvas appears blank (${JSON.stringify(live)})`);

      const cards = await mobile.locator('.sensor-card').count();
      assert(cards >= 6, `mobile shows only ${cards} sensor cards`);
      return `${report.viewport}px, ${cards} sensor cards, ${live.colours} colour buckets`;
    });

    await test('mobile effects and controls are reachable', async () => {
      await mobile.locator('#studio').scrollIntoViewIfNeeded();
      const effects = await mobile.locator('.effect-item').count();
      assert(effects === 8, `mobile shows ${effects} effects`);
      await mobile.locator('.effect-item[data-effect="night"]').click();
      await mobile.waitForTimeout(200);
      assert((await state(mobile)).effect === 'night', 'mobile effect switch failed');
      return `${effects} effects, night mode active`;
    });

    await mobile.waitForTimeout(300);
    await mobile.screenshot({ path: path.join(SHOTS, 'mobile-home.png'), fullPage: true });

    await test('no uncaught browser errors during the mobile run', async () => {
      const relevant = mobileErrors.filter((entry) => !/favicon|net::ERR_/i.test(entry));
      assert(relevant.length === 0, relevant.join(' | '));
      return '0 errors';
    });

    await mobileContext.close();
  } finally {
    await browser.close();
  }

  console.log('');
  const passed = results.filter((result) => result.ok).length;
  if (failures) {
    console.log(`  ${red(`✖ ${failures} failed`)}, ${passed}/${results.length} passed`);
    console.log(`  Screenshots: ${SHOTS}\n`);
    process.exitCode = 1;
  } else {
    console.log(`  ${green(`✔ all ${passed} UI checks passed`)}`);
    console.log(`  Screenshots: ${SHOTS}\n`);
  }
}

main().catch((error) => {
  console.error(`\n  ${red('✖ UI check could not start')}\n    ${red(error.stack || error.message)}\n`);
  process.exitCode = 1;
});
