# Live camera on the public website — exact setup

**Website:** <https://livestream-lemon-omega.vercel.app/>

The ESP32-CAM publishes **JPEG frames** to a public MQTT broker over TLS. The
website subscribes to the same topic over a secure WebSocket (WSS) and paints
the frames as they arrive. Video never passes through a Vercel function, so it
keeps working no matter how many serverless instances Vercel starts — and it
uses no Vercel invocations or bandwidth for the feed.

```
ESP32-CAM ──TLS 8883──► public.cloud.shiftr.io ◄──WSS 443── browser
```

No account, no public IP, no port forwarding, no token.

> **Important:** the firmware currently on the camera is the old HTTP uploader
> that posts to a dead tunnel (`Upload error: connection refused`). No website
> change can fix that, so the sketch has to be flashed **once**. After that,
> every power-on connects by itself.

---

## 1. Flash the camera (one time, ~1 minute)

Open this sketch in Arduino IDE:

```
C:\Users\Alshuruq Comapny\OneDrive\Desktop\CameraWebServer\CameraWebServer\CameraWebServer.ino
```

The repo contains the same firmware at:

```
firmware\esp32cam-wifimanager\esp32cam-wifimanager.ino   (WiFiManager portal)
firmware\esp32cam-streamer\esp32cam-streamer.ino          (Wi-Fi compiled in)
```

### Arduino IDE settings

| Setting | Value |
| --- | --- |
| Board | **AI Thinker ESP32-CAM** (or ESP32 Wrover Module) |
| PSRAM | **Enabled** |
| Partition Scheme | the sketch folder ships `partitions.csv`, so any scheme works (≥ 3 MB app) |
| Upload speed | 115200 (or 460800 if stable) |

### Libraries

**Nothing to install.** `PubSubClient.h` / `PubSubClient.cpp` are inside the same
sketch folder, and **WiFiManager** is already installed — the current firmware was
built with it.

If you ever move the sketch to a new computer, install **WiFiManager** by tzapu
from *Tools → Manage Libraries*.

### First boot

1. Connect `GPIO0` to `GND`, press `RST`, click **Upload**.
2. Remove `GPIO0` from `GND`, press `RST`, open the Serial Monitor at **115200**.
3. The board reuses the Wi-Fi it already saved (no portal, no password typing).
   You should see:

```text
[boot] MIRSAD camera v2 (MQTT)
[wifi] connected: 192.168.x.x
[mqtt] connecting to public.cloud.shiftr.io:8883 ... connected
[mqtt] topic: mirsad/live/a7f3c9e1d84b4f06b2a5
[mqtt] streaming to mirsad/live/a7f3c9e1d84b4f06b2a5
[stats] 15.0 fps, 118 KB/s, 0 dropped
```

4. Open the website. The camera pill turns **LIVE** within a few seconds.

> Only if the board has **no** saved Wi-Fi does it open the
> `ESP32-CAM-Config` hotspot. Join it, choose your network, and it starts
> streaming. Credentials are stored on the board afterwards.

---

## 2. What you should see on the website

- The live feed appears automatically after power-on.
- Closing the tab and opening it again reconnects by itself.
- If the camera loses power, the dashboard shows **Waiting for signal**.
- Power the camera back on and the feed returns without refreshing the page.
- The transport selector defaults to **MQTT**; WS/MJPEG/HTTP remain available
  for the local Node relay.

---

## 3. Change the broker or topic (optional)

Both sides must use the same values.

**Firmware** (`CameraWebServer.ino`):

```cpp
const char *MQTT_HOST = "public.cloud.shiftr.io";
const uint16_t MQTT_PORT = 8883;
const char *MQTT_USER = "public";
const char *MQTT_PASS = "public";
const char *MQTT_TOPIC = "mirsad/live/a7f3c9e1d84b4f06b2a5";
```

**Website** (`public/js/runtime.js`):

```js
export const BROKER = {
  url: 'wss://public.cloud.shiftr.io',
  topic: 'mirsad/live/a7f3c9e1d84b4f06b2a5',
  username: 'public',
  password: 'public',
};
```

You can also override the site without rebuilding by adding query parameters:

```text
https://livestream-lemon-omega.vercel.app/?broker=wss://broker.hivemq.com:8884/mqtt&topic=mirsad/live/YOUR_TOPIC
```

> The public broker is a shared demo service. Use a long random topic and do
> not send anything private.

---

## 4. Test without hardware

Publish synthetic frames from a computer:

```powershell
cd "C:\Users\Alshuruq Comapny\OneDrive\Desktop\task_1"
npm install
npm run sim:mqtt
```

The website should switch to **LIVE** and show a moving colour pattern.
Press `Ctrl+C` to stop the simulator; the dashboard returns to
**Waiting for signal**.

---

## 5. Local Node relay (optional)

The original server still works for LAN use and accepts raw RGB565 uploads:

```powershell
cd "C:\Users\Alshuruq Comapny\OneDrive\Desktop\task_1"
copy .env.example .env
npm install
npm start
```

Open <http://localhost:3000>. Use the **WS**, **MJPEG** or **HTTP** transport
buttons there. The firmware in this guide publishes over MQTT, so it does not
upload to the local relay; the old HTTP upload endpoint remains for other
clients and simulators.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Serial still shows `Upload error: connection refused` | The board is still running the old firmware. Flash `CameraWebServer.ino` again. |
| `[mqtt] failed (rc=-2)` | Broker unreachable: check Wi-Fi, or try `broker.hivemq.com:8883`. |
| `[mqtt] failed (rc=4/5)` | Wrong broker user/password (`public` / `public` on Shiftr). |
| Serial shows `frame too large` | Lower `JPEG_QUALITY` (e.g. 18) or raise `MQTT_BUFFER_BYTES` if PSRAM allows. |
| `[camera] init failed 0x105` | Reseat the camera ribbon cable and set PSRAM = **Enabled**. |
| Site says **Waiting for signal** | Serial must print `[stats] ... fps`. Topic must match on both sides. |
| Site says **MQTT broker unreachable** | The browser cannot reach the WSS URL; it falls back to HTTP polling. Try `?broker=wss://broker.hivemq.com:8884/mqtt`. |
| Feed is 1–2 fps | Weak Wi-Fi or thin 5 V supply. Move the camera closer to the router, lower `TARGET_FPS`. |
