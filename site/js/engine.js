/* DEADPIXEL engine — document, layers, history, selection, compositing. */

let _uid = 1;
export const uid = () => 'L' + (_uid++) + '_' + Date.now().toString(36);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

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
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'],
  ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'], ['color-burn', 'Color Burn'],
  ['hard-light', 'Hard Light'], ['soft-light', 'Soft Light'],
  ['difference', 'Difference'], ['exclusion', 'Exclusion'],
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

/* ---------------------------------------------------------------- layers */

export class Layer {
  constructor(w, h, name = 'Layer') {
    this.id = uid();
    this.name = name;
    this.type = 'raster';
    this.visible = true;
    this.opacity = 1;
    this.blend = 'source-over';
    this.locked = false;
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }
  draw(ctx) { ctx.drawImage(this.canvas, 0, 0); }
  clone() {
    const l = new Layer(this.canvas.width, this.canvas.height, this.name + ' copy');
    l.visible = this.visible; l.opacity = this.opacity; l.blend = this.blend;
    l.ctx.drawImage(this.canvas, 0, 0);
    return l;
  }
  resize(w, h, smooth = true) {
    const old = this.canvas;
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.ctx.imageSmoothingEnabled = smooth;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(old, 0, 0, old.width, old.height, 0, 0, w, h);
  }
  /* rebuild canvas at new doc size, drawing old content at (dx,dy) */
  rebase(w, h, dx = 0, dy = 0) {
    const old = this.canvas;
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.ctx.drawImage(old, dx, dy);
  }
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
    const l = new TextLayer(this.canvas.width, this.canvas.height, { name: this.name + ' copy', t: { ...this.t } });
    l.visible = this.visible; l.opacity = this.opacity; l.blend = this.blend;
    return l;
  }
  rasterize() {
    const l = new Layer(this.canvas.width, this.canvas.height, this.name);
    l.visible = this.visible; l.opacity = this.opacity; l.blend = this.blend;
    l.ctx.drawImage(this.canvas, 0, 0);
    return l;
  }
}

/* --------------------------------------------------------------- history */

export class History extends EventTarget {
  constructor(cap = 40) {
    super();
    this.entries = [];  // {label, undo(), redo()}
    this.index = -1;    // last applied entry
    this.cap = cap;
  }
  push(label, undo, redo) {
    this.entries.length = this.index + 1;
    this.entries.push({ label, undo, redo });
    if (this.entries.length > this.cap) this.entries.shift();
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
    this.activeIndex = 0;
    this.selection = null;
    this.effects = [];
    this.signalSeed = (Math.random() * 0xffffffff) >>> 0;
    this.effectProcessor = null;
    this.history = new History();
    this.dirty = false;         // unsaved changes
    this._compo = makeCanvas(w, h);
    this._compoCtx = this._compo.getContext('2d', { willReadFrequently: true });
    this._compoDirty = true;

    const base = new Layer(w, h, 'Background');
    if (opts.bg && opts.bg !== 'transparent') {
      base.ctx.fillStyle = opts.bg;
      base.ctx.fillRect(0, 0, w, h);
    }
    this.layers.push(base);
  }
  get activeLayer() { return this.layers[this.activeIndex] || null; }

  changed(structural = false) {
    this.dirty = true;
    this._compoDirty = true;
    this.dispatchEvent(new CustomEvent('change', { detail: { structural } }));
  }

  compose() {
    if (this._compoDirty) {
      const ctx = this._compoCtx;
      ctx.clearRect(0, 0, this.width, this.height);
      for (const l of this.layers) {
        if (!l.visible || l.opacity <= 0) continue;
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = l.blend;
        l.draw(ctx);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (!this._effectsBypassed && this.effects.length && this.effectProcessor) this.effectProcessor(this._compo, this.effects, this.signalSeed);
      this._compoDirty = false;
    }
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

  /* ---- structural ops (history-recorded) ---- */
  _restoreLayers(snapshot, activeIndex) {
    this.layers = snapshot.slice();
    this.activeIndex = clamp(activeIndex, 0, this.layers.length - 1);
    this.changed(true);
  }
  _structural(label, mutate) {
    const before = this.layers.slice(), beforeIdx = this.activeIndex;
    mutate();
    const after = this.layers.slice(), afterIdx = this.activeIndex;
    this.history.push(label,
      () => this._restoreLayers(before, beforeIdx),
      () => this._restoreLayers(after, afterIdx));
    this.changed(true);
  }
  addLayer(layer = null, name = null) {
    const l = layer || new Layer(this.width, this.height, name || 'Layer ' + (this.layers.length + 1));
    this._structural('New layer', () => {
      this.layers.splice(this.activeIndex + 1, 0, l);
      this.activeIndex++;
    });
    return l;
  }
  removeLayer(i = this.activeIndex) {
    if (this.layers.length <= 1) return;
    this._structural('Delete layer', () => {
      this.layers.splice(i, 1);
      this.activeIndex = clamp(this.activeIndex, 0, this.layers.length - 1);
    });
  }
  duplicateLayer(i = this.activeIndex) {
    const src = this.layers[i]; if (!src) return;
    this._structural('Duplicate layer', () => {
      this.layers.splice(i + 1, 0, src.clone());
      this.activeIndex = i + 1;
    });
  }
  moveLayer(from, to) {
    if (from === to || to < 0 || to >= this.layers.length) return;
    this._structural('Reorder layer', () => {
      const [l] = this.layers.splice(from, 1);
      this.layers.splice(to, 0, l);
      this.activeIndex = to;
    });
  }
  mergeDown(i = this.activeIndex) {
    if (i <= 0) return;
    const top = this.layers[i], bottom = this.layers[i - 1];
    const merged = new Layer(this.width, this.height, bottom.name);
    merged.visible = true;
    merged.opacity = bottom.opacity !== 1 || bottom.blend !== 'source-over' ? 1 : bottom.opacity;
    merged.ctx.globalAlpha = bottom.opacity;
    merged.ctx.globalCompositeOperation = 'source-over';
    if (bottom.visible) bottom.draw(merged.ctx);
    merged.ctx.globalAlpha = top.opacity;
    merged.ctx.globalCompositeOperation = top.blend;
    if (top.visible) top.draw(merged.ctx);
    merged.ctx.globalAlpha = 1;
    merged.ctx.globalCompositeOperation = 'source-over';
    this._structural('Merge down', () => {
      this.layers.splice(i - 1, 2, merged);
      this.activeIndex = i - 1;
    });
  }
  flatten() {
    const flat = new Layer(this.width, this.height, 'Background');
    flat.ctx.drawImage(this.compose(), 0, 0);
    this._structural('Flatten', () => {
      this.layers = [flat];
      this.activeIndex = 0;
    });
  }
  rasterizeLayer(i = this.activeIndex) {
    const l = this.layers[i];
    if (!l || l.type !== 'text') return;
    this._structural('Rasterize text', () => {
      this.layers.splice(i, 1, l.rasterize());
    });
  }

  /* ---- pixel ops on a layer, history-recorded ---- */
  withLayerSnapshot(label, layer, fn) {
    const before = copyCanvas(layer.canvas);
    const wasText = layer.type === 'text' ? { ...layer.t } : null;
    fn();
    const after = copyCanvas(layer.canvas);
    const isText = layer.type === 'text' ? { ...layer.t } : null;
    this.history.push(label,
      () => {
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(before, 0, 0);
        if (wasText && layer.type === 'text') layer.t = { ...wasText };
        this.changed();
      },
      () => {
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(after, 0, 0);
        if (isText && layer.type === 'text') layer.t = { ...isText };
        this.changed();
      });
    this.changed();
  }

  /* ---- whole-document geometry (history via full snapshot) ---- */
  _geoSnapshot() {
    return {
      w: this.width, h: this.height,
      layers: this.layers.slice(),
      idx: this.activeIndex,
    };
  }
  _geoRestore(s) {
    this.width = s.w; this.height = s.h;
    this._compo = makeCanvas(s.w, s.h);
    this._compoCtx = this._compo.getContext('2d', { willReadFrequently: true });
    this.layers = s.layers.slice();
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
  resizeImage(w, h, smooth = true) {
    this._geo('Image size', () => {
      const sx = w / this.width, sy = h / this.height;
      this.layers = this.layers.map(l => {
        if (l.type === 'text') {
          const nl = l.clone();
          nl.name = l.name;
          nl.t.size = Math.max(1, Math.round(l.t.size * sy));
          nl.t.x = Math.round(l.t.x * sx); nl.t.y = Math.round(l.t.y * sy);
          nl.canvas = makeCanvas(w, h);
          nl.ctx = nl.canvas.getContext('2d', { willReadFrequently: true });
          nl.render();
          return nl;
        }
        const nl = l.clone(); nl.name = l.name;
        nl.resize(w, h, smooth);
        return nl;
      });
      this.width = w; this.height = h;
    });
  }
  resizeCanvas(w, h, anchor = 'center') {
    this._geo('Canvas size', () => {
      const ax = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : .5;
      const ay = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : .5;
      const dx = Math.round((w - this.width) * ax);
      const dy = Math.round((h - this.height) * ay);
      this.layers = this.layers.map(l => {
        const nl = l.clone(); nl.name = l.name;
        if (nl.type === 'text') {
          nl.t.x += dx; nl.t.y += dy;
          nl.canvas = makeCanvas(w, h);
          nl.ctx = nl.canvas.getContext('2d', { willReadFrequently: true });
          nl.render();
        } else nl.rebase(w, h, dx, dy);
        return nl;
      });
      this.width = w; this.height = h;
    });
  }
  crop(rect) {
    const { x, y, w, h } = rect;
    this._geo('Crop', () => {
      this.layers = this.layers.map(l => {
        const nl = l.clone(); nl.name = l.name;
        if (nl.type === 'text') {
          nl.t.x -= x; nl.t.y -= y;
          nl.canvas = makeCanvas(w, h);
          nl.ctx = nl.canvas.getContext('2d', { willReadFrequently: true });
          nl.render();
        } else nl.rebase(w, h, -x, -y);
        return nl;
      });
      this.width = w; this.height = h;
    });
  }
  rotateDoc(deg) { // 90, 180, 270
    this._geo('Rotate canvas', () => {
      const [w, h] = deg === 180 ? [this.width, this.height] : [this.height, this.width];
      this.layers = this.layers.map(l => {
        const src = l.type === 'text' ? l.rasterize() : l.clone();
        src.name = l.name;
        const nl = src;
        const old = nl.canvas;
        nl.canvas = makeCanvas(w, h);
        nl.ctx = nl.canvas.getContext('2d', { willReadFrequently: true });
        nl.ctx.save();
        nl.ctx.translate(w / 2, h / 2);
        nl.ctx.rotate(deg * Math.PI / 180);
        nl.ctx.drawImage(old, -old.width / 2, -old.height / 2);
        nl.ctx.restore();
        return nl;
      });
      this.width = w; this.height = h;
    });
  }
  flipDoc(horizontal) {
    this._geo(horizontal ? 'Flip horizontal' : 'Flip vertical', () => {
      this.layers = this.layers.map(l => {
        const nl = l.type === 'text' ? l.rasterize() : l.clone();
        nl.name = l.name;
        const old = nl.canvas;
        nl.canvas = makeCanvas(this.width, this.height);
        nl.ctx = nl.canvas.getContext('2d', { willReadFrequently: true });
        nl.ctx.save();
        if (horizontal) { nl.ctx.scale(-1, 1); nl.ctx.drawImage(old, -this.width, 0); }
        else { nl.ctx.scale(1, -1); nl.ctx.drawImage(old, 0, -this.height); }
        nl.ctx.restore();
        return nl;
      });
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
