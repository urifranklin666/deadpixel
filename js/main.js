/* DEADPIXEL main — app state, viewport, input, boot. */

import { Doc, Layer, TextLayer, clamp, makeCanvas } from './engine.js';
import { TOOLS, toolById, transformTool } from './tools.js';
import * as UI from './ui.js';
import { openDpx, loadImageFile, docFromImage, autosave, loadAutosave, clearAutosave, docFromFiles } from './io.js';
import { processSignalStack } from './filters.js';

const $ = (s) => document.querySelector(s);

class App {
  constructor() {
    this.doc = null;
    this.tool = null;
    this.prevToolId = 'brush';
    this.color = { fg: '#ff2233', bg: '#050505' };
    this.brush = { preset: 'soft-round', size: 24, opacity: 100, flow: 100, hardness: 60, pressureSize: true };
    this.text = { family: 'VT323', size: 64, weight: '400', italic: false, align: 'left', letterSpacing: 0, lineHeight: 1.2 };
    this.fonts = [
      { family: 'Big Shoulders', category: 'ui' },
      { family: 'VT323', category: 'ui' },
      { family: 'Arial', category: 'system' }, { family: 'Georgia', category: 'system' },
      { family: 'Times New Roman', category: 'system' }, { family: 'Courier New', category: 'system' },
      { family: 'Impact', category: 'system' },
    ];
    this.view = { zoom: 1, panX: 0, panY: 0 };
    this.pointer = null;
    this.pointerInView = false;
    this.spaceDown = false;
    this.transforming = false;
    this.recording = null;
    this.lastFilter = null;
    this.installPrompt = null;
    this._renderQueued = false;
    this._antsPhase = 0;

    this.viewCanvas = $('#view');
    this.viewCtx = this.viewCanvas.getContext('2d');
    this.viewport = $('#viewport');
    this.cmd = UI.buildCommands(this);
  }

  toast(msg, err) { UI.toast(msg, err); }

  /* ------------------------------ doc ------------------------------ */
  attachDoc(doc) {
    this.doc = doc;
    doc.effectProcessor = processSignalStack;
    doc.addEventListener('change', (e) => {
      this.requestRender();
      this.refreshTitle();
      this._layersDirty = true;
    });
    doc.history.addEventListener('change', () => {
      this.refreshHistory?.();
      this._layersDirty = true;
      this.requestRender();
    });
    this.refreshTitle();
    this.refreshLayers?.();
    this.refreshHistory?.();
    this.refreshActions?.();
    this.fitView();
    document.querySelector('#launch-bay')?.classList.add('gone');
    document.body.classList.add('has-doc');
  }
  newDoc(w, h, opts) {
    const doc = new Doc(w, h, opts);
    this.attachDoc(doc);
    this.toast('NEW TRANSMISSION ' + w + '×' + h);
  }
  openSample(kind) {
    const W = 1280, H = 800;
    this.newDoc(W, H, { name: kind.toUpperCase(), bg: '#050505' });
    const l = this.doc.activeLayer, c = l.ctx;
    c.fillStyle = '#050505'; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255,34,51,.18)'; c.lineWidth = 1;
    for (let x = 0; x < W; x += 48) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y < H; y += 48) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    c.font = '900 190px "Big Shoulders"'; c.textBaseline = 'top';
    if (kind === 'xerox') {
      c.fillStyle = '#d8d2d3'; c.fillRect(70, 70, W - 140, H - 140);
      c.fillStyle = '#050505'; c.fillText('COPY', 105, 92); c.fillText('OF A', 105, 260); c.fillText('GHOST', 105, 428);
      c.fillStyle = '#ff2233'; c.fillRect(850, 70, 18, H - 140);
    } else if (kind === 'signal') {
      c.fillStyle = '#ff2233'; c.fillRect(0, 510, W, 130);
      c.fillStyle = '#d8d2d3'; c.fillText('NO', 85, 100); c.fillText('SIGNAL', 85, 270);
      c.fillStyle = '#050505'; c.font = '32px VT323'; c.fillText('TRANSMISSION CORRUPTED / CH.404', 90, 550);
    } else {
      c.fillStyle = '#d8d2d3'; c.fillText('AFTER', 75, 100); c.fillStyle = '#ff2233'; c.fillText('MIDNIGHT', 75, 280);
      c.strokeStyle = '#ff2233'; c.lineWidth = 8; c.strokeRect(75, 500, 880, 130);
      c.font = '28px VT323'; c.fillStyle = '#d8d2d3'; c.fillText('UNLICENSED TRANSMISSION / KEEP WATCHING', 105, 545);
    }
    l.name = 'CONTAMINATED SAMPLE';
    this.doc.changed(); this.doc.dirty = false; this.refreshTitle(); this.requestRender();
  }
  refreshTitle() {
    const t = $('#doc-title');
    if (!this.doc) { t.textContent = 'NO SIGNAL'; return; }
    t.textContent = this.doc.name + '.DPX';
    t.classList.toggle('dirty', this.doc.dirty);
  }

  /* ------------------------------ view ------------------------------ */
  resizeView() {
    const r = this.viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.viewCanvas.width = Math.round(r.width * dpr);
    this.viewCanvas.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    this.requestRender();
  }
  docToScreen(x, y) {
    return [x * this.view.zoom + this.view.panX, y * this.view.zoom + this.view.panY];
  }
  screenToDoc(sx, sy) {
    return [(sx - this.view.panX) / this.view.zoom, (sy - this.view.panY) / this.view.zoom];
  }
  fitView() {
    if (!this.doc) return;
    const r = this.viewport.getBoundingClientRect();
    const pad = 40;
    const z = Math.min((r.width - pad) / this.doc.width, (r.height - pad) / this.doc.height, 4);
    this.view.zoom = Math.max(.02, z);
    this.view.panX = (r.width - this.doc.width * this.view.zoom) / 2;
    this.view.panY = (r.height - this.doc.height * this.view.zoom) / 2;
    this.requestRender();
  }
  setZoom(z, cx = null, cy = null) {
    const r = this.viewport.getBoundingClientRect();
    if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
    const [dx, dy] = this.screenToDoc(cx, cy);
    this.view.zoom = clamp(z, .02, 32);
    this.view.panX = cx - dx * this.view.zoom;
    this.view.panY = cy - dy * this.view.zoom;
    this.requestRender();
  }
  zoomAt(docX, docY, factor) {
    if (docX == null) { this.setZoom(this.view.zoom * factor); return; }
    const [sx, sy] = this.docToScreen(docX, docY);
    this.setZoom(this.view.zoom * factor, sx, sy);
  }

  requestRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => { this._renderQueued = false; this.render(); });
  }
  render() {
    const ctx = this.viewCtx;
    const { width: W, height: H } = this.viewCanvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.scale(this.dpr, this.dpr);
    if (!this.doc) return;
    const D = this.doc;
    const { zoom, panX, panY } = this.view;

    // canvas shadow + checker
    const [x0, y0] = this.docToScreen(0, 0);
    const w = D.width * zoom, h = D.height * zoom;
    ctx.save();
    ctx.shadowColor = 'rgba(255,34,51,.18)';
    ctx.shadowBlur = 40;
    ctx.fillStyle = '#0a0708';
    ctx.fillRect(x0, y0, w, h);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    const cs = 8;
    ctx.fillStyle = '#141011';
    ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = '#1d1718';
    const startX = Math.floor(-x0 / cs) * cs;
    for (let yy = 0; yy < h + cs; yy += cs) {
      for (let xx = ((yy / cs) % 2) * cs; xx < w + cs; xx += cs * 2) {
        ctx.fillRect(x0 + xx, y0 + yy, cs, cs);
      }
    }
    // document composite
    ctx.imageSmoothingEnabled = zoom < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);
    ctx.drawImage(D.compose(), 0, 0);
    // live stroke preview
    const stroke = this.tool?.previewStroke?.();
    if (stroke && stroke.layer === D.activeLayer) {
      // stroke draws on top approximating layer position (correct for top layer & normal mode; acceptable preview)
      stroke.preview(ctx);
    }
    ctx.restore();

    // border
    ctx.strokeStyle = 'rgba(255,34,51,.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 - .5, y0 - .5, w + 1, h + 1);

    // marching ants
    if (D.selection && !D.selection.isEmpty) {
      ctx.save();
      ctx.lineWidth = 1;
      for (const pass of [['#000', 0], ['#fff', 4]]) {
        ctx.strokeStyle = pass[0];
        ctx.setLineDash([4, 4]);
        ctx.lineDashOffset = -this._antsPhase + pass[1];
        for (const poly of D.selection.outline) {
          ctx.beginPath();
          for (let i = 0; i < poly.length; i++) {
            const [px, py] = this.docToScreen(poly[i][0], poly[i][1]);
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
      if (!this._antsTimer) {
        this._antsTimer = setInterval(() => {
          this._antsPhase = (this._antsPhase + 1) % 8;
          this.requestRender();
        }, 120);
      }
    } else if (this._antsTimer) {
      clearInterval(this._antsTimer);
      this._antsTimer = null;
    }

    // tool overlay (screen space)
    if (this.transforming) transformTool.drawOverlay(this, ctx);
    else this.tool?.drawOverlay?.(this, ctx);

    // status bar
    $('#st-zoom').textContent = Math.round(zoom * 100) + '%';
    $('#st-size').textContent = D.width + '×' + D.height;

    // layers panel refresh (throttled)
    if (this._layersDirty && !this._layersTimer) {
      this._layersTimer = setTimeout(() => {
        this._layersTimer = null;
        this._layersDirty = false;
        this.refreshLayers?.();
      }, 120);
    }
  }

  /* ------------------------------ tools ------------------------------ */
  setTool(id) {
    if (this.transforming) return;
    const t = toolById(id);
    if (!t || t === this.tool) return;
    this.tool?.onDeactivate?.(this);
    if (this.tool) this.prevToolId = this.tool.id;
    this.tool = t;
    document.body.dataset.tool = id;
    t.onActivate?.(this);
    UI.reflectTool(this);
    UI.buildOptionsBar(this);
    this.requestRender();
  }
  enterTransform() {
    if (!this.doc || this.transforming) return;
    if (transformTool.begin(this)) {
      this.transforming = true;
      this._toolBeforeTransform = this.tool;
      this.tool = transformTool;
      UI.reflectTool(this);
      UI.buildOptionsBar(this);
      this.requestRender();
    }
  }
  exitTransform() {
    this.transforming = false;
    this.tool = this._toolBeforeTransform || toolById('move');
    UI.reflectTool(this);
    UI.buildOptionsBar(this);
    this.requestRender();
  }

  /* ------------------------------ color ------------------------------ */
  setColor(which, hex, fromPicker = false) {
    this.color[which] = hex;
    if (!fromPicker || which === 'bg') this.onColorChanged?.();
    else {
      $('#hex-in').value = hex;
      this._fgSw.style.background = hex;
    }
    this.requestRender();
  }
  swapColors() {
    [this.color.fg, this.color.bg] = [this.color.bg, this.color.fg];
    this.onColorChanged?.();
  }

  /* ------------------------------ filters bookkeeping ------------------------------ */
  noteFilter(filterId, params) {
    this.lastFilter = { filterId, params: { ...params } };
    if (this.recording) this.recording.push({ filter: filterId, params: { ...params } });
  }
  repeatLastFilter() {
    if (!this.lastFilter || !this.doc) { this.toast('NO FILTER TO REPEAT', true); return; }
    const l = this.doc.activeLayer;
    if (!l || l.type === 'text' || l.locked) { this.toast('CANNOT FILTER THIS LAYER', true); return; }
    import('./filters.js').then(({ applyFilterToLayer, filterById }) => {
      const f = filterById(this.lastFilter.filterId);
      this.doc.withLayerSnapshot(f.name, l, () =>
        applyFilterToLayer(this.doc, l, this.lastFilter.filterId, this.lastFilter.params));
      this.noteFilter(this.lastFilter.filterId, this.lastFilter.params);
      this.requestRender();
    });
  }
  fillActive() {
    const D = this.doc;
    const l = D?.activeLayer;
    if (!l || l.type === 'text' || l.locked) { this.toast('CANNOT FILL THIS LAYER', true); return; }
    D.withLayerSnapshot('Fill foreground', l, () => {
      const tmp = makeCanvas(D.width, D.height);
      const tctx = tmp.getContext('2d');
      tctx.fillStyle = this.color.fg;
      tctx.fillRect(0, 0, D.width, D.height);
      if (D.selection) D.selection.maskCanvas(tmp);
      l.ctx.drawImage(tmp, 0, 0);
    });
    this.requestRender();
  }
  clearActive() {
    const D = this.doc;
    const l = D?.activeLayer;
    if (!l || l.type === 'text' || l.locked) { this.toast('CANNOT CLEAR THIS LAYER', true); return; }
    D.withLayerSnapshot('Clear', l, () => {
      if (D.selection) {
        const tmp = makeCanvas(D.width, D.height);
        const tctx = tmp.getContext('2d');
        tctx.drawImage(D.selection.mask, 0, 0);
        l.ctx.save();
        l.ctx.globalCompositeOperation = 'destination-out';
        l.ctx.drawImage(tmp, 0, 0);
        l.ctx.restore();
      } else {
        l.ctx.clearRect(0, 0, D.width, D.height);
      }
    });
    this.requestRender();
  }

  /* ------------------------------ fonts ------------------------------ */
  async loadFontList() {
    try {
      const res = await fetch('fonts/pack/fonts.json');
      const pack = await res.json();
      const packed = pack.map(f => ({ family: f.family, category: f.category }));
      this.fonts = [...packed, ...this.fonts];
    } catch (e) { /* pack optional */ }
  }
  async ensureFont(family) {
    try {
      await document.fonts.load(`400 32px "${family}"`);
      await document.fonts.load(`700 32px "${family}"`);
    } catch (e) { /* system font */ }
    // re-render text layers using it
    if (this.doc) {
      let touched = false;
      for (const l of this.doc.layers) {
        if (l.type === 'text' && l.t.family === family) { l.render(); touched = true; }
      }
      if (touched) this.doc.changed();
    }
  }

  /* ------------------------------ text entry ------------------------------ */
  startTextEntry(p, existing = null) {
    if (this._textEditor) this.commitTextEntry();
    const D = this.doc;
    const overlay = $('#edit-overlay');
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.spellcheck = false;
    const t = existing ? existing.t : {
      x: Math.round(p.x), y: Math.round(p.y),
      family: this.text.family, size: this.text.size,
      weight: parseInt(this.text.weight), italic: this.text.italic,
      align: this.text.align, letterSpacing: this.text.letterSpacing,
      lineHeight: this.text.lineHeight, color: this.color.fg,
      text: '',
    };
    ta.value = existing ? existing.t.text : '';
    const place = () => {
      const z = this.view.zoom;
      const [sx, sy] = this.docToScreen(t.x, t.y - t.size);
      ta.style.left = sx + 'px';
      ta.style.top = sy + 'px';
      ta.style.font = `${t.italic ? 'italic ' : ''}${t.weight} ${t.size * z}px "${t.family}"`;
      ta.style.color = t.color;
      ta.style.letterSpacing = (t.letterSpacing * z) + 'px';
      ta.style.lineHeight = t.lineHeight;
      ta.style.textAlign = t.align;
      // autosize
      ta.style.width = 'auto'; ta.style.height = 'auto';
      ta.style.width = Math.max(60, ta.scrollWidth + 20) + 'px';
      ta.style.height = Math.max(t.size * z * 1.3, ta.scrollHeight) + 'px';
    };
    ta.addEventListener('input', place);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.commitTextEntry();
    });
    overlay.appendChild(ta);
    this._textEditor = { ta, t, existing, place };
    this.onTextOptionChanged = (key) => {
      if (!this._textEditor) return;
      const tt = this._textEditor.t;
      if (key === 'family') tt.family = this.text.family;
      if (key === 'size') tt.size = this.text.size;
      if (key === 'weight') tt.weight = parseInt(this.text.weight);
      if (key === 'italic') tt.italic = this.text.italic;
      if (key === 'align') tt.align = this.text.align;
      if (key === 'letterSpacing') tt.letterSpacing = this.text.letterSpacing;
      this._textEditor.place();
    };
    this.ensureFont(t.family).then(place);
    place();
    setTimeout(() => ta.focus(), 0);
    if (existing) {
      existing.visible = false;
      D.changed();
    }
  }
  commitTextEntry() {
    const ed = this._textEditor;
    if (!ed) return;
    this._textEditor = null;
    const text = ed.ta.value;
    ed.ta.remove();
    const D = this.doc;
    if (ed.existing) {
      const l = ed.existing;
      l.visible = true;
      if (text.trim() && text !== l.t.text) {
        D.withLayerSnapshot('Edit text', l, () => { l.t.text = text; l.render(); });
      } else l.render();
      D.changed();
    } else if (text.trim()) {
      const l = new TextLayer(D.width, D.height, { t: { ...ed.t, text } });
      D.addLayer(l);
      this.toast('TEXT LAYER ADDED — Ctrl+T TO TRANSFORM');
    }
    this.requestRender();
  }
  editTextLayer(layer) {
    // sync options bar to this layer's settings
    this.text.family = layer.t.family;
    this.text.size = layer.t.size;
    this.text.weight = String(layer.t.weight);
    this.text.italic = layer.t.italic;
    this.text.align = layer.t.align;
    this.text.letterSpacing = layer.t.letterSpacing;
    UI.buildOptionsBar(this);
    this.startTextEntry(null, layer);
  }

  /* ------------------------------ file pickers / import ------------------------------ */
  openFilePicker(asLayer) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dpx,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml';
    input.addEventListener('change', () => {
      if (input.files[0]) this.openFile(input.files[0], asLayer);
    });
    input.click();
  }
  async openFile(file, asLayer = false) {
    try {
      if (file.name.toLowerCase().endsWith('.dpx')) {
        const doc = await openDpx(await file.arrayBuffer());
        doc.name = file.name.replace(/\.dpx$/i, '').toUpperCase();
        this.attachDoc(doc);
        this.toast('PROJECT LOADED: ' + doc.name);
        return;
      }
      const img = await loadImageFile(file);
      if (asLayer && this.doc) {
        const D = this.doc;
        const l = new Layer(D.width, D.height, file.name.replace(/\.[^.]+$/, '').slice(0, 24));
        const scale = Math.min(1, D.width / img.naturalWidth, D.height / img.naturalHeight);
        const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
        l.ctx.drawImage(img, (D.width - w) / 2, (D.height - h) / 2, w, h);
        D.addLayer(l);
        this.toast('IMPORTED AS LAYER');
      } else {
        const doc = docFromImage(img, file.name.replace(/\.[^.]+$/, '').toUpperCase());
        this.attachDoc(doc);
        this.toast('IMAGE OPENED ' + doc.width + '×' + doc.height);
      }
    } catch (e) {
      console.error(e);
      this.toast('COULD NOT OPEN FILE', true);
    }
  }

  /* ------------------------------ input wiring ------------------------------ */
  bindInput() {
    const vc = this.viewCanvas;
    let panDrag = null;
    const touchPoints = new Map();
    let pinch = null, gestureActive = false;
    const pinchMetrics = () => {
      const pts = [...touchPoints.values()];
      if (pts.length < 2) return null;
      const a = pts[0], b = pts[1];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    };

    vc.addEventListener('pointerdown', (e) => {
      if (this._textEditor) { this.commitTextEntry(); if (this.tool?.id === 'text') return; }
      try { vc.setPointerCapture(e.pointerId); } catch (_) { /* synthetic/test pointers */ }
      const r = vc.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [x, y] = this.screenToDoc(sx, sy);
      const pt = { x, y, sx, sy, pressure: e.pressure || .5 };
      this.pointer = pt;
      if (e.pointerType === 'touch') {
        touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touchPoints.size === 2) {
          const m = pinchMetrics();
          gestureActive = true;
          pinch = { ...m, zoom: this.view.zoom, panX: this.view.panX, panY: this.view.panY };
          this.tool?.onUp?.(this, pt, e);
          this.viewport.classList.add('panning');
          return;
        }
        if (gestureActive) return;
      }
      if (this.spaceDown || e.button === 1) {
        panDrag = { x: e.clientX, y: e.clientY, px: this.view.panX, py: this.view.panY };
        this.viewport.classList.add('panning');
        return;
      }
      if (e.button === 2) return;
      if (!this.doc) return;
      this.tool?.onDown?.(this, pt, e);
      this.requestRender();
    });
    vc.addEventListener('pointermove', (e) => {
      const r = vc.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [x, y] = this.screenToDoc(sx, sy);
      const pt = { x, y, sx, sy, pressure: e.pressure || .5 };
      this.pointer = pt;
      this.pointerInView = true;
      if (e.pointerType === 'touch' && touchPoints.has(e.pointerId)) {
        touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (gestureActive && pinch) {
          const m = pinchMetrics();
          if (m) {
            const z = clamp(pinch.zoom * (m.d / pinch.d), .02, 32);
            const startDocX = (pinch.x - r.left - pinch.panX) / pinch.zoom;
            const startDocY = (pinch.y - r.top - pinch.panY) / pinch.zoom;
            this.view.zoom = z;
            this.view.panX = (m.x - r.left) - startDocX * z;
            this.view.panY = (m.y - r.top) - startDocY * z;
            this.requestRender();
          }
          return;
        }
      }
      if (panDrag) {
        this.view.panX = panDrag.px + (e.clientX - panDrag.x);
        this.view.panY = panDrag.py + (e.clientY - panDrag.y);
        this.requestRender();
        return;
      }
      if (this.doc) {
        // coalesced events give smoother strokes
        const events = e.getCoalescedEvents?.() || [e];
        for (const ce of events) {
          const csx = ce.clientX - r.left, csy = ce.clientY - r.top;
          const [cx, cy] = this.screenToDoc(csx, csy);
          this.tool?.onMove?.(this, { x: cx, y: cy, sx: csx, sy: csy, pressure: ce.pressure || .5 }, e);
        }
        $('#st-pos').textContent = Math.round(x) + ',' + Math.round(y);
      }
      if (['brush', 'pencil', 'eraser', 'clone', 'smudge'].includes(this.tool?.id)) this.requestRender();
    });
    vc.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        const wasGesture = gestureActive;
        touchPoints.delete(e.pointerId);
        if (touchPoints.size < 2) pinch = null;
        if (!touchPoints.size) { gestureActive = false; this.viewport.classList.remove('panning'); }
        if (wasGesture) return;
      }
      if (panDrag) { panDrag = null; this.viewport.classList.remove('panning'); return; }
      if (!this.doc) return;
      const r = vc.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [x, y] = this.screenToDoc(sx, sy);
      this.tool?.onUp?.(this, { x, y, sx, sy, pressure: e.pressure || .5 }, e);
      this.requestRender();
    });
    vc.addEventListener('pointercancel', (e) => {
      touchPoints.delete(e.pointerId);
      if (!touchPoints.size) { pinch = null; gestureActive = false; this.viewport.classList.remove('panning'); }
    });
    vc.addEventListener('pointerleave', () => { this.pointerInView = false; this.requestRender(); });
    vc.addEventListener('contextmenu', (e) => e.preventDefault());

    // wheel zoom
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.doc) return;
      const r = vc.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.setZoom(this.view.zoom * factor, sx, sy);
    }, { passive: false });

    // drag & drop import
    ['dragenter', 'dragover'].forEach(ev => this.viewport.addEventListener(ev, (e) => {
      e.preventDefault();
      this.viewport.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => this.viewport.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && e.target !== this.viewport) return;
      this.viewport.classList.remove('dragover');
      if (ev === 'drop') {
        const f = e.dataTransfer.files?.[0];
        if (f) this.openFile(f, !!this.doc && !f.name.toLowerCase().endsWith('.dpx'));
      }
    }));

    // paste image
    document.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const f = item.getAsFile();
      if (f) this.openFile(f, !!this.doc);
    });

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input,textarea,select,[contenteditable]')) return;
      if (e.code === 'Space' && !e.repeat) { this.spaceDown = true; this.viewport.classList.add('tool-hand'); }

      // tool-level key handling first (Enter/Esc for crop, lasso, transform)
      if (this.tool?.onKey?.(this, e)) { e.preventDefault(); return; }

      const combo = (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') +
        (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const norm = combo.replace('Ctrl+Shift+Z', 'Ctrl+Shift+Z');
      for (const id in this.cmd) {
        const k = this.cmd[id].key;
        if (!k) continue;
        const variants = [k];
        if (k === 'Ctrl+Shift+Z') variants.push('Ctrl+Y');
        if (k === 'Ctrl+=') variants.push('Ctrl++');
        if (k === 'Delete') variants.push('Backspace');
        if (variants.some(v => v.toLowerCase() === norm.toLowerCase())) {
          e.preventDefault();
          this.cmd[id].run();
          return;
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // single-key tools & misc
      const key = e.key.toLowerCase();
      if (key === 'x') { this.swapColors(); return; }
      if (key === '[') { this.brush.size = Math.max(1, Math.round(this.brush.size / 1.15)); UI.buildOptionsBar(this); this.requestRender(); return; }
      if (key === ']') { this.brush.size = Math.min(400, Math.max(this.brush.size + 1, Math.round(this.brush.size * 1.15))); UI.buildOptionsBar(this); this.requestRender(); return; }
      if (/^arrow/.test(key) && this.doc && this.tool?.id === 'move') {
        const d = e.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -d : key === 'arrowright' ? d : 0;
        const dy = key === 'arrowup' ? -d : key === 'arrowdown' ? d : 0;
        this.nudgeActive(dx, dy);
        e.preventDefault();
        return;
      }
      const dup = TOOLS.filter(t => t.key === key);
      if (dup.length) {
        // cycle when several tools share a key (g: fill/gradient)
        const idx = dup.indexOf(this.tool);
        this.setTool(dup[(idx + 1) % dup.length].id);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        if (this.tool?.id !== 'hand') this.viewport.classList.remove('tool-hand');
      }
    });

    window.addEventListener('resize', () => this.resizeView());
    window.addEventListener('beforeunload', (e) => {
      if (this.doc?.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  nudgeActive(dx, dy) {
    const D = this.doc;
    const l = D.activeLayer;
    if (!l || l.locked) return;
    if (l.type === 'text') {
      D.withLayerSnapshot('Nudge', l, () => { l.t.x += dx; l.t.y += dy; l.render(); });
    } else {
      D.withLayerSnapshot('Nudge', l, () => {
        const snap = makeCanvas(l.canvas.width, l.canvas.height);
        snap.getContext('2d').drawImage(l.canvas, 0, 0);
        l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
        l.ctx.drawImage(snap, dx, dy);
      });
    }
    this.requestRender();
  }
}

/* ------------------------------ boot ------------------------------ */
async function boot() {
  const app = new App();
  window.deadpixel = app; // console access

  // PWA install prompt capture + service worker
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); app.installPrompt = e; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  await app.loadFontList();

  UI.buildMenus(app);
  UI.buildToolbar(app);
  UI.buildPanels(app);
  UI.bindLaunchBay(app);
  const panelToggle = document.querySelector('#panels-toggle');
  panelToggle?.addEventListener('click', () => {
    const open = document.querySelector('#panels')?.classList.toggle('open');
    panelToggle.setAttribute('aria-expanded', String(!!open));
  });
  const damageQuery = matchMedia('(max-width: 720px), (pointer: coarse)');
  const setDamageMode = () => document.body.classList.toggle('damage-mode', damageQuery.matches);
  damageQuery.addEventListener?.('change', setDamageMode); setDamageMode();
  const panels = document.querySelector('#panels');
  const setPanelsOpen = (open) => {
    panels?.classList.toggle('open', open);
    panelToggle?.setAttribute('aria-expanded', String(open));
  };
  document.querySelectorAll('#damage-dock [data-damage]').forEach(button => {
    const action = button.dataset.damage;
    if (action === 'compare') {
      const bypass = (on) => {
        if (!app.doc) return;
        app.doc._effectsBypassed = on; app.doc._compoDirty = true; app.requestRender();
        button.classList.toggle('holding', on); button.querySelector('span').textContent = on ? 'ORIGINAL' : 'BEFORE';
      };
      button.addEventListener('pointerdown', e => { e.preventDefault(); try { button.setPointerCapture(e.pointerId); } catch (_) {} bypass(true); });
      ['pointerup','pointercancel','lostpointercapture'].forEach(ev => button.addEventListener(ev, () => bypass(false)));
      return;
    }
    button.addEventListener('click', () => {
      if (action === 'open') app.openFilePicker(false);
      if (action === 'crop') { app.setTool('crop'); setPanelsOpen(false); app.toast('DRAG A CROP · ENTER TO COMMIT'); }
      if (action === 'text') { app.setTool('text'); setPanelsOpen(false); app.toast('TAP THE IMAGE TO TYPE'); }
      if (action === 'signal') { app.activatePanelMode?.('signal'); setPanelsOpen(!panels?.classList.contains('open')); }
      if (action === 'export') app.cmd['file.export.png'].run();
    });
  });
  app.bindInput();
  app.setTool('brush');

  // boot splash
  const bootEl = $('#boot');
  const showApp = () => {
    bootEl.classList.add('off');
    $('#app').hidden = false;
    app.resizeView();
  };
  const skipBoot = sessionStorage.getItem('dp_booted');
  if (skipBoot) showApp();
  else {
    document.querySelectorAll('.boot-line').forEach(line => {
      setTimeout(() => line.classList.add('on'), parseInt(line.dataset.t));
    });
    const finish = () => {
      sessionStorage.setItem('dp_booted', '1');
      showApp();
      afterBoot();
    };
    bootEl.addEventListener('click', finish, { once: true });
    setTimeout(() => { if (!bootEl.classList.contains('off')) finish(); }, 1500);
  }

  async function afterBoot() {
    // crash recovery
    const saved = await loadAutosave();
    if (saved && saved.files) {
      const age = Math.round((Date.now() - saved.when) / 60000);
      const res = await UI.dialog('RESURRECTION', (body) => {
        body.appendChild(el2('div', 'dlg-note',
          `An unsaved session was found on this machine: <b>${saved.name}</b> (${age < 1 ? 'moments' : age + ' min'} ago). Recover it?`));
      }, [
        { label: 'Discard', value: () => 'discard' },
        { label: 'Recover', primary: true, value: () => 'recover' },
      ]);
      if (res === 'recover') {
        try {
          const doc = await docFromFiles(saved.files);
          doc.name = saved.name;
          app.attachDoc(doc);
          app.toast('SESSION RESURRECTED');
          return;
        } catch (e) { console.error(e); }
      }
      await clearAutosave();
    }
    if (!app.doc) document.querySelector('#launch-bay')?.classList.remove('gone');
  }
  function el2(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  if (skipBoot) afterBoot();

  // autosave every 45s
  setInterval(() => { if (app.doc?.dirty) autosave(app.doc); }, 45000);

  // preload a few showcase fonts so the picker doesn't flash
  ['VT323', 'Big Shoulders'].forEach(f => app.ensureFont(f));
}

boot();
