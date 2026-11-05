import { config } from './config.js';

const MAX_HISTORY = 360;
const MAX_KEYS = 32;

const ALIASES = new Map(
  Object.entries({
    temp: 'temperature',
    temperature_c: 'temperature',
    tempc: 'temperature',
    hum: 'humidity',
    humidity_pct: 'humidity',
    rh: 'humidity',
    soil_moisture: 'soil',
    soilmoisture: 'soil',
    moisture: 'soil',
    soil_pct: 'soil',
    lux: 'light',
    illuminance: 'light',
    brightness: 'light',
    light_pct: 'light',
    air_quality: 'airQuality',
    airquality: 'airQuality',
    aqi: 'airQuality',
    gas: 'airQuality',
    co2_ppm: 'co2',
    carbon: 'co2',
    pir: 'motion',
    movement: 'motion',
    presence: 'motion',
    pressure_hpa: 'pressure',
    battery_pct: 'battery',
    battery_voltage: 'voltage',
    rssi_dbm: 'rssi',
    water_temp: 'waterTemperature',
    tds_ppm: 'tds',
    turbidity_ntu: 'turbidity',
    flow_lpm: 'flow',
  }).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value]),
);

const META_KEYS = new Set([
  'deviceId',
  'device_id',
  'device',
  'id',
  'readings',
  'values',
  'sensors',
  'ts',
  'timestamp',
  'demo',
  'token',
  'source',
]);

const clampNumber = (value) => {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(-1_000_000, Math.min(1_000_000, value));
  return Math.round(clamped * 1000) / 1000;
};

const normalizeKey = (key) => {
  const cleaned = String(key).trim();
  if (!cleaned) return null;
  const alias = ALIASES.get(cleaned.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (alias) return alias;
  const camel = cleaned
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[A-Z]/, (chr) => chr.toLowerCase());
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(camel)) return null;
  return camel;
};

export class SensorStore {
  constructor() {
    this.latest = null;
    this.devices = new Map();
    this.history = [];
    this.listeners = new Set();
    this.lastRealAt = 0;
    this.lastDemoAt = 0;
    this.demoTimer = null;
    this.demoStartedAt = Date.now();
  }

  start() {
    if (!config.demoFallback || this.demoTimer) return;
    this.demoTimer = setInterval(() => this.maybeGenerateDemo(), 2000);
    this.demoTimer.unref?.();
  }

  stop() {
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = null;
    this.listeners.clear();
  }

  onUpdate(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  normalize(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Payload must be a JSON object');
    }

    const nested = payload.readings || payload.values || payload.sensors;
    const source = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : payload;

    const readings = {};
    let count = 0;

    for (const [rawKey, rawValue] of Object.entries(source)) {
      if (count >= MAX_KEYS) break;
      if (META_KEYS.has(rawKey)) continue;
      if (rawValue === null || rawValue === undefined) continue;
      if (typeof rawValue === 'object') continue;

      const key = normalizeKey(rawKey);
      if (!key) continue;

      if (typeof rawValue === 'boolean') {
        readings[key] = rawValue;
        count += 1;
        continue;
      }

      const numeric = typeof rawValue === 'number' ? rawValue : Number.parseFloat(String(rawValue));
      const value = clampNumber(numeric);
      if (value === null) continue;
      readings[key] = value;
      count += 1;
    }

    if (!count) throw new Error('No valid sensor readings found');

    const deviceId = String(
      payload.deviceId ||
        payload.device_id ||
        payload.device ||
        payload.id ||
        'ESP32-SENSOR-01',
    )
      .trim()
      .slice(0, 48) || 'ESP32-SENSOR-01';

    return {
      deviceId,
      readings,
      demo: Boolean(payload.demo),
    };
  }

  ingest(payload, meta = {}) {
    const { deviceId, readings, demo } = this.normalize(payload);
    const now = Date.now();
    const source = demo ? 'demo' : 'live';

    const record = {
      deviceId,
      readings,
      ts: now,
      source,
      demo: source === 'demo',
      ip: meta.ip || null,
    };

    this.latest = record;
    this.devices.set(deviceId, record);
    if (source === 'live') this.lastRealAt = now;

    this.history.push({ ...readings, t: now, demo: source === 'demo' });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);

    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        console.error('[sensors] listener failed:', error.message);
      }
    }

    return record;
  }

  getLatest() {
    if (!this.latest) return null;
    const ageMs = Math.max(0, Date.now() - this.latest.ts);
    return {
      ...this.latest,
      ageMs,
      connected: this.latest.source === 'live' && ageMs < 10_000,
    };
  }

  getHistory(limit = 120) {
    const size = Math.max(1, Math.min(MAX_HISTORY, Number(limit) || 120));
    return this.history.slice(-size);
  }

  getDevices() {
    return [...this.devices.values()].map((device) => ({
      deviceId: device.deviceId,
      source: device.source,
      lastSeen: new Date(device.ts).toISOString(),
      ageMs: Math.max(0, Date.now() - device.ts),
      readings: device.readings,
    }));
  }

  maybeGenerateDemo() {
    if (!config.demoFallback) return;
    if (Date.now() - this.lastRealAt < 6000) return;

    const t = (Date.now() - this.demoStartedAt) / 1000;
    const noise = (amount) => (Math.random() * 2 - 1) * amount;
    const motion = Math.floor(t / 2) % 17 === 0;

    this.ingest({
      deviceId: 'SIMULATED-SENSORS',
      demo: true,
      readings: {
        temperature: 26.4 + Math.sin(t / 19) * 2.4 + noise(0.18),
        humidity: 54 + Math.sin(t / 23 + 1.2) * 8 + noise(0.6),
        soil: 43 + Math.sin(t / 31 + 0.4) * 6 + noise(0.5),
        light: 62 + Math.sin(t / 9) * 23 + noise(1.2),
        airQuality: 18 + Math.sin(t / 13 + 2) * 6 + noise(1.1),
        motion,
        pressure: 1012 + Math.sin(t / 60) * 2 + noise(0.2),
        battery: 92 - Math.min(8, t / 600),
        rssi: -57 + noise(3),
      },
    });
    this.lastDemoAt = Date.now();
  }

  getStatus() {
    const latest = this.getLatest();
    return {
      connected: Boolean(latest?.connected),
      source: latest?.source || 'none',
      demo: latest?.source === 'demo',
      deviceId: latest?.deviceId || null,
      lastSeen: latest ? new Date(latest.ts).toISOString() : null,
      ageMs: latest?.ageMs ?? null,
      devices: this.devices.size,
      values: latest?.readings || null,
      history: this.history.length,
    };
  }
}

export const sensorStore = new SensorStore();
