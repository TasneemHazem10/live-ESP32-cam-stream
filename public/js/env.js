// Backend base URL for the relay that receives ESP32-CAM frames.
//
//   ""                              -> same origin (dashboard served by the relay)
//   "https://mirsad-live.onrender.com" -> dashboard on Vercel, relay on Render
//
// You can also override it for one session with ?api=https://… in the URL.
// This file is loaded before app.js, so window.MIRSAD_API_BASE is already set
// when public/js/runtime.js reads it.
window.MIRSAD_API_BASE = 'https://live-esp32-cam-stream.onrender.com';
