/* DEADPIXEL filters — adjustments, effects, convolution, actions. */

import { makeCanvas, copyCanvas, clamp } from './engine.js';

function seeded(seed) {
  let a = (Number(seed) || 0x6d2b79f5) >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashSeed(value) {
  let h = 2166136261;
  for (const ch of String(value)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const cl = (v) => v < 0 ? 0 : v > 255 ? 255 : v;

/* ---- pixel helpers ------------------------------------------------------ */

function perPixel(img, fn) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) fn(d, i);
  return img;
}

function convolve(img, w, h, kernel, kw, divisor = null, offset = 0) {
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const half = (kw - 1) / 2;
  let div = divisor;
  if (div === null) { div = kernel.reduce((a, b) => a + b, 0) || 1; }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < kw; ky++) {
        for (let kx = 0; kx < kw; kx++) {
          const sx = clamp(x + kx - half, 0, w - 1);
          const sy = clamp(y + ky - half, 0, h - 1);
          const si = (sy * w + sx) * 4;
          const kv = kernel[ky * kw + kx];
          r += src[si] * kv; g += src[si + 1] * kv; b += src[si + 2] * kv;
        }
      }
      const i = (y * w + x) * 4;
      d[i] = cl(r / div + offset);
      d[i + 1] = cl(g / div + offset);
      d[i + 2] = cl(b / div + offset);
    }
  }
  return img;
}

/* separable box blur on RGBA, radius int ≥1; 3 passes ≈ gaussian */
function boxBlurPass(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  // horizontal
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      const row = y * w * 4 + c;
      for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1) * 4];
      for (let x = 0; x < w; x++) {
        dst[row + x * 4] = acc * iarr;
        const add = src[row + clamp(x + r + 1, 0, w - 1) * 4];
        const sub = src[row + clamp(x - r, 0, w - 1) * 4];
        acc += add - sub;
      }
    }
  }
}
function boxBlurPassV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      const col = x * 4 + c;
      for (let y = -r; y <= r; y++) acc += src[col + clamp(y, 0, h - 1) * w * 4];
      for (let y = 0; y < h; y++) {
        dst[col + y * w * 4] = acc * iarr;
        const add = src[col + clamp(y + r + 1, 0, h - 1) * w * 4];
        const sub = src[col + clamp(y - r, 0, h - 1) * w * 4];
        acc += add - sub;
      }
    }
  }
}
export function gaussianBlurImage(img, w, h, radius) {
  if (radius < 1) return img;
  // premultiply alpha so transparent pixels don't bleed dark fringes
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    d[i] *= a; d[i + 1] *= a; d[i + 2] *= a;
  }
  let a = new Float32Array(d);
  let b = new Float32Array(d.length);
  const r = Math.max(1, Math.round(radius / 2));
  for (let p = 0; p < 3; p++) {
    boxBlurPass(a, b, w, h, r);
    boxBlurPassV(b, a, w, h, r);
  }
  for (let i = 0; i < d.length; i += 4) {
    const al = a[i + 3] / 255;
    if (al > 0.003) {
      d[i] = cl(a[i] / al); d[i + 1] = cl(a[i + 1] / al); d[i + 2] = cl(a[i + 2] / al);
    } else { d[i] = d[i + 1] = d[i + 2] = 0; }
    d[i + 3] = cl(a[i + 3]);
  }
  return img;
}

function rgbToHslPx(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const dd = max - min;
    s = l > .5 ? dd / (2 - max - min) : dd / (max + min);
    if (max === r) h = (g - b) / dd + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / dd + 2;
    else h = (r - g) / dd + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgbPx(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < .5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/* ---- filter registry ----------------------------------------------------
   Each: {id, name, group, params: [{key,label,min,max,step,def}], apply(img,w,h,p)} */

export const FILTERS = [
  /* -------- adjustments -------- */
  {
    id: 'brightness-contrast', name: 'Brightness / Contrast', group: 'adjust',
    params: [
      { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, def: 0 },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, def: 0 },
    ],
    apply(img, w, h, p) {
      const br = p.brightness * 1.275;
      const c = p.contrast / 100;
      const f = c >= 0 ? 1 / Math.max(.0001, 1 - c) : 1 + c;
      return perPixel(img, (d, i) => {
        d[i] = cl((d[i] - 128) * f + 128 + br);
        d[i + 1] = cl((d[i + 1] - 128) * f + 128 + br);
        d[i + 2] = cl((d[i + 2] - 128) * f + 128 + br);
      });
    },
  },
  {
    id: 'hsl', name: 'Hue / Saturation', group: 'adjust',
    params: [
      { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, def: 0 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, def: 0 },
      { key: 'lightness', label: 'Lightness', min: -100, max: 100, step: 1, def: 0 },
    ],
    apply(img, w, h, p) {
      const dh = p.hue / 360, ds = p.saturation / 100, dl = p.lightness / 100;
      return perPixel(img, (d, i) => {
        let [hh, ss, ll] = rgbToHslPx(d[i], d[i + 1], d[i + 2]);
        hh = (hh + dh + 1) % 1;
        ss = clamp(ss * (1 + ds) + (ds > 0 ? ds * .25 : 0), 0, 1);
        ll = clamp(dl >= 0 ? ll + (1 - ll) * dl : ll * (1 + dl), 0, 1);
        const [r, g, b] = hslToRgbPx(hh, ss, ll);
        d[i] = cl(r); d[i + 1] = cl(g); d[i + 2] = cl(b);
      });
    },
  },
  {
    id: 'levels', name: 'Levels', group: 'adjust',
    params: [
      { key: 'inBlack', label: 'In Black', min: 0, max: 254, step: 1, def: 0 },
      { key: 'inWhite', label: 'In White', min: 1, max: 255, step: 1, def: 255 },
      { key: 'gamma', label: 'Gamma ×100', min: 10, max: 300, step: 1, def: 100 },
      { key: 'outBlack', label: 'Out Black', min: 0, max: 255, step: 1, def: 0 },
      { key: 'outWhite', label: 'Out White', min: 0, max: 255, step: 1, def: 255 },
    ],
    apply(img, w, h, p) {
      const ib = p.inBlack, iw = Math.max(p.inWhite, ib + 1), g = p.gamma / 100;
      const ob = p.outBlack, ow = p.outWhite;
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        let t = clamp((v - ib) / (iw - ib), 0, 1);
        t = Math.pow(t, 1 / g);
        lut[v] = cl(ob + t * (ow - ob));
      }
      return perPixel(img, (d, i) => {
        d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
      });
    },
  },
  {
    id: 'invert', name: 'Invert', group: 'adjust', params: [],
    apply(img) {
      return perPixel(img, (d, i) => {
        d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
      });
    },
  },
  {
    id: 'desaturate', name: 'Desaturate', group: 'adjust', params: [],
    apply(img) {
      return perPixel(img, (d, i) => {
        const v = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
        d[i] = d[i + 1] = d[i + 2] = v;
      });
    },
  },
  {
    id: 'posterize', name: 'Posterize', group: 'adjust',
    params: [{ key: 'levels', label: 'Levels', min: 2, max: 16, step: 1, def: 4 }],
    apply(img, w, h, p) {
      const n = p.levels - 1;
      return perPixel(img, (d, i) => {
        d[i] = Math.round(Math.round(d[i] / 255 * n) / n * 255);
        d[i + 1] = Math.round(Math.round(d[i + 1] / 255 * n) / n * 255);
        d[i + 2] = Math.round(Math.round(d[i + 2] / 255 * n) / n * 255);
      });
    },
  },
  {
    id: 'threshold', name: 'Threshold', group: 'adjust',
    params: [{ key: 'level', label: 'Level', min: 1, max: 254, step: 1, def: 128 }],
    apply(img, w, h, p) {
      return perPixel(img, (d, i) => {
        const v = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114 >= p.level ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      });
    },
  },
  {
    id: 'colorize', name: 'Colorize (Red Shift)', group: 'adjust',
    params: [
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, def: 354 },
      { key: 'saturation', label: 'Saturation', min: 0, max: 100, step: 1, def: 80 },
    ],
    apply(img, w, h, p) {
      const hh = p.hue / 360, ss = p.saturation / 100;
      return perPixel(img, (d, i) => {
        const l = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) / 255;
        const [r, g, b] = hslToRgbPx(hh, ss, l);
        d[i] = cl(r); d[i + 1] = cl(g); d[i + 2] = cl(b);
      });
    },
  },

  /* -------- blur / sharpen -------- */
  {
    id: 'gaussian-blur', name: 'Gaussian Blur', group: 'filter',
    params: [{ key: 'radius', label: 'Radius', min: 1, max: 60, step: 1, def: 6 }],
    apply(img, w, h, p) { return gaussianBlurImage(img, w, h, p.radius); },
  },
  {
    id: 'sharpen', name: 'Sharpen', group: 'filter',
    params: [{ key: 'amount', label: 'Amount', min: 1, max: 100, step: 1, def: 40 }],
    apply(img, w, h, p) {
      const a = p.amount / 100;
      const k = [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0];
      return convolve(img, w, h, k, 3, 1);
    },
  },
  {
    id: 'emboss', name: 'Emboss', group: 'filter', params: [],
    apply(img, w, h) { return convolve(img, w, h, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 3, 1); },
  },
  {
    id: 'edge', name: 'Edge Detect', group: 'filter', params: [],
    apply(img, w, h) { return convolve(img, w, h, [-1, -1, -1, -1, 8, -1, -1, -1, -1], 3, 1); },
  },

  /* -------- degradation suite (the house specials) -------- */
  {
    id: 'noise', name: 'Add Noise', group: 'filter',
    params: [
      { key: 'amount', label: 'Amount', min: 1, max: 100, step: 1, def: 20 },
      { key: 'mono', label: 'Monochrome', min: 0, max: 1, step: 1, def: 1 },
    ],
    apply(img, w, h, p) {
      const amt = p.amount * 1.4;
      const rnd = p._seed == null ? Math.random : seeded(p._seed);
      return perPixel(img, (d, i) => {
        if (p.mono) {
          const n = (rnd() - .5) * amt;
          d[i] = cl(d[i] + n); d[i + 1] = cl(d[i + 1] + n); d[i + 2] = cl(d[i + 2] + n);
        } else {
          d[i] = cl(d[i] + (rnd() - .5) * amt);
          d[i + 1] = cl(d[i + 1] + (rnd() - .5) * amt);
          d[i + 2] = cl(d[i + 2] + (rnd() - .5) * amt);
        }
      });
    },
  },
  {
    id: 'pixelate', name: 'Pixelate', group: 'filter',
    params: [{ key: 'size', label: 'Cell Size', min: 2, max: 64, step: 1, def: 8 }],
    apply(img, w, h, p) {
      const s = p.size, d = img.data;
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          const si = (Math.min(h - 1, y + (s >> 1)) * w + Math.min(w - 1, x + (s >> 1))) * 4;
          const r = d[si], g = d[si + 1], b = d[si + 2], a = d[si + 3];
          for (let yy = y; yy < Math.min(y + s, h); yy++) {
            for (let xx = x; xx < Math.min(x + s, w); xx++) {
              const i = (yy * w + xx) * 4;
              d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
            }
          }
        }
      }
      return img;
    },
  },
  {
    id: 'scanlines', name: 'Scanlines', group: 'filter',
    params: [
      { key: 'spacing', label: 'Spacing', min: 2, max: 12, step: 1, def: 3 },
      { key: 'darkness', label: 'Darkness', min: 5, max: 100, step: 1, def: 40 },
    ],
    apply(img, w, h, p) {
      const d = img.data, f = 1 - p.darkness / 100;
      for (let y = 0; y < h; y++) {
        if (y % p.spacing !== 0) continue;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
        }
      }
      return img;
    },
  },
  {
    id: 'chromatic', name: 'Chromatic Aberration', group: 'filter',
    params: [{ key: 'offset', label: 'Offset', min: 1, max: 30, step: 1, def: 4 }],
    apply(img, w, h, p) {
      const src = new Uint8ClampedArray(img.data);
      const d = img.data, o = p.offset;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const ri = (y * w + clamp(x - o, 0, w - 1)) * 4;
          const bi = (y * w + clamp(x + o, 0, w - 1)) * 4;
          d[i] = src[ri];
          d[i + 2] = src[bi + 2];
        }
      }
      return img;
    },
  },
  {
    id: 'vhs', name: 'VHS Tracking', group: 'filter',
    params: [
      { key: 'shift', label: 'Max Shift', min: 2, max: 60, step: 1, def: 14 },
      { key: 'bands', label: 'Band Count', min: 1, max: 20, step: 1, def: 6 },
    ],
    apply(img, w, h, p) {
      const src = new Uint8ClampedArray(img.data);
      const d = img.data;
      const rnd = p._seed == null ? Math.random : seeded(p._seed);
      for (let b = 0; b < p.bands; b++) {
        const by = Math.floor(rnd() * h);
        const bh = 2 + Math.floor(rnd() * Math.max(3, h * .02));
        const shift = Math.floor((rnd() - .3) * p.shift);
        for (let y = by; y < Math.min(by + bh, h); y++) {
          for (let x = 0; x < w; x++) {
            const sx = clamp(x - shift, 0, w - 1);
            const i = (y * w + x) * 4, si = (y * w + sx) * 4;
            d[i] = src[si]; d[i + 1] = src[si + 1]; d[i + 2] = src[si + 2]; d[i + 3] = src[si + 3];
          }
        }
      }
      return img;
    },
  },
  {
    id: 'vignette', name: 'Vignette', group: 'filter',
    params: [{ key: 'amount', label: 'Amount', min: 5, max: 100, step: 1, def: 45 }],
    apply(img, w, h, p) {
      const d = img.data, cx = w / 2, cy = h / 2;
      const maxD = Math.sqrt(cx * cx + cy * cy);
      const amt = p.amount / 100;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxD;
          const f = 1 - amt * Math.pow(dist, 2.2);
          const i = (y * w + x) * 4;
          d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
        }
      }
      return img;
    },
  },
  {
    id: 'glow', name: 'Phosphor Glow', group: 'filter',
    params: [
      { key: 'radius', label: 'Radius', min: 2, max: 40, step: 1, def: 10 },
      { key: 'intensity', label: 'Intensity', min: 10, max: 100, step: 1, def: 55 },
    ],
    apply(img, w, h, p) {
      const blurred = new ImageData(new Uint8ClampedArray(img.data), w, h);
      gaussianBlurImage(blurred, w, h, p.radius);
      const d = img.data, s = blurred.data, k = p.intensity / 100;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = cl(d[i] + s[i] * k);
        d[i + 1] = cl(d[i + 1] + s[i + 1] * k);
        d[i + 2] = cl(d[i + 2] + s[i + 2] * k);
      }
      return img;
    },
  },
  {
    id: 'interference', name: 'Interference', group: 'filter',
    params: [
      { key: 'strength', label: 'Strength', min: 5, max: 100, step: 1, def: 30 },
      { key: 'freq', label: 'Frequency', min: 1, max: 40, step: 1, def: 9 },
    ],
    apply(img, w, h, p) {
      const d = img.data, k = p.strength / 100;
      const rnd = p._seed == null ? Math.random : seeded(p._seed);
      const phase = rnd() * Math.PI * 2;
      for (let y = 0; y < h; y++) {
        const s = Math.sin(y / h * Math.PI * p.freq + phase) * 40 * k;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          d[i] = cl(d[i] + s); d[i + 1] = cl(d[i + 1] + s * .4); d[i + 2] = cl(d[i + 2] + s * .6);
        }
      }
      return img;
    },
  },
];

export const filterById = (id) => FILTERS.find(f => f.id === id);

export function processFilterPixels(data, w, h, filterId, params = {}) {
  const f = filterById(filterId);
  if (!f) throw new Error('Unknown filter: ' + filterId);
  const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  f.apply({ data: pixels }, w, h, { ...defaultParams(filterId), ...params });
  return pixels;
}

let processingWorker = null;
let processingJobId = 0;
const processingJobs = new Map();
export const processingStats = { completed: 0, cancelled: 0, lastMs: 0, queued: 0, peakQueued: 0, stageHits: 0, stageMisses: 0, cacheBytes: 0, cacheLimited: false, previewScale: 1, moduleMs: {} };
const MAX_STAGE_CACHE_BYTES = 64 * 1024 * 1024;

function cancelProcessingJobs(kind) {
  const matches = [...processingJobs.entries()].filter(([, job]) => job.kind === kind);
  if (!matches.length) return;
  for (const [id, job] of processingJobs) {
    processingJobs.delete(id);
    processingStats.cancelled++;
    job.reject(new DOMException('Superseded processing job', 'AbortError'));
  }
  // Pixel kernels are synchronous inside the worker; termination is the only
  // way to stop a currently running obsolete job rather than merely ignore it.
  processingWorker?.terminate();
  processingWorker = null;
}

function getProcessingWorker() {
  if (processingWorker || typeof Worker === 'undefined') return processingWorker;
  try {
    processingWorker = new Worker(new URL('./processing-worker.js', import.meta.url), { type: 'module' });
    processingWorker.onmessage = ({ data }) => {
      const job = processingJobs.get(data.id);
      if (!job) return;
      processingJobs.delete(data.id);
      processingStats.queued = processingJobs.size;
      processingStats.completed++;
      processingStats.lastMs = performance.now() - job.started;
      if (job.module) processingStats.moduleMs[job.module] = Math.round(processingStats.lastMs * 10) / 10;
      data.error ? job.reject(new Error(data.error)) : job.resolve(new Uint8ClampedArray(data.buffer));
    };
    processingWorker.onerror = (event) => {
      for (const job of processingJobs.values()) {
        try { job.resolve(job.fallback()); }
        catch (error) { job.reject(error); }
      }
      processingJobs.clear();
      processingWorker?.terminate();
      processingWorker = null;
    };
  } catch (_) { processingWorker = null; }
  return processingWorker;
}

export function processFilterPixelsAsync(data, w, h, filterId, params = {}) {
  const worker = getProcessingWorker();
  const pixels = new Uint8ClampedArray(data);
  if (!worker) return Promise.resolve(processFilterPixels(pixels, w, h, filterId, params));
  const id = ++processingJobId;
  return new Promise((resolve, reject) => {
    processingJobs.set(id, {
      resolve, reject, kind: 'filter', started: performance.now(),
      fallback: () => processFilterPixels(new Uint8ClampedArray(data), w, h, filterId, params),
    });
    processingStats.queued = processingJobs.size; processingStats.peakQueued = Math.max(processingStats.peakQueued, processingStats.queued);
    worker.postMessage({ id, kind: 'filter', buffer: pixels.buffer, w, h, filterId, params }, [pixels.buffer]);
  });
}

export function processSignalPixels(data, w, h, effects, seed = 0) {
  const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  for (let i = 0; i < (effects || []).length; i++) {
    const effect = effects[i];
    if (effect.enabled === false) continue;
    const effectSeed = hashSeed(`${seed}:${effect.id || effect.filter}:${effect._signalIndex ?? i}`);
    const mix = Math.max(0, Math.min(1, effect.mix == null ? 1 : effect.mix));
    const before = mix < 1 || effect.mask ? new Uint8ClampedArray(pixels) : null;
    processFilterPixels(pixels, w, h, effect.filter, { ...(effect.params || {}), _seed: effectSeed });
    if (before) {
      for (let p = 0; p < pixels.length; p += 4) {
        let mask = 1;
        if (effect.mask === 'luma') mask = (before[p] * .2126 + before[p + 1] * .7152 + before[p + 2] * .0722) / 255;
        else if (effect.mask === 'alpha') mask = before[p + 3] / 255;
        else if (effect.mask === 'raster' && effect.maskPixels) mask = effect.maskPixels[p >> 2] / 255;
        if (effect.maskInvert) mask = 1 - mask;
        const amount = mix * mask;
        for (let c = 0; c < 4; c++) pixels[p + c] = before[p + c] + (pixels[p + c] - before[p + c]) * amount;
      }
    }
  }
  return pixels;
}

export function processSignalPixelsAsync(data, w, h, effects, seed = 0) {
  const worker = getProcessingWorker();
  const pixels = new Uint8ClampedArray(data);
  if (!worker) return Promise.resolve(processSignalPixels(pixels, w, h, effects, seed));
  const id = ++processingJobId;
  return new Promise((resolve, reject) => {
    processingJobs.set(id, {
      resolve, reject, kind: 'signal', started: performance.now(),
      module: effects?.length === 1 ? effects[0].filter : null,
      fallback: () => processSignalPixels(new Uint8ClampedArray(data), w, h, effects, seed),
    });
    processingStats.queued = processingJobs.size; processingStats.peakQueued = Math.max(processingStats.peakQueued, processingStats.queued);
    worker.postMessage({ id, kind: 'signal', buffer: pixels.buffer, w, h, effects, seed }, [pixels.buffer]);
  });
}

/* Apply filter to a layer canvas, honoring selection mask. */
export function applyFilterToLayer(doc, layer, filterId, params) {
  const f = filterById(filterId);
  if (!f) return;
  const w = layer.canvas.width, h = layer.canvas.height;
  const before = doc.selection ? copyCanvas(layer.canvas) : null;
  const img = layer.ctx.getImageData(0, 0, w, h);
  f.apply(img, w, h, params);
  layer.ctx.putImageData(img, 0, 0);
  if (doc.selection) {
    // filtered result only inside selection: filtered∙mask over original
    const filtered = copyCanvas(layer.canvas);
    doc.selection.maskCanvas(filtered);
    layer.ctx.clearRect(0, 0, w, h);
    layer.ctx.drawImage(before, 0, 0);
    layer.ctx.drawImage(filtered, 0, 0);
  }
}

export async function applyFilterToLayerAsync(doc, layer, filterId, params) {
  const w = layer.canvas.width, h = layer.canvas.height;
  const original = doc.selection ? copyCanvas(layer.canvas) : null;
  const input = layer.ctx.getImageData(0, 0, w, h);
  const pixels = await processFilterPixelsAsync(input.data, w, h, filterId, params);
  const output = layer.ctx.createImageData(w, h);
  output.data.set(pixels);
  layer.ctx.putImageData(output, 0, 0);
  if (doc.selection) {
    const filtered = copyCanvas(layer.canvas);
    doc.selection.maskCanvas(filtered);
    layer.ctx.clearRect(0, 0, w, h);
    layer.ctx.drawImage(original, 0, 0);
    layer.ctx.drawImage(filtered, 0, 0);
  }
}

export function defaultParams(filterId) {
  const f = filterById(filterId);
  const p = {};
  (f?.params || []).forEach(pr => p[pr.key] = pr.def);
  return p;
}

function stageKeys(effects, seed) {
  let prefix = String(seed >>> 0);
  return (effects || []).map((effect, index) => prefix += '|' + JSON.stringify({ ...effect, maskPixels: effect.maskPixels ? `mask:${effect.maskId || index}` : null }));
}

function stageStart(cache, keys) {
  if (!cache?.keys || !cache?.stages) return 0;
  let start = 0;
  while (start < keys.length && cache.keys[start] === keys[start] && cache.stages[start]) start++;
  processingStats.stageHits += start; processingStats.stageMisses += keys.length - start;
  return start;
}

function storeStage(cache, index, keys, pixels) {
  if (!cache) return;
  cache.keys = keys; cache.stages ||= [];
  const bytes = pixels.byteLength * (index + 1);
  if (bytes <= MAX_STAGE_CACHE_BYTES) cache.stages[index] = new Uint8ClampedArray(pixels);
  else processingStats.cacheLimited = true;
  processingStats.cacheBytes = cache.stages.reduce((sum, stage) => sum + (stage?.byteLength || 0), 0);
}

export function processSignalStack(canvas, effects, seed = 0, cache = null) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const keys = stageKeys(effects, seed), start = stageStart(cache, keys);
  if (start) image.data.set(cache.stages[start - 1]);
  for (let i = start; i < (effects || []).length; i++) {
    processSignalPixels(image.data, canvas.width, canvas.height, [{ ...effects[i], _signalIndex: i }], seed);
    storeStage(cache, i, keys, image.data);
  }
  if (cache) { cache.keys = keys; cache.stages.length = keys.length; }
  ctx.putImageData(image, 0, 0);
}

export function processSignalStackAsync(canvas, effects, seed = 0, cache = null) {
  const maxPreviewPixels = 2_000_000;
  if (canvas.width * canvas.height > maxPreviewPixels) {
    const scale = Math.sqrt(maxPreviewPixels / (canvas.width * canvas.height));
    processingStats.previewScale = scale;
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    const preview = makeCanvas(w, h);
    preview.getContext('2d').drawImage(canvas, 0, 0, w, h);
    const pctx = preview.getContext('2d', { willReadFrequently: true });
    const input = pctx.getImageData(0, 0, w, h);
    return processSignalPixelsAsync(input.data, w, h, effects, seed).then((pixels) => {
      const image = pctx.createImageData(w, h); image.data.set(pixels); pctx.putImageData(image, 0, 0);
      const output = makeCanvas(canvas.width, canvas.height);
      output.getContext('2d').drawImage(preview, 0, 0, output.width, output.height);
      return output.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, output.width, output.height).data;
    });
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  processingStats.previewScale = 1;
  const keys = stageKeys(effects, seed), start = stageStart(cache, keys);
  let pixels = start ? new Uint8ClampedArray(cache.stages[start - 1]) : image.data;
  return (async () => {
    for (let i = start; i < (effects || []).length; i++) {
      pixels = await processSignalPixelsAsync(pixels, canvas.width, canvas.height, [{ ...effects[i], _signalIndex: i }], seed);
      storeStage(cache, i, keys, pixels);
    }
    if (cache) { cache.keys = keys; cache.stages.length = keys.length; }
    return pixels;
  })();
}

export { seeded, hashSeed };

/* ---- actions ------------------------------------------------------------
   An action = named sequence of {filter, params} steps. */

export const BUILTIN_ACTIONS = [
  { id: 'dead-channel', name: 'DEAD CHANNEL', steps: [
    { filter: 'desaturate', params: {} },
    { filter: 'brightness-contrast', params: { brightness: -8, contrast: 28 } },
    { filter: 'scanlines', params: { spacing: 3, darkness: 38 } },
    { filter: 'noise', params: { amount: 18, mono: 1 } },
    { filter: 'vignette', params: { amount: 52 } },
  ]},
  { id: 'vhs-eulogy', name: 'VHS EULOGY', steps: [
    { filter: 'chromatic', params: { offset: 5 } },
    { filter: 'vhs', params: { shift: 16, bands: 7 } },
    { filter: 'hsl', params: { hue: 0, saturation: -28, lightness: 0 } },
    { filter: 'noise', params: { amount: 14, mono: 0 } },
    { filter: 'interference', params: { strength: 22, freq: 7 } },
  ]},
  { id: 'phosphor-burn', name: 'PHOSPHOR BURN', steps: [
    { filter: 'glow', params: { radius: 12, intensity: 70 } },
    { filter: 'colorize', params: { hue: 354, saturation: 72 } },
    { filter: 'scanlines', params: { spacing: 3, darkness: 30 } },
    { filter: 'brightness-contrast', params: { brightness: 0, contrast: 18 } },
  ]},
  { id: 'xerox-gospel', name: 'XEROX GOSPEL', steps: [
    { filter: 'desaturate', params: {} },
    { filter: 'brightness-contrast', params: { brightness: 10, contrast: 42 } },
    { filter: 'threshold', params: { level: 132 } },
    { filter: 'noise', params: { amount: 24, mono: 1 } },
  ]},
  { id: 'blood-chrome', name: 'BLOOD CHROME', steps: [
    { filter: 'posterize', params: { levels: 5 } },
    { filter: 'colorize', params: { hue: 352, saturation: 88 } },
    { filter: 'sharpen', params: { amount: 55 } },
    { filter: 'vignette', params: { amount: 35 } },
  ]},
  { id: 'midnight-broadcast', name: 'MIDNIGHT BROADCAST', steps: [
    { filter: 'brightness-contrast', params: { brightness: -22, contrast: 22 } },
    { filter: 'hsl', params: { hue: -8, saturation: -35, lightness: -6 } },
    { filter: 'vignette', params: { amount: 65 } },
    { filter: 'scanlines', params: { spacing: 4, darkness: 30 } },
    { filter: 'noise', params: { amount: 10, mono: 1 } },
  ]},
  { id: 'open-casket', name: 'OPEN CASKET', steps: [
    { filter: 'gaussian-blur', params: { radius: 2 } },
    { filter: 'glow', params: { radius: 18, intensity: 45 } },
    { filter: 'hsl', params: { hue: 0, saturation: -55, lightness: 8 } },
    { filter: 'vignette', params: { amount: 58 } },
  ]},
  { id: 'signal-lost', name: 'SIGNAL LOST', steps: [
    { filter: 'pixelate', params: { size: 6 } },
    { filter: 'vhs', params: { shift: 30, bands: 12 } },
    { filter: 'chromatic', params: { offset: 8 } },
    { filter: 'noise', params: { amount: 40, mono: 0 } },
  ]},
];

export function runAction(doc, layer, action) {
  doc.withLayerSnapshot('Action: ' + action.name, layer, () => {
    for (const step of action.steps) {
      applyFilterToLayer(doc, layer, step.filter, { ...defaultParams(step.filter), ...step.params });
    }
  });
}
