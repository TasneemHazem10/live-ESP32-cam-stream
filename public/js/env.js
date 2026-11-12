// Backend base URL for the relay that receives ESP32-CAM frames.
//
// The dashboard is served by the relay itself (Render), so an empty value —
// same origin — is the normal setting. Nothing to configure, nothing to deploy
// separately, no CORS hop.
//
//   ""                        -> same origin (Render serves both the page and the API)
//   "https://…"               -> only for local UI work against a remote relay
//
// You can also override it for one session with ?api=https://… in the URL.
// This file is loaded before app.js, so window.MIRSAD_API_BASE is already set
// when public/js/runtime.js reads it.
window.MIRSAD_API_BASE = '';
