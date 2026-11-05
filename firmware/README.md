# MIRSAD firmware guide

Two independent Arduino sketches:

| Sketch | Board | Purpose |
| --- | --- | --- |
| [`esp32cam-streamer/esp32cam-streamer.ino`](esp32cam-streamer/esp32cam-streamer.ino) | AI-Thinker ESP32-CAM + RHYX-M21-45 2 MP | Capture 320×240 RGB565 and POST frames |
| [`esp32-sensor-node/esp32-sensor-node.ino`](esp32-sensor-node/esp32-sensor-node.ino) | ESP32 DevKit 38-pin (ESP32-WROOM-32) | Read sensors and POST JSON every 2 s |

Both boards only make **outbound** HTTPS requests. Do not port-forward anything and do not give
either board a public IP.

---

## 1. Arduino IDE setup

1. Install the current Arduino IDE.
2. Open **File → Preferences → Additional Boards Manager URLs** and add:
   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. Open **Tools → Board → Boards Manager**, search for **esp32**, and install
   **ESP32 by Espressif Systems** (2.0.x or 3.x).
4. Install the libraries used by the sensor node via **Tools → Manage Libraries**:
   - **DHT sensor library** by Adafruit
   - **Adafruit Unified Sensor**
   - **Adafruit BMP280** (only if you enable pressure)
5. Select the correct port under **Tools → Port**.

The camera sketch only needs the ESP32 board package; `esp_camera.h` is bundled.

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

```cpp
const char *WIFI_SSID = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SERVER_URL = "https://YOUR-SERVICE.onrender.com/api/upload-frame";
const char *UPLOAD_TOKEN = "";          // same as Render, or empty
const char *DEVICE_ID = "ESP32-CAM-01";
const bool USE_RGB565_BIG_ENDIAN = true;
const int TARGET_FPS = 4;
```

The sketch appends the required query string automatically:

```text
?w=320&h=240&format=rgb565be&device=ESP32-CAM-01
```

Do not include those parameters in `SERVER_URL`; just end with `/api/upload-frame`.

### Why big-endian is the default

The OV2640 normally returns RGB565 high-byte-first (`rgb565be`). If the browser shows blue skin
and orange sky, the byte order is reversed: set `USE_RGB565_BIG_ENDIAN = false` and re-upload.
The server supports both `rgb565be` and `rgb565le`.

### Bandwidth and frame rate

A single 320×240 RGB565 frame is **153,600 bytes**. At 4 fps that is about **4.9 Mbit/s** of
raw upload, before TLS overhead. The sketch defaults to 4 fps for reliability over mobile/TLS
links. Increase to 6–10 fps only if the Wi-Fi signal and power supply are solid. The relay
converts every frame to JPEG (usually 8–30 KB), so downstream viewers use far less bandwidth.

### Camera LED

The red status LED on GPIO 33 is active LOW and lights while a frame is uploading. It is not
required for operation.

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
2. The camera badge changes from `DEMO` to `LIVE` after the first frame.
3. Sensor values replace the simulated values within two seconds.
4. Check the server:

```bash
curl https://YOUR-SERVICE.onrender.com/api/status
curl https://YOUR-SERVICE.onrender.com/api/sensors/devices
```

5. In the dashboard open **WebRTC** mode to confirm the data channel works. If Metered is
   configured, the TURN pill reads `TURN`; otherwise `STUN`.

---

## 5. Troubleshooting

### Camera

| Symptom | Fix |
| --- | --- |
| `[camera] init failed: 0x105` | Camera not detected; reseat the ribbon cable, check 5 V and PSRAM setting |
| `[upload] failed HTTP -1` | DNS/TLS/network failure; confirm the URL starts with `https://` and the board has internet |
| `[upload] failed HTTP 401` | `UPLOAD_TOKEN` does not match the Render environment variable |
| `[upload] failed HTTP 400` | Wrong dimensions/format; keep the sketch defaults (`320×240`, RGB565) |
| Colours swapped | Toggle `USE_RGB565_BIG_ENDIAN` |
| Random resets | Weak 5 V supply; shorten wires, add a 470–1000 µF capacitor near 5 V/GND |
| Image is dark | Increase `set_brightness` slightly, or add light; the OV2640 needs decent illumination |
| Very low FPS | Reduce `TARGET_FPS`, move closer to the router, use the external antenna if present |

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

| Setting | Query string | When |
| --- | --- | --- |
| `USE_RGB565_BIG_ENDIAN = true` | `format=rgb565be` | Default for OV2640 / RHYX-M21-45 |
| `USE_RGB565_BIG_ENDIAN = false` | `format=rgb565le` | Swap if red/blue channels look reversed |

The server's `FRAME_FORMAT` environment variable is only a fallback; the firmware query string
always wins.
