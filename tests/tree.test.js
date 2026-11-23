import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, GroupLayer, AdjustLayer, setAdjustFilters, flattenLayers, countLeaves, MAX_TREE_DEPTH, uid } from '../site/js/engine.js';
import { docFromFiles, serializeDoc } from '../site/js/io.js';

/* Tree tests run in Node. The document-level cases stub canvas creation
   because they only use groups and never draw pixels. */

const leaf = (name) => ({
  id: name, type: 'raster', name,
  clone() { return { ...this }; }, // stub so GroupLayer.clone can walk past it
});
const group = (name, children = []) => {
  const g = new GroupLayer(name);
  g.children = children;
  return g;
};

test('groups carry shared node state and tree plumbing', () => {
  const g = new GroupLayer('SET');
  assert.equal(g.type, 'group');
  assert.equal(g.expanded, true);
  assert.deepEqual(g.children, []);
  for (const key of ['visible', 'opacity', 'blend', 'locked', 'clipped', 'mask', 'maskEnabled', 'effects']) {
    assert.ok(key in g, `missing shared state: ${key}`);
  }
  assert.equal(g.visible, true);
  assert.equal(g.opacity, 1);
  assert.equal(g.blend, 'source-over');
  assert.equal(g.mask, null);
});

test('flattenLayers walks the tree depth-first in paint order', () => {
  const tree = [group('A', [leaf('a1'), group('B', [leaf('b1')]), leaf('a2')]), leaf('top')];
  const flat = flattenLayers(tree);
  assert.deepEqual(flat.map(l => l.name), ['A', 'a1', 'B', 'b1', 'a2', 'top']);
  assert.equal(flat.length, 6);
});

test('flattenLayers reuses the provided output array', () => {
  const tree = [leaf('x')];
  const out = [];
  assert.equal(flattenLayers(tree, out), out);
  assert.deepEqual(out.map(l => l.name), ['x']);
});

test('countLeaves only counts non-group nodes', () => {
  const tree = [group('A', [leaf('a1'), group('B', [leaf('b1'), leaf('b2')])]), leaf('top')];
  assert.equal(countLeaves(tree), 4);
  assert.equal(countLeaves([group('empty')]), 0);
});

test('contains finds direct and deeply nested children only within the group', () => {
  const tree = group('A', [leaf('a1'), group('B', [leaf('b1')])]);
  assert.equal(tree.contains('a1'), true);
  assert.equal(tree.contains('b1'), true);
  assert.equal(tree.contains('top'), false);
  assert.equal(tree.contains('nope'), false);
});

test('clone deep-copies the subtree and stays structurally independent', () => {
  const g = group('A', [group('B', [leaf('b1')]), leaf('a1')]);
  const c = g.clone();
  assert.equal(c.name, 'A');
  assert.equal(c.id !== g.id, true);
  assert.equal(c.children !== g.children, true);
  const inner = c.children[0];
  assert.equal(inner.name, 'B');
  assert.equal(inner.children !== g.children[0].children, true);
  assert.equal(inner.children[0].name, 'b1');
  inner.children.push(leaf('extra'));
  assert.equal(g.children[0].children.length, 1, 'original must be untouched');
});

test('assign adopts another node\'s state and copies the children list', () => {
  const a = group('A');
  const b = group('B', [leaf('b1')]);
  b.opacity = .5;
  b.visible = false;
  b.clipped = true;
  a.assign(b);
  assert.equal(a.id, b.id);
  assert.equal(a.opacity, .5);
  assert.equal(a.visible, false);
  assert.equal(a.clipped, true);
  assert.equal(a.children !== b.children, true);
  assert.deepEqual(a.children.map(l => l.id), ['b1']);
  a.children.push(leaf('extra'));
  assert.equal(b.children.length, 1, 'children array must be copied, not shared');
});

test('depth budget constant matches the documented limit', () => {
  assert.equal(MAX_TREE_DEPTH, 8);
});

test('uid stays unique within a batch', () => {
  const seen = new Set(Array.from({ length: 200 }, () => uid()));
  assert.equal(seen.size, 200);
});

/* ---- adjustment layers ---- */

const adjustable = () => [ // fake registry like the one filters.js injects
  { id: 'exposure', params: [{ key: 'stops', def: 0 }, { key: 'offset', def: 0 }] },
  { id: 'vibrance', params: [{ key: 'amount', def: 25 }] },
];

test('adjustment layers carry filter id, params, and no children', () => {
  const a = new AdjustLayer('exposure', { stops: 5 }, 'Look');
  assert.equal(a.type, 'adjust');
  assert.equal(a.filter, 'exposure');
  assert.deepEqual(a.params, { stops: 5 });
  assert.equal(a.name, 'Look');
  assert.equal(a.contains(a.id), true);
  assert.equal(a.contains('other'), false);
  const bare = new AdjustLayer(null); // Doc.addAdjustmentLayer names it after the filter
  assert.equal(bare.name, 'Adjustment');
  assert.deepEqual(bare.params, {});
});

test('adjustment layer clone is independent of its source', () => {
  const a = new AdjustLayer('vibrance', { amount: 40 });
  a.opacity = .5;
  a.blend = 'multiply';
  const c = a.clone();
  assert.equal(c.filter, 'vibrance');
  assert.equal(c.opacity, .5);
  assert.equal(c.blend, 'multiply');
  assert.equal(c.id !== a.id, true);
  c.params.amount = 90;
  assert.equal(a.params.amount, 40, 'params must copy, not share');
  c.visible = false;
  assert.equal(a.visible, true, 'shared state must copy, not share');
});

test('setAdjustFilters injects the kernel registry for content rendering', () => {
  setAdjustFilters(adjustable());
  setAdjustFilters([]); // restore so later suite state is untouched
});

test('flatten and leaf counts treat adjustment layers as leaves', () => {
  const adj = () => new AdjustLayer('exposure', null);
  const tree = [group('A', [leaf('a1'), adj()]), adj()];
  const flat = flattenLayers(tree);
  assert.deepEqual(flat.map(l => l.type), ['group', 'raster', 'adjust', 'adjust']);
  assert.equal(flat[2] instanceof AdjustLayer, true);
  assert.equal(countLeaves(tree), 3);
});

test('groups nest adjustment layers and pass structural identity through', () => {
  const a = new AdjustLayer('vibrance', { amount: 10 }, 'SAT');
  const g = group('G', [leaf('a1'), a]);
  const flat = flattenLayers([g]);
  assert.deepEqual(flat.map(l => l.name), ['G', 'a1', 'SAT']);
  assert.equal(countLeaves([g]), 2);
  assert.equal(g.contains(a.id), true);
});

function groupOnlyDoc(t) {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
  t.after(() => { delete globalThis.document; });
  const doc = new Doc(1, 1);
  doc.layers = [];
  return doc;
}

test('layer moves preserve the maximum nesting the DPX reader can reopen', async t => {
  const doc = groupOnlyDoc(t);
  let parent = doc.addGroup('Root');
  for (let depth = 1; depth < MAX_TREE_DEPTH; depth++) {
    doc.setActiveId(doc.layers[0].id);
    const child = doc.addGroup('Nested ' + depth);
    assert.equal(doc.reparent(child.id, parent.id), true);
    parent = child;
  }
  doc.setActiveId(doc.layers[0].id);
  const extra = doc.addGroup('Extra');
  const position = doc.history.index;
  parent.expanded = false;
  assert.equal(doc.reparent(extra.id, parent.id), false);
  assert.equal(doc.moveLayerRelative(extra.id, parent.id, 'into'), 'depth');
  assert.equal(parent.expanded, false);
  doc.setActiveId(parent.id);
  assert.equal(doc.groupFromActive(), null);
  assert.equal(doc.history.index, position);
  assert.equal(doc.layers.includes(extra), true);
  const restored = await docFromFiles(await serializeDoc(doc));
  assert.equal(restored.flatLayers.length, MAX_TREE_DEPTH + 1);
});

test('undo and redo preserve the group targeted by earlier clipping history', t => {
  const doc = groupOnlyDoc(t);
  const group = doc.addGroup('Clipped');
  doc.setClipped(group.id, true);
  const sibling = doc.addGroup('Sibling');
  doc.history.undo();
  doc.history.undo();
  assert.equal(doc.findLayer(group.id).clipped, false);
  doc.history.redo();
  doc.history.redo();
  assert.equal(doc.findLayer(group.id).clipped, true);
  assert.equal(doc.findLayer(sibling.id).name, 'Sibling');
});

test('a DPX round trip restores the selected nested group', async t => {
  const doc = groupOnlyDoc(t);
  const parent = doc.addGroup('Parent');
  const selected = doc.addGroup('Selected');
  doc.reparent(selected.id, parent.id);
  doc.setActiveId(parent.id);
  doc.addGroup('Later');
  doc.setActiveId(selected.id);
  const restored = await docFromFiles(await serializeDoc(doc));
  assert.equal(restored.activeLayer.name, 'Selected');
});

test('undo and redo restore nested child lists while keeping node identity', t => {
  const doc = groupOnlyDoc(t);
  const parent = doc.addGroup('Parent');
  const left = doc.addGroup('Left');
  const right = doc.addGroup('Right');
  assert.equal(doc.reparent(left.id, parent.id), true);
  assert.equal(doc.reparent(right.id, parent.id, 1), true);

  assert.equal(doc.moveLayerRelative(left.id, right.id, 'above'), 'moved');
  assert.deepEqual(parent.children, [right, left]);
  doc.history.undo();
  assert.deepEqual(parent.children, [left, right]);
  assert.equal(doc.activeLayer, right);
  doc.history.redo();
  assert.deepEqual(parent.children, [right, left]);
  assert.equal(doc.activeLayer, left);

  assert.equal(doc.moveLayerRelative(left.id, right.id, 'into'), 'moved');
  assert.equal(right.children[0], left);
  assert.equal(doc.moveLayerRelative(right.id, left.id, 'into'), 'cycle');
  doc.history.undo();
  assert.deepEqual(parent.children, [right, left]);
  assert.deepEqual(right.children, []);
});
