# MIRSAD · مرصد

**Live ESP32-CAM vision dashboard with browser effects, WebRTC/TURN transport and ESP32 sensor telemetry.**

MIRSAD accepts raw **RGB565** frames from an ESP32-CAM (RHYX-M21-45 / AI-Thinker) over HTTPS on
`POST /api/upload-frame`, converts them to JPEG on the Node relay and fans them out to the browser
over **WebSocket**, **MJPEG**, **HTTP polling** or a **WebRTC data channel**. The camera only makes
outbound connections: it needs **no public IP, no port forwarding and no NAT traversal**, and the
same Render process serves both the dashboard and the API, so there is no separate static host,
no CORS hop and no serverless instance in the video path.

Because the relay keeps the latest frame in memory, it must run on a single long-lived instance —
Render, Railway, Docker or the laptop. LiveKit Cloud and Metered TURN remain available for WebRTC.

The same page shows live readings from an **ESP32 38-pin sensor node** (temperature, humidity,
soil, light, air quality, motion, pressure, battery and RSSI). The built-in simulator updates every
two seconds and switches to real readings automatically on the first ESP32 packet.

> **Using the original FieldEye ESP sketches?** They are fully supported by the Node relay. The
> relay accepts both `X-Api-Key` and `X-Upload-Token`, plus `Authorization: Bearer ...`, `?token=`
> and `?apiKey=`. For the Render deployment and the exact flashing steps, see
> [`LIVE-SETUP.md`](LIVE-SETUP.md).

---

## Table of contents

- [Feature overview](#feature-overview)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Transports](#transports)
- [Browser vision effects](#browser-vision-effects)
- [HTTP and WebSocket API](#http-and-websocket-api)
- [Hardware](#hardware)
- [Configuration](#configuration)
- [Tests](#tests)
- [Deployment](#deployment)
  - [1. Deploy the relay + dashboard to Render](#1-deploy-the-relay--dashboard-to-render)
  - [2. Enable Metered TURN](#2-enable-metered-turn)
  - [3. Flash the ESP32 boards](#3-flash-the-esp32-boards)
  - [Optional: run the relay on a laptop](#optional-run-the-relay-on-a-laptop)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [License](#license)

---

## Feature overview

| Area | What you get |
| --- | --- |
| Camera ingestion | `POST /api/upload-frame` accepts raw RGB565 LE/BE (`153,600` bytes for 320×240) or a JPEG fallback |
| Laptop camera | Only the relay laptop opens `getUserMedia`; it relays JPEG frames through `POST /api/laptop/frame` (same-origin, no upload token) |
| Remote video | Every other device is a viewer: it watches the laptop stream over WebSocket/MJPEG/HTTP/WebRTC and is never asked for camera access |
| LiveKit Cloud | Optional internet viewing: browsers only receive short-lived tokens minted by the relay |
| Low latency delivery | WebSocket binary JPEG frames, MJPEG multipart stream, HTTP polling and WebRTC data channel |
| WebRTC | Browser ↔ server data channel negotiated through `/api/rtc/offer`; Metered TURN credentials fetched server-side |
| Browser effects | Water index, vegetation, thermal, night vision, edge detection, cinematic, invert and raw — all client-side canvas filters |
| Studio controls | Effect intensity, mirror, rule-of-thirds grid, fullscreen, PNG snapshot, automatic effect tour |
| Sensors | 9 live cards + history chart; a dynamic simulator updates every 2 s until real ESP32 packets replace it |
| UI | Arabic-first RTL with one-click English, dark aurora glass design, scroll reveals, counters, responsive mobile menu |
| Operations | `/healthz`, `/api/status`, structured errors, upload token, CORS allow-list, request logging, Docker file |
| Demo mode | Optional synthetic camera + sensor signal for UI development (`DEMO_FALLBACK=true`); **off by default**, sensors stop after the first real packet |

---

## Architecture

```text
┌────────────────────┐  POST /api/laptop/frame (JPEG) ┌──────────────────────────┐
│  Laptop webcam     │ ─────────────────────────────► │  MIRSAD relay (Node.js)  │
│  current source    │   same-origin, no upload token │  JPEG fan-out            │
└────────────────────┘                                │  in-memory frame hub     │
┌────────────────────┐   HTTPS POST (outbound only)   │  sensor store + history  │
│  ESP32-CAM (later) │ ─────────────────────────────► │  Metered TURN credentials│
│  320×240 RGB565    │     153,600 bytes/frame        │                          │
└────────────────────┘                                │                          │
┌────────────────────┐   HTTPS POST every 2 s        │                          │
│  ESP32 38-pin      │ ─────────────────────────────► │                          │
│  DHT22, soil, LDR, │     JSON sensor readings       └──────────┬───────────────┘
│  MQ-135, PIR, etc. │                                           │
└────────────────────┘                     WebSocket / MJPEG / WebRTC / HTTP
                                                       │
                                                       ▼
                                            ┌─────────────────────┐
                                            │  Viewer browsers    │
                                            │  canvas + effects   │
                                            │  sensor charts      │
                                            │  no camera prompt   │
                                            └─────────────────────┘
```

The relay keeps the latest JPEG frame and a 360-point sensor history in memory. A new frame is
pushed to all connected clients immediately. No database is required.

---

## Quick start

Requirements: **Node.js 22 or newer** (tested on Node 24), npm and a modern browser.

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git
cd YOUR_REPO
npm install
npm start
```

Open **http://localhost:3000** on the laptop. The page opens the **laptop camera** automatically;
allow the browser prompt. That webcam is the live source for every device until the ESP32-CAM is
wired up, and the sensor cards run on the live simulator (`SIM` badge). The first sensor packet
stops the simulator permanently. When the ESP32-CAM starts posting, close the laptop dashboard tab
so the board is the only video publisher; the relay always serves the newest frame.

Every other device (phone, tablet, another PC) is a **viewer**. Open the same dashboard there —
by default `http://LAPTOP-LAN-IP:3000` on the same Wi-Fi — and it plays the laptop's stream over
WebSocket/MJPEG/HTTP. Viewer devices **never call `getUserMedia`**, so they are never asked for
camera access, and the camera buttons are hidden. The server's `local` flag in `/api/status`
decides the role from the request's source address, so the laptop still owns the camera even when
it opens its own dashboard through the LAN IP.

> **Using a public tunnel (Cloudflare Tunnel, ngrok, …)?** Open **http://localhost:3000** on the
> laptop to publish, and give viewers the public tunnel URL. A public hostname is always treated
> as watch-only, so tunnel visitors are never prompted for a camera — even though the proxy
> connects to the relay from `127.0.0.1`.

For viewing from outside the LAN, set the LiveKit credentials (see [Deployment](#deployment)) and
choose **LiveKit** on the viewer. `DEMO_FALLBACK=true` keeps a synthetic camera feed for the
WebSocket/MJPEG transports and the sensor simulator on; it does not add a camera prompt anywhere.

Useful local commands:

```bash
npm run dev          # restart on file changes
npm run sim:camera   # POST synthetic RGB565 frames to the local relay
npm run sim:sensors  # POST synthetic sensor packets
npm run test:e2e     # HTTP, WebSocket, MJPEG and sensor checks
npm run test:webrtc  # real offer/answer + data-channel frame check
npm run test:ui      # headless Chrome UI test (needs system Chrome)
```

To use a real camera, flash one of the ESP32-CAM sketches and point `SERVER_HOST` at the laptop's
LAN address, for example `192.168.1.50` with `SERVER_PORT 3000` (plain HTTP; the sketches use
`https://` unconditionally, so for LAN testing prefer the Render relay):

- [`firmware/esp32cam-wifimanager`](firmware/esp32cam-wifimanager/esp32cam-wifimanager.ino) —
  recommended; first boot opens the `ESP32-CAM-Config` Wi-Fi portal, no Wi-Fi credentials in code.
- [`firmware/esp32cam-streamer`](firmware/esp32cam-streamer/esp32cam-streamer.ino) — hard-coded
  Wi-Fi SSID/password.

See the [firmware guide](firmware/README.md) for wiring, flashing and calibration.

---

## Transports

| Transport | Endpoint | Best for | Notes |
| --- | --- | --- | --- |
| **WebSocket** | `/ws/frames` | Default | Binary JPEG plus JSON metadata; automatic reconnect |
| **WebRTC data channel** | `/api/rtc/offer` | Restrictive NAT / CGNAT | 12-byte header + JPEG; uses TURN when Metered is configured |
| **MJPEG** | `/stream.mjpeg`, `/api/stream.mjpeg` | Compatibility, direct `<img>` use | `multipart/x-mixed-replace` stream |
| **HTTP polling** | `/api/frame.jpg` | Fallback when sockets are blocked | Polled at ~200 ms with cache busting |

All transports read from the relay's in-memory frame hub, so the relay must be a single
long-running instance (laptop, Docker, Render, Railway) — not isolated serverless functions.
The ESP32-CAM reaches it at `POST /api/upload-frame`; there is no MQTT broker in the path.

WebRTC uses a data channel rather than VP8/H.264 video because the ESP32 already sends RGB565
and the server can deliver the same JPEG to every transport. This avoids native codecs and
ffmpeg, works with the pure-TypeScript `werift` implementation, and still traverses NAT through
Metered TURN. Frames carry `uint32 BE sequence` + `float64 BE server timestamp` (12 bytes),
followed by the JPEG bytes.

On Render, WebRTC **requires** Metered TURN: the service has no public UDP port for ICE, so only
relayed candidates can connect. Configure `METERED_DOMAIN` + `METERED_API_KEY` (see
[Enable Metered TURN](#2-enable-metered-turn)); without them WebSocket remains the working
transport and WebRTC mode falls back after 20 s. The server peer prefers Metered's TCP/TLS relay
(`turns:…:443?transport=tcp`) so the allocation does not depend on outbound UDP.

---

## Browser vision effects

All effects run locally in a canvas — no image ever leaves the browser for processing.

| Effect | What it highlights |
| --- | --- |
| `raw` | Untouched camera frame |
| `water` | NDWI-style water index (blue/cyan palette) |
| `vegetation` | Vegetation health (green/lime palette) |
| `thermal` | False-colour heat map based on luminance |
| `night` | Green night-vision gain with contrast boost |
| `edge` | Sobel edge detection |
| `cinematic` | Teal/orange grade with soft contrast |
| `invert` | Colour negative |

The intensity slider blends every effect from 0–100 %. The tour button cycles all eight
effects automatically.

---

## HTTP and WebSocket API

Full request/response examples are in [`docs/API.md`](docs/API.md).

### Camera

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/upload-frame` | Upload raw RGB565 (or JPEG) with `?w=320&h=240&format=rgb565le` |
| `POST` | `/api/camera/frame` | Alias for the same handler |
| `POST` | `/api/laptop/frame` | Relay the laptop webcam JPEG; same-origin only, no upload token |
| `GET` | `/api/frame.jpg` | Newest frame as JPEG |
| `GET` | `/api/latest-frame` | 307 redirect to `/api/frame.jpg` |
| `GET` | `/stream.mjpeg` | MJPEG stream |
| `GET` | `/api/stream.mjpeg` | MJPEG stream alias |

Upload query/header options:

```text
?w=320&h=240           width / height (16–4096)
?format=rgb565le       rgb565le (default) | rgb565be | rgb565 | jpeg
?flip=x,y             optional horizontal / vertical flip
?device=ESP32-CAM-01   device label shown in status
?token=...             alternative to the X-Upload-Token header
```

### Sensors

```json
POST /api/sensors
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

Aliases such as `temp`, `hum`, `soil_moisture`, `lux`, `aqi`, `pir` and `pressure_hpa` are
normalised automatically. History is kept in memory (`GET /api/sensors/history?limit=120`).

### Streaming and status

| Method | Path | Purpose |
| --- | --- | --- |
| `WS` | `/ws/frames` | JSON hello/metadata + binary JPEG frames |
| `WS` | `/ws/sensors` | Hello with history, then live `reading` messages |
| `GET` | `/api/status` | Camera, sensors, clients, ICE and config snapshot |
| `GET` | `/healthz` | Health check |
| `GET` | `/api/rtc/config` | ICE servers + Metered/STUN source |
| `POST` | `/api/rtc/offer` | WebRTC SDP offer → answer |
| `DELETE` | `/api/rtc/peer/:id` | Idempotent peer cleanup |
| `GET` | `/firmware/...` | Firmware sketches as plain text downloads |

All responses use JSON except image, MJPEG, WebSocket and firmware routes.

---

## Hardware

- **Camera:** AI-Thinker ESP32-CAM with the RHYX-M21-45 2 MP module, OV2640, 320×240 RGB565.
- **Sensor node:** ESP32 DevKit 38-pin (ESP32-WROOM-32) with DHT22, capacitive soil probe,
  LDR, MQ-135, PIR and optional BMP280 / battery divider.

Wiring tables, calibration constants, library installation and upload steps are in
[`firmware/README.md`](firmware/README.md).

> Power the ESP32-CAM from a stable **5 V / 1 A** supply. Brown-outs are the most common cause
> of failed uploads and scrambled colours.

---

## Configuration

Copy `.env.example` to `.env` for local development. Secrets are never required by the browser.
The laptop relay reads `.env` on every restart; there is no hosted dashboard to configure.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `UPLOAD_TOKEN` | empty | Shared secret for camera/sensor uploads |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `DEMO_FALLBACK` | `false` | Run the live sensor simulator until the first real ESP32 packet |
| `DEMO_FPS` | `8` | Demo camera frame rate when no laptop camera is running |
| `JPEG_QUALITY` | `80` | JPEG encoder quality |
| `FRAME_WIDTH` / `FRAME_HEIGHT` | `320` / `240` | Defaults when the device omits dimensions |
| `FRAME_FORMAT` | `rgb565le` | Default byte order when the device omits `format` |
| `MAX_FRAME_BYTES` | `2097152` | Upload body limit |
| `FRAME_STALE_MS` | `5000` | Age at which a live frame is considered stale |
| `MAX_WEBRTC_PEERS` | `4` | Concurrent data-channel peers |
| `LIVEKIT_URL` | empty | LiveKit Cloud WebSocket URL |
| `LIVEKIT_API_KEY` | empty | LiveKit API key |
| `LIVEKIT_API_SECRET` | empty | LiveKit secret (server-side only; never in the browser) |
| `LIVEKIT_ROOM` | `live` | Room used by the laptop camera and remote viewers |
| `LIVEKIT_TOKEN_TTL` | `21600` | Join-token lifetime in seconds |
| `METERED_DOMAIN` | empty | Metered TURN app domain |
| `METERED_API_KEY` | empty | Metered API key (server-side only) |
| `METERED_REGION` | empty | Optional Metered region |
| `METERED_TTL_MS` | `1800000` | Credential cache duration |
| `STUN_SERVERS` | Google STUN | Fallback ICE servers |
| `LOG_REQUESTS` | `false` | Log every HTTP request |

---

## Tests

The checks expect a running relay at `http://localhost:3000`:

```bash
npm start                 # terminal 1
npm run test:e2e          # terminal 2 — 14 HTTP/WS/MJPEG/sensor checks
npm run test:webrtc       # offer/answer + 12-byte header + live frames
npm run test:ui           # headless Chrome UI suite, saves screenshots/
```

`test:ui` uses `playwright-core` with the system Chrome/Edge executable. Set `CHROME_PATH` if
Chrome is installed somewhere else. The suite verifies:

- Arabic RTL boot, all eight effects, intensity, mirror, grid
- PNG snapshot download
- WebSocket → WebRTC → MJPEG → HTTP transport switching
- nine sensor cards, sparklines and telemetry chart
- TURN/status pills, language switching, firmware downloads
- mobile menu, 390 px layout and horizontal-overflow guard
- zero uncaught browser errors

Test commands accept an alternate server URL:

```bash
node tools/e2e-check.js http://localhost:3000
node tools/webrtc-check.js http://localhost:3000
node tools/ui-check.js http://localhost:3000
```

---

## Deployment

One Render web service is the whole deployment: it serves the dashboard, receives the ESP32-CAM
uploads and fans frames out to browsers. There is no separate static host (no Vercel, no GitHub
Pages) and no CORS hop.

```text
https://live-esp32-cam-stream.onrender.com
```

### 1. Deploy the relay + dashboard to Render

1. Open <https://dashboard.render.com/> → **New +** → **Blueprint**.
2. Select the repository and apply `render.yaml`. Render runs:

   ```text
   Build:  npm ci
   Start:  npm start
   Health: /healthz
   ```

3. Wait for **Live**, then open the service URL. The dashboard and `/api/status` come from the
   same origin, so `public/js/env.js` stays empty (`window.MIRSAD_API_BASE = ''`).
4. Push to `main` to redeploy. `autoDeployTrigger: commit` is already set.

Checks after every deploy:

```bash
curl https://YOUR-SERVICE.onrender.com/healthz
curl https://YOUR-SERVICE.onrender.com/api/status
# config.jpegEncoder must be "sharp" — the fallback "jpeg-js" is far slower
npm run test:prod            # headless Chrome proves the deployed page paints frames
```

Free plan: 0.1 vCPU and it sleeps after ~15 minutes without traffic. The camera pinging
`/healthz` keeps it awake; the first request after a sleep can take 30–60 s.

### 2. Enable Metered TURN

TURN is only needed for the WebRTC transport when a viewer sits behind symmetric NAT or a
corporate firewall. The camera upload never uses TURN.

1. Create a free account at <https://www.metered.ca/> and add a TURN app.
2. Copy the app **domain** (`mirsad.metered.live`) and the **API key**.
3. Render → service → **Environment**:

   ```env
   METERED_DOMAIN=mirsad.metered.live
   METERED_API_KEY=...        # server-side only
   METERED_REGION=            # optional
   ```

4. Save (Render restarts), then verify:

   ```bash
   curl https://YOUR-SERVICE.onrender.com/api/rtc/config
   # → "source":"metered", "turn":true, ICE servers include turns:...
   ```

Credentials are fetched server-side and cached for 30 minutes; the API key never reaches the
browser. The dashboard's TURN pill switches from `STUN` to `TURN`. The test client works without
a browser camera:

```bash
npm run test:webrtc
```

### 3. Flash the ESP32 boards

Follow [`LIVE-SETUP.md`](LIVE-SETUP.md) for the camera and [`firmware/README.md`](firmware/README.md)
for wiring. Set the Render host in the sketch (no scheme, no path):

```cpp
#define SERVER_HOST "live-esp32-cam-stream.onrender.com"
```

The relay appends `/api/upload-frame?w=320&h=240&format=rgb565le&device=…`. Prebuilt images are
served at `/flash.html` (Chrome/Edge + a USB-TTL adapter), so the camera laptop does not need
Arduino IDE. The sensor node posts JSON to `/api/sensors`; its `SERVER_URL` is the same host with
`https://` and the `/api/sensors` path.

After flashing, the dashboard source badge changes from `OFF` to `LIVE` on the first upload.
Because a public hostname is always classified as **viewer**, opening the Render dashboard never
prompts for a laptop camera — the ESP32-CAM stays the only publisher.

### Optional: run the relay on a laptop

Useful for LAN development before deploying:

```bash
cp .env.example .env      # Windows: copy .env.example .env
npm install
npm start
```

Open `http://localhost:3000` on that laptop to publish its webcam; other devices on the same
Wi-Fi are watch-only viewers and never open a camera. For viewers outside the LAN either deploy
to Render (above) or configure LiveKit Cloud:

```env
LIVEKIT_URL=wss://YOUR-PROJECT.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET=...      # server-side only
LIVEKIT_ROOM=live
```

The server only signs short-lived join tokens (`/api/livekit/token`). If the secret is missing,
the laptop camera still works locally and LiveKit mode shows a "not configured" toast.

---

## Security notes

- Set `UPLOAD_TOKEN` before exposing the service; both firmware sketches support
  `X-Upload-Token`. Without it, anyone who knows the URL can post frames.
- Keep `LIVEKIT_API_SECRET` and `METERED_API_KEY` server-side. Only short-lived join/ICE
  credentials are returned.
- The firmware uses `secureClient.setInsecure()` for convenience with development relays and
  rotating certificates. For a production fleet, pin a root CA with `setCACert()`.
- Tighten `ALLOWED_ORIGINS` to your dashboard origin instead of `*`.
- Uploads are capped by `MAX_FRAME_BYTES`; frame dimensions are validated.
- The relay is stateless apart from in-memory frames/history. Do not store secrets in the app.
- `getUserMedia` requires a secure context, but only the relay laptop needs it: use
  `http://localhost` there. Viewer devices never open a camera, so `http://192.168.x.x` is fine
  for watching the relay stream; use LiveKit or an HTTPS tunnel for viewing outside the LAN.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Dashboard stays on `OFF` | Camera cannot reach the relay, wrong URL or token | Check Serial Monitor, confirm the full `/api/upload-frame` URL and `UPLOAD_TOKEN` |
| Upload returns `401` | Token mismatch | Set the same token in firmware and `.env`. Both `X-Upload-Token` and `X-Api-Key` are accepted |
| Sensors show `OFF` after a while | Sensor node stopped posting | The dashboard marks data stale after 12 s; check the board, Wi-Fi and `/api/sensors/devices` |
| Upload returns `400 Expected … bytes` | Wrong `w`/`h` or format | Use `?w=320&h=240&format=rgb565le` |
| Colours look swapped | RGB565 byte order | Change the sketch's query string to `format=rgb565be` |
| Camera resets / brown-outs | Weak 5 V supply | Use a 5 V / 1 A supply and short, thick wires |
| `GET /api/frame.jpg` 404 | No frame uploaded yet | Start the camera, or set `DEMO_FALLBACK=true` only for UI testing |
| WebRTC connects but no frames | Server demo/camera stopped | Check `/api/status`; confirm `frameReady` and network |
| TURN pill says `STUN` | Metered not configured or credentials failed | Set `METERED_DOMAIN` + `METERED_API_KEY`, check server logs |
| Sensors show `--` | No packet yet | Confirm `/api/sensors` URL and JSON body; check `/api/sensors/devices` |
| Every visitor is asked for camera access | Everyone is being classified as the laptop, usually because a tunnel/proxy forwards from `127.0.0.1` | Update to this build, hard-refresh, and open the laptop at `http://localhost:3000`; public tunnel hosts are now watch-only |
| Laptop camera does not start | Browser blocked the camera, or the dashboard is open on a viewer device | Allow camera permission on the relay laptop; only the laptop should show the camera buttons. LAN viewers use the relay stream, not their own camera |
| Phone shows a frozen or very slow image | The laptop tab is hidden and an older build used throttled `setTimeout` to publish | Update and reload the laptop page once. This build publishes from a background worker, so the tab can be hidden or minimized while it shares the camera |
| LiveKit mode says "not configured" | `LIVEKIT_API_SECRET` is missing or still a placeholder | Paste the real secret from LiveKit **Settings → Keys**, restart the relay |
| Remote viewer stays black | No publisher in the room, or the secret is invalid | Keep the laptop dashboard open (it publishes the webcam); check `/api/livekit/config` reports `enabled: true` |
| UI test cannot find Chrome | No system Chrome/Edge | Set `CHROME_PATH` to the executable |

---

## Project layout

```text
server/                 Express relay
  config.js             Environment parsing
  frameHub.js           RGB565 → JPEG, live frame hub, fan-out
  rgb565.js             Byte-order conversion and validation
  sensors.js            Sensor normalisation, history, live simulator
  livekit.js            LiveKit token minting + sensor data-channel mirror
  webrtc.js             werift peers + Metered credentials
  index.js              Routes, WebSockets, lifecycle
public/                 Static dashboard (served by the relay)
  index.html            Arabic-first UI
  css/styles.css        Aurora glass theme, RTL, responsive
  js/app.js             Rendering, effects, controls, telemetry
  js/stream.js          WebSocket / WebRTC / MJPEG / polling / laptop camera / LiveKit
  js/effects.js         Eight canvas effects
  js/charts.js          Sparklines and telemetry chart
  js/i18n.js            Arabic/English dictionary
firmware/
  esp32cam-streamer/    ESP32-CAM RGB565 uploader (hard-coded Wi-Fi)
  esp32cam-wifimanager/ ESP32-CAM RGB565 uploader (captive-portal Wi-Fi setup)
  esp32-sensor-node/    ESP32 38-pin telemetry node
tools/                  Simulators and test suites
docs/                   API reference + English/Arabic deployment guides
render.yaml             Render Blueprint (single web service)
Dockerfile              Container build
```

---

## License

MIT © 2026 MIRSAD. See [LICENSE](LICENSE).

For a more detailed English walkthrough, see [`docs/DEPLOY-EN.md`](docs/DEPLOY-EN.md).
For the Arabic step-by-step guide, see [`docs/DEPLOY-AR.md`](docs/DEPLOY-AR.md).
