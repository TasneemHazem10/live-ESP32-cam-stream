const params = new URLSearchParams(window.location.search);
const configured = params.get('api') || window.API_BASE || '';

export const API_BASE = String(configured).replace(/\/+$/, '');

// The ESP32-CAM publishes JPEG frames to a public MQTT broker. Browsers receive
// them over a WebSocket (WSS on port 443), so the live feed does not depend on
// any single serverless instance. Override with ?broker=&topic= or by setting
// window.MIRSAD_BROKER_* before the module loads.
export const BROKER = {
  url: params.get('broker') || window.MIRSAD_BROKER_URL || 'wss://public.cloud.shiftr.io',
  topic: params.get('topic') || window.MIRSAD_BROKER_TOPIC || 'mirsad/live/a7f3c9e1d84b4f06b2a5',
  username: params.get('brokerUser') || window.MIRSAD_BROKER_USER || 'public',
  password: params.get('brokerPass') || window.MIRSAD_BROKER_PASS || 'public',
};

export function api(path) {
  return `${API_BASE}${path}`;
}

export function wsUrl(path) {
  if (!API_BASE) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${path}`;
  }
  try {
    const url = new URL(API_BASE);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${url.host}${path}`;
  } catch {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${path}`;
  }
}

export function absoluteUrl(path) {
  if (!API_BASE) return `${window.location.origin}${path}`;
  try {
    return new URL(path, `${API_BASE}/`).href;
  } catch {
    return `${API_BASE}${path}`;
  }
}
