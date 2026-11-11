# MIRSAD — live ESP32-CAM on the web, step by step

The camera has no public IP, so it **pushes** frames out to a relay. The relay
turns them into JPEG and hands them to every browser.

```text
ESP32-CAM (RHYX-M21-45)                       Render (Node relay)                 Browser
───────────────────────                       ───────────────────                 ───────
320x240 RGB565, 153,600 B/frame   ──HTTPS──▶  POST /api/upload-frame   ──WSS──▶   /ws/frames
5 fps by default                  POST       RGB565 → JPEG (jpeg-js)             MJPEG, HTTP poll
saved Wi-Fi, no captive portal               /api/frame.jpg, /stream.mjpeg       filters, effects
```

No MQTT, no public broker, no port forwarding, no account on the camera side.

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `public/` | **Vercel** (static) | the dashboard — visual only, no state |
| `server/` | **Render** (Node) | ingests frames, encodes JPEG, broadcasts WS/MJPEG |
| `firmware/esp32cam-wifimanager/` | ESP32-CAM | captures and POSTs raw RGB565 |
| `tools/` | your PC | build, flash, simulate, verify |

The browser needs to know one thing: the relay's URL. That is
`public/js/env.js` → `window.MIRSAD_API_BASE`.

> **This project is already deployed:**
> - relay → `https://live-esp32-cam-stream.onrender.com` (Render service `srv-dbqbd70m7kps73d2bhtg`)
> - dashboard → `https://livestream-lemon-omega.vercel.app`
> - firmware → built with `SERVER_HOST "live-esp32-cam-stream.onrender.com"`
>
> Steps 1 and 2 below are already done and are kept for reference / redeployment.

---

## Step 1 — Deploy the relay to Render  *(you do this, ~5 minutes)*

1. Open <https://render.com> → **Get Started** → sign up **with GitHub**.
2. Authorise Render to read the repo
   `github.com/TasneemHazem10/live-ESP32-cam-stream`.
3. Click **New +** → **Blueprint**.
4. Pick the repo → **Connect**. Render finds `render.yaml` by itself.
5. Click **Apply** / **Create**. Wait until the badge says **Live** (2–3 min).
6. Copy the URL at the top of the service page:

   ```text
   https://live-esp32-cam-stream.onrender.com
   ```

**Send that URL back** so it can be baked into the site and the firmware.

Notes:

- The free plan sleeps after ~15 minutes of no traffic. The camera posting every
  200 ms keeps it awake; after a sleep the first request takes 30–60 s, which is
  why the firmware pings `/healthz` before streaming.
- `UPLOAD_TOKEN` is empty in `render.yaml` on purpose. Set it in
  **Dashboard → Environment** later to lock the endpoint to your camera.

### Check it without any hardware

```powershell
$env:SERVER_URL = "https://live-esp32-cam-stream.onrender.com"

# the exact request the firmware makes (153,600-byte RGB565):
node tools/esp-post-check.js

# continuous synthetic stream, then open the site:
$env:SERVER_URL = "https://live-esp32-cam-stream.onrender.com"; node tools/simulate-camera.js
```

`esp-post-check.js` prints `PASS` and eight colour bars when the upload path,
byte order and JPEG encoding are all correct.

---

## Step 2 — Point the website at the relay  *(one line)*

Edit `public/js/env.js`:

```js
window.MIRSAD_API_BASE = 'https://live-esp32-cam-stream.onrender.com';
```

Commit + push, or test instantly without touching code by adding the parameter:

```text
https://livestream-lemon-omega.vercel.app/?api=https://live-esp32-cam-stream.onrender.com
```

`https://livestream-lemon-omega.vercel.app/` alone (no `?api=`) talks to its own
origin, which has no relay — it will sit on "waiting for camera".

---

## Step 3 — Flash the camera  *(one time)*

`SERVER_HOST` in the sketch must be the Render host **without** `https://`:

```cpp
#define SERVER_HOST "live-esp32-cam-stream.onrender.com"
```

Then either:

**A. Browser (no Arduino IDE)** — serve the prebuilt image:

```powershell
powershell -File tools/build-firmware.ps1   # compiles + fills public/firmware/
```

Commit + push, open `https://livestream-lemon-omega.vercel.app/flash.html` in
Chrome/Edge on the computer with the USB-TTL adapter, press **Install firmware**.

Wiring — `5V→5V`, `GND→GND`, `TX→U0RXD`, `RX→U0TXD`, `GPIO0→GND`, tap `RST`.

**B. Arduino IDE** — open `firmware/esp32cam-wifimanager/esp32cam-wifimanager.ino`,
board **AI Thinker ESP32-CAM**, **PSRAM: Enabled**, then Upload.

When it finishes: remove `GPIO0` from `GND`, tap `RST`.

The Wi-Fi already stored on the board is kept, so there is no captive portal and
no password to type.

---

## Step 4 — Confirm it works

Serial Monitor at `115200`:

```text
[boot] MIRSAD camera v3 (HTTP RGB565)
[wifi] connected: 192.168.1.24
[relay] https://live-esp32-cam-stream.onrender.com:443/api/upload-frame?w=320&h=240&format=rgb565le&device=ESP32-CAM-RHYX
[relay] awake (HTTP 200)
[post] first frame accepted by the relay
[stats] 4.8 fps, 720 KB/s, 0 failed
```

Then open the dashboard. `https://…/api/status` shows the truth:

```json
"camera": { "connected": true, "source": "live", "fps": 4.8, "width": 320, "height": 240 }
```

---

## Data cost (important on a MiFi)

Raw RGB565 is 153,600 bytes per frame — about 20× a JPEG.

| `TARGET_FPS` | Upload | Per hour |
| --- | --- | --- |
| 2 | 300 KB/s | ~1.1 GB |
| 5 (default) | 750 KB/s | ~2.7 GB |
| 10 | 1.5 MB/s | ~5.4 GB |

Change `TARGET_FPS` in the sketch and re-flash if that is too much. The relay
also accepts hardware JPEG (`?format=jpeg`) at ~8 KB/frame if the module turns
out to support it.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `[post] failed: connection refused` / `-1` | wrong `SERVER_HOST`, or the Render service is asleep | check the host, wait 60 s, reload `/healthz` in a browser |
| `[post] server said HTTP 404` | path changed | must be `POST /api/upload-frame` |
| `[post] server said HTTP 401` | `UPLOAD_TOKEN` set on Render but not in the sketch | set the same token in the sketch, or clear it in Render |
| Site says "waiting" but `/api/status` shows fps | browser pointed at the wrong relay | set `window.MIRSAD_API_BASE` or use `?api=` |
| Image is blue where it should be red | byte order | send `?format=rgb565be` instead of `rgb565le` |
| Picture is a slideshow | RGB565 is large; TLS upload dominates | lower resolution or use JPEG mode |
| WebSocket never connects, HTTP works | a proxy in front of the relay buffers WS | the dashboard falls back to polling automatically |
| `Upload error: connection refused` in the log | still the **old** firmware | flash v3 — see `[boot] MIRSAD camera v3` |

---

## Optional, later

- **Upload token** — Render → Environment → `UPLOAD_TOKEN`, same string in the
  sketch. Rebuild and re-flash.
- **WebRTC** — the relay already exposes `/api/rtc/offer` (werift, data channel).
  Add `METERED_DOMAIN` + `METERED_API_KEY` in Render → Environment so browsers
  behind symmetric NAT get TURN. No firmware change.
- **Sensors** — `firmware/esp32-sensor-node` POSTs JSON to `/api/sensors`;
  `node tools/simulate-sensors.js` fakes it.
