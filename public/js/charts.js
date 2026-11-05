const rgba = (hex, alpha) => {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

function prepare(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function smoothLine(ctx, points) {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    ctx.quadraticCurveTo(current.x, current.y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}

export class Sparkline {
  constructor(canvas, color = '#22d3ee') {
    this.canvas = canvas;
    this.color = color;
    this.values = [];
    this.ctx = canvas.getContext('2d');
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas);
  }

  setValues(values) {
    this.values = (values || []).filter((value) => Number.isFinite(value)).slice(-36);
    this.draw();
  }

  setColor(color) {
    this.color = color;
    this.draw();
  }

  draw() {
    const { ctx, width, height } = prepare(this.canvas);
    if (width < 4 || height < 4) return;
    if (this.values.length < 2) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height - 6);
      ctx.lineTo(width, height - 6);
      ctx.stroke();
      return;
    }

    let min = Math.min(...this.values);
    let max = Math.max(...this.values);
    if (max - min < 1) {
      max += 0.5;
      min -= 0.5;
    }
    const span = max - min;
    const top = 5;
    const bottom = height - 5;
    const pad = 2;

    const points = this.values.map((value, index) => ({
      x: pad + (index / (this.values.length - 1)) * (width - pad * 2),
      y: bottom - ((value - min) / span) * (bottom - top),
    }));

    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, rgba(this.color, 0.28));
    gradient.addColorStop(1, rgba(this.color, 0));

    ctx.beginPath();
    smoothLine(ctx, points);
    ctx.lineTo(points[points.length - 1].x, height);
    ctx.lineTo(points[0].x, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    smoothLine(ctx, points);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = rgba(this.color, 0.55);
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }
}

export class TelemetryChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.points = [];
    this.hoverIndex = null;
    this.labels = options.labels || {};
    this.lang = options.lang || 'ar';
    this.ctx = canvas.getContext('2d');
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas);

    canvas.addEventListener('mousemove', (event) => {
      const rect = canvas.getBoundingClientRect();
      this.pointerX = event.clientX - rect.left;
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => {
      this.pointerX = null;
      this.draw();
    });
    canvas.addEventListener(
      'touchmove',
      (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        const rect = canvas.getBoundingClientRect();
        this.pointerX = touch.clientX - rect.left;
        this.draw();
      },
      { passive: true },
    );
    canvas.addEventListener('touchend', () => {
      this.pointerX = null;
      this.draw();
    });
  }

  setLabels(labels, lang) {
    this.labels = { ...this.labels, ...labels };
    if (lang) this.lang = lang;
    this.draw();
  }

  setPoints(points) {
    this.points = (points || []).filter((point) => point && Number.isFinite(point.t)).slice(-90);
    this.draw();
  }

  draw() {
    const { ctx, width, height } = prepare(this.canvas);
    if (width < 20 || height < 20) return;

    const pad = { top: 18, right: 40, bottom: 26, left: 42 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const font = '11px "IBM Plex Sans Arabic", "Space Grotesk", system-ui, sans-serif';

    ctx.font = font;
    ctx.textBaseline = 'middle';

    const tempMin = 10;
    const tempMax = 45;
    const yFor = (value) => pad.top + plotH - (Math.max(0, Math.min(100, value)) / 100) * plotH;
    const yForTemp = (value) =>
      pad.top + plotH - ((Math.max(tempMin, Math.min(tempMax, value)) - tempMin) / (tempMax - tempMin)) * plotH;

    // Grid + left axis (%)
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = pad.top + (plotH / 4) * i;
      ctx.strokeStyle = i === 4 ? 'rgba(148, 163, 184, 0.22)' : 'rgba(148, 163, 184, 0.09)';
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.62)';
      ctx.textAlign = 'right';
      ctx.fillText(`${100 - i * 25}`, pad.left - 8, y);
    }

    // Right axis (temperature)
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(251, 146, 60, 0.75)';
    const rightX = pad.left + plotW + 8;
    ctx.fillText(`${tempMax}°`, rightX, pad.top);
    ctx.fillText(`${tempMin}°`, rightX, pad.top + plotH);

    if (this.points.length < 2) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.textAlign = 'center';
      ctx.font = `13px "IBM Plex Sans Arabic", "Space Grotesk", system-ui, sans-serif`;
      ctx.fillText(this.labels.waiting || 'Waiting for telemetry…', pad.left + plotW / 2, pad.top + plotH / 2);
      return;
    }

    const series = [
      { key: 'humidity', color: '#22d3ee', scale: 'percent', width: 2.1 },
      { key: 'soil', color: '#a3e635', scale: 'percent', width: 1.7 },
      { key: 'temperature', color: '#fb923c', scale: 'temp', width: 2 },
    ];

    const xFor = (index) => pad.left + (index / Math.max(1, this.points.length - 1)) * plotW;

    // Area under humidity
    const humidityPoints = this.points
      .map((point, index) => (Number.isFinite(point.humidity) ? { x: xFor(index), y: yFor(point.humidity) } : null))
      .filter(Boolean);
    if (humidityPoints.length > 1) {
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      gradient.addColorStop(0, 'rgba(34, 211, 238, 0.20)');
      gradient.addColorStop(1, 'rgba(34, 211, 238, 0)');
      ctx.beginPath();
      smoothLine(ctx, humidityPoints);
      ctx.lineTo(humidityPoints[humidityPoints.length - 1].x, pad.top + plotH);
      ctx.lineTo(humidityPoints[0].x, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top - 4, plotW, plotH + 8);
    ctx.clip();

    for (const config of series) {
      const points = this.points
        .map((point, index) => {
          const value = point[config.key];
          if (!Number.isFinite(value)) return null;
          return {
            x: xFor(index),
            y: config.scale === 'temp' ? yForTemp(value) : yFor(value),
          };
        })
        .filter(Boolean);

      if (points.length < 2) continue;
      ctx.beginPath();
      smoothLine(ctx, points);
      ctx.strokeStyle = config.color;
      ctx.lineWidth = config.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = rgba(config.color, 0.45);
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = config.color;
      ctx.fill();
    }
    ctx.restore();

    // X axis labels
    const labelCount = Math.min(4, this.points.length);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.textAlign = 'center';
    for (let i = 0; i < labelCount; i += 1) {
      const index = Math.round((i / Math.max(1, labelCount - 1)) * (this.points.length - 1));
      const point = this.points[index];
      const x = xFor(index);
      const time = new Date(point.t).toLocaleTimeString(this.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
      ctx.fillText(time, x, pad.top + plotH + 15);
    }

    // Hover crosshair + tooltip
    if (this.pointerX !== null && this.pointerX !== undefined) {
      const ratio = (this.pointerX - pad.left) / plotW;
      const index = Math.max(0, Math.min(this.points.length - 1, Math.round(ratio * (this.points.length - 1))));
      const point = this.points[index];
      const x = xFor(index);

      ctx.strokeStyle = 'rgba(226, 232, 240, 0.24)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      const rows = [
        { label: this.labels.temperature, value: point.temperature, unit: '°C', color: '#fb923c' },
        { label: this.labels.humidity, value: point.humidity, unit: '%', color: '#22d3ee' },
        { label: this.labels.soil, value: point.soil, unit: '%', color: '#a3e635' },
      ].filter((row) => Number.isFinite(row.value));

      const boxW = 142;
      const boxH = 18 + rows.length * 17;
      const boxX = Math.min(width - boxW - 8, Math.max(8, x + (this.lang === 'ar' ? -boxW - 12 : 12)));
      const boxY = pad.top + 6;

      ctx.fillStyle = 'rgba(7, 11, 26, 0.92)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 10);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = this.lang === 'ar' ? 'right' : 'left';
      ctx.font = font;
      rows.forEach((row, rowIndex) => {
        const y = boxY + 15 + rowIndex * 17;
        ctx.fillStyle = row.color;
        ctx.beginPath();
        ctx.arc(this.lang === 'ar' ? boxX + boxW - 12 : boxX + 12, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(226, 232, 240, 0.78)';
        ctx.fillText(row.label, this.lang === 'ar' ? boxX + boxW - 22 : boxX + 22, y);
        ctx.textAlign = this.lang === 'ar' ? 'left' : 'right';
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(`${Number(row.value).toFixed(1)}${row.unit}`, this.lang === 'ar' ? boxX + 10 : boxX + boxW - 10, y);
        ctx.textAlign = this.lang === 'ar' ? 'right' : 'left';
      });
    }
  }
}

export function drawSparklineFallback(canvas, values, color) {
  const spark = new Sparkline(canvas, color);
  spark.setValues(values);
  return spark;
}
