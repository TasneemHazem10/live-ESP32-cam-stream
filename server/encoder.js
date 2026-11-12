/**
 * RGB(A) -> JPEG encoding.
 *
 * The handover document asks for `sharp` (libvips). It is what we use when it is
 * installed: on Render's free plan (0.1 CPU) libvips encodes a 320x240 frame in
 * a few milliseconds, while the pure-JS `jpeg-js` encoder needs hundreds.
 *
 * `jpeg-js` stays as a fallback so the relay still runs on a machine where the
 * native libvips binary cannot be installed (for example an offline laptop with
 * a broken npm cache). Both paths produce a baseline JPEG that browsers accept.
 */

import jpeg from 'jpeg-js';

let sharpPromise = null;

async function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((module) => {
        const sharp = module.default || module;
        // One thread: the relay encodes one frame at a time, and on a 0.1 vCPU
        // instance extra libvips workers only add scheduling overhead.
        try {
          sharp.concurrency(1);
        } catch {
          /* libvips build without the setter */
        }
        return sharp;
      })
      .catch(() => null);
  }
  return sharpPromise;
}

/** Which encoder this process will use ("sharp" or "jpeg-js"). */
export async function getEncoder() {
  return (await loadSharp()) ? 'sharp' : 'jpeg-js';
}

/**
 * Encode a raw RGBA buffer as a baseline JPEG.
 *
 * @param {Buffer} rgba width * height * 4 bytes; alpha is ignored
 * @param {number} width
 * @param {number} height
 * @param {number} quality 1-100
 * @returns {Promise<Buffer>} JPEG bytes
 */
export async function encodeJpeg(rgba, width, height, quality) {
  const sharp = await loadSharp();
  if (sharp) {
    return sharp(rgba, { raw: { width, height, channels: 4 } })
      .jpeg({ quality })
      .toBuffer();
  }
  return jpeg.encode({ data: rgba, width, height }, quality).data;
}
