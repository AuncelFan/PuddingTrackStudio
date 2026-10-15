import coordtransform from 'coordtransform';

export const WORLD = 40075016.68557849;
export const BASEMAPS = {
  grid: { name: '离线坐标网格', attribution: '' },
  osm: { name: 'OpenStreetMap', attribution: '© OpenStreetMap contributors' },
  gaode: { name: '高德地图 · GCJ-02', attribution: '© 高德地图' },
};

export function project(lon, lat, basemap = 'grid') {
  if (basemap === 'gaode') [lon, lat] = coordtransform.wgs84togcj02(lon, lat);
  lat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return [lon * WORLD / 360, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * WORLD / (2 * Math.PI)];
}

export function fitCamera(points, width, height, basemap) {
  const coords = points.map(p => project(p[0], p[1], basemap));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, (maxY - minY) * width / height, 80) * 1.32;
  return { center: [(minX + maxX) / 2, (minY + maxY) / 2], span };
}

export function screenPoint(coord, camera, width, height) {
  const resolution = camera.span / width;
  return [width / 2 + (coord[0] - camera.center[0]) / resolution,
    height / 2 - (coord[1] - camera.center[1]) / resolution];
}

export function tileLayout(camera, width, height) {
  const resolution = camera.span / width;
  const zoom = Math.min(18, Math.max(0, Math.floor(Math.log2(WORLD / (256 * resolution)))));
  const n = 2 ** zoom;
  const tileMeters = WORLD / n;
  const left = camera.center[0] - camera.span / 2;
  const top = camera.center[1] + resolution * height / 2;
  const firstX = Math.floor((left + WORLD / 2) / tileMeters);
  const firstY = Math.floor((WORLD / 2 - top) / tileMeters);
  const lastX = Math.floor((left + camera.span + WORLD / 2) / tileMeters);
  const lastY = Math.floor((WORLD / 2 - top + resolution * height) / tileMeters);
  const size = tileMeters / resolution;
  const tiles = [];
  for (let y = firstY; y <= lastY; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = firstX; x <= lastX; x++) {
      tiles.push({ z: zoom, x: ((x % n) + n) % n, y,
        left: (x * tileMeters - WORLD / 2 - left) / resolution,
        top: (WORLD / 2 - y * tileMeters - top) / -resolution, size });
    }
  }
  return tiles;
}

function path(ctx, points, until = points.length - 1) {
  ctx.beginPath();
  for (let i = 0; i <= until; i++) {
    const p = points[i];
    if (i === 0 || p[2]) ctx.moveTo(p[0], p[1]);
    else ctx.lineTo(p[0], p[1]);
  }
}

function circle(ctx, x, y, radius, fill, stroke, lineWidth = 1) {
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

function marker(ctx, x, y, radius, style, color, unit, heading) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.18;
  circle(ctx, 0, 0, radius * 2.7, color);
  ctx.globalAlpha = 1;
  if (style === 'ring') {
    circle(ctx, 0, 0, radius, null, '#ffffff', 3 * unit);
    circle(ctx, 0, 0, radius, null, color, 1.5 * unit);
    circle(ctx, 0, 0, radius * 0.2, color);
  } else if (style === 'arrow') {
    ctx.rotate(heading);
    ctx.beginPath();
    ctx.moveTo(0, -radius); ctx.lineTo(radius * 0.8, radius);
    ctx.lineTo(0, radius * 0.55); ctx.lineTo(-radius * 0.8, radius); ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * unit; ctx.stroke();
  } else if (style === 'pin') {
    // The tip, rather than the centre of the pin, is anchored to the route.
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-radius * 0.55, -radius * 0.6, -radius, -radius, -radius, -radius * 1.35);
    ctx.arc(0, -radius * 1.35, radius, Math.PI, 0);
    ctx.bezierCurveTo(radius, -radius, radius * 0.55, -radius * 0.6, 0, 0);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * unit; ctx.stroke();
    circle(ctx, 0, -radius * 1.35, radius * 0.35, '#ffffff');
  } else if (style === 'crosshair') {
    circle(ctx, 0, 0, radius * 0.65, null, color, 1.5 * unit);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * unit; ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(dx * radius * 0.45, dy * radius * 0.45);
      ctx.lineTo(dx * radius, dy * radius);
    }
    ctx.stroke(); circle(ctx, 0, 0, radius * 0.16, color);
  } else {
    circle(ctx, 0, 0, radius, color, '#ffffff', 2 * unit);
    circle(ctx, 0, 0, radius * 0.24, '#ffffff');
  }
  ctx.restore();
}

export function clock(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Both browser and Skia use this exact renderer and the same immutable camera.
 * Basemap pixels are drawn separately in the editor; Node supplies a frozen tile mosaic.
 */
export function createScene({ createCanvas, track, config, camera, basemapImage = null, overlay = false }) {
  const { width, height } = config;
  const unit = Math.min(width, height) / 640;
  const base = createCanvas(width, height), route = createCanvas(width, height);
  const ctx = base.getContext('2d'), routeCtx = route.getContext('2d');
  const basemap = config.mode === 'map' ? config.basemap : 'grid';
  const projected = track.points.map(p => {
    const xy = screenPoint(project(p[0], p[1], basemap), camera, width, height);
    return [...xy, p[5]];
  });
  const lineWidth = config.lineWidth * unit;
  const routeAlpha = config.routeOpacity;
  const geometry = config.mode === 'geometry';
  const trailColor = config.trailColor || config.routeColor;
  // Directions are stable during stationary recordings and segment gaps.
  const headings = [];
  let heading = 0;
  for (let i = 0; i < projected.length; i++) {
    if (projected[i][2]) heading = 0;
    const next = projected[i + 1];
    if (next && !next[2] && Math.hypot(next[0] - projected[i][0], next[1] - projected[i][1]) > 0.001) {
      heading = Math.atan2(next[1] - projected[i][1], next[0] - projected[i][0]) + Math.PI / 2;
    }
    headings.push(heading);
  }
  ctx.lineCap = ctx.lineJoin = routeCtx.lineCap = routeCtx.lineJoin = 'round';
  if (geometry) {
    if (config.backgroundOpacity > 0) {
      ctx.globalAlpha = config.backgroundOpacity;
      ctx.fillStyle = config.backgroundColor;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
  } else if (basemap === 'grid') {
    ctx.fillStyle = config.backgroundColor;
    ctx.fillRect(0, 0, width, height);
    if (config.showGrid) {
      const meters = camera.span / 8;
      const step = 10 ** Math.floor(Math.log10(meters));
      const gridMeters = step * (meters / step >= 5 ? 5 : meters / step >= 2 ? 2 : 1);
      const resolution = camera.span / width;
      const left = camera.center[0] - camera.span / 2;
      const bottom = camera.center[1] - height * resolution / 2;
      ctx.strokeStyle = '#ffffff0d'; ctx.lineWidth = 1 * unit; ctx.beginPath();
      for (let x = Math.ceil(left / gridMeters) * gridMeters; x < left + camera.span; x += gridMeters) {
        const px = (x - left) / resolution; ctx.moveTo(px, 0); ctx.lineTo(px, height);
      }
      for (let y = Math.ceil(bottom / gridMeters) * gridMeters; y < bottom + height * resolution; y += gridMeters) {
        const py = height - (y - bottom) / resolution; ctx.moveTo(0, py); ctx.lineTo(width, py);
      }
      ctx.stroke();
    }
  } else if (basemapImage) {
    ctx.drawImage(basemapImage, 0, 0, width, height);
  } else if (!overlay) {
    ctx.fillStyle = '#e5e8e5'; ctx.fillRect(0, 0, width, height);
  }
  path(ctx, projected);
  if (!geometry && basemap !== 'grid') {
    // A dark outline keeps a small route legible on bright, detailed map tiles.
    ctx.globalAlpha = routeAlpha * 0.85;
    ctx.strokeStyle = '#15252d'; ctx.lineWidth = lineWidth + 3 * unit; ctx.stroke();
  }
  path(routeCtx, projected);
  routeCtx.globalAlpha = routeAlpha;
  routeCtx.strokeStyle = config.routeColor;
  routeCtx.lineWidth = lineWidth;
  if (geometry && config.glow) { routeCtx.shadowColor = config.routeColor; routeCtx.shadowBlur = 10 * unit; }
  routeCtx.stroke();
  ctx.globalAlpha = 1;
  const trail = config.showTrail && trailColor !== config.routeColor ? createCanvas(width, height) : null;
  const trailCtx = trail?.getContext('2d');
  let lastFrame = null;
  let lastVertex = -1;

  function colourTrail(vertex, xy) {
    if (lastVertex === vertex && lastFrame?.every((value, i) => value === xy[i])) return;
    // Start from the immutable route on every update. source-atop changes only
    // colour: the route's original alpha, line width and glow remain intact,
    // regardless of frame rate, pauses, crossings or playback history.
    trailCtx.clearRect(0, 0, width, height);
    trailCtx.drawImage(route, 0, 0);
    trailCtx.save();
    trailCtx.globalCompositeOperation = 'source-atop';
    trailCtx.strokeStyle = trailCtx.fillStyle = trailColor;
    if (vertex === projected.length - 1) {
      trailCtx.fillRect(0, 0, width, height);
    } else {
      trailCtx.lineCap = trailCtx.lineJoin = 'round';
      trailCtx.lineWidth = lineWidth;
      if (geometry && config.glow) { trailCtx.shadowColor = trailColor; trailCtx.shadowBlur = 10 * unit; }
      path(trailCtx, projected, vertex);
      const p = projected[vertex];
      if (p[0] !== xy[0] || p[1] !== xy[1]) trailCtx.lineTo(...xy);
      trailCtx.stroke();
    }
    trailCtx.restore();
    lastVertex = vertex; lastFrame = xy;
  }

  function drawLabels(ctx) {
    if (config.showEndpoints) {
      for (const [i, label] of [[0, 'S'], [projected.length - 1, 'F']]) {
        const [x, y] = projected[i];
        circle(ctx, x, y, 8 * unit, '#152026', '#dbe5e4', 1.5 * unit);
        ctx.font = `bold ${9 * unit}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e4ecec'; ctx.fillText(label, x, y + unit * 0.5);
      }
    }
    const attribution = geometry ? '' : BASEMAPS[basemap]?.attribution;
    if (attribution) {
      ctx.font = `${Math.max(9, 10 * unit)}px sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      const textWidth = ctx.measureText(attribution).width;
      ctx.fillStyle = '#ffffffd9'; ctx.fillRect(width - textWidth - 10, height - 18 * unit, textWidth + 10, 18 * unit);
      ctx.fillStyle = '#33444b'; ctx.fillText(attribution, width - 5, height - 3 * unit);
    }
  }

  return {
    draw(target, frame, frameIndex, plan) {
      const targetCtx = target.getContext('2d');
      const xy = screenPoint(project(frame[0], frame[1], basemap), camera, width, height);
      if (trail) colourTrail(frame[4], xy);
      targetCtx.clearRect(0, 0, width, height);
      targetCtx.drawImage(base, 0, 0);
      targetCtx.drawImage(trail || route, 0, 0);
      drawLabels(targetCtx);
      const radius = config.markerSize * unit;
      marker(targetCtx, ...xy, radius, config.markerStyle || 'dot', config.markerColor, unit,
        headings[Math.max(0, Math.min(headings.length - 1, frame[4]))]);
      if (config.showHud) {
        const x = 24 * unit, y = 24 * unit;
        targetCtx.fillStyle = '#10191fd9';
        targetCtx.fillRect(x - 10 * unit, y - 8 * unit, 125 * unit, 30 * unit);
        targetCtx.textAlign = 'left'; targetCtx.textBaseline = 'top';
        targetCtx.fillStyle = '#edf5f3'; targetCtx.font = `bold ${12 * unit}px sans-serif`;
        const progress = frame[6] ?? 0;
        targetCtx.fillText(`${Math.round(progress * 100)}%  /  ${(frame[3] / 1000).toFixed(2)} km`, x, y);
      }
    },
  };
}
