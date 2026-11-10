// Simulate the ESP32-CAM by publishing JPEG frames to the same MQTT broker the
// firmware uses. Handy for testing the dashboard without hardware:
//
//   npm run sim:mqtt
//
// It draws a moving colour pattern so you can tell the stream is live.
import mqtt from 'mqtt';
import jpeg from 'jpeg-js';

const BROKER_URL = process.env.MQTT_URL || 'wss://public.cloud.shiftr.io';
const TOPIC = process.env.MQTT_TOPIC || 'mirsad/live/a7f3c9e1d84b4f06b2a5';
const USER = process.env.MQTT_USER || 'public';
const PASS = process.env.MQTT_PASS || 'public';
const WIDTH = 320;
const HEIGHT = 240;
const FPS = Number(process.env.FPS || 15);

const client = mqtt.connect(BROKER_URL, {
  clientId: `mirsad_sim_${Math.random().toString(16).slice(2, 10)}`,
  username: USER,
  password: PASS,
  reconnectPeriod: 2000,
});

let frame = 0;
let timer = null;

function render(t) {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const wave = Math.sin((x + t) / 24) * 0.5 + 0.5;
      const band = Math.sin((y - t * 1.7) / 18) * 0.5 + 0.5;
      data[i] = Math.round(40 + wave * 200);
      data[i + 1] = Math.round(30 + band * 180);
      data[i + 2] = Math.round(90 + (1 - wave) * 140);
      data[i + 3] = 255;
    }
  }
  // A moving white box makes dropped frames obvious.
  const bx = ((t * 3) % (WIDTH - 40));
  const by = ((t * 2) % (HEIGHT - 40));
  for (let y = by; y < by + 40; y++) {
    for (let x = bx; x < bx + 40; x++) {
      const i = (y * WIDTH + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
    }
  }
  return jpeg.encode({ data, width: WIDTH, height: HEIGHT }, 55).data;
}

client.on('connect', () => {
  console.log(`[sim] connected to ${BROKER_URL}, publishing ${FPS} fps to ${TOPIC}`);
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const buffer = render(frame++);
    client.publish(TOPIC, buffer, { qos: 0 }, (error) => {
      if (error) console.error('[sim] publish failed:', error.message);
      else if (frame % 20 === 0) console.log(`[sim] sent ${frame} frames (${buffer.length} bytes last)`);
    });
  }, Math.round(1000 / FPS));
});

client.on('error', (error) => console.error('[sim] broker error:', error.message));
client.on('close', () => console.log('[sim] connection closed'));

const stop = () => {
  if (timer) clearInterval(timer);
  client.end(true);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
