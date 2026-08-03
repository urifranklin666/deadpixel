/* DEADPIXEL tools — tool framework + implementations.
   A tool: {id, name, key, icon, options[], onDown/onMove/onUp/onKey,
            drawOverlay(app,ctx), onActivate/onDeactivate}
   Coordinates arriving in handlers are doc-space {x, y, pressure, e}. */

import { makeCanvas, copyCanvas, clamp, Selection, TextLayer, hexToRgb, rgbToHex } from './engine.js';
import { Stroke, BRUSH_PRESETS, renderTip, STAMPS, renderStamp } from './brushes.js';

/* ---------- svg icons (stroke style, 24 box) ---------- */
const I = {
  move: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>',
  marquee: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.4"/>',
  lasso: '<path d="M4 11c0-3.9 3.6-6 8-6s8 2.1 8 6-3.6 6-8 6c-1 0-2-.1-2.9-.4M6 19.5c-1.2-.6-1.6-2.3-.8-3.6"/><circle cx="7" cy="19" r="1.6"/>',
  wand: '<path d="M15 9L4 20M17 3v3M21 7h-3M20 3l-2 2M14 6l1.5 1.5M19 11l-1.5-1.5"/>',
  crop: '<path d="M7 2v15h15M2 7h15v15"/>',
  picker: '<path d="M14 6l4 4M6 18l-3 1 1-3L15 5l3 3L7 19zM17 3l4 4"/>',
  brush: '<path d="M20 4c-4 1-9 5-11 9l2 2c4-2 8-7 9-11zM9 13c-2 0-4 2-4 4 0 1-1 2-2 2 1.5 2 6 2 7-1 .5-1.5 0-3-1-5z"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3"/>',
  eraser: '<path d="M8 19l-4-4c-.8-.8-.8-2 0-2.8l7-7c.8-.8 2-.8 2.8 0l4.2 4.2c.8.8.8 2 0 2.8L11 19H8zM6 21h14"/>',
  clone: '<rect x="3" y="3" width="12" height="12"/><path d="M9 21h12V9M15 15h6M15 21V15"/>',
  smudge: '<path d="M5 18c2-1 3-3 3-6 0-2 1-4 3-4s3 2 3 4c0 3 1 5 3 6M4 20h16"/>',
  fill: '<path d="M8 3l9 9-7 7-7-7 5-5zM3 12h11M19 15s2 2.4 2 4a2 2 0 1 1-4 0c0-1.6 2-4 2-4z"/>',
  gradient: '<rect x="3" y="5" width="18" height="14"/><path d="M7 5v14M11 5v14" opacity=".6"/><path d="M15 5v14" opacity=".3"/>',
  shape: '<rect x="3" y="9" width="10" height="10"/><circle cx="16" cy="8" r="5"/>',
  stamp: '<path d="M9 11c0-2-1-2.5-1-4a4 4 0 1 1 8 0c0 1.5-1 2-1 4M5 15h14v4H5zM7 15v-2c0-1 1-2 2-2h6c1 0 2 1 2 2v2"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  hand: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0V13c0 4-2 8-6 8-3 0-4.5-1.5-6.5-5L3 12.6c-.6-1 .2-2.3 1.4-2.1.6.1 1.1.5 1.4 1L8 14"/>',
  zoom: '<circle cx="10" cy="10" r="7"/><path d="M21 21l-6-6M7 10h6M10 7v6"/>',
};
export const iconSvg = (id) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${I[id] || ''}</svg>`;

/* ---------- shared option descriptors ---------- */
const brushCommonOpts = [
  { type: 'slider', key: 'size', label: 'Size', min: 1, max: 400, step: 1, scope: 'brush' },
  { type: 'slider', key: 'opacity', label: 'Opacity', min: 1, max: 100, step: 1, scope: 'brush', pct: true },
  { type: 'slider', key: 'flow', label: 'Flow', min: 1, max: 100, step: 1, scope: 'brush', pct: true },
  { type: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 100, step: 1, scope: 'brush', pct: true },
  { type: 'check', key: 'pressureSize', label: 'PEN→SIZE', scope: 'brush' },
];

function paintableLayer(app) {
  const l = app.doc?.activeLayer;
  if (!l) return null;
  if (l.locked) { app.toast('LAYER IS LOCKED', true); return null; }
  if (l.type === 'text') { app.toast('TEXT LAYER — RASTERIZE TO PAINT (Layer ▸ Rasterize)', true); return null; }
  return l;
}

function strokeSettings(app, over = {}) {
  const b = app.brush;
  const preset = BRUSH_PRESETS.find(p => p.id === b.preset) || BRUSH_PRESETS[0];
  return {
    tip: preset.tip, pixel: !!preset.pixel,
    smooth: !!preset.smooth,
    jitter: preset.jitter || 0, angleJitter: preset.angleJitter || 0,
    flowScale: preset.flowScale || 1,
    spacing: preset.spacing,
    size: b.size, hardness: b.hardness / 100,
    opacity: b.opacity / 100, flow: b.flow / 100,
    color: app.color.fg,
    pressureSize: b.pressureSize, pressureFlow: false,
    erase: false,
    ...over,
  };
}

/* ============================== TOOLS ============================== */

export const TOOLS = [];
const T = (t) => { TOOLS.push(t); return t; };

/* ---------------- move ---------------- */
T({
  id: 'move', name: 'MOVE', key: 'v', icon: 'move',
  hint: 'drag to move layer · Ctrl+T transform · arrows nudge',
  options: [],
  onDown(app, p) {
    const l = app.doc.activeLayer;
    if (!l || l.locked) { if (l?.locked) app.toast('LAYER IS LOCKED', true); return; }
    this.start = p; this.layer = l;
    this.snap = l.type === 'text' ? { x: l.t.x, y: l.t.y } : copyCanvas(l.canvas);
    this.moved = false;
  },
  onMove(app, p) {
    if (!this.start) return;
    const dx = Math.round(p.x - this.start.x), dy = Math.round(p.y - this.start.y);
    if (!dx && !dy) return;
    this.moved = true;
    const l = this.layer;
    if (l.type === 'text') {
      l.t.x = this.snap.x + dx; l.t.y = this.snap.y + dy;
      l.render();
    } else {
      l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
      l.ctx.drawImage(this.snap, dx, dy);
    }
    app.doc.changed();
  },
  onUp(app, p) {
    if (!this.start) return;
    const l = this.layer, snap = this.snap, moved = this.moved;
    this.start = null;
    if (!moved) return;
    const dx = Math.round(p.x - (l.type === 'text' ? 0 : 0)); // final state already applied
    // rebuild history entry: restore original, then re-apply through snapshot wrapper
    if (l.type === 'text') {
      const now = { x: l.t.x, y: l.t.y };
      l.t.x = snap.x; l.t.y = snap.y; l.render();
      app.doc.withLayerSnapshot('Move layer', l, () => { l.t.x = now.x; l.t.y = now.y; l.render(); });
    } else {
      const now = copyCanvas(l.canvas);
      l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
      l.ctx.drawImage(snap, 0, 0);
      app.doc.withLayerSnapshot('Move layer', l, () => {
        l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
        l.ctx.drawImage(now, 0, 0);
      });
    }
  },
});

/* ---------------- marquee (rect/ellipse) ---------------- */
T({
  id: 'marquee', name: 'MARQUEE', key: 'm', icon: 'marquee',
  hint: 'drag to select · Shift = square/circle · Esc deselect',
  options: [
    { type: 'seg', key: 'shape', label: 'Shape', values: [['rect', 'RECT'], ['ellipse', 'ELLIPSE']], scope: 'tool', def: 'rect' },
  ],
  state: { shape: 'rect' },
  onDown(app, p) { this.a = p; this.b = p; },
  onMove(app, p, e) {
    if (!this.a) return;
    if (e.shiftKey) {
      const dx = p.x - this.a.x, dy = p.y - this.a.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      this.b = { x: this.a.x + Math.sign(dx || 1) * m, y: this.a.y + Math.sign(dy || 1) * m };
    } else this.b = p;
    app.requestRender();
  },
  onUp(app) {
    if (!this.a) return;
    const x = Math.min(this.a.x, this.b.x), y = Math.min(this.a.y, this.b.y);
    const w = Math.abs(this.b.x - this.a.x), h = Math.abs(this.b.y - this.a.y);
    this.a = null;
    if (w < 2 || h < 2) { app.doc.deselect(); app.requestRender(); return; }
    const D = app.doc;
    const sel = this.state.shape === 'ellipse'
      ? Selection.fromEllipse(D.width, D.height, x + w / 2, y + h / 2, w / 2, h / 2)
      : Selection.fromRect(D.width, D.height, x, y, w, h);
    D.setSelection(sel, 'Marquee select');
    app.requestRender();
  },
  drawOverlay(app, ctx) {
    if (!this.a) return;
    const [x1, y1] = app.docToScreen(Math.min(this.a.x, this.b.x), Math.min(this.a.y, this.b.y));
    const [x2, y2] = app.docToScreen(Math.max(this.a.x, this.b.x), Math.max(this.a.y, this.b.y));
    ctx.save();
    ctx.strokeStyle = '#ff2233'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    if (this.state.shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else ctx.strokeRect(x1 + .5, y1 + .5, x2 - x1, y2 - y1);
    ctx.restore();
  },
});

/* ---------------- lasso ---------------- */
T({
  id: 'lasso', name: 'LASSO', key: 'l', icon: 'lasso',
  hint: 'freehand: drag · poly: click points, Enter/dblclick close, Esc cancel',
  options: [
    { type: 'seg', key: 'mode', label: 'Mode', values: [['free', 'FREE'], ['poly', 'POLY']], scope: 'tool', def: 'free' },
  ],
  state: { mode: 'free' },
  pts: null,
  onDown(app, p, e) {
    if (this.state.mode === 'free') { this.pts = [p]; this.dragging = true; }
    else {
      if (!this.pts) this.pts = [];
      this.pts.push(p);
      if (e.detail >= 2) this.close(app);
    }
    app.requestRender();
  },
  onMove(app, p) {
    if (this.state.mode === 'free' && this.dragging) { this.pts.push(p); app.requestRender(); }
    else if (this.pts) { this.hover = p; app.requestRender(); }
  },
  onUp(app) {
    if (this.state.mode === 'free' && this.dragging) { this.dragging = false; this.close(app); }
  },
  onKey(app, e) {
    if (!this.pts) return false;
    if (e.key === 'Enter') { this.close(app); return true; }
    if (e.key === 'Escape') { this.pts = null; app.requestRender(); return true; }
    return false;
  },
  close(app) {
    const pts = this.pts; this.pts = null; this.hover = null;
    if (!pts || pts.length < 3) { app.requestRender(); return; }
    app.doc.setSelection(Selection.fromPolygon(app.doc.width, app.doc.height, pts), 'Lasso select');
    app.requestRender();
  },
  drawOverlay(app, ctx) {
    if (!this.pts || !this.pts.length) return;
    ctx.save();
    ctx.strokeStyle = '#ff2233'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.beginPath();
    this.pts.forEach((p, i) => {
      const [sx, sy] = app.docToScreen(p.x, p.y);
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    });
    if (this.hover) { const [hx, hy] = app.docToScreen(this.hover.x, this.hover.y); ctx.lineTo(hx, hy); }
    ctx.stroke();
    ctx.restore();
  },
  onDeactivate() { this.pts = null; this.hover = null; },
});

/* ---------------- magic wand ---------------- */
T({
  id: 'wand', name: 'WAND', key: 'w', icon: 'wand',
  hint: 'click to select similar pixels',
  options: [
    { type: 'slider', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1, scope: 'tool', def: 32 },
    { type: 'check', key: 'contiguous', label: 'CONTIGUOUS', scope: 'tool', def: true },
  ],
  state: { tolerance: 32, contiguous: true },
  onDown(app, p) {
    const D = app.doc;
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= D.width || y0 >= D.height) return;
    const comp = D.compose();
    const img = comp.getContext('2d').getImageData(0, 0, D.width, D.height);
    const d = img.data, w = D.width, h = D.height;
    const i0 = (y0 * w + x0) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
    const tol = this.state.tolerance;
    const match = (i) => {
      const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb, da = d[i + 3] - ta;
      return Math.sqrt((dr * dr + dg * dg + db * db + da * da) / 4) <= tol;
    };
    const mask = new Uint8Array(w * h);
    if (this.state.contiguous) {
      const stack = [y0 * w + x0];
      mask[y0 * w + x0] = 255;
      while (stack.length) {
        const pos = stack.pop();
        const px = pos % w, py = (pos / w) | 0;
        const neigh = [];
        if (px > 0) neigh.push(pos - 1);
        if (px < w - 1) neigh.push(pos + 1);
        if (py > 0) neigh.push(pos - w);
        if (py < h - 1) neigh.push(pos + w);
        for (const n of neigh) {
          if (!mask[n] && match(n * 4)) { mask[n] = 255; stack.push(n); }
        }
      }
    } else {
      for (let i = 0; i < w * h; i++) if (match(i * 4)) mask[i] = 255;
    }
    D.setSelection(Selection.fromMaskData(w, h, mask), 'Magic wand');
    app.requestRender();
  },
});

/* ---------------- crop ---------------- */
T({
  id: 'crop', name: 'CROP', key: 'c', icon: 'crop',
  hint: 'drag crop area · Enter/✓ apply · Esc cancel',
  options: [
    { type: 'button', label: '✓ APPLY', action: 'apply', scope: 'tool' },
    { type: 'button', label: '✗ CANCEL', action: 'cancel', scope: 'tool' },
  ],
  rect: null,
  onDown(app, p) { this.a = p; this.rect = null; app.requestRender(); },
  onMove(app, p) {
    if (!this.a) return;
    this.rect = {
      x: Math.round(Math.min(this.a.x, p.x)), y: Math.round(Math.min(this.a.y, p.y)),
      w: Math.round(Math.abs(p.x - this.a.x)), h: Math.round(Math.abs(p.y - this.a.y)),
    };
    app.requestRender();
  },
  onUp(app, p, e) {
    this.a = null;
    if (this.rect && (this.rect.w < 3 || this.rect.h < 3)) this.rect = null;
    if (e && e.detail >= 2) this.doAction(app, 'apply');
    app.requestRender();
  },
  onKey(app, e) {
    if (e.key === 'Enter' && this.rect) { this.doAction(app, 'apply'); return true; }
    if (e.key === 'Escape' && this.rect) { this.rect = null; app.requestRender(); return true; }
    return false;
  },
  doAction(app, action) {
    if (action === 'cancel') { this.rect = null; app.requestRender(); return; }
    if (action === 'apply' && this.rect) {
      const D = app.doc;
      const r = {
        x: clamp(this.rect.x, 0, D.width - 1), y: clamp(this.rect.y, 0, D.height - 1),
        w: clamp(this.rect.w, 1, D.width), h: clamp(this.rect.h, 1, D.height),
      };
      this.rect = null;
      D.crop(r);
      app.fitView();
      app.toast('CROPPED ' + r.w + '×' + r.h);
    }
  },
  drawOverlay(app, ctx) {
    if (!this.rect) return;
    const [x1, y1] = app.docToScreen(this.rect.x, this.rect.y);
    const [x2, y2] = app.docToScreen(this.rect.x + this.rect.w, this.rect.y + this.rect.h);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.fillRect(0, 0, W, y1); ctx.fillRect(0, y2, W, H - y2);
    ctx.fillRect(0, y1, x1, y2 - y1); ctx.fillRect(x2, y1, W - x2, y2 - y1);
    ctx.strokeStyle = '#ff2233'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x1 + .5, y1 + .5, x2 - x1, y2 - y1);
    ctx.font = '14px VT323, monospace'; ctx.fillStyle = '#ff2233';
    ctx.fillText(`${this.rect.w}×${this.rect.h}`, x1 + 6, y1 - 6);
    ctx.restore();
  },
  onDeactivate() { this.rect = null; this.a = null; },
});

/* ---------------- eyedropper ---------------- */
T({
  id: 'picker', name: 'PICKER', key: 'i', icon: 'picker',
  hint: 'click to sample color · Alt-click sets background',
  options: [],
  pick(app, p, e) {
    const D = app.doc;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= D.width || y >= D.height) return;
    const d = D.compose().getContext('2d').getImageData(x, y, 1, 1).data;
    const hex = rgbToHex(d[0], d[1], d[2]);
    if (e.altKey) app.setColor('bg', hex); else app.setColor('fg', hex);
  },
  onDown(app, p, e) { this.pick(app, p, e); this.down = true; },
  onMove(app, p, e) { if (this.down) this.pick(app, p, e); },
  onUp() { this.down = false; },
});

/* ---------------- brush-family factory ---------------- */
function paintTool(def) {
  return {
    ...def,
    onDown(app, p, e) {
      const layer = paintableLayer(app);
      if (!layer) return;
      this.stroke = new Stroke(app.doc, layer, this.settings(app));
      this.stroke.moveTo(p.x, p.y, p.pressure);
      app.requestRender();
    },
    onMove(app, p) {
      if (!this.stroke) return;
      this.stroke.moveTo(p.x, p.y, p.pressure);
      app.requestRender();
    },
    onUp(app) {
      if (!this.stroke) return;
      this.stroke.commit(this.label);
      this.stroke = null;
      app.requestRender();
    },
    drawOverlay(app, ctx) {
      // brush size cursor
      if (app.pointer && app.pointerInView) {
        const r = (app.brush.size / 2) * app.view.zoom;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(app.pointer.sx, app.pointer.sy, Math.max(2, r), 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,.5)';
        ctx.beginPath();
        ctx.arc(app.pointer.sx, app.pointer.sy, Math.max(2, r) + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    },
  };
}

T(paintTool({
  id: 'brush', name: 'BRUSH', key: 'b', icon: 'brush',
  hint: 'paint · [ ] size · pick tips in BRUSH MORGUE panel',
  label: 'Brush stroke',
  options: brushCommonOpts,
  settings(app) { return strokeSettings(app); },
  previewStroke() { return this.stroke; },
}));

T(paintTool({
  id: 'pencil', name: 'PENCIL', key: 'n', icon: 'pencil',
  hint: 'hard pixel lines, no anti-aliasing',
  label: 'Pencil',
  options: [
    { type: 'slider', key: 'size', label: 'Size', min: 1, max: 100, step: 1, scope: 'brush' },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 1, max: 100, step: 1, scope: 'brush', pct: true },
  ],
  settings(app) {
    return strokeSettings(app, { tip: 'pixel', pixel: true, smooth: false, spacing: .25, hardness: 1, flow: 1, jitter: 0, angleJitter: 0 });
  },
  previewStroke() { return this.stroke; },
}));

T(paintTool({
  id: 'eraser', name: 'ERASER', key: 'e', icon: 'eraser',
  hint: 'erase to transparency',
  label: 'Eraser',
  options: brushCommonOpts.slice(0, 4),
  settings(app) { return strokeSettings(app, { erase: true, color: '#ffffff' }); },
  previewStroke() { return this.stroke; },
}));

/* ---------------- clone stamp ---------------- */
T({
  id: 'clone', name: 'CLONE', key: 's', icon: 'clone',
  hint: 'Alt-click source, then paint to clone',
  options: [
    { type: 'slider', key: 'size', label: 'Size', min: 4, max: 300, step: 1, scope: 'brush' },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 1, max: 100, step: 1, scope: 'brush', pct: true },
    { type: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 100, step: 1, scope: 'brush', pct: true },
  ],
  src: null,
  onDown(app, p, e) {
    if (e.altKey) { this.src = { x: p.x, y: p.y }; app.toast('CLONE SOURCE SET'); return; }
    if (!this.src) { app.toast('ALT-CLICK TO SET CLONE SOURCE', true); return; }
    const layer = paintableLayer(app);
    if (!layer) return;
    this.layer = layer;
    this.snap = copyCanvas(layer.canvas);
    this.stroke = new Stroke(app.doc, layer, strokeSettings(app, { spacing: .25 }));
    this.offset = { dx: this.src.x - p.x, dy: this.src.y - p.y };
    // override dab: masked copy from snapshot
    const tool = this;
    this.stroke.dab = function (x, y) {
      const s = this.s;
      const size = Math.max(2, s.size);
      const tip = renderTip('round', size, s.hardness);
      const tmp = makeCanvas(size, size);
      const tctx = tmp.getContext('2d');
      tctx.drawImage(tip, 0, 0);
      tctx.globalCompositeOperation = 'source-in';
      tctx.drawImage(tool.snap, x + tool.offset.dx - size / 2, y + tool.offset.dy - size / 2, size, size, 0, 0, size, size);
      this.ctx.drawImage(tmp, x - size / 2, y - size / 2);
    };
    this.stroke.moveTo(p.x, p.y, p.pressure);
    app.requestRender();
  },
  onMove(app, p) {
    if (!this.stroke) return;
    this.stroke.moveTo(p.x, p.y, p.pressure);
    app.requestRender();
  },
  onUp(app) {
    if (!this.stroke) return;
    this.stroke.commit('Clone stamp');
    this.stroke = null; this.snap = null;
    app.requestRender();
  },
  previewStroke() { return this.stroke; },
  drawOverlay(app, ctx) {
    if (this.src) {
      const [sx, sy] = app.docToScreen(this.src.x, this.src.y);
      ctx.save();
      ctx.strokeStyle = '#ff2233'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 6, sy); ctx.lineTo(sx + 6, sy);
      ctx.moveTo(sx, sy - 6); ctx.lineTo(sx, sy + 6);
      ctx.stroke();
      ctx.restore();
    }
  },
});

/* ---------------- smudge ---------------- */
T({
  id: 'smudge', name: 'SMUDGE', key: 'u', icon: 'smudge',
  hint: 'drag to smear pixels',
  options: [
    { type: 'slider', key: 'size', label: 'Size', min: 4, max: 200, step: 1, scope: 'brush' },
    { type: 'slider', key: 'strength', label: 'Strength', min: 1, max: 100, step: 1, scope: 'tool', def: 60 },
  ],
  state: { strength: 60 },
  onDown(app, p) {
    const layer = paintableLayer(app);
    if (!layer) return;
    this.layer = layer;
    this.before = copyCanvas(layer.canvas);
    this.last = p;
    this.sample = null;
    this.grab(app, p);
  },
  grab(app, p) {
    const size = Math.max(4, Math.round(app.brush.size));
    const tip = renderTip('round', size, .5);
    const tmp = makeCanvas(size, size);
    const tctx = tmp.getContext('2d');
    tctx.drawImage(tip, 0, 0);
    tctx.globalCompositeOperation = 'source-in';
    tctx.drawImage(this.layer.canvas, p.x - size / 2, p.y - size / 2, size, size, 0, 0, size, size);
    this.sample = tmp;
  },
  onMove(app, p) {
    if (!this.before || !this.sample) return;
    const size = this.sample.width;
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(1, size * .12);
    if (dist < step) return;
    const strength = this.state.strength / 100;
    const n = Math.floor(dist / step);
    for (let i = 1; i <= n; i++) {
      const x = this.last.x + dx * i / n, y = this.last.y + dy * i / n;
      this.layer.ctx.globalAlpha = strength;
      this.layer.ctx.drawImage(this.sample, x - size / 2, y - size / 2);
      this.layer.ctx.globalAlpha = 1;
      this.grab(app, { x, y });
    }
    this.last = p;
    app.doc.changed();
  },
  onUp(app) {
    if (!this.before) return;
    const layer = this.layer, before = this.before;
    this.before = null; this.sample = null;
    const now = copyCanvas(layer.canvas);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.drawImage(before, 0, 0);
    app.doc.withLayerSnapshot('Smudge', layer, () => {
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      layer.ctx.drawImage(now, 0, 0);
    });
  },
});

/* ---------------- fill / bucket ---------------- */
T({
  id: 'fill', name: 'FILL', key: 'g', icon: 'fill',
  hint: 'click to flood-fill with foreground color',
  options: [
    { type: 'slider', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1, scope: 'tool', def: 32 },
    { type: 'check', key: 'contiguous', label: 'CONTIGUOUS', scope: 'tool', def: true },
  ],
  state: { tolerance: 32, contiguous: true },
  onDown(app, p) {
    const layer = paintableLayer(app);
    if (!layer) return;
    const D = app.doc;
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= D.width || y0 >= D.height) return;
    const w = D.width, h = D.height;
    const img = layer.ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const i0 = (y0 * w + x0) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
    const tol = this.state.tolerance;
    const { r: fr, g: fg, b: fb } = hexToRgb(app.color.fg);
    const match = (i) => {
      const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb, da = d[i + 3] - ta;
      return Math.sqrt((dr * dr + dg * dg + db * db + da * da) / 4) <= tol;
    };
    let selData = null;
    if (D.selection) {
      selData = D.selection.mctx.getImageData(0, 0, w, h).data;
      if (selData[i0 + 3] < 8) { app.toast('CLICK INSIDE SELECTION', true); return; }
    }
    const inSel = (i) => !selData || selData[i + 3] > 8;
    D.withLayerSnapshot('Fill', layer, () => {
      if (this.state.contiguous) {
        const seen = new Uint8Array(w * h);
        const stack = [y0 * w + x0];
        seen[y0 * w + x0] = 1;
        while (stack.length) {
          const pos = stack.pop();
          const i = pos * 4;
          d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
          const px = pos % w, py = (pos / w) | 0;
          const neigh = [];
          if (px > 0) neigh.push(pos - 1);
          if (px < w - 1) neigh.push(pos + 1);
          if (py > 0) neigh.push(pos - w);
          if (py < h - 1) neigh.push(pos + w);
          for (const nb of neigh) {
            if (!seen[nb] && inSel(nb * 4) && match(nb * 4)) { seen[nb] = 1; stack.push(nb); }
          }
        }
      } else {
        for (let i = 0; i < w * h; i++) {
          const ii = i * 4;
          if (inSel(ii) && match(ii)) { d[ii] = fr; d[ii + 1] = fg; d[ii + 2] = fb; d[ii + 3] = 255; }
        }
      }
      layer.ctx.putImageData(img, 0, 0);
    });
    app.requestRender();
  },
});

/* ---------------- gradient ---------------- */
T({
  id: 'gradient', name: 'GRADIENT', key: 'g', keyCycle: 'fill', icon: 'gradient',
  hint: 'drag to draw gradient (fg → bg)',
  options: [
    { type: 'seg', key: 'kind', label: 'Type', values: [['linear', 'LINEAR'], ['radial', 'RADIAL']], scope: 'tool', def: 'linear' },
    { type: 'seg', key: 'blendTo', label: 'To', values: [['bg', 'BG COLOR'], ['alpha', 'TRANSPARENT']], scope: 'tool', def: 'bg' },
  ],
  state: { kind: 'linear', blendTo: 'bg' },
  onDown(app, p) {
    if (!paintableLayer(app)) return;
    this.a = p; this.b = p;
  },
  onMove(app, p) { if (this.a) { this.b = p; app.requestRender(); } },
  onUp(app) {
    if (!this.a) return;
    const { a, b } = this;
    this.a = null;
    const layer = app.doc.activeLayer;
    const D = app.doc;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) { app.requestRender(); return; }
    D.withLayerSnapshot('Gradient', layer, () => {
      const ctx = layer.ctx;
      let g;
      if (this.state.kind === 'radial') {
        g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y));
      } else {
        g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      }
      const fg = app.color.fg;
      const { r, g: gg, b: bb } = hexToRgb(fg);
      g.addColorStop(0, fg);
      g.addColorStop(1, this.state.blendTo === 'alpha' ? `rgba(${r},${gg},${bb},0)` : app.color.bg);
      const tmp = makeCanvas(D.width, D.height);
      const tctx = tmp.getContext('2d');
      tctx.fillStyle = g;
      tctx.fillRect(0, 0, D.width, D.height);
      if (D.selection) D.selection.maskCanvas(tmp);
      ctx.drawImage(tmp, 0, 0);
    });
    app.requestRender();
  },
  drawOverlay(app, ctx) {
    if (!this.a) return;
    const [x1, y1] = app.docToScreen(this.a.x, this.a.y);
    const [x2, y2] = app.docToScreen(this.b.x, this.b.y);
    ctx.save();
    ctx.strokeStyle = '#ff2233'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.restore();
  },
});

/* ---------------- shapes ---------------- */
T({
  id: 'shape', name: 'SHAPE', key: 'p', icon: 'shape',
  hint: 'drag to draw · Shift constrains · fills with FG, strokes with BG',
  options: [
    { type: 'select', key: 'kind', label: 'Shape', values: [['rect', 'RECTANGLE'], ['ellipse', 'ELLIPSE'], ['line', 'LINE'], ['star', 'STAR'], ['poly', 'POLYGON']], scope: 'tool', def: 'rect' },
    { type: 'check', key: 'fill', label: 'FILL', scope: 'tool', def: true },
    { type: 'check', key: 'stroke', label: 'STROKE', scope: 'tool', def: false },
    { type: 'slider', key: 'strokeW', label: 'Stroke W', min: 1, max: 60, step: 1, scope: 'tool', def: 4 },
    { type: 'slider', key: 'sides', label: 'Points', min: 3, max: 12, step: 1, scope: 'tool', def: 5 },
  ],
  state: { kind: 'rect', fill: true, stroke: false, strokeW: 4, sides: 5 },
  onDown(app, p) { if (paintableLayer(app)) { this.a = p; this.b = p; } },
  onMove(app, p, e) {
    if (!this.a) return;
    if (e.shiftKey && this.state.kind !== 'line') {
      const dx = p.x - this.a.x, dy = p.y - this.a.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      this.b = { x: this.a.x + Math.sign(dx || 1) * m, y: this.a.y + Math.sign(dy || 1) * m };
    } else this.b = p;
    app.requestRender();
  },
  path(ctx, a, b) {
    const st = this.state;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.beginPath();
    if (st.kind === 'rect') ctx.rect(x, y, w, h);
    else if (st.kind === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (st.kind === 'line') { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    else {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const R = Math.max(w, h) / 2;
      const n = st.sides;
      if (st.kind === 'star') {
        for (let i = 0; i < n * 2; i++) {
          const r = i % 2 ? R * .45 : R;
          const ang = -Math.PI / 2 + i * Math.PI / n;
          const px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const ang = -Math.PI / 2 + i * 2 * Math.PI / n;
          const px = cx + Math.cos(ang) * R, py = cy + Math.sin(ang) * R;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
      }
      ctx.closePath();
    }
  },
  onUp(app) {
    if (!this.a) return;
    const { a, b } = this;
    this.a = null;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) { app.requestRender(); return; }
    const D = app.doc, layer = D.activeLayer;
    const st = this.state;
    D.withLayerSnapshot('Shape', layer, () => {
      const tmp = makeCanvas(D.width, D.height);
      const tctx = tmp.getContext('2d');
      this.path(tctx, a, b);
      if (st.fill && st.kind !== 'line') { tctx.fillStyle = app.color.fg; tctx.fill(); }
      if (st.stroke || st.kind === 'line') {
        tctx.strokeStyle = st.kind === 'line' ? app.color.fg : app.color.bg;
        tctx.lineWidth = st.strokeW;
        tctx.stroke();
      }
      if (D.selection) D.selection.maskCanvas(tmp);
      layer.ctx.drawImage(tmp, 0, 0);
    });
    app.requestRender();
  },
  drawOverlay(app, ctx) {
    if (!this.a) return;
    ctx.save();
    ctx.strokeStyle = '#ff2233'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    const sa = app.docToScreen(this.a.x, this.a.y), sb = app.docToScreen(this.b.x, this.b.y);
    this.path(ctx, { x: sa[0], y: sa[1] }, { x: sb[0], y: sb[1] });
    ctx.stroke();
    ctx.restore();
  },
});

/* ---------------- stamp ---------------- */
T({
  id: 'stamp', name: 'STAMP', key: 'k', icon: 'stamp',
  hint: 'click to place stamp · drag to size it · pick design in options',
  options: [
    { type: 'stamp-picker', key: 'stampId', scope: 'tool', def: 'skull' },
    { type: 'slider', key: 'size', label: 'Size', min: 16, max: 800, step: 1, scope: 'tool', def: 160 },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 1, max: 100, step: 1, scope: 'tool', pct: true, def: 100 },
  ],
  state: { stampId: 'skull', size: 160, opacity: 100 },
  onDown(app, p) { if (paintableLayer(app)) { this.a = p; this.drag = 0; } },
  onMove(app, p) {
    if (!this.a) return;
    this.drag = Math.hypot(p.x - this.a.x, p.y - this.a.y) * 2;
    app.requestRender();
  },
  onUp(app, p) {
    if (!this.a) return;
    const center = this.a;
    const size = this.drag > 8 ? this.drag : this.state.size;
    this.a = null;
    const D = app.doc, layer = D.activeLayer;
    D.withLayerSnapshot('Stamp', layer, () => {
      const img = renderStamp(this.state.stampId, Math.round(size), app.color.fg);
      const tmp = makeCanvas(D.width, D.height);
      const tctx = tmp.getContext('2d');
      tctx.globalAlpha = this.state.opacity / 100;
      tctx.drawImage(img, center.x - size / 2, center.y - size / 2);
      if (D.selection) D.selection.maskCanvas(tmp);
      layer.ctx.drawImage(tmp, 0, 0);
    });
    app.requestRender();
  },
  drawOverlay(app, ctx) {
    if (!this.a) return;
    const size = (this.drag > 8 ? this.drag : this.state.size) * app.view.zoom;
    const [sx, sy] = app.docToScreen(this.a.x, this.a.y);
    ctx.save();
    ctx.globalAlpha = .5;
    ctx.drawImage(renderStamp(this.state.stampId, Math.max(8, Math.round(size)), '#ff2233'), sx - size / 2, sy - size / 2, size, size);
    ctx.restore();
  },
});

/* ---------------- text ---------------- */
T({
  id: 'text', name: 'TEXT', key: 't', icon: 'text',
  hint: 'click to place text · edit in overlay · Esc commits',
  options: [
    { type: 'font-picker', key: 'family', scope: 'text' },
    { type: 'slider', key: 'size', label: 'Size', min: 8, max: 400, step: 1, scope: 'text' },
    { type: 'seg', key: 'weight', label: 'Weight', values: [['400', 'REG'], ['700', 'BOLD']], scope: 'text' },
    { type: 'check', key: 'italic', label: 'ITALIC', scope: 'text' },
    { type: 'seg', key: 'align', label: 'Align', values: [['left', 'L'], ['center', 'C'], ['right', 'R']], scope: 'text' },
    { type: 'slider', key: 'letterSpacing', label: 'Tracking', min: -10, max: 60, step: 1, scope: 'text' },
  ],
  onDown(app, p, e) {
    // if clicking an existing text layer near its anchor, edit it
    const D = app.doc;
    const hit = D.layers.findIndex(l => l.type === 'text' && l.visible &&
      Math.abs(p.y - (l.t.y - l.t.size / 2)) < l.t.size * 1.5 * (String(l.t.text).split('\n').length) &&
      Math.abs(p.x - l.t.x) < D.width);
    if (hit >= 0 && D.layers[hit].ctx.getImageData(Math.floor(clamp(p.x, 0, D.width - 1)), Math.floor(clamp(p.y, 0, D.height - 1)), 1, 1).data[3] > 0) {
      D.activeIndex = hit;
      app.editTextLayer(D.layers[hit]);
      return;
    }
    app.startTextEntry(p);
  },
});

/* ---------------- hand ---------------- */
T({
  id: 'hand', name: 'HAND', key: 'h', icon: 'hand',
  hint: 'drag to pan · Space works from any tool',
  options: [],
  onDown(app, p, e) { this.s = { x: e.clientX, y: e.clientY, px: app.view.panX, py: app.view.panY }; },
  onMove(app, p, e) {
    if (!this.s) return;
    app.view.panX = this.s.px + (e.clientX - this.s.x);
    app.view.panY = this.s.py + (e.clientY - this.s.y);
    app.requestRender();
  },
  onUp() { this.s = null; },
});

/* ---------------- zoom ---------------- */
T({
  id: 'zoom', name: 'ZOOM', key: 'z', icon: 'zoom',
  hint: 'click zoom in · Alt-click zoom out · Ctrl+0 fit',
  options: [
    { type: 'button', label: 'FIT', action: 'fit', scope: 'tool' },
    { type: 'button', label: '100%', action: 'hundred', scope: 'tool' },
  ],
  onDown(app, p, e) {
    const factor = e.altKey ? 1 / 1.5 : 1.5;
    app.zoomAt(p.x, p.y, factor);
  },
  doAction(app, action) {
    if (action === 'fit') app.fitView();
    if (action === 'hundred') app.setZoom(1);
  },
});

/* ---------------- transform (pseudo-tool, entered via Ctrl+T) ---------------- */
export const transformTool = {
  id: 'transform', name: 'TRANSFORM', icon: 'move', internal: true,
  hint: 'drag corners to scale · ring to rotate · inside to move · Enter apply · Esc cancel',
  options: [
    { type: 'button', label: '✓ APPLY', action: 'apply', scope: 'tool' },
    { type: 'button', label: '✗ CANCEL', action: 'cancel', scope: 'tool' },
  ],
  begin(app) {
    const D = app.doc;
    let layer = D.activeLayer;
    if (!layer) return false;
    if (layer.locked) { app.toast('LAYER IS LOCKED', true); return false; }
    if (layer.type === 'text') { D.rasterizeLayer(); layer = D.activeLayer; app.toast('TEXT RASTERIZED FOR TRANSFORM'); }
    // find content bounds
    const w = layer.canvas.width, h = layer.canvas.height;
    const d = layer.ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) { app.toast('LAYER IS EMPTY', true); return false; }
    this.layer = layer;
    this.snap = copyCanvas(layer.canvas);
    this.box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    this.tx = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
    this.mode = null;
    return true;
  },
  center() { return { x: this.box.x + this.box.w / 2 + this.tx.dx, y: this.box.y + this.box.h / 2 + this.tx.dy }; },
  corners() {
    const c = this.center();
    const { sx, sy, rot } = this.tx;
    const hw = this.box.w / 2 * sx, hh = this.box.h / 2 * sy;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) =>
      ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos }));
  },
  applyPreview(app) {
    const l = this.layer, c = this.center();
    l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    l.ctx.save();
    l.ctx.translate(c.x, c.y);
    l.ctx.rotate(this.tx.rot);
    l.ctx.scale(this.tx.sx, this.tx.sy);
    l.ctx.drawImage(this.snap,
      this.box.x, this.box.y, this.box.w, this.box.h,
      -this.box.w / 2, -this.box.h / 2, this.box.w, this.box.h);
    l.ctx.restore();
    app.doc.changed();
  },
  onDown(app, p, e) {
    const corners = this.corners().map(pt => app.docToScreen(pt.x, pt.y));
    const sp = [p.sx, p.sy];
    const near = (a, r) => Math.hypot(a[0] - sp[0], a[1] - sp[1]) < r;
    this.grabIdx = corners.findIndex(cn => near(cn, 10));
    const c = this.center();
    const sc = app.docToScreen(c.x, c.y);
    const distC = Math.hypot(sp[0] - sc[0], sp[1] - sc[1]);
    const maxCorner = Math.max(...corners.map(cn => Math.hypot(cn[0] - sc[0], cn[1] - sc[1])));
    if (this.grabIdx >= 0) this.mode = 'scale';
    else if (distC > maxCorner + 6 && distC < maxCorner + 46) this.mode = 'rotate';
    else this.mode = 'move';
    this.startP = p;
    this.startTx = { ...this.tx };
    this.startAngle = Math.atan2(p.y - c.y, p.x - c.x);
  },
  onMove(app, p, e) {
    if (!this.mode) return;
    const st = this.startTx;
    if (this.mode === 'move') {
      this.tx.dx = st.dx + (p.x - this.startP.x);
      this.tx.dy = st.dy + (p.y - this.startP.y);
    } else if (this.mode === 'rotate') {
      const c = this.center();
      const a = Math.atan2(p.y - c.y, p.x - c.x);
      this.tx.rot = st.rot + (a - this.startAngle);
      if (e.shiftKey) this.tx.rot = Math.round(this.tx.rot / (Math.PI / 12)) * (Math.PI / 12);
    } else if (this.mode === 'scale') {
      const c = { x: this.box.x + this.box.w / 2 + st.dx, y: this.box.y + this.box.h / 2 + st.dy };
      const cos = Math.cos(-st.rot), sin = Math.sin(-st.rot);
      const un = (q) => ({ x: (q.x - c.x) * cos - (q.y - c.y) * sin, y: (q.x - c.x) * sin + (q.y - c.y) * cos });
      const p0 = un(this.startP), p1 = un(p);
      let fx = p0.x !== 0 ? p1.x / p0.x : 1;
      let fy = p0.y !== 0 ? p1.y / p0.y : 1;
      if (e.shiftKey) { const f = Math.max(Math.abs(fx), Math.abs(fy)); fx = Math.sign(fx || 1) * f; fy = Math.sign(fy || 1) * f; }
      this.tx.sx = clamp(st.sx * fx, -20, 20);
      this.tx.sy = clamp(st.sy * fy, -20, 20);
    }
    this.applyPreview(app);
  },
  onUp() { this.mode = null; },
  onKey(app, e) {
    if (e.key === 'Enter') { this.doAction(app, 'apply'); return true; }
    if (e.key === 'Escape') { this.doAction(app, 'cancel'); return true; }
    return false;
  },
  doAction(app, action) {
    const l = this.layer, snap = this.snap;
    if (action === 'cancel') {
      l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
      l.ctx.drawImage(snap, 0, 0);
      app.doc.changed();
    } else {
      const now = copyCanvas(l.canvas);
      l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
      l.ctx.drawImage(snap, 0, 0);
      app.doc.withLayerSnapshot('Transform', l, () => {
        l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
        l.ctx.drawImage(now, 0, 0);
      });
    }
    this.layer = null; this.snap = null;
    app.exitTransform();
  },
  drawOverlay(app, ctx) {
    if (!this.layer) return;
    const pts = this.corners().map(pt => app.docToScreen(pt.x, pt.y));
    ctx.save();
    ctx.strokeStyle = '#ff2233'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#050505';
    for (const [x, y] of pts) {
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
    ctx.restore();
  },
};

export const toolById = (id) => id === 'transform' ? transformTool : TOOLS.find(t => t.id === id);
