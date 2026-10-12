import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateOutputBytes, formatFileSize, formatSizeEstimate } from '../shared/output-size.mjs';

test('size estimates include the measured encoded formats and long ProRes example', () => {
  for (const [format, width, height, frameCount, measuredBytes] of [
    ['mp4', 320, 320, 25, 9571], ['webm', 320, 320, 25, 16645],
    ['hevc-alpha', 320, 320, 25, 23635],
    ['mov', 320, 320, 25, 1044910], ['mov', 640, 640, 5845, 3_200_000_000],
  ]) {
    const estimate = estimateOutputBytes({ format, width, height, frameCount, mode: 'map', basemap: 'grid' });
    assert.ok(estimate.min < measuredBytes && estimate.max > measuredBytes);
  }
});

test('size estimates reflect resolution and frame count without allocating frames', () => {
  const config = { format: 'mov', width: 640, height: 640, frameCount: 5845 };
  const original = estimateOutputBytes(config);
  const larger = estimateOutputBytes({ ...config, width: 1280, height: 1280 });
  const shorter = estimateOutputBytes({ ...config, frameCount: 2923 });
  assert.ok(larger.min > original.min * 3.99 && larger.max > original.max * 3.99);
  assert.ok(shorter.min < original.min * 0.51 && shorter.max < original.max * 0.51);
  assert.ok(estimateOutputBytes({ ...config, format: 'webm' }).max < original.min);
  assert.ok(estimateOutputBytes({ ...config, format: 'hevc-alpha' }).max < original.min);
});

test('size display distinguishes unavailable estimates and large files', () => {
  assert.equal(formatSizeEstimate(estimateOutputBytes({ format: 'mov', width: 640, height: 640, frameCount: 0 })), '—');
  assert.equal(formatSizeEstimate(estimateOutputBytes({ format: 'mov', width: NaN, height: 640, frameCount: 1 })), '—');
  assert.equal(formatFileSize(3_200_000_000), '3.2 GB');
});
