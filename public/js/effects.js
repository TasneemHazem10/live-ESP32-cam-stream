export const EFFECTS = [
  { id: 'raw', icon: 'eye', nameKey: 'effects.raw.name', descKey: 'effects.raw.desc', accent: '#94a3b8' },
  { id: 'water', icon: 'droplet', nameKey: 'effects.water.name', descKey: 'effects.water.desc', accent: '#22d3ee' },
  { id: 'vegetation', icon: 'leaf', nameKey: 'effects.vegetation.name', descKey: 'effects.vegetation.desc', accent: '#a3e635' },
  { id: 'thermal', icon: 'thermometer', nameKey: 'effects.thermal.name', descKey: 'effects.thermal.desc', accent: '#fb923c' },
  { id: 'night', icon: 'moon', nameKey: 'effects.night.name', descKey: 'effects.night.desc', accent: '#34d399' },
  { id: 'edge', icon: 'edges', nameKey: 'effects.edge.name', descKey: 'effects.edge.desc', accent: '#38bdf8' },
  { id: 'cinematic', icon: 'film', nameKey: 'effects.cinematic.name', descKey: 'effects.cinematic.desc', accent: '#f472b6' },
  { id: 'invert', icon: 'invert', nameKey: 'effects.invert.name', descKey: 'effects.invert.desc', accent: '#c4b5fd' },
];

export const EFFECT_IDS = EFFECTS.map((effect) => effect.id);

const hexToRgb = (hex) => {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
};

function buildPalette(stops) {
  const palette = new Uint8Array(256 * 3);
  const points = stops.map(([position, color]) => ({ position, rgb: hexToRgb(color) }));

  for (let i = 0; i < 256; i += 1) {
    const v = i / 255;
    let left = points[0];
    let right = points[points.length - 1];
    for (let p = 0; p < points.length - 1; p += 1) {
      if (v >= points[p].position && v <= points[p + 1].position) {
        left = points[p];
        right = points[p + 1];
        break;
      }
    }
    const span = right.position - left.position || 1;
    const k = Math.max(0, Math.min(1, (v - left.position) / span));
    palette[i * 3] = Math.round(left.rgb[0] + (right.rgb[0] - left.rgb[0]) * k);
    palette[i * 3 + 1] = Math.round(left.rgb[1] + (right.rgb[1] - left.rgb[1]) * k);
    palette[i * 3 + 2] = Math.round(left.rgb[2] + (right.rgb[2] - left.rgb[2]) * k);
  }
  return palette;
}

const WATER = buildPalette([
  [0, '#020617'],
  [0.2, '#0c4a6e'],
  [0.42, '#0891b2'],
  [0.64, '#22d3ee'],
  [0.82, '#a5f3fc'],
  [1, '#f8fafc'],
]);

const VEGETATION = buildPalette([
  [0, '#0c0a09'],
  [0.2, '#365314'],
  [0.42, '#65a30d'],
  [0.62, '#a3e635'],
  [0.8, '#ecfccb'],
  [1, '#fefce8'],
]);

const THERMAL = buildPalette([
  [0, '#04010f'],
  [0.18, '#2e1065'],
  [0.35, '#7f1d1d'],
  [0.55, '#dc2626'],
  [0.72, '#f97316'],
  [0.87, '#fde047'],
  [1, '#ffffff'],
]);

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);

function palettePass(src, dst, palette, index, blend) {
  const s = src.data;
  const d = dst.data;
  const pixels = src.width * src.height;

  for (let i = 0, j = 0; i < pixels; i += 1, j += 4) {
    const r = s[j];
    const g = s[j + 1];
    const b = s[j + 2];
    const slot = (clamp01(index(r, g, b)) * 255) | 0;
    const p = slot * 3;
    d[j] = clamp255(r + (palette[p] - r) * blend);
    d[j + 1] = clamp255(g + (palette[p + 1] - g) * blend);
    d[j + 2] = clamp255(b + (palette[p + 2] - b) * blend);
    d[j + 3] = 255;
  }
}

function nightPass(src, dst, blend) {
  const s = src.data;
  const d = dst.data;
  const pixels = src.width * src.height;

  for (let i = 0, j = 0; i < pixels; i += 1, j += 4) {
    const r = s[j];
    const g = s[j + 1];
    const b = s[j + 2];
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    const boosted = Math.pow(lum, 0.62);
    const grain = (((i * 2654435761) >>> 0) % 97) / 97 - 0.5;
    const nr = boosted * 26 + grain * 9;
    const ng = boosted * 238 + grain * 14;
    const nb = boosted * 96 + grain * 11;

    d[j] = clamp255(r + (nr - r) * blend);
    d[j + 1] = clamp255(g + (ng - g) * blend);
    d[j + 2] = clamp255(b + (nb - b) * blend);
    d[j + 3] = 255;
  }
}

function edgePass(src, dst, blend) {
  const s = src.data;
  const d = dst.data;
  const { width, height } = src;
  const luma = new Float32Array(width * height);

  for (let i = 0, j = 0; i < luma.length; i += 1, j += 4) {
    luma[i] = s[j] * 0.299 + s[j + 1] * 0.587 + s[j + 2] * 0.114;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const j = (y * width + x) * 4;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        d[j] = clamp255(s[j] + (8 - s[j]) * blend);
        d[j + 1] = clamp255(s[j + 1] + (18 - s[j + 1]) * blend);
        d[j + 2] = clamp255(s[j + 2] + (28 - s[j + 2]) * blend);
        d[j + 3] = 255;
        continue;
      }

      const tl = luma[(y - 1) * width + (x - 1)];
      const tc = luma[(y - 1) * width + x];
      const tr = luma[(y - 1) * width + (x + 1)];
      const ml = luma[y * width + (x - 1)];
      const mr = luma[y * width + (x + 1)];
      const bl = luma[(y + 1) * width + (x - 1)];
      const bc = luma[(y + 1) * width + x];
      const br = luma[(y + 1) * width + (x + 1)];

      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const magnitude = Math.min(255, Math.sqrt(gx * gx + gy * gy) * 0.72);

      const nr = 5 + magnitude * 0.22;
      const ng = 10 + magnitude;
      const nb = 16 + magnitude * 0.88;

      d[j] = clamp255(s[j] + (nr - s[j]) * blend);
      d[j + 1] = clamp255(s[j + 1] + (ng - s[j + 1]) * blend);
      d[j + 2] = clamp255(s[j + 2] + (nb - s[j + 2]) * blend);
      d[j + 3] = 255;
    }
  }
}

function cinematicPass(src, dst, blend) {
  const s = src.data;
  const d = dst.data;
  const { width, height } = src;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const j = (y * width + x) * 4;
      const r = s[j];
      const g = s[j + 1];
      const b = s[j + 2];
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      const highlight = Math.pow(lum, 1.15);
      const shadow = Math.pow(1 - lum, 1.4);

      let nr = r * 1.06 + 30 * highlight - 22 * shadow;
      let ng = g * 1.01 + 10 * highlight - 6 * shadow;
      let nb = b * 0.96 - 10 * highlight + 36 * shadow;

      nr = (nr - 128) * 1.12 + 128;
      ng = (ng - 128) * 1.12 + 128;
      nb = (nb - 128) * 1.14 + 128;

      const vx = (x / width - 0.5) * 2;
      const vy = (y / height - 0.5) * 2;
      const vignette = 1 - 0.34 * Math.min(1, (vx * vx + vy * vy) * 0.92);

      nr *= vignette;
      ng *= vignette;
      nb *= vignette;

      d[j] = clamp255(r + (nr - r) * blend);
      d[j + 1] = clamp255(g + (ng - g) * blend);
      d[j + 2] = clamp255(b + (nb - b) * blend);
      d[j + 3] = 255;
    }
  }
}

function invertPass(src, dst, blend) {
  const s = src.data;
  const d = dst.data;
  for (let j = 0; j < s.length; j += 4) {
    d[j] = clamp255(s[j] + (255 - s[j] - s[j]) * blend);
    d[j + 1] = clamp255(s[j + 1] + (255 - s[j + 1] - s[j + 1]) * blend);
    d[j + 2] = clamp255(s[j + 2] + (255 - s[j + 2] - s[j + 2]) * blend);
    d[j + 3] = 255;
  }
}

/**
 * Applies a filter from src ImageData into dst ImageData.
 * `intensity` blends the filtered result with the original frame.
 */
export function applyEffect(effectId, src, dst, intensity = 1) {
  const blend = Math.max(0, Math.min(1, intensity));

  switch (effectId) {
    case 'water':
      palettePass(src, dst, WATER, (r, g, b) => {
        const green = (g - r) / (g + r + 30);
        const blue = (b - r) / (b + r + 30);
        return 0.47 + (green * 0.72 + blue * 0.28) * 1.65;
      }, blend);
      break;

    case 'vegetation':
      palettePass(src, dst, VEGETATION, (r, g, b) => 0.46 + ((g - r) / (g + r + 30)) * 1.85, blend);
      break;

    case 'thermal':
      palettePass(src, dst, THERMAL, (r, g, b) => {
        const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        return (lum - 0.03) * 1.14;
      }, blend);
      break;

    case 'night':
      nightPass(src, dst, blend);
      break;

    case 'edge':
      edgePass(src, dst, blend);
      break;

    case 'cinematic':
      cinematicPass(src, dst, blend);
      break;

    case 'invert':
      invertPass(src, dst, blend);
      break;

    default: {
      const s = src.data;
      const d = dst.data;
      for (let j = 0; j < s.length; j += 4) {
        d[j] = s[j];
        d[j + 1] = s[j + 1];
        d[j + 2] = s[j + 2];
        d[j + 3] = 255;
      }
    }
  }

  return dst;
}
