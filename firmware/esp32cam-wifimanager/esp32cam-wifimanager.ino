/*
 * ============================================================================
 *  MIRSAD — ESP32-CAM live streamer  (v3, HTTP RGB565 — spec transport)
 * ----------------------------------------------------------------------------
 *  Board   : AI-Thinker ESP32-CAM (RHYX-M21-45 2 MP camera module)
 *  Sensor  : 320x240 (QVGA), raw RGB565, 2 bytes/pixel -> 153,600 B per frame
 *  Uplink  : HTTP POST application/octet-stream to the relay on Render
 *
 *        ESP32-CAM --HTTPS POST /api/upload-frame--> Render relay
 *        Render relay --WSS /ws/frames (JPEG)------> browser
 *
 *  The relay decodes RGB565 to JPEG and fans it out over WebSocket, MJPEG or
 *  HTTP polling, so the camera never needs a public IP or port forwarding.
 *
 *  ---------------------------------------------------------------------------
 *  BEFORE FLASHING: set SERVER_HOST below
 *  ---------------------------------------------------------------------------
 *  SERVER_HOST must be the Render service host (no https://, no trailing /):
 *      Render dashboard -> your service -> the URL under the name,
 *      e.g. "mirsad-live-ab12.onrender.com"
 *
 *  Wi-Fi: the board reuses the network it already saved, so no captive portal
 *  appears. If there is no saved network it opens "ESP32-CAM-Config".
 *
 *  Expected serial output at 115200 baud:
 *      [boot] MIRSAD camera v3 (HTTP RGB565)
 *      [wifi] connected: 192.168.1.24
 *      [relay] https://…/api/upload-frame?w=320&h=240&format=rgb565le…
 *      [relay] awake (HTTP 200)
 *      [post] 1 frames, 153600 B, 0 failed
 *      [stats] 4.8 fps, 720 KB/s, 0 failed
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_camera.h>

// ---------------------------------------------------------------------------
// 1. Relay (Render) — EDIT THIS ONE LINE
// ---------------------------------------------------------------------------

#define SERVER_HOST "live-esp32-cam-stream.onrender.com"
#define SERVER_PORT 443
#define UPLOAD_PATH "/api/upload-frame"

// Optional shared secret. Leave empty unless UPLOAD_TOKEN is set on Render.
#define UPLOAD_TOKEN ""

#define DEVICE_ID "ESP32-CAM-RHYX"

// ---------------------------------------------------------------------------
// 2. Frame parameters (must match the handover spec)
// ---------------------------------------------------------------------------

#define FRAME_W 320
#define FRAME_H 240
#define FRAME_BYTES (FRAME_W * FRAME_H * 2)   // 153,600 bytes

// RGB565 is 153,600 B/frame, so each frame is ~20x a JPEG. 5 fps is a good
// compromise (about 2.7 GB/hour). Lower this on metered links.
#define TARGET_FPS 5
#define FRAME_INTERVAL_MS (1000 / TARGET_FPS)

// Wake-up ping: Render's free tier sleeps when idle. The first request can take
// up to a minute, so wait for /healthz before streaming instead of failing.
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
String uploadUrl;

unsigned long lastFrameAt = 0;
unsigned long lastStatsAt = 0;
unsigned long lastReconnectAt = 0;
uint32_t framesSent = 0;
uint32_t framesFailed = 0;
uint32_t statsFrames = 0;
uint32_t statsBytes = 0;

// ---------------------------------------------------------------------------
// 5. Helper: wait for the relay to answer (wakes a sleeping Render instance)
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
  Serial.println();
  Serial.println("[boot] MIRSAD camera v3 (HTTP RGB565)");

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

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_RGB565;   // spec: no hardware JPEG
  config.frame_size = FRAMESIZE_QVGA;       // 320x240
  config.fb_count = psramFound() ? 2 : 1;
  config.grab_mode = psramFound() ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.jpeg_quality = 12;                 // ignored in RGB565 mode

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[camera] init failed 0x%x -> restarting\n", err);
    delay(2000);
    ESP.restart();
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_vflip(sensor, 0);
    sensor->set_hmirror(sensor, 0);
    sensor->set_brightness(sensor, 0);
    sensor->set_saturation(sensor, 0);
  }

  // Reuses the Wi-Fi already stored on the board; the portal only opens when
  // there is no saved network at all.
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

  tlsClient.setInsecure();            // Render's certificate is valid; no CA bundle on the board
  tlsClient.setHandshakeTimeout(20);

  uploadUrl = String("https://") + SERVER_HOST + ":" + SERVER_PORT + UPLOAD_PATH;
  uploadUrl += String("?w=") + FRAME_W + "&h=" + FRAME_H + "&format=rgb565le";
  uploadUrl += String("&device=") + DEVICE_ID;
  if (strlen(UPLOAD_TOKEN) > 0) uploadUrl += String("&token=") + UPLOAD_TOKEN;

  Serial.print("[relay] ");
  Serial.println(uploadUrl);

  wakeRelay();

  lastStatsAt = millis();
}

// ---------------------------------------------------------------------------
// 7. Upload one frame
// ---------------------------------------------------------------------------

bool postFrame(const uint8_t *data, size_t len) {
  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(15000);
  http.setReuse(true);

  if (!http.begin(tlsClient, uploadUrl)) {
    Serial.println("[post] begin failed");
    return false;
  }

  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Frame-Width", String(FRAME_W));
  http.addHeader("X-Frame-Height", String(FRAME_H));
  http.addHeader("X-Frame-Format", "rgb565le");

  int code = http.POST(const_cast<uint8_t *>(data), len);
  if (code <= 0) {
    Serial.printf("[post] failed: %s\n", http.errorToString(code).c_str());
  } else if (code != 200) {
    Serial.printf("[post] server said HTTP %d\n", code);
  }
  http.end();

  if (code != 200) {
    // A stale keep-alive socket cannot be reused; drop it so the next attempt
    // performs a clean handshake.
    tlsClient.stop();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 8. Main loop
// ---------------------------------------------------------------------------

void loop() {
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
    Serial.printf("[stats] %.1f fps, %.0f KB/s, %u failed\n",
                  statsFrames / seconds,
                  (statsBytes / 1024.0f) / seconds,
                  (unsigned)framesFailed);
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
    Serial.println("[camera] capture failed");
    delay(100);
    return;
  }

  if (fb->format != PIXFORMAT_RGB565 || fb->len < FRAME_BYTES) {
    Serial.printf("[camera] unexpected frame: fmt=%d len=%u\n",
                  (int)fb->format, (unsigned)fb->len);
    esp_camera_fb_return(fb);
    return;
  }

  bool ok = postFrame(fb->buf, FRAME_BYTES);
  esp_camera_fb_return(fb);

  if (ok) {
    framesSent++;
    statsFrames++;
    statsBytes += FRAME_BYTES;
    if (framesSent == 1) {
      Serial.println("[post] first frame accepted by the relay");
    }
  } else {
    framesFailed++;
    delay(200);   // brief backoff; keeps the log readable when the relay is down
  }
}
