const params = new URLSearchParams(window.location.search);

// The relay (Render) is the only source of frames: the ESP32-CAM POSTs raw
// RGB565 buffers to /api/upload-frame there, the relay JPEG-encodes them and
// pushes them to browsers over /ws/frames. The dashboard is served by the same
// process, so an empty base means "same origin"; ?api= still overrides it for
// pointing a local page at a remote relay.
const configured = params.get('api') || window.MIRSAD_API_BASE || window.API_BASE || '';

export const API_BASE = String(configured).replace(/\/+$/, '');

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
