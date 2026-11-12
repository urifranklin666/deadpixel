import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectMeta } from '../site/js/io.js';

const valid = () => ({
  app: 'DEADPIXEL', version: 1, width: 1920, height: 1080,
  layers: [{ id: 'L1', type: 'raster' }],
});

const valid3 = () => ({
  app: 'DEADPIXEL', version: 3, width: 64, height: 64,
  layersTree: [
    { id: 'LG1', type: 'group', name: 'SET', children: [
      { id: 'L1', type: 'raster' },
      { id: 'L2', type: 'text' },
    ] },
    { id: 'L3', type: 'raster' },
  ],
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

test('accepts well-formed v3 layer trees', () => {
  const meta = validateProjectMeta(valid3());
  assert.equal(meta.layersTree[0].children.length, 2);
});

test('v3 does not require a flat layers list', () => {
  const { layers, ...rest } = valid3();
  assert.doesNotThrow(() => validateProjectMeta(rest));
});

test('v3 requires a layersTree array', () => {
  const { layersTree, ...rest } = valid3();
  assert.throws(() => validateProjectMeta(rest), /layer list/);
  assert.throws(() => validateProjectMeta({ ...valid3(), layersTree: 'nope' }), /layer list/);
});

test('v3 rejects unknown node types at any depth', () => {
  assert.throws(() => validateProjectMeta({
    ...valid3(), layersTree: [{ id: 'LG1', type: 'group', children: [{ id: 'X', type: 'video' }] }],
  }), /layer metadata/);
});

test('v3 rejects non-array group children', () => {
  assert.throws(() => validateProjectMeta({
    ...valid3(), layersTree: [{ id: 'LG1', type: 'group', children: 'nope' }],
  }), /layer metadata/);
});

test('v3 rejects trees deeper than the engine depth limit', () => {
  let node = null;
  for (let i = 0; i <= 9; i++) node = { id: 'G' + i, type: 'group', children: node ? [node] : [] };
  assert.throws(() => validateProjectMeta({ ...valid3(), layersTree: [node] }), /layer list/);
});

test('v3 enforces the flat node budget across the whole tree', () => {
  const tree = Array.from({ length: 257 }, (_, i) => ({ id: 'N' + i, type: 'raster' }));
  assert.throws(() => validateProjectMeta({ ...valid3(), layersTree: tree }), /layer list/);
  const ok = Array.from({ length: 256 }, (_, i) => ({ id: 'N' + i, type: 'raster' }));
  assert.equal(validateProjectMeta({ ...valid3(), layersTree: ok }).layersTree.length, 256);
});
