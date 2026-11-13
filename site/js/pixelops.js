/* DEADPIXEL pixelops — pure raster/array math: mask morphology (feather,
   expand/contract), median filtering (spot heal), and perspective math
   (distort transform). Node-safe: no canvas, no engine import.

   All alpha helpers work on Uint8ClampedArray-like RGBA blocks laid out
   as width×height, row-major, 4 bytes per pixel. */

const INF = 1e12;

/* separable box blur on one channel (alpha or a masked copy), repeated
   passes approximate a gaussian; returns a new Uint8ClampedArray-like
   data only if the caller passes a full RGBA block, else a plain array */
export function blurAlpha(data, w, h, r, passes = 3) {
  r = Math.round(r);
  if (r < 1) return data;
  const src = new Float32Array(w * h);
  for (let i = 0; i < src.length; i++) src[i] = data[i * 4 + 3];
  let cur = src;
  for (let p = 0; p < passes; p++) cur = boxBlur(cur, w, h, r);
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = cur[i];
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = r * 2 + 1;
  // horizontal
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      const add = src[y * w + Math.min(w - 1, x + r + 1)];
      const sub = src[y * w + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
  return out;
}

/* exact Euclidean distance transform (Felzenszwalb-Huttenlocher).
   EDT(seed(x,y)) = min over seed cells of (x-x')^2 + (y-y')^2 */
function edt1d(f, out, n, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    out[q] = dx * dx + f[v[k]];
  }
}

export function distanceTo(alpha, w, h, inside /* seed predicate: boolean */) {
  const dt = new Float64Array(w * h);
  const f = new Float64Array(Math.max(w, h));
  const out = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  // pass 1: columns → d0 = min over y' (y-y')^2 [seed(x,y')]
  const d0 = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = inside(alpha[(y * w + x) * 4 + 3], x, y) ? 0 : INF;
    edt1d(f, out, h, v, z);
    for (let y = 0; y < h; y++) d0[y * w + x] = out[y] + x * x;
  }
  // pass 2: rows → min over x' (d0 + (x-x')^2) - x'^2 handled by f trick
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d0[y * w + x] - x * x;
    edt1d(f, out, w, v, z);
    for (let x = 0; x < w; x++) dt[y * w + x] = out[x];
  }
  return dt;
}

/* binary morphology on the alpha>=128 core with a soft 1px edge band:
   expand fills everything within r of the core (alpha 255) and fades
   linearly to 0 across the next 1px; contract clears everything within
   r of a hole and fades back to the original alpha across the next 1px.
   Canvas border is not a hole (empty neighbors only come from real
   transparent/non-selected cells). Merges with the original alpha via
   max (expand) / min (contract) so existing partial values survive. */
export function growAlpha(data, w, h, r, erode = false) {
  r = Math.round(r);
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  if (r < 1) return out;
  const dt = erode
    ? distanceTo(data, w, h, (a) => a < 128) // distance to the nearest hole
    : distanceTo(data, w, h, (a) => a >= 128); // distance to the core
  const r2 = r * r;
  for (let i = 0; i < w * h; i++) {
    const orig = data[i * 4 + 3];
    const d2 = dt[i];
    let a;
    if (erode) {
      if (d2 <= r2) out[i * 4 + 3] = 0;
      else {
        const d = Math.sqrt(d2);
        a = d <= r + 1 ? Math.min(orig, Math.round(255 * (d - r))) : orig;
        out[i * 4 + 3] = a;
      }
    } else {
      if (d2 <= r2) a = 255;
      else {
        const d = Math.sqrt(d2);
        a = d < r + 1 ? Math.round(255 * (1 - (d - r))) : 0;
      }
      out[i * 4 + 3] = Math.max(orig, a);
    }
  }
  return out;
}

/* median filter over the RGB channels inside a region; alpha is kept.
   data is the region's RGBA block (w×h), k is the odd window size. */
export function medianRGB(data, w, h, k = 3) {
  const half = Math.max(0, (k - 1) >> 1);
  const out = new Uint8ClampedArray(data);
  const rs = [], gs = [], bs = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      rs.length = gs.length = bs.length = 0;
      for (let dy = -half; dy <= half; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -half; dx <= half; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          if (data[i + 3] < 128) continue;
          rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
        }
      }
      if (rs.length < 3) continue; // too sparse to trust
      rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b);
      const m = rs.length >> 1;
      const i = (y * w + x) * 4;
      out[i] = rs[m]; out[i + 1] = gs[m]; out[i + 2] = bs[m];
    }
  }
  return out;
}

/* perspective: solve the 3×3 homography H with H(2,2)=1 from 4 point
   pairs; pts are [{x,y}]. Returns Float64Array(9) or null (degenerate). */
export function solveHomography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
  }
  const M = A.map(r => r.slice());
  // gaussian elimination with partial pivot (8x9 → x)
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j < 9; j++) M[col][j] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let j = col; j < 9; j++) M[r][j] -= f * M[col][j];
    }
  }
  const H = new Float64Array(9);
  for (let c = 0; c < 8; c++) H[c] = M[c][8];
  H[8] = 1;
  return H;
}

export function applyHomography(H, x, y) {
  const den = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / den, y: (H[3] * x + H[4] * y + H[5]) / den };
}

/* affine mapping sending triangle src onto triangle dst (5 scalar pairs) */
export function affineForTriangle(s0, s1, s2, d0, d1, d2) {
  const x1 = s1.x - s0.x, y1 = s1.y - s0.y, x2 = s2.x - s0.x, y2 = s2.y - s0.y;
  const u1 = d1.x - d0.x, v1 = d1.y - d0.y, u2 = d2.x - d0.x, v2 = d2.y - d0.y;
  if (Math.abs(x1 * y2 - x2 * y1) < 1e-9) return null; // degenerate source
  if (Math.abs(u1 * v2 - u2 * v1) < 1e-9) return null; // degenerate destination
  const det = x1 * y2 - x2 * y1;
  const a = (u1 * y2 - u2 * y1) / det, c = (u2 * x1 - u1 * x2) / det;
  const b = (v1 * y2 - v2 * y1) / det, d = (v2 * x1 - v1 * x2) / det;
  return { a, b, c, d, e: d0.x - a * s0.x - c * s0.y, f: d0.y - b * s0.x - d * s0.y };
}
