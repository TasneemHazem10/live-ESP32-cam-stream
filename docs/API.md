# MIRSAD API reference

Base URL: `http://localhost:3000` or `https://YOUR-SERVICE.onrender.com`.

All control endpoints return JSON. Camera uploads use a binary body; streams use JPEG,
multipart or WebSocket. Unknown `/api/*` routes return a structured 404.

If `UPLOAD_TOKEN` is configured, uploads require either:

```http
X-Upload-Token: your-token
```

or `?token=your-token` in the URL. Read-only endpoints and browsers do not need the token.

---

## 1. Camera ingestion

### `POST /api/upload-frame`

Alias: `POST /api/camera/frame`.

Upload one raw RGB565 frame or a complete JPEG. The relay converts RGB565 to RGBA, then encodes
JPEG and fans it out to every viewer.

Query parameters:

| Name | Default | Description |
| --- | --- | --- |
| `w` | `FRAME_WIDTH` (320) | Width in pixels, 16–4096 |
| `h` | `FRAME_HEIGHT` (240) | Height in pixels, 16–4096 |
| `format` | `FRAME_FORMAT` (`rgb565le`) | `rgb565be`, `rgb565le`, `rgb565`, `jpeg` |
| `flip` | none | `x`, `y`, or `x,y` |
| `device` | none | Device label (max 48 chars) |
| `token` | none | Upload token alternative |

Headers `X-Frame-Width`, `X-Frame-Height`, `X-Frame-Format` and `X-Device-Id` are accepted as
alternatives to the query parameters.

A 320×240 RGB565 frame must be exactly **153,600 bytes**:

```bash
curl -X POST "http://localhost:3000/api/upload-frame?w=320&h=240&format=rgb565be&device=ESP32-CAM-01" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Upload-Token: $UPLOAD_TOKEN" \
  --data-binary @frame.rgb565
```

Response:

```json
{
  "ok": true,
  "seq": 42,
  "width": 320,
  "height": 240,
  "bytes": 153600,
  "jpegBytes": 14322,
  "source": "live",
  "ms": 37
}
```

Errors:

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | `empty_body` | No binary body was sent |
| `400` | `frame_rejected` | Wrong byte count, dimensions or malformed JPEG |
| `401` | `invalid_token` | Token missing or wrong |
| `413` | `payload_too_large` | Body exceeds `MAX_FRAME_BYTES` |

### `GET /api/frame.jpg`

Returns the newest frame. Headers: `X-Frame-Seq`, `X-Frame-Time`, `X-Frame-Source`.

```bash
curl -o latest.jpg http://localhost:3000/api/frame.jpg
```

Returns `404 {"ok":false,"error":"no_frame"}` before any frame exists and when the demo signal
is disabled.

### `GET /api/latest-frame`

`307` redirect to `/api/frame.jpg`.

### `GET /stream.mjpeg` and `GET /api/stream.mjpeg`

`multipart/x-mixed-replace; boundary=frame`. Each part has `Content-Type: image/jpeg`,
`Content-Length`, `X-Seq` and `X-Time`.

```html
<img src="http://localhost:3000/stream.mjpeg" alt="MIRSAD live stream" />
```

---

## 2. Sensors

### `POST /api/sensors`

```json
{
  "deviceId": "ESP32-SENSOR-38P",
  "readings": {
    "temperature": 26.4,
    "humidity": 58.1,
    "soil": 42,
    "light": 73,
    "airQuality": 24,
    "motion": false,
    "pressure": 1012.8,
    "battery": 91,
    "rssi": -57
  }
}
```

`readings`, `values` or `sensors` may wrap the values; a flat object also works. Common aliases
are normalised (`temp`→`temperature`, `hum`/`rh`→`humidity`, `soil_moisture`→`soil`,
`lux`→`light`, `aqi`/`gas`→`airQuality`, `pir`→`motion`, etc.). Booleans are stored for
`motion`; other values must be numeric.

Response:

```json
{
  "ok": true,
  "deviceId": "ESP32-SENSOR-38P",
  "ts": 1780000000000,
  "source": "live",
  "readings": { "temperature": 26.4, "...": "..." }
}
```

### `GET /api/sensors/latest`

```json
{
  "ok": true,
  "deviceId": "ESP32-SENSOR-38P",
  "readings": { "temperature": 26.4, "humidity": 58.1 },
  "values": { "temperature": 26.4, "humidity": 58.1 },
  "source": "live",
  "demo": false,
  "ts": 1780000000000,
  "ageMs": 1200,
  "connected": true
}
```

### `GET /api/sensors/history?limit=120`

`limit` is clamped to 1–360. Each point contains readings plus `t` (epoch ms) and `demo`.

```json
{
  "ok": true,
  "count": 90,
  "points": [
    { "temperature": 26.4, "humidity": 58.1, "t": 1780000000000, "demo": false }
  ]
}
```

### `GET /api/sensors/devices`

Returns every device seen since the process started, with `lastSeen`, `ageMs` and its latest
readings.

---

## 3. WebSockets

Both sockets share the HTTP server and support automatic reconnection from the dashboard.

### `WS /ws/frames`

Immediately after connecting:

```json
{
  "type": "hello",
  "serverTime": 1780000000000,
  "camera": { "connected": true, "source": "live", "width": 320, "height": 240 },
  "webrtc": { "transport": "datachannel" }
}
```

For every frame, two messages are sent in order:

1. JSON metadata:

```json
{
  "type": "frame",
  "seq": 42,
  "ts": 1780000000000,
  "width": 320,
  "height": 240,
  "bytes": 14322,
  "source": "live",
  "demo": false,
  "deviceId": "ESP32-CAM-01"
}
```

2. Binary message containing the JPEG bytes (`0xFF 0xD8 … 0xFF 0xD9`).

If the newest frame exists, it is sent immediately after `hello`. The relay drops frames for a
client whose buffered amount exceeds 1 MB.

### `WS /ws/sensors`

Hello packet:

```json
{
  "type": "hello",
  "serverTime": 1780000000000,
  "latest": { "deviceId": "ESP32-SENSOR-38P", "readings": { "...": "..." } },
  "history": [ { "temperature": 26.4, "t": 1780000000000 } ]
}
```

Then, on each ingest:

```json
{
  "type": "reading",
  "deviceId": "ESP32-SENSOR-38P",
  "readings": { "temperature": 26.5, "humidity": 58.0 },
  "ts": 1780000002000,
  "source": "live",
  "demo": false
}
```

---

## 4. WebRTC signalling

The relay uses `werift` and a WebRTC **data channel** named `frames`. The browser creates the
offer with `pc.createDataChannel('frames', { ordered: false, maxRetransmits: 0 })`, waits for
ICE gathering, and posts the offer. The server answers.

### `GET /api/rtc/config`

```json
{
  "ok": true,
  "available": true,
  "transport": "datachannel",
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" }
  ],
  "source": "stun",
  "turn": false,
  "maxPeers": 4
}
```

With Metered configured, `iceServers` includes `turn:`/`turns:` entries with short-lived
`username`/`credential`, `source` is `"metered"` and `turn` is `true`.

### `POST /api/rtc/offer`

```json
{
  "type": "offer",
  "sdp": "v=0\r\n...m=application..."
}
```

Response:

```json
{
  "ok": true,
  "id": "a2b3c4d5-...",
  "type": "answer",
  "sdp": "v=0\r\n...",
  "ice": "metered",
  "turn": true
}
```

The offer must contain an `m=application` section. A peer limit returns `429`; malformed SDP
returns `400` with `error: "webrtc_offer_failed"`.

### `DELETE /api/rtc/peer/:id`

Closes a peer. This operation is idempotent and returns:

```json
{ "ok": true, "closed": true }
```

`closed` is `false` when the peer had already exited.

### Data-channel frame format

Every binary message is:

```text
┌────────────────────┬──────────────────────┬─────────────────────────┐
│ uint32 BE sequence │ float64 BE timestamp │ JPEG bytes               │
│ 4 bytes            │ 8 bytes              │ N bytes                  │
└────────────────────┴──────────────────────┴─────────────────────────┘
```

The browser reads the sequence and timestamp with `DataView`, removes the 12-byte header and
decodes the JPEG with `createImageBitmap`. Text messages are JSON status packets, for example:

```json
{
  "type": "status",
  "sent": 128,
  "source": "live",
  "ts": 1780000000000
}
```

---

## 5. Status and health

### `GET /api/status`

```json
{
  "ok": true,
  "serverTime": 1780000000000,
  "uptimeSec": 3600,
  "camera": {
    "connected": true,
    "source": "live",
    "demo": false,
    "width": 320,
    "height": 240,
    "fps": 4.2,
    "bitrateKbps": 480,
    "frames": 15200,
    "realFrames": 15010,
    "lastFrameAt": "2026-11-05T18:00:00.000Z",
    "ageMs": 120,
    "jpegBytes": 14322,
    "deviceId": "ESP32-CAM-01"
  },
  "sensors": {
    "connected": true,
    "source": "live",
    "demo": false,
    "deviceId": "ESP32-SENSOR-38P",
    "lastSeen": "2026-11-05T18:00:00.000Z",
    "ageMs": 800,
    "devices": 2,
    "values": { "temperature": 26.4 },
    "history": 120
  },
  "clients": { "frames": 3, "sensors": 2, "webrtc": 1 },
  "webrtc": {
    "available": true,
    "transport": "datachannel",
    "active": 1,
    "max": 4,
    "turn": true,
    "iceSource": "metered"
  },
  "config": {
    "demoFallback": true,
    "uploadAuth": true,
    "jpegQuality": 80,
    "frameSize": "320x240",
    "resolution": { "width": 320, "height": 240 },
    "maxFrameBytes": 2097152
  },
  "endpoints": {
    "upload": "/api/upload-frame",
    "frame": "/api/frame.jpg",
    "mjpeg": "/stream.mjpeg",
    "wsFrames": "/ws/frames",
    "sensors": "/api/sensors",
    "sensorsWs": "/ws/sensors",
    "webrtc": "/api/rtc/offer"
  }
}
```

### `GET /healthz`

```json
{ "ok": true, "uptimeSec": 3600, "camera": "live", "sensors": "live" }
```

Used by Render and Docker health checks.

---

## 6. Firmware downloads

```text
GET /firmware/esp32cam-streamer/esp32cam-streamer.ino
GET /firmware/esp32-sensor-node/esp32-sensor-node.ino
```

Served as `text/plain; charset=utf-8` with a one-hour cache. The dashboard links directly to
both files.

---

## 7. Error format

```json
{
  "ok": false,
  "error": "not_found",
  "path": "/api/does-not-exist"
}
```

Server errors return `500` with a generic message; validation errors include a useful
`message`. CORS preflight requests return `204`.
