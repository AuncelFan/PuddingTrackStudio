import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fitCamera } from '../shared/scene.mjs';

for (const format of ['mov', 'hevc-alpha']) test(`${format} renderer reports an encoder that exits while a frame is being written`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-render-'));
  try {
    const fakeEncoder = join(directory, 'fake-ffmpeg');
    await writeFile(fakeEncoder, '#!/usr/bin/env node\nsetTimeout(() => process.exit(2), 50);\n');
    await chmod(fakeEncoder, 0o755);
    const track = { points: [[120, 30, 0, 0, 0, true], [120.01, 30.01, 0, 1, 1000, false]] };
    const manifest = {
      track,
      config: {
        mode: 'geometry', format, width: 1920, height: 1080,
        backgroundColor: '#15232c', backgroundOpacity: 0.35,
        routeColor: '#91e2bc', markerColor: '#ffbc7a', routeOpacity: 0.5,
        lineWidth: 4, markerSize: 7, showGrid: true, showTrail: false,
        showEndpoints: false, glow: false, showHud: false,
      },
      camera: fitCamera(track.points, 1920, 1080, 'grid'),
      plan: { frames: [[120, 30, 0, 0, 0, 0]], frameCount: 1, fps: 30, start: 0, end: 0, speed: 1 },
      output: join(directory, 'output.mov'), ffmpeg: fakeEncoder, origin: 'http://127.0.0.1:1',
    };
    const manifestPath = join(directory, 'input.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const started = Date.now();
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ['scripts/render.mjs', manifestPath], { cwd: process.cwd() });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /"stage":"failed"/);
    assert.ok(Date.now() - started < 5000, 'encoder failure must not leave the renderer hanging');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
