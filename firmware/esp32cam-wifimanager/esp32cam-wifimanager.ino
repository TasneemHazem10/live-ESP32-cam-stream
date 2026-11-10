/*
 * ============================================================================
 *  MIRSAD — ESP32-CAM live streamer  (v2, MQTT transport)
 * ----------------------------------------------------------------------------
 *  Board      : AI-Thinker ESP32-CAM (RHYX-M21-45 2 MP camera module)
 *  Framework  : Arduino ESP32 core 2.0.x or 3.x
 *
 *  The camera captures 320x240 JPEG frames ~15 times per second and publishes
 *  them to a public MQTT broker over TLS. The website subscribes to the same
 *  topic over a secure WebSocket, so the video goes
 *
 *        ESP32-CAM --TLS 8883--> public.cloud.shiftr.io <--WSS 443-- browser
 *
 *  Nothing else is needed: no server, no port forwarding, no account, no IP.
 *  After power-on the camera reconnects to the Wi-Fi it already saved and the
 *  website shows the image by itself.
 *
 *  ---------------------------------------------------------------------------
 *  FLASH THIS ONCE (about 1 minute)
 *  ---------------------------------------------------------------------------
 *  1. Open CameraWebServer.ino in Arduino IDE.
 *  2. Tools -> Board: "AI Thinker ESP32-CAM"
 *     Tools -> PSRAM:  "Enabled"
 *     Tools -> Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *     Tools -> Port: your USB-TTL adapter
 *  3. Connect GPIO0 to GND, press RST, click Upload.
 *  4. When it finishes: remove GPIO0 from GND, press RST, open Serial Monitor
 *     at 115200.
 *
 *  Libraries: none to install. PubSubClient.h / PubSubClient.cpp live in this
 *  same folder, and WiFiManager is already installed on this computer.
 *
 *  Wi-Fi: the board keeps the network it saved before, so no captive portal
 *  should appear. If it does (no saved network), join "ESP32-CAM-Config",
 *  pick your Wi-Fi, and the board starts streaming.
 *
 *  Expected serial output:
 *      [boot] MIRSAD camera v2 (MQTT)
 *      [wifi] connected: 192.168.1.24
 *      [mqtt] connecting to public.cloud.shiftr.io:8883 ... connected
 *      [mqtt] topic: mirsad/live/a7f3c9e1d84b4f06b2a5
 *      [stats] 15.0 fps, 118 KB/s, 0 dropped
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include "PubSubClient.h"
#include <esp_camera.h>

// ---------------------------------------------------------------------------
// 1. Broker / topic — must match public/js/runtime.js on the website
// ---------------------------------------------------------------------------

const char *MQTT_HOST = "public.cloud.shiftr.io";
const uint16_t MQTT_PORT = 8883;
const char *MQTT_USER = "public";
const char *MQTT_PASS = "public";
const char *MQTT_TOPIC = "mirsad/live/a7f3c9e1d84b4f06b2a5";

const char *DEVICE_ID = "ESP32-CAM-01";

// 15 fps is smooth and was proven to run loss-free on this broker.
const int TARGET_FPS = 15;
const uint32_t FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

// Smaller number = sharper/bigger frame. 16 keeps a QVGA frame around 6-9 KB,
// which is what makes 15 fps possible over TLS.
const int JPEG_QUALITY = 16;

// PubSubClient copies the whole JPEG into this buffer before sending.
const size_t MQTT_BUFFER_BYTES = 24576;

// ---------------------------------------------------------------------------
// 2. AI-Thinker camera pin map (RHYX-M21-45 uses the same pinout)
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
// 3. State
// ---------------------------------------------------------------------------

WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);

unsigned long lastFrameAt = 0;
unsigned long lastMqttAttemptAt = 0;
unsigned long lastStatsAt = 0;
uint32_t framesSent = 0;
uint32_t framesDropped = 0;
uint32_t statsFrames = 0;
uint32_t statsBytes = 0;

void reconnectMqtt() {
  String clientId = String(DEVICE_ID) + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.printf("[mqtt] connecting to %s:%u ... ", MQTT_HOST, MQTT_PORT);
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
    Serial.println("connected");
  } else {
    Serial.printf("failed (rc=%d)\n", mqtt.state());
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(200);
  Serial.println();
  Serial.println("[boot] MIRSAD camera v2 (MQTT)");

  camera_config_t config;
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

  config.xclk_freq_hz = 10000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA;
  config.fb_count = psramFound() ? 2 : 1;
  config.grab_mode = psramFound() ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.jpeg_quality = JPEG_QUALITY;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[camera] init failed 0x%x -> restarting\n", err);
    delay(2000);
    ESP.restart();
  }

  // Reuses the Wi-Fi already stored on the board. The portal only opens if the
  // board has no saved network at all.
  WiFiManager wm;
  wm.setConnectTimeout(20);
  wm.setConfigPortalTimeout(180);
  Serial.println("[wifi] connecting (portal 'ESP32-CAM-Config' if no saved network)...");
  if (!wm.autoConnect("ESP32-CAM-Config")) {
    Serial.println("[wifi] failed -> restarting");
    ESP.restart();
  }
  WiFi.setSleep(false);
  Serial.println("[wifi] connected: " + WiFi.localIP().toString());

  tlsClient.setInsecure();
  tlsClient.setHandshakeTimeout(15);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(10);
  if (!mqtt.setBufferSize(MQTT_BUFFER_BYTES)) {
    Serial.println("[mqtt] WARNING: could not allocate the frame buffer");
  }

  Serial.printf("[mqtt] topic: %s\n", MQTT_TOPIC);
  lastStatsAt = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(500);
    return;
  }

  if (!mqtt.connected()) {
    if (millis() - lastMqttAttemptAt >= 3000) {
      lastMqttAttemptAt = millis();
      reconnectMqtt();
    }
    delay(50);
    return;
  }

  // Keep the MQTT session healthy (answers pings, notices a dead socket).
  mqtt.loop();

  unsigned long now = millis();

  if (now - lastStatsAt >= 5000) {
    float seconds = (now - lastStatsAt) / 1000.0f;
    Serial.printf("[stats] %.1f fps, %.0f KB/s, %u dropped\n",
                  statsFrames / seconds,
                  (statsBytes / 1024.0f) / seconds,
                  (unsigned)framesDropped);
    statsFrames = 0;
    statsBytes = 0;
    lastStatsAt = now;
  }

  if (now - lastFrameAt < FRAME_INTERVAL_MS) {
    delay(2);
    return;
  }
  lastFrameAt = now;

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[camera] frame capture failed");
    delay(100);
    return;
  }

  if (fb->format != PIXFORMAT_JPEG || fb->len == 0) {
    Serial.println("[camera] unexpected frame format");
    esp_camera_fb_return(fb);
    return;
  }

  if (fb->len > mqtt.getBufferSize()) {
    framesDropped++;
    if (framesDropped % 20 == 1) {
      Serial.printf("[camera] frame too large (%u bytes) - dropping\n", (unsigned)fb->len);
    }
    esp_camera_fb_return(fb);
    return;
  }

  bool ok = mqtt.publish(MQTT_TOPIC, fb->buf, fb->len, false);
  size_t frameLen = fb->len;
  esp_camera_fb_return(fb);

  if (ok) {
    framesSent++;
    statsFrames++;
    statsBytes += frameLen;
    if (framesSent == 1) {
      Serial.printf("[mqtt] streaming to %s\n", MQTT_TOPIC);
    }
  } else {
    Serial.println("[mqtt] publish failed - reconnecting");
    mqtt.disconnect();
  }
}
