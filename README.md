
**Live ESP32-CAM vision dashboard with browser effects, WebRTC/TURN transport and ESP32 sensor telemetry.**
it accepts raw **RGB565** frames from an ESP32-CAM (RHYX-M21-45 / AI-Thinker), converts
them to JPEG on the server, and fans them out to every browser over **WebSocket**, **MJPEG**,
**HTTP polling** or a **WebRTC data channel**. The camera only makes outbound HTTPS requests:
it needs **no public IP, no port forwarding and no NAT traversal**.

Until the ESP32-CAM and sensor node are wired up, the dashboard uses the **laptop webcam** and a
**live sensor simulator**. The Node relay runs on the laptop; **LiveKit Cloud** carries the camera
track to remote viewers. No Render account or payment card is required.

The same page shows live readings from an **ESP32 38-pin sensor node** (temperature, humidity,
soil, light, air quality, motion, pressure, battery and RSSI). The built-in simulator updates every
two seconds and switches to real readings automatically on the first ESP32 packet. **Metered TURN**
remains available for restricted / carrier-grade NAT networks.

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
  - [1. Run the relay on the laptop](#1-run-the-relay-on-the-laptop)
  - [2. LiveKit Cloud remote video](#2-livekit-cloud-remote-video)
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
| Laptop camera | Auto-starts `getUserMedia`, runs every effect locally, and publishes the track to LiveKit Cloud |
| Remote video | LiveKit Cloud room: browsers only receive short-lived tokens minted by the relay |
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

Open **http://localhost:3000**. The page opens the **laptop camera** automatically; allow the
browser prompt. Until the ESP32-CAM is wired up, that webcam is the live source, and the sensor
cards run on the live simulator (`SIM` badge). Both switch to real hardware automatically:
the first ESP32-CAM frame replaces the webcam locally, and the first sensor packet stops the
simulator permanently.

To view the camera on another device, set the LiveKit credentials (see
[Deployment](#deployment)) and use the **LiveKit** mode. Without a camera on a machine, the page
shows a "waiting for camera" panel; `DEMO_FALLBACK=true` adds a synthetic feed for the
WebSocket/MJPEG transports and keeps the sensor simulator on.

Useful local commands:

```bash
npm run dev          # restart on file changes
npm run sim:camera   # POST synthetic RGB565 frames to the local relay
npm run sim:sensors  # POST synthetic sensor packets
npm run test:e2e     # HTTP, WebSocket, MJPEG and sensor checks
npm run test:webrtc  # real offer/answer + data-channel frame check
npm run test:ui      # headless Chrome UI test (needs system Chrome)
```

To use a real camera, flash one of the ESP32-CAM sketches and point `SERVER_URL` at the laptop's
LAN address, for example `http://192.168.1.50:3000/api/upload-frame`:

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
| `FRAME_FORMAT` | `rgb565be` | Default byte order when the device omits `format` |
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
node tools/e2e-check.js http://localhost:3000
node tools/webrtc-check.js http://localhost:3000
node tools/ui-check.js http://localhost:3000
```

---

## Deployment

There is no hosted relay to pay for. The laptop runs `npm start` (the same command used in
development), and LiveKit Cloud carries the video to anyone outside the LAN.

### 1. Run the relay on the laptop

```bash
cp .env.example .env      # Windows: copy .env.example .env
npm install
npm start
```

Open **http://localhost:3000**. The page starts the laptop camera automatically (allow the
browser permission prompt), applies the selected vision effect, and shows the live sensor
simulator with a `SIM` badge.

Useful environment values for this phase:

```env
DEMO_FALLBACK=true          # live simulator until the ESP32 boards are connected
DEMO_FPS=8
LIVEKIT_URL=wss://YOUR-PROJECT.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET=...      # server-side only, never sent to browsers
LIVEKIT_ROOM=live
```

`DEMO_FALLBACK=true` no longer means a fake camera: the laptop webcam is the real source. The
simulator only fills the sensor cards, and it stops permanently after the first real ESP32 packet.

> Browsers only allow `getUserMedia` in a **secure context**. `http://localhost` is secure, but
> `http://192.168.x.x` is not. For phones on the same Wi-Fi, use the **LiveKit** mode (or put the
> relay behind a free HTTPS tunnel such as Cloudflare Tunnel / ngrok).

### 2. LiveKit Cloud remote video

1. Create a free project at **https://cloud.livekit.io/**.
2. Open **Settings → Keys** and copy the **URL**, **API Key** and **API Secret** into `.env`.
   The secret is shown only once; if it is lost, create a new key.
3. Restart the relay. The startup banner should say
   `LiveKit : wss://… · room "live"` and `/api/livekit/config` should return `"enabled": true`.
4. **Publisher (laptop):** open the dashboard and click **Laptop camera**. The webcam preview is
   local *and* published to LiveKit.
5. **Viewer (phone / another city):** open the dashboard, click **LiveKit**, and the remote camera
   track is rendered into the same canvas with all effects. Sensor packets are mirrored into the
   LiveKit data channel by the server, so the cards stay live too.

The server only signs short-lived join tokens (`/api/livekit/token`); the API secret never leaves
the machine. If the secret is missing, the laptop camera still works locally and the LiveKit mode
shows a clear "not configured" toast.

### 3. Enable Metered TURN

TURN is optional once LiveKit is in use; keep it for the direct browser WebRTC mode on mobile
carriers and corporate Wi-Fi. The camera upload itself never needs TURN.

1. Create a free account at **https://www.metered.ca/**.
2. Open the **TURN** / **Open Relay** dashboard and create an app (for example `mirsad`).
3. Copy the app **domain** (looks like `mirsad.metered.live`) and the **API key**.
4. Add them to `.env`:
   - `METERED_DOMAIN=mirsad.metered.live`
   - `METERED_API_KEY=...` (keep secret)
   - `METERED_REGION=` (optional, e.g. a region shown by Metered)
5. Restart the relay.
6. Verify:

```bash
curl http://localhost:3000/api/rtc/config
# → "source":"metered", "turn":true, ICE servers include turns:...
```

The server fetches short-lived credentials from Metered and caches them for 30 minutes. The
API key never reaches the browser. In the dashboard, the TURN pill switches from `STUN` to
`TURN`.

### 4. Flash the ESP32 boards

Follow [`firmware/README.md`](firmware/README.md). Use the laptop's **LAN address** (not
`localhost`) so the boards can reach the relay:

```cpp
const char *WIFI_SSID = "...";
const char *WIFI_PASSWORD = "...";
const char *SERVER_URL = "http://192.168.1.50:3000/api/upload-frame"; // camera
const char *SERVER_URL = "http://192.168.1.50:3000/api/sensors";      // sensors
const char *UPLOAD_TOKEN = "...";   // same value as .env, or empty
```

Find the laptop address with `ipconfig` (Windows) or `ipconfig getifaddr en0` (macOS). After the
first camera frame arrives, the dashboard source badge changes from `OFF` to `LIVE` and the
waiting panel disappears.

### Optional: GitHub Pages frontend

The relay already serves the frontend, so static hosting is only useful for a public dashboard
that talks to a relay exposed through a tunnel:

1. Publish the `public/` folder (for example with a GitHub Actions Pages workflow).
2. Point it at the tunnel URL:
   ```html
   <meta name="mirsad-api-base" content="https://YOUR-TUNNEL.example.com" />
   ```
   or append `?api=https://YOUR-TUNNEL.example.com` to the Pages URL.
3. Set `ALLOWED_ORIGINS` in `.env` to the Pages origin, for example
   `https://YOUR_USER.github.io`.
4. Restart. WebSocket and API calls are automatically rewritten to the relay host.

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
- `getUserMedia` requires a secure context: use `http://localhost` or terminate HTTPS with a
  tunnel/reverse proxy before exposing the dashboard to other devices.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Dashboard stays on `OFF` | Camera cannot reach the relay, wrong URL or token | Check Serial Monitor, confirm the full `/api/upload-frame` URL and `UPLOAD_TOKEN` |
| Upload returns `401` | Token mismatch | Set the same token in firmware and `.env`. Both `X-Upload-Token` and `X-Api-Key` are accepted |
| Sensors show `OFF` after a while | Sensor node stopped posting | The dashboard marks data stale after 12 s; check the board, Wi-Fi and `/api/sensors/devices` |
| Upload returns `400 Expected … bytes` | Wrong `w`/`h` or format | Use `?w=320&h=240&format=rgb565be` (or `le`) |
| Colours look swapped | RGB565 byte order | Flip `USE_RGB565_BIG_ENDIAN` in the camera sketch |
| Camera resets / brown-outs | Weak 5 V supply | Use a 5 V / 1 A supply and short, thick wires |
| `GET /api/frame.jpg` 404 | No frame uploaded yet | Start the camera, or set `DEMO_FALLBACK=true` only for UI testing |
| WebRTC connects but no frames | Server demo/camera stopped | Check `/api/status`; confirm `frameReady` and network |
| TURN pill says `STUN` | Metered not configured or credentials failed | Set `METERED_DOMAIN` + `METERED_API_KEY`, check server logs |
| Sensors show `--` | No packet yet | Confirm `/api/sensors` URL and JSON body; check `/api/sensors/devices` |
| Laptop camera does not start | Browser blocked the camera or the origin is not secure | Allow camera permission; use `localhost` or HTTPS. LAN IPs need LiveKit mode or a tunnel |
| LiveKit mode says "not configured" | `LIVEKIT_API_SECRET` is missing or still a placeholder | Paste the real secret from LiveKit **Settings → Keys**, restart the relay |
| Remote viewer stays black | No publisher in the room, or the secret is invalid | Start **Laptop camera** on one device first; check `/api/livekit/config` reports `enabled: true` |
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
render.yaml             Legacy Render Blueprint (unused; kept for reference)
Dockerfile              Container build
```

---

## License

MIT © 2026 MIRSAD. See [LICENSE](LICENSE).

For a more detailed English walkthrough, see [`docs/DEPLOY-EN.md`](docs/DEPLOY-EN.md).
For the Arabic step-by-step guide, see [`docs/DEPLOY-AR.md`](docs/DEPLOY-AR.md).
