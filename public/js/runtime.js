const params = new URLSearchParams(window.location.search);
const configured = params.get('api') || window.API_BASE || '';

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
