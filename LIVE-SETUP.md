# Make MIRSAD live — exact setup for your two folders

This is the end-to-end procedure for your setup:

| Part | Folder | Purpose |
| --- | --- | --- |
| Website + relay | `C:\Users\Alshuruq Comapny\OneDrive\Desktop\task_1` | Public Render site, receives ESP32 uploads, converts RGB565 to JPEG, serves the dashboard |
| ESP32-CAM sketch | `C:\Users\Alshuruq Comapny\OneDrive\Desktop\fieldeye\esp32-live\firmware\CameraWebServer` | RHYX-M21-45 camera, 320×240 RGB565 |
| ESP32 sensor sketch | `C:\Users\Alshuruq Comapny\OneDrive\Desktop\fieldeye\esp32-live\firmware\sensors` | 38-pin ESP32 sensor node |

The camera and sensor boards only make **outbound HTTPS requests**. You do **not** need a public
IP, port forwarding or router changes. The Render site is public for viewers.

> Important: the website and both sketches must point to the **same Render address** and use the
> **same upload token**.

---

## What was already fixed in the code

- The relay now accepts **both** `X-Upload-Token` (MIRSAD sketches) and `X-Api-Key` (original
  FieldEye sketches), plus `Authorization: Bearer ...`, `?token=` and `?apiKey=`.
- The FieldEye camera sketch now sends `w`, `h`, `format` and `device` query parameters, so the
  server never has to guess the frame layout.
- The FieldEye sensor sketch now sends `X-Upload-Token`, a `deviceId`, and a nested `readings`
  object that the dashboard understands.
- The default byte order is now `rgb565be` everywhere (correct for the RHYX-M21-45 / OV2640).
- MJPEG now paints the newest frame immediately instead of waiting for the next upload.
- The dashboard marks sensors `OFF` after 12 seconds without a packet instead of leaving stale
  numbers labelled `LIVE`.
- FieldEye-compatible aliases exist (`GET /api/sensors`, `GET /api/ice`,
  `POST /api/webrtc/offer`, `WS /ws`) so either frontend can talk to this relay.

---

## Step 1 — Push the website code to GitHub

The repository already exists and has an `origin` remote. From the `task_1` folder:

```powershell
cd "C:\Users\Alshuruq Comapny\OneDrive\Desktop\task_1"
git status
git add .
git commit -m "Make camera and sensors live; FieldEye firmware compatibility"
git push
```

If the push asks for credentials, sign in to GitHub when prompted. Never commit `.env`.

---

## Step 2 — Deploy the website on Render

1. Open <https://render.com> and sign in with GitHub.
2. **New +** → **Blueprint**.
3. Select the repository that contains `task_1` (`TasneemHazem10/live-ESP32-cam-stream`).
4. Render reads `render.yaml` and shows the **mirsad-live** service. Click **Apply**.
5. Wait for the build (`npm ci`) and deploy (`npm start`). The health check is `/healthz`.
6. Copy the public address shown at the top. It looks like:

   ```text
   https://mirsad-live.onrender.com
   ```

   If that name is already taken, Render gives you a different name. Use **your** address in
   every step below.

> Free plan: the service sleeps after about 15 minutes without traffic and takes 30–60 seconds
> to wake. The ESP32 retries automatically, and the page reconnects. For 24/7 operation use the
> paid Starter plan.

### Manual service instead of Blueprint

If the Blueprint does not work, create a **New + → Web Service** with:

- Runtime: **Node**
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/healthz`
- Environment: `NODE_VERSION=22`, `DEMO_FALLBACK=false`, `UPLOAD_TOKEN=<your secret>`

---

## Step 3 — Set the upload token

`render.yaml` asks Render to generate a random `UPLOAD_TOKEN`. The ESP32s must send the same value.

1. Render Dashboard → **mirsad-live** → **Environment**.
2. Find `UPLOAD_TOKEN` and copy its value (click the eye icon to reveal it).
3. Keep it secret. Anyone with the token can upload frames/sensors. Viewers do **not** need it.

If you prefer a simpler token, replace the generated value with your own long random text, for
example:

```text
MIRSAD-2026-7f3c9a1e5b
```

Then use that exact text as `apiKey` / `API_KEY` in the sketches.

If you want no token at all (not recommended for a public site), set `UPLOAD_TOKEN` to an empty
value in Render. The sketches can then leave `apiKey` empty.

---

## Step 4 — Verify the public server

Open these in a browser after the deploy is **Live**:

```text
https://YOUR-SERVICE.onrender.com/healthz
https://YOUR-SERVICE.onrender.com/api/status
https://YOUR-SERVICE.onrender.com/
```

Expected before any hardware connects:

```json
{ "ok": true, "camera": "none", "sensors": "none" }
```

The dashboard shows `OFF` and a “waiting for camera” panel. This is correct until the ESP32-CAM
sends its first frame.

---

## Step 5 — Flash the ESP32-CAM (RHYX-M21-45)

Use the FieldEye sketch you already have:

```text
C:\Users\Alshuruq Comapny\OneDrive\Desktop\fieldeye\esp32-live\firmware\CameraWebServer\CameraWebServer.ino
```

### 5.1 Edit the configuration block

```cpp
const char* serverUrl = "https://YOUR-SERVICE.onrender.com/api/upload-frame";
const char* apiKey    = "PASTE-THE-UPLOAD_TOKEN-HERE";
const char* deviceId  = "ESP32-CAM-01";
const bool USE_RGB565_BIG_ENDIAN = true;
const int TARGET_FPS = 4;
```

- `serverUrl` must end with `/api/upload-frame`.
- `apiKey` must exactly match Render's `UPLOAD_TOKEN` (or be empty if you removed it).
- `USE_RGB565_BIG_ENDIAN`: keep `true` first. If skin looks blue and the sky orange, set it to
  `false`, re-upload, and set Render `FRAME_FORMAT=rgb565le` if you want it to survive restarts.
- `TARGET_FPS`: 4 is reliable over TLS. Try 6–8 only on strong Wi-Fi.

### 5.2 Arduino IDE settings

- Board: **ESP32 Wrover Module** (or **AI Thinker ESP32-CAM**)
- PSRAM: **Enabled**
- Partition Scheme: **Huge APP (3MB No OTA)**
- Upload speed: **115200**
- CPU frequency: **240 MHz**
- Flash frequency: **40 MHz**
- Libraries: **WiFiManager by tzapu** (Library Manager). `esp_camera.h` is included with the
  ESP32 board package.

### 5.3 Wiring the USB-TTL programmer

| USB-TTL | ESP32-CAM |
| --- | --- |
| 5V | 5V (use a stable 5 V / 1 A supply) |
| GND | GND |
| TX | U0RXD (GPIO 3) |
| RX | U0TXD (GPIO 1) |
| — | GPIO 0 → GND **only while uploading** |

### 5.4 Upload sequence

1. Connect `GPIO 0` to `GND`.
2. Press **RST** once.
3. Click **Upload** in Arduino IDE.
4. When it finishes, remove the `GPIO 0` jumper and press **RST**.
5. Open **Serial Monitor** at **115200**.

### 5.5 Join Wi-Fi

On first boot the board opens the network **`ESP32-CAM-Config`**:

1. Join it from your phone or laptop.
2. Choose your **2.4 GHz** home Wi-Fi and enter the password.
3. Wait for the portal to close. The board remembers the network.

The ESP32-CAM does **not** support 5 GHz-only networks.

### 5.6 Expected Serial Monitor output

```text
WiFi connected: 192.168.1.42
[relay] https://YOUR-SERVICE.onrender.com/api/upload-frame?w=320&h=240&format=rgb565be&device=ESP32-CAM-01
```

There should be no repeated `Upload problem:` lines. If you see `Upload problem: 401`, the token
does not match. If you see `400 Expected 153600 bytes`, you flashed an old sketch that is not
sending 320×240 RGB565.

---

## Step 6 — Flash the 38-pin ESP32 sensor node

Use the FieldEye sensor sketch:

```text
C:\Users\Alshuruq Comapny\OneDrive\Desktop\fieldeye\esp32-live\firmware\sensors\sensors.ino
```

### 6.1 Edit the configuration block

```cpp
const char* WIFI_SSID   = "YOUR_WIFI_NAME";
const char* WIFI_PASS   = "YOUR_WIFI_PASSWORD";
const char* SENSOR_URL  = "https://YOUR-SERVICE.onrender.com/api/sensors";
const char* API_KEY     = "PASTE-THE-UPLOAD_TOKEN-HERE";
const char* DEVICE_ID   = "ESP32-SENSOR-38P";
```

`SENSOR_URL` must end with `/api/sensors`.

### 6.2 Libraries and board

- Install **DHT sensor library** by Adafruit and **Adafruit Unified Sensor**.
- Board: **ESP32 Dev Module**
- Upload speed: **921600** (or 115200 if unstable)
- Flash size: **4 MB**

### 6.3 Wiring

| Sensor | Sensor pin | ESP32 38-pin |
| --- | --- | --- |
| DHT22 / AM2302 | VCC / DATA / GND | 3V3 / GPIO 4 / GND (10 kΩ pull-up DATA→3V3) |
| Capacitive soil probe | AO / VCC / GND | GPIO 34 / 3V3 / GND |
| LDR module | AO / VCC / GND | GPIO 35 / 3V3 / GND |
| Water level sensor | AO / VCC / GND | GPIO 32 / 3V3 / GND |
| PIR HC-SR501 | OUT / VCC / GND | GPIO 27 / 5V / GND |
| Optional battery divider | midpoint | GPIO 33 (2:1 divider, max 4.2 V) |

> Use **ADC1 pins only** (GPIO 32–39) for analog sensors. ADC2 stops working while Wi-Fi is on.
> Never feed 5 V into an ESP32 GPIO. Connect all grounds together.

### 6.4 Expected Serial Monitor output

```text
IP 192.168.1.43
{"deviceId":"ESP32-SENSOR-38P","readings":{"temperature":26.4,"humidity":58.0,...}} -> 200
```

The dashboard should fill the sensor cards within 2–3 seconds.

---

## Step 7 — Confirm everything is live

1. Open `https://YOUR-SERVICE.onrender.com/`.
2. The camera badge changes from `OFF` to `LIVE` after the first frame.
3. Sensor values replace `--` within a few seconds.
4. Check the JSON:

```powershell
curl.exe https://YOUR-SERVICE.onrender.com/api/status
curl.exe https://YOUR-SERVICE.onrender.com/api/sensors/latest
curl.exe https://YOUR-SERVICE.onrender.com/api/sensors/devices
```

`/api/status` should show `"source": "live"` for both `camera` and `sensors`.

Public endpoints you can share or embed:

| URL | What it is |
| --- | --- |
| `https://YOUR-SERVICE.onrender.com/` | Full public dashboard |
| `https://YOUR-SERVICE.onrender.com/api/frame.jpg` | Newest JPEG frame |
| `https://YOUR-SERVICE.onrender.com/api/stream.mjpeg` | Motion-JPEG stream |
| `https://YOUR-SERVICE.onrender.com/api/sensors/latest` | Newest sensor JSON |
| `https://YOUR-SERVICE.onrender.com/ws/frames` | WebSocket JPEG stream |

Minimal public embed:

```html
<img src="https://YOUR-SERVICE.onrender.com/api/stream.mjpeg" alt="Live camera" />
```

---

## Step 8 — Optional: enable WebRTC / TURN

The site is already live over WebSocket/MJPEG without this. Do it only if you want the “WebRTC”
transport to work on mobile/corporate networks.

1. Create a free account at <https://www.metered.ca/>.
2. Create a TURN app and copy the **app domain** (for example `mirsad.metered.live`) and **API key**.
3. Render → **Environment** → add:
   - `METERED_DOMAIN=mirsad.metered.live`
   - `METERED_API_KEY=...`
4. Redeploy/restart.
5. `https://YOUR-SERVICE.onrender.com/api/rtc/config` should show `"source":"metered"` and
   `"turn":true`. The dashboard pill changes from `STUN` to `TURN · Metered`.

The camera upload never needs TURN.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Dashboard stays `OFF` | Camera cannot reach the relay | Check Serial Monitor; URL must be `https://.../api/upload-frame`; check token |
| Serial `Upload problem: 401` | Token mismatch | Copy Render `UPLOAD_TOKEN` into `apiKey` (both `X-Upload-Token` and `X-Api-Key` are accepted) |
| Serial `400 Expected 153600 bytes` | Old sketch / wrong format | Flash the updated sketch; it sends `w=320&h=240&format=rgb565be` |
| Serial `Upload problem: -1` / `-11` | Wi-Fi/TLS or Render cold start | Move closer to router; wait 60 s; the sketch retries |
| Colours wrong (blue skin, orange sky) | RGB565 byte order | Set `USE_RGB565_BIG_ENDIAN = false` in the sketch, re-upload |
| Camera resets / brown-outs | Weak 5 V supply | Use 5 V / 1 A, short thick wires, add 470–1000 µF near 5 V/GND |
| `[camera] init failed: 0x105` | Camera not detected / PSRAM | Reseat ribbon cable; enable PSRAM; use Huge APP partition |
| Sensors show `--` | No packet | Check `/api/sensors` URL, token, JSON body, and Wi-Fi |
| Sensor values stop updating | Board offline | After 12 s the dashboard now marks the cards `OFF`; check Serial Monitor |
| `nan` temperature/humidity | DHT wiring | Check GPIO 4 and the 10 kΩ pull-up; DHT22 needs 2 s between reads |
| Soil always 0 or 100 | Calibration | Adjust `SOIL_DRY_RAW` / `SOIL_WET_RAW` |
| Free Render service sleeps | Free plan | Wait 30–60 s for wake-up, or use the Starter plan |
| `/api/status` shows a different site | Two deployments | Make sure `serverUrl` and `SENSOR_URL` use the **same** Render address as the page you open |

---

## If it is still not live, send me these

1. Your exact Render URL.
2. The first 40 lines of the ESP32-CAM Serial Monitor at 115200.
3. The first 40 lines of the sensor node Serial Monitor.
4. The output of `https://YOUR-SERVICE.onrender.com/api/status`.
5. A screenshot of the dashboard.

With those five items the remaining problem is almost always a URL/token typo, a 5 GHz Wi-Fi
network, or the camera not being in 320×240 RGB565 mode.
