# Make MIRSAD live — exact setup for your two folders

This is the end-to-end procedure for your setup. **Render is not used**; the relay runs on the
laptop and LiveKit Cloud carries the video to remote viewers.

| Part | Folder | Purpose |
| --- | --- | --- |
| Website + relay | `C:\Users\Alshuruq Comapny\OneDrive\Desktop\task_1` | Runs on the laptop, receives ESP32 uploads, converts RGB565 to JPEG, serves the dashboard |
| ESP32-CAM sketch | `C:\Users\Alshuruq Comapny\OneDrive\Desktop\fieldeye\esp32-live\firmware\CameraWebServer` | RHYX-M21-45 camera, 320×240 RGB565 |
| ESP32 sensor sketch | `C:\Users\Alshuruq Comapny\OneDrive\Desktop\fieldeye\esp32-live\firmware\sensors` | 38-pin ESP32 sensor node |

## What works right now (no hardware yet)

- The **relay laptop** opens the camera automatically. Allow the browser permission prompt once.
- All eight vision effects, mirror, grid, snapshot and the effect tour work on the webcam feed.
- Every other device is a **viewer**: it opens the dashboard and watches the same stream. It never
  asks for camera access and the camera buttons are hidden.
- On the same Wi-Fi, viewers watch through the relay (`http://LAPTOP-LAN-IP:3000`) using
  WebSocket, MJPEG, HTTP or WebRTC — no LiveKit account needed.
- The **sensor cards update every two seconds** from the built-in live simulator and show a `SIM`
  badge. The first real ESP32 packet switches them to `LIVE` permanently.
- **LiveKit Cloud** is optional and carries the laptop camera to viewers outside the LAN; the same
  room also carries sensor packets.

The camera and sensor boards only make **outbound requests** to the laptop. You do **not** need a
public IP or router changes while they are on the same Wi-Fi.

> Important: the relay and both sketches must use the **same LAN address** and the **same upload
> token**.

---

## Step 1 — Start the relay on the laptop

From PowerShell:

```powershell
cd "C:\Users\Alshuruq Comapny\OneDrive\Desktop\task_1"
copy .env.example .env
npm install
npm start
```

Open <http://localhost:3000>. The startup banner should show:

```text
  MIRSAD live relay
  ➜  http://localhost:3000
  ➜  demo signal     : ON
  ➜  LiveKit         : wss://… · room "live"
  ➜  sensors         : live simulator until ESP32 connects
```

If port 3000 is busy, stop the old Node process or set `PORT=3001` in `.env`.

### Set the upload token

Edit `.env`:

```env
UPLOAD_TOKEN=MIRSAD-2026-7f3c9a1e5b
```

Keep it secret; anyone with it can post frames/sensors. Viewers do **not** need it. The sketches
must send the same value. Leave it empty for a quick test on a trusted LAN (not recommended).

Restart the relay after every `.env` change.

---

## Step 2 — LiveKit Cloud (remote video)

1. Create a free project at <https://cloud.livekit.io/>.
2. Open **Settings → Keys** and copy the project **URL**, **API Key** and **API Secret**.
3. Put them in `.env`:

   ```env
   LIVEKIT_URL=wss://YOUR-PROJECT.livekit.cloud
   LIVEKIT_API_KEY=APIxxxxxxxxxxxx
   LIVEKIT_API_SECRET=your-real-secret
   LIVEKIT_ROOM=live
   ```

4. Restart the relay. The banner must no longer say `LiveKit : not configured`.
5. Verify:

   ```powershell
   curl.exe http://localhost:3000/api/livekit/config
   # → {"ok":true,"enabled":true,"url":"wss://…","room":"live","transport":"webrtc"}
   ```

### Publishing and viewing

- **Publisher (relay laptop only):** open <http://localhost:3000> and allow the camera prompt. The
  webcam appears in the canvas and is relayed to every viewer; keep this tab open. Switching the
  laptop's own preview to WebSocket/WebRTC/MJPEG does not stop the camera sharing.
- **Viewer on the same Wi-Fi:** open `http://LAPTOP-LAN-IP:3000` (for example
  `http://192.168.1.50:3000`). The dashboard plays the relay stream by default and never asks for
  camera access. Pick WebSocket, MJPEG or HTTP for the lowest-friction path.
- **Viewer outside the LAN:** open the dashboard and click **LiveKit**. The laptop's camera track
  appears in the same canvas with all effects, and sensor packets arrive on the room data channel.

> If you expose the relay through a tunnel (Cloudflare Tunnel, ngrok, …), keep the laptop on
> **http://localhost:3000** and share the tunnel URL with viewers. A public hostname is always
> treated as watch-only, so tunnel visitors never get a camera prompt even though the proxy
> connects to the relay from loopback.

The API secret stays on the laptop; browsers only receive short-lived join tokens from
`/api/livekit/token`. If the secret is missing, the laptop camera still works locally and on the
LAN, and the LiveKit mode shows a clear “not configured” message.

> LiveKit’s free tier is enough for a demo. No card is required to create the project.

---

## Step 3 — Find the laptop LAN address

The ESP32 boards cannot reach `localhost`. Run:

```powershell
ipconfig
```

Use the **IPv4 Address** of the Wi-Fi adapter, for example `192.168.1.50`. Test it from a phone on
the same Wi-Fi:

```text
http://192.168.1.50:3000/api/status
```

If Windows Firewall blocks it, allow Node.js on **Private networks** when prompted.

> Browsers only allow `getUserMedia` on `localhost` or HTTPS. That is fine here: only the relay
> laptop opens the camera. A phone opening `http://192.168.1.50:3000` is a viewer and watches the
> relay stream (WebSocket/MJPEG/HTTP) without any camera prompt. Use LiveKit for viewing outside
> the LAN, or put the relay behind HTTPS (for example Cloudflare Tunnel or ngrok) if you later want
> camera features on other devices.

---

## Step 4 — Verify the local server

Open these in a browser:

```text
http://localhost:3000/healthz
http://localhost:3000/api/status
http://localhost:3000/
```

Expected with no hardware yet:

```json
{
  "ok": true,
  "camera": { "source": "none" },
  "sensors": { "source": "demo", "demo": true }
}
```

The sensor values change every two seconds. The camera badge changes to `LIVE` as soon as the
laptop camera or the ESP32-CAM delivers frames.

---

## Step 5 — Flash the ESP32-CAM (RHYX-M21-45)

Use the FieldEye sketch you already have:

```text
C:\Users\Alshuruq Comapny\OneDrive\Desktop\fieldeye\esp32-live\firmware\CameraWebServer\CameraWebServer.ino
```

### 5.1 Edit the configuration block

```cpp
const char* serverUrl = "http://192.168.1.50:3000/api/upload-frame";
const char* apiKey    = "PASTE-THE-UPLOAD_TOKEN-HERE";
const char* deviceId  = "ESP32-CAM-01";
const bool USE_RGB565_BIG_ENDIAN = true;
const int TARGET_FPS = 4;
```

- `serverUrl` must end with `/api/upload-frame` and use the laptop LAN address.
- `apiKey` must exactly match `UPLOAD_TOKEN` in `.env` (or be empty if you removed it).
- If the sketch uses `WiFiClientSecure` / `secureClient`, either switch to plain `WiFiClient` for
  the LAN address, or expose the relay over HTTPS with a tunnel and use that URL.
- `USE_RGB565_BIG_ENDIAN`: keep `true` first. If skin looks blue and the sky orange, set it to
  `false`, re-upload, and set `FRAME_FORMAT=rgb565le` in `.env`.
- `TARGET_FPS`: 4 is reliable. Try 6–8 only on strong Wi-Fi.

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
[relay] http://192.168.1.50:3000/api/upload-frame?w=320&h=240&format=rgb565be&device=ESP32-CAM-01
```

There should be no repeated `Upload problem:` lines. `401` means the token does not match.
`400 Expected 153600 bytes` means the sketch is not sending 320×240 RGB565.

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
const char* SENSOR_URL  = "http://192.168.1.50:3000/api/sensors";
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

The first packet stops the simulator and the dashboard badge changes from `SIM` to `LIVE`.

---

## Step 7 — Confirm everything is live

1. Open <http://localhost:3000/> (or the LiveKit viewer on another device).
2. The camera badge changes from `OFF` to `LIVE` after the first frame.
3. Sensor values keep updating and the badge reads `LIVE` instead of `SIM`.
4. Check the JSON:

   ```powershell
   curl.exe http://localhost:3000/api/status
   curl.exe http://localhost:3000/api/sensors/latest
   curl.exe http://localhost:3000/api/sensors/devices
   ```

`/api/status` should show `"source": "live"` for both `camera` and `sensors`.

Local endpoints:

| URL | What it is |
| --- | --- |
| `http://localhost:3000/` | Full dashboard |
| `http://localhost:3000/api/frame.jpg` | Newest JPEG frame |
| `http://localhost:3000/api/stream.mjpeg` | Motion-JPEG stream |
| `http://localhost:3000/api/sensors/latest` | Newest sensor JSON |
| `http://localhost:3000/ws/frames` | WebSocket JPEG stream |
| `http://localhost:3000/api/livekit/config` | LiveKit availability |

Remote viewers should use the **LiveKit** button in the dashboard, not the MJPEG URL (the relay
is not exposed to the internet).

---

## Step 8 — Optional: enable Metered TURN

Only needed for the direct browser WebRTC mode on mobile/corporate networks. LiveKit already works
without it, and camera uploads never need TURN.

1. Create a free account at <https://www.metered.ca/>.
2. Create a TURN app and copy the **app domain** (for example `mirsad.metered.live`) and **API key**.
3. Add to `.env`:
   - `METERED_DOMAIN=mirsad.metered.live`
   - `METERED_API_KEY=...`
4. Restart the relay.
5. `http://localhost:3000/api/rtc/config` should show `"source":"metered"` and `"turn":true`.
   The dashboard pill changes from `STUN` to `TURN · Metered`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every visitor is asked for camera access | Everyone is being classified as the laptop (common with a tunnel/proxy forwarding from `127.0.0.1`) | Update and hard-refresh; open the laptop at `http://localhost:3000`, share the LAN/tunnel URL with viewers. Public hosts are watch-only |
| Laptop camera does not start | Browser blocked it | Allow camera permission on the relay laptop; use `localhost` or HTTPS there |
| `getUserMedia is not defined` on a phone | Phone is a viewer and should not open a camera | Nothing to fix: watch the relay stream. Use **LiveKit** for viewing outside the LAN |
| LiveKit mode says “not configured” | Secret missing/placeholder | Paste the real secret from LiveKit **Settings → Keys**, restart |
| Remote viewer stays black | Laptop is not publishing | Keep the laptop dashboard open with camera allowed; check `/api/livekit/config` reports `enabled: true` |
| Dashboard stays `OFF` after flashing | Camera cannot reach the relay | Use the laptop LAN IP, confirm `http://IP:3000/healthz`, check token |
| Serial `Upload problem: 401` | Token mismatch | Copy `UPLOAD_TOKEN` from `.env` into the sketch (both `X-Upload-Token` and `X-Api-Key` are accepted) |
| Serial `400 Expected 153600 bytes` | Old sketch / wrong format | Flash the updated sketch; it sends `w=320&h=240&format=rgb565be` |
| Serial `Upload problem: -1` / `-11` | Wi-Fi or TLS problem | Move closer to the router; use `http://` + `WiFiClient` on the LAN |
| Colours wrong (blue skin, orange sky) | RGB565 byte order | Set `USE_RGB565_BIG_ENDIAN = false` and `FRAME_FORMAT=rgb565le`, re-upload |
| Camera resets / brown-outs | Weak 5 V supply | Use 5 V / 1 A, short thick wires, add 470–1000 µF near 5 V/GND |
| `[camera] init failed: 0x105` | Camera not detected / PSRAM | Reseat ribbon cable; enable PSRAM; use Huge APP partition |
| Sensors show `--` | No packet | Check `/api/sensors` URL, token, JSON body, and Wi-Fi |
| Sensors stay on `SIM` after wiring | Simulator still delivering or packet rejected | Check `/api/sensors/devices`; the simulator stops on the first valid live packet |
| `nan` temperature/humidity | DHT wiring | Check GPIO 4 and the 10 kΩ pull-up; DHT22 needs 2 s between reads |
| Soil always 0 or 100 | Calibration | Adjust `SOIL_DRY_RAW` / `SOIL_WET_RAW` |
| ESP32 cannot reach the laptop | Windows Firewall | Allow Node.js on Private networks; confirm both devices are on the same Wi-Fi |

---

## If it is still not live, send me these

1. The laptop LAN address and `http://IP:3000/api/status` output.
2. The first 40 lines of the ESP32-CAM Serial Monitor at 115200.
3. The first 40 lines of the sensor node Serial Monitor.
4. The output of `http://localhost:3000/api/livekit/config`.
5. A screenshot of the dashboard.

With those items the remaining problem is almost always a URL/token typo, a 5 GHz Wi-Fi network,
or the camera not being in 320×240 RGB565 mode.
