import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blurAlpha, distanceTo, growAlpha, medianRGB,
  solveHomography, applyHomography, affineForTriangle,
} from '../site/js/pixelops.js';

/* Pure-math raster tests: no canvas, no DOM. The helpers operate on RGBA
   blocks (Uint8ClampedArray) laid out width×height, row-major. */

const block = (w, h, fill = 0) => new Uint8ClampedArray(w * h * 4).fill(fill);
const alphaAt = (d, w, x, y) => d[(y * w + x) * 4 + 3];
const setOpaque = (d, w, x, y, r = 255, g = 0, b = 0) => {
  const i = (y * w + x) * 4;
  d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
};
const alphaEnergy = (d) =>
  d.reduce((s, v, i) => s + (i % 4 === 3 ? v : 0), 0);

test('blurAlpha spreads an isolated core and preserves RGB + energy', () => {
  const w = 9, h = 9;
  const d = block(w, h);
  setOpaque(d, w, 4, 4); // white opaque dot, rest is transparent black
  const out = blurAlpha(d, w, h, 1, 3);
  // RGB bytes untouched (only alpha moves)
  assert.equal(out[(4 * 9 + 4) * 4], 255);
  const before = alphaEnergy(d), after = alphaEnergy(out);
  assert.ok(Math.abs(after - before) / before < 0.05,
    `alpha energy drifted: ${before} → ${after}`);
  // the hard core softens; the halo appears 3px out and dies before the corner
  // (3 passes of r=1 box blur of a delta: centre ≈ 255·(1/3)³ spread wide)
  const centreA = out[(4 * 9 + 4) * 4 + 3];
  assert.ok(centreA > 5 && centreA < 200, `centre must soften, got ${centreA}`);
  assert.ok(alphaAt(out, w, 4, 1) > 0, 'blur must reach 3px out at r=1 ×3 passes');
  assert.equal(alphaAt(out, w, 0, 0), 0);
  // r < 1 is a no-op (values unchanged)
  const same = blurAlpha(d, w, h, 0);
  assert.equal(alphaAt(same, w, 4, 4), 255);
  assert.equal(alphaAt(same, w, 3, 4), 0);
});

test('distanceTo is the exact squared Euclidean transform of the seeds', () => {
  const w = 7, h = 7;
  const d = block(w, h);
  setOpaque(d, w, 3, 3);
  const dt = distanceTo(d, w, h, (a) => a >= 128);
  assert.equal(dt[3 * 7 + 3], 0);
  assert.equal(dt[0], 18); // (3,3) → (0,0): 9 + 9
  assert.equal(dt[3], 9); // straight along the column
  assert.equal(dt[4], 10); // (4,0): 1 + 9
});

test('growAlpha expands r=1 into a hard plus with a soft fringe', () => {
  const w = 7, h = 7;
  const d = block(w, h);
  setOpaque(d, w, 3, 3);
  const plus = growAlpha(d, w, h, 1);
  assert.equal(alphaAt(plus, w, 3, 3), 255);
  assert.equal(alphaAt(plus, w, 2, 3), 255, 'cardinal is exactly r away');
  const diag = alphaAt(plus, w, 2, 2); // dist √2 ≈ 1.414 → 255·(2−√2)
  assert.ok(diag > 100 && diag < 200, `diagonal fringe must be soft, got ${diag}`);
  assert.equal(alphaAt(plus, w, 0, 0), 0);
});

test('growAlpha dilates r=2 over the round footprint, not the square', () => {
  const w = 9, h = 9;
  const d = block(w, h);
  setOpaque(d, w, 4, 4);
  const out = growAlpha(d, w, h, 2);
  for (const [x, y] of [[4, 4], [2, 4], [4, 2], [6, 4], [4, 6]]) {
    assert.ok(alphaAt(out, w, x, y) > 128, `core cell (${x},${y}) must fill`);
  }
  const corner = alphaAt(out, w, 2, 2); // dist 2√2 → thin fringe
  assert.ok(corner > 0 && corner < 128, `corner fringe soft, got ${corner}`);
  assert.equal(alphaAt(out, w, 8, 8), 0, 'dist 4√2 > 3 must stay empty');
  // fractional radii round to the nearest integer
  const r15 = growAlpha(d, w, h, 1.5);
  assert.equal(alphaAt(r15, w, 8, 8), 0);
  assert.equal(alphaAt(r15, w, 2, 4), 255);
});

test('growAlpha contracts with Euclidean rims and soft corners', () => {
  const w = 9, h = 9;
  const d = block(w, h);
  for (let y = 2; y <= 6; y++)
    for (let x = 2; x <= 6; x++) setOpaque(d, w, x, y, 255, 255, 255);
  const out = growAlpha(d, w, h, 1, true);
  // cells exactly 1px from a hole are cleared (corners too: the top/left
  // hole rows are orthogonal neighbours of the block corner)
  assert.equal(alphaAt(out, w, 2, 4), 0);
  assert.equal(alphaAt(out, w, 4, 2), 0);
  assert.equal(alphaAt(out, w, 2, 2), 0);
  // interior (dist 2+) survives intact
  for (let y = 3; y <= 5; y++)
    for (let x = 3; x <= 5; x++)
      assert.ok(alphaAt(out, w, x, y) > 200, `interior (${x},${y}) must survive`);
  // r=2 collapses the 5×5 block to the single center cell
  const tighter = growAlpha(d, w, h, 2, true);
  const cores = tighter.reduce((s, v, i) => s + (i % 4 === 3 && v > 128 ? 1 : 0), 0);
  assert.equal(cores, 1);
  assert.ok(alphaAt(tighter, w, 4, 4) > 200);
});

test('growAlpha contract keeps a soft rim where holes are diagonal-only', () => {
  const w = 9, h = 9;
  const d = block(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) setOpaque(d, w, x, y, 255, 255, 255);
  d[(4 * 9 + 4) * 4 + 3] = 0; // a single hole, every neighbour opaque
  const out = growAlpha(d, w, h, 1, true);
  // orthogonal neighbours of the hole are within r → cleared
  assert.equal(alphaAt(out, w, 4, 3), 0);
  assert.equal(alphaAt(out, w, 3, 4), 0);
  // diagonal corners of the hole sit at √2 → min(orig, 255·(√2−1)) ≈ 105
  const corner = alphaAt(out, w, 3, 3);
  assert.ok(corner > 50 && corner < 128, `soft rim, got ${corner}`);
  // the far field is untouched
  assert.equal(alphaAt(out, w, 0, 0), 255);
  assert.equal(alphaAt(out, w, 1, 1), 255); // dist 2√2 > band
});

test('growAlpha honors a seed touching the canvas corner', () => {
  const w = 4, h = 4;
  const d = block(w, h);
  setOpaque(d, w, 0, 0);
  const out = growAlpha(d, w, h, 1);
  assert.equal(alphaAt(out, w, 0, 0), 255);
  assert.equal(alphaAt(out, w, 1, 0), 255);
  assert.equal(alphaAt(out, w, 0, 1), 255);
  const diag = alphaAt(out, w, 1, 1);
  assert.ok(diag > 50 && diag < 200, `soft diagonal fringe, got ${diag}`);
  assert.equal(alphaAt(out, w, 3, 0), 0);
  // an empty mask must stay empty (distanceTo over an all-hole grid = no-op)
  const empty = growAlpha(block(w, h), w, h, 3);
  assert.equal(alphaEnergy(empty), 0);
});

test('medianRGB clears a salt blemish, keeps alpha, skips sparse regions', () => {
  const w = 5, h = 5;
  const d = block(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) setOpaque(d, w, x, y, 200, 210, 220);
  setOpaque(d, w, 2, 2, 10, 20, 30); // outlier
  const out = medianRGB(d, w, h, 3);
  assert.ok(Math.abs(out[(2 * 5 + 2) * 4] - 200) < 25, 'red median must crowd out the salt');
  assert.ok(Math.abs(out[(2 * 5 + 2) * 4 + 2] - 220) < 25);
  // untouched pixels are unchanged (median of a constant is the constant)
  assert.equal(out[0], d[0]);
  // alpha is fully preserved
  for (let i = 0; i < d.length; i += 4) assert.equal(out[i + 3], 255);
  // an outlier among only two opaque samples is left alone (no invented data)
  const s = 8;
  const sp = block(s, s);
  setOpaque(sp, s, 3, 3, 7, 7, 7);
  setOpaque(sp, s, 4, 4, 250, 250, 250);
  const so = medianRGB(sp, s, s, 3);
  assert.equal(so[(4 * 8 + 4) * 4], 250, 'too few samples in window → untouched');
});

test('solveHomography: identity roundtrip, projective roundtrip, degenerate', () => {
  const sq = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }];
  const H1 = solveHomography(sq, sq);
  assert.ok(H1);
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(H1, sq[i].x, sq[i].y);
    assert.ok(Math.abs(p.x - sq[i].x) < 1e-9 && Math.abs(p.y - sq[i].y) < 1e-9);
  }
  // a real projective map: square → trapezoid, solve must invert it
  const trap = [{ x: 1, y: 1 }, { x: 7, y: 2 }, { x: 7, y: 7 }, { x: 1, y: 6 }];
  const H2 = solveHomography(sq, trap);
  assert.ok(H2);
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(H2, sq[i].x, sq[i].y);
    assert.ok(Math.abs(p.x - trap[i].x) < 1e-6 && Math.abs(p.y - trap[i].y) < 1e-6,
      `corner ${i}: got (${p.x.toFixed(4)}, ${p.y.toFixed(4)})`);
  }
  // degenerate (collinear destination) → null, not garbage
  const collinear = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
  assert.equal(solveHomography(sq, collinear), null);
});

test('affineForTriangle maps triangle→triangle and rejects degenerates', () => {
  const s0 = { x: 0, y: 0 }, s1 = { x: 4, y: 0 }, s2 = { x: 0, y: 4 };
  const id = affineForTriangle(s0, s1, s2, s0, s1, s2);
  assert.deepEqual([id.a, id.b, id.c, id.d, id.e, id.f], [1, 0, 0, 1, 0, 0]);
  const A = affineForTriangle(
    s0, s1, s2,
    { x: 10, y: 0 }, { x: 18, y: 0 }, { x: 10, y: 8 }, // ×2 then translate x+10
  );
  const p = { x: A.a * 2 + A.c * 2 + A.e, y: A.b * 2 + A.d * 2 + A.f };
  assert.ok(Math.abs(p.x - 14) < 1e-9 && Math.abs(p.y - 4) < 1e-9);
  assert.equal(affineForTriangle(s0, s1, s2, s0, s0, s0), null, 'collinear dst');
});
