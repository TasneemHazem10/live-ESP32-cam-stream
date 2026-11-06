/*
 * ============================================================================
 *  MIRSAD — ESP32-CAM RGB565 streamer (WiFiManager edition)
 * ----------------------------------------------------------------------------
 *  Board      : AI-Thinker ESP32-CAM / RHYX-M21-45 2 MP
 *  Framework  : Arduino ESP32 core 2.0.x or 3.x
 *  Libraries  : ESP32 board package + "WiFiManager" by tzapu
 *  Partition  : "Huge APP (3MB No OTA/1MB SPIFFS)"
 *
 *  This version keeps the WiFiManager captive portal from your CameraWebServer
 *  sketch, but fixes the relay URL, adds the required query parameters and
 *  upload token, and regulates the frame rate so Render/TLS can keep up.
 *
 *  First boot:
 *    1. Flash the sketch.
 *    2. Connect to Wi-Fi "ESP32-CAM-Config" from your phone/laptop.
 *    3. Choose your home Wi-Fi and enter its password.
 *    4. The board posts 320x240 RGB565 frames to the relay.
 *
 *  Upload endpoint:
 *    POST /api/upload-frame?w=320&h=240&format=rgb565be&device=ESP32-CAM-01
 *    Body: 153,600 raw RGB565 bytes
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_camera.h>

// ---------------------------------------------------------------------------
// 1. Configure these values
// ---------------------------------------------------------------------------

// Render URL, or your local relay. End at /api/upload-frame.
// Local example: "http://192.168.1.50:3000/api/upload-frame"
const char *SERVER_URL = "https://YOUR-SERVICE.onrender.com/api/upload-frame";

// Leave empty when UPLOAD_TOKEN is not set on the server.
// For production, use the same long random value as Render.
const char *UPLOAD_TOKEN = "";

// Shown in the dashboard and in /api/sensors/devices.
const char *DEVICE_ID = "ESP32-CAM-01";

// OV2640 / RHYX modules normally send RGB565 high-byte-first.
// If colours are swapped (blue skin, orange sky), set this to false.
const bool USE_RGB565_BIG_ENDIAN = true;

// 4 fps is reliable over TLS. Raise to 6-8 only on a strong local network.
const int TARGET_FPS = 4;

// Set true if the module is mounted upside down or mirrored.
const bool FLIP_VERTICAL = false;
const bool FLIP_HORIZONTAL = false;

// AI-Thinker ESP32-CAM red status LED (active LOW).
const int STATUS_LED_PIN = 33;

// Stable clock for RHYX clone sensors. Try 20000000 if your module is stable.
const int XCLK_FREQ_HZ = 10000000;

// ---------------------------------------------------------------------------
// 2. AI-Thinker camera pin map
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
// 3. Internals
// ---------------------------------------------------------------------------

const int FRAME_WIDTH = 320;
const int FRAME_HEIGHT = 240;
const size_t FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 2;
const uint32_t FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

String uploadUrl;
bool secureTransport = false;
WiFiClient plainClient;
WiFiClientSecure secureClient;
uint32_t framesSent = 0;
uint32_t uploadFails = 0;
uint32_t lastFrameAt = 0;

void led(bool on) {
  digitalWrite(STATUS_LED_PIN, on ? LOW : HIGH);
}

void blink(int times, int durationMs = 80) {
  for (int i = 0; i < times; i++) {
    led(true);
    delay(durationMs);
    led(false);
    delay(durationMs);
  }
}

bool initCamera() {
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
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
#else
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
#endif
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = XCLK_FREQ_HZ;
  config.pixel_format = PIXFORMAT_RGB565;
  config.frame_size = FRAMESIZE_QVGA;
  config.jpeg_quality = 12;
  config.fb_count = psramFound() ? 2 : 1;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.grab_mode = psramFound() ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY;

  esp_err_t error = esp_camera_init(&config);
  if (error != ESP_OK) {
    Serial.printf("[camera] init failed: 0x%x\n", error);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_framesize(sensor, FRAMESIZE_QVGA);
    sensor->set_pixformat(sensor, PIXFORMAT_RGB565);
    sensor->set_brightness(sensor, 0);
    sensor->set_saturation(sensor, 0);
    sensor->set_vflip(sensor, FLIP_VERTICAL ? 1 : 0);
    sensor->set_hmirror(sensor, FLIP_HORIZONTAL ? 1 : 0);
  }

  Serial.println("[camera] ready at 320x240 RGB565");
  return true;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  // Captive portal. On first boot, join "ESP32-CAM-Config" and choose a network.
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  wm.setConnectTimeout(20);
  Serial.println("[wifi] opening portal 'ESP32-CAM-Config' if not configured");

  if (!wm.autoConnect("ESP32-CAM-Config")) {
    Serial.println("[wifi] connection timeout, restarting in 5s");
    delay(5000);
    ESP.restart();
  }

  Serial.printf("[wifi] connected, IP=%s RSSI=%d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  blink(2);
}

int uploadFrame(const uint8_t *buffer, size_t length) {
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(15000);
  http.setReuse(true);

  bool started = secureTransport
                    ? http.begin(secureClient, uploadUrl)
                    : http.begin(plainClient, uploadUrl);
  if (!started) {
    Serial.println("[http] begin failed");
    return -1;
  }

  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("X-Device-Id", DEVICE_ID);
  if (strlen(UPLOAD_TOKEN) > 0) http.addHeader("X-Upload-Token", UPLOAD_TOKEN);

  uint32_t at = millis();
  int code = http.POST(const_cast<uint8_t *>(buffer), length);
  uint32_t elapsed = millis() - at;

  if (code == HTTP_CODE_OK || code == HTTP_CODE_CREATED) {
    framesSent++;
    if (framesSent % 20 == 1) {
      Serial.printf("[upload] #%lu ok %u ms (%u bytes)\n",
                    (unsigned long)framesSent, elapsed, (unsigned)length);
    }
    if (http.connected()) http.getString();
  } else {
    uploadFails++;
    Serial.printf("[upload] failed HTTP %d in %u ms\n", code, elapsed);
    if (code < 0) http.end();
    return code;
  }

  http.end();
  return code;
}

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(STATUS_LED_PIN, OUTPUT);
  led(false);

  Serial.println();
  Serial.println("=====================================");
  Serial.println("  MIRSAD ESP32-CAM RGB565 streamer");
  Serial.println("  WiFiManager edition");
  Serial.println("=====================================");

  if (!initCamera()) {
    Serial.println("[camera] check the ribbon cable and power supply");
    blink(10, 120);
    delay(3000);
    ESP.restart();
  }

  connectWiFi();

  secureTransport = String(SERVER_URL).startsWith("https://");
  if (secureTransport) {
    // Render uses a rotating certificate chain. For a production fleet,
    // replace setInsecure() with the current root CA via setCACert().
    secureClient.setInsecure();
    secureClient.setHandshakeTimeout(12);
  }

  uploadUrl = String(SERVER_URL);
  uploadUrl += uploadUrl.indexOf('?') >= 0 ? "&" : "?";
  uploadUrl += "w=" + String(FRAME_WIDTH);
  uploadUrl += "&h=" + String(FRAME_HEIGHT);
  uploadUrl += "&format=";
  uploadUrl += USE_RGB565_BIG_ENDIAN ? "rgb565be" : "rgb565le";
  uploadUrl += "&device=" + String(DEVICE_ID);

  Serial.printf("[relay] %s\n", uploadUrl.c_str());
  Serial.printf("[relay] target %d fps, payload %u bytes\n",
                TARGET_FPS, (unsigned)FRAME_BYTES);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  uint32_t now = millis();
  if (now - lastFrameAt < FRAME_INTERVAL_MS) {
    delay(5);
    return;
  }
  lastFrameAt = now;

  camera_fb_t *frame = esp_camera_fb_get();
  if (!frame) {
    Serial.println("[camera] capture failed");
    delay(250);
    return;
  }

  if (frame->format == PIXFORMAT_RGB565 && frame->len >= FRAME_BYTES) {
    led(true);
    int code = uploadFrame(frame->buf, FRAME_BYTES);
    led(false);

    if (code < 0 && uploadFails % 15 == 0) {
      Serial.println("[wifi] resetting connection after repeated failures");
      WiFi.disconnect();
      delay(1200);
      WiFi.reconnect();
    }
  } else {
    Serial.printf("[camera] unexpected format=%d len=%u\n",
                  frame->format, (unsigned)frame->len);
  }

  esp_camera_fb_return(frame);
}
