/*
 * ============================================================================
 *  MIRSAD — ESP32 38-pin sensor node
 * ----------------------------------------------------------------------------
 *  Board      : ESP32 DevKit 38-pin (ESP32-WROOM-32)
 *  Framework  : Arduino ESP32 core 2.0.x or 3.x
 *
 *  Sensors (default wiring)
 *  ------------------------
 *  DHT22 / AM2302   data  -> GPIO 4     temperature + humidity
 *  Capacitive soil  AO    -> GPIO 34    soil moisture (ADC1)
 *  LDR module       AO    -> GPIO 35    light (ADC1)
 *  MQ-135           AO    -> GPIO 32    air quality (ADC1, warm-up 2-3 min)
 *  PIR HC-SR501     OUT   -> GPIO 27    motion
 *  Battery divider  ADC   -> GPIO 33    optional, 2:1 divider (ADC1)
 *  BMP280 (optional) SDA  -> GPIO 21    pressure (I2C)
 *                    SCL  -> GPIO 22
 *
 *  Important: use ADC1 pins (32-39) only. ADC2 does not work while Wi-Fi is on.
 *
 *  Libraries
 *  ---------
 *  - DHT sensor library (Adafruit) + Adafruit Unified Sensor
 *  - Adafruit BMP280 (only if USE_BMP280 is set to 1)
 *
 *  The node POSTs a JSON object every two seconds to /api/sensors.
 *  It never needs a public IP or an inbound port.
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>

// Optional pressure sensor. Set to 1 after installing Adafruit BMP280.
#define USE_BMP280 0
#if USE_BMP280
#include <Adafruit_BMP280.h>
Adafruit_BMP280 bmp;
bool bmpReady = false;
#endif

// ---------------------------------------------------------------------------
// 1. Configure these values
// ---------------------------------------------------------------------------

const char *WIFI_SSID = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char *SERVER_URL = "https://YOUR-SERVICE.onrender.com/api/sensors";
const char *UPLOAD_TOKEN = "";  // leave empty when the relay has no token
const char *DEVICE_ID = "ESP32-SENSOR-38P";

const uint32_t SEND_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// 2. Pins
// ---------------------------------------------------------------------------

const int DHT_PIN = 4;
const int DHT_TYPE = DHT22;
const int SOIL_PIN = 34;
const int LIGHT_PIN = 35;
const int AIR_PIN = 32;
const int PIR_PIN = 27;
const int BATTERY_PIN = 33;
const int LED_PIN = 2;

// Calibrate these two values for your own soil probe:
// SOIL_DRY_RAW is the reading in dry air, SOIL_WET_RAW in a glass of water.
const int SOIL_DRY_RAW = 3200;
const int SOIL_WET_RAW = 1400;

// Battery voltage divider ratio (2:1 means two equal resistors).
const float BATTERY_DIVIDER = 2.0;
const float BATTERY_EMPTY_V = 3.30;
const float BATTERY_FULL_V = 4.20;

// ---------------------------------------------------------------------------
// 3. Internals
// ---------------------------------------------------------------------------

DHT dht(DHT_PIN, DHT_TYPE);
WiFiClient plainClient;
WiFiClientSecure secureClient;
bool secureTransport = false;
uint32_t packetsSent = 0;
uint32_t packetsFailed = 0;
uint32_t lastSendAt = 0;

void blinkLed(int times, int durationMs = 60) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(durationMs);
    digitalWrite(LED_PIN, LOW);
    delay(durationMs);
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 30000) {
    delay(500);
    Serial.print('.');
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP=%s RSSI=%d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    blinkLed(2);
  } else {
    Serial.println("[wifi] timeout, restarting in 5s");
    delay(5000);
    ESP.restart();
  }
}

float readBatteryVolts() {
  // analogReadMilliVolts is available on ESP32 Arduino core 2.0+.
  uint32_t millivolts = analogReadMilliVolts(BATTERY_PIN);
  return (millivolts / 1000.0f) * BATTERY_DIVIDER;
}

int readBatteryPercent() {
  float volts = readBatteryVolts();
  if (volts < 1.0f) return 0;  // no divider connected
  float percent = (volts - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V) * 100.0f;
  return (int)constrain(percent, 0.0f, 100.0f);
}

String buildPayload() {
  String readings = "";
  bool first = true;

  auto addNumber = [&](const char *key, float value, int decimals) {
    if (isnan(value) || isinf(value)) return;
    if (!first) readings += ",";
    first = false;
    readings += "\"";
    readings += key;
    readings += "\":";
    readings += String(value, decimals);
  };

  auto addInt = [&](const char *key, int value) {
    if (!first) readings += ",";
    first = false;
    readings += "\"";
    readings += key;
    readings += "\":";
    readings += String(value);
  };

  auto addBool = [&](const char *key, bool value) {
    if (!first) readings += ",";
    first = false;
    readings += "\"";
    readings += key;
    readings += "\":";
    readings += value ? "true" : "false";
  };

  // DHT22 needs ~2 seconds between reads; the loop interval already respects it.
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();
  addNumber("temperature", temperature, 1);
  addNumber("humidity", humidity, 1);

  int soilRaw = analogRead(SOIL_PIN);
  int soilPercent = (int)constrain(
      map(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100), 0, 100);
  addInt("soil", soilPercent);

  int lightRaw = analogRead(LIGHT_PIN);
  int lightPercent = (int)constrain(map(lightRaw, 0, 4095, 0, 100), 0, 100);
  addInt("light", lightPercent);

  // MQ-135 needs a warm-up of a few minutes for a stable baseline.
  int airRaw = analogRead(AIR_PIN);
  int airQuality = (int)constrain(map(airRaw, 250, 3200, 12, 190), 0, 500);
  addInt("airQuality", airQuality);

  addBool("motion", digitalRead(PIR_PIN) == HIGH);

#if USE_BMP280
  if (bmpReady) {
    float pressure = bmp.readPressure() / 100.0f;
    if (pressure > 300 && pressure < 1200) addNumber("pressure", pressure, 1);
  }
#endif

  int battery = readBatteryPercent();
  if (battery > 0) addInt("battery", battery);
  addInt("rssi", WiFi.RSSI());

  String payload = "{\"deviceId\":\"";
  payload += DEVICE_ID;
  payload += "\",\"readings\":{";
  payload += readings;
  payload += "}}";
  return payload;
}

int postPayload(const String &payload) {
  HTTPClient http;
  http.setConnectTimeout(6000);
  http.setTimeout(10000);
  http.setReuse(true);

  bool started = secureTransport
                     ? http.begin(secureClient, SERVER_URL)
                     : http.begin(plainClient, SERVER_URL);
  if (!started) {
    Serial.println("[http] begin failed");
    return -1;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  if (strlen(UPLOAD_TOKEN) > 0) http.addHeader("X-Upload-Token", UPLOAD_TOKEN);

  int code = http.POST(payload);
  if (code == HTTP_CODE_OK || code == HTTP_CODE_CREATED) {
    packetsSent++;
    Serial.printf("[sensors] packet #%lu accepted (%u bytes)\n",
                  (unsigned long)packetsSent, (unsigned)payload.length());
  } else {
    packetsFailed++;
    Serial.printf("[sensors] post failed HTTP %d\n", code);
    if (code < 0) http.end();
    return code;
  }

  http.end();
  return code;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(LED_PIN, OUTPUT);
  pinMode(PIR_PIN, INPUT);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  dht.begin();

#if USE_BMP280
  if (bmp.begin(0x76)) {
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                    Adafruit_BMP280::SAMPLING_X2,
                    Adafruit_BMP280::SAMPLING_X16,
                    Adafruit_BMP280::FILTER_X16,
                    Adafruit_BMP280::STANDBY_MS_500);
    bmpReady = true;
    Serial.println("[bmp280] ready");
  } else {
    Serial.println("[bmp280] not found, continuing without pressure");
  }
#endif

  Serial.println();
  Serial.println("=====================================");
  Serial.println("  MIRSAD ESP32 sensor node");
  Serial.println("=====================================");

  connectWiFi();

  secureTransport = String(SERVER_URL).startsWith("https://");
  if (secureTransport) {
    secureClient.setInsecure();  // see the note in the ESP32-CAM sketch
    secureClient.setHandshakeTimeout(12);
  }

  Serial.printf("[relay] %s\n", SERVER_URL);
  Serial.printf("[sensors] sending every %lu ms\n", (unsigned long)SEND_INTERVAL_MS);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();

  uint32_t now = millis();
  if (now - lastSendAt < SEND_INTERVAL_MS) {
    delay(10);
    return;
  }
  lastSendAt = now;

  String payload = buildPayload();
  digitalWrite(LED_PIN, HIGH);
  int code = postPayload(payload);
  digitalWrite(LED_PIN, LOW);

  if (code < 0 && packetsFailed % 10 == 0) {
    Serial.println("[wifi] resetting connection after repeated failures");
    WiFi.disconnect();
    delay(1000);
    WiFi.reconnect();
  }
}
