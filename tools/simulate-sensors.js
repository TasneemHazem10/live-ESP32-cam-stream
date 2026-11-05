#!/usr/bin/env node
/**
 * Pushes realistic ESP32 sensor readings to the relay every two seconds.
 *
 *   npm run sim:sensors
 *   SERVER_URL=http://localhost:3000 INTERVAL=1000 npm run sim:sensors
 *
 * Set DEMO=1 to mark the readings as demo data instead of a live device.
 */

const BASE = (process.env.SERVER_URL || process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.UPLOAD_TOKEN || '';
const DEVICE = process.env.DEVICE_ID || 'ESP32-SENSOR-SIM';
const INTERVAL = Math.max(500, Number(process.env.INTERVAL) || 2000);
const DEMO = /^(1|true|yes)$/i.test(process.env.DEMO || '');
const ENDPOINT = `${BASE}/api/sensors`;
const STARTED = Date.now();

const round = (value, decimals = 1) => Math.round(value * 10 ** decimals) / 10 ** decimals;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reading(t) {
  const noise = (amount) => (Math.random() * 2 - 1) * amount;
  const motion = Math.floor(t / 14) % 11 === 0;
  return {
    temperature: round(26.4 + Math.sin(t / 19) * 2.4 + noise(0.18), 1),
    humidity: round(54 + Math.sin(t / 23 + 1.2) * 8 + noise(0.6), 1),
    soil: round(43 + Math.sin(t / 31 + 0.4) * 6 + noise(0.5), 1),
    light: round(62 + Math.sin(t / 9) * 23 + noise(1.2), 0),
    airQuality: round(18 + Math.sin(t / 13 + 2) * 6 + noise(1.1), 0),
    motion,
    pressure: round(1012 + Math.sin(t / 60) * 2 + noise(0.2), 1),
    battery: round(92 - Math.min(8, t / 600), 0),
    rssi: round(-57 + noise(3), 0),
  };
}

async function post(payload) {
  const headers = {
    'content-type': 'application/json',
    'x-device-id': DEVICE,
  };
  if (TOKEN) headers['x-upload-token'] = TOKEN;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${text.slice(0, 140)}`);
  }
  return response.json();
}

async function main() {
  console.log('');
  console.log('  MIRSAD synthetic sensor node');
  console.log(`  ➜  relay   ${BASE}`);
  console.log(`  ➜  device  ${DEVICE}${DEMO ? ' (marked as demo)' : ' (live device)'}`);
  console.log(`  ➜  every   ${INTERVAL} ms`);
  console.log('');

  let sent = 0;
  let failed = 0;
  let consecutive = 0;
  let stopped = false;

  process.on('SIGINT', () => {
    stopped = true;
  });

  while (!stopped) {
    const t = (Date.now() - STARTED) / 1000;
    const values = reading(t);
    const payload = {
      deviceId: DEVICE,
      ...(DEMO ? { demo: true } : {}),
      readings: values,
    };

    try {
      await post(payload);
      sent += 1;
      consecutive = 0;
      const parts = Object.entries(values)
        .slice(0, 6)
        .map(([key, value]) => `${key}=${typeof value === 'boolean' ? (value ? 'motion' : 'clear') : value}`);
      console.log(`  ✓ #${sent} ${parts.join(' ')}`);
    } catch (error) {
      failed += 1;
      consecutive += 1;
      console.warn(`  ! failed (${consecutive}x): ${error.message}`);
      if (consecutive >= 15) {
        console.error('  ! 15 consecutive failures — is the server running?');
        process.exitCode = 1;
        break;
      }
    }

    await sleep(INTERVAL);
  }

  console.log(`\n  stopped. sent=${sent} failed=${failed}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
