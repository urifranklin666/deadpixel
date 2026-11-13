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

const valid4 = () => ({
  app: 'DEADPIXEL', version: 4, width: 64, height: 64,
  layersTree: [
    { id: 'L1', type: 'raster' },
    { id: 'ADJ', type: 'adjust', filter: 'exposure', params: { stops: 5, offset: 0 } },
    { id: 'ADJ2', type: 'adjust', filter: 'vibrance', params: {}, mask: 'layer-ADJ2', maskEnabled: true },
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

/* ---- v4 adjustment layers ---- */

test('accepts well-formed v4 trees with adjustment nodes', () => {
  const meta = validateProjectMeta(valid4());
  assert.equal(meta.layersTree[1].filter, 'exposure');
  assert.deepEqual(meta.layersTree[1].params, { stops: 5, offset: 0 });
  assert.equal(meta.layersTree[2].mask, 'layer-ADJ2');
});

test('v4 adjustment nodes can be nested inside groups', () => {
  const meta = validateProjectMeta({
    ...valid4(),
    layersTree: [{
      id: 'LG1', type: 'group', name: 'SET', children: [
        { id: 'ADJ', type: 'adjust', filter: 'vibrance', params: { amount: 25 } },
        { id: 'L1', type: 'raster' },
      ],
    }],
  });
  assert.equal(meta.layersTree[0].children[0].type, 'adjust');
});

test('v3 rejects adjustment nodes so old readers stay authoritative', () => {
  const v3 = valid3();
  v3.layersTree.push({ id: 'ADJ', type: 'adjust', filter: 'exposure', params: {} });
  assert.throws(() => validateProjectMeta(v3), /layer metadata/);
  const nested = valid3();
  nested.layersTree[0].children.push({ id: 'ADJ2', type: 'adjust', filter: 'invert', params: {} });
  assert.throws(() => validateProjectMeta(nested), /layer metadata/);
});

test('v4 rejects malformed adjustment nodes', () => {
  const bad = (node) => ({ ...valid4(), layersTree: [node] });
  assert.throws(() => validateProjectMeta(bad({ id: 'A', type: 'adjust', params: {} })), /layer metadata/); // missing filter
  assert.throws(() => validateProjectMeta(bad({ id: 'A', type: 'adjust', filter: 7, params: {} })), /layer metadata/);
  assert.throws(() => validateProjectMeta(bad({ id: 'A', type: 'adjust', filter: 'exposure', params: 'nope' })), /layer metadata/);
  assert.throws(() => validateProjectMeta(bad({ id: 'A', type: 'adjust', filter: 'exposure', params: { stops: Infinity } })), /layer metadata/);
  assert.throws(() => validateProjectMeta(bad({ id: 'A', type: 'adjust', filter: 'exposure', params: { stops: NaN } })), /layer metadata/);
  assert.throws(() => validateProjectMeta(bad({ id: 'A', type: 'adjust', filter: 'exposure', params: { stops: 'high' } })), /layer metadata/);
  assert.doesNotThrow(() => validateProjectMeta(bad({ id: 'A', type: 'adjust', filter: 'exposure' }))); // params optional
});

test('v4 still rejects unknown node types and bad trees', () => {
  assert.throws(() => validateProjectMeta({
    ...valid4(), layersTree: [{ id: 'X', type: 'video' }],
  }), /layer metadata/);
  assert.throws(() => validateProjectMeta({ ...valid4(), layersTree: 'nope' }), /layer list/);
});

test('v4 enforces the same node budget across the tree', () => {
  const tree = Array.from({ length: 257 }, (_, i) =>
    ({ id: 'N' + i, type: i % 2 ? 'raster' : 'adjust', filter: 'invert' }));
  assert.throws(() => validateProjectMeta({ ...valid4(), layersTree: tree }), /layer list/);
});
