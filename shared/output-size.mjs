// Broad empirical ranges in bytes per pixel per frame for the fixed-camera
// encoder settings in scripts/render.mjs. Detail, alpha, and motion can vary
// the output size substantially; these are planning estimates, not limits.
const rates = {
  mov: [0.3, 1.6],
  mp4: [0.0003, 0.006],
  webm: [0.0002, 0.008],
  'hevc-alpha': [0.0003, 0.012],
};

export function estimateOutputBytes({ format, width, height, frameCount, mode, basemap }) {
  if (!rates[format] || ![width, height, frameCount].every(value => Number.isFinite(value) && value > 0)) return null;
  const detailedMap = mode === 'map' && basemap !== 'grid';
  const [low, high] = rates[format];
  const pixels = width * height * frameCount;
  const multiplier = format !== 'mov' && detailedMap ? 4 : 1;
  // Include headers and the initial full image in inter-frame formats.
  const overhead = 4096 + (format === 'mov' ? 0 : width * height * 0.02);
  return { min: overhead + pixels * low * multiplier, max: overhead + pixels * high * multiplier };
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatSizeEstimate(estimate) {
  return estimate ? `${formatFileSize(estimate.min)}–${formatFileSize(estimate.max)}` : '—';
}
