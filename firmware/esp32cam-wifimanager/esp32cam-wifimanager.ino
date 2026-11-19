/*
 * ============================================================================
 *  MIRSAD — ESP32-CAM live streamer  (v6, runtime-tunable software JPEG)
 * ----------------------------------------------------------------------------
 *  Board   : AI-Thinker ESP32-CAM (RHYX-M21-45 2 MP camera module)
 *  Sensor  : RGB565 capture (this sensor has NO hardware JPEG mode), compressed
 *            with the ESP32's software JPEG encoder (frame2jpg) before upload.
 *  Uplink  : HTTPS POST application/octet-stream to the Render relay
 *
 *        ESP32-CAM --HTTPS POST /api/upload-frame--> Render relay
 *        Render relay --WSS /ws/frames (JPEG)------> browser
 *
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

Preferences prefs;

// ---------------------------------------------------------------------------
// 1. Relay (Render)
// ---------------------------------------------------------------------------

#define SERVER_HOST "live-esp32-cam-stream.onrender.com"
#define SERVER_PORT 443
#define UPLOAD_PATH "/api/upload-frame"
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
String uploadUrlJpeg;
String uploadUrlRgb;

uint8_t jpegQuality = DEFAULT_QUALITY;
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
          }
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
  Serial.println("[boot] MIRSAD camera v6 (runtime-tunable software JPEG)");

  prefs.begin("mirsad", true);
  jpegQuality = prefs.getUChar("quality", DEFAULT_QUALITY);
  framesize_t saved = (framesize_t)prefs.getUChar("size", (uint8_t)DEFAULT_SIZE);
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

  Serial.println("[serial] WIFI,<ssid>,<password> | QUALITY,<30-100> | SIZE,qqvga|hqvga|qvga");
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

  Serial.print("[relay] ");
  Serial.println(uploadUrlJpeg);

  wakeRelay();
  lastStatsAt = millis();
}

// ---------------------------------------------------------------------------
// 7. Upload one frame
// ---------------------------------------------------------------------------

bool postFrame(const uint8_t *data, size_t len, bool isJpeg) {
  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(15000);
  http.setReuse(true);

  if (!http.begin(tlsClient, isJpeg ? uploadUrlJpeg : uploadUrlRgb)) {
    Serial.println("[post] begin failed");
    return false;
  }

  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Frame-Width", String(frameW));
  http.addHeader("X-Frame-Height", String(frameH));
  http.addHeader("X-Frame-Format", isJpeg ? "jpeg" : "rgb565le");

  int code = http.POST(const_cast<uint8_t *>(data), len);
  if (code <= 0) {
    Serial.printf("[post] failed: %s\n", http.errorToString(code).c_str());
  } else if (code != 200) {
    Serial.printf("[post] server said HTTP %d\n", code);
  }
  http.end();

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
    if (millis() - lastReconnectAt > 3000) {
      lastReconnectAt = millis();
      Serial.println("[wifi] lost -> reconnecting");
      WiFi.reconnect();
    }
    delay(200);
    return;
  }

  unsigned long now = millis();

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

  if (now - lastFrameAt < FRAME_INTERVAL_MS) {
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

  // Compress in software on the ESP32. frame2jpg() allocates the output buffer.
  uint8_t *jpg = nullptr;
  size_t jpgLen = 0;
  t0 = millis();
  bool compressed = frame2jpg(fb, jpegQuality, &jpg, &jpgLen);
  unsigned long encMs = millis() - t0;

  bool ok;
  size_t bytes;
  t0 = millis();
  if (compressed && jpg && jpgLen >= 100 && jpgLen < 400000) {
    ok = postFrame(jpg, jpgLen, true);
    bytes = jpgLen;
  } else {
    Serial.println("[jpeg] compression failed -> sending RGB565");
    ok = postFrame(fb->buf, rgbBytes, false);
    bytes = rgbBytes;
  }
  unsigned long postMs = millis() - t0;

  if (compressed && jpg) free(jpg);
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
