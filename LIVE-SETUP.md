# MIRSAD — live ESP32-CAM on the web, step by step

The camera has no public IP, so it **pushes** frames out to a relay. The relay
turns them into JPEG and hands them to every browser. Render serves the
dashboard *and* the API from the same process — there is no second host.

```text
ESP32-CAM (RHYX-M21-45)                    Render (Node relay)                  Browser
───────────────────────                    ───────────────────                  ───────
320x240 RGB565, 153,600 B/frame  ─HTTPS──▶ POST /api/upload-frame   ─WSS────▶    /ws/frames  (default)
5 fps by default                 POST      RGB565 → JPEG (sharp)    ─WebRTC─▶    /api/rtc/offer (data channel)
saved Wi-Fi, no captive portal             /api/frame.jpg                      MJPEG, HTTP poll
                                           /stream.mjpeg                       filters, effects
                                           TURN credentials ← Metered
```

No MQTT, no public broker, no port forwarding, no account on the camera side,
no separate static host, no CORS hop.

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `server/` + `public/` | **Render** (only service) | serves the dashboard, ingests frames, encodes JPEG, broadcasts WS / WebRTC / MJPEG |
| `firmware/esp32cam-wifimanager/` | ESP32-CAM | captures and POSTs raw RGB565 |
| `tools/` | your PC | build, flash, simulate, verify |

The dashboard and the API share an origin, so `public/js/env.js` is empty:

```js
window.MIRSAD_API_BASE = '';   // same origin — nothing to configure
```

> **Already deployed:** `https://live-esp32-cam-stream.onrender.com`
> (Render service `srv-dbqbd70m7kps73d2bhtg`).
> Steps 1–2 are kept for reference / redeployment.

---

## Step 1 — Deploy (or redeploy) the relay to Render

1. Open <https://render.com> → **New +** → **Blueprint**.
2. Pick `github.com/TasneemHazem10/live-ESP32-cam-stream`. Render finds
   `render.yaml` automatically.
3. **Apply**. The badge turns **Live** in 2–3 minutes. Pushes to `main`
   redeploy automatically.
4. The service URL is what the firmware and the browser use.

Notes:

- Free plan: 0.1 vCPU, sleeps after ~15 min without traffic. The firmware pings
  `/healthz` first, so a cold start costs one wait of up to 60 s.
- `sharp` ships a prebuilt libvips binary for Render's Linux image, so no build
  flags are needed. `/api/status` reports which encoder is active:
  `config.jpegEncoder` must say `"sharp"` (fallback would be `"jpeg-js"`,
  roughly 10–100× slower).
- `UPLOAD_TOKEN` is empty in `render.yaml` on purpose. Setting it locks the
  upload endpoint to your camera, but the same string must then be flashed into
  the sketch.

### Check it without any hardware

```powershell
$env:SERVER_URL = "https://live-esp32-cam-stream.onrender.com"

# the exact request the firmware makes (153,600-byte RGB565):
node tools/esp-post-check.js        # or: npm run test:ingest

# continuous synthetic stream in another terminal:
$env:SERVER_URL = "https://live-esp32-cam-stream.onrender.com"; node tools/simulate-camera.js

# headless Chrome opens the deployed page and proves it paints live frames:
npm run test:prod
```

`esp-post-check.js` prints `PASS` and eight colour bars when the upload path,
byte order and JPEG encoding are all correct.

---

## Step 2 — WebRTC + Metered TURN (required for WebRTC on Render)

The relay already speaks WebRTC: `POST /api/rtc/offer` creates a werift peer
per browser and pushes each JPEG over an SCTP **data channel** (frame header +
JPEG bytes). No audio/video tracks — the camera has no mic and no speaker.

**TURN is not optional on Render.** The service only exposes HTTP/HTTPS through
Render's proxy; no public UDP port exists for ICE, so a direct peer-to-peer
connection cannot complete. With Metered configured, both peers connect
outbound to the TURN relay and the data channel works. Without it, the
dashboard's WebRTC mode times out after 20 s and falls back to WebSocket.
(The camera upload itself never uses TURN.)

1. Sign up at <https://www.metered.ca/stun-turn> (free tier) and create an app.
2. Copy the app **subdomain** (e.g. `myapp.metered.live`) and the **API key**.
3. Render → your service → **Environment** → add:

   | Key | Value |
   | --- | --- |
   | `METERED_DOMAIN` | `myapp.metered.live` (host only — no `https://`) |
   | `METERED_API_KEY` | the app API key |
   | `METERED_REGION` | optional, e.g. `eu` |
   | `METERED_TTL_MS` | optional, credential cache time, default `1800000` |

4. Save → Render restarts the service.

The API key stays server-side: browsers call `GET /api/rtc/config`, and the
relay returns short-lived TURN credentials. Verify:

```powershell
curl.exe -sS https://live-esp32-cam-stream.onrender.com/api/status
# "webrtc": { "available": true, "transport": "datachannel", "turn": true, "iceSource": "metered", ... }

curl.exe -sS https://live-esp32-cam-stream.onrender.com/api/rtc/config
# "source": "metered", "turn": true, "iceServers": [ ... ]
```

`iceSource: "stun"` means the variables are missing or Metered rejected the key
(the relay logs `[webrtc] Metered TURN unavailable (…)`).

Transport selection is automatic: the dashboard tries the configured mode
(default **WebSocket**) and falls back to the next one if frames do not arrive.
You can force WebRTC with `?mode=webrtc` or the transport switcher in the UI.
Because Render has no public UDP port, WebRTC needs the Metered variables
above; without them it falls back to WebSocket after its 20 s frame timeout.

Test WebRTC without a browser camera:

```powershell
npm run test:webrtc
```

---

## Step 3 — Flash the camera *(one time)*

`SERVER_HOST` in the sketch must be the Render host **without** `https://`:

```cpp
#define SERVER_HOST "live-esp32-cam-stream.onrender.com"
```

Then either:

**A. Browser (no Arduino IDE)** — serve the prebuilt image:

```powershell
powershell -File tools/build-firmware.ps1   # compiles + fills public/firmware/
```

Commit + push, open
`https://live-esp32-cam-stream.onrender.com/flash.html` in Chrome/Edge on the
computer with the USB-TTL adapter, press **Install firmware**.

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

Then open <https://live-esp32-cam-stream.onrender.com>. `/api/status` shows the
truth:

```json
"camera": { "connected": true, "source": "live", "fps": 4.8, "width": 320, "height": 240 },
"config": { "jpegEncoder": "sharp" }
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
| `[post] failed: connection refused` / `-1` | wrong `SERVER_HOST`, or Render is asleep | check the host, wait 60 s, reload `/healthz` |
| `[post] server said HTTP 404` | path changed | must be `POST /api/upload-frame` |
| `[post] server said HTTP 401` | `UPLOAD_TOKEN` set on Render but not in the sketch | set the same token in the sketch, or clear it in Render |
| Site says "waiting" but `/api/status` shows fps | browser cached an old page | hard reload; `env.js` must be `''` |
| `jpegEncoder` is `jpeg-js` | sharp failed to load on the host | check the deploy log; `npm ci` must install `sharp` for linux-x64 |
| Image is blue where it should be red | byte order | send `?format=rgb565be` instead of `rgb565le` |
| Picture is a slideshow | RGB565 is large; TLS upload dominates | lower resolution or use JPEG mode |
| WebSocket never connects, HTTP works | a proxy in front of the relay buffers WS | the dashboard falls back to polling automatically |
| WebRTC connects but no picture | no TURN, or the data channel never opened | set the Metered variables; check `/api/rtc/config` |
| `Upload error: connection refused` in the log | still the **old** firmware | flash v3 — see `[boot] MIRSAD camera v3` |

---

## Optional, later

- **Upload token** — Render → Environment → `UPLOAD_TOKEN`, same string in the
  sketch. Rebuild and re-flash.
- **Sensors** — `firmware/esp32-sensor-node` POSTs JSON to `/api/sensors`;
  `node tools/simulate-sensors.js` fakes it.
