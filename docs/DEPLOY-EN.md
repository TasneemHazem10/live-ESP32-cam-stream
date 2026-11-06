# MIRSAD — Complete Deployment & Hardware Guide

This guide walks through the entire project, end to end:

1. Run it locally.
2. Push the code to GitHub.
3. Deploy the relay + dashboard to Render.
4. Configure Metered TURN.
5. Flash the ESP32-CAM.
6. Flash the ESP32 38-pin sensor node.
7. Verify everything and troubleshoot.

> The camera and sensor boards only make **outbound HTTPS requests**. You do **not** need a
> public IP, port forwarding, or NAT traversal on either board.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Run locally](#2-run-locally)
3. [Push to GitHub](#3-push-to-github)
4. [Deploy to Render](#4-deploy-to-render)
5. [Environment variables](#5-environment-variables)
6. [Metered TURN](#6-metered-turn)
7. [Flash the ESP32-CAM](#7-flash-the-esp32-cam)
8. [Flash the ESP32 38-pin sensor node](#8-flash-the-esp32-38-pin-sensor-node)
9. [Verify the deployment](#9-verify-the-deployment)
10. [Update the deployment](#10-update-the-deployment)
11. [Troubleshooting](#11-troubleshooting)
12. [Security and cost notes](#12-security-and-cost-notes)

---

## 1. What you need

| Item | Details |
| --- | --- |
| GitHub account | Free — <https://github.com> |
| Render account | Free — <https://render.com> (sign up with GitHub) |
| Metered account | Free — <https://www.metered.ca> (optional, strongly recommended) |
| Node.js | **22 or newer** — <https://nodejs.org> |
| Arduino IDE | 2.x — <https://www.arduino.cc/en/software> |
| ESP32-CAM | AI-Thinker board with RHYX-M21-45 2 MP camera |
| ESP32 38-pin | ESP32 DevKit / ESP32-WROOM-32 with sensors |
| USB-TTL adapter | CP2102 or CH340 for the ESP32-CAM |
| Power supply | **5 V / 1 A** for the ESP32-CAM |

The project is pure Node.js. It does **not** need Python, ffmpeg, a database, or a native
build toolchain.

---

## 2. Run locally

Open PowerShell in the project folder:

```powershell
npm install
npm start
```

Open:

```text
http://localhost:3000
```

The dashboard starts in **live-only mode**: it shows a waiting panel until the ESP32-CAM sends
its first frame. There is no synthetic video by default. To preview the UI without hardware,
set `DEMO_FALLBACK=true` in `.env` and restart the server.

Try:

- All eight vision effects and the intensity slider.
- Mirror, rule-of-thirds grid, fullscreen, and PNG snapshot.
- Switching transport: WebSocket → WebRTC → MJPEG → HTTP.
- Arabic ↔ English language switching.

Useful commands:

```powershell
npm run dev          # restart automatically on file changes
npm run sim:camera   # POST synthetic RGB565 frames
npm run sim:sensors  # POST synthetic sensor packets
npm run test:e2e     # 12 HTTP/WebSocket/MJPEG/sensor checks
npm run test:webrtc  # real offer/answer + data-channel frame check
npm run test:ui      # headless Chrome UI test
```

> The three test suites expect the relay to be running at `http://localhost:3000` in another
> terminal. `test:ui` needs system Chrome or Edge; set `CHROME_PATH` if it is installed in a
> non-standard location.

Stop the server with `Ctrl + C`.

---

## 3. Push to GitHub

### 3.1 Create the repository

1. Open <https://github.com/new>.
2. Name it, for example, `mirsad-live`.
3. Choose **Private** or **Public**.
4. Do **not** add a README, `.gitignore`, or license — the project already contains them.
5. Click **Create repository** and copy the repository URL.

### 3.2 First commit and push

The project has already been initialized and committed locally. From the project folder:

```powershell
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

Replace `YOUR_USER` and `YOUR_REPO` with your account and repository names.

If you are starting from a fresh copy without a Git repository:

```powershell
git init
git add .
git commit -m "MIRSAD live ESP32-CAM dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

### 3.3 Alternative: GitHub CLI

```powershell
gh auth login
gh repo create mirsad-live --private --source=. --remote=origin --push
```

### 3.4 Pre-push checklist

Make sure `.env` is **not** tracked:

```powershell
git status
```

`.env`, `node_modules/`, and screenshots are excluded by `.gitignore`. Only `.env.example`
belongs in the repository.

---

## 4. Deploy to Render

One Render web service serves both the frontend and the API.

### Option A — Blueprint (recommended)

1. Open <https://dashboard.render.com/>.
2. Click **New** → **Blueprint**.
3. Connect GitHub and select the repository.
4. Render detects `render.yaml` and shows the **mirsad-live** service.
5. Review the settings and click **Apply**.
6. Render **auto-generates `UPLOAD_TOKEN`** for you. After the service is created, open
   **Dashboard → your service → Environment** and copy the token — you will paste it into the
   ESP32 sketch.
7. TURN is optional. The Blueprint uses public STUN by default. To support very restrictive
   networks later, add `METERED_DOMAIN`, `METERED_API_KEY` and `METERED_REGION` under
   **Dashboard → your service → Environment** and redeploy.
8. Wait for the build and deploy. Render uses:

   ```text
   Build:       npm ci
   Start:       npm start
   Health path: /healthz
   ```

9. Open the generated URL:

   ```text
   https://YOUR-SERVICE.onrender.com
   ```

### Option B — Manual web service

1. Click **New** → **Web Service**.
2. Connect GitHub and select the repository.
3. Set:
   - **Runtime:** Node
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz`
4. Add at least:

   ```text
   NODE_VERSION=22
   ```

   See [section 5](#5-environment-variables) for the rest.
5. Click **Create Web Service**.

### Generate `UPLOAD_TOKEN`

Use one of these and copy the output:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

or:

```bash
openssl rand -hex 24
```

Use the **same value** in Render and in both firmware sketches. A mismatch returns HTTP 401.

---

## 5. Environment variables

In Render: open the service → **Environment** → add or edit variables → save and redeploy.

| Variable | Suggested | Purpose |
| --- | --- | --- |
| `NODE_VERSION` | `22` | Node runtime |
| `NODE_ENV` | `production` | Production mode |
| `UPLOAD_TOKEN` | long random string | Protects camera/sensor uploads |
| `ALLOWED_ORIGINS` | `*` or your domain | Allowed browser origins |
| `DEMO_FALLBACK` | `false` | Optional synthetic frames/readings for UI testing; keep false for live-only |
| `DEMO_FPS` | `8` | Demo camera frame rate |
| `JPEG_QUALITY` | `80` | JPEG quality |
| `FRAME_WIDTH` / `FRAME_HEIGHT` | `320` / `240` | Default frame dimensions |
| `FRAME_FORMAT` | `rgb565le` | Default byte order |
| `MAX_FRAME_BYTES` | `2097152` | Upload size limit |
| `FRAME_STALE_MS` | `5000` | Age before a frame is considered stale |
| `MAX_WEBRTC_PEERS` | `4` | Concurrent WebRTC sessions |
| `METERED_DOMAIN` | Metered app domain | TURN service |
| `METERED_API_KEY` | Metered API key | Stays server-side only |
| `METERED_REGION` | empty or a region | Optional Metered region |
| `STUN_SERVERS` | Google STUN | Fallback when Metered is absent |
| `LOG_REQUESTS` | `false` | Log every request (debugging only) |

All variables are documented in `.env.example`.

---

## 6. Metered TURN

TURN is strongly recommended for restricted networks: mobile carriers, hotel Wi-Fi,
corporate firewalls, and carrier-grade NAT. **Camera uploads never need TURN**, but viewing
over WebRTC may.

### 6.1 Create a Metered app

1. Sign up at <https://www.metered.ca/>.
2. Open the **TURN / Open Relay** dashboard.
3. Create a new app, for example `mirsad`.
4. Copy:
   - **App domain** — looks like `mirsad.metered.live`
   - **API key** — the secret

### 6.2 Add it to Render

In Render → service → **Environment**:

```text
METERED_DOMAIN=mirsad.metered.live
METERED_API_KEY=your_api_key_here
METERED_REGION=
```

Save and redeploy or restart the service.

### 6.3 Verify

```powershell
curl.exe https://YOUR-SERVICE.onrender.com/api/rtc/config
```

Look for:

```json
{ "source": "metered", "turn": true }
```

The `iceServers` array should contain `turns:` URLs. In the dashboard the transport badge changes
from `STUN` to `TURN`.

> The Metered API key never reaches the browser. The server fetches short-lived credentials and
> caches them for 30 minutes.

---

## 7. Flash the ESP32-CAM

### 7.1 Prepare Arduino IDE

1. Open **File → Preferences → Additional Boards Manager URLs** and add:

   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

2. Open **Tools → Board → Boards Manager**, search for `esp32`, and install
   **ESP32 by Espressif Systems**.
3. No extra library is needed for the camera; `esp_camera.h` ships with the ESP32 package.

### 7.2 Wire the USB-TTL adapter

| USB-TTL | ESP32-CAM | Note |
| --- | --- | --- |
| `5V` | `5V` | Real 5 V / 1 A supply |
| `GND` | `GND` | Common ground is mandatory |
| `TX` | `U0RXD` (GPIO 3) | Cross TX → RX |
| `RX` | `U0TXD` (GPIO 1) | Cross RX → TX |
| — | `GPIO 0` → `GND` | Only while uploading |
| — | `RST` | Reset / start upload |

### 7.3 Edit the sketch

Two camera sketches exist. The **recommended** one stores Wi-Fi credentials through the
`ESP32-CAM-Config` captive portal, so no Wi-Fi password is written in code:

```text
firmware/esp32cam-wifimanager/esp32cam-wifimanager.ino
```

It still needs the relay settings below (`SERVER_URL`, `UPLOAD_TOKEN`, `DEVICE_ID`,
`USE_RGB565_BIG_ENDIAN`, `TARGET_FPS`). After flashing, join **`ESP32-CAM-Config`** from your
phone or laptop and choose your home network. To change networks later, erase the flash and
reboot.

The alternative sketch with hard-coded Wi-Fi credentials is
`firmware/esp32cam-streamer/esp32cam-streamer.ino`:

```cpp
const char *WIFI_SSID     = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SERVER_URL    = "https://YOUR-SERVICE.onrender.com/api/upload-frame";
const char *UPLOAD_TOKEN  = "SAME_VALUE_AS_RENDER";
const char *DEVICE_ID     = "ESP32-CAM-01";
const bool  USE_RGB565_BIG_ENDIAN = true;
const int   TARGET_FPS    = 4;
```

Important:

- Use your Render URL and end at `/api/upload-frame`. Do **not** append query parameters; the
  sketch adds `?w=320&h=240&format=rgb565be&device=...` automatically.
- If colours look inverted (orange sky, blue skin), set
  `USE_RGB565_BIG_ENDIAN = false`.
- Keep `TARGET_FPS = 4` initially. One 320×240 RGB565 frame is 153,600 bytes, about 4.9 Mbit/s
  of raw upload before TLS overhead.

### 7.4 Arduino IDE upload settings

- **Board:** AI Thinker ESP32-CAM
- **CPU Frequency:** 240 MHz
- **Flash Frequency:** 40 MHz
- **Partition Scheme:** Huge APP (3MB No OTA/1MB SPIFFS)
- **PSRAM:** Enabled
- **Upload Speed:** 115200 (try 460800 only if stable)

### 7.5 Upload sequence

1. Connect `GPIO 0` to `GND`.
2. Press **RST** once.
3. Click **Upload** in Arduino IDE.
4. When the upload finishes, disconnect `GPIO 0` from `GND` and press **RST**.
5. Open **Serial Monitor** at **115200 baud**.

If it hangs at `Connecting........_____`, hold **RST**, click Upload, and release **RST** when
the dots start. Also reseat the camera ribbon cable (gold contacts toward the board) and check
the 5 V supply.

Expected serial output:

```text
[wifi] connected, IP=192.168.1.42 RSSI=-57 dBm
[camera] sensor PID=0x26, 320x240 RGB565
[upload] frame #1 accepted (153600 bytes)
```

---

## 8. Flash the ESP32 38-pin sensor node

### 8.1 Install libraries

**Tools → Manage Libraries** and install:

- **DHT sensor library** by Adafruit
- **Adafruit Unified Sensor**
- **Adafruit BMP280** (optional, for pressure)

### 8.2 Wiring

| Sensor | Sensor pin | ESP32 38-pin | Note |
| --- | --- | --- | --- |
| DHT22 | VCC / DATA / GND | 3V3 / GPIO 4 / GND | 10 kΩ pull-up DATA → 3V3 |
| Capacitive soil probe | AO / VCC / GND | GPIO 34 / 3V3 / GND | ADC1 only |
| LDR | AO / VCC / GND | GPIO 35 / 3V3 / GND | ADC1 only |
| MQ-135 | AO / VCC / GND | GPIO 32 / 5V / GND | 2–3 minute warm-up |
| PIR HC-SR501 | OUT / VCC / GND | GPIO 27 / 5V / GND | ~30 second warm-up |
| BMP280 (optional) | SDA / SCL / VCC | GPIO 21 / GPIO 22 / 3V3 | I2C |
| Battery divider (optional) | midpoint | GPIO 33 | 2:1 divider, max 4.2 V cell |
| Status LED | LED | GPIO 2 | Usually on-board |

> **Electrical safety:** ESP32 GPIOs accept **0–3.3 V only**. Never feed 5 V into a GPIO.
> Use GPIO 32–39 for analog inputs; ADC2 stops working while Wi-Fi is active. GPIO 34–39 are
> input-only and have no internal pull-ups.

### 8.3 Edit the sketch

Open:

```text
firmware/esp32-sensor-node/esp32-sensor-node.ino
```

Edit:

```cpp
const char *WIFI_SSID     = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SERVER_URL    = "https://YOUR-SERVICE.onrender.com/api/sensors";
const char *UPLOAD_TOKEN  = "SAME_VALUE_AS_RENDER";
const char *DEVICE_ID     = "ESP32-SENSOR-38P";
const uint32_t SEND_INTERVAL_MS = 2000;
```

Calibrate the soil probe:

```cpp
const int SOIL_DRY_RAW = 3200;   // probe in dry air
const int SOIL_WET_RAW = 1400;   // probe in a glass of water
```

Open Serial Monitor at 115200 and note the raw `analogRead(SOIL_PIN)` values to refine the
mapping. The sketch maps dry → 0 % and wet → 100 %.

Optional battery divider:

```cpp
const float BATTERY_DIVIDER = 2.0;
const float BATTERY_EMPTY_V = 3.30;
const float BATTERY_FULL_V  = 4.20;
```

If no divider is connected, the battery reading is omitted.

### 8.4 Upload

- **Board:** ESP32 Dev Module
- **Upload Speed:** 921600 (or 115200 if unstable)
- **Flash Size:** 4 MB
- **PSRAM:** Disabled (unless your board has it)

Hold **BOOT** if the board does not enter download mode automatically.

Expected serial output:

```text
[wifi] connected, IP=192.168.1.42 RSSI=-57 dBm
[relay] https://YOUR-SERVICE.onrender.com/api/sensors
[sensors] sending every 2000 ms
[sensors] packet #1 accepted (182 bytes)
```

### 8.5 Optional BMP280

1. Install **Adafruit BMP280**.
2. Change `#define USE_BMP280 0` to `1`.
3. The sketch tries address `0x76`; some modules use `0x77`.

---

## 9. Verify the deployment

1. Open:

   ```text
   https://YOUR-SERVICE.onrender.com
   ```

2. The camera badge changes from `OFF` to `LIVE` after the first frame arrives.
3. Real sensor values replace the simulated ones within two seconds.
4. Try each transport: **WebSocket**, **WebRTC**, **MJPEG**, **HTTP**.
5. With Metered configured the badge reads `TURN`; otherwise `STUN`.

Server checks:

```powershell
curl.exe https://YOUR-SERVICE.onrender.com/healthz
curl.exe https://YOUR-SERVICE.onrender.com/api/status
curl.exe https://YOUR-SERVICE.onrender.com/api/sensors/devices
curl.exe https://YOUR-SERVICE.onrender.com/api/rtc/config
```

Expected `/healthz` response:

```json
{ "ok": true, "camera": "live", "sensors": "live" }
```

(`demo` before hardware is connected.)

Run the full suites against production:

```powershell
node tools/e2e-check.js https://YOUR-SERVICE.onrender.com
node tools/webrtc-check.js https://YOUR-SERVICE.onrender.com
node tools/ui-check.js https://YOUR-SERVICE.onrender.com
```

---

## 10. Update the deployment

After local changes:

```powershell
git add .
git commit -m "Describe the change"
git push
```

Render redeploys automatically because `render.yaml` sets `autoDeploy: true`. You can also use
**Manual Deploy → Deploy latest commit** in the Render dashboard.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Dashboard stays on `OFF` / waiting | Camera cannot reach the relay | Check `SERVER_URL`, Serial Monitor, and Wi-Fi |
| Upload returns `401` | Token mismatch | Use the same `UPLOAD_TOKEN` in firmware and Render |
| Upload returns `400 Expected … bytes` | Wrong dimensions or format | Keep 320×240 and `rgb565be` or `rgb565le` |
| Colours swapped | RGB565 byte order | Flip `USE_RGB565_BIG_ENDIAN` |
| ESP32-CAM reboots randomly | Weak power supply | 5 V / 1 A, short thick wires, 470–1000 µF capacitor |
| `[camera] init failed: 0x105` | Camera not detected | Reseat the ribbon cable, check PSRAM and power |
| `GET /api/frame.jpg` returns 404 | No frame uploaded yet | Start the camera, or set `DEMO_FALLBACK=true` only for UI testing |
| WebRTC connects but no frames | No live frames or blocked network | Check `/api/status` and Metered configuration |
| TURN badge stays `STUN` | Metered not configured or credentials failed | Set `METERED_DOMAIN` + `METERED_API_KEY`, redeploy |
| Sensors show `--` | No packet received | Check the `/api/sensors` URL and JSON body |
| Render is slow on first request | Free plan spin-down | Wait a few seconds; clients reconnect automatically |
| Frames/history disappear after redeploy | In-memory storage | Expected; they return after the next upload/reading |
| `nan` temperature/humidity | DHT wiring or missing pull-up | Check GPIO 4 and the 10 kΩ resistor |
| MQ-135 never changes | Sensor not warmed up | Wait 2–3 minutes and confirm 5 V supply |

---

## 12. Security and cost notes

- **Set `UPLOAD_TOKEN`** before sharing the URL. Without it, anyone can post frames or readings.
- **Never commit `.env`.** Use Render environment variables.
- **Keep `METERED_API_KEY` server-side.** Browsers receive only short-lived ICE credentials.
- Tighten **`ALLOWED_ORIGINS`** to your own domain in production.
- Render provides TLS automatically. The firmware uses `setInsecure()` for convenience; for a
  strict production fleet, pin a root CA with `setCACert()`.
- **Render free plan** spins down after inactivity; the first request afterwards takes a few
  seconds.
- Frames and sensor history live **in memory only**. Restarting the service clears them until
  the next upload/reading.
- No database and no audio. Video only, and all vision filters run locally in the browser.

---

## Quick links

- Main overview and API summary: [`README.md`](../README.md)
- API reference: [`docs/API.md`](API.md)
- Hardware wiring and flashing: [`firmware/README.md`](../firmware/README.md)
- Arabic guide: [`docs/DEPLOY-AR.md`](DEPLOY-AR.md)
- Render: <https://dashboard.render.com/>
- Metered: <https://www.metered.ca/>
- GitHub: <https://github.com/new>
