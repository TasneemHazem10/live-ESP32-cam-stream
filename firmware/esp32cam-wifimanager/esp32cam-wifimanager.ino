/*
 * ============================================================================
 *  MIRSAD — ESP32-CAM live streamer  (v7, persistent WebSocket uplink)
 * ----------------------------------------------------------------------------
 *  Board   : AI-Thinker ESP32-CAM (RHYX-M21-45 2 MP camera module)
 *  Sensor  : RGB565 capture (this sensor has NO hardware JPEG mode), compressed
 *            with the ESP32's software JPEG encoder (frame2jpg) before upload.
 *  Uplink  : HTTPS POST application/octet-stream to the Render relay
 *
 *        ESP32-CAM --HTTPS POST /api/upload-frame--> Render relay
 *        Render relay --WSS /ws/frames (JPEG)------> browser
 *
 *  Uplink: one persistent WebSocket carries many JPEG frames (no per-frame
 *          HTTP round trip). If the WS is unavailable, the original HTTPS POST
 *          path is used automatically, so the camera is never offline.
 *  Live tuning over USB serial at 115200 (no reflash needed):
 *    WIFI,<ssid>,<password>   store any 2.4 GHz network
 *    QUALITY,<30-100>         JPEG quality (lower = faster, softer)
 *    SIZE,qqvga|hqvga|qvga    160x120 | 240x176 | 320x240
 *  Settings are stored in NVS and restored on boot.
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_camera.h>
#include <img_converters.h>
#include <Preferences.h>
#include <esp_system.h>   // esp_random() for WebSocket masking keys

Preferences prefs;

// ---------------------------------------------------------------------------
// 1. Relay (Render)
// ---------------------------------------------------------------------------

#define SERVER_HOST "live-esp32-cam-stream.onrender.com"
#define SERVER_PORT 443
#define UPLOAD_PATH "/api/upload-frame"
#define WS_PATH "/ws/camera"
#define WS_RETRY_MS 5000
#define UPLOAD_TOKEN ""
#define DEVICE_ID "ESP32-CAM-RHYX"

// ---------------------------------------------------------------------------
// 2. Frame parameters (defaults — change at runtime over serial)
// ---------------------------------------------------------------------------

#define DEFAULT_QUALITY 75
#define DEFAULT_SIZE FRAMESIZE_QVGA

#define TARGET_FPS 10
#define FRAME_INTERVAL_MS (1000 / TARGET_FPS)

#define HEALTH_PATH "/healthz"
#define WAKE_TIMEOUT_MS 90000

// ---------------------------------------------------------------------------
// 3. AI-Thinker camera pin map (RHYX-M21-45 uses the same pinout)
// ---------------------------------------------------------------------------

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define Y1_GPIO_NUM 4
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// ---------------------------------------------------------------------------
// 4. State
// ---------------------------------------------------------------------------

WiFiClientSecure tlsClient;

// Keep the HTTPClient alive across frames. A local HTTPClient would be destroyed
// at the end of every postFrame(), and its destructor calls _client->stop(),
// which kills the reused TLS connection and forces a ~1.5 s handshake per frame.
HTTPClient uploadHttp;
String uploadUrlJpeg;
String uploadUrlRgb;

// Primary uplink: one TLS connection upgraded to WebSocket, reused for every
// frame. POST stays configured as the automatic fallback.
WiFiClientSecure camTls;
bool wsConnected = false;
unsigned long wsLastRetryAt = 0;
static bool wsSend(uint8_t *data, size_t len, uint8_t opcode);
static bool sendWsMeta();

uint8_t jpegQuality = DEFAULT_QUALITY;
// Raw RGB565 over the WebSocket avoids the lossy on-device JPEG step: the
// relay encodes with sharp at higher quality, and the camera saves ~29 ms.
bool wsRaw = true;
framesize_t frameSize = DEFAULT_SIZE;
int frameW = 320;
int frameH = 240;

unsigned long lastFrameAt = 0;
unsigned long lastStatsAt = 0;
unsigned long lastReconnectAt = 0;
uint32_t framesSent = 0;
uint32_t framesFailed = 0;
uint32_t statsFrames = 0;
uint32_t statsBytes = 0;
uint32_t statsCap = 0;
uint32_t statsEnc = 0;
uint32_t statsPost = 0;
uint32_t statsCount = 0;

#define WIFI_CMD_PREFIX "WIFI,"
#define WIFI_CONNECT_TIMEOUT_MS 25000

// ---------------------------------------------------------------------------
// 4b. Frame geometry / upload URLs
// ---------------------------------------------------------------------------

void frameDims(framesize_t fs, int &w, int &h) {
  switch (fs) {
    case FRAMESIZE_QQVGA: w = 160; h = 120; break;
    case FRAMESIZE_HQVGA: w = 240; h = 176; break;
    case FRAMESIZE_QVGA:  w = 320; h = 240; break;
    default:              w = 320; h = 240; break;
  }
}

void buildUrls() {
  String base = String("https://") + SERVER_HOST + ":" + SERVER_PORT + UPLOAD_PATH;
  uploadUrlJpeg = base + "?w=" + frameW + "&h=" + frameH + "&format=jpeg&device=" + DEVICE_ID;
  uploadUrlRgb  = base + "?w=" + frameW + "&h=" + frameH + "&format=rgb565le&device=" + DEVICE_ID;
  if (strlen(UPLOAD_TOKEN) > 0) {
    uploadUrlJpeg += String("&token=") + UPLOAD_TOKEN;
    uploadUrlRgb  += String("&token=") + UPLOAD_TOKEN;
  }
}

bool validSize(framesize_t fs) {
  return fs == FRAMESIZE_QQVGA || fs == FRAMESIZE_HQVGA || fs == FRAMESIZE_QVGA;
}

// ---------------------------------------------------------------------------
// 4c. Camera init (called on boot and when SIZE changes)
// ---------------------------------------------------------------------------

bool initCamera(framesize_t fs) {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
#else
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
#endif
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_RGB565;   // this sensor has no hardware JPEG
  config.frame_size = fs;
  config.fb_count = psramFound() ? 2 : 1;
  config.grab_mode = psramFound() ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.jpeg_quality = jpegQuality;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[camera] init failed 0x%x\n", err);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_vflip(sensor, 0);
    sensor->set_hmirror(sensor, 0);
    sensor->set_brightness(sensor, 0);
    sensor->set_contrast(sensor, 1);
    sensor->set_saturation(sensor, 1);
    sensor->set_sharpness(sensor, 1);
    sensor->set_wb_mode(sensor, 0);       // auto white balance
    sensor->set_exposure_ctrl(sensor, 1); // auto exposure
    sensor->set_gain_ctrl(sensor, 1);     // auto gain
  }

  frameSize = fs;
  frameDims(fs, frameW, frameH);
  buildUrls();
  Serial.printf("[camera] ready %dx%d, quality=%u\n", frameW, frameH, (unsigned)jpegQuality);
  return true;
}

// ---------------------------------------------------------------------------
// 4d. Wi-Fi stored over USB serial
// ---------------------------------------------------------------------------

bool applySerialWifi() {
  prefs.begin("mirsad", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();
  if (ssid.length() == 0) return false;

  Serial.printf("[wifi] using serial network: %s\n", ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[wifi] connected: " + WiFi.localIP().toString());
    return true;
  }
  Serial.println("[wifi] serial network failed -> opening portal");
  return false;
}

void handleSerialConfig() {
  static String line;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (line.length() > 0) {
        line.trim();
        if (line.startsWith(WIFI_CMD_PREFIX)) {
          String rest = line.substring(strlen(WIFI_CMD_PREFIX));
          int sep = rest.indexOf(',');
          if (sep > 0) {
            String ssid = rest.substring(0, sep);
            String pass = rest.substring(sep + 1);
            ssid.trim();
            pass.trim();
            if (ssid.length() > 0) {
              prefs.begin("mirsad", false);
              prefs.putString("ssid", ssid);
              prefs.putString("pass", pass);
              prefs.end();
              Serial.printf("[serial] saved Wi-Fi '%s'; restarting...\n", ssid.c_str());
              delay(200);
              ESP.restart();
            }
          }
        } else if (line.startsWith("QUALITY,")) {
          int q = line.substring(8).toInt();
          if (q >= 30 && q <= 100) {
            jpegQuality = (uint8_t)q;
            prefs.begin("mirsad", false);
            prefs.putUChar("quality", jpegQuality);
            prefs.end();
            Serial.printf("[serial] JPEG quality = %u\n", (unsigned)jpegQuality);
          } else {
            Serial.println("[serial] QUALITY range is 30-100");
          }
        } else if (line.startsWith("SIZE,")) {
          String name = line.substring(5);
          name.toLowerCase();
          framesize_t fs = frameSize;
          if (name == "qqvga") fs = FRAMESIZE_QQVGA;
          else if (name == "hqvga") fs = FRAMESIZE_HQVGA;
          else if (name == "qvga") fs = FRAMESIZE_QVGA;
          else Serial.println("[serial] SIZE: qqvga | hqvga | qvga");
          if (validSize(fs) && fs != frameSize) {
            esp_camera_deinit();
            delay(150);
            framesize_t applied = initCamera(fs) ? fs : DEFAULT_SIZE;
            if (applied != fs) initCamera(DEFAULT_SIZE);
            prefs.begin("mirsad", false);
            prefs.putUChar("size", (uint8_t)applied);
            prefs.end();
            Serial.printf("[serial] frame size = %dx%d\n", frameW, frameH);
            sendWsMeta();
          }
        } else if (line.startsWith("FORMAT,")) {
          String name = line.substring(7);
          name.toLowerCase();
          if (name == "raw" || name == "rgb565" || name == "rgb565le") {
            wsRaw = true;
          } else if (name == "jpeg" || name == "jpg") {
            wsRaw = false;
          } else {
            Serial.println("[serial] FORMAT: raw | jpeg");
          }
          prefs.begin("mirsad", false);
          prefs.putBool("wsraw", wsRaw);
          prefs.end();
          Serial.printf("[serial] WS format = %s\n", wsRaw ? "rgb565le" : "jpeg");
          sendWsMeta();
        }
      }
      line = "";
    } else if (line.length() < 160) {
      line += c;
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Wake a sleeping Render instance
// ---------------------------------------------------------------------------

bool wakeRelay() {
  HTTPClient http;
  String url = String("https://") + SERVER_HOST + ":" + SERVER_PORT + HEALTH_PATH;
  http.setConnectTimeout(15000);
  http.setTimeout(15000);
  http.setReuse(false);

  unsigned long started = millis();
  int attempt = 0;
  while (millis() - started < WAKE_TIMEOUT_MS) {
    attempt++;
    if (!http.begin(tlsClient, url)) {
      Serial.printf("[relay] begin failed (attempt %d)\n", attempt);
      delay(2000);
      continue;
    }
    int code = http.GET();
    http.end();
    if (code > 0 && code < 500) {
      Serial.printf("[relay] awake (HTTP %d)\n", code);
      return true;
    }
    Serial.printf("[relay] not ready yet (HTTP %d), retrying...\n", code);
    tlsClient.stop();
    delay(3000);
  }
  Serial.println("[relay] wake-up timed out; will keep trying in the loop");
  return false;
}

// ---------------------------------------------------------------------------
// 6. Setup
// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(200);
  Serial.println("[boot] MIRSAD camera v7.1 (raw WS uplink, server-side JPEG)");

  prefs.begin("mirsad", true);
  jpegQuality = prefs.getUChar("quality", DEFAULT_QUALITY);
  framesize_t saved = (framesize_t)prefs.getUChar("size", (uint8_t)DEFAULT_SIZE);
  wsRaw = prefs.getBool("wsraw", true);
  prefs.end();
  if (jpegQuality < 30 || jpegQuality > 100) jpegQuality = DEFAULT_QUALITY;
  if (!validSize(saved)) saved = DEFAULT_SIZE;

  if (!initCamera(saved)) {
    Serial.println("[camera] saved size failed -> retrying QVGA");
    delay(1000);
    if (!initCamera(DEFAULT_SIZE)) {
      Serial.println("[camera] init failed -> restarting");
      delay(2000);
      ESP.restart();
    }
  }

  Serial.println("[serial] WIFI,<ssid>,<password> | QUALITY,<30-100> | SIZE,qqvga|hqvga|qvga | FORMAT,raw|jpeg");
  if (!applySerialWifi()) {
    WiFiManager wm;
    wm.setConnectTimeout(20);
    wm.setConfigPortalTimeout(180);
    prefs.begin("mirsad", true);
    bool hadSerialNetwork = prefs.getString("ssid", "").length() > 0;
    prefs.end();
    if (hadSerialNetwork) wm.resetSettings();
    Serial.println("[wifi] connecting (portal 'ESP32-CAM-Config' if no saved network)...");
    if (!wm.autoConnect("ESP32-CAM-Config")) {
      Serial.println("[wifi] failed -> restarting");
      ESP.restart();
    }
    WiFi.setSleep(false);
    Serial.println("[wifi] connected: " + WiFi.localIP().toString());
  }

  tlsClient.setInsecure();
  tlsClient.setHandshakeTimeout(20);
  camTls.setInsecure();
  camTls.setHandshakeTimeout(20);
  uploadHttp.setConnectTimeout(10000);
  uploadHttp.setTimeout(15000);
  uploadHttp.setReuse(true);

  Serial.print("[relay] ");
  Serial.println(uploadUrlJpeg);

  wakeRelay();
  lastStatsAt = millis();
}

// ---------------------------------------------------------------------------
// 6b. Persistent WebSocket uplink (primary; POST remains the fallback)
// ---------------------------------------------------------------------------

static bool tlsWriteAll(const uint8_t *buf, size_t len) {
  size_t off = 0;
  unsigned long t0 = millis();
  while (off < len && millis() - t0 < 10000) {
    int n = camTls.write(buf + off, len - off);
    if (n > 0) {
      off += (size_t)n;
    } else if (n < 0) {
      return false;
    } else {
      delay(1);
    }
  }
  return off == len;
}

// Send one WebSocket frame. Client frames MUST be masked, so the payload is
// XOR-ed in place — callers only pass buffers they are about to discard.
static bool wsSend(uint8_t *data, size_t len, uint8_t opcode) {
  if (!camTls.connected()) return false;

  uint8_t header[14];
  size_t h = 0;
  header[h++] = 0x80 | opcode;                 // FIN + opcode
  if (len < 126) {
    header[h++] = 0x80 | (uint8_t)len;         // MASK bit set
  } else if (len <= 0xffff) {
    header[h++] = 0x80 | 126;
    header[h++] = (uint8_t)(len >> 8);
    header[h++] = (uint8_t)len;
  } else {
    header[h++] = 0x80 | 127;
    for (int i = 7; i >= 0; i--) header[h++] = (uint8_t)(len >> (8 * i));
  }
  uint8_t mask[4] = {
    (uint8_t)esp_random(), (uint8_t)esp_random(),
    (uint8_t)esp_random(), (uint8_t)esp_random()
  };
  memcpy(header + h, mask, 4);
  h += 4;
  if (!tlsWriteAll(header, h)) return false;
  for (size_t i = 0; i < len; i++) data[i] ^= mask[i & 3];
  return len == 0 || tlsWriteAll(data, len);
}

// Tell the relay how to interpret the binary frames that follow.
static bool sendWsMeta() {
  if (!wsConnected) return false;
  char meta[128];
  int n = snprintf(meta, sizeof(meta),
                   "{\"w\":%d,\"h\":%d,\"device\":\"%s\",\"format\":\"%s\"}",
                   frameW, frameH, DEVICE_ID, wsRaw ? "rgb565le" : "jpeg");
  return wsSend((uint8_t *)meta, (size_t)n, 0x1);
}

static bool wsReadExact(uint8_t *buf, size_t len, unsigned long timeoutMs) {
  size_t got = 0;
  unsigned long t0 = millis();
  while (got < len && millis() - t0 < timeoutMs) {
    int avail = camTls.available();
    if (avail > 0) {
      int n = camTls.read(buf + got, min((size_t)avail, len - got));
      if (n > 0) got += (size_t)n;
      else if (n < 0) return false;
    } else {
      delay(1);
    }
  }
  return got == len;
}

// Drain frames from the server. No video flows camera-ward, but Cloudflare /
// Render may send pings, and they must be answered to keep the socket alive.
static bool wsPump() {
  unsigned long t0 = millis();
  while (camTls.available() > 0 && millis() - t0 < 40) {
    uint8_t h[2];
    if (!wsReadExact(h, 2, 100)) return false;
    uint8_t opcode = h[0] & 0x0f;
    bool masked = (h[1] & 0x80) != 0;
    uint64_t len = h[1] & 0x7f;
    if (len == 126) {
      uint8_t x[2];
      if (!wsReadExact(x, 2, 100)) return false;
      len = ((uint64_t)x[0] << 8) | x[1];
    } else if (len == 127) {
      uint8_t x[8];
      if (!wsReadExact(x, 8, 100)) return false;
      len = 0;
      for (int i = 0; i < 8; i++) len = (len << 8) | x[i];
    }
    uint8_t mask[4] = {0, 0, 0, 0};
    if (masked && !wsReadExact(mask, 4, 100)) return false;
    if (len > 2048) return false;              // server never sends large frames here
    uint8_t payload[2048];
    if (len && !wsReadExact(payload, (size_t)len, 300)) return false;
    if (masked) for (size_t i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    if (opcode == 0x8) return false;           // close
    if (opcode == 0x9) {                       // ping -> pong
      if (!wsSend(payload, (size_t)len, 0xA)) return false;
    }
  }
  return camTls.connected();
}

static void wsDisconnect() {
  wsConnected = false;
  camTls.stop();
}

static bool wsConnect() {
  if (!camTls.connect(SERVER_HOST, SERVER_PORT)) {
    Serial.println("[ws] TLS connect failed");
    return false;
  }

  String path = String(WS_PATH) + "?device=" + DEVICE_ID;
  if (strlen(UPLOAD_TOKEN) > 0) path += String("&token=") + UPLOAD_TOKEN;
  String req =
    String("GET ") + path + " HTTP/1.1\r\n" +
    "Host: " + SERVER_HOST ":" + SERVER_PORT + "\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "\r\n";
  if (!tlsWriteAll((const uint8_t *)req.c_str(), req.length())) {
    wsDisconnect();
    return false;
  }

  String header;
  unsigned long t0 = millis();
  while (millis() - t0 < 15000) {
    while (camTls.available() > 0) {
      char c = (char)camTls.read();
      header += c;
      if (header.length() > 4096) { wsDisconnect(); return false; }
    }
    if (header.indexOf("\r\n\r\n") >= 0) break;
    delay(10);
  }
  if (!header.startsWith("HTTP/1.1 101")) {
    Serial.printf("[ws] upgrade failed: %s\n", header.substring(0, 60).c_str());
    wsDisconnect();
    return false;
  }

  wsConnected = true;
  if (!sendWsMeta()) {
    wsDisconnect();
    return false;
  }

  Serial.printf("[ws] connected: %s (%dx%d, %s)\n", path.c_str(), frameW, frameH,
                wsRaw ? "rgb565le" : "jpeg");
  return true;
}

// ---------------------------------------------------------------------------
// 7. Upload one frame (fallback path)
// ---------------------------------------------------------------------------

bool postFrame(const uint8_t *data, size_t len, bool isJpeg) {
  if (!uploadHttp.begin(tlsClient, isJpeg ? uploadUrlJpeg : uploadUrlRgb)) {
    Serial.println("[post] begin failed");
    return false;
  }

  uploadHttp.addHeader("Content-Type", "application/octet-stream");
  uploadHttp.addHeader("X-Device-Id", DEVICE_ID);
  uploadHttp.addHeader("X-Frame-Width", String(frameW));
  uploadHttp.addHeader("X-Frame-Height", String(frameH));
  uploadHttp.addHeader("X-Frame-Format", isJpeg ? "jpeg" : "rgb565le");

  int code = uploadHttp.POST(const_cast<uint8_t *>(data), len);
  if (code <= 0) {
    Serial.printf("[post] failed: %s\n", uploadHttp.errorToString(code).c_str());
  } else if (code != 200) {
    Serial.printf("[post] server said HTTP %d\n", code);
  }
  // end() keeps the TCP/TLS socket open because setReuse(true) is set.
  uploadHttp.end();

  if (code != 200) {
    tlsClient.stop();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 8. Main loop
// ---------------------------------------------------------------------------

void loop() {
  handleSerialConfig();

  if (WiFi.status() != WL_CONNECTED) {
    if (wsConnected) wsDisconnect();
    if (millis() - lastReconnectAt > 3000) {
      lastReconnectAt = millis();
      Serial.println("[wifi] lost -> reconnecting");
      WiFi.reconnect();
    }
    delay(200);
    return;
  }

  unsigned long now = millis();

  // Keep the persistent uplink healthy. Retry every few seconds when down;
  // HTTP POST continues to carry frames until the WebSocket comes back.
  if (!wsConnected && now - wsLastRetryAt >= WS_RETRY_MS) {
    wsLastRetryAt = now;
    wsConnect();
  }
  bool usingWs = wsConnected;
  if (usingWs && !wsPump()) {
    Serial.println("[ws] link lost -> falling back to POST");
    wsDisconnect();
    usingWs = false;
  }

  if (now - lastStatsAt >= 5000) {
    float seconds = (now - lastStatsAt) / 1000.0f;
    Serial.printf("[stats] %.2f fps, %.0f KB/s, %u failed | cap=%lu enc=%lu post=%lu ms\n",
                  statsFrames / seconds,
                  (statsBytes / 1024.0f) / seconds,
                  (unsigned)framesFailed,
                  statsCount ? statsCap / statsCount : 0,
                  statsCount ? statsEnc / statsCount : 0,
                  statsCount ? statsPost / statsCount : 0);
    statsFrames = 0;
    statsBytes = 0;
    statsCap = 0;
    statsEnc = 0;
    statsPost = 0;
    statsCount = 0;
    lastStatsAt = now;
  }

  // WebSocket is pipelined: no per-frame response to wait for, so run as fast
  // as capture + encode/send allow. POST stays rate-limited to TARGET_FPS.
  if (!usingWs && now - lastFrameAt < FRAME_INTERVAL_MS) {
    delay(2);
    return;
  }
  lastFrameAt = now;

  unsigned long t0 = millis();
  camera_fb_t *fb = esp_camera_fb_get();
  unsigned long capMs = millis() - t0;
  if (!fb) {
    Serial.println("[camera] capture failed");
    delay(100);
    return;
  }

  const size_t rgbBytes = (size_t)frameW * frameH * 2;
  if (fb->format != PIXFORMAT_RGB565 || fb->len < rgbBytes) {
    Serial.printf("[camera] unexpected frame: fmt=%d len=%u expected=%u\n",
                  (int)fb->format, (unsigned)fb->len, (unsigned)rgbBytes);
    esp_camera_fb_return(fb);
    return;
  }

  bool ok = false;
  size_t bytes = rgbBytes;
  unsigned long encMs = 0;
  unsigned long postMs = 0;
  uint8_t *jpg = nullptr;
  size_t jpgLen = 0;

  if (usingWs && wsRaw) {
    // Fast path: no lossy encode on the ESP32. The relay converts RGB565 and
    // encodes a higher-quality JPEG with sharp. wsSend masks in place, which
    // is safe because the framebuffer is returned immediately afterwards.
    t0 = millis();
    ok = wsSend(fb->buf, rgbBytes, 0x2);
    if (!ok) wsDisconnect();
    postMs = millis() - t0;
  } else {
    // Compress in software on the ESP32 (on-device JPEG or POST fallback).
    t0 = millis();
    bool compressed = frame2jpg(fb, jpegQuality, &jpg, &jpgLen);
    encMs = millis() - t0;

    t0 = millis();
    if (compressed && jpg && jpgLen >= 100 && jpgLen < 400000) {
      bytes = jpgLen;
      if (usingWs) {
        ok = wsSend(jpg, jpgLen, 0x2);   // masks in place; do not POST on failure
        if (!ok) wsDisconnect();
      } else {
        ok = postFrame(jpg, jpgLen, true);
      }
    } else {
      Serial.println("[jpeg] compression failed -> sending RGB565 via POST");
      ok = postFrame(fb->buf, rgbBytes, false);
      bytes = rgbBytes;
    }
    postMs = millis() - t0;
  }

  if (jpg) free(jpg);
  esp_camera_fb_return(fb);

  statsCap += capMs;
  statsEnc += encMs;
  statsPost += postMs;
  statsCount++;

  if (ok) {
    framesSent++;
    statsFrames++;
    statsBytes += bytes;
    if (framesSent == 1) {
      Serial.println("[post] first frame accepted by the relay");
    }
  } else {
    framesFailed++;
    delay(200);
  }
}
