import test from 'node:test';
import assert from 'node:assert/strict';
import { processFilterPixels, processFilterPixelsAsync, processSignalPixels, processSignalPixelsAsync } from '../site/js/filters.js';

const sample = () => new Uint8ClampedArray([
  10, 20, 30, 255, 100, 120, 140, 255,
  200, 180, 160, 255, 250, 240, 230, 255,
]);

test('async filter fallback matches deterministic synchronous processing', async () => {
  const expected = processFilterPixels(sample(), 2, 2, 'brightness-contrast', { brightness: 12, contrast: 20 });
  const actual = await processFilterPixelsAsync(sample(), 2, 2, 'brightness-contrast', { brightness: 12, contrast: 20 });
  assert.deepEqual(actual, expected);
});

test('seeded noise processing is repeatable', () => {
  const a = processFilterPixels(sample(), 2, 2, 'noise', { amount: 30, mono: 1, _seed: 42 });
  const b = processFilterPixels(sample(), 2, 2, 'noise', { amount: 30, mono: 1, _seed: 42 });
  assert.deepEqual(a, b);
});

test('async Signal Rack fallback matches synchronous output', async () => {
  const effects = [
    { id: 'a', filter: 'brightness-contrast', params: { brightness: 8, contrast: 10 } },
    { id: 'b', filter: 'noise', params: { amount: 15, mono: 1 } },
  ];
  const expected = processSignalPixels(sample(), 2, 2, effects, 404);
  const actual = await processSignalPixelsAsync(sample(), 2, 2, effects, 404);
  assert.deepEqual(actual, expected);
});

test('Signal Rack module mix blends processed and original pixels', () => {
  const original = sample();
  const dry = processSignalPixels(sample(), 2, 2, [{ id: 'x', filter: 'invert', params: {}, mix: 0 }], 1);
  assert.deepEqual(dry, original);
});

test('Signal Rack alpha mask preserves fully transparent pixels', () => {
  const pixels = sample(); pixels[3] = 0; const original = new Uint8ClampedArray(pixels);
  const output = processSignalPixels(pixels, 2, 2, [{ id: 'x', filter: 'invert', params: {}, mask: 'alpha' }], 1);
  assert.deepEqual([...output.slice(0, 4)], [...original.slice(0, 4)]);
});

test('Signal Rack painted mask applies an effect pixel by pixel', () => {
  const pixels = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
  const output = processSignalPixels(pixels, 2, 1, [{ id: 'paint', filter: 'invert', params: {}, mask: 'raster', maskPixels: new Uint8ClampedArray([255, 0]) }], 1);
  assert.deepEqual([...output], [245, 235, 225, 255, 40, 50, 60, 255]);
});
