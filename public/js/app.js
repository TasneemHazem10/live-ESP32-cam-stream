import { getLang, initI18n, t } from './i18n.js';
import { EFFECTS, applyEffect } from './effects.js';
import { LiveStream } from './stream.js';
import { Sparkline, TelemetryChart } from './charts.js';
import { absoluteUrl, api, wsUrl } from './runtime.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MODE_IDS = ['ws', 'webrtc', 'mjpeg', 'poll', 'livekit'];
const MODE_LABELS = { ws: 'WS', webrtc: 'WEBRTC', mjpeg: 'MJPEG', poll: 'HTTP', livekit: 'LIVEKIT' };
const SENSOR_STALE_MS = 12_000;

// Only the machine that runs the relay (opened as localhost) owns the camera.
// Every other device — a phone on the LAN, a remote browser — is a viewer and
// must never prompt for camera access.
function isRelayLaptop() {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

// Camera publishing is only allowed from a local/private origin. A public
// tunnel URL (Cloudflare Tunnel, ngrok, a hosted frontend…) is watch-only even
// if the relay is reached through a proxy that makes the source address look
// local. This is what stops remote visitors from being prompted for a camera.
function isPrivateHostname(host) {
  const name = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!name) return false;
  if (name === 'localhost' || name === '::1' || name === '127.0.0.1' || /^127\./.test(name)) return true;
  if (/^10\./.test(name)) return true;
  if (/^192\.168\./.test(name)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
  return /\.local$/.test(name);
}

function isLocalOrigin() {
  return isPrivateHostname(window.location.hostname);
}

// 'laptop' = this browser may own the camera; 'viewer' = watch-only device.
// The server confirms the role from the request's source address, which also
// covers the laptop opening the dashboard through its own LAN IP.
let relayRole = isRelayLaptop() ? 'laptop' : isLocalOrigin() ? 'unknown' : 'viewer';
let relayRoleLocked = isRelayLaptop() || !isLocalOrigin();

const SENSOR_DEFS = {
  temperature: { icon: 'thermometer', accent: '#fb923c', unit: '°C', decimals: 1, labelKey: 'sensor.temperature' },
  humidity: { icon: 'droplet', accent: '#22d3ee', unit: '%', decimals: 1, labelKey: 'sensor.humidity' },
  soil: { icon: 'leaf', accent: '#a3e635', unit: '%', decimals: 1, labelKey: 'sensor.soil' },
  light: { icon: 'sun', accent: '#fbbf24', unit: '%', decimals: 0, labelKey: 'sensor.light' },
  airQuality: { icon: 'wind', accent: '#a78bfa', unit: 'AQI', decimals: 0, labelKey: 'sensor.airQuality' },
  motion: { icon: 'motion', accent: '#f472b6', unit: '', decimals: 0, labelKey: 'sensor.motion', boolean: true },
  pressure: { icon: 'activity', accent: '#38bdf8', unit: 'hPa', decimals: 1, labelKey: 'sensor.pressure' },
  battery: { icon: 'bolt', accent: '#34d399', unit: '%', decimals: 0, labelKey: 'sensor.battery' },
  rssi: { icon: 'wifi', accent: '#94a3b8', unit: 'dBm', decimals: 0, labelKey: 'sensor.rssi' },
  co2: { icon: 'wind', accent: '#c4b5fd', unit: 'ppm', decimals: 0, labelKey: 'sensor.co2' },
  waterLevel: { icon: 'droplet', accent: '#60a5fa', unit: '%', decimals: 0, labelKey: 'sensor.waterLevel' },
  waterTemperature: { icon: 'droplet', accent: '#38bdf8', unit: '°C', decimals: 1, labelKey: 'sensor.waterTemperature' },
  tds: { icon: 'droplet', accent: '#67e8f9', unit: 'ppm', decimals: 0, labelKey: 'sensor.tds' },
  turbidity: { icon: 'droplet', accent: '#7dd3fc', unit: 'NTU', decimals: 1, labelKey: 'sensor.turbidity' },
  flow: { icon: 'wind', accent: '#22d3ee', unit: 'L/m', decimals: 2, labelKey: 'sensor.flow' },
};

const PRIMARY_SENSORS = ['temperature', 'humidity', 'soil', 'light', 'airQuality', 'motion'];

const state = {
  effect: 'raw',
  intensity: 1,
  mirror: false,
  grid: false,
  mode: 'ws',
  phase: 'connecting',
  tour: false,
  tourTimer: null,
  frameReady: false,
  source: 'none',
  streamConnected: false,
  lastFrameMeta: { width: 320, height: 240 },
  lastFrameAt: 0,
  lang: 'ar',
};

/* -------------------------------------------------------------------------- */
/* DOM                                                                         */
/* -------------------------------------------------------------------------- */

initI18n();
state.lang = getLang();

const dom = {
  heroCanvas: $('hero-canvas'),
  videoCanvas: $('video-canvas'),
  videoWrap: $('video-wrap'),
  videoWait: $('video-wait'),
  previewStage: document.querySelector('.preview-stage'),
  previewNote: document.querySelector('.preview-note'),
  heroFps: $('hero-fps'),
  heroLatency: $('hero-latency'),
  heroSource: $('hero-source'),
  heroClock: $('hero-clock'),
  statFps: $('stat-fps'),
  statLatency: $('stat-latency'),
  cameraPill: $('camera-pill'),
  cameraPillText: $('camera-pill-text'),
  turnPill: $('turn-pill'),
  turnPillText: $('turn-pill-text'),
  sourceBadge: $('source-badge'),
  studioFps: $('studio-fps'),
  studioLatency: $('studio-latency'),
  studioMode: $('studio-mode'),
  hudEffect: $('hud-effect'),
  videoTime: $('video-time'),
  metricFps: $('metric-fps'),
  metricLatency: $('metric-latency'),
  metricBitrate: $('metric-bitrate'),
  metricResolution: $('metric-resolution'),
  metricFrames: $('metric-frames'),
  effectList: $('effect-list'),
  intensity: $('intensity'),
  intensityValue: $('intensity-value'),
  tourBtn: $('tour-btn'),
  snapshotBtn: $('snapshot-btn'),
  mirrorBtn: $('mirror-btn'),
  gridBtn: $('grid-btn'),
  fullscreenBtn: $('fullscreen-btn'),
  videoGrid: $('video-grid'),
  sensorPill: $('sensor-pill'),
  sensorPillText: $('sensor-pill-text'),
  sensorChart: $('sensor-chart'),
  sensorDevice: $('sensor-device'),
  sensorUpdated: $('sensor-updated'),
  floatTemp: $('float-temp'),
  sensorGrid: $('sensor-grid'),
  toastStack: $('toast-stack'),
  serverPill: $('server-pill'),
  serverPillText: $('server-pill-text'),
  langToggle: $('lang-toggle'),
  menuToggle: $('menu-toggle'),
  mainNav: $('main-nav'),
  progressBar: $('progress-bar'),
  siteHeader: $('site-header'),
  year: $('year'),
};

const heroCtx = dom.heroCanvas?.getContext('2d');
const videoCtx = dom.videoCanvas?.getContext('2d');

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

const filterCanvas = document.createElement('canvas');
const filterCtx = filterCanvas.getContext('2d', { willReadFrequently: true });
let srcImageData = null;
let dstImageData = null;

function prepareCanvas(canvas, ctx) {
  if (!canvas || !ctx) return { width: 0, height: 0 };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round((rect.width || canvas.clientWidth || 320) * dpr));
  const height = Math.max(1, Math.round((rect.height || canvas.clientHeight || 240) * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}

function drawFrameTo(canvas, ctx, source, sourceWidth, sourceHeight) {
  const { width, height } = prepareCanvas(canvas, ctx);
  if (!width || !height) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#02040b';
  ctx.fillRect(0, 0, width, height);

  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const x = Math.round((width - drawWidth) / 2);
  const y = Math.round((height - drawHeight) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, drawWidth, drawHeight);
}

function renderFrame(source, meta = {}) {
  const sourceWidth = Number(meta.width) || source.width || source.naturalWidth || 320;
  const sourceHeight = Number(meta.height) || source.height || source.naturalHeight || 240;
  if (!sourceWidth || !sourceHeight) return;

  // Filter at a sensible working resolution (never upscale the camera feed).
  const maxWidth = 640;
  const scale = Math.min(1, maxWidth / sourceWidth);
  const workWidth = Math.max(16, Math.round(sourceWidth * scale));
  const workHeight = Math.max(12, Math.round(sourceHeight * scale));

  if (filterCanvas.width !== workWidth || filterCanvas.height !== workHeight) {
    filterCanvas.width = workWidth;
    filterCanvas.height = workHeight;
    srcImageData = null;
    dstImageData = null;
  }

  filterCtx.clearRect(0, 0, workWidth, workHeight);
  filterCtx.drawImage(source, 0, 0, workWidth, workHeight);

  if (state.effect !== 'raw') {
    try {
      srcImageData = filterCtx.getImageData(0, 0, workWidth, workHeight);
      if (!dstImageData || dstImageData.width !== workWidth || dstImageData.height !== workHeight) {
        dstImageData = filterCtx.createImageData(workWidth, workHeight);
      }
      applyEffect(state.effect, srcImageData, dstImageData, state.intensity);
      filterCtx.putImageData(dstImageData, 0, 0);
    } catch (error) {
      console.warn('[fx] effect failed, painting raw frame:', error);
    }
  }

  drawFrameTo(dom.videoCanvas, videoCtx, filterCanvas, workWidth, workHeight);
  drawFrameTo(dom.heroCanvas, heroCtx, filterCanvas, workWidth, workHeight);

  state.lastFrameMeta = { width: sourceWidth, height: sourceHeight };
  dom.metricResolution.textContent = `${sourceWidth}×${sourceHeight}`;
  hideWait();
}

function hideWait() {
  if (!state.frameReady) {
    state.frameReady = true;
    if (dom.videoWait) dom.videoWait.hidden = true;
  }
}

function showWait() {
  state.frameReady = false;
  if (dom.videoWait) dom.videoWait.hidden = false;
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

const TOAST_ICONS = {
  info: 'i-sparkles',
  success: 'i-check',
  warn: 'i-lock',
  error: 'i-close',
};

function showToast(message, kind = 'info', timeout = 4200) {
  if (!dom.toastStack || !message) return;
  while (dom.toastStack.children.length >= 4) {
    dom.toastStack.firstElementChild?.remove();
  }

  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.innerHTML = `
    <span class="toast-icon"><svg class="icon"><use href="#${TOAST_ICONS[kind] || TOAST_ICONS.info}"></use></svg></span>
    <span class="toast-message"></span>
  `;
  toast.querySelector('.toast-message').textContent = message;
  dom.toastStack.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('is-visible'));
  const remove = () => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 320);
  };
  const timer = setTimeout(remove, timeout);
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

/* -------------------------------------------------------------------------- */
/* Vision effects                                                              */
/* -------------------------------------------------------------------------- */

function effectButton(effect) {
  return `
    <span class="effect-icon"><svg class="icon"><use href="#i-${effect.icon}"></use></svg></span>
    <span class="effect-copy"><b>${t(effect.nameKey)}</b><small>${t(effect.descKey)}</small></span>
    <span class="effect-check"><svg class="icon"><use href="#i-check"></use></svg></span>
  `;
}

function renderEffects() {
  if (!dom.effectList) return;
  dom.effectList.replaceChildren();

  for (const effect of EFFECTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'effect-item';
    button.dataset.effect = effect.id;
    button.style.setProperty('--accent', effect.accent);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(state.effect === effect.id));
    if (state.effect === effect.id) button.classList.add('is-active');
    button.innerHTML = effectButton(effect);
    button.addEventListener('click', () => {
      stopTour();
      setEffect(effect.id);
    });
    dom.effectList.appendChild(button);
  }
  updateEffectLabels();
}

function setEffect(id) {
  if (!EFFECTS.some((effect) => effect.id === id)) return;
  state.effect = id;
  for (const button of dom.effectList.querySelectorAll('.effect-item')) {
    const active = button.dataset.effect === id;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  }
  updateEffectLabels();
}

function updateEffectLabels() {
  const effect = EFFECTS.find((item) => item.id === state.effect) || EFFECTS[0];
  dom.hudEffect.textContent = t(effect.nameKey);
}

function setIntensity(percent) {
  const value = clamp(Number(percent) || 0, 0, 100);
  state.intensity = value / 100;
  if (dom.intensity) dom.intensity.value = String(value);
  if (dom.intensityValue) dom.intensityValue.textContent = `${Math.round(value)}%`;
}

function updateTourButton() {
  if (!dom.tourBtn) return;
  dom.tourBtn.classList.toggle('is-active', state.tour);
  const use = dom.tourBtn.querySelector('use');
  if (use) use.setAttribute('href', state.tour ? '#i-close' : '#i-sparkles');
  const label = dom.tourBtn.querySelector('span');
  if (label) label.textContent = t(state.tour ? 'studio.tourOn' : 'studio.tour');
}

function stopTour() {
  if (!state.tour) return;
  state.tour = false;
  if (state.tourTimer) clearInterval(state.tourTimer);
  state.tourTimer = null;
  updateTourButton();
}

function startTour() {
  if (state.tour) {
    stopTour();
    return;
  }
  state.tour = true;
  updateTourButton();

  let index = Math.max(0, EFFECTS.findIndex((effect) => effect.id === state.effect));
  const advance = () => {
    index = (index + 1) % EFFECTS.length;
    setEffect(EFFECTS[index].id);
  };
  advance();
  state.tourTimer = setInterval(advance, 3200);
}

/* -------------------------------------------------------------------------- */
/* Stream                                                                      */
/* -------------------------------------------------------------------------- */

const stream = new LiveStream({
  onFrame(bitmap, meta) {
    state.streamConnected = true;
    state.lastFrameAt = Date.now();
    applySource(meta.source || stream.lastSource || state.source);
    renderFrame(bitmap, meta);
    hideWait();
    updateCameraPill();
  },
  onState({ phase, source, connected }) {
    state.phase = phase;
    state.streamConnected = Boolean(connected);
    if (source) applySource(source);
    if (phase === 'connecting' || phase === 'reconnecting' || phase === 'error') {
      showWait();
    }
    updateCameraPill();
  },
  onStats(stats) {
    updateStats(stats);
  },
  onError(error) {
    if (!error) return;
    if (error.code === 'turn_missing') {
      showToast(t('toast.stun'), 'warn');
      return;
    }
    if (error.code === 'livekit_not_configured') {
      showToast(t('toast.livekitMissing'), 'warn', 6000);
      return;
    }
    if (error.code === 'livekit_publish_failed') {
      // The laptop preview is already live; only remote sharing failed.
      if (state.mode === 'camera') showToast(t('toast.livekitPublish'), 'warn', 6000);
      return;
    }
    if (error.code === 'relay_publish_failed') {
      // Local preview keeps running; only the relay copy of the camera stopped.
      if (state.mode === 'camera') {
        showToast(
          t(error.soft ? 'toast.relayPublishSoft' : 'toast.relayPublish'),
          error.soft ? 'warn' : 'error',
          7000,
        );
      }
      return;
    }
    if (
      error.code === 'NotAllowedError' ||
      error.code === 'PermissionDeniedError' ||
      /permission|denied|not allowed/i.test(error.message || '')
    ) {
      showToast(t('toast.cameraDenied'), 'error', 6000);
      if (state.mode === 'camera') showWait();
      return;
    }
    if (error.code === 'rtc_unavailable') {
      showToast(t('toast.rtcUnavailable'), 'error');
    }
    if (state.mode === 'webrtc') {
      showToast(t('toast.webrtcFail'), 'error');
      startMode('ws', { announce: false });
      return;
    }
    if (error.code === 'ws_failed' || error.code === 'ws_no_frames') {
      if (state.mode === 'ws') {
        if (error.code === 'ws_failed') showToast(t('toast.wsFallback'), 'warn');
        startMode('poll', { announce: false });
      }
      return;
    }
    if (error.code === 'mjpeg_no_frames') {
      if (state.mode === 'mjpeg') startMode('poll', { announce: false });
      return;
    }
    showToast(error.message || t('status.offline'), 'error');
  },
  onSensor(message) {
    if (message?.type === 'sensor' && message.readings) {
      applySensorRecord(message);
    }
  },
});

function updateStats(stats = {}) {
  const fps = Number.isFinite(stats.fps) ? Math.round(stats.fps * 10) / 10 : null;
  const latency = Number.isFinite(stats.latency) ? Math.max(0, Math.round(stats.latency)) : null;
  const bitrate = Number.isFinite(stats.bitrateKbps) ? stats.bitrateKbps : null;

  if (dom.heroFps) dom.heroFps.textContent = fps === null ? '--' : String(fps);
  if (dom.statFps) dom.statFps.textContent = fps === null ? '--' : String(fps);
  if (dom.studioFps) dom.studioFps.textContent = fps === null ? '--' : String(fps);
  if (dom.metricFps) dom.metricFps.textContent = fps === null ? '--' : String(fps);

  if (dom.heroLatency) dom.heroLatency.textContent = latency === null ? '--' : String(latency);
  if (dom.statLatency) dom.statLatency.textContent = latency === null ? '--' : String(latency);
  if (dom.studioLatency) dom.studioLatency.textContent = latency === null ? '--' : `${latency} ms`;
  if (dom.metricLatency) dom.metricLatency.textContent = latency === null ? '--' : `${latency} ms`;

  if (dom.metricBitrate) {
    if (bitrate === null) dom.metricBitrate.textContent = '--';
    else if (bitrate >= 1000) dom.metricBitrate.textContent = `${(bitrate / 1000).toFixed(2)} Mbps`;
    else dom.metricBitrate.textContent = `${Math.round(bitrate)} kbps`;
  }

  if (dom.metricFrames) {
    const frames = Number.isFinite(stats.frames) ? stats.frames : null;
    dom.metricFrames.textContent = frames === null ? '--' : frames.toLocaleString(state.lang === 'ar' ? 'ar-EG' : 'en-US');
  }

  if (stats.connected === false && fps === 0) {
    // Keep the last useful values while reconnecting; only zero the live rate.
    if (dom.heroFps) dom.heroFps.textContent = '--';
    if (dom.studioFps) dom.studioFps.textContent = '--';
  }
}

function applySource(source) {
  const value = ['live', 'demo', 'none'].includes(source) ? source : state.source;
  state.source = value;
  const label = value === 'live' ? 'LIVE' : value === 'demo' ? 'DEMO' : 'OFF';
  const isLive = value === 'live';

  if (dom.heroSource) {
    dom.heroSource.textContent = label;
    dom.heroSource.classList.toggle('is-live', isLive);
  }
  if (dom.sourceBadge) {
    dom.sourceBadge.textContent = label;
    dom.sourceBadge.classList.toggle('is-live', isLive);
  }
  dom.previewNote?.classList.toggle('is-hidden', isLive);
}

function updateCameraPill() {
  if (!dom.cameraPill || !dom.cameraPillText) return;
  let text = t('status.waiting');
  let cls = 'is-offline';

  if (state.streamConnected) {
    if (state.source === 'live') {
      text = t('status.live');
      cls = 'is-live';
    } else if (state.source === 'demo') {
      text = t('status.demo');
      cls = 'is-demo';
    } else {
      text = t('status.waiting');
      cls = 'is-offline';
    }
  } else if (state.phase === 'connecting') {
    text = t('status.connecting');
    cls = 'is-demo';
  } else if (state.phase === 'reconnecting') {
    text = t('status.reconnecting');
    cls = 'is-demo';
  }

  dom.cameraPill.classList.remove('is-live', 'is-demo', 'is-offline');
  dom.cameraPill.classList.add(cls);
  dom.cameraPillText.textContent = text;
}

function startMode(mode, { announce = true } = {}) {
  if (!MODE_IDS.includes(mode)) return;
  // Never open a camera on a viewer device or a public origin, even if a stale
  // URL/button somehow requests camera mode.
  if (mode === 'camera' && (relayRole !== 'laptop' || !isLocalOrigin())) return;
  state.mode = mode;
  state.phase = 'connecting';
  state.streamConnected = false;
  state.frameReady = false;
  showWait();
  updateModeUI();
  updateCameraPill();

  stream.start(mode);

  if (announce) {
    if (mode === 'webrtc') showToast(t('toast.webrtcStart'), 'info');
    else if (mode === 'livekit') showToast(t('toast.livekitStart'), 'info');
    else showToast(t('toast.mode', { mode: t(`mode.${mode}`) }), 'info', 2600);
  }
}

function updateCameraControls() {
  // Camera mode is removed — the live source is the ESP32-CAM only.
  for (const id of ['local-camera-btn', 'wait-camera-btn']) {
    const button = $(id);
    if (button) button.hidden = true;
  }
}

function updateModeUI() {
  for (const button of document.querySelectorAll('.mode-btn')) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (dom.studioMode) dom.studioMode.textContent = MODE_LABELS[state.mode] || state.mode.toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Sensors                                                                     */
/* -------------------------------------------------------------------------- */

const chart = dom.sensorChart
  ? new TelemetryChart(dom.sensorChart, {
      labels: chartLabels(),
      lang: state.lang,
    })
  : null;

const sensorSeries = new Map();
const sensorCards = new Map();
let chartPoints = [];
let latestSensor = null;
let lastSensorTs = 0;
let lastSensorPillKey = '';

function chartLabels() {
  return {
    temperature: t('sensor.legend.temperature'),
    humidity: t('sensor.legend.humidity'),
    soil: t('sensor.legend.soil'),
    waiting: t('sensors.offline'),
  };
}

function wantedSensorKeys(readings = {}) {
  const extras = Object.keys(readings).filter(
    (key) => SENSOR_DEFS[key] && !PRIMARY_SENSORS.includes(key),
  );
  return [...PRIMARY_SENSORS, ...extras];
}

function sensorUnit(def) {
  if (def.unit) return def.unit;
  return '';
}

function formatSensor(key, value) {
  const def = SENSOR_DEFS[key];
  if (!def) return { text: String(value), unit: '' };
  if (def.boolean) {
    return { text: value ? t('sensor.motion.active') : t('sensor.motion.idle'), unit: '' };
  }
  if (!Number.isFinite(value)) return { text: '--', unit: sensorUnit(def) };
  const decimals = Number.isFinite(def.decimals) ? def.decimals : 1;
  return { text: Number(value).toFixed(decimals), unit: sensorUnit(def) };
}

function createSensorCard(key) {
  const def = SENSOR_DEFS[key];
  const card = document.createElement('article');
  card.className = 'sensor-card';
  card.dataset.sensor = key;
  card.style.setProperty('--accent', def.accent);
  card.innerHTML = `
    <div class="sensor-top">
      <span class="sensor-icon"><svg class="icon"><use href="#i-${def.icon}"></use></svg></span>
      <span class="sensor-status"></span>
    </div>
    <div class="sensor-label"></div>
    <div class="sensor-value"><b>--</b><small></small></div>
    <canvas class="sensor-spark" width="140" height="34" aria-hidden="true"></canvas>
    <div class="sensor-foot"><span class="sensor-delta">—</span><span class="sensor-range">3m</span></div>
  `;
  card.querySelector('.sensor-label').textContent = t(def.labelKey);
  card.querySelector('.sensor-status').textContent = t('sensor.statusDemo');

  const refs = {
    card,
    value: card.querySelector('.sensor-value b'),
    unit: card.querySelector('.sensor-value small'),
    status: card.querySelector('.sensor-status'),
    delta: card.querySelector('.sensor-delta'),
    range: card.querySelector('.sensor-range'),
    spark: new Sparkline(card.querySelector('.sensor-spark'), def.accent),
  };

  sensorCards.set(key, refs);
  dom.sensorGrid.appendChild(card);
  return refs;
}

function renderSensorCards(keys) {
  if (!dom.sensorGrid) return;
  const signature = keys.join('|');
  if (dom.sensorGrid.dataset.signature === signature && sensorCards.size === keys.length) {
    for (const key of keys) {
      const refs = sensorCards.get(key);
      if (refs) refs.card.querySelector('.sensor-label').textContent = t(SENSOR_DEFS[key].labelKey);
    }
    return;
  }

  dom.sensorGrid.replaceChildren();
  sensorCards.clear();
  dom.sensorGrid.dataset.signature = signature;

  for (const key of keys) {
    const refs = createSensorCard(key);
    const history = sensorSeries.get(key);
    if (history?.length) refs.spark.setValues(history);
    if (latestSensor?.readings && key in latestSensor.readings) {
      updateSensorCard(key, latestSensor.readings[key]);
    }
    if (latestSensor) {
      refs.status.textContent = latestSensor.demo
        ? t('sensor.statusDemo')
        : latestSensor.connected
          ? t('sensor.statusLive')
          : t('sensor.statusOffline');
    }
  }
}

function updateSensorCard(key, value) {
  const refs = sensorCards.get(key);
  const def = SENSOR_DEFS[key];
  if (!refs || !def) return;

  const formatted = formatSensor(key, value);
  refs.value.textContent = formatted.text;
  refs.unit.textContent = formatted.unit;

  const history = sensorSeries.get(key) || [];
  if (Number.isFinite(value) || def.boolean) {
    const numeric = def.boolean ? (value ? 1 : 0) : Number(value);
    if (history[history.length - 1] !== numeric) {
      history.push(numeric);
      if (history.length > 36) history.shift();
      sensorSeries.set(key, history);
    }
    refs.spark.setValues(history);
  }

  if (def.boolean) {
    refs.card.classList.toggle('is-motion', Boolean(value));
    refs.delta.textContent = value ? t('sensor.motion.active') : t('sensor.motion.idle');
    refs.delta.className = `sensor-delta ${value ? 'up' : ''}`.trim();
    refs.range.textContent = t('sensor.statusLive');
  } else if (history.length >= 2) {
    const delta = history[history.length - 1] - history[history.length - 2];
    const decimals = def.decimals ?? 1;
    refs.delta.textContent = `${delta > 0 ? '+' : ''}${delta.toFixed(decimals)}`;
    refs.delta.className = `sensor-delta ${delta > 0.0001 ? 'up' : delta < -0.0001 ? 'down' : ''}`.trim();
    const min = Math.min(...history);
    const max = Math.max(...history);
    refs.range.textContent = `${min.toFixed(decimals)}–${max.toFixed(decimals)}`;
  } else {
    refs.delta.textContent = '—';
    refs.range.textContent = '3m';
  }

  refs.status.textContent = latestSensor?.demo
    ? t('sensor.statusDemo')
    : latestSensor?.connected
      ? t('sensor.statusLive')
      : t('sensor.statusOffline');
}

function refreshSensorLiveness() {
  if (!latestSensor || latestSensor.demo) return;
  const connected = Date.now() - latestSensor.ts < SENSOR_STALE_MS;
  if (latestSensor.connected === connected) return;

  latestSensor.connected = connected;
  latestSensor.source = connected ? 'live' : 'none';
  updateSensorPill();
  for (const [key, refs] of sensorCards) {
    if (latestSensor.readings && key in latestSensor.readings) {
      refs.status.textContent = connected ? t('sensor.statusLive') : t('sensor.statusOffline');
    }
  }
}

function pushSensorReading(key, value) {
  if (!SENSOR_DEFS[key]) return;
  const numeric = SENSOR_DEFS[key].boolean ? (value ? 1 : 0) : Number(value);
  if (!Number.isFinite(numeric)) return;
  const history = sensorSeries.get(key) || [];
  history.push(numeric);
  if (history.length > 36) history.shift();
  sensorSeries.set(key, history);
}

function pushChartPoint(record) {
  const ts = Number(record.ts) || Date.now();
  if (chartPoints.length && chartPoints[chartPoints.length - 1].t === ts) return;
  const readings = record.readings || {};
  chartPoints.push({
    t: ts,
    temperature: Number(readings.temperature),
    humidity: Number(readings.humidity),
    soil: Number(readings.soil),
  });
  if (chartPoints.length > 90) chartPoints.shift();
  chart?.setPoints(chartPoints);
}

function applySensorRecord(record, { seed = false } = {}) {
  if (!record || (!record.readings && !record.values)) return;
  const readings = record.readings || record.values || {};
  const ts = Number(record.ts) || Date.now();
  const demo = Boolean(record.demo || record.source === 'demo');
  const normalized = {
    deviceId: record.deviceId || 'ESP32-SENSOR-01',
    readings,
    ts,
    source: record.source || (demo ? 'demo' : 'live'),
    demo,
    // The server also sends this; recompute locally so old history loaded on
    // page refresh is never painted as a live device.
    connected: demo ? true : record.connected !== false && Date.now() - ts < SENSOR_STALE_MS,
  };

  latestSensor = normalized;

  if (record.source === 'live' || readings) {
    dom.sensorDevice.textContent = normalized.deviceId;
  }

  renderSensorCards(wantedSensorKeys(readings));

  for (const [key, value] of Object.entries(readings)) {
    if (!SENSOR_DEFS[key]) continue;
    if (!seed && ts === lastSensorTs) continue;
    pushSensorReading(key, value);
    updateSensorCard(key, value);
  }

  if (!seed && ts !== lastSensorTs) {
    pushChartPoint(normalized);
    lastSensorTs = ts;
  } else if (seed) {
    if (!chartPoints.length) pushChartPoint(normalized);
    lastSensorTs = ts;
  }

  updateSensorPill();
  updateSensorUpdated();

  // Live temperature for hero float chip — only real sensor values, never fixed.
  if (dom.floatTemp) {
    const temp = Number(readings.temperature);
    if (Number.isFinite(temp)) {
      dom.floatTemp.textContent = `${temp.toFixed(1)}°C`;
    } else {
      dom.floatTemp.textContent = t('hero.float2');
    }
  }
}

function seedSensorHistory(points = []) {
  if (!Array.isArray(points) || !points.length) return;
  chartPoints = points
    .filter((point) => point && Number.isFinite(Number(point.t)))
    .slice(-90)
    .map((point) => ({
      t: Number(point.t),
      temperature: Number(point.temperature),
      humidity: Number(point.humidity),
      soil: Number(point.soil),
    }));
  chart?.setPoints(chartPoints);

  for (const key of PRIMARY_SENSORS) {
    if (!SENSOR_DEFS[key] || SENSOR_DEFS[key].boolean) continue;
    const values = points
      .map((point) => Number(point[key]))
      .filter((value) => Number.isFinite(value))
      .slice(-36);
    if (values.length) {
      sensorSeries.set(key, values);
      sensorCards.get(key)?.spark.setValues(values);
    }
  }
}

function updateSensorPill() {
  if (!dom.sensorPill || !dom.sensorPillText) return;
  let key = 'offline';
  let text = t('sensors.offline');
  let cls = 'is-offline';

  if (latestSensor) {
    if (latestSensor.demo) {
      key = 'demo';
      text = t('sensors.demo');
      cls = 'is-demo';
    } else if (latestSensor.connected) {
      key = 'live';
      text = t('sensors.connected');
      cls = 'is-live';
    } else {
      key = 'offline';
      text = t('sensors.offline');
      cls = 'is-offline';
    }
  }

  const signature = `${key}:${state.lang}`;
  if (signature === lastSensorPillKey) return;
  lastSensorPillKey = signature;
  dom.sensorPill.classList.remove('is-live', 'is-demo', 'is-offline');
  dom.sensorPill.classList.add(cls);
  dom.sensorPillText.textContent = text;
}

function updateSensorUpdated() {
  if (!dom.sensorUpdated) return;
  if (!latestSensor) {
    dom.sensorUpdated.textContent = '--';
    return;
  }
  const seconds = Math.max(0, Math.round((Date.now() - latestSensor.ts) / 1000));
  if (seconds < 2) dom.sensorUpdated.textContent = t('sensors.justNow');
  else if (seconds < 60) dom.sensorUpdated.textContent = t('sensors.secondsAgo', { n: seconds });
  else dom.sensorUpdated.textContent = t('sensors.minutesAgo', { n: Math.floor(seconds / 60) });
}

async function fetchJson(path) {
  try {
    const response = await fetch(absoluteUrl(path), {
      cache: 'no-store',
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function loadSensorSnapshot() {
  const [history, latest] = await Promise.all([
    fetchJson('/api/sensors/history?limit=90'),
    fetchJson('/api/sensors/latest'),
  ]);

  if (history?.points?.length) seedSensorHistory(history.points);
  if (latest?.readings) applySensorRecord({ ...latest, source: latest.source || 'live' }, { seed: true });
}

let sensorSocket = null;
let sensorRetry = null;

function connectSensorSocket() {
  if (sensorSocket && (sensorSocket.readyState === WebSocket.OPEN || sensorSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  let socket;
  try {
    socket = new WebSocket(wsUrl('/ws/sensors'));
  } catch {
    scheduleSensorReconnect();
    return;
  }
  sensorSocket = socket;

  socket.onopen = () => {
    if (sensorRetry) clearTimeout(sensorRetry);
    sensorRetry = null;
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'hello') {
      if (message.history?.length) seedSensorHistory(message.history);
      if (message.latest) applySensorRecord(message.latest, { seed: true });
      return;
    }

    if (message.type === 'reading' || message.readings) {
      applySensorRecord(message);
    }
  };

  socket.onclose = () => {
    if (sensorSocket === socket) sensorSocket = null;
    scheduleSensorReconnect();
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleSensorReconnect() {
  if (sensorRetry || document.hidden) return;
  sensorRetry = setTimeout(() => {
    sensorRetry = null;
    connectSensorSocket();
  }, 3500);
}

/* -------------------------------------------------------------------------- */
/* Status polling                                                              */
/* -------------------------------------------------------------------------- */

let lastStatus = null;
let demoToastShown = false;
let statusRetry = 6000;

function setPill(element, textElement, text, cls) {
  if (!element || !textElement) return;
  element.classList.remove('is-online', 'is-offline', 'is-live', 'is-demo');
  if (cls) element.classList.add(cls);
  textElement.textContent = text;
}

async function refreshStatus() {
  const status = await fetchJson('/api/status');

  if (!status?.ok) {
    setPill(dom.serverPill, dom.serverPillText, t('status.offline'), 'is-offline');
    statusRetry = Math.min(20_000, Math.round(statusRetry * 1.6));
    setTimeout(refreshStatus, statusRetry);
    return;
  }

  lastStatus = status;
  statusRetry = 6000;
  setPill(dom.serverPill, dom.serverPillText, t('status.serverOnline'), 'is-online');

  // Resolve once per page load whether this browser is the relay laptop.
  if (!relayRoleLocked && typeof status.local === 'boolean') {
    relayRoleLocked = true;
    relayRole = status.local && isLocalOrigin() ? 'laptop' : 'viewer';
    updateCameraControls();
  }

  const camera = status.camera || {};
  if (!state.streamConnected && camera.source) applySource(camera.source);

  if (dom.turnPill && dom.turnPillText) {
    const turnReady = Boolean(status.webrtc?.turn);
    dom.turnPill.classList.toggle('is-on', turnReady);
    dom.turnPillText.textContent = turnReady ? 'TURN · Metered' : 'STUN';
    dom.turnPill.title = `ICE: ${status.webrtc?.iceSource || 'stun'}${turnReady ? ' (Metered TURN)' : ''}`;
  }

  if (camera.fps && !state.streamConnected) {
    if (dom.heroFps) dom.heroFps.textContent = String(camera.fps);
    if (dom.statFps) dom.statFps.textContent = String(camera.fps);
  }
  if (!state.streamConnected && camera.width && camera.height) {
    dom.metricResolution.textContent = `${camera.width}×${camera.height}`;
  }

  if (camera.source === 'demo' && !demoToastShown) {
    demoToastShown = true;
    setTimeout(() => showToast(t('toast.demo'), 'info', 5200), 1200);
  }

  updateCameraPill();
  setTimeout(refreshStatus, statusRetry);
}

/* -------------------------------------------------------------------------- */
/* Interaction wiring                                                          */
/* -------------------------------------------------------------------------- */

function setupModeButtons() {
  for (const button of document.querySelectorAll('.mode-btn')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode;
      if (!MODE_IDS.includes(mode) || (mode === state.mode && state.streamConnected)) return;
      if (mode === 'camera' && (relayRole !== 'laptop' || !isLocalOrigin())) return;
      startMode(mode);
    });
  }
}

function setupCopyButtons() {
  const buttons = document.querySelectorAll('.copy-btn');

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const targetId = button.dataset.copyTarget;
      const target = targetId ? $(targetId) : null;
      const text = target ? target.textContent.trim() : (button.dataset.copy || '').trim();
      if (!text) return;

      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        try {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none;inset-inline-start:-999px;';
          document.body.appendChild(textarea);
          textarea.select();
          copied = document.execCommand('copy');
          textarea.remove();
        } catch {
          copied = false;
        }
      }

      if (!copied) {
        showToast(text, 'info', 6000);
        return;
      }

      const use = button.querySelector('use');
      const previous = use?.getAttribute('href');
      if (use) use.setAttribute('href', '#i-check');
      button.classList.add('is-copied');
      showToast(t('toast.copy'), 'success', 2200);
      setTimeout(() => {
        button.classList.remove('is-copied');
        if (use && previous) use.setAttribute('href', previous);
      }, 1600);
    });
  }
}

function setupStageControls() {
  dom.intensity?.addEventListener('input', (event) => {
    setIntensity(event.target.value);
  });

  dom.tourBtn?.addEventListener('click', startTour);

  dom.mirrorBtn?.addEventListener('click', () => {
    state.mirror = !state.mirror;
    dom.videoWrap?.classList.toggle('is-mirrored', state.mirror);
    dom.previewStage?.classList.toggle('is-mirrored', state.mirror);
    dom.mirrorBtn.classList.toggle('is-active', state.mirror);
    dom.mirrorBtn.setAttribute('aria-pressed', String(state.mirror));
  });

  dom.gridBtn?.addEventListener('click', () => {
    state.grid = !state.grid;
    dom.videoGrid?.classList.toggle('is-on', state.grid);
    dom.gridBtn.classList.toggle('is-active', state.grid);
    dom.gridBtn.setAttribute('aria-pressed', String(state.grid));
  });

  dom.snapshotBtn?.addEventListener('click', () => {
    if (!state.frameReady || !dom.videoCanvas) {
      showToast(t('studio.waitTitle'), 'warn');
      return;
    }
    dom.videoCanvas.toBlob((blob) => {
      if (!blob) {
        showToast(t('studio.waitTitle'), 'warn');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      link.href = url;
      link.download = `mirsad-${state.effect}-${stamp}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast(t('toast.snapshot'), 'success');
    }, 'image/png');
  });

  dom.fullscreenBtn?.addEventListener('click', async () => {
    const target = dom.videoWrap;
    if (!target) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (target.requestFullscreen) {
        await target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      }
    } catch {
      showToast(t('studio.fullscreen'), 'warn');
    }
  });

  document.addEventListener('fullscreenchange', () => {
    dom.fullscreenBtn?.classList.toggle('is-active', Boolean(document.fullscreenElement));
  });
}

function setupNavigation() {
  dom.menuToggle?.addEventListener('click', () => {
    const open = !dom.mainNav?.classList.contains('is-open');
    dom.mainNav?.classList.toggle('is-open', open);
    dom.menuToggle.setAttribute('aria-expanded', String(open));
  });

  for (const link of dom.mainNav?.querySelectorAll('a') || []) {
    link.addEventListener('click', () => {
      dom.mainNav.classList.remove('is-open');
      dom.menuToggle?.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', (event) => {
    if (!dom.mainNav?.classList.contains('is-open')) return;
    if (dom.mainNav.contains(event.target) || dom.menuToggle?.contains(event.target)) return;
    dom.mainNav.classList.remove('is-open');
    dom.menuToggle?.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    dom.mainNav?.classList.remove('is-open');
    dom.menuToggle?.setAttribute('aria-expanded', 'false');
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 980) {
      dom.mainNav?.classList.remove('is-open');
      dom.menuToggle?.setAttribute('aria-expanded', 'false');
    }
  });
}

function setupScrollEffects() {
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const top = window.scrollY || 0;
      dom.siteHeader?.classList.toggle('is-scrolled', top > 12);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const progress = max > 0 ? clamp((top / max) * 100, 0, 100) : 0;
      if (dom.progressBar) dom.progressBar.style.width = `${progress}%`;
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function setupReveal() {
  const elements = document.querySelectorAll('.reveal');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || !('IntersectionObserver' in window)) {
    elements.forEach((element) => element.classList.add('is-visible'));
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    elements.forEach((element) => observer.observe(element));
  }

  const counters = document.querySelectorAll('[data-count]');
  const animate = (element) => {
    const target = Number(element.dataset.count) || 0;
    const duration = 1200;
    const started = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      element.textContent = String(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  if (reduced || !('IntersectionObserver' in window)) {
    counters.forEach((element) => {
      element.textContent = element.dataset.count;
    });
  } else {
    const counterObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          animate(entry.target);
          counterObserver.unobserve(entry.target);
        }
      },
      { threshold: 0.6 },
    );
    counters.forEach((element) => counterObserver.observe(element));
  }
}

function setupTilt() {
  const card = document.querySelector('.tilt');
  if (!card) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  card.addEventListener('pointermove', (event) => {
    const rect = card.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    card.style.transition = 'transform 0.08s linear';
    card.style.setProperty('--rx', `${((0.5 - y) * 7).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${((x - 0.5) * 9).toFixed(2)}deg`);
  });

  card.addEventListener('pointerleave', () => {
    card.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.7, 0.2, 1)';
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
  });
}

function setupStars() {
  const field = document.querySelector('.starfield');
  if (!field) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = reduced ? 60 : 220;
  const width = field.clientWidth || window.innerWidth;
  const height = field.clientHeight || window.innerHeight;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const star = document.createElement('span');
    star.className = 'star' + (reduced ? '' : ' twinkle');

    // Varied star sizes and classes for visual depth
    const roll = Math.random();
    if (roll > 0.92) {
      star.classList.add('giant');
    } else if (roll > 0.78) {
      star.classList.add('large');
    } else if (roll > 0.6) {
      star.classList.add('small');
    }

    const size = roll > 0.92 ? 4 : roll > 0.78 ? 3 : roll > 0.6 ? 2 : Math.random() * 1.5 + 0.5;
    const x = Math.random() * width;
    const y = Math.random() * height;
    const opacity = Math.random() * 0.7 + 0.15;

    star.style.width = size + 'px';
    star.style.height = size + 'px';
    star.style.left = x + 'px';
    star.style.top = y + 'px';
    star.style.opacity = opacity;
    if (!reduced) {
      star.style.setProperty('--dur', (2 + Math.random() * 6) + 's');
      star.style.animationDelay = (Math.random() * 6) + 's';
    }
    frag.appendChild(star);
  }
  field.appendChild(frag);
}

function setupDust() {
  const layer = document.querySelector('.bg-layer');
  if (!layer) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = reduced ? 20 : 60;
  const width = window.innerWidth;
  const height = window.innerHeight;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const dust = document.createElement('span');
    dust.className = 'dust-particle ' + (Math.random() > 0.5 ? 'small' : 'medium');

    const x = Math.random() * width;
    const y = Math.random() * height;
    const opacity = Math.random() * 0.4 + 0.1;
    const duration = 12 + Math.random() * 18;
    const delay = Math.random() * 20;

    dust.style.left = x + 'px';
    dust.style.top = y + 'px';
    dust.style.opacity = opacity;
    if (!reduced) {
      dust.style.animation = 'dust-float ' + duration + 's linear infinite';
      dust.style.animationDelay = delay + 's';
    }
    frag.appendChild(dust);
  }
  layer.appendChild(frag);
}

function setupClocks() {
  const update = () => {
    const now = new Date();
    if (dom.heroClock) {
      dom.heroClock.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    if (dom.videoTime) {
      dom.videoTime.textContent = now.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    updateSensorUpdated();
    refreshSensorLiveness();
  };
  update();
  setInterval(update, 1000);
  if (dom.year) dom.year.textContent = String(new Date().getFullYear());
}

function setupEndpoint() {
  const endpoint = absoluteUrl('/api/upload-frame');
  for (const node of document.querySelectorAll('.js-upload-endpoint, #upload-endpoint')) {
    node.textContent = endpoint;
    node.setAttribute('title', endpoint);
  }
}

/* -------------------------------------------------------------------------- */
/* Language changes                                                            */
/* -------------------------------------------------------------------------- */

window.addEventListener('langchange', () => {
  state.lang = getLang();
  renderEffects();
  updateEffectLabels();
  updateTourButton();
  updateCameraPill();
  updateSensorPill();

  if (lastStatus) setPill(dom.serverPill, dom.serverPillText, t('status.serverOnline'), 'is-online');
  else setPill(dom.serverPill, dom.serverPillText, t('status.connecting'), '');

  const keys = wantedSensorKeys(latestSensor?.readings || {});
  dom.sensorGrid.dataset.signature = '';
  renderSensorCards(keys);
  for (const key of keys) {
    if (latestSensor?.readings && key in latestSensor.readings) {
      updateSensorCard(key, latestSensor.readings[key]);
    }
  }

  if (chart) {
    chart.setLabels(chartLabels(), state.lang);
    chart.setPoints(chartPoints);
  }

  updateStats({ fps: null, latency: null, bitrateKbps: null, frames: null });
  updateSensorUpdated();
  updateModeUI();
  dom.metricFrames.textContent = '--';
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

renderEffects();
setIntensity(100);
updateTourButton();
updateModeUI();
renderSensorCards(PRIMARY_SENSORS);
updateSensorPill();

setupModeButtons();
setupCopyButtons();
setupStageControls();
setupNavigation();
setupScrollEffects();
setupReveal();
setupTilt();
setupStars();
setupDust();
setupClocks();
setupEndpoint();
applySource('none');
updateCameraPill();
updateCameraControls();

loadSensorSnapshot();
connectSensorSocket();
refreshStatus();
// The relay receives raw RGB565 frames from the ESP32-CAM over
// POST /api/upload-frame, encodes them to JPEG and pushes them to this page
// over /ws/frames. Prefer the WebRTC data channel only when the relay reports
// working Metered TURN credentials: Render exposes no public UDP port, so
// direct ICE cannot connect there, while both peers can reach TURN. If the
// status probe fails or times out, start on WebSocket — it always works.
async function initialMode() {
  try {
    const response = await fetch(api('/api/status'), {
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return 'ws';
    const status = await response.json();
    if (status?.webrtc?.available && status?.webrtc?.turn) return 'webrtc';
  } catch {
    /* cold start or offline: WebSocket is the safe default */
  }
  return 'ws';
}

initialMode().then((mode) => startMode(mode, { announce: false }));

// Live-only watchdog: if frames stop arriving, stop claiming LIVE and show the
// waiting panel instead of leaving a frozen frame on screen.
setInterval(() => {
  if (!state.streamConnected || !state.lastFrameAt) return;
  if (Date.now() - state.lastFrameAt > 6000) {
    state.streamConnected = false;
    applySource('none');
    showWait();
    updateCameraPill();
  }
}, 1000);

// Pause sensor reconnects while the tab is hidden, resume on focus.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!sensorSocket || sensorSocket.readyState > WebSocket.OPEN)) {
    connectSensorSocket();
  }
});

// Expose a tiny read-only diagnostics surface for automated UI checks.
window.__MIRSAD__ = {
  get state() {
    return { ...state, sensorKeys: [...sensorCards.keys()], chartPoints: chartPoints.length };
  },
  get stream() {
    return stream;
  },
  effects: EFFECTS.map((effect) => effect.id),
  ready: true,
};

// Kick the first status paint even when the network is slow.
void sleep(0).then(updateSensorUpdated);
