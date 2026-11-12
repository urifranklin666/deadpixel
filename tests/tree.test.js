import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupLayer, flattenLayers, countLeaves, MAX_TREE_DEPTH, uid } from '../site/js/engine.js';

/* Canvas-free tree tests: everything here runs in plain node.
   Doc-level structural operations (groups, reparenting, clipping) are
   covered by the Playwright suite through window.deadpixel. */

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
