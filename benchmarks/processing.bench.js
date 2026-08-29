import { performance } from 'node:perf_hooks';
import { processSignalPixels } from '../site/js/filters.js';

const sizes = [
  ['1080p', 1920, 1080],
  ['4K', 3840, 2160],
];
const effects = [
  { id: 'contrast', filter: 'brightness-contrast', params: { brightness: -8, contrast: 24 } },
  { id: 'scan', filter: 'scanlines', params: { spacing: 4, darkness: 28 }, mix: .8 },
  { id: 'noise', filter: 'noise', params: { amount: 12, mono: 1 }, mix: .65 },
  { id: 'vignette', filter: 'vignette', params: { amount: 45 }, mask: 'luma' },
];

console.log('DEADPIXEL processing benchmark');
for (const [label, width, height] of sizes) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(127);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const started = performance.now();
  processSignalPixels(pixels, width, height, effects, 404);
  const elapsed = performance.now() - started;
  const megapixels = width * height / 1_000_000;
  console.log(`${label.padEnd(6)} ${megapixels.toFixed(2)} MP  ${elapsed.toFixed(1)} ms  ${(elapsed / megapixels).toFixed(1)} ms/MP`);
}
