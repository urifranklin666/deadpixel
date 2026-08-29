import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectMeta } from '../site/js/io.js';

const valid = () => ({
  app: 'DEADPIXEL', version: 1, width: 1920, height: 1080,
  layers: [{ id: 'L1', type: 'raster' }],
});

test('accepts valid project metadata', () => {
  assert.equal(validateProjectMeta(valid()).width, 1920);
});

test('rejects unsupported versions and oversized canvases', () => {
  assert.throws(() => validateProjectMeta({ ...valid(), version: 99 }), /unsupported/);
  assert.throws(() => validateProjectMeta({ ...valid(), width: 40000 }), /dimensions/);
  assert.throws(() => validateProjectMeta({ ...valid(), width: 20000, height: 20000 }), /dimensions/);
});

test('rejects malformed layers', () => {
  assert.throws(() => validateProjectMeta({ ...valid(), layers: [{ id: 'L1', type: 'video' }] }), /layer metadata/);
});
