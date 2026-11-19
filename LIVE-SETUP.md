# MIRSAD — live ESP32-CAM on the web, step by step

The camera has no public IP, so it **pushes** frames out to a relay. The relay
turns them into JPEG and hands them to every browser. Render serves the
dashboard *and* the API from the same process — there is no second host.

```text
ESP32-CAM (RHYX-M21-45)                    Render (Node relay)                  Browser
───────────────────────                    ───────────────────                  ───────
160x120 RGB565 → JPEG  ──WSS────▶ /ws/camera (primary)      ─WSS────▶    /ws/frames  (default)
~5 KB/frame (v7.1)               HTTP POST  POST /api/upload-frame    ─WebRTC─▶    /api/rtc/offer (data channel)
saved Wi-Fi, or config portal              /api/frame.jpg                      MJPEG, HTTP poll
                                           /stream.mjpeg                       filters, effects
                                           TURN credentials ← Metered (enabled)
```

No MQTT, no public broker, no port forwarding, no account on the camera side,
no separate static host, no CORS hop.

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `server/` + `public/` | **Render** (only service) | serves the dashboard, ingests frames, broadcasts WS / WebRTC / MJPEG |
| `firmware/esp32cam-wifimanager/` | ESP32-CAM | captures RGB565, compresses to JPEG on-device, streams over `/ws/camera` with HTTP POST fallback (v7) |
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

# the camera upload path (v5 sends JPEG; this tool sends raw RGB565 as fallback):
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

> **Already configured.** `server/config.js` ships working Metered defaults, so
> WebRTC works on this deployment without adding anything in Render. `/api/status`
> reports `"turn": true, "iceSource": "metered"`. The steps below are only for
> rotating to your own Metered app; environment variables always override the
> defaults.

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
relay returns short-lived TURN credentials. The server-side peer reorders those
credentials to prefer Metered's TCP/TLS relay (`turns:…:443?transport=tcp`)
over UDP, because a container host cannot rely on outbound UDP; the browser
still receives the original list. Verify:

```powershell
curl.exe -sS https://live-esp32-cam-stream.onrender.com/api/status
# "webrtc": { "available": true, "transport": "datachannel", "turn": true, "iceSource": "metered", ... }

curl.exe -sS https://live-esp32-cam-stream.onrender.com/api/rtc/config
# "source": "metered", "turn": true, "iceServers": [ ... ]
```

`iceSource: "stun"` means the variables are missing or Metered rejected the key
(the relay logs `[webrtc] Metered TURN unavailable (…)`). When it works, the
Render log shows the URL the server peer will use:

```text
[webrtc] Metered TURN ready (5 entries, server uses turns:global.relay.metered.ca:443?transport=tcp)
```

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

You can also set the network without the portal: open a serial monitor at
115200 baud and send `WIFI,<ssid>,<password>`. The board saves it, reboots,
and joins that network on any router.

Wi-Fi credentials are stored on the board. If the saved network is still in
range, no portal appears. If there is no saved network — or that network is
gone — the board opens `ESP32-CAM-Config` at `192.168.4.1` so you can pick
**any 2.4 GHz Wi-Fi** and enter its password. The camera then gets a normal
DHCP address on whichever network it joins, and always uploads to the public
Render hostname (`live-esp32-cam-stream.onrender.com`), never to a local IP.
You do **not** have to use `WEAO9A85`; choose whatever network you want.

---

## Step 4 — Confirm it works

Serial Monitor at `115200`:

```text
[boot] MIRSAD camera v7 (persistent WebSocket uplink)
[wifi] connected: 192.168.1.2
[ws] connected: /ws/camera?device=ESP32-CAM-RHYX (160x120)
[stats] 17.8 fps, 43 KB/s, 0 failed | cap=18 enc=29 post=8 ms
```

Then open <https://live-esp32-cam-stream.onrender.com>. `/api/status` shows the
truth:

```json
"camera": { "connected": true, "source": "live", "fps": 17.8, "width": 160, "height": 120, "jpegBytes": 3000, "transport": "ws" },
"webrtc": { "available": true, "turn": true, "iceSource": "metered" },
"config": { "jpegEncoder": "sharp" }
```

---

## Data cost (important on a MiFi)

v7.1 sends a 160×120 JPEG over one persistent WebSocket.
The relay passes it through unchanged, with no per-frame HTTP round trip. Quality
90 is stored in NVS and holds ~17 fps. Raw RGB565 can be selected with
`FORMAT,raw` (server-side sharp encoding) but is much slower on this board.
If the WebSocket is unavailable, the firmware falls back to the original HTTPS
POST path with on-device JPEG. Send `FORMAT,jpeg` over serial to use on-device
JPEG on the WebSocket too (lower bandwidth, slightly softer).

| Mode | Payload | notes |
| --- | --- | --- |
| v7.1 JPEG WS (default) | ~5 KB/frame | on-device JPEG at quality 90, ~17 fps |
| v7.1 `FORMAT,raw` | 38,400 B/frame | server-side sharp, sharper but only ~2.5 fps |
| POST fallback | ~5 KB/frame | HTTPS if the WebSocket cannot connect |

`JPEG_QUALITY` (default `90` for server-side raw encoding) trades size for sharpness; lowering it to 70
speeds up compression further but softens the picture. The relay still accepts
raw RGB565 from older sketches.

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
| Picture is a slideshow | camera capture + on-device JPEG encode is the limit (~0.5 fps) | lower `JPEG_QUALITY`/frame size and re-flash, or improve Wi-Fi signal |
| `[camera] init failed 0x106` / `JPEG format is not supported` | sensor has no hardware JPEG; only v5 works | flash v5 (`RGB565 -> software JPEG`) |
| `[camera] init failed 0x105` / `Camera probe failed` | camera ribbon cable loose | unplug USB, reseat ribbon, power-cycle |
| WebSocket never connects, HTTP works | a proxy in front of the relay buffers WS | the dashboard falls back to polling automatically |
| WebRTC connects but no picture | no camera frames reaching the relay, or no TURN | check `/api/status` camera first, then `/api/rtc/config` |
| `Upload error: connection refused` in the log | still the **old** firmware | flash v5 — see `[boot] MIRSAD camera v5` |

---

## Optional, later

- **Upload token** — Render → Environment → `UPLOAD_TOKEN`, same string in the
  sketch. Rebuild and re-flash.
- **Sensors** — `firmware/esp32-sensor-node` POSTs JSON to `/api/sensors`;
  `node tools/simulate-sensors.js` fakes it.
