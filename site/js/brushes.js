/* DEADPIXEL brush engine — procedural tips, presets, stroke pipeline, stamps. */

import { makeCanvas, clamp, hexToRgb } from './engine.js';

/* deterministic PRNG so tips look identical across sessions */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Every tip renders WHITE shapes with alpha into a size×size canvas.
   Color is applied by tinting (source-in). */
const TIP_RENDERERS = {
  round(ctx, s, hardness) {
    const r = s / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    const edge = clamp(hardness, 0, 1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(Math.max(.01, edge * .95), 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  },
  pixel(ctx, s) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, s, s);
  },
  calligraphy(ctx, s, hardness) {
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = '#fff';
    ctx.filter = hardness < .9 ? `blur(${(1 - hardness) * s * .05}px)` : 'none';
    ctx.beginPath();
    ctx.ellipse(0, 0, s * .48, s * .14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
  flat(ctx, s, hardness) {
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.fillStyle = '#fff';
    ctx.filter = hardness < .9 ? `blur(${(1 - hardness) * s * .04}px)` : 'none';
    ctx.fillRect(-s * .48, -s * .09, s * .96, s * .18);
    ctx.restore();
  },
  splatter(ctx, s) {
    const rnd = mulberry(7);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), .6) * s * .44;
      const r = (rnd() * .11 + .02) * s;
      ctx.beginPath();
      ctx.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, r, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  spray(ctx, s) {
    const rnd = mulberry(13);
    for (let i = 0; i < Math.max(60, s * 3); i++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * s * .5;
      ctx.fillStyle = `rgba(255,255,255,${.25 + rnd() * .5})`;
      const r = Math.max(.6, s * .012);
      ctx.fillRect(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, r, r);
    }
  },
  chalk(ctx, s) {
    const rnd = mulberry(29);
    const img = ctx.createImageData(s, s);
    const r = s / 2;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = x - r, dy = y - r;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d > 1) continue;
      const n = rnd();
      const a = n < .45 ? 0 : (1 - d * d) * (120 + n * 135);
      const i = (y * s + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
  },
  grunge(ctx, s) {
    const rnd = mulberry(41);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), .8) * s * .3;
      const rr = (rnd() * .22 + .08) * s;
      ctx.globalAlpha = .35 + rnd() * .5;
      ctx.beginPath();
      ctx.ellipse(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, rr, rr * (rnd() * .5 + .4), rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  static(ctx, s) {
    const rnd = mulberry(404);
    const cell = Math.max(1, Math.round(s / 14));
    for (let y = 0; y < s; y += cell) for (let x = 0; x < s; x += cell) {
      const dx = x - s / 2, dy = y - s / 2;
      if (dx * dx + dy * dy > (s / 2) * (s / 2)) continue;
      if (rnd() < .5) continue;
      ctx.fillStyle = `rgba(255,255,255,${rnd() > .5 ? 1 : .45})`;
      ctx.fillRect(x, y, cell, cell);
    }
  },
  halftone(ctx, s) {
    const cell = Math.max(3, s / 7);
    for (let y = cell / 2; y < s; y += cell) for (let x = cell / 2; x < s; x += cell) {
      const dx = x - s / 2, dy = y - s / 2;
      const d = Math.sqrt(dx * dx + dy * dy) / (s / 2);
      if (d > 1) continue;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, (1 - d) * cell * .48, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  scanline(ctx, s) {
    const band = Math.max(1.5, s / 10);
    const r = s / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#fff';
    for (let y = 0; y < s; y += band * 2) ctx.fillRect(0, y, s, band);
    ctx.restore();
  },
  rake(ctx, s) {
    const rnd = mulberry(97);
    ctx.strokeStyle = '#fff';
    for (let i = 0; i < 7; i++) {
      const y = s * (.15 + .7 * i / 6) + (rnd() - .5) * s * .06;
      ctx.globalAlpha = .5 + rnd() * .5;
      ctx.lineWidth = Math.max(1, s * .04);
      ctx.beginPath();
      ctx.moveTo(s * .1, y); ctx.lineTo(s * .9, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  glow(ctx, s) {
    const r = s / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(255,255,255,.9)');
    g.addColorStop(.25, 'rgba(255,255,255,.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  },
  blot(ctx, s) {
    const rnd = mulberry(66);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = i / n * Math.PI * 2;
      const rr = s * .34 * (1 + (rnd() - .5) * .5);
      const x = s / 2 + Math.cos(a) * rr, y = s / 2 + Math.sin(a) * rr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  },
  cross(ctx, s) {
    ctx.fillStyle = '#fff';
    const t = Math.max(1, s * .16);
    ctx.fillRect(s / 2 - t / 2, s * .06, t, s * .88);
    ctx.fillRect(s * .06, s / 2 - t / 2, s * .88, t);
  },
};

export const BRUSH_PRESETS = [
  { id: 'hard-round', name: 'HARD ROUND', tip: 'round', hardness: .96, spacing: .08, smooth: true },
  { id: 'soft-round', name: 'SOFT ROUND', tip: 'round', hardness: .35, spacing: .1, smooth: true },
  { id: 'airbrush', name: 'AIRBRUSH', tip: 'glow', hardness: .1, spacing: .06, flowScale: .35, smooth: true },
  { id: 'pixel', name: 'PIXEL', tip: 'pixel', hardness: 1, spacing: 1, pixel: true },
  { id: 'calligraphy', name: 'CALLIG', tip: 'calligraphy', hardness: .9, spacing: .07, smooth: true },
  { id: 'flat', name: 'FLAT', tip: 'flat', hardness: .9, spacing: .07, smooth: true },
  { id: 'splatter', name: 'SPLATTER', tip: 'splatter', hardness: 1, spacing: .5, jitter: .4 },
  { id: 'spray', name: 'SPRAY', tip: 'spray', hardness: 1, spacing: .12, flowScale: .5 },
  { id: 'chalk', name: 'CHALK', tip: 'chalk', hardness: 1, spacing: .12, angleJitter: 1 },
  { id: 'grunge', name: 'GRUNGE', tip: 'grunge', hardness: 1, spacing: .35, angleJitter: 1, jitter: .25 },
  { id: 'static', name: 'STATIC', tip: 'static', hardness: 1, spacing: .3, angleJitter: 1 },
  { id: 'halftone', name: 'HALFTONE', tip: 'halftone', hardness: 1, spacing: .25 },
  { id: 'scanline', name: 'SCANLINE', tip: 'scanline', hardness: 1, spacing: .2 },
  { id: 'rake', name: 'RAKE', tip: 'rake', hardness: 1, spacing: .09, smooth: true },
  { id: 'blot', name: 'BLOT', tip: 'blot', hardness: 1, spacing: .4, jitter: .3, angleJitter: 1 },
];

const tipCache = new Map();
export function renderTip(tipId, size, hardness) {
  size = Math.max(1, Math.round(size));
  const key = `${tipId}|${size}|${hardness.toFixed(2)}`;
  if (tipCache.has(key)) return tipCache.get(key);
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  (TIP_RENDERERS[tipId] || TIP_RENDERERS.round)(ctx, size, hardness);
  if (tipCache.size > 220) tipCache.clear();
  tipCache.set(key, c);
  return c;
}

export function tintedTip(tipId, size, hardness, colorHex) {
  const key = `${tipId}|${Math.round(size)}|${hardness.toFixed(2)}|${colorHex}`;
  if (tipCache.has(key)) return tipCache.get(key);
  const base = renderTip(tipId, size, hardness);
  const c = makeCanvas(base.width, base.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(base, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, c.width, c.height);
  if (tipCache.size > 220) tipCache.clear();
  tipCache.set(key, c);
  return c;
}

/* ------------------------------------------------------------- stroke ---
   A Stroke accumulates dabs into its own canvas; the view composites it
   live; commit() bakes it into the layer through the selection mask. */
export class Stroke {
  constructor(doc, layer, settings) {
    // settings: {tip, size, hardness, opacity, flow, spacing, jitter,
    //            angleJitter, color, erase, pressureSize, pressureFlow, pixel}
    this.doc = doc;
    this.layer = layer;
    this.s = settings;
    this.canvas = makeCanvas(doc.width, doc.height);
    this.ctx = this.canvas.getContext('2d');
    if (settings.pixel) this.ctx.imageSmoothingEnabled = false;
    this.last = null;      // last dab position
    this.leftover = 0;     // spacing carry
    this.rnd = Math.random;
    this._smoothPt = null; // exponential smoothing for shaky lines
  }
  dab(x, y, pressure = 1) {
    const s = this.s;
    const size = Math.max(1, s.size * (s.pressureSize ? (.25 + .75 * pressure) : 1));
    const flow = clamp(s.flow * (s.pressureFlow ? pressure : 1) * (s.flowScale || 1), .01, 1);
    if (s.jitter) {
      const a = this.rnd() * Math.PI * 2, d = this.rnd() * s.jitter * size;
      x += Math.cos(a) * d; y += Math.sin(a) * d;
    }
    const tip = tintedTip(s.tip, size, s.hardness, s.color);
    this.ctx.globalAlpha = flow;
    if (s.angleJitter) {
      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(this.rnd() * Math.PI * 2 * s.angleJitter);
      this.ctx.drawImage(tip, -size / 2, -size / 2);
      this.ctx.restore();
    } else if (s.pixel) {
      const px = Math.floor(x - size / 2), py = Math.floor(y - size / 2);
      this.ctx.drawImage(tip, px, py);
    } else {
      this.ctx.drawImage(tip, x - size / 2, y - size / 2);
    }
    this.ctx.globalAlpha = 1;
  }
  moveTo(x, y, pressure = 1) {
    const s = this.s;
    if (s.smooth && this._smoothPt) {
      const k = .35;
      x = this._smoothPt.x + (x - this._smoothPt.x) * k;
      y = this._smoothPt.y + (y - this._smoothPt.y) * k;
    }
    this._smoothPt = { x, y };
    if (!this.last) {
      this.dab(x, y, pressure);
      this.last = { x, y, pressure };
      return;
    }
    const dx = x - this.last.x, dy = y - this.last.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(.5, this.s.size * this.s.spacing);
    let t = step - this.leftover;
    if (dist < t) { this.leftover += dist; this.last = { x, y, pressure }; return; }
    while (t <= dist) {
      const f = t / dist;
      this.dab(this.last.x + dx * f, this.last.y + dy * f,
        this.last.pressure + (pressure - this.last.pressure) * f);
      t += step;
    }
    this.leftover = dist - (t - step);
    this.last = { x, y, pressure };
  }
  /* draw live preview of stroke onto a target ctx (doc space) */
  preview(ctx) {
    ctx.save();
    if (this.doc.selection) {
      // masked preview: draw stroke through mask into temp
      const tmp = makeCanvas(this.doc.width, this.doc.height);
      const tctx = tmp.getContext('2d');
      tctx.drawImage(this.canvas, 0, 0);
      this.doc.selection.maskCanvas(tmp);
      ctx.globalAlpha = this.s.opacity;
      if (this.s.erase) ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(tmp, 0, 0);
    } else {
      ctx.globalAlpha = this.s.opacity;
      if (this.s.erase) ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(this.canvas, 0, 0);
    }
    ctx.restore();
  }
  commit(label = 'Brush stroke') {
    const { doc, layer } = this;
    doc.withLayerSnapshot(label, layer, () => {
      let src = this.canvas;
      if (doc.selection) {
        src = makeCanvas(doc.width, doc.height);
        src.getContext('2d').drawImage(this.canvas, 0, 0);
        doc.selection.maskCanvas(src);
      }
      layer.ctx.save();
      layer.ctx.globalAlpha = this.s.opacity;
      layer.ctx.globalCompositeOperation = this.s.erase ? 'destination-out' : 'source-over';
      layer.ctx.drawImage(src, 0, 0);
      layer.ctx.restore();
    });
  }
}

/* -------------------------------------------------------------- stamps --
   Vector stamps drawn procedurally: render(ctx, size) fills white shapes,
   tinted like brush tips. */
function poly(ctx, pts, close = true) {
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
  if (close) ctx.closePath();
}
function starPts(cx, cy, spikes, outer, inner, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = rot + i * Math.PI / spikes;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

export const STAMPS = [
  { id: 'skull', name: 'SKULL', render(ctx, s) {
    const u = s / 100;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(50 * u, 42 * u, 32 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(30 * u, 55 * u, 40 * u, 26 * u);
    // teeth gaps
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 3; i++) ctx.fillRect((38 + i * 9) * u, 70 * u, 2.6 * u, 12 * u);
    ctx.beginPath(); ctx.arc(38 * u, 40 * u, 8.5 * u, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(62 * u, 40 * u, 8.5 * u, 0, Math.PI * 2); ctx.fill();
    poly(ctx, [[50 * u, 50 * u], [44 * u, 62 * u], [56 * u, 62 * u]]); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }},
  { id: 'pentagram', name: 'PENTAGRAM', render(ctx, s) {
    const u = s / 100;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 4 * u;
    ctx.beginPath(); ctx.arc(50 * u, 50 * u, 46 * u, 0, Math.PI * 2); ctx.stroke();
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * 4 * Math.PI / 5;
      pts.push([50 * u + Math.cos(a) * 46 * u, 50 * u + Math.sin(a) * 46 * u]);
    }
    poly(ctx, pts); ctx.stroke();
  }},
  { id: 'cross-inv', name: 'INV CROSS', render(ctx, s) {
    const u = s / 100;
    ctx.fillStyle = '#fff';
    ctx.fillRect(43 * u, 4 * u, 14 * u, 92 * u);
    ctx.fillRect(22 * u, 62 * u, 56 * u, 14 * u);
  }},
  { id: 'star', name: 'STAR', render(ctx, s) {
    ctx.fillStyle = '#fff';
    poly(ctx, starPts(s / 2, s / 2, 5, s * .48, s * .19)); ctx.fill();
  }},
  { id: 'sparkle', name: 'SPARKLE', render(ctx, s) {
    ctx.fillStyle = '#fff';
    poly(ctx, starPts(s / 2, s / 2, 4, s * .5, s * .1)); ctx.fill();
  }},
  { id: 'burst', name: 'BURST', render(ctx, s) {
    ctx.fillStyle = '#fff';
    poly(ctx, starPts(s / 2, s / 2, 12, s * .5, s * .32)); ctx.fill();
  }},
  { id: 'heart', name: 'HEART', render(ctx, s) {
    const u = s / 100;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(50 * u, 88 * u);
    ctx.bezierCurveTo(0, 52 * u, 8 * u, 8 * u, 50 * u, 32 * u);
    ctx.bezierCurveTo(92 * u, 8 * u, 100 * u, 52 * u, 50 * u, 88 * u);
    ctx.fill();
  }},
  { id: 'heart-broken', name: 'BROKEN', render(ctx, s) {
    STAMPS.find(x => x.id === 'heart').render(ctx, s);
    const u = s / 100;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 6 * u; ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(50 * u, 24 * u); ctx.lineTo(42 * u, 44 * u); ctx.lineTo(58 * u, 58 * u); ctx.lineTo(46 * u, 92 * u);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }},
  { id: 'bolt', name: 'BOLT', render(ctx, s) {
    const u = s / 100;
    ctx.fillStyle = '#fff';
    poly(ctx, [[58 * u, 2 * u], [20 * u, 58 * u], [44 * u, 58 * u], [36 * u, 98 * u], [80 * u, 38 * u], [54 * u, 38 * u]]);
    ctx.fill();
  }},
  { id: 'biohazard', name: 'BIOHAZ', render(ctx, s) {
    const u = s / 100; const cx = 50 * u, cy = 54 * u;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 7 * u;
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 3;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 22 * u, cy + Math.sin(a) * 22 * u, 20 * u, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx, cy, 9 * u, 0, Math.PI * 2); ctx.fill();
  }},
  { id: 'radiation', name: 'RADS', render(ctx, s) {
    const u = s / 100; const cx = 50 * u, cy = 50 * u;
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) {
      const a0 = -Math.PI / 2 + i * 2 * Math.PI / 3 - Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, 46 * u, a0, a0 + Math.PI / 3);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(cx, cy, 14 * u, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.arc(cx, cy, 8 * u, 0, Math.PI * 2); ctx.fill();
  }},
  { id: 'crosshair', name: 'XHAIR', render(ctx, s) {
    const u = s / 100;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5 * u;
    ctx.beginPath(); ctx.arc(50 * u, 50 * u, 34 * u, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    [[50, 4, 50, 28], [50, 72, 50, 96], [4, 50, 28, 50], [72, 50, 96, 50]].forEach(([x1, y1, x2, y2]) => {
      ctx.moveTo(x1 * u, y1 * u); ctx.lineTo(x2 * u, y2 * u);
    });
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(50 * u, 50 * u, 4 * u, 0, Math.PI * 2); ctx.fill();
  }},
  { id: 'eye', name: 'EYE', render(ctx, s) {
    const u = s / 100;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(4 * u, 50 * u);
    ctx.quadraticCurveTo(50 * u, 8 * u, 96 * u, 50 * u);
    ctx.quadraticCurveTo(50 * u, 92 * u, 4 * u, 50 * u);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(50 * u, 50 * u, 17 * u, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.arc(50 * u, 50 * u, 9 * u, 0, Math.PI * 2); ctx.fill();
  }},
  { id: 'arrow', name: 'ARROW', render(ctx, s) {
    const u = s / 100;
    ctx.fillStyle = '#fff';
    poly(ctx, [[6 * u, 42 * u], [58 * u, 42 * u], [58 * u, 22 * u], [94 * u, 50 * u], [58 * u, 78 * u], [58 * u, 58 * u], [6 * u, 58 * u]]);
    ctx.fill();
  }},
  { id: 'nofuture', name: 'CIRCLE-A', render(ctx, s) {
    const u = s / 100;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 6 * u;
    ctx.beginPath(); ctx.arc(50 * u, 50 * u, 42 * u, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(28 * u, 78 * u); ctx.lineTo(50 * u, 20 * u); ctx.lineTo(72 * u, 78 * u);
    ctx.moveTo(12 * u, 60 * u); ctx.lineTo(88 * u, 60 * u);
    ctx.stroke();
  }},
  { id: 'testbars', name: 'SMPTE', render(ctx, s) {
    const u = s / 100;
    const alphas = [1, .82, .66, .5, .36, .24, .14];
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = `rgba(255,255,255,${alphas[i]})`;
      ctx.fillRect((2 + i * 13.7) * u, 10 * u, 12.4 * u, 80 * u);
    }
  }},
  { id: 'nosignal', name: 'NO SIG', render(ctx, s) {
    const u = s / 100;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5 * u;
    ctx.strokeRect(6 * u, 22 * u, 88 * u, 56 * u);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${17 * u}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('NO', 50 * u, 45 * u);
    ctx.fillText('SIGNAL', 50 * u, 66 * u);
  }},
  { id: 'barbs', name: 'BARBS', render(ctx, s) {
    const u = s / 100;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 4.5 * u;
    ctx.beginPath(); ctx.moveTo(0, 50 * u);
    ctx.bezierCurveTo(30 * u, 34 * u, 70 * u, 66 * u, 100 * u, 50 * u);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const x = (14 + i * 24) * u, y = (i % 2 ? 56 : 44) * u;
      ctx.beginPath();
      ctx.moveTo(x - 9 * u, y - 9 * u); ctx.lineTo(x + 9 * u, y + 9 * u);
      ctx.moveTo(x + 9 * u, y - 9 * u); ctx.lineTo(x - 9 * u, y + 9 * u);
      ctx.stroke();
    }
  }},
];

const stampCache = new Map();
export function renderStamp(id, size, colorHex = '#ffffff') {
  const key = `${id}|${Math.round(size)}|${colorHex}`;
  if (stampCache.has(key)) return stampCache.get(key);
  const def = STAMPS.find(s => s.id === id) || STAMPS[0];
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  def.render(ctx, size);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, size, size);
  if (stampCache.size > 120) stampCache.clear();
  stampCache.set(key, c);
  return c;
}
