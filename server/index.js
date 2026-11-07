import compression from 'compression';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { ROOT_DIR, config, PUBLIC_DIR, hasLiveKit, hasUploadAuth } from './config.js';
import { frameHub } from './frameHub.js';
import { sensorStore } from './sensors.js';
import { broadcastSensor, createLiveKitToken, liveKitStatus } from './livekit.js';
import { isJpeg, parseFlip, parseFormat } from './rgb565.js';
import {
  closeAllWebRtcPeers,
  closeWebRtcPeer,
  createWebRtcPeer,
  getIceConfig,
  getWebRtcStats,
  isWebRtcAvailable,
} from './webrtc.js';

const app = express();
const server = http.createServer(app);
const frameClients = new Set();
const sensorClients = new Set();
const startedAt = Date.now();

app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(
  compression({
    filter: (req, res) => {
      if (req.path === '/stream.mjpeg' || req.path === '/api/stream.mjpeg' || req.path === '/api/frame.jpg') {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = config.allowedOrigins
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (config.allowedOrigins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Upload-Token, X-Api-Key, X-Device-Id, X-Frame-Width, X-Frame-Height, X-Frame-Format, X-Rgb565-Order',
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

if (config.logRequests) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });
}

app.use(express.json({ limit: '96kb' }));

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function requireToken(req, res, next) {
  if (!hasUploadAuth()) return next();
  const authorization = req.get('authorization') || '';
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  // Accept both header names so the original FieldEye sketches (X-Api-Key) and
  // the MIRSAD sketches (X-Upload-Token) work without reflashing.
  const token =
    req.get('x-upload-token') ||
    req.get('x-api-key') ||
    bearer ||
    req.query.token ||
    req.query.apiKey;
  if (token && token === config.uploadToken) return next();
  return res.status(401).json({
    ok: false,
    error: 'invalid_token',
    message: 'Missing or invalid X-Upload-Token / X-Api-Key',
  });
}

function pickDimension(queryValue, headerValue, fallback) {
  const value = Number.parseInt(queryValue ?? headerValue ?? fallback, 10);
  if (!Number.isFinite(value) || value < 16 || value > 4096) return fallback;
  return value;
}

function frameOptions(req) {
  const format = parseFormat(
    req.query.format || req.get('x-frame-format') || req.get('x-rgb565-order'),
    config.defaultFormat,
  );
  const flip = parseFlip(req.query.flip);
  return {
    width: pickDimension(req.query.w, req.get('x-frame-width'), config.defaultWidth),
    height: pickDimension(req.query.h, req.get('x-frame-height'), config.defaultHeight),
    bigEndian: format.bigEndian,
    isJpeg: format.raw === 'jpeg',
    ...flip,
    deviceId: String(req.query.device || req.get('x-device-id') || '').slice(0, 48) || null,
  };
}

function uploadFrame(req, res) {
  const started = Date.now();
  const raw = Buffer.isBuffer(req.body) ? req.body : null;

  if (!raw || raw.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'empty_body',
      message: 'Send the raw frame as a binary request body (application/octet-stream).',
    });
  }

  const options = frameOptions(req);

  try {
    let frame;
    if (options.isJpeg || isJpeg(raw)) {
      frame = frameHub.ingestJpeg(raw, {
        width: options.width,
        height: options.height,
        deviceId: options.deviceId,
      });
    } else {
      frame = frameHub.ingestRgb565(raw, options);
    }

    return res.json({
      ok: true,
      seq: frame.seq,
      width: frame.width,
      height: frame.height,
      bytes: raw.length,
      jpegBytes: frame.bytes,
      source: frame.source,
      ms: Date.now() - started,
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: 'frame_rejected', message: error.message });
  }
}

/* ------------------------------------------------------------------ */
/* Camera ingestion                                                    */
/* ------------------------------------------------------------------ */

app.post(
  '/api/upload-frame',
  requireToken,
  express.raw({ type: () => true, limit: config.maxFrameBytes }),
  uploadFrame,
);

// Friendly alias for different firmware builds.
app.post(
  '/api/camera/frame',
  requireToken,
  express.raw({ type: () => true, limit: config.maxFrameBytes }),
  uploadFrame,
);

app.get('/api/frame.jpg', (req, res) => {
  const frame = frameHub.latest;
  if (!frame) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ ok: false, error: 'no_frame' });
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Frame-Seq', String(frame.seq));
  res.setHeader('X-Frame-Time', String(frame.ts));
  res.setHeader('X-Frame-Source', frame.source);
  return res.send(frame.jpeg);
});

app.get('/api/latest-frame', (req, res) => {
  res.redirect(307, '/api/frame.jpg');
});

/* ------------------------------------------------------------------ */
/* MJPEG streaming                                                     */
/* ------------------------------------------------------------------ */

function mjpegHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const sub = frameHub.subscribe();
  let closed = false;

  const writeFrame = (frame) => {
    if (closed || !frame) return;
    res.write(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\nX-Seq: ${frame.seq}\r\nX-Time: ${frame.ts}\r\n\r\n`,
    );
    res.write(frame.jpeg);
    res.write('\r\n');
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    sub.close();
  };

  req.on('close', stop);
  res.on('close', stop);
  res.on('error', stop);

  // Send the newest frame immediately so an <img> or player paints at once
  // instead of waiting up to a full frame interval (or forever when the
  // camera is paused).
  if (frameHub.latest) writeFrame(frameHub.latest);

  (async () => {
    while (!closed) {
      const frame = await sub.next(10_000);
      if (closed) break;
      if (!frame) continue;
      writeFrame(frame);
    }
  })().catch(stop);
}

app.get('/stream.mjpeg', mjpegHandler);
app.get('/api/stream.mjpeg', mjpegHandler);

/* ------------------------------------------------------------------ */
/* Sensors                                                             */
/* ------------------------------------------------------------------ */

app.post('/api/sensors', requireToken, (req, res) => {
  try {
    const record = sensorStore.ingest(req.body, {
      ip: req.ip,
    });
    return res.json({
      ok: true,
      deviceId: record.deviceId,
      ts: record.ts,
      source: record.source,
      readings: record.readings,
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: 'invalid_sensors', message: error.message });
  }
});

// Compatibility shape used by the original FieldEye dashboard.
app.get('/api/sensors', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const latest = sensorStore.getLatest();
  const history = sensorStore.getHistory(120);
  if (!latest) {
    return res.json({ ok: true, data: {}, values: {}, updatedAt: 0, history });
  }
  return res.json({
    ok: true,
    ...latest,
    data: latest.readings,
    values: latest.readings,
    updatedAt: latest.ts,
    history,
  });
});

app.get('/api/sensors/latest', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const latest = sensorStore.getLatest();
  if (!latest) return res.status(404).json({ ok: false, error: 'no_sensor_data' });
  return res.json({ ok: true, ...latest, readings: latest.readings, values: latest.readings });
});

app.get('/api/sensors/history', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const limit = Math.min(360, Math.max(1, Number.parseInt(req.query.limit, 10) || 120));
  return res.json({
    ok: true,
    count: sensorStore.getHistory(limit).length,
    points: sensorStore.getHistory(limit),
  });
});

app.get('/api/sensors/devices', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, devices: sensorStore.getDevices() });
});

/* ------------------------------------------------------------------ */
/* LiveKit Cloud                                                       */
/* ------------------------------------------------------------------ */

app.get('/api/livekit/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, ...liveKitStatus(), transport: 'webrtc' });
});

const liveKitTokenHandler = asyncRoute(async (req, res) => {
  const role = String(req.query.role || req.body?.role || 'viewer').toLowerCase() === 'publisher'
    ? 'publisher'
    : 'viewer';
  const identity = req.query.identity || req.body?.identity;
  const name = req.query.name || req.body?.name;
  try {
    const result = await createLiveKitToken({ identity, role, name });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.code || 'livekit_token_failed',
      message: error.message,
    });
  }
});

app.get('/api/livekit/token', liveKitTokenHandler);
app.post('/api/livekit/token', liveKitTokenHandler);

// Serve the browser SDK locally so the dashboard works on a LAN with no CDN.
app.get('/vendor/livekit-client.umd.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(ROOT_DIR, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js'));
});

/* ------------------------------------------------------------------ */
/* WebRTC signalling                                                   */
/* ------------------------------------------------------------------ */

app.get(
  '/api/rtc/config',
  asyncRoute(async (req, res) => {
    const ice = await getIceConfig();
    const available = await isWebRtcAvailable();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      available,
      transport: 'datachannel',
      iceServers: ice.iceServers,
      source: ice.source,
      turn: ice.turn,
      maxPeers: config.maxWebRtcPeers,
    });
  }),
);

const rtcOfferHandler = asyncRoute(async (req, res) => {
  try {
    const answer = await createWebRtcPeer(req.body, { ip: req.ip });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...answer });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: 'webrtc_offer_failed',
      message: error.message,
    });
  }
});

app.post('/api/rtc/offer', rtcOfferHandler);
// Alias used by the original FieldEye dashboard.
app.post('/api/webrtc/offer', rtcOfferHandler);

// FieldEye-compatible ICE alias.
app.get(
  '/api/ice',
  asyncRoute(async (req, res) => {
    const ice = await getIceConfig();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ iceServers: ice.iceServers, source: ice.source, turn: ice.turn });
  }),
);

app.delete('/api/rtc/peer/:id', (req, res) => {
  const closed = closeWebRtcPeer(req.params.id);
  // DELETE is idempotent: closing an already-closed peer is still success.
  return res.json({ ok: true, closed });
});

/* ------------------------------------------------------------------ */
/* Status / health                                                     */
/* ------------------------------------------------------------------ */

app.get('/api/status', asyncRoute(async (req, res) => {
  const ice = await getIceConfig();
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    serverTime: Date.now(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    camera: frameHub.getStatus(),
    sensors: sensorStore.getStatus(),
    clients: {
      frames: frameClients.size,
      sensors: sensorClients.size,
      webrtc: getWebRtcStats().active,
    },
    webrtc: {
      available: await isWebRtcAvailable(),
      transport: 'datachannel',
      active: getWebRtcStats().active,
      max: config.maxWebRtcPeers,
      turn: ice.turn,
      iceSource: ice.source,
    },
    livekit: liveKitStatus(),
    config: {
      demoFallback: config.demoFallback,
      uploadAuth: hasUploadAuth(),
      jpegQuality: config.jpegQuality,
      frameSize: `${config.defaultWidth}x${config.defaultHeight}`,
      resolution: { width: config.defaultWidth, height: config.defaultHeight },
      maxFrameBytes: config.maxFrameBytes,
    },
    endpoints: {
      upload: '/api/upload-frame',
      frame: '/api/frame.jpg',
      mjpeg: '/stream.mjpeg',
      wsFrames: '/ws/frames',
      sensors: '/api/sensors',
      sensorsWs: '/ws/sensors',
      webrtc: '/api/rtc/offer',
      livekit: '/api/livekit/token',
    },
  });
}));

app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    camera: frameHub.getStatus().source,
    sensors: sensorStore.getStatus().source,
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.originalUrl });
});

/* ------------------------------------------------------------------ */
/* Firmware downloads                                                  */
/* ------------------------------------------------------------------ */

app.use(
  '/firmware',
  express.static(path.join(ROOT_DIR, 'firmware'), {
    fallthrough: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.ino') || filePath.endsWith('.h')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }),
);

/* ------------------------------------------------------------------ */
/* Static frontend                                                     */
/* ------------------------------------------------------------------ */

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      }
    },
  }),
);

app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html') && !path.extname(req.path)) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  return res.status(404).json({ ok: false, error: 'not_found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || error.statusCode || (error.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error('[server]', error);
  return res.status(status).json({
    ok: false,
    error: error.type === 'entity.too.large' ? 'payload_too_large' : 'server_error',
    message: status >= 500 ? 'Internal server error' : error.message,
  });
});

/* ------------------------------------------------------------------ */
/* WebSockets                                                          */
/* ------------------------------------------------------------------ */

const frameWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const sensorWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

function originAllowed(req) {
  if (config.allowedOrigins === '*') return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  return config.allowedOrigins
    .split(',')
    .map((item) => item.trim())
    .includes(origin);
}

frameWss.on('connection', (ws) => {
  frameClients.add(ws);

  const sendFrame = (frame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_000_000) return;
    ws.send(
      JSON.stringify({
        type: 'frame',
        seq: frame.seq,
        ts: frame.ts,
        width: frame.width,
        height: frame.height,
        bytes: frame.bytes,
        source: frame.source,
        demo: frame.demo,
        deviceId: frame.deviceId,
      }),
    );
    ws.send(frame.jpeg, { binary: true });
  };

  ws.send(
    JSON.stringify({
      type: 'hello',
      serverTime: Date.now(),
      camera: frameHub.getStatus(),
      webrtc: { transport: 'datachannel' },
    }),
  );
  if (frameHub.isLive()) sendFrame(frameHub.latest);

  const off = frameHub.onFrame(sendFrame);
  ws.on('close', () => {
    off();
    frameClients.delete(ws);
  });
  ws.on('error', () => {
    off();
    frameClients.delete(ws);
  });
});

sensorWss.on('connection', (ws) => {
  sensorClients.add(ws);
  ws.send(
    JSON.stringify({
      type: 'hello',
      serverTime: Date.now(),
      latest: sensorStore.getLatest(),
      history: sensorStore.getHistory(90),
    }),
  );

  const off = sensorStore.onUpdate((record) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          type: 'reading',
          deviceId: record.deviceId,
          readings: record.readings,
          ts: record.ts,
          source: record.source,
          demo: record.demo,
        }),
      );
    } catch {
      /* closing */
    }
  });

  ws.on('close', () => {
    off();
    sensorClients.delete(ws);
  });
  ws.on('error', () => {
    off();
    sensorClients.delete(ws);
  });
});

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  if (pathname === '/ws/frames' || pathname === '/ws') {
    frameWss.handleUpgrade(req, socket, head, (ws) => frameWss.emit('connection', ws, req));
    return;
  }
  if (pathname === '/ws/sensors') {
    sensorWss.handleUpgrade(req, socket, head, (ws) => sensorWss.emit('connection', ws, req));
    return;
  }
  socket.destroy();
});

const heartbeat = setInterval(() => {
  for (const ws of frameClients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
  for (const ws of sensorClients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000);
heartbeat.unref?.();

for (const ws of [frameWss, sensorWss]) {
  ws.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

frameHub.start();
sensorStore.start();
// Mirror every sensor packet into the LiveKit room so viewers who only have
// the LiveKit URL (no access to this laptop) still see live telemetry.
sensorStore.onUpdate((record) => {
  broadcastSensor(record).catch(() => {});
});

server.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log('  MIRSAD live relay');
  console.log(`  ➜  http://${shownHost}:${config.port}`);
  console.log(`  ➜  upload endpoint : POST /api/upload-frame (${config.defaultWidth}x${config.defaultHeight} RGB565)`);
  console.log(`  ➜  demo signal     : ${config.demoFallback ? 'ON' : 'OFF'}`);
  console.log(`  ➜  upload auth     : ${hasUploadAuth() ? 'ON' : 'OFF'}`);
  console.log(`  ➜  TURN            : ${config.metered.domain && config.metered.apiKey ? 'Metered configured' : 'STUN only'}`);
  console.log(`  ➜  LiveKit         : ${hasLiveKit() ? `${config.livekit.url} · room "${config.livekit.room}"` : 'not configured'}`);
  console.log(`  ➜  sensors         : ${config.demoFallback ? 'live simulator until ESP32 connects' : 'waiting for ESP32'}`);
  console.log('');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, shutting down...`);
  clearInterval(heartbeat);
  frameHub.stop();
  sensorStore.stop();
  closeAllWebRtcPeers();
  for (const client of [...frameClients, ...sensorClients]) {
    try {
      client.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
  }
  frameWss.close();
  sensorWss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('[server] unhandled rejection:', error);
});
