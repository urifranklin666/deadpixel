/* DEADPIXEL engine — document, layer tree, history, selection, compositing.
   Layer tree: GroupLayer nodes hold children; raster and text layers are leaves.
   Leaves can carry a nondestructive layer mask and a clipping flag. */

import { blurAlpha, growAlpha } from './pixelops.js';

let _uid = 1;
export const uid = () => 'L' + (_uid++) + '_' + Date.now().toString(36);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export const MAX_TREE_DEPTH = 8;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export const BLEND_MODES = [
  ['pass-through', 'Pass Through'], ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'],
  ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'], ['color-burn', 'Color Burn'],
  ['hard-light', 'Hard Light'], ['soft-light', 'Soft Light'],
  ['difference', 'Difference'], ['exclusion', 'Exclusion'],
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

/* ---------------------------------------------------------------- layers */

/* shared, versioned visual state for every node (groups included) */
function baseLayerState(self, name) {
  self.id = uid();
  self.name = name;
  self.visible = true;
  self.opacity = 1;
  self.blend = 'source-over';
  self.locked = false;
  self.clipped = false;
  self.revision = 0;
  self.effects = [];
  self.signalSeed = (Math.random() * 0xffffffff) >>> 0;
  self.mask = null;            // grayscale layer mask (alpha = coverage)
  self.maskEnabled = true;
  self.maskRevision = 0;
}

/* copy shared visual state; canvases are handled by the caller */
function copyShared(from, to) {
  to.name = from.name;
  to.visible = from.visible;
  to.opacity = from.opacity;
  to.blend = from.blend;
  to.locked = from.locked;
  to.clipped = from.clipped;
  to.revision = from.revision;
  to.effects = JSON.parse(JSON.stringify(from.effects || []));
  to.signalSeed = from.signalSeed >>> 0;
  to.mask = from.mask ? copyCanvas(from.mask) : null;
  to.maskEnabled = from.maskEnabled;
  to.maskRevision = from.maskRevision;
  return to;
}

export class Layer {
  constructor(w, h, name = 'Layer') {
    baseLayerState(this, name);
    this.type = 'raster';
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }
  draw(ctx) { ctx.drawImage(this.canvas, 0, 0); }
  clone() {
    const l = new Layer(this.canvas.width, this.canvas.height, this.name);
    copyShared(this, l);
    l.ctx.drawImage(this.canvas, 0, 0);
    return l;
  }
  /* rebuild canvas (and mask, when present) at the new size through one draw fn */
  _regeo(w, h, draw) {
    const old = this.canvas, oldMask = this.mask;
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    draw(this.ctx, old, old.width, old.height);
    if (oldMask) {
      this.mask = makeCanvas(w, h);
      const mctx = this.mask.getContext('2d', { willReadFrequently: true });
      draw(mctx, oldMask, oldMask.width, oldMask.height);
      this.maskRevision++;
    }
  }
  resize(w, h, smooth = true) {
    this._regeo(w, h, (ctx, src, sw, sh) => {
      ctx.imageSmoothingEnabled = smooth;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
    });
  }
  /* rebuild canvas at new doc size, drawing old content at (dx,dy) */
  rebase(w, h, dx = 0, dy = 0) {
    this._regeo(w, h, (ctx, src) => ctx.drawImage(src, dx, dy));
  }
  /* generic rotate/flip placement */
  geoTransform(w, h, draw) { this._regeo(w, h, draw); }
}

export class TextLayer extends Layer {
  constructor(w, h, props = {}) {
    super(w, h, props.name || 'Text');
    this.type = 'text';
    this.t = Object.assign({
      text: 'DEAD PIXEL', family: 'VT323', size: 64, weight: 400,
      color: '#ff2233', align: 'left', letterSpacing: 0, lineHeight: 1.2,
      x: 80, y: 120, italic: false,
    }, props.t || {});
    this.render();
  }
  font() {
    const t = this.t;
    return `${t.italic ? 'italic ' : ''}${t.weight} ${t.size}px "${t.family}"`;
  }
  render() {
    const { ctx, canvas, t } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.font = this.font();
    ctx.fillStyle = t.color;
    ctx.textAlign = t.align;
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = (t.letterSpacing || 0) + 'px';
    const lines = String(t.text).split('\n');
    const lh = t.size * t.lineHeight;
    lines.forEach((line, i) => ctx.fillText(line, t.x, t.y + i * lh));
    ctx.restore();
    this.name = (String(t.text).split('\n')[0] || 'Text').slice(0, 24);
  }
  clone() {
    const l = new TextLayer(this.canvas.width, this.canvas.height, { name: this.name, t: { ...this.t } });
    copyShared(this, l);
    l.visible = this.visible; l.opacity = this.opacity; l.blend = this.blend;
    return l;
  }
  rasterize() {
    const l = new Layer(this.canvas.width, this.canvas.height, this.name);
    l.visible = this.visible; l.opacity = this.opacity; l.blend = this.blend;
    l.locked = this.locked; l.clipped = this.clipped;
    l.ctx.drawImage(this.canvas, 0, 0);
    if (this.mask) { l.mask = copyCanvas(this.mask); l.maskEnabled = this.maskEnabled; }
    return l;
  }
}

/* layer folder: composites its children into one buffer, then blends as a unit */
export class GroupLayer {
  constructor(name = 'Group') {
    baseLayerState(this, name);
    this.type = 'group';
    this.expanded = true;      // panel disclosure state
    this.children = [];
  }
  clone() { // deep duplicate of the subtree
    const g = new GroupLayer(this.name);
    copyShared(this, g);
    g.expanded = this.expanded;
    g.children = this.children.map(c => c.clone());
    return g;
  }
  /* adopt the state of a shallow structural clone (children array copied) */
  assign(other) {
    Object.assign(this, other);
    this.children = other.children.slice();
    return this;
  }
  contains(id) {
    if (this.children.some(c => c.id === id)) return true;
    return this.children.some(c => c.type === 'group' && c.contains(id));
  }
  /* content bounds of the whole subtree (shared with selection code) */
  contentBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of this.children) {
      const b = c.type === 'group' ? c.contentBounds() : boundsOf(c);
      if (!b) continue;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w - 1); y1 = Math.max(y1, b.y + b.h - 1);
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
}

function boundsOf(layer) {
  if (layer.type === 'adjust') return null; // full-canvas extent
  if (layer.type === 'text') return textBounds(layer);
  const w = layer.canvas.width, h = layer.canvas.height;
  const d = layer.ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 0) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function textBounds(layer) {
  const t = layer.t, lines = String(t.text).split('\n');
  const ctx = layer.ctx;
  ctx.font = layer.font();
  let w = 1;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  return { x: t.x, y: t.y - t.size, w: Math.ceil(w), h: Math.ceil(lines.length * t.size * t.lineHeight) };
}

/* ------------------------------------------------------------- tree utils */

/* adjustment kernels are injected once from filters.js (which imports this
   module, so the reference must point back) */
let ADJUST_FILTERS = [];
export function setAdjustFilters(list) { ADJUST_FILTERS = list || []; }
function adjustDefaults(filterId) {
  const f = ADJUST_FILTERS.find(x => x.id === filterId);
  const p = {};
  (f?.params || []).forEach(pr => p[pr.key] = pr.def);
  return p;
}

/* adjustment layer: a full-canvas color op applied to everything below it
   inside its own sibling list. Carries a filter id + params; the visible
   content is computed by the compositor against the backdrop below. */
export class AdjustLayer {
  constructor(filterId = null, params = null, name = null) {
    baseLayerState(this, name || 'Adjustment');
    this.type = 'adjust';
    this.filter = filterId;
    this.params = params ? { ...params } : {};
  }
  clone() {
    const c = new AdjustLayer(this.filter, null, this.name);
    copyShared(this, c);
    c.params = { ...this.params };
    return c;
  }
  contains(id) { return id === this.id; }
}

export function flattenLayers(list, out = []) {
  for (const l of list) { out.push(l); if (l.type === 'group') flattenLayers(l.children, out); }
  return out;
}

export function countLeaves(list) {
  let n = 0;
  for (const l of list) n += l.type === 'group' ? countLeaves(l.children) : 1;
  return n;
}

/* shallow structural clone: new arrays + new group wrappers, shared leaf objects */
function cloneLevel(list) {
  return list.map(l => l.type === 'group' ? new GroupLayer().assign(l) : l);
}

/* --------------------------------------------------------------- history */

export class History extends EventTarget {
  constructor(cap = 40, maxBytes = 256 * 1024 * 1024) {
    super();
    this.entries = [];  // {label, undo(), redo(), bytes}
    this.index = -1;    // last applied entry
    this.cap = cap;
    this.maxBytes = maxBytes;
    this.bytes = 0;
  }
  push(label, undo, redo, options = {}) {
    const removedRedo = this.entries.splice(this.index + 1);
    for (const entry of removedRedo) this.bytes -= entry.bytes || 0;
    const entry = { label, undo, redo, bytes: Math.max(0, options.bytes || 0) };
    this.entries.push(entry);
    this.bytes += entry.bytes;
    while (this.entries.length > 1 &&
      (this.entries.length > this.cap || this.bytes > this.maxBytes)) {
      const dropped = this.entries.shift();
      this.bytes -= dropped.bytes || 0;
    }
    this.index = this.entries.length - 1;
    this.dispatchEvent(new Event('change'));
  }
  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  undo() {
    if (!this.canUndo) return false;
    this.entries[this.index--].undo();
    this.dispatchEvent(new Event('change'));
    return true;
  }
  redo() {
    if (!this.canRedo) return false;
    this.entries[++this.index].redo();
    this.dispatchEvent(new Event('change'));
    return true;
  }
  jumpTo(i) { // i = -1 .. entries.length-1
    while (this.index > i && this.canUndo) this.entries[this.index--].undo();
    while (this.index < i && this.canRedo) this.entries[++this.index].redo();
    this.dispatchEvent(new Event('change'));
  }
}

/* ------------------------------------------------------------- selection */

export class Selection {
  constructor(w, h) {
    this.mask = makeCanvas(w, h);
    this.mctx = this.mask.getContext('2d', { willReadFrequently: true });
    this._outline = null;
    this._bounds = null;
  }
  static fromRect(w, h, x, y, rw, rh) {
    const s = new Selection(w, h);
    s.mctx.fillStyle = '#fff';
    s.mctx.fillRect(x, y, rw, rh);
    return s._done();
  }
  static fromEllipse(w, h, cx, cy, rx, ry) {
    const s = new Selection(w, h);
    s.mctx.fillStyle = '#fff';
    s.mctx.beginPath();
    s.mctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
    s.mctx.fill();
    return s._done();
  }
  static fromPolygon(w, h, pts) {
    const s = new Selection(w, h);
    s.mctx.fillStyle = '#fff';
    s.mctx.beginPath();
    pts.forEach((p, i) => i ? s.mctx.lineTo(p.x, p.y) : s.mctx.moveTo(p.x, p.y));
    s.mctx.closePath();
    s.mctx.fill();
    return s._done();
  }
  static fromMaskData(w, h, data /* Uint8Array w*h, 0/255 */) {
    const s = new Selection(w, h);
    const img = s.mctx.createImageData(w, h);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = v;
    }
    s.mctx.putImageData(img, 0, 0);
    return s._done();
  }
  /* rebuild from a full RGBA block (white RGB + selection alpha), e.g. the
     output of the pixelops feather/grow filters */
  static fromBlock(w, h, block) {
    const s = new Selection(w, h);
    const img = s.mctx.createImageData(w, h);
    img.data.set(block.subarray(0, w * h * 4));
    s.mctx.putImageData(img, 0, 0);
    return s._done();
  }
  _done() { this._outline = null; this._bounds = null; return this; }
  get bounds() {
    if (this._bounds) return this._bounds;
    const { width: w, height: h } = this.mask;
    const d = this.mctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    this._bounds = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    return this._bounds;
  }
  get isEmpty() { return !this.bounds; }
  invert() {
    const c = makeCanvas(this.mask.width, this.mask.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(this.mask, 0, 0);
    this.mask = c;
    this.mctx = c.getContext('2d', { willReadFrequently: true });
    return this._done();
  }
  /* clip a temp canvas to the selection (keeps only selected pixels) */
  maskCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.mask, 0, 0);
    ctx.restore();
  }
  /* marching-squares outline polygons, downsampled for big masks */
  get outline() {
    if (this._outline) return this._outline;
    const W = this.mask.width, H = this.mask.height;
    const step = Math.max(1, Math.floor(Math.max(W, H) / 1400));
    const gw = Math.ceil(W / step), gh = Math.ceil(H / step);
    const d = this.mctx.getImageData(0, 0, W, H).data;
    const grid = new Uint8Array((gw + 2) * (gh + 2)); // 1px empty border
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const x = Math.min(W - 1, gx * step), y = Math.min(H - 1, gy * step);
        grid[(gy + 1) * (gw + 2) + (gx + 1)] = d[(y * W + x) * 4 + 3] > 127 ? 1 : 0;
      }
    }
    // collect edge segments between filled and empty cells
    const segs = new Map(); // "x,y" start -> [endx, endy]
    const key = (x, y) => x + ',' + y;
    const addSeg = (x1, y1, x2, y2) => {
      const k = key(x1, y1);
      if (!segs.has(k)) segs.set(k, []);
      segs.get(k).push([x2, y2]);
    };
    for (let gy = 0; gy <= gh; gy++) {
      for (let gx = 0; gx <= gw; gx++) {
        const cur = grid[(gy + 1) * (gw + 2) + (gx + 1)];
        const left = grid[(gy + 1) * (gw + 2) + gx];
        const up = grid[gy * (gw + 2) + (gx + 1)];
        // vertical edge between (gx-1,gy) and (gx,gy) — direction keeps filled on left
        if (cur !== left) {
          if (cur) addSeg(gx, gy + 1, gx, gy); else addSeg(gx, gy, gx, gy + 1);
        }
        if (cur !== up) {
          if (cur) addSeg(gx, gy, gx + 1, gy); else addSeg(gx + 1, gy, gx, gy);
        }
      }
    }
    // chain segments into polygons
    const polys = [];
    while (segs.size) {
      const [startK, ends] = segs.entries().next().value;
      const [sx, sy] = startK.split(',').map(Number);
      const poly = [[sx, sy]];
      let cx = sx, cy = sy;
      let guard = 0;
      while (guard++ < 500000) {
        const k = key(cx, cy);
        const list = segs.get(k);
        if (!list || !list.length) break;
        const [nx, ny] = list.pop();
        if (!list.length) segs.delete(k);
        poly.push([nx, ny]);
        cx = nx; cy = ny;
        if (cx === sx && cy === sy) break;
      }
      if (poly.length > 2) polys.push(poly.map(([x, y]) => [x * step, y * step]));
      if (ends && !ends.length) segs.delete(startK);
    }
    this._outline = polys;
    return polys;
  }
}

/* ------------------------------------------------------------------- doc */

export class Doc extends EventTarget {
  constructor(w, h, opts = {}) {
    super();
    this.width = Math.round(w);
    this.height = Math.round(h);
    this.name = opts.name || 'UNTITLED';
    this.layers = [];
    this._activeId = null;      // active node id (layer or group)
    this.selection = null;
    this.effects = [];
    this.signalMasks = new Map();
    this.maskRevision = 0;
    this.signalSeed = (Math.random() * 0xffffffff) >>> 0;
    this.effectProcessor = null;
    this.effectProcessorAsync = null;
    this.history = new History();
    this.dirty = false;         // unsaved changes
    this._compo = makeCanvas(w, h);
    this._compoCtx = this._compo.getContext('2d', { willReadFrequently: true });
    this._compoDirty = true;
    this._compoEffectsApplied = false;
    this._compoGeneration = 0;
    this._compoPending = null;
    this.onProcessingChange = null;

    const base = new Layer(w, h, 'Background');
    if (opts.bg && opts.bg !== 'transparent') {
      base.ctx.fillStyle = opts.bg;
      base.ctx.fillRect(0, 0, w, h);
    }
    this.layers.push(base);
    this._activeId = base.id;
  }

  /* ----------------------------- tree walking ----------------------------- */
  get flatLayers() { return flattenLayers(this.layers); }
  findLayer(id) { return id == null ? null : flattenLayers(this.layers).find(l => l.id === id) || null; }
  locate(id) { // {list, index, parent} — parent null for root
    const search = (list, parent) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) return { list, index: i, parent };
        if (list[i].type === 'group') {
          const hit = search(list[i].children, list[i]);
          if (hit) return hit;
        }
      }
      return null;
    };
    return search(this.layers, null);
  }
  isDescendantOf(id, ancestorId) {
    const a = this.findLayer(ancestorId);
    return !!(a && a.type === 'group' && a.contains(id));
  }
  get activeLayer() { return this.findLayer(this._activeId); }
  get activeIndex() { return this.flatLayers.findIndex(l => l.id === this._activeId); }
  set activeIndex(i) {
    const flat = this.flatLayers;
    const target = flat[clamp(i, 0, flat.length - 1)];
    this._activeId = target ? target.id : null;
  }
  setActiveId(id) { if (this.findLayer(id)) this._activeId = id; }

  /* ------------------------ non destructive rack -------------------------- */
  createSignalMask(fromSelection = true) {
    const id = 'M' + uid();
    const data = new Uint8ClampedArray(this.width * this.height);
    if (fromSelection && this.selection) {
      const pixels = this.selection.mctx.getImageData(0, 0, this.width, this.height).data;
      for (let i = 0; i < data.length; i++) data[i] = pixels[i * 4 + 3];
    } else data.fill(255);
    this.signalMasks.set(id, data);
    return id;
  }

  effectsWithMasks(effects) {
    return (effects || []).map(effect => effect.mask === 'raster' && this.signalMasks.has(effect.maskId)
      ? { ...effect, maskPixels: this.signalMasks.get(effect.maskId) } : effect);
  }

  changed(structural = false) {
    this.dirty = true;
    this._compoDirty = true;
    this._compoEffectsApplied = false;
    this._compoGeneration++;
    this.dispatchEvent(new CustomEvent('change', { detail: { structural } }));
  }

  /* --------------------------- compositing core --------------------------- */
  /* signature of a subtree — anything that changes its rendered output */
  _nodeSig(l) {
    if (l.type === 'adjust') {
      return `A[${l.id}:${l.filter}:${JSON.stringify(l.params || {})}:${l.visible ? 1 : 0}:${l.opacity}:${l.blend}:${l.clipped ? 1 : 0}:${this._maskSig(l)}]`;
    }
    if (l.type === 'group') {
      return 'G{'
        + `${l.id}:${l.visible?1:0}:${l.opacity}:${l.blend}:${l.clipped?1:0}`
        + `:fx${l._effectsBypassed ? 'B' : (l.effects?.length ? 'Y' + this._fxSeedPart(l) : '')}`
        + `:${this._maskSig(l)}:` + this._childrenSig(l) + '}';
    }
    return `${l.id}:${l.revision}:${l.visible?1:0}:${l.opacity}:${l.blend}:${l.clipped?1:0}`
      + `:fx${l._effectsBypassed ? 'B' : (l.effects?.length ? l._effectCacheKey || '?' : '')}`
      + `:${this._maskSig(l)}`;
  }
  _childrenSig(l) {
    return l.children.map(c => this._nodeSig(c)).join('|');
  }
  _maskSig(l) {
    return l.mask ? (l.maskEnabled ? 'M' + l.maskRevision : 'Moff' + l.maskRevision) : '-';
  }
  _fxSeedPart(l) { return (l.signalSeed >>> 0).toString(36) + ':' + (this.maskRevision >>> 0).toString(36); }

  /* children composited into a cached, doc-sized buffer.
     (The group's own layer mask is applied later, in _layerContent,
      so it clips the final output after the group's Signal Rack.) */
  _groupBuffer(g, preview = false, onReady = null) {
    const sig = this._childrenSig(g);
    if (g._groupCache && g._groupCache.key === sig) return g._groupCache.canvas;
    const canvas = makeCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    this._renderLayers(g.children, ctx, preview, onReady);
    g._groupCache = { canvas, key: sig };
    return canvas;
  }

  /* one node's drawable content: leaf canvas or group buffer, with its
     Signal Rack stack applied, then its layer mask applied. May start an
     async preview job and return the stale canvas meanwhile. */
  _layerContent(l, preview = false, onReady = null) {
    let base = l.type === 'group' ? this._groupBuffer(l, preview, onReady) : l.canvas;
    if (l.effects?.length && this.effectProcessor && !l._effectsBypassed) {
      const key = l.type === 'group' ? 'G|' + this._childrenSig(l) : l.revision + ':' + this.maskRevision;
      const fullKey = key + ':' + l.signalSeed + ':' + JSON.stringify(l.effects);
      if (l._signalStageCache?.inputRevision !== key) l._signalStageCache = { inputRevision: key };
      if (l._effectCacheKey !== fullKey) {
        if (preview && this.effectProcessorAsync) {
          if (l._effectPendingKey !== fullKey) {
            if (l._effectPending) this.onProcessingChange?.(false);
            const token = {}; l._effectPending = token; l._effectPendingKey = fullKey;
            this.onProcessingChange?.(true);
            const input = copyCanvas(base);
            this.effectProcessorAsync(input, l.effects, l.signalSeed, l._signalStageCache ||= {}).then((pixels) => {
              if (l._effectPending !== token) return;
              l._effectPending = null; l._effectPendingKey = null; this.onProcessingChange?.(false);
              const stale = l.type === 'group' ? 'G|' + this._childrenSig(l) : l.revision + ':' + this.maskRevision;
              if (stale + ':' + l.signalSeed + ':' + JSON.stringify(l.effects) !== fullKey) return;
              const output = makeCanvas(this.width, this.height), image = output.getContext('2d').createImageData(this.width, this.height);
              image.data.set(pixels); output.getContext('2d').putImageData(image, 0, 0);
              l._effectCache = output; l._effectCacheKey = fullKey;
              this._compoDirty = true; onReady?.();
            }).catch(() => {
              if (l._effectPending !== token) return;
              l._effectPending = null; l._effectPendingKey = null; this.onProcessingChange?.(false);
            });
          }
        } else {
          if (l._effectPending) this.onProcessingChange?.(false);
          l._effectPending = null; l._effectPendingKey = null;
          l._effectCache = copyCanvas(base);
          this.effectProcessor(l._effectCache, l.effects, l.signalSeed, l._signalStageCache ||= {});
          l._effectCacheKey = fullKey;
        }
      }
      if (l._effectCacheKey === fullKey) base = l._effectCache;
    }
    if (l.mask && l.maskEnabled) {
      const outKey = this._maskSig(l) + '|' + (l._effectCacheKey || 'raw' + l.revision);
      if (l._maskedCache?.key !== outKey) {
        const masked = copyCanvas(base);
        masked.getContext('2d').globalCompositeOperation = 'destination-in';
        masked.getContext('2d').drawImage(l.mask, 0, 0);
        l._maskedCache = { canvas: masked, key: outKey };
      }
      base = l._maskedCache.canvas;
      l._contentKey = outKey;
    } else {
      l._contentKey = (l._effectCacheKey || 'raw' + l.revision + ':' + (l.type === 'group' ? this._childrenSig(l) : ''));
    }
    return base;
  }

  /* alpha-only copy used as the clip source for clipping masks; cached per node */
  _clipSource(l, content) {
    if (l._clipCache && l._clipCache.key === l._contentKey) return l._clipCache.canvas;
    const c = makeCanvas(this.width, this.height);
    c.getContext('2d').drawImage(content, 0, 0);
    l._clipCache = { canvas: c, key: l._contentKey };
    return c;
  }

  /* adjustment output: the filter applied to the backdrop accumulated so
     far, then masked by the adjustment's layer mask. Cached on
     `backdropKey | filter | params | visibility | maskSig`. */
  _adjustContent(l, below, belowKey) {
    const key = belowKey + '|' + (l.filter || 'none') + '|' + JSON.stringify(l.params || {})
      + '|' + (l.visible ? 1 : 0) + ':' + this._maskSig(l);
    if (l._adjustCache?.key === key) { l._contentKey = 'ad' + key; return l._adjustCache.canvas; }
    if (!l.visible) { l._contentKey = 'ad' + key; return null; }
    const f = ADJUST_FILTERS.find(x => x.id === l.filter);
    if (!f) { l._contentKey = 'ad' + key; l._adjustCache = { canvas: below, key, passthrough: true }; return below; }
    const out = copyCanvas(below);
    const octx = out.getContext('2d', { willReadFrequently: true });
    const img = octx.getImageData(0, 0, this.width, this.height);
    f.apply(img, this.width, this.height, { ...adjustDefaults(l.filter), ...(l.params || {}) });
    octx.putImageData(img, 0, 0);
    if (l.mask && l.maskEnabled) {
      octx.globalCompositeOperation = 'destination-in';
      octx.drawImage(l.mask, 0, 0);
      octx.globalCompositeOperation = 'source-over';
    }
    l._adjustCache = { canvas: out, key };
    l._contentKey = 'ad' + key;
    return out;
  }

  /* blend a content canvas onto the workspace ctx honoring the node's
     blend mode (pass-through coerced for non-groups) and opacity */
  _blendOnto(ctx, content, blend, opacity) {
    const gco = blend === 'pass-through' ? 'source-over' : blend;
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = gco;
    ctx.drawImage(content, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* draw a sibling list (root or inside a group) honoring clip chains */
  _renderLayers(list, ctx, preview = false, onReady = null) {
    let clipBase = null;
    let accKey = ''; // identity of the backdrop: every drawn node's content key
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (!l.visible || l.opacity <= 0) continue;
      /* pass-through groups paint their children straight onto the backdrop
         (no buffer, no group blend); falls back to the buffer path when the
         group has masking/fx/opacity/clip interactions */
      if (l.type === 'group' && l.blend === 'pass-through'
        && l.opacity >= 1 && !l.mask && !l.effects?.length && !l._effectsBypassed) {
        const laterClipped = list.slice(i + 1).some(s => s.clipped && s.visible && s.opacity > 0);
        if (!laterClipped && !l.clipped) {
          this._renderLayers(l.children, ctx, preview, onReady);
          accKey += '|pt' + this._nodeSig(l);
          continue;
        }
      }
      const content = l.type === 'adjust'
        ? this._adjustContent(l, ctx.canvas, accKey)
        : this._layerContent(l, preview, onReady);
      if (content) {
        if (l.clipped && clipBase) {
          if (l.blend !== 'source-over' || l.opacity < 1) {
            // blend against the backdrop below, then keep only the base's alpha
            const R = makeCanvas(this.width, this.height);
            const rctx = R.getContext('2d');
            rctx.drawImage(ctx.canvas, 0, 0);
            rctx.globalAlpha = l.opacity;
            rctx.globalCompositeOperation = l.blend === 'pass-through' ? 'source-over' : l.blend;
            rctx.drawImage(content, 0, 0);
            rctx.globalAlpha = 1;
            rctx.globalCompositeOperation = 'destination-in';
            rctx.drawImage(clipBase, 0, 0);
            ctx.drawImage(R, 0, 0);
          } else {
            const scratch = copyCanvas(content);
            scratch.getContext('2d').globalCompositeOperation = 'destination-in';
            scratch.getContext('2d').drawImage(clipBase, 0, 0);
            ctx.drawImage(scratch, 0, 0);
          }
        } else {
          this._blendOnto(ctx, content, l.blend, l.opacity);
        }
        // a clip source is only needed when a later sibling is actually clipped
        const laterClipped = list.slice(i + 1).some(s => s.clipped && s.visible && s.opacity > 0);
        if (laterClipped && !l.clipped) clipBase = this._clipSource(l, content);
        else if (l.clipped) clipBase = clipBase;
        accKey += '|' + (l._contentKey || l.id);
      }
    }
  }

  _buildCompositeBase(preview = false, onReady = null) {
    if (this._compoDirty) {
      // Also invalidates jobs when callers toggle preview-only state directly.
      this._compoGeneration++;
      if (this._compoPending) this.onProcessingChange?.(false);
      this._compoPending = null;
      const ctx = this._compoCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      this._renderLayers(this.layers, ctx, preview, onReady);
      const baseKey = 'T' + this._childrenSig({ children: this.layers });
      if (this._signalStageCache?.baseKey !== baseKey) this._signalStageCache = { baseKey };
      this._compoDirty = false;
      this._compoEffectsApplied = this._effectsBypassed || !this.effects.length;
    }
  }

  compose() {
    this._buildCompositeBase();
    if (!this._compoEffectsApplied && this.effectProcessor) {
      this._compoGeneration++;
      this._compoPending = null;
      this.effectProcessor(this._compo, this.effects, this.signalSeed, this._signalStageCache ||= {});
      this._compoEffectsApplied = true;
    }
    return this._compo;
  }

  composePreview(onReady) {
    this._buildCompositeBase(true, onReady);
    if (this._compoEffectsApplied || this._compoPending) return this._compo;
    if (!this.effectProcessorAsync) return this.compose();
    const token = { generation: this._compoGeneration };
    this._compoPending = token;
    this.onProcessingChange?.(true);
    this.effectProcessorAsync(this._compo, this.effects, this.signalSeed, this._signalStageCache ||= {}).then((pixels) => {
      if (this._compoPending !== token) return;
      this._compoPending = null;
      this.onProcessingChange?.(false);
      if (this._compoDirty || token.generation !== this._compoGeneration) return;
      const image = this._compoCtx.createImageData(this.width, this.height);
      image.data.set(pixels);
      this._compoCtx.putImageData(image, 0, 0);
      this._compoEffectsApplied = true;
      onReady?.();
    }).catch(() => {
      if (this._compoPending !== token) return;
      this._compoPending = null;
      this.onProcessingChange?.(false);
      if (!this._compoDirty && token.generation === this._compoGeneration) {
        this.effectProcessor?.(this._compo, this.effects, this.signalSeed);
        this._compoEffectsApplied = true;
        onReady?.();
      }
    });
    return this._compo;
  }

  /* flattened copy on white/transparent for export */
  flattenedCanvas(background = null) {
    const c = makeCanvas(this.width, this.height);
    const ctx = c.getContext('2d');
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, this.width, this.height); }
    ctx.drawImage(this.compose(), 0, 0);
    return c;
  }

  replaceEffects(next, label = 'Signal rack', nextSeed = this.signalSeed) {
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const before = clone(this.effects), after = clone(next);
    const beforeSeed = this.signalSeed >>> 0, afterSeed = nextSeed >>> 0;
    const apply = (value, seed) => { this.effects = clone(value); this.signalSeed = seed; this.changed(); };
    this.history.push(label, () => apply(before, beforeSeed), () => apply(after, afterSeed));
    apply(after, afterSeed);
  }

  replaceLayerEffects(layer, next, label = 'Layer signal rack', nextSeed = layer.signalSeed) {
    if (!layer) return;
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const before = clone(layer.effects || []), after = clone(next);
    const beforeSeed = layer.signalSeed >>> 0, afterSeed = nextSeed >>> 0;
    const apply = (value, seed) => {
      layer.effects = clone(value); layer.signalSeed = seed; layer._effectCacheKey = null; this.changed();
    };
    this.history.push(label, () => apply(before, beforeSeed), () => apply(after, afterSeed));
    apply(after, afterSeed);
  }

  /* ---- structural ops (history-recorded) ---- */
  _snapshotTree() {
    return { root: cloneLevel(this.layers), idx: this.activeIndex };
  }
  _restoreTree(s) {
    this.layers = cloneLevel(s.root);
    this.activeIndex = s.idx;
    this.changed(true);
  }
  _structural(label, mutate) {
    const before = this._snapshotTree();
    mutate();
    const after = this._snapshotTree();
    this.history.push(label, () => this._restoreTree(before), () => this._restoreTree(after));
    this.changed(true);
  }

  /* flat index helpers used by legacy commands */
  _locateActive() { return this.locate(this._activeId) || { list: this.layers, index: 0, parent: null }; }

  addLayer(layer = null, name = null) {
    const { list, index } = this._locateActive();
    const l = layer || new Layer(this.width, this.height, name || 'Layer ' + (countLeaves(this.layers) + 1));
    this._structural('New layer', () => {
      list.splice(index + 1, 0, l);
      this._activeId = l.id;
    });
    return l;
  }

  addGroup(name = null) { // empty group placed above the active node
    const { list, index } = this._locateActive();
    const g = new GroupLayer(name || 'Group ' + (this.layers.filter(l => l.type === 'group').length + 1));
    this._structural('New group', () => {
      list.splice(index + 1, 0, g);
      this._activeId = g.id;
    });
    return g;
  }

  /* adjustment layer placed above the active node; params default from the
     injected registry so an empty params map matches the kernel defaults */
  addAdjustmentLayer(filterId, params = null, name = null) {
    const { list, index } = this._locateActive();
    const a = new AdjustLayer(filterId, params, name || filterId);
    this._structural('New adjustment layer', () => {
      list.splice(index + 1, 0, a);
      this._activeId = a.id;
    });
    return a;
  }

  /* edit an adjustment layer's params (history-tracked; caches invalidated) */
  setAdjustParams(id, params, label = 'Adjustment') {
    const l = this.findLayer(id);
    if (!l || l.type !== 'adjust') return;
    const before = { ...l.params };
    const after = { ...params };
    this.history.push(label,
      () => { l.params = { ...before }; l._adjustCache = null; this.changed(); },
      () => { l.params = { ...after }; l._adjustCache = null; this.changed(); });
    l.params = { ...after };
    l._adjustCache = null;
    this.changed();
  }

  groupFromActive() { // Ctrl+G: put the active node into a new group
    const { list, index } = this._locateActive();
    const active = list[index];
    const g = new GroupLayer('Group ' + (this.layers.filter(l => l.type === 'group').length + 1));
    this._structural('Group layer', () => {
      g.children.push(active);
      list[index] = g;
      this._activeId = active.id; // stay on the moved node, like keeping a layer selected inside
    });
    return g;
  }

  removeLayer(id = null) {
    const loc = this.locate(id ?? this._activeId);
    if (!loc) return;
    if (countLeaves(this.layers) <= 1) return;
    this._structural('Delete layer', () => {
      loc.list.splice(loc.index, 1);
      const flat = this.flatLayers;
      this._activeId = flat.length ? flat[flat.length - 1].id : null;
    });
  }

  duplicateLayer(id = null) {
    const at = this.locate(id ?? this._activeId);
    if (!at) return;
    const src = at.list[at.index];
    const copy = src.clone();
    this._structural('Duplicate layer', () => {
      at.list.splice(at.index + 1, 0, copy);
      this._activeId = copy.id;
    });
    return copy;
  }

  moveWithinSiblings(id = null, dir = 1) { // +1 = up in the stack, -1 = down
    const at = this.locate(id ?? this._activeId);
    if (!at) return;
    const to = at.index + dir;
    if (to < 0 || to >= at.list.length) return;
    this._structural('Reorder layer', () => {
      const [l] = at.list.splice(at.index, 1);
      at.list.splice(to, 0, l);
      this._activeId = l.id;
    });
  }

  reparent(id, parentId = null, index = 0, label = 'Reorder layer') {
    const at = this.locate(id);
    if (!at) return false;
    if (parentId != null && (parentId === id || this.isDescendantOf(parentId, id))) return false;
    const parent = parentId == null ? null : this.findLayer(parentId);
    if (parentId != null && (!parent || parent.type !== 'group')) return false;
    const target = parentId == null ? this.layers : parent.children;
    this._structural(label, () => {
      const [l] = at.list.splice(at.index, 1);
      target.splice(clamp(index, 0, target.length), 0, l);
      this._activeId = l.id;
    });
    return true;
  }

  /* legacy flat-index move (kept for command compatibility).
     Semantics match array splice: remove at `from`, insert at `to`
     in the flattened DFS order of the tree. */
  moveLayer(from, to) {
    const flat = this.flatLayers;
    if (from < 0 || from >= flat.length || to < 0 || to >= flat.length || from === to) return;
    const moved = flat[from], anchor = flat[to];
    const insertAfter = to > from;
    this._structural('Reorder layer', () => {
      const loc0 = this.locate(moved.id);
      loc0.list.splice(loc0.index, 1);
      let list, index;
      if (anchor.type === 'group' && insertAfter) {
        list = anchor.children; index = 0;
      } else {
        const locA = this.locate(anchor.id);
        list = locA.list;
        index = locA.index + (insertAfter ? 1 : 0);
      }
      list.splice(clamp(index, 0, list.length), 0, moved);
      this._activeId = moved.id;
    });
  }

  mergeDown(id = null) {
    const at = this.locate(id ?? this._activeId);
    if (!at || at.index <= 0) return false;
    const top = at.list[at.index], bottom = at.list[at.index - 1];
    if (bottom.type === 'adjust') return false; // bake only onto pixel content
    if (top.type === 'adjust') {
      // bake the adjustment into the pair, removing both nodes
      if (top.clipped) return false;
      const merged = new Layer(this.width, this.height, bottom.name);
      merged.clipped = bottom.clipped;
      merged.ctx.globalAlpha = bottom.opacity;
      merged.ctx.globalCompositeOperation = bottom.blend === 'pass-through' ? 'source-over' : bottom.blend;
      if (bottom.visible) merged.ctx.drawImage(this._layerContent(bottom), 0, 0);
      merged.ctx.globalAlpha = 1;
      merged.ctx.globalCompositeOperation = 'source-over';
      if (top.visible) {
        const adjusted = this._adjustContent(top, merged, 'bake|' + (bottom._contentKey || bottom.id));
        merged.ctx.globalAlpha = top.opacity;
        merged.ctx.globalCompositeOperation = top.blend === 'pass-through' ? 'source-over' : top.blend;
        merged.ctx.drawImage(adjusted, 0, 0);
        merged.ctx.globalAlpha = 1;
        merged.ctx.globalCompositeOperation = 'source-over';
      }
      this._structural('Merge down', () => {
        at.list.splice(at.index - 1, 2, merged);
        this._activeId = merged.id;
      });
      return true;
    }
    const bottomContent = this._layerContent(bottom);
    const merged = new Layer(this.width, this.height, bottom.name);
    merged.visible = true;
    merged.opacity = bottom.opacity !== 1 || bottom.blend !== 'source-over' ? 1 : bottom.opacity;
    merged.clipped = bottom.clipped;
    merged.ctx.globalAlpha = bottom.opacity;
    merged.ctx.globalCompositeOperation = bottom.blend === 'pass-through' ? 'source-over' : bottom.blend;
    if (bottom.visible) merged.ctx.drawImage(bottomContent, 0, 0);
    merged.ctx.globalAlpha = top.opacity;
    merged.ctx.globalCompositeOperation = top.blend === 'pass-through' ? 'source-over' : top.blend;
    if (top.visible) merged.ctx.drawImage(this._layerContent(top), 0, 0);
    merged.ctx.globalAlpha = 1;
    merged.ctx.globalCompositeOperation = 'source-over';
    this._structural('Merge down', () => {
      at.list.splice(at.index - 1, 2, merged);
      this._activeId = merged.id;
    });
    return true;
  }

  /* rasterize a group into one layer (PS "Merge Group") */
  rasterizeGroup(id = null, label = 'Merge group', bakeGroupProps = true) {
    const at = this.locate(id ?? this._activeId);
    if (!at) return;
    const g = at.list[at.index];
    if (g.type !== 'group') return;
    const buffer = copyCanvas(this._groupBuffer(g));
    if (g.effects?.length && this.effectProcessor && !g._effectsBypassed) {
      this.effectProcessor(buffer, this.effectsWithMasks(g.effects), g.signalSeed, {});
    }
    if (g.mask && g.maskEnabled) {
      buffer.getContext('2d').globalCompositeOperation = 'destination-in';
      buffer.getContext('2d').drawImage(g.mask, 0, 0);
      buffer.getContext('2d').globalCompositeOperation = 'source-over';
    }
    const merged = new Layer(this.width, this.height, g.name);
    if (bakeGroupProps) {
      merged.visible = g.visible; merged.opacity = g.opacity;
      merged.blend = g.blend; merged.clipped = g.clipped;
      merged.mask = g.mask ? copyCanvas(g.mask) : null;
      merged.maskEnabled = g.maskEnabled;
      merged.signalSeed = g.signalSeed >>> 0;
    }
    merged.ctx.drawImage(buffer, 0, 0);
    this._structural(label, () => {
      at.list.splice(at.index, 1, merged);
      this._activeId = merged.id;
    });
    return merged;
  }

  flatten() {
    const flat = new Layer(this.width, this.height, 'Background');
    flat.ctx.drawImage(this.compose(), 0, 0);
    this._structural('Flatten', () => {
      this.layers = [flat];
      this._activeId = flat.id;
    });
  }

  rasterizeLayer(id = null) {
    const at = this.locate(id ?? this._activeId);
    if (!at) return;
    const l = at.list[at.index];
    if (l.type !== 'text') return;
    this._structural('Rasterize text', () => {
      at.list.splice(at.index, 1, l.rasterize());
      this._activeId = at.list[at.index].id;
    });
  }

  /* group/leaf translation used by the move tool and arrow-key nudging */
  translateNode(id, dx, dy) {
    const l = this.findLayer(id);
    if (!l) return;
    const walk = (node) => {
      if (node.type === 'group') { node.children.forEach(walk); return; }
      if (node.type === 'adjust') return; // full-canvas extent, nothing to shift
      if (node.type === 'text') { node.t.x += dx; node.t.y += dy; node.render(); }
      else node.rebase(node.canvas.width, node.canvas.height, dx, dy);
    };
    walk(l);
    this.changed();
  }

  recordTranslate(label, id, dx, dy) {
    this.history.push(label,
      () => this.translateNode(id, -dx, -dy),
      () => this.translateNode(id, dx, dy),
      { bytes: 0 });
  }

  /* ---- layer masks ---- */
  addLayerMask(id = null, mode = 'reveal-all', label = 'Layer mask') {
    const at = this.locate(id ?? this._activeId);
    if (!at || !at.list[at.index]) return;
    const layer = at.list[at.index];
    if (layer.mask) return;
    const m = makeCanvas(this.width, this.height);
    const mctx = m.getContext('2d');
    if (mode === 'hide-all') { /* fully black */ }
    else if ((mode === 'reveal-sel' || mode === 'hide-sel') && this.selection) {
      mctx.drawImage(this.selection.mask, 0, 0);
      if (mode === 'hide-sel') {
        mctx.globalCompositeOperation = 'destination-out';
        mctx.drawImage(this.selection.mask, 0, 0);
        mctx.globalCompositeOperation = 'source-over';
      }
    } else { mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, this.width, this.height); }
    const after = { mask: m, maskEnabled: true, maskRevision: layer.maskRevision + 1 };
    const before = { mask: null, maskEnabled: true, maskRevision: layer.maskRevision };
    const apply = (state) => {
      layer.mask = state.mask; layer.maskEnabled = state.maskEnabled;
      layer.maskRevision = state.maskRevision; this.changed();
    };
    this.history.push(label, () => apply(before), () => apply(after));
    apply(after);
  }

  deleteLayerMask(id = null, applyToPixels = false, label = 'Delete mask') {
    const at = this.locate(id ?? this._activeId);
    if (!at) return;
    const layer = at.list[at.index];
    if (!layer.mask) return;
    if (applyToPixels && layer.type !== 'group' && !layer.locked) {
      // bake: keep pixels only where the mask shows them
      const before = copyCanvas(layer.canvas);
      layer.ctx.globalCompositeOperation = 'destination-in';
      layer.ctx.drawImage(layer.mask, 0, 0);
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.revision++;
      const after = copyCanvas(layer.canvas);
      const maskRef = layer.mask;
      const restore = (canvas, mask) => {
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(canvas, 0, 0);
        layer.mask = mask;
        layer.revision++; this.changed();
      };
      this.history.push('Apply mask', () => restore(before, maskRef), () => restore(after, null));
    } else {
      const states = { before: layer.mask, after: null };
      this.history.push(label,
        () => { layer.mask = states.before; this.changed(); },
        () => { layer.mask = states.after; this.changed(); });
      layer.mask = null;
    }
    this.changed();
  }

  toggleLayerMaskEnabled(id = null) {
    const layer = this.findLayer(id ?? this._activeId);
    if (!layer?.mask) return;
    const was = layer.maskEnabled;
    this.history.push('Enable/disable mask',
      () => { layer.maskEnabled = was; this.changed(); },
      () => { layer.maskEnabled = !was; this.changed(); });
    layer.maskEnabled = !was;
    this.changed();
  }

  /* history entry for painting on a layer mask (used by the brush tools) */
  withMaskSnapshot(label, layer, fn) {
    if (!layer?.mask) return fn();
    const before = copyCanvas(layer.mask);
    const wasRev = layer.maskRevision;
    fn(layer.mask.getContext('2d', { willReadFrequently: true }));
    const after = copyCanvas(layer.mask);
    layer.maskRevision++;
    this.history.push(label,
      () => {
        layer.mask.getContext('2d').clearRect(0, 0, layer.mask.width, layer.mask.height);
        layer.mask.getContext('2d').drawImage(before, 0, 0);
        layer.maskRevision++; this.changed();
      },
      () => {
        layer.mask.getContext('2d').clearRect(0, 0, layer.mask.width, layer.mask.height);
        layer.mask.getContext('2d').drawImage(after, 0, 0);
        layer.maskRevision++; this.changed();
      });
    this.changed();
  }
  async withMaskSnapshotAsync(label, layer, fn) {
    if (!layer?.mask) { if (fn) await fn(layer?.mask?.getContext?.('2d')); return; }
    const before = copyCanvas(layer.mask);
    await fn(layer.mask.getContext('2d', { willReadFrequently: true }));
    const after = copyCanvas(layer.mask);
    layer.maskRevision++;
    this.history.push(label,
      () => {
        layer.mask.getContext('2d').clearRect(0, 0, layer.mask.width, layer.mask.height);
        layer.mask.getContext('2d').drawImage(before, 0, 0);
        layer.maskRevision++; this.changed();
      },
      () => {
        layer.mask.getContext('2d').clearRect(0, 0, layer.mask.width, layer.mask.height);
        layer.mask.getContext('2d').drawImage(after, 0, 0);
        layer.maskRevision++; this.changed();
      });
    this.changed();
  }

  /* ---- pixel ops on a layer, history-recorded ---- */
  withLayerSnapshot(label, layer, fn) {
    if (!layer || layer.type === 'group') return;
    const before = copyCanvas(layer.canvas);
    const wasText = layer.type === 'text' ? { ...layer.t } : null;
    fn();
    const after = copyCanvas(layer.canvas);
    layer.revision++;
    const isText = layer.type === 'text' ? { ...layer.t } : null;
    this.history.push(label,
      () => {
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(before, 0, 0);
        layer.revision++;
        if (wasText && layer.type === 'text') layer.t = { ...wasText };
        this.changed();
      },
      () => {
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(after, 0, 0);
        layer.revision++;
        if (isText && layer.type === 'text') layer.t = { ...isText };
        this.changed();
      }, { bytes: before.width * before.height * 4 * 2 });
    this.changed();
  }

  async withLayerSnapshotAsync(label, layer, fn) {
    if (!layer || layer.type === 'group') return fn ? await fn() : undefined;
    const before = copyCanvas(layer.canvas);
    const wasText = layer.type === 'text' ? { ...layer.t } : null;
    await fn();
    const after = copyCanvas(layer.canvas);
    layer.revision++;
    const isText = layer.type === 'text' ? { ...layer.t } : null;
    this.history.push(label,
      () => {
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(before, 0, 0);
        layer.revision++;
        if (wasText && layer.type === 'text') layer.t = { ...wasText };
        this.changed();
      },
      () => {
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(after, 0, 0);
        layer.revision++;
        if (isText && layer.type === 'text') layer.t = { ...isText };
        this.changed();
      }, { bytes: before.width * before.height * 4 * 2 });
    this.changed();
  }

  /* clipping masks */
  setClipped(id = null, flag = null, label = 'Clipping mask') {
    const layer = this.findLayer(id ?? this._activeId);
    if (!layer) return;
    if (layer.clipped && flag === null) return this.releaseClip(id, label);
    const was = layer.clipped;
    const next = flag === null ? true : flag;
    this.history.push(label,
      () => { layer.clipped = was; this.changed(); },
      () => { layer.clipped = next; this.changed(); });
    layer.clipped = next;
    this.changed();
  }
  releaseClip(id = null, label = 'Release clipping mask') {
    const layer = this.findLayer(id ?? this._activeId);
    if (!layer?.clipped) return;
    this.history.push(label,
      () => { layer.clipped = true; this.changed(); },
      () => { layer.clipped = false; this.changed(); });
    layer.clipped = false;
    this.changed();
  }

  /* ---- whole-document geometry (history via full snapshot) ---- */
  _geoSnapshot() {
    return {
      w: this.width, h: this.height,
      root: cloneLevel(this.layers),
      masks: new Map([...this.signalMasks].map(([id, data]) => [id, new Uint8ClampedArray(data)])),
      idx: this.activeIndex,
    };
  }
  _geoRestore(s) {
    this.width = s.w; this.height = s.h;
    this._compo = makeCanvas(s.w, s.h);
    this._compoCtx = this._compo.getContext('2d', { willReadFrequently: true });
    this.layers = cloneLevel(s.root);
    this.signalMasks = new Map([...s.masks].map(([id, data]) => [id, new Uint8ClampedArray(data)]));
    this.activeIndex = s.idx;
    this.selection = null;
    this.changed(true);
  }
  _geo(label, mutate) {
    const before = this._geoSnapshot();
    mutate();
    const after = this._geoSnapshot();
    this.history.push(label, () => this._geoRestore(before), () => this._geoRestore(after));
    this._geoRestore(after); // apply canonical state (also resets compose buffer)
  }
  _transformSignalMasks(w, h, draw) {
    const transformed = new Map();
    for (const [id, alpha] of this.signalMasks) {
      const src = makeCanvas(this.width, this.height), sctx = src.getContext('2d'), image = sctx.createImageData(this.width, this.height);
      for (let i = 0; i < alpha.length; i++) image.data.set([255, 255, 255, alpha[i]], i * 4);
      sctx.putImageData(image, 0, 0);
      const dst = makeCanvas(w, h), dctx = dst.getContext('2d', { willReadFrequently: true }); draw(dctx, src, w, h);
      const rgba = dctx.getImageData(0, 0, w, h).data, next = new Uint8ClampedArray(w * h);
      for (let i = 0; i < next.length; i++) next[i] = rgba[i * 4 + 3];
      transformed.set(id, next);
    }
    this.signalMasks = transformed;
  }

  /* Shared geometry walker: rebuilds the whole tree for image/canvas ops.
     leaf(l) -> replacement leaf node; groupState.drawMask(ctx, srcMask, sw, sh)
     -> optional re-placement of group masks. */
  _geoTree(list, leaf, groupState = null, w = this.width, h = this.height) {
    return list.map(l => {
      if (l.type === 'group') {
        const ng = new GroupLayer(l.name);
        copyShared(l, ng);
        ng.expanded = l.expanded;
        ng.children = this._geoTree(l.children, leaf, groupState, w, h);
        if (ng.mask && groupState?.drawMask) {
          ng.mask = makeCanvas(w, h);
          groupState.drawMask(ng.mask.getContext('2d'), l.mask, l.mask.width, l.mask.height);
          ng.maskRevision = l.maskRevision + 1;
        }
        return ng;
      }
      return leaf(l);
    });
  }

  resizeImage(w, h, smooth = true) {
    this._geo('Image size', () => {
      const sx = w / this.width, sy = h / this.height;
      const stretch = (ctx, src, sw, sh) => {
        ctx.imageSmoothingEnabled = smooth;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
      };
      this._transformSignalMasks(w, h, stretch);
      this.layers = this._geoTree(this.layers, (l) => {
        if (l.type === 'adjust') {
          const nl = l.clone(); nl.name = l.name;
          if (l.mask) {
            nl.mask = makeCanvas(w, h);
            stretch(nl.mask.getContext('2d'), l.mask, l.mask.width, l.mask.height);
            nl.maskRevision = l.maskRevision + 1;
          } else nl.mask = null;
          return nl;
        }
        if (l.type === 'text') return this._resizeText(l, w, h, sx, sy);
        const nl = l.clone(); nl.name = l.name;
        nl.resize(w, h, smooth);
        return nl;
      }, { drawMask: stretch }, w, h);
      this.width = w; this.height = h;
    });
  }
  _resizeText(l, w, h, sx, sy) {
    const nl = l.clone();
    nl.name = l.name;
    nl.t.size = Math.max(1, Math.round(l.t.size * sy));
    nl.t.x = Math.round(l.t.x * sx); nl.t.y = Math.round(l.t.y * sy);
    nl.canvas = makeCanvas(w, h);
    nl.ctx = nl.canvas.getContext('2d', { willReadFrequently: true });
    nl.render();
    if (l.mask) {
      nl.mask = makeCanvas(w, h);
      const mctx = nl.mask.getContext('2d');
      mctx.imageSmoothingEnabled = true;
      mctx.imageSmoothingQuality = 'high';
      mctx.drawImage(l.mask, 0, 0, l.mask.width, l.mask.height, 0, 0, w, h);
      nl.maskRevision = l.maskRevision + 1;
    } else nl.mask = null;
    return nl;
  }

  /* text leaf rebuild shared by canvas-size and crop ops */
  _geoTextLeaf(l, w, h, place, adjustT) {
    const nl = l.clone();
    nl.name = l.name;
    adjustT(nl.t);
    nl.canvas = makeCanvas(w, h);
    nl.ctx = nl.canvas.getContext('2d', { willReadFrequently: true });
    nl.render();
    if (l.mask) {
      nl.mask = makeCanvas(w, h);
      place(nl.mask.getContext('2d'), l.mask);
      nl.maskRevision = l.maskRevision + 1;
    } else nl.mask = null;
    return nl;
  }

  resizeCanvas(w, h, anchor = 'center') {
    this._geo('Canvas size', () => {
      const ax = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : .5;
      const ay = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : .5;
      const dx = Math.round((w - this.width) * ax);
      const dy = Math.round((h - this.height) * ay);
      const place = (ctx, src) => ctx.drawImage(src, dx, dy);
      this._transformSignalMasks(w, h, place);
      this.layers = this._geoTree(this.layers, (l) => {
        if (l.type === 'adjust') {
          const nl = l.clone(); nl.name = l.name;
          if (l.mask) {
            nl.mask = makeCanvas(w, h);
            place(nl.mask.getContext('2d'), l.mask);
            nl.maskRevision = l.maskRevision + 1;
          } else nl.mask = null;
          return nl;
        }
        if (l.type === 'text') return this._geoTextLeaf(l, w, h, place, (t) => { t.x += dx; t.y += dy; });
        const nl = l.clone(); nl.name = l.name;
        nl.rebase(w, h, dx, dy);
        return nl;
      }, { drawMask: place }, w, h);
      this.width = w; this.height = h;
    });
  }

  crop(rect) {
    const { x, y, w, h } = rect;
    this._geo('Crop', () => {
      const place = (ctx, src) => ctx.drawImage(src, -x, -y);
      this._transformSignalMasks(w, h, place);
      this.layers = this._geoTree(this.layers, (l) => {
        if (l.type === 'adjust') {
          const nl = l.clone(); nl.name = l.name;
          if (l.mask) {
            nl.mask = makeCanvas(w, h);
            place(nl.mask.getContext('2d'), l.mask);
            nl.maskRevision = l.maskRevision + 1;
          } else nl.mask = null;
          return nl;
        }
        if (l.type === 'text') return this._geoTextLeaf(l, w, h, place, (t) => { t.x -= x; t.y -= y; });
        const nl = l.clone(); nl.name = l.name;
        nl.rebase(w, h, -x, -y);
        return nl;
      }, { drawMask: place }, w, h);
      this.width = w; this.height = h;
    });
  }

  rotateDoc(deg) { // 90, 180, 270
    this._geo('Rotate canvas', () => {
      const [w, h] = deg === 180 ? [this.width, this.height] : [this.height, this.width];
      const rot = (ctx, src, sw, sh) => {
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(deg * Math.PI / 180);
        ctx.drawImage(src, -sw / 2, -sh / 2);
        ctx.restore();
      };
      this._transformSignalMasks(w, h, (ctx, src) => rot(ctx, src, src.width, src.height));
      this.layers = this._geoTree(this.layers, (l) => {
        if (l.type === 'adjust') {
          const nl = l.clone(); nl.name = l.name;
          if (l.mask) {
            nl.mask = makeCanvas(w, h);
            rot(nl.mask.getContext('2d'), l.mask, l.mask.width, l.mask.height);
            nl.maskRevision = l.maskRevision + 1;
          } else nl.mask = null;
          return nl;
        }
        const nl = l.type === 'text' ? l.rasterize() : l.clone();
        nl.name = l.name;
        nl.geoTransform(w, h, rot);
        return nl;
      }, { drawMask: (ctx, src, sw, sh) => rot(ctx, src, sw, sh) }, w, h);
      this.width = w; this.height = h;
    });
  }

  flipDoc(horizontal) {
    this._geo(horizontal ? 'Flip horizontal' : 'Flip vertical', () => {
      const w = this.width, h = this.height;
      const flip = (ctx, src, sw, sh) => {
        ctx.save();
        if (horizontal) { ctx.scale(-1, 1); ctx.drawImage(src, -sw, 0); }
        else { ctx.scale(1, -1); ctx.drawImage(src, 0, -sh); }
        ctx.restore();
      };
      this._transformSignalMasks(w, h, (ctx, src) => flip(ctx, src, src.width, src.height));
      this.layers = this._geoTree(this.layers, (l) => {
        if (l.type === 'adjust') {
          const nl = l.clone(); nl.name = l.name;
          if (l.mask) {
            nl.mask = makeCanvas(w, h);
            flip(nl.mask.getContext('2d'), l.mask, l.mask.width, l.mask.height);
            nl.maskRevision = l.maskRevision + 1;
          } else nl.mask = null;
          return nl;
        }
        const nl = l.type === 'text' ? l.rasterize() : l.clone();
        nl.name = l.name;
        nl.geoTransform(w, h, flip);
        return nl;
      }, { drawMask: (ctx, src, sw, sh) => flip(ctx, src, sw, sh) });
    });
  }

  /* ---- selection (history-recorded) ---- */
  setSelection(sel, label = 'Select') {
    const before = this.selection, after = sel;
    this.history.push(label,
      () => { this.selection = before; this.changed(); },
      () => { this.selection = after; this.changed(); });
    this.selection = after;
    this.changed();
  }
  selectAll() {
    this.setSelection(Selection.fromRect(this.width, this.height, 0, 0, this.width, this.height), 'Select all');
  }
  deselect() {
    if (this.selection) this.setSelection(null, 'Deselect');
  }
  invertSelection() {
    if (!this.selection) return this.selectAll();
    const c = makeCanvas(this.width, this.height);
    c.getContext('2d').drawImage(this.selection.mask, 0, 0);
    const s = new Selection(this.width, this.height);
    s.mctx.drawImage(c, 0, 0);
    this.setSelection(s.invert(), 'Invert selection');
  }
  /* run a pixelops alpha filter over the selection mask and install the
     result as a NEW selection (history-recorded). Returns false when there
     is nothing selected so callers can toast. */
  filterSelection(label, fn) {
    const sel = this.selection;
    if (!sel || sel.isEmpty) return false;
    const w = sel.mask.width, h = sel.mask.height;
    const img = sel.mctx.getImageData(0, 0, w, h);
    const out = fn(img.data, w, h) || img.data;
    this.setSelection(Selection.fromBlock(w, h, out), label);
    return true;
  }
  featherSelection(px = 4) {
    return this.filterSelection('Feather selection',
      (data, w, h) => blurAlpha(data, w, h, clamp(Math.round(px), 1, 250), 3));
  }
  growSelection(px = 2, erode = false) {
    return this.filterSelection(erode ? 'Contract selection' : 'Expand selection',
      (data, w, h) => growAlpha(data, w, h, clamp(Math.round(px), 1, 250), !!erode));
  }
}

/* color helpers used across modules */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
}
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
}
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
