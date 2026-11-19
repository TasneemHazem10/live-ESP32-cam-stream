# MIRSAD firmware guide

Two Arduino sketches:

| Sketch | Board | Purpose |
| --- | --- | --- |
| [`esp32cam-wifimanager/esp32cam-wifimanager.ino`](esp32cam-wifimanager/esp32cam-wifimanager.ino) | AI-Thinker ESP32-CAM + RHYX-M21-45 2 MP | v5: capture 320×240 RGB565, compress to **JPEG on-device**, POST it (~8–13 KB/frame); any 2.4 GHz Wi‑Fi via serial command or portal |
| [`esp32-sensor-node/esp32-sensor-node.ino`](esp32-sensor-node/esp32-sensor-node.ino) | ESP32 DevKit 38-pin (ESP32-WROOM-32) | Read sensors and POST JSON every 2 s |

Both boards only make **outbound** connections — no public IP, no port forwarding, no broker
account. The camera POSTs JPEG frames to the relay on Render, which passes them through and
pushes them to the dashboard:

```text
ESP32-CAM  --HTTPS POST /api/upload-frame-->  Render relay  --WSS /ws/frames-->  browser
```

> The relay accepts `X-Upload-Token` and `X-Api-Key`, plus `Authorization: Bearer ...`,
> `?token=` and `?apiKey=`. For the complete deployment walkthrough for this exact project, see
> [`../LIVE-SETUP.md`](../LIVE-SETUP.md).

---

## 1. Arduino IDE setup

1. Install the current Arduino IDE.
2. Open **File → Preferences → Additional Boards Manager URLs** and add:
   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. Open **Tools → Board → Boards Manager**, search for **esp32**, and install
   **ESP32 by Espressif Systems** (3.x recommended; 2.0.x also compiles).
4. Install the libraries used by the sensor node via **Tools → Manage Libraries**:
   - **DHT sensor library** by Adafruit
   - **Adafruit Unified Sensor**
   - **Adafruit BMP280** (only if you enable pressure)
5. Install **WiFiManager** by tzapu — the camera sketch needs it. Everything else
   (`esp_camera.h`, `HTTPClient`, `WiFiClientSecure`) ships with the ESP32 core, so no MQTT
   library and no bundled `PubSubClient` files are required.
6. Select the correct port under **Tools → Port**.

---

## 2. ESP32-CAM (RHYX-M21-45) wiring and flashing

The RHYX-M21-45 module uses the standard AI-Thinker ESP32-CAM pinout. The camera is already
wired on the board, so the only external connection is the USB-TTL programmer.

### USB-TTL programming header

| USB-TTL adapter | ESP32-CAM | Notes |
| --- | --- | --- |
| `5V` | `5V` | Use a real 5 V supply, 1 A recommended |
| `GND` | `GND` | Common ground is mandatory |
| `TX` | `U0RXD` (GPIO 3) | Cross TX → RX |
| `RX` | `U0TXD` (GPIO 1) | Cross RX → TX |
| — | `GPIO 0` → `GND` | Only while uploading (boot mode) |
| — | `RST` | Press to reset / start upload |

**Upload sequence**

1. Connect `GPIO 0` to `GND`.
2. Press **RST** once.
3. In Arduino IDE choose:
   - Board: **AI Thinker ESP32-CAM**
   - CPU frequency: **240 MHz**
   - Flash frequency: **40 MHz**
   - Partition scheme: **Huge APP (3MB No OTA/1MB SPIFFS)**
   - PSRAM: **Enabled**
   - Upload speed: **115200** (try 460800 if stable)
4. Click **Upload**.
5. When uploading finishes, disconnect `GPIO 0` from `GND`, then press **RST**.
6. Open **Serial Monitor** at **115200 baud**.

If `Connecting........_____` never completes, hold **RST**, click Upload, and release RST when
the dots start. If the camera is not detected, reseat the ribbon cable with the gold contacts
facing the board and check the 5 V supply.

### Camera settings to edit

There is exactly one line to change before flashing: the relay host.

```cpp
#define SERVER_HOST "mirsad-live-xxxx.onrender.com"   // Render host, no https://
#define SERVER_PORT 443
#define UPLOAD_PATH "/api/upload-frame"
#define UPLOAD_TOKEN ""        // leave empty unless UPLOAD_TOKEN is set on Render
#define DEVICE_ID "ESP32-CAM-RHYX"
#define TARGET_FPS 10          // capture target; actual rate is lower (see below)
#define JPEG_QUALITY 80        // 60–70 is faster but softer
```

Frame geometry:

```cpp
#define FRAME_W 320
#define FRAME_H 240
```

The RHYX-M21-45 has **no hardware JPEG** (`PIXFORMAT_JPEG` fails with `0x106` and
reboot-loops). v5 captures `PIXFORMAT_RGB565` / `FRAMESIZE_QVGA` and calls
`frame2jpg()` from `img_converters.h` to compress on the ESP32, then uploads
`application/octet-stream` to `?w=320&h=240&format=jpeg`. The relay passes JPEG
through untouched; if compression fails, the sketch falls back to raw RGB565
(`?format=rgb565le`). Colour is tuned with contrast/saturation/sharpness `1`,
auto white balance, auto exposure and auto gain.

Wi-Fi configuration (any 2.4 GHz network, no portal needed):

1. Open Serial Monitor at **115200 baud** and send:

   ```text
   WIFI,YourNetworkName,YourPassword
   ```

2. The board replies `[serial] saved Wi-Fi 'YourNetworkName'; restarting...` and reboots.
3. It prints `[wifi] using serial network: ...` then `[wifi] connected: 192.168.x.x`.
4. It pings the relay (`[relay] awake (HTTP 200)`) — Render's free tier may take up to a minute
   to wake up, which is why this happens before streaming.
5. `[post] first frame accepted by the relay` means the dashboard goes **LIVE**.

The credentials survive reboots and work on any network; send another `WIFI,...` line to change
them. If no serial network is stored, the board falls back to the **`ESP32-CAM-Config`** hotspot
at `192.168.4.1`, which has a **180-second timeout** before retrying.

### Bandwidth and frame rate

v5 uploads a ~8–13 KB JPEG per frame (instead of 153,600 bytes of raw RGB565),
so bandwidth is modest. The end-to-end rate is currently about **0.5 fps**,
limited by on-device capture/JPEG encode plus the HTTPS POST round-trip, not by
browser delivery. WebRTC (with Metered TURN) only affects relay → browser.

| Firmware | Payload | Notes |
| --- | --- | --- |
| v5 (default) | ~8–13 KB/frame | software JPEG on-device; relay passes through |
| fallback | 153,600 B/frame | only if `frame2jpg()` fails |

To trade sharpness for speed, lower `JPEG_QUALITY` (e.g. 60–70) or the frame
size, then rebuild and re-flash. The relay still accepts raw RGB565 from older
sketches.

The camera LED is not used by this sketch.

---

## 3. ESP32 38-pin sensor node

### Wiring

| Sensor / signal | Sensor pin | ESP32 38-pin | Notes |
| --- | --- | --- | --- |
| DHT22 / AM2302 | `VCC` | `3V3` | 3.3 V |
| DHT22 / AM2302 | `DATA` | `GPIO 4` | 10 kΩ pull-up from DATA to 3V3 |
| DHT22 / AM2302 | `GND` | `GND` | |
| Capacitive soil probe | `AO` | `GPIO 34` | ADC1, input-only pin |
| Capacitive soil probe | `VCC` | `3V3` | Most probes are 3.3 V; check the label |
| Capacitive soil probe | `GND` | `GND` | |
| LDR module | `AO` | `GPIO 35` | ADC1, input-only pin |
| LDR module | `VCC` | `3V3` | |
| LDR module | `GND` | `GND` | |
| MQ-135 | `AO` | `GPIO 32` | ADC1; module heater usually needs 5 V |
| MQ-135 | `VCC` | `5V` | Warm-up 2–3 minutes |
| MQ-135 | `GND` | `GND` | |
| PIR HC-SR501 | `OUT` | `GPIO 27` | Output is 3.3 V on most modules |
| PIR HC-SR501 | `VCC` | `5V` | |
| PIR HC-SR501 | `GND` | `GND` | |
| Battery divider (optional) | midpoint | `GPIO 33` | 2:1 divider, max 4.2 V battery |
| BMP280 (optional) | `SDA` | `GPIO 21` | I2C |
| BMP280 (optional) | `SCL` | `GPIO 22` | I2C |
| BMP280 (optional) | `VCC` | `3V3` | |
| Status LED | `LED` | `GPIO 2` | On-board LED on many DevKit boards |

> **ADC1 only.** Use GPIO 32–39 for analog inputs. ADC2 pins stop working while Wi-Fi is
> active. GPIO 34–39 are input-only and have no internal pull-ups.

> **Voltage safety.** ESP32 ADC pins accept **0–3.3 V**. If your MQ-135 or battery divider can
> exceed 3.3 V, add a resistor divider before the pin. Never feed 5 V into an ESP32 GPIO.

> **Power.** Power the sensor node from USB or a stable 5 V supply. Connect all grounds
> together. The MQ-135 heater draws a noticeable current; a weak USB port can cause resets.

### Sensor settings to edit

```cpp
const char *WIFI_SSID = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SERVER_URL = "https://YOUR-SERVICE.onrender.com/api/sensors";
const char *UPLOAD_TOKEN = "";          // same as Render, or empty
const char *DEVICE_ID = "ESP32-SENSOR-38P";
const uint32_t SEND_INTERVAL_MS = 2000;
```

Calibrate the soil probe:

```cpp
const int SOIL_DRY_RAW = 3200;   // probe in dry air
const int SOIL_WET_RAW = 1400;   // probe in a glass of water
```

Open the Serial Monitor at **115200** and note the raw values in `analogRead(SOIL_PIN)` if you
want a more accurate mapping. The sketch maps dry→0 % and wet→100 %.

Battery divider:

```cpp
const float BATTERY_DIVIDER = 2.0;   // two equal resistors
const float BATTERY_EMPTY_V = 3.30;
const float BATTERY_FULL_V = 4.20;
```

If no divider is connected, the battery reading is omitted.

### Optional BMP280

1. Install **Adafruit BMP280**.
2. Change `#define USE_BMP280 0` to `1`.
3. The sketch tries address `0x76`; some modules use `0x77`.

### Uploading

- Board: **ESP32 Dev Module**
- Upload speed: **921600** (or 115200 if unstable)
- Flash size: **4 MB**
- PSRAM: **Disabled** (unless your specific board has it)
- Hold **BOOT** if the board does not enter download mode automatically.

Serial output after a successful start:

```text
[wifi] connected, IP=192.168.1.42 RSSI=-57 dBm
[relay] https://YOUR-SERVICE.onrender.com/api/sensors
[sensors] sending every 2000 ms
[sensors] packet #1 accepted (182 bytes)
```

---

## 4. Verify end to end

1. Open the Render URL (or `http://localhost:3000`).
2. The camera badge changes from `OFF` to `LIVE` after the first frame. In live-only mode the
   dashboard shows a waiting panel until the ESP32-CAM connects.
3. Sensor values replace `--` within two seconds of the first packet.
4. Check the server:

```bash
curl https://YOUR-SERVICE.onrender.com/api/status
curl https://YOUR-SERVICE.onrender.com/api/sensors/devices
```

5. In the dashboard open **WebRTC** mode to confirm the data channel works. If Metered is
   configured, the TURN pill reads `TURN`; otherwise `STUN`.

If the badge stays on `OFF`, the board is not reaching the relay. Open the Serial Monitor at
115200 and confirm the `[relay]` URL and the `[post] first frame accepted` lines.

---

## 5. Troubleshooting

### Camera

| Symptom | Fix |
| --- | --- |
| `[camera] init failed 0x105` | Camera not detected; reseat the ribbon cable, check 5 V and the PSRAM setting |
| `[post] failed: connection refused` | Wrong `SERVER_HOST`, or the Render service is still asleep — open `/healthz` in a browser and wait 60 s |
| `[post] server said HTTP 404` | `UPLOAD_PATH` must be `/api/upload-frame` |
| `[post] server said HTTP 401` | `UPLOAD_TOKEN` is set on Render but not in the sketch |
| `[post] server said HTTP 413` | Frame body larger than `MAX_FRAME_BYTES`; keep 320×240 RGB565 |
| `[relay] not ready yet (HTTP -1)` | TLS handshake failed — usually no internet, or a captive portal blocked it |
| `[camera] unexpected frame: fmt=…` | Sensor did not enter RGB565/QVGA mode; check `pixel_format` and `frame_size` |
| Random resets | Weak 5 V supply; shorten wires, add a 470–1000 µF capacitor near 5 V/GND |
| Image is dark | Add light; the OV2640 needs decent illumination, or raise `set_brightness` |
| Very low FPS | Raw RGB565 is large — lower `TARGET_FPS`, move closer to the router |
| `ESP32-CAM-Config` portal never appears | Board already has saved Wi-Fi credentials — that is normal |
| Serial shows `ESP32-CAM-Confiq` / `Upload error: connection refused` | Old firmware is still flashed; flash v3 — the log must start with `[boot] MIRSAD camera v3 (HTTP RGB565)` |

### Sensor node

| Symptom | Fix |
| --- | --- |
| `nan` temperature/humidity | DHT data pin wrong or missing 10 kΩ pull-up; DHT22 needs 2 s between reads |
| Soil always 0 or 100 | Calibrate `SOIL_DRY_RAW` / `SOIL_WET_RAW` for your probe |
| Air quality never changes | MQ-135 needs 2–3 minutes warm-up and 5 V heater supply |
| PIR always triggers | Adjust the potentiometers and warm-up time (HC-SR501 needs ~30 s) |
| `[sensors] post failed HTTP 401` | Token mismatch |
| `[sensors] post failed HTTP 400` | JSON has no numeric readings; check the Serial Monitor payload |
| Board resets when MQ-135 starts | Power the heater from a separate 5 V supply with a common ground |

### Colour order reference

The sketch sends little-endian RGB565 and asks the relay for the same:

| Query string | When |
| --- | --- |
| `format=rgb565le` | Default — what the ESP32 writes as a native `uint16_t` |
| `format=rgb565be` | Only if the picture shows red where it should be blue |

The server's `FRAME_FORMAT` environment variable is only a fallback; the firmware query string
always wins. `node tools/esp-post-check.js` proves the colour order without any hardware.
