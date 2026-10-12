import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createScene, fitCamera, project, screenPoint, tileLayout, WORLD } from '../shared/scene.mjs';

const track = { points: [[120, 30, 0, 0, 0, true], [120.01, 30, 0, 10, 100, false], [120.01, 30.01, 0, 20, 200, false]] };
const config = { width: 320, height: 320, mode: 'map', basemap: 'grid', backgroundColor: '#15232c', backgroundOpacity: 1,
  routeColor: '#91e2bc', markerColor: '#ffbc7a', routeOpacity: 0.8, lineWidth: 4, markerSize: 7,
  showGrid: true, showTrail: false, showHud: false, showEndpoints: false, glow: false };
const plan = { frames: [[120, 30, 0, 0, 0, 0], [120.01, 30.005, 0, 150, 1, 15]], start: 0, end: 20, speed: 60 };
const pixels = (canvas, x, y, w = 1, h = 1) => canvas.getContext('2d').getImageData(x, y, w, h).data;

for (const markerStyle of ['dot', 'ring', 'arrow', 'pin', 'crosshair']) {
test(`${markerStyle}: camera and pixels outside the moving marker stay fixed`, () => {
  const camera = fitCamera(track.points, 320, 320, 'grid');
  const beforeCamera = JSON.stringify(camera);
  const scene = createScene({ createCanvas, track, config: { ...config, markerStyle }, camera });
  const a = createCanvas(320, 320), b = createCanvas(320, 320);
  scene.draw(a, plan.frames[0], 0, plan); scene.draw(b, plan.frames[1], 1, plan);
  assert.equal(JSON.stringify(camera), beforeCamera);
  const centers = plan.frames.map(frame => screenPoint(project(frame[0], frame[1]), camera, 320, 320));
  const first = pixels(a, 0, 0, 320, 320), last = pixels(b, 0, 0, 320, 320);
  let changed = 0;
  for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) {
    const offset = (y * 320 + x) * 4;
    const differs = first.slice(offset, offset + 4).some((v, i) => v !== last[offset + i]);
    if (differs) {
      changed++;
      assert.ok(centers.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < 12), `Unexpected moving background at ${x},${y}`);
    }
  }
  assert.ok(changed > 50, 'marker must actually move');
});
}

test('HUD uses the backend distance progress and omits time and speed', () => {
  const camera = fitCamera(track.points, 320, 320, 'grid');
  const canvas = createCanvas(320, 320), ctx = canvas.getContext('2d');
  const text = [], drawText = ctx.fillText;
  ctx.fillText = function (value, ...args) { text.push(value); drawText.call(this, value, ...args); };
  const scene = createScene({ createCanvas, track, config: { ...config, showHud: true }, camera });
  scene.draw(canvas, [...plan.frames[1], 0.37], 1, { ...plan, speed: 240 });
  assert.deepEqual(text, ['37%  /  0.15 km']);
});

test('travelled path uses its custom colour while the remaining path keeps the route colour', () => {
  const camera = fitCamera(track.points, 320, 320, 'grid');
  const canvas = createCanvas(320, 320);
  const scene = createScene({ createCanvas, track,
    config: { ...config, routeColor: '#ff0000', trailColor: '#2244ff', routeOpacity: 1, showTrail: true }, camera });
  scene.draw(canvas, plan.frames[1], 1, plan);
  const sample = (lon, lat) => {
    const [x, y] = screenPoint(project(lon, lat), camera, 320, 320);
    return pixels(canvas, Math.round(x), Math.round(y));
  };
  const travelled = sample(120.005, 30), ahead = sample(120.01, 30.008);
  assert.ok(travelled[2] > travelled[0] * 2, 'Passed path must use the custom blue');
  assert.ok(ahead[0] > ahead[2] * 2, 'Unvisited path must retain red');
  scene.draw(canvas, plan.frames[0], 0, plan);
  const rewound = sample(120.005, 30);
  assert.ok(rewound[0] > rewound[2] * 2, 'Seeking backwards must remove the old trail');
});

test('transparent geometry retains fractional route alpha and empty background alpha', () => {
  const transparent = { ...config, mode: 'geometry', backgroundOpacity: 0, routeOpacity: 0.5 };
  const camera = fitCamera(track.points, 320, 320, 'grid');
  const canvas = createCanvas(320, 320);
  const scene = createScene({ createCanvas, track, config: transparent, camera });
  scene.draw(canvas, plan.frames[0], 0, plan);
  assert.equal(pixels(canvas, 0, 0)[3], 0);
  const [x, y] = screenPoint(project(120.005, 30), camera, 320, 320);
  const alpha = pixels(canvas, Math.round(x), Math.round(y))[3];
  assert.ok(alpha > 100 && alpha < 150, `Expected half alpha, got ${alpha}`);
});

test('getImageData supplies straight RGBA for translucent FFmpeg input', () => {
  const canvas = createCanvas(1, 1), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255, 0, 0, 0.5)'; ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  assert.deepEqual([...data], [255, 0, 0, 127]);
});

test('seeking backwards produces exactly the same image as a fresh scene', () => {
  const camera = fitCamera(track.points, 320, 320, 'grid');
  const options = { createCanvas, track, config: { ...config, showTrail: true }, camera };
  const scene = createScene(options), fresh = createScene(options);
  const a = createCanvas(320, 320), b = createCanvas(320, 320);
  scene.draw(a, plan.frames[1], 1, plan); scene.draw(a, plan.frames[0], 0, plan);
  fresh.draw(b, plan.frames[0], 0, plan);
  assert.deepEqual(a.data(), b.data());
});

test('tile mosaic covers a viewport and wraps at the date line', () => {
  const camera = { center: [WORLD / 2, 0], span: 200000 };
  const tiles = tileLayout(camera, 640, 640);
  assert.ok(tiles.some(t => t.x === 0));
  assert.ok(tiles.some(t => t.x === 2 ** t.z - 1));
  assert.ok(tiles.some(t => t.left <= 0 && t.left + t.size > 0));
  assert.ok(tiles.some(t => t.top <= 0 && t.top + t.size > 0));
  assert.ok(tiles.every(t => t.x >= 0 && t.y >= 0 && t.y < 2 ** t.z));
});
