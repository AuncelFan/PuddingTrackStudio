import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { fitCamera, project, screenPoint } from '../shared/scene.mjs';
import { estimateOutputBytes, formatSizeEstimate } from '../shared/output-size.mjs';

const origin = process.env.TRACE_URL || 'http://127.0.0.1:8000';
const web = process.env.TRACE_WEB_URL || origin;
const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
async function request(path, body) {
  const response = await fetch(origin + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${response.statusText}`);
  return response.json();
}
const health = await request('/api/health');
assert.equal(health.status, 'ok');
const { tracks: [track] } = await request('/api/demo', {});
const camera = fitCamera(track.points, 320, 320, 'grid');
const framePlan = await request(`/api/tracks/${track.id}/plan`, { speed: 120, fps: 12, end: 240 });
assert.equal(framePlan.frameCount, 25);
const ffmpeg = process.env.FFMPEG_PATH || execFileSync('uv', ['run', 'python', '-c', 'from backend.jobs import ffmpeg_path; print(ffmpeg_path())'], { encoding: 'utf8' }).trim();
const hevcFFmpeg = health.hevcAlpha?.available ? health.hevcAlpha.ffmpeg : null;
const formats = ['mp4', 'webm', 'mov', ...(hevcFFmpeg ? ['hevc-alpha'] : [])];
if (process.env.TRACE_REQUIRE_HEVC_ALPHA) assert.ok(hevcFFmpeg, health.hevcAlpha?.reason);
if (!hevcFFmpeg) console.log(`HEVC Alpha skipped: ${health.hevcAlpha?.reason || 'not installed'}`);
const cases = formats.map(format => ({ format,
  backgroundOpacity: ['webm', 'hevc-alpha'].includes(format) ? 0 : format === 'mov' ? 0.35 : 1,
  filename: format === 'hevc-alpha' ? 'export-hevc-alpha.mov' : `export.${format}` }));
if (hevcFFmpeg) cases.push({ format: 'hevc-alpha', backgroundOpacity: 0.35, filename: 'export-hevc-alpha-semi.mov' });
const encodedSizes = {};

for (const { format, backgroundOpacity, filename } of cases) {
  const started = Date.now();
  const job = await request('/api/exports', { trackId: track.id, plan: { speed: 120, fps: 12, end: 240 }, camera,
    config: { format, width: 320, height: 320, mode: format === 'mp4' ? 'map' : 'geometry',
      backgroundOpacity,
      showTrail: false, showEndpoints: false, glow: false, routeOpacity: 0.5, lineWidth: 10 } });
  let result;
  do {
    await new Promise(resolve => setTimeout(resolve, 300));
    result = await request(`/api/exports/${job.id}`);
    assert.notEqual(result.status, 'failed', result.error);
    assert.ok(Date.now() - started < 60000, 'Render timeout');
  } while (result.status !== 'done');
  const response = await fetch(origin + result.downloadUrl);
  assert.ok(response.ok);
  assert.equal(result.format, format === 'hevc-alpha' ? 'mov' : format);
  const path = new URL(filename, output);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  const inputOptions = format === 'webm' ? ['-c:v', 'libvpx-vp9'] : [];
  // Decode every frame, so a truncated file or wrong output frame count fails verification.
  const decoder = format === 'hevc-alpha' ? hevcFFmpeg : ffmpeg;
  const rgba = execFileSync(decoder, ['-v', 'error', ...inputOptions, '-i', path.pathname,
    ...(format === 'hevc-alpha' ? ['-sws_flags', 'accurate_rnd+bitexact'] : []),
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(rgba.length, framePlan.frameCount * 320 * 320 * 4, 'Decoded frame count');
  if (['webm', 'hevc-alpha'].includes(format) && backgroundOpacity === 0) {
    assert.equal(rgba[3], 0, 'Transparent background');
    const routePoint = track.points[Math.floor(track.points.length / 2)];
    const [x, y] = screenPoint(project(routePoint[0], routePoint[1]), camera, 320, 320);
    const index = (Math.round(y) * 320 + Math.round(x)) * 4;
    assert.ok(rgba[index + 3] > 90 && rgba[index + 3] < 165, 'Fractional route alpha');
    assert.ok(rgba[index + 1] > 175, `Straight colour must survive encoding; green=${rgba[index + 1]}`);
  }
  if (format === 'hevc-alpha') {
    assert.equal(response.headers.get('content-type'), 'video/quicktime');
    assert.match(response.headers.get('content-disposition'), /\.mov/);
    const ffprobe = fileURLToPath(new URL('./ffprobe', `file://${hevcFFmpeg}`));
    const metadata = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.pathname], { encoding: 'utf8' }));
    assert.equal(metadata.streams.length, 1, 'Auxiliary alpha belongs to one HEVC stream');
    assert.equal(metadata.streams[0].codec_name, 'hevc');
    assert.equal(metadata.streams[0].codec_tag_string, 'hvc1');
    assert.equal(Number(metadata.streams[0].nb_frames), framePlan.frameCount);
    for (let frame = 0; frame < framePlan.frameCount; frame++) {
      assert.ok(Math.abs(rgba[frame * 320 * 320 * 4 + 3] - Math.round(backgroundOpacity * 255)) <= 4, 'Alpha survives every decoded frame');
    }
  }
  if (format === 'mov' || (format === 'hevc-alpha' && backgroundOpacity === 0.35)) {
    assert.ok(Math.abs(rgba[3] - 89) < 4, `Semi-transparent background alpha=${rgba[3]}`);
    assert.ok(Math.abs(rgba[1] - 35) < 4, `Straight background colour green=${rgba[1]}`);
  }
  assert.equal(result.frameCount, framePlan.frameCount);
  const estimate = estimateOutputBytes({ format, width: 320, height: 320, frameCount: framePlan.frameCount,
    mode: format === 'mp4' ? 'map' : 'geometry', basemap: 'grid' });
  assert.ok(estimate.min <= result.sizeBytes && result.sizeBytes <= estimate.max,
    `${format} actual size ${result.sizeBytes} bytes falls within the displayed estimate`);
  encodedSizes[filename] = result.sizeBytes;
  console.log(`${format} (background ${backgroundOpacity}): ${framePlan.frameCount} decoded frames, alpha/colour verified, ${result.sizeBytes} bytes`);
}
if (hevcFFmpeg) console.log(`Same semi-transparent scene: HEVC Alpha ${(encodedSizes['export.mov'] / encodedSizes['export-hevc-alpha-semi.mov']).toFixed(1)}× smaller than ProRes`);

// Exercise both queued and active cancellation, and block downloads of incomplete output.
const longJob = await request('/api/exports', { trackId: track.id, camera,
  plan: { fps: 60, speed: 1, end: 120 }, config: { width: 320, height: 320, format: hevcFFmpeg ? 'hevc-alpha' : 'mp4' } });
const queued = await request('/api/exports', { trackId: track.id, camera,
  plan: { fps: 12, speed: 120, end: 240 }, config: { width: 320, height: 320 } });
const cancellationStarted = Date.now();
while ((await request(`/api/exports/${longJob.id}`)).renderedFrames === 0) {
  assert.ok(Date.now() - cancellationStarted < 10000, 'Active encoder must progress past frame zero');
  await new Promise(resolve => setTimeout(resolve, 100));
}
for (const id of [queued.id, longJob.id]) {
  const response = await fetch(origin + `/api/exports/${id}`, { method: 'DELETE' });
  assert.equal((await response.json()).status, 'cancelled');
  assert.equal((await fetch(origin + `/api/exports/${id}/download`)).status, 409);
}
console.log('Jobs: queued/active cancellation and incomplete download protection verified');

const browser = await chromium.launch({ headless: true,
  ...(process.env.TRACE_CHROMIUM_PATH ? { executablePath: process.env.TRACE_CHROMIUM_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const openExport = async () => {
    if (!await page.locator('#export-dialog').evaluate(dialog => dialog.open)) await page.locator('#open-export').click();
  };
  const closeExport = async () => {
    if (await page.locator('#export-dialog').evaluate(dialog => dialog.open)) await page.locator('#close-export').click();
  };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(web);
  assert.ok(await page.locator('#export-dialog').isHidden(), 'Export details start outside the sidebar');
  assert.equal(await page.locator('.right-sidebar #format').count(), 0);
  assert.equal(await page.locator('#estimated-size').textContent(), '—');
  assert.deepEqual(await page.locator('#speed-presets button').evaluateAll(buttons => buttons.map(button => Number(button.dataset.speed))), [30, 60, 120, 240]);
  assert.equal(await page.locator('#file').getAttribute('accept'), '.kml,.gpx');
  const gpxBuffer = Buffer.from(`<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>GPX import</name>
    <trkseg><trkpt lon="120" lat="30"><time>2026-01-01T00:00:00Z</time></trkpt>
    <trkpt lon="120.00001" lat="30"><time>2026-01-01T00:00:00Z</time></trkpt>
    <trkpt lon="120.001" lat="30"><time>2026-01-01T00:01:00Z</time></trkpt></trkseg>
    <trkseg><trkpt lon="120.002" lat="30"><time>2026-01-01T00:02:00Z</time></trkpt>
    <trkpt lon="120.003" lat="30"><time>2026-01-01T00:03:00Z</time></trkpt></trkseg>
    </trk></gpx>`);
  const [gpxResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/tracks') && response.request().method() === 'POST'),
    page.locator('#file').setInputFiles({ name: 'hike.gpx', mimeType: 'application/gpx+xml', buffer: gpxBuffer }),
  ]);
  assert.equal(gpxResponse.status(), 200);
  const gpxTrack = (await gpxResponse.json()).tracks[0];
  assert.equal(gpxTrack.pointCount, 4);
  assert.equal(gpxTrack.segmentCount, 2);
  await page.waitForFunction(id => document.querySelector('#track-select').value === id && !document.querySelector('#play').disabled, gpxTrack.id);
  assert.equal(await page.locator('#track-name').textContent(), 'GPX import');
  assert.match(await page.locator('#warnings').textContent(), /10 米.*减少 1 点/);
  await page.locator('#play').click();
  await page.waitForFunction(() => Number(document.querySelector('#timeline').value) > 0);
  await page.locator('#play').click();
  const [untimedResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/tracks') && response.request().method() === 'POST'),
    page.locator('#file').setInputFiles({ name: 'route.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from('<gpx><rte><rtept lon="120" lat="30"/><rtept lon="120.001" lat="30"/></rte></gpx>') }),
  ]);
  assert.equal(untimedResponse.status(), 422);
  await page.waitForFunction(() => document.querySelector('.import-details').open);
  await page.locator('#fallback-duration').fill('30');
  const [retryResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/tracks') && response.request().method() === 'POST'),
    page.locator('#reimport').click(),
  ]);
  assert.equal(retryResponse.status(), 200);
  const untimedTrack = (await retryResponse.json()).tracks[0];
  assert.equal(untimedTrack.synthetic, true);
  await page.waitForFunction(id => document.querySelector('#track-select').value === id && !document.querySelector('#play').disabled, untimedTrack.id);
  assert.equal(await page.locator('#source-kind').textContent(), '推算时间');
  await page.locator('#fallback-duration').fill('');
  await page.locator('.import-details summary').click();
  console.log('GPX browser import: timed segments, duplicate merge, playback and untimed duration retry verified');
  await page.locator('#demo').click();
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  // The plan request is asynchronous. Clicking immediately after importing
  // must queue playback instead of being lost while the frames are built.
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-label') === '暂停' && Number(document.querySelector('#timeline').value) > 0, { timeout: 10000 });
  await page.locator('#play').click();
  assert.equal(await page.locator('#show-trail').isChecked(), false, 'Only the marker moves by default');
  await page.waitForTimeout(250);
  const importedCamera = await page.evaluate(() => JSON.parse(localStorage.getItem('pudding-track-studio')).camera);
  const expectedCamera = fitCamera(track.points, 640, 640, 'grid');
  assert.ok(Math.abs(importedCamera.span - expectedCamera.span) < 0.001, 'Import must fit the route');
  assert.ok(importedCamera.center.every((value, i) => Math.abs(value - expectedCamera.center[i]) < 0.001));
  await page.locator('#lock').click();
  const preview = await page.locator('#preview').boundingBox();
  await page.mouse.move(preview.x + preview.width / 2, preview.y + preview.height / 2);
  await page.mouse.down(); await page.mouse.move(preview.x + preview.width / 2 + 40, preview.y + preview.height / 2 + 20, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(350);
  const readCamera = () => page.evaluate(() => JSON.parse(localStorage.getItem('pudding-track-studio')).camera);
  const fixedCamera = await readCamera();
  await page.locator('#play').click(); await page.waitForTimeout(800); await page.locator('#play').click();
  assert.deepEqual(await readCamera(), fixedCamera, 'Playback cannot change the selected camera');
  assert.match(await page.locator('#lock').textContent(), /已锁定/);
  assert.ok(Number(await page.locator('#timeline').inputValue()) > 0, 'Frames advance');
  await page.screenshot({ path: new URL('studio-map.png', output).pathname });
  const [importResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/tracks') && response.request().method() === 'POST'),
    page.locator('#file').setInputFiles(fileURLToPath(new URL('../examples/West Lake Loop.kml', import.meta.url))),
  ]);
  const importedTrackId = (await importResponse.json()).tracks[0].id;
  await page.waitForFunction(id => document.querySelector('#track-select').value === id && !document.querySelector('#export').disabled, importedTrackId);
  assert.match(await page.locator('#track-name').textContent(), /West Lake Loop/);
  assert.equal(await page.locator('#line-width').getAttribute('type'), 'number');
  assert.equal(await page.locator('#marker-size').getAttribute('max'), '640');
  await page.locator('#line-width').fill('40'); await page.locator('#line-width').press('Tab');
  assert.equal(await page.locator('#line-width').inputValue(), '40', 'Line width is not capped at the old 12 px');
  await page.locator('#line-width').fill('4'); await page.locator('#line-width').press('Tab');
  const markerUp = page.locator('#marker-size').locator('..').locator('[data-direction="1"]');
  await markerUp.click(); assert.equal(await page.locator('#marker-size').inputValue(), '14.5');
  const handle = await markerUp.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 28, { steps: 7 });
  await page.mouse.up();
  assert.equal(await page.locator('#marker-size').inputValue(), '18', 'Vertical dragging changes the size without an extra click step');
  await page.locator('#marker-size').fill('14'); await page.locator('#marker-size').press('Tab');
  const markerImages = new Set();
  for (const style of ['dot', 'ring', 'arrow', 'pin', 'crosshair']) {
    await page.locator('#marker-style').selectOption(style);
    markerImages.add(await page.locator('#scene').evaluate(canvas => canvas.toDataURL()));
  }
  assert.equal(markerImages.size, 5, 'All marker styles have distinct previews');
  await page.locator('#marker-style').selectOption('pin');
  await page.locator('#show-trail').check();
  assert.ok(await page.locator('#trail-color').isVisible());
  await page.locator('#trail-color').evaluate(input => { input.value = '#ea6fa3'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#show-hud').check();
  await page.locator('#speed').fill('120'); await page.locator('#speed').press('Tab');
  await page.locator('.clip-details summary').click();
  await page.locator('#clip-end').fill('240'); await page.locator('#clip-end').press('Tab');
  await page.locator('#clip-start').fill('240'); await page.locator('#clip-start').press('Tab');
  await page.waitForFunction(() => document.querySelector('#export-error').textContent.includes('截取范围'));
  await openExport();
  assert.ok(await page.locator('#export').isDisabled());
  assert.ok(await page.locator('#export-error').isVisible(), 'Invalid clip ranges explain the disabled export inside its dialog');
  await closeExport();
  await page.locator('#clip-start').fill('0'); await page.locator('#clip-start').press('Tab');
  await page.waitForFunction(() => !document.querySelector('#export').disabled);
  await openExport();
  assert.ok(await page.locator('#export-error').isHidden(), 'Correcting the clip range clears the error');
  await page.locator('#fps').fill('12'); await page.locator('#fps').press('Tab');
  await page.waitForFunction(() => document.querySelector('#timeline').max === '24' && !document.querySelector('#play').disabled);
  await page.locator('#resolution').selectOption('custom');
  await page.locator('#height').fill('360'); await page.locator('#height').press('Tab');
  assert.equal(await page.locator('#estimated-size').textContent(), formatSizeEstimate(estimateOutputBytes({ format: 'mp4', width: 640, height: 360, frameCount: 25, mode: 'map', basemap: 'grid' })));
  await page.locator('#export').click();
  await page.locator('#export-dialog').waitFor({ state: 'hidden' });
  assert.ok(await page.locator('#export-dialog').isHidden(), 'Submitting an export returns to its sidebar status');
  await page.locator('#download').waitFor({ state: 'visible', timeout: 60000 });
  const downloadPath = await page.locator('#download').getAttribute('href');
  const uiJobId = downloadPath.match(/\/exports\/([^/]+)\/download/)[1];
  const downloadUrl = await page.locator('#download').evaluate(link => link.href);
  assert.ok(downloadUrl.startsWith(new URL('./', web + (web.endsWith('/') ? '' : '/')).href));
  assert.equal((await fetch(downloadUrl)).status, 200, 'Download resolves below the app directory');
  const uiJob = await request(`/api/exports/${uiJobId}`);
  assert.equal(uiJob.width, 640); assert.equal(uiJob.height, 360);
  assert.equal(uiJob.fps, 12); assert.equal(uiJob.frameCount, 25);
  await openExport();
  await page.locator('#resolution').selectOption('640x640');
  await closeExport();
  await page.locator('#style-geometry').click();
  assert.equal(await page.locator('#format').inputValue(), 'webm');
  assert.equal(await page.locator('#scene').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3]), 0);
  await openExport();
  await page.locator('#format').selectOption('mp4');
  assert.ok(await page.locator('#export').isDisabled());
  assert.match(await page.locator('#message').textContent(), /透明/);
  await page.locator('#format').selectOption('webm');
  await page.locator('#format').selectOption('mov');
  assert.equal(await page.locator('#estimated-size').textContent(), formatSizeEstimate(estimateOutputBytes({ format: 'mov', width: 640, height: 640, frameCount: 25 })));
  await closeExport();
  await page.locator('[data-speed="240"]').click();
  await page.waitForFunction(() => document.querySelector('#timeline').max === '12' && !document.querySelector('#export').disabled);
  assert.equal(await page.locator('#estimated-size').textContent(), formatSizeEstimate(estimateOutputBytes({ format: 'mov', width: 640, height: 640, frameCount: 13 })));
  await openExport();
  await page.locator('#fps').fill('24'); await page.locator('#fps').press('Tab');
  await page.waitForFunction(() => document.querySelector('#timeline').max === '24' && !document.querySelector('#export').disabled);
  assert.equal(await page.locator('#estimated-size').textContent(), formatSizeEstimate(estimateOutputBytes({ format: 'mov', width: 640, height: 640, frameCount: 25 })));
  await page.locator('#format').selectOption('webm');
  if (hevcFFmpeg) {
    await page.locator('#format').selectOption('hevc-alpha');
    assert.equal(await page.locator('#estimated-size').textContent(), formatSizeEstimate(estimateOutputBytes({ format: 'hevc-alpha', width: 640, height: 640, frameCount: 25 })));
    assert.match(await page.locator('#format-note').textContent(), /辅助 Alpha/);
    assert.match(await page.locator('#format-note').textContent(), /仅用于.*视频剪辑/);
    assert.match(await page.locator('#format-note').textContent(), /不代表视频导出有误/);
    await page.screenshot({ path: new URL('export-dialog-hevc.png', output).pathname });
    const [submitted] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/exports') && response.request().method() === 'POST'),
      page.locator('#export').click(),
    ]);
    const submittedJob = await submitted.json();
    await page.waitForFunction(id => document.querySelector('#job-stage').textContent === '视频已就绪'
      && !document.querySelector('#download').hidden && document.querySelector('#download').getAttribute('href')?.includes(id), submittedJob.id,
    { timeout: 60000 });
    const hevcJobId = (await page.locator('#download').getAttribute('href')).match(/\/exports\/([^/]+)\/download/)[1];
    assert.equal((await request(`/api/exports/${hevcJobId}`)).encoding, 'hevc-alpha');
    assert.ok(await page.locator('#job-format-note').isVisible());
    assert.match(await page.locator('#job-format-note').textContent(), /播放器预览失真并非导出失败/);
    await openExport();
    await page.locator('#format').selectOption('webm');
    await closeExport();
    assert.ok(await page.locator('#job-format-note').isVisible(), 'Completed output keeps its own Alpha compatibility note');
  }
  await closeExport();
  const sidebar = await page.locator('.right-sidebar').evaluate(element => ({
    height: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY,
  }));
  assert.equal(sidebar.overflow, 'visible');
  assert.ok(sidebar.scroll <= sidebar.height + 1, 'The right sidebar must not have an internal scrollbar');
  await page.screenshot({ path: new URL('studio-geometry.png', output).pathname });
  // Mock one tile source to check path resolution without needing the network.
  const tileRequests = [];
  await page.route('**/api/tiles/**', async route => {
    tileRequests.push(route.request().url());
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64') });
  });
  await page.locator('#style-map').click();
  await page.locator('#basemap').selectOption('osm');
  await page.waitForFunction(() => document.querySelector('#tiles-status').textContent === '底图已加载');
  assert.ok(tileRequests.length > 0);
  assert.ok(tileRequests.every(url => url.startsWith(new URL('./', web + (web.endsWith('/') ? '' : '/')).href + 'api/tiles/')));
  await page.locator('#basemap').selectOption('grid');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout cannot overflow horizontally');
  await page.locator('#marker-size').scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL('studio-mobile-controls.png', output).pathname });
  await openExport();
  assert.ok(await page.locator('#export-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), 'Mobile export settings cannot overflow horizontally');
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#export-dialog').isHidden(), 'Escape closes the export dialog');
  // Both static index entry URLs and hash URLs must retain the same base path.
  const directory = new URL('./', web + (web.endsWith('/') ? '' : '/'));
  for (const entry of ['index.html#/preview', './#/preview']) {
    await page.goto(new URL(entry, directory).href);
    await page.waitForFunction(() => document.querySelector('#service-status').textContent === '本地渲染服务在线' && !document.querySelector('#export').disabled);
    assert.equal(await page.locator('.brand').evaluate(link => link.href), directory.href);
    assert.equal(await page.locator('#speed').inputValue(), '240');
    assert.notEqual(await page.locator('#estimated-size').textContent(), '—');
  }
  assert.deepEqual(errors, [], 'Browser console errors');
  const unavailable = await browser.newPage();
  try {
    await unavailable.route('**/api/health', route => route.fulfill({ json: { ...health,
      hevcAlpha: { available: false, reason: 'HEVC Alpha 尚未安装，请运行 npm run setup:hevc-alpha，然后刷新页面。' } } }));
    await unavailable.goto(web);
    await unavailable.locator('#demo').click();
    await unavailable.waitForFunction(() => !document.querySelector('#export').disabled);
    await unavailable.locator('#open-export').click();
    await unavailable.locator('#format').selectOption('hevc-alpha');
    assert.ok(await unavailable.locator('#export').isDisabled());
    assert.match(await unavailable.locator('#export-error').textContent(), /setup:hevc-alpha/);
    await unavailable.locator('#format').selectOption('mov');
    assert.ok(await unavailable.locator('#export').isEnabled());
  } finally { await unavailable.close(); }
  console.log('UI: import, custom dimensions/FPS/speed, size estimates, export/download, fixed camera, alpha, mobile layout and index/hash entry verified');
} finally { await browser.close(); }
