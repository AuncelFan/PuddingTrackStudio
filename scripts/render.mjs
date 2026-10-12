import { readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createScene, tileLayout } from '../shared/scene.mjs';

const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { track, config, camera, plan, output, ffmpeg: executable, origin } = manifest;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let encoder;
let stderr = '';
let cancelled = false;
let forceKillTimer;
const terminateEncoder = () => {
  if (!encoder || encoder.exitCode !== null || encoder.signalCode !== null) return;
  encoder.stdin?.destroy();
  encoder.kill('SIGTERM');
  clearTimeout(forceKillTimer);
  forceKillTimer = setTimeout(() => encoder?.kill('SIGKILL'), 2000);
  forceKillTimer.unref();
  encoder.once('close', () => clearTimeout(forceKillTimer));
};
const abort = () => {
  cancelled = true;
  // Closing stdin is important when a frame write is waiting for the pipe to
  // drain.  Killing the child alone does not always wake that write callback
  // on all Node/FFmpeg combinations.
  terminateEncoder();
};
process.on('SIGTERM', abort);
process.on('SIGINT', abort);

try {
  let basemapImage = null;
  if (config.mode === 'map' && config.basemap !== 'grid') {
    emit({ stage: 'tiles', progress: 0.01 });
    basemapImage = createCanvas(config.width, config.height);
    const ctx = basemapImage.getContext('2d');
    ctx.fillStyle = '#e5e8e5'; ctx.fillRect(0, 0, config.width, config.height);
    const tiles = tileLayout(camera, config.width, config.height);
    // Bound request concurrency and honour the tile service cache.
    for (let i = 0; i < tiles.length; i += 4) {
      const batch = await Promise.all(tiles.slice(i, i + 4).map(async tile => {
        const url = `${origin}/api/tiles/${config.basemap}/${tile.z}/${tile.x}/${tile.y}.png`;
        const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (!response.ok) throw new Error('地图瓦片加载失败；可重试或选择离线坐标网格。');
        return { tile, image: await loadImage(Buffer.from(await response.arrayBuffer())) };
      }));
      for (const { tile, image } of batch) ctx.drawImage(image, tile.left, tile.top, tile.size, tile.size);
      if (cancelled) throw new Error('任务已取消');
    }
  }
  const canvas = createCanvas(config.width, config.height);
  const scene = createScene({ createCanvas, track, config, camera, basemapImage });
  const codec = config.format === 'mp4'
    ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
    : config.format === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '22', '-row-mt', '1']
      : config.format === 'hevc-alpha'
        ? ['-vf', 'scale=iw:ih:flags=accurate_rnd+bitexact,format=yuva420p',
          '-c:v', 'libx265', '-preset', 'fast', '-crf', '18', '-pix_fmt', '+yuva420p',
          '-x265-params', 'pools=2:frame-threads=1:log-level=error', '-tag:v', 'hvc1', '-movflags', '+faststart']
      : ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16'];
  encoder = spawn(executable, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo',
    '-pixel_format', 'rgba', '-video_size', `${config.width}x${config.height}`,
    '-framerate', String(plan.fps), '-i', 'pipe:0', '-an', ...codec,
    '-threads', '2', output], { stdio: ['pipe', 'ignore', 'pipe'] });
  let encoderFailure;
  let encoderExitCode = null;
  // Attach listeners immediately; encoder failure must never leave a pipe writer hanging.
  const completed = new Promise(resolve => {
    encoder.once('error', error => { encoderFailure = error; resolve(-1); });
    encoder.once('close', code => { encoderExitCode = code; resolve(code); });
  });
  encoder.stdin.on('error', error => { encoderFailure = error; });
  encoder.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
  const encoderError = () => encoderFailure ||
    (encoderExitCode !== null ? new Error(`FFmpeg 提前退出（${encoderExitCode}）`) : null);
  const writeFrame = pixels => new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('FFmpeg 写入帧超时；编码器可能已卡住。')), 30_000);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      encoder.off('close', onClose);
      encoder.stdin.off('error', onError);
      error ? reject(error) : resolve();
    };
    const onClose = () => finish(encoderError() || new Error('FFmpeg 提前退出'));
    const onError = error => finish(error);
    encoder.once('close', onClose);
    encoder.stdin.once('error', onError);
    try {
      encoder.stdin.write(pixels, error => finish(error));
    } catch (error) {
      finish(error);
    }
  });
  emit({ stage: 'rendering', progress: 0.02 });
  for (let index = 0; index < plan.frames.length; index++) {
    if (cancelled) throw new Error('任务已取消');
    if (encoderFailure || encoder.exitCode !== null) throw new Error(stderr || encoderFailure?.message || 'FFmpeg 提前退出');
    scene.draw(canvas, plan.frames[index], index, plan);
    // canvas.data() is premultiplied. FFmpeg needs straight RGBA, otherwise translucent
    // routes become dark when composited. getImageData performs the unpremultiplication.
    const rgba = canvas.getContext('2d').getImageData(0, 0, config.width, config.height).data;
    const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    // One outstanding write bounds memory and avoids accumulating race handlers on long jobs.
    await writeFrame(pixels);
    if (index % Math.max(1, Math.floor(plan.fps / 2)) === 0) {
      emit({ stage: 'rendering', progress: 0.02 + 0.95 * (index + 1) / plan.frames.length, renderedFrames: index + 1 });
    }
  }
  emit({ stage: 'encoding', progress: 0.98, renderedFrames: plan.frameCount });
  encoder.stdin.end();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FFmpeg 完成编码超时；编码器可能已卡住。')), 120_000);
    completed.then(value => { clearTimeout(timer); resolve(value); });
  });
  if (code !== 0 || encoderFailure) throw new Error(stderr || encoderFailure?.message || `FFmpeg 退出码 ${code}`);
  emit({ stage: 'done', progress: 1 });
} catch (error) {
  terminateEncoder();
  await unlink(output).catch(() => {});
  emit({ stage: 'failed', error: stderr.trim() || error.message });
  process.exitCode = 1;
}
