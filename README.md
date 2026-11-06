
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/TasneemHazem10/live-ESP32-cam-stream)

**Live ESP32-CAM vision dashboard with browser effects, WebRTC/TURN transport and ESP32 sensor telemetry.**
it accepts raw **RGB565** frames from an ESP32-CAM (RHYX-M21-45 / AI-Thinker), converts
them to JPEG on the server, and fans them out to every browser over **WebSocket**, **MJPEG**,
**HTTP polling** or a **WebRTC data channel**. The camera only makes outbound HTTPS requests:
it needs **no public IP, no port forwarding and no NAT traversal**.

The same page shows live readings from an **ESP32 38-pin sensor node** (temperature, humidity,
soil, light, air quality, motion, pressure, battery and RSSI). Everything runs from one Render
web service, with **Metered TURN** available for restricted / carrier-grade NAT networks.

> **Using the original FieldEye ESP sketches?** They are fully supported. The relay accepts both
> `X-Api-Key` and `X-Upload-Token`, plus `Authorization: Bearer ...`, `?token=` and `?apiKey=`.
> For the complete deployment + flashing walkthrough for this exact setup, see
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
  - [1. Push to GitHub](#1-push-to-github)
  - [2. Deploy the relay on Render](#2-deploy-the-relay-on-render)
  - [3. Enable Metered TURN](#3-enable-metered-turn)
  - [4. Flash the ESP32 boards](#4-flash-the-esp32-boards)
  - [Optional: GitHub Pages frontend](#optional-github-pages-frontend)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [License](#license)

---

## Feature overview

| Area | What you get |
| --- | --- |
| Camera ingestion | `POST /api/upload-frame` accepts raw RGB565 LE/BE (`153,600` bytes for 320×240) or a JPEG fallback |
| Low latency delivery | WebSocket binary JPEG frames, MJPEG multipart stream, HTTP polling and WebRTC data channel |
| WebRTC | Browser ↔ server data channel negotiated through `/api/rtc/offer`; Metered TURN credentials fetched server-side |
| Browser effects | Water index, vegetation, thermal, night vision, edge detection, cinematic, invert and raw — all client-side canvas filters |
| Studio controls | Effect intensity, mirror, rule-of-thirds grid, fullscreen, PNG snapshot, automatic effect tour |
| Sensors | 9 live demo cards + history chart; real ESP32 packets replace the demo automatically |
| UI | Arabic-first RTL with one-click English, dark aurora glass design, scroll reveals, counters, responsive mobile menu |
| Operations | `/healthz`, `/api/status`, structured errors, upload token, CORS allow-list, request logging, Docker file |
| Demo mode | Optional synthetic camera + sensor signal for UI development (`DEMO_FALLBACK=true`); **off by default** and permanently stops after the first real frame |

---

## Architecture

```text
┌────────────────────┐   HTTPS POST (outbound only)   ┌──────────────────────────┐
│  ESP32-CAM         │ ─────────────────────────────► │  MIRSAD relay (Node.js)  │
│  320×240 RGB565    │     153,600 bytes/frame        │  RGB565 → JPEG           │
│  4 fps default     │                                │  in-memory frame hub     │
└────────────────────┘                                │  sensor store + history  │
                                                      │  Metered TURN credentials│
┌────────────────────┐   HTTPS POST every 2 s        │                          │
│  ESP32 38-pin      │ ─────────────────────────────► │                          │
│  DHT22, soil, LDR, │     JSON sensor readings       └──────────┬───────────────┘
│  MQ-135, PIR, etc. │                                           │
└────────────────────┘                     WebSocket / MJPEG / WebRTC / HTTP
                                                       │
                                                       ▼
                                            ┌─────────────────────┐
                                            │  Browser dashboard  │
                                            │  canvas + effects   │
                                            │  sensor charts      │
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

Open **http://localhost:3000**. The page starts in **live-only mode**: it shows a
"waiting for camera" panel until the ESP32-CAM sends its first frame. There is no synthetic
video by default. To preview the UI without hardware, set `DEMO_FALLBACK=true` in `.env` and
restart the server.

Useful local commands:

```bash
npm run dev          # restart on file changes
npm run sim:camera   # POST synthetic RGB565 frames to the local relay
npm run sim:sensors  # POST synthetic sensor packets
npm run test:e2e     # HTTP, WebSocket, MJPEG and sensor checks
npm run test:webrtc  # real offer/answer + data-channel frame check
npm run test:ui      # headless Chrome UI test (needs system Chrome)
```

To use a real camera, flash one of the ESP32-CAM sketches and point `SERVER_URL` at
`https://YOUR-SERVICE.onrender.com/api/upload-frame`:

- [`firmware/esp32cam-wifimanager`](firmware/esp32cam-wifimanager/esp32cam-wifimanager.ino) —
  recommended; first boot opens the `ESP32-CAM-Config` Wi-Fi portal, no Wi-Fi credentials in code.
- [`firmware/esp32cam-streamer`](firmware/esp32cam-streamer/esp32cam-streamer.ino) — hard-coded
  Wi-Fi SSID/password.

See the [firmware guide](firmware/README.md) for wiring, flashing and calibration.

---

## Transports

| Transport | Endpoint | Best for | Notes |
| --- | --- | --- | --- |
| **WebSocket** | `/ws/frames` | Default low-latency mode | Binary JPEG plus JSON metadata; automatic reconnect |
| **WebRTC data channel** | `/api/rtc/offer` | Restrictive NAT / CGNAT | 12-byte header + JPEG; uses TURN when Metered is configured |
| **MJPEG** | `/stream.mjpeg`, `/api/stream.mjpeg` | Compatibility, direct `<img>` use | `multipart/x-mixed-replace` stream |
| **HTTP polling** | `/api/frame.jpg` | Fallback when sockets are blocked | Polled at ~140 ms with cache busting |

WebRTC uses a data channel rather than VP8/H.264 video because the ESP32 already sends RGB565
and the server can deliver the same JPEG to every transport. This avoids native codecs and
ffmpeg, works with the pure-TypeScript `werift` implementation, and still traverses NAT through
Metered TURN. Frames carry `uint32 BE sequence` + `float64 BE server timestamp` (12 bytes),
followed by the JPEG bytes.

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
| `POST` | `/api/upload-frame` | Upload raw RGB565 (or JPEG) with `?w=320&h=240&format=rgb565be` |
| `POST` | `/api/camera/frame` | Alias for the same handler |
| `GET` | `/api/frame.jpg` | Newest frame as JPEG |
| `GET` | `/api/latest-frame` | 307 redirect to `/api/frame.jpg` |
| `GET` | `/stream.mjpeg` | MJPEG stream |
| `GET` | `/api/stream.mjpeg` | MJPEG stream alias |

Upload query/header options:

```text
?w=320&h=240           width / height (16–4096)
?format=rgb565be       rgb565be | rgb565le | rgb565 | jpeg
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
| `GET` | `/healthz` | Render health check |
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

Copy `.env.example` to `.env` for local development. On Render, set the same keys in the
service's **Environment** tab. Secrets are never required by the browser.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `UPLOAD_TOKEN` | empty | Shared secret for camera/sensor uploads |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `DEMO_FALLBACK` | `false` | Optional synthetic frames/sensors for UI testing; disable for live-only |
| `DEMO_FPS` | `8` | Demo camera frame rate |
| `JPEG_QUALITY` | `80` | JPEG encoder quality |
| `FRAME_WIDTH` / `FRAME_HEIGHT` | `320` / `240` | Defaults when the device omits dimensions |
| `FRAME_FORMAT` | `rgb565le` | Default byte order when the device omits `format` |
| `MAX_FRAME_BYTES` | `2097152` | Upload body limit |
| `FRAME_STALE_MS` | `5000` | Age at which a live frame is considered stale |
| `MAX_WEBRTC_PEERS` | `4` | Concurrent data-channel peers |
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
npm run test:e2e          # terminal 2 — 12 HTTP/WS/MJPEG/sensor checks
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
node tools/e2e-check.js https://mirsad-live.onrender.com
node tools/webrtc-check.js https://mirsad-live.onrender.com
node tools/ui-check.js https://mirsad-live.onrender.com
```

---

## Deployment

The included [`render.yaml`](render.yaml) deploys one Node web service that serves both the
frontend and the API. GitHub is the source repository; Render builds and hosts it.

### 1. Push to GitHub

Create an empty repository at **https://github.com/new** (do not add a README), then:

```bash
git init
git add .
git commit -m "MIRSAD live ESP32-CAM dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

With GitHub CLI:

```bash
gh auth login
gh repo create YOUR_REPO --private --source=. --remote=origin --push
```

Never commit `.env`. Only `.env.example` belongs in the repository.

### 2. Deploy the relay on Render

**One-click Blueprint** for this repository:

<https://render.com/deploy?repo=https://github.com/TasneemHazem10/live-ESP32-cam-stream>

1. Sign in to Render with GitHub and authorize access to the repository.
2. Render reads `render.yaml` and shows the **mirsad-live** service.
3. Click **Apply**.
4. Render **auto-generates `UPLOAD_TOKEN`**. After the service is created, open
   **Dashboard → mirsad-live → Environment** and copy the token. Paste it into the ESP32 sketch.
5. Wait for the build (`npm ci`) and deploy (`npm start`). The health check is `/healthz`.
6. Open the generated `https://YOUR-SERVICE.onrender.com` URL.

`METERED_DOMAIN`, `METERED_API_KEY` and `METERED_REGION` are optional; add them later under
**Environment** if you need TURN (see [section 3](#3-enable-metered-turn)).

**Manual service instead of a Blueprint:**

1. **New** → **Web Service** → connect the repository.
2. Runtime **Node**, build command `npm ci`, start command `npm start`.
3. Health check path `/healthz`.
4. Add the environment variables from `.env.example` (at minimum `NODE_VERSION=22`).
5. Deploy.

> Render's free plan spins down after inactivity. The first request after a pause takes a few
> seconds; WebSocket/WebRTC clients reconnect automatically. The image is kept in memory, so a
> restart clears frames and sensor history until the next upload.

### 3. Enable Metered TURN

TURN is strongly recommended: it lets WebRTC work on mobile carriers, guest Wi-Fi and
corporate networks that block direct peer-to-peer traffic. The camera upload itself never
needs TURN.

1. Create a free account at **https://www.metered.ca/**.
2. Open the **TURN** / **Open Relay** dashboard and create an app (for example `mirsad`).
3. Copy the app **domain** (looks like `mirsad.metered.live`) and the **API key**.
4. In Render → your service → **Environment**, add:
   - `METERED_DOMAIN=mirsad.metered.live`
   - `METERED_API_KEY=...` (keep secret)
   - `METERED_REGION=` (optional, e.g. a region shown by Metered)
5. Save and redeploy/restart.
6. Verify:

```bash
curl https://YOUR-SERVICE.onrender.com/api/rtc/config
# → "source":"metered", "turn":true, ICE servers include turns:...
```

The server fetches short-lived credentials from Metered and caches them for 30 minutes. The
API key never reaches the browser. In the dashboard, the TURN pill switches from `STUN` to
`TURN`.

### 4. Flash the ESP32 boards

Follow [`firmware/README.md`](firmware/README.md). The only values you must edit are:

```cpp
const char *WIFI_SSID = "...";
const char *WIFI_PASSWORD = "...";
const char *SERVER_URL = "https://YOUR-SERVICE.onrender.com/api/upload-frame"; // camera
const char *SERVER_URL = "https://YOUR-SERVICE.onrender.com/api/sensors";      // sensors
const char *UPLOAD_TOKEN = "...";   // same value as Render, or empty
```

After the first camera frame arrives, the dashboard source badge changes from `OFF` to
`LIVE` and the waiting panel disappears.

### Optional: GitHub Pages frontend

Render already serves the frontend, so this is only needed if you specifically want static
hosting on GitHub Pages:

1. Publish the `public/` folder (for example with a GitHub Actions Pages workflow).
2. Set the Render backend URL in `public/index.html`:
   ```html
   <meta name="mirsad-api-base" content="https://YOUR-SERVICE.onrender.com" />
   ```
   or append `?api=https://YOUR-SERVICE.onrender.com` to the Pages URL.
3. Set `ALLOWED_ORIGINS` on Render to your Pages origin, for example
   `https://YOUR_USER.github.io`.
4. Redeploy. WebSocket and API calls are automatically rewritten to the Render host.

---

## Security notes

- Set `UPLOAD_TOKEN` before exposing the service; both firmware sketches support
  `X-Upload-Token`. Without it, anyone who knows the URL can post frames.
- Keep `METERED_API_KEY` server-side. Only short-lived ICE credentials are returned.
- The firmware uses `secureClient.setInsecure()` for convenience with Render's rotating
  certificates. For a production fleet, pin a root CA with `setCACert()`.
- Tighten `ALLOWED_ORIGINS` to your dashboard origin instead of `*`.
- Uploads are capped by `MAX_FRAME_BYTES`; frame dimensions are validated.
- The relay is stateless apart from in-memory frames/history. Do not store secrets in the app.
- Serve only over HTTPS in production (Render provides TLS automatically).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Dashboard stays on `OFF` | Camera cannot reach the relay, wrong URL or token | Check Serial Monitor, confirm the full `/api/upload-frame` URL and `UPLOAD_TOKEN` |
| Upload returns `401` | Token mismatch | Set the same token in firmware and Render. Both `X-Upload-Token` and `X-Api-Key` are accepted |
| Sensors show `OFF` after a while | Sensor node stopped posting | The dashboard marks data stale after 12 s; check the board, Wi-Fi and `/api/sensors/devices` |
| Upload returns `400 Expected … bytes` | Wrong `w`/`h` or format | Use `?w=320&h=240&format=rgb565be` (or `le`) |
| Colours look swapped | RGB565 byte order | Flip `USE_RGB565_BIG_ENDIAN` in the camera sketch |
| Camera resets / brown-outs | Weak 5 V supply | Use a 5 V / 1 A supply and short, thick wires |
| `GET /api/frame.jpg` 404 | No frame uploaded yet | Start the camera, or set `DEMO_FALLBACK=true` only for UI testing |
| WebRTC connects but no frames | Server demo/camera stopped | Check `/api/status`; confirm `frameReady` and network |
| TURN pill says `STUN` | Metered not configured or credentials failed | Set `METERED_DOMAIN` + `METERED_API_KEY`, check server logs |
| Sensors show `--` | No packet yet | Confirm `/api/sensors` URL and JSON body; check `/api/sensors/devices` |
| Render cold start | Free plan spin-down | Wait for the first request or upgrade the plan |
| UI test cannot find Chrome | No system Chrome/Edge | Set `CHROME_PATH` to the executable |

---

## Project layout

```text
server/                 Express relay
  config.js             Environment parsing
  frameHub.js           RGB565 → JPEG, live frame hub, fan-out
  rgb565.js             Byte-order conversion and validation
  sensors.js            Sensor normalisation, history, demo data
  webrtc.js             werift peers + Metered credentials
  index.js              Routes, WebSockets, lifecycle
public/                 Static dashboard (served by the relay)
  index.html            Arabic-first UI
  css/styles.css        Aurora glass theme, RTL, responsive
  js/app.js             Rendering, effects, controls, telemetry
  js/stream.js          WebSocket / WebRTC / MJPEG / polling clients
  js/effects.js         Eight canvas effects
  js/charts.js          Sparklines and telemetry chart
  js/i18n.js            Arabic/English dictionary
firmware/
  esp32cam-streamer/    ESP32-CAM RGB565 uploader (hard-coded Wi-Fi)
  esp32cam-wifimanager/ ESP32-CAM RGB565 uploader (captive-portal Wi-Fi setup)
  esp32-sensor-node/    ESP32 38-pin telemetry node
tools/                  Simulators and test suites
docs/                   API reference + English/Arabic deployment guides
render.yaml             Render Blueprint
Dockerfile              Container build
```

---

## License

MIT © 2026 MIRSAD. See [LICENSE](LICENSE).

For a more detailed English walkthrough, see [`docs/DEPLOY-EN.md`](docs/DEPLOY-EN.md).
For the Arabic step-by-step guide, see [`docs/DEPLOY-AR.md`](docs/DEPLOY-AR.md).
