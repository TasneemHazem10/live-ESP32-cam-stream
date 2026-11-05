/**
 * RGB565 -> RGBA conversion.
 *
 * The ESP32-CAM (RHYX-M21-45) sends raw 16-bit RGB565 pixels. Browsers (and
 * JPEG encoders) need 8-bit RGBA, so we expand every channel with lookup
 * tables. 5/6-bit values are scaled to the full 0..255 range instead of being
 * simply shifted, which keeps white white and avoids a green/blue cast.
 */

const LUT5 = new Uint8Array(32);
const LUT6 = new Uint8Array(64);

for (let i = 0; i < 32; i += 1) LUT5[i] = Math.round((i * 255) / 31);
for (let i = 0; i < 64; i += 1) LUT6[i] = Math.round((i * 255) / 63);

export function parseFormat(value, fallback = 'rgb565le') {
  const raw = String(value || fallback).toLowerCase().replace(/[-_\s]/g, '');
  if (['rgb565', 'rgb565le', 'le', 'little', 'littleendian'].includes(raw)) {
    return { raw: 'rgb565', bigEndian: false };
  }
  if (['rgb565be', 'be', 'big', 'bigendian'].includes(raw)) {
    return { raw: 'rgb565', bigEndian: true };
  }
  if (['jpeg', 'jpg'].includes(raw)) return { raw: 'jpeg', bigEndian: false };
  return { raw: 'rgb565', bigEndian: false };
}

export function parseFlip(value) {
  const raw = String(value || '').toLowerCase();
  return {
    flipX: raw.includes('x') || raw === 'horizontal' || raw === 'h',
    flipY: raw.includes('y') || raw === 'vertical' || raw === 'v',
  };
}

export function isJpeg(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  );
}

/**
 * @param {Buffer} buffer raw RGB565 payload
 * @param {number} width
 * @param {number} height
 * @param {{bigEndian?: boolean, flipX?: boolean, flipY?: boolean, rgba?: Buffer}} options
 * @returns {Buffer} RGBA pixels (width * height * 4)
 */
export function rgb565ToRgba(buffer, width, height, options = {}) {
  const { bigEndian = false, flipX = false, flipY = false } = options;
  const pixels = width * height;
  const expected = pixels * 2;

  if (!Buffer.isBuffer(buffer) || buffer.length < expected) {
    throw new Error(`Expected ${expected} bytes for ${width}x${height} RGB565, received ${buffer?.length ?? 0}`);
  }

  const out = options.rgba && options.rgba.length === pixels * 4 ? options.rgba : Buffer.allocUnsafe(pixels * 4);

  for (let y = 0; y < height; y += 1) {
    const srcY = flipY ? height - 1 - y : y;
    const srcRow = srcY * width * 2;
    const dstRow = y * width * 4;

    for (let x = 0; x < width; x += 1) {
      const srcX = flipX ? width - 1 - x : x;
      const i = srcRow + srcX * 2;
      const pixel = bigEndian
        ? (buffer[i] << 8) | buffer[i + 1]
        : buffer[i] | (buffer[i + 1] << 8);

      const o = dstRow + x * 4;
      out[o] = LUT5[(pixel >> 11) & 0x1f];
      out[o + 1] = LUT6[(pixel >> 5) & 0x3f];
      out[o + 2] = LUT5[pixel & 0x1f];
      out[o + 3] = 255;
    }
  }

  return out;
}
