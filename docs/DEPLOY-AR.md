# دليل النشر والتشغيل خطوة بخطوة · MIRSAD / مرصد

> **تحديث:** لم نعد نستخدم Render. الخادم يعمل الآن على اللابتوب، والبث عن بُعد يتم عبر
> **LiveKit Cloud**. اتبع [`../LIVE-SETUP.md`](../LIVE-SETUP.md) للطريقة الحالية. خطوات Render
> أدناه محفوظة كمرجع قديم فقط.

هذا الدليل يشرح بالتفصيل كيف تنشر المشروع كاملًا: الواجهة + الخادم على **Render**، والكود على
**GitHub**، ثم تُشغّل **Metered TURN** وتُبرمج لوحتي **ESP32-CAM** و **ESP32 38-pin**.

> **مهم:** الكاميرا والحساسات تتصل بالخادم عبر طلبات HTTPS صادرة فقط. لا تحتاج IP عام، ولا
> فتح منافذ في الراوتر، ولا NAT traversal. جهاز ESP32-CAM يرفع الصور إلى Render، وRender هو
> الذي يوزّعها على المتصفحات.

---

## المحتويات

1. [ما ستحتاجه](#1-ما-ستحتاجه)
2. [تجربة المشروع محليًا](#2-تجربة-المشروع-محليًا)
3. [رفع الكود إلى GitHub](#3-رفع-الكود-إلى-github)
4. [النشر على Render](#4-النشر-على-render)
5. [متغيرات البيئة](#5-متغيرات-البيئة)
6. [إعداد Metered TURN](#6-إعداد-metered-turn)
7. [برمجة ESP32-CAM](#7-برمجة-esp32-cam)
8. [برمجة ESP32 38-pin](#8-برمجة-esp32-38-pin)
9. [التحقق النهائي](#9-التحقق-النهائي)
10. [تحديث المشروع لاحقًا](#10-تحديث-المشروع-لاحقًا)
11. [حل المشاكل](#11-حل-المشاكل)
12. [ملاحظات الأمان والتكلفة](#12-ملاحظات-الأمان-والتكلفة)

---

## 1. ما ستحتاجه

| العنصر | التفاصيل |
| --- | --- |
| حساب GitHub | مجاني — <https://github.com> |
| حساب Render | مجاني — <https://render.com> (يمكن التسجيل بحساب GitHub) |
| حساب Metered | مجاني — <https://www.metered.ca> (اختياري لكنه مُوصى به بشدة) |
| Node.js | الإصدار **22 أو أحدث** — <https://nodejs.org> |
| Arduino IDE | الإصدار 2.x — <https://www.arduino.cc/en/software> |
| ESP32-CAM | AI-Thinker + كاميرا RHYX-M21-45 (2 ميجابكسل) |
| ESP32 38-pin | ESP32 DevKit / ESP32-WROOM-32 مع الحساسات |
| USB-TTL | لبرمجة ESP32-CAM (مثل CP2102 أو CH340) |
| مصدر طاقة | **5 فولت / 1 أمبير** للكاميرا |

> المشروع مكتوب بـ **Node.js** بالكامل. لا يحتاج Python ولا ffmpeg ولا أي مكتبة نظام إضافية.

---

## 2. تجربة المشروع محليًا

افتح PowerShell داخل مجلد المشروع ونفّذ:

```powershell
npm install
npm start
```

ثم افتح المتصفح على:

```text
http://localhost:3000
```

ستظهر الواجهة العربية في **وضع كاميرا اللابتوب**: يفتح خادم اللابتوب الكاميرا تلقائيًا (اسمح
بالوصول مرة واحدة) ويبثّ إطارات JPEG لكل المشاهدين. أول إطار من ESP32-CAM يمكن أن يحلّ محلها
لاحقًا. لا توجد كاميرا صناعية افتراضيًا. لمعاينة الواجهة دون عتاد، اضبط `DEMO_FALLBACK=true`
في `.env` ثم أعد تشغيل الخادم. جرّب الفلاتر الثمانية، تبديل اللغة، النقل بين
WebSocket / WebRTC / MJPEG / HTTP، ولقطة PNG بعد وصول البث.

الأجهزة الأخرى على نفس الشبكة تفتح `http://LAPTOP-LAN-IP:3000` وتشاهد البث كـ**مشاهدين**،
دون أي طلب للوصول إلى كاميراتها، مع إخفاء أزرار الكاميرا.

أوامر مفيدة:

```powershell
npm run dev          # إعادة التشغيل التلقائي عند تعديل الملفات
npm run sim:camera   # إرسال إطارات RGB565 صناعية إلى الخادم المحلي
npm run sim:sensors  # إرسال قراءات حساسات صناعية
npm run test:e2e     # 13 فحصًا للـ HTTP وWebSocket وMJPEG والحساسات
npm run test:webrtc  # فحص WebRTC وdata channel ورأس الإطار
npm run test:ui      # فحص الواجهة عبر Chrome (يتطلب Chrome مثبتًا)
```

> اختبارات `test:e2e` و`test:webrtc` و`test:ui` تحتاج الخادم شغّالًا على `http://localhost:3000`
> في نافذة PowerShell أخرى.

لإيقاف الخادم المحلي اضغط `Ctrl + C`.

---

## 3. رفع الكود إلى GitHub

### 3.1 إنشاء المستودع

1. افتح <https://github.com/new>.
2. اكتب اسمًا مثل `mirsad-live`.
3. اختر **Private** أو **Public**.
4. **لا تُضف** README أو .gitignore أو License (المشروع يحتوي عليها).
5. اضغط **Create repository** وانسخ رابط المستودع.

### 3.2 أول Commit ورفع

من داخل مجلد المشروع في PowerShell:

```powershell
git init
git add .
git commit -m "MIRSAD live ESP32-CAM dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

استبدل `YOUR_USER` و`YOUR_REPO` باسم حسابك واسم المستودع.

### 3.3 البديل: GitHub CLI

إذا كان `gh` مثبتًا:

```powershell
gh auth login
gh repo create mirsad-live --private --source=. --remote=origin --push
```

### 3.4 تحقق قبل الرفع

تأكد أن ملف `.env` **غير موجود** في المستودع. الملف الموجود في Git هو `.env.example` فقط:

```powershell
git status
```

يجب ألا يظهر `.env` أو `node_modules` أو `screenshots` في قائمة الملفات. ملف `.gitignore`
مُعدّ لاستثنائها تلقائيًا.

---

## 4. النشر على Render

المشروع يخدم الواجهة والـ API من **خدمة واحدة**. لا تحتاج خدمة منفصلة للواجهة.

### الطريقة أ — Blueprint (مُوصى بها)

1. افتح <https://dashboard.render.com/>.
2. اضغط **New** ← **Blueprint**.
3. اربط حساب GitHub واختر المستودع الذي رفعت إليه المشروع.
4. سيتعرّف Render على ملف `render.yaml` ويعرض خدمة باسم **mirsad-live**.
5. راجع الإعدادات ثم اضغط **Apply**.
6. يولّد Render قيمة **`UPLOAD_TOKEN`** تلقائيًا. بعد إنشاء الخدمة افتح
   **Dashboard → الخدمة → Environment** وانسخ القيمة — ستضعها في كود ESP32.
7. خدمة TURN اختيارية. يستخدم الـ Blueprint خوادم STUN العامة افتراضيًا. لدعم الشبكات
   المقيّدة جدًا لاحقًا، أضف `METERED_DOMAIN` و`METERED_API_KEY` ومنطقة `METERED_REGION` من
   **Dashboard → الخدمة → Environment** ثم أعد النشر.
8. انتظر انتهاء **Build** ثم **Deploy**. الأمران المستخدمان:
   - Build: `npm ci`
   - Start: `npm start`
   - Health check: `/healthz`
9. افتح الرابط الذي يظهر بالشكل:

   ```text
   https://mirsad-live.onrender.com
   ```

### الطريقة ب — خدمة يدوية

1. **New** ← **Web Service**.
2. اربط GitHub واختر المستودع.
3. الإعدادات:
   - **Runtime:** Node
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz`
4. أضف متغيرات البيئة (انظر [القسم 5](#5-متغيرات-البيئة)). الحد الأدنى:
   ```text
   NODE_VERSION=22
   ```
5. اضغط **Create Web Service**.

### توليد `UPLOAD_TOKEN`

استخدم أحد الأوامر التالية وانسخ الناتج:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

أو:

```bash
openssl rand -hex 24
```

ضع نفس القيمة في Render وفي كودي ESP32 (`UPLOAD_TOKEN`). إذا اختلفت القيمتان ستحصل على
`HTTP 401`.

> إن تركت `UPLOAD_TOKEN` فارغًا فسيعمل النظام، لكن أي شخص يعرف رابط الخادم يستطيع إرسال
> صور أو قراءات. اضبطه قبل الاستخدام الحقيقي.

---

## 5. متغيرات البيئة

على Render: افتح الخدمة ← **Environment** ← **Add Environment Variable**، ثم أعد النشر
(**Manual Deploy** ← **Deploy latest commit**) أو اضغط **Save Changes**.

| المتغير | القيمة المقترحة | الوظيفة |
| --- | --- | --- |
| `NODE_VERSION` | `22` | إصدار Node |
| `NODE_ENV` | `production` | بيئة التشغيل |
| `UPLOAD_TOKEN` | قيمة عشوائية طويلة | حماية رفع الصور والحساسات |
| `ALLOWED_ORIGINS` | `*` أو نطاقك | أصول المتصفح المسموح لها |
| `DEMO_FALLBACK` | `false` | صور/قراءات صناعية اختيارية لاختبار الواجهة؛ اتركه false للبث الحي فقط |
| `DEMO_FPS` | `8` | سرعة الكاميرا التجريبية |
| `JPEG_QUALITY` | `80` | جودة تحويل JPEG |
| `FRAME_WIDTH` / `FRAME_HEIGHT` | `320` / `240` | أبعاد افتراضية |
| `FRAME_FORMAT` | `rgb565le` | ترتيب البايتات الافتراضي |
| `MAX_FRAME_BYTES` | `2097152` | حد حجم الإطار |
| `FRAME_STALE_MS` | `5000` | عمر الإطار قبل اعتباره قديمًا |
| `MAX_WEBRTC_PEERS` | `4` | أقصى عدد جلسات WebRTC |
| `METERED_DOMAIN` | نطاق تطبيق Metered | خادم TURN |
| `METERED_API_KEY` | مفتاح Metered | يبقى على الخادم فقط |
| `METERED_REGION` | فارغ أو منطقة | منطقة Metered اختيارية |
| `STUN_SERVERS` | Google STUN | بديل عند غياب Metered |
| `LOG_REQUESTS` | `false` | تسجيل كل طلب (للتشخيص فقط) |

كل القيم موجودة موثّقة في `.env.example`.

---

## 6. إعداد Metered TURN

TURN مهم للشبكات المقيّدة: شبكات الجوال، Wi-Fi الفنادق، شبكات الشركات، وCGNAT. **رفع
الكاميرا لا يحتاج TURN**، لكن مشاهدة WebRTC من تلك الشبكات قد تحتاجه.

### 6.1 إنشاء تطبيق Metered

1. سجّل في <https://www.metered.ca/>.
2. افتح لوحة **TURN / Open Relay**.
3. أنشئ تطبيقًا جديدًا، مثل `mirsad`.
4. انسخ:
   - **App domain** — يبدو مثل `mirsad.metered.live`
   - **API key** — المفتاح السري

### 6.2 إضافته إلى Render

في Render ← الخدمة ← **Environment**:

```text
METERED_DOMAIN=mirsad.metered.live
METERED_API_KEY=ضع_المفتاح_هنا
METERED_REGION=
```

احفظ التغييرات وأعد النشر/التشغيل.

### 6.3 التحقق

```powershell
curl.exe https://YOUR-SERVICE.onrender.com/api/rtc/config
```

ابحث في الناتج عن:

```json
{ "source": "metered", "turn": true }
```

ويجب أن تظهر عناوين تبدأ بـ `turns:` ضمن `iceServers`. في الواجهة ستتحول شارة النقل من
`STUN` إلى `TURN`.

> مفتاح Metered لا يصل إلى المتصفح أبدًا. الخادم يجلب بيانات اعتماد قصيرة العمر ويخزّنها
> لمدة 30 دقيقة.

---

## 7. برمجة ESP32-CAM

### 7.1 تجهيز Arduino IDE

1. افتح **File ← Preferences ← Additional Boards Manager URLs** وأضف:
   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
2. **Tools ← Board ← Boards Manager** ← ابحث عن `esp32` ← ثبّت **ESP32 by Espressif Systems**.
3. لا تحتاج مكتبات إضافية للكاميرا؛ `esp_camera.h` مضمّن مع حزمة ESP32.

### 7.2 توصيل USB-TTL

| USB-TTL | ESP32-CAM | ملاحظة |
| --- | --- | --- |
| `5V` | `5V` | مصدر 5 فولت / 1 أمبير |
| `GND` | `GND` | الأرضي المشترك إلزامي |
| `TX` | `U0RXD` (GPIO 3) | TX ← RX |
| `RX` | `U0TXD` (GPIO 1) | RX ← TX |
| — | `GPIO 0` ← `GND` | فقط أثناء الرفع |
| — | `RST` | لإعادة التشغيل / بدء الرفع |

### 7.3 تعديل الكود

يوجد كودان للكاميرا. **الموصى به** هو الذي يحفظ بيانات الواي فاي عبر بوابة
`ESP32-CAM-Config`، فلا تُكتب كلمة سر الشبكة في الكود:

```text
firmware/esp32cam-wifimanager/esp32cam-wifimanager.ino
```

ما زال يحتاج إعدادات الخادم التالية (`SERVER_URL`، `UPLOAD_TOKEN`، `DEVICE_ID`،
`USE_RGB565_BIG_ENDIAN`، `TARGET_FPS`). بعد الرفع، اتصل بشبكة **`ESP32-CAM-Config`** من
هاتفك أو حاسوبك واختر شبكة المنزل. لتغيير الشبكة لاحقًا، امسح الفلاش ثم أعد التشغيل.

البديل بكلمة سر مكتوبة في الكود هو
`firmware/esp32cam-streamer/esp32cam-streamer.ino`:

```cpp
const char *WIFI_SSID     = "اسم_شبكة_الواي_فاي";
const char *WIFI_PASSWORD = "كلمة_سر_الواي_فاي";
const char *SERVER_URL    = "https://YOUR-SERVICE.onrender.com/api/upload-frame";
const char *UPLOAD_TOKEN  = "نفس_قيمة_Render";
const char *DEVICE_ID     = "ESP32-CAM-01";
const bool  USE_RGB565_BIG_ENDIAN = true;
const int   TARGET_FPS    = 4;
```

- ضع رابط **Render** الخاص بك، ولا تُضف `?w=...` إلى `SERVER_URL`؛ الكود يضيفها تلقائيًا.
- إذا كانت الألوان معكوسة (سماء برتقالية وبشرة زرقاء) غيّر
  `USE_RGB565_BIG_ENDIAN` إلى `false`.
- ابدأ بـ `TARGET_FPS = 4`. كل إطار 153,600 بايت (320×240 RGB565)، أي نحو 4.9 ميجابت/ثانية.

### 7.4 إعدادات الرفع في Arduino IDE

- **Board:** AI Thinker ESP32-CAM
- **CPU Frequency:** 240 MHz
- **Flash Frequency:** 40 MHz
- **Partition Scheme:** Huge APP (3MB No OTA/1MB SPIFFS)
- **PSRAM:** Enabled
- **Upload Speed:** 115200 (جرّب 460800 إذا كانت الوصلة مستقرة)

### 7.5 خطوات الرفع

1. صل `GPIO 0` بـ `GND`.
2. اضغط **RST** مرة واحدة.
3. اضغط **Upload** في Arduino IDE.
4. عند اكتمال الرفع: افصل `GPIO 0` عن `GND`، ثم اضغط **RST**.
5. افتح **Serial Monitor** بسرعة **115200**.

إذا توقّف الرفع عند `Connecting........_____`، استمر بالضغط على **RST** وأفلته لحظة بدء
النقاط. تأكد أيضًا من تثبيت كابل الكاميرا (الأطراف الذهبية نحو اللوحة) ومن قوة مصدر 5V.

---

## 8. برمجة ESP32 38-pin

### 8.1 المكتبات

**Tools ← Manage Libraries** وثبّت:

- **DHT sensor library** by Adafruit
- **Adafruit Unified Sensor**
- **Adafruit BMP280** (اختياري، للضغط الجوي)

### 8.2 التوصيل

| الحساس | طرف الحساس | ESP32 38-pin | ملاحظة |
| --- | --- | --- | --- |
| DHT22 | VCC / DATA / GND | 3V3 / GPIO 4 / GND | مقاومة 10k بين DATA و3V3 |
| حساس رطوبة التربة | AO / VCC / GND | GPIO 34 / 3V3 / GND | ADC1 فقط |
| LDR | AO / VCC / GND | GPIO 35 / 3V3 / GND | ADC1 فقط |
| MQ-135 | AO / VCC / GND | GPIO 32 / 5V / GND | تسخين 2–3 دقائق |
| PIR HC-SR501 | OUT / VCC / GND | GPIO 27 / 5V / GND | انتظر ~30 ثانية |
| BMP280 (اختياري) | SDA / SCL / VCC | GPIO 21 / GPIO 22 / 3V3 | I2C |
| بطارية (اختياري) | منتصف المقسم | GPIO 33 | مقسم 2:1 بحد أقصى 4.2V |
| LED الحالة | LED | GPIO 2 | غالبًا مدمج |

> **تحذير:** أطراف ADC في ESP32 تتحمل **0–3.3 فولت فقط**. لا تُدخل 5 فولت إلى أي GPIO.
> استخدم GPIO 32–39 للمداخل التناظرية (ADC1)، لأن ADC2 يتوقف أثناء تشغيل Wi-Fi.

### 8.3 تعديل الكود

افتح:

```text
firmware/esp32-sensor-node/esp32-sensor-node.ino
```

وعدّل:

```cpp
const char *WIFI_SSID     = "اسم_شبكة_الواي_فاي";
const char *WIFI_PASSWORD = "كلمة_سر_الواي_فاي";
const char *SERVER_URL    = "https://YOUR-SERVICE.onrender.com/api/sensors";
const char *UPLOAD_TOKEN  = "نفس_قيمة_Render";
const char *DEVICE_ID     = "ESP32-SENSOR-38P";
const uint32_t SEND_INTERVAL_MS = 2000;
```

لمعايرة حساس التربة:

```cpp
const int SOIL_DRY_RAW = 3200;   // الحساس في الهواء الجاف
const int SOIL_WET_RAW = 1400;   // الحساس في كوب ماء
```

افتح Serial Monitor بسرعة 115200 لرؤية القيم الخام وضبط الأرقام بدقة.

### 8.4 الرفع

- **Board:** ESP32 Dev Module
- **Upload Speed:** 921600 (أو 115200 عند عدم الاستقرار)
- **Flash Size:** 4 MB
- **PSRAM:** Disabled (إلا إذا كانت لوحتك تدعمها)

إذا لم تدخل اللوحة وضع التحميل تلقائيًا، اضغط مع الاستمرار على **BOOT** أثناء بدء الرفع.

بعد النجاح يجب أن يظهر في Serial Monitor شيء مثل:

```text
[wifi] connected, IP=192.168.1.42 RSSI=-57 dBm
[relay] https://YOUR-SERVICE.onrender.com/api/sensors
[sensors] sending every 2000 ms
[sensors] packet #1 accepted (182 bytes)
```

---

## 9. التحقق النهائي

1. افتح رابط Render:

   ```text
   https://YOUR-SERVICE.onrender.com
   ```

2. بعد وصول أول إطار من الكاميرا تتحول شارة المصدر من `OFF` إلى `LIVE`.
3. خلال ثانيتين تظهر قراءات الحساسات الحقيقية بدل القيم التجريبية.
4. جرّب أوضاع النقل: **WebSocket** ثم **WebRTC** ثم **MJPEG** ثم **HTTP**.
5. عند وجود Metered تظهر شارة `TURN`، وإلا تظهر `STUN`.

فحص الخادم من الجهاز:

```powershell
curl.exe https://YOUR-SERVICE.onrender.com/healthz
curl.exe https://YOUR-SERVICE.onrender.com/api/status
curl.exe https://YOUR-SERVICE.onrender.com/api/sensors/devices
curl.exe https://YOUR-SERVICE.onrender.com/api/rtc/config
```

الناتج المتوقع من `/healthz`:

```json
{ "ok": true, "camera": "live", "sensors": "live" }
```

(أو `demo` قبل توصيل العتاد.)

يمكنك أيضًا اختبار النشر بالكامل من جهازك:

```powershell
node tools/e2e-check.js https://YOUR-SERVICE.onrender.com
node tools/webrtc-check.js https://YOUR-SERVICE.onrender.com
node tools/ui-check.js https://YOUR-SERVICE.onrender.com
```

---

## 10. تحديث المشروع لاحقًا

بعد أي تعديل محلي:

```powershell
git add .
git commit -m "وصف التعديل"
git push
```

Render يعيد النشر تلقائيًا لأن `autoDeploy: true` في `render.yaml`. يمكنك أيضًا الضغط على
**Manual Deploy ← Deploy latest commit** من لوحة Render.

---

## 11. حل المشاكل

| العرض | السبب المحتمل | الحل |
| --- | --- | --- |
| تبقى الواجهة على `OFF` أو "بانتظار الإشارة" | الكاميرا لا تصل إلى الخادم | تحقق من `SERVER_URL` الكامل، ومن Serial Monitor، ومن اتصال Wi-Fi |
| `HTTP 401` عند الرفع | `UPLOAD_TOKEN` غير متطابق | اجعل القيمة نفسها في الكود وفي Render |
| `HTTP 400 Expected … bytes` | أبعاد أو صيغة خاطئة | استخدم `320×240` و`rgb565be` أو `rgb565le` |
| الألوان معكوسة | ترتيب بايتات RGB565 | اقلب `USE_RGB565_BIG_ENDIAN` |
| ESP32-CAM يعيد التشغيل | مصدر طاقة ضعيف | 5V / 1A + أسلاك قصيرة + مكثف 470–1000µF |
| `[camera] init failed: 0x105` | الكاميرا غير متصلة | أعد تثبيت الكابل، تحقق من PSRAM والطاقة |
| `GET /api/frame.jpg` يعيد 404 | لا يوجد إطار بعد | شغّل الكاميرا، أو اضبط `DEMO_FALLBACK=true` لاختبار الواجهة فقط |
| WebRTC يتصل بلا صور | لا توجد إطارات أو الشبكة تمنع الاتصال | تحقق من `/api/status` ومن إعداد Metered |
| شارة TURN تبقى STUN | Metered غير مضبوط | أضف `METERED_DOMAIN` و`METERED_API_KEY` وأعد النشر |
| الحساسات تظهر `--` | لا يوجد باكت واصل | تحقق من `/api/sensors` ومن جسم JSON |
| Render بطيء عند أول فتح | الخطة المجانية تنام | انتظر ثوانٍ؛ العملاء يعيدون الاتصال تلقائيًا |
| التيار/الحساسات تختفي بعد إعادة النشر | التخزين في الذاكرة فقط | هذا متوقع؛ تعود بعد أول إطار/قراءة جديدة |
| `nan` في الحرارة/الرطوبة | طرف DHT أو مقاومة السحب | تحقق من GPIO 4 ومن مقاومة 10k |
| MQ-135 لا يتغير | لم يسخن بعد | انتظر 2–3 دقائق وتأكد من تغذية 5V |

---

## 12. ملاحظات الأمان والتكلفة

- **اضبط `UPLOAD_TOKEN`** قبل نشر الرابط. بدونه يستطيع أي شخص إرسال بيانات.
- **لا ترفع `.env`** إلى GitHub. استخدم متغيرات Render.
- **`METERED_API_KEY` سري** ويبقى على الخادم؛ المتصفح يحصل على بيانات مؤقتة فقط.
- **`ALLOWED_ORIGINS`** اجعله نطاقك بدل `*` عند الاستخدام الإنتاجي.
- شهادة TLS على Render تلقائية. الكاميرا تستخدم `setInsecure()` لتسهيل التجربة؛ في إنتاج
  صارم ثبّت شهادة الجذر عبر `setCACert()`.
- **الخطة المجانية في Render** تُوقف الخدمة بعد فترة خمول، وأول طلب بعدها يستغرق ثوانٍ.
- الصور وسجل الحساسات في **الذاكرة فقط**؛ إعادة تشغيل الخدمة تمسحهما حتى يصل إطار/قراءة جديدة.
- لا توجد قاعدة بيانات ولا تسجيل صوتي. الفيديو فقط، وجميع الفلاتر تعمل داخل المتصفح.

---

## روابط سريعة

- الكود الكامل وشرح API: [`README.md`](../README.md)
- مرجع الـ API: [`docs/API.md`](API.md)
- دليل العتاد والتوصيل: [`firmware/README.md`](../firmware/README.md)
- Render: <https://dashboard.render.com/>
- Metered: <https://www.metered.ca/>
- GitHub: <https://github.com/new>
