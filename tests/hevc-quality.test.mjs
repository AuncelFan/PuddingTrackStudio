import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createScene, fitCamera } from '../shared/scene.mjs';

const ffmpeg = process.env.TRACE_HEVC_FFMPEG_PATH || join(process.cwd(), '.tools/hevc-alpha/bin/ffmpeg');

test('HEVC export preserves the thin route and glow when Alpha is composited', { skip: !existsSync(ffmpeg) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-hevc-quality-'));
  try {
    const track = { points: [[120, 30, 0, 0, 0, true], [120.01, 30, 0, 10, 100, false], [120.01, 30.01, 0, 20, 200, false]] };
    const config = {
      width: 320, height: 320, mode: 'geometry', basemap: 'grid', format: 'hevc-alpha',
      backgroundColor: '#15232c', backgroundOpacity: 0, routeColor: '#91e2bc', markerColor: '#ffbc7a',
      routeOpacity: 0.85, lineWidth: 4, markerSize: 7, glow: true,
      showGrid: false, showTrail: false, showHud: false, showEndpoints: false,
    };
    const camera = fitCamera(track.points, 320, 320, 'grid');
    const plan = { frames: [[120, 30, 0, 0, 0, 0], [120.01, 30.005, 0, 150, 1, 15]],
      frameCount: 2, fps: 30, start: 0, end: 20, speed: 60 };
    const movie = join(directory, 'output.mov');
    const manifest = join(directory, 'input.json');
    await writeFile(manifest, JSON.stringify({ track, config, camera, plan, output: movie, ffmpeg, origin: 'http://127.0.0.1:1' }));
    execFileSync(process.execPath, ['scripts/render.mjs', manifest], { timeout: 15000 });
    const decoded = execFileSync(ffmpeg, ['-v', 'error', '-i', movie, '-sws_flags', 'accurate_rnd+bitexact',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    const frameBytes = 320 * 320 * 4;
    assert.equal(decoded.length, frameBytes * 2);
    const scene = createScene({ createCanvas, track, config, camera });
    const canvas = createCanvas(320, 320);
    for (let frame = 0; frame < 2; frame++) {
      scene.draw(canvas, plan.frames[frame], frame, plan);
      const expected = canvas.getContext('2d').getImageData(0, 0, 320, 320).data;
      const actual = decoded.subarray(frame * frameBytes, (frame + 1) * frameBytes);
      let alphaError = 0, sourceCoverage = 0, decodedCoverage = 0;
      let sourceMass = 0, decodedMass = 0, ignoredAlphaCoverage = 0;
      const colourErrors = [0, 0, 0];
      for (let offset = 0; offset < frameBytes; offset += 4) {
        const a = expected[offset + 3], b = actual[offset + 3];
        alphaError += Math.abs(a - b); sourceMass += a; decodedMass += b;
        sourceCoverage += Number(a >= 128); decodedCoverage += Number(b >= 128);
        ignoredAlphaCoverage += Number(Math.max(...actual.subarray(offset, offset + 3)) >= 128);
        for (let background = 0; background < 3; background++) {
          const level = [0, 80, 255][background];
          for (let channel = 0; channel < 3; channel++) {
            const before = expected[offset + channel] * a / 255 + level * (1 - a / 255);
            const after = actual[offset + channel] * b / 255 + level * (1 - b / 255);
            colourErrors[background] += Math.abs(before - after);
          }
        }
      }
      assert.ok(alphaError / (320 * 320) < 0.5, 'Alpha edge mean error must stay small');
      assert.ok(Math.abs(decodedCoverage / sourceCoverage - 1) < 0.06, 'Visible route/marker area must not become wider');
      assert.ok(Math.abs(decodedMass / sourceMass - 1) < 0.06, 'Glow opacity must survive encoding');
      assert.ok(colourErrors.every(error => error / (320 * 320 * 3) < 1), 'Composition on dark, grey and white backgrounds must match the source');
      assert.ok(ignoredAlphaCoverage > sourceCoverage * 3, 'Ignoring Alpha must reproduce the reported thick glow');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
