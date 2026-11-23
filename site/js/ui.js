/* DEADPIXEL ui — menus, options bar, panels, dialogs, commands. */

import { BLEND_MODES, Selection, hexToRgb, rgbToHex, hsvToRgb, rgbToHsv, clamp, makeCanvas, setAdjustFilters } from './engine.js';
import { TOOLS, toolById, iconSvg } from './tools.js';
import { BRUSH_PRESETS, renderTip, STAMPS, renderStamp } from './brushes.js';
import { FILTERS, filterById, defaultParams, applyFilterToLayer, applyFilterToLayerAsync, processFilterPixelsAsync, BUILTIN_ACTIONS, seeded, processingStats } from './filters.js';
import { saveProjectFile, openDpx, exportDoc, downloadBlob, loadImageFile, docFromImage } from './io.js';

const $ = (sel, root = document) => root.querySelector(sel);
export const APP_VERSION = '2.0.0';

/* hand the adjustment kernels to the engine (compositor needs them; reverse
   dependency lives in the doc's filter lookup to avoid the import cycle) */
const ADJUSTABLE = FILTERS.filter(f => f.group === 'adjust');
setAdjustFilters(ADJUSTABLE);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export function recipeToHash(doc) {
  const payload = {
    v: 1, s: doc.signalSeed >>> 0,
    e: (doc.effects || []).map(x => [x.filter, x.params || {}, x.enabled !== false, !!x.locked, x.paramLocks || {}, x.mix == null ? 1 : x.mix]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let raw = ''; bytes.forEach(b => raw += String.fromCharCode(b));
  return '#r=' + btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function recipeFromHash(hash = location.hash) {
  if (!hash.startsWith('#r=')) return null;
  try {
    let raw = hash.slice(3).replaceAll('-', '+').replaceAll('_', '/');
    while (raw.length % 4) raw += '=';
    const bin = atob(raw), bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes));
    if (p.v !== 1 || !Array.isArray(p.e)) return null;
    return { seed: p.s >>> 0, effects: p.e.map((x, i) => ({ id: `shared_${i}`, filter: x[0], params: x[1] || {}, enabled: x[2] !== false, locked: !!x[3], paramLocks: x[4] || {}, mix: x[5] == null ? 1 : x[5] })) };
  } catch (_) { return null; }
}

/* ============================ toasts ============================ */
let toastBox = null;
export function toast(msg, isErr = false) {
  if (!toastBox) { toastBox = el('div'); toastBox.id = 'toasts'; document.body.appendChild(toastBox); }
  const t = el('div', 'toast' + (isErr ? ' err' : ''), msg);
  toastBox.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 2200);
  setTimeout(() => t.remove(), 2700);
}

/* ============================ dialogs ============================ */
export function dialog(title, bodyBuilder, buttons) {
  return new Promise((resolve) => {
    const scrim = el('div', 'dlg-scrim');
    const dlg = el('div', 'dlg');
    dlg.appendChild(el('h3', null, title));
    const body = el('div', 'dlg-body');
    dlg.appendChild(body);
    const ctl = bodyBuilder(body) || {};
    const foot = el('div', 'dlg-foot');
    const close = (val) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    for (const b of buttons) {
      const btn = el('button', 'btn' + (b.primary ? ' primary' : ''), b.label);
      btn.addEventListener('click', async () => {
        const v = b.value ? (typeof b.value === 'function' ? await b.value(ctl) : b.value) : null;
        if (v === '__invalid__') return;
        close(v);
      });
      foot.appendChild(btn);
    }
    dlg.appendChild(foot);
    scrim.appendChild(dlg);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !(e.target.tagName === 'TEXTAREA')) {
        e.stopPropagation();
        const primary = buttons.find(b => b.primary);
        if (primary) foot.querySelector('.primary')?.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(null); });
    $('#dialogs').appendChild(scrim);
    const firstInput = dlg.querySelector('input,select');
    if (firstInput) { firstInput.focus(); firstInput.select?.(); }
  });
}

function row(label, inputEl) {
  const r = el('div', 'dlg-row');
  r.appendChild(el('label', null, label));
  r.appendChild(inputEl);
  return r;
}
function numInput(value, min, max) {
  const i = el('input');
  i.type = 'number'; i.value = value; i.min = min; i.max = max;
  return i;
}

/* ---- new document ---- */
export async function newDocDialog(app) {
  const res = await dialog('NEW TRANSMISSION', (body) => {
    const name = el('input'); name.type = 'text'; name.value = 'UNTITLED';
    const w = numInput(1280, 1, 8192), h = numInput(720, 1, 8192);
    const preset = el('select');
    [['', 'CUSTOM'], ['1280x720', 'HD 1280×720'], ['1920x1080', 'FULL 1920×1080'],
     ['1080x1080', 'SQUARE 1080'], ['1080x1920', 'STORY 1080×1920'],
     ['800x600', 'CRT 800×600'], ['640x480', 'VGA 640×480'], ['2048x2048', 'TEXTURE 2048'],
    ].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; preset.appendChild(o); });
    preset.addEventListener('change', () => {
      if (!preset.value) return;
      const [pw, ph] = preset.value.split('x').map(Number);
      w.value = pw; h.value = ph;
    });
    const bg = el('select');
    [['transparent', 'TRANSPARENT'], ['#ffffff', 'WHITE'], ['#050505', 'BLACK'], ['fg', 'FOREGROUND COLOR']]
      .forEach(([v, t]) => { const o = el('option', null, t); o.value = v; bg.appendChild(o); });
    body.appendChild(row('Name', name));
    body.appendChild(row('Preset', preset));
    body.appendChild(row('Width px', w));
    body.appendChild(row('Height px', h));
    body.appendChild(row('Background', bg));
    return { name, w, h, bg };
  }, [
    { label: 'Cancel' },
    { label: 'Create', primary: true, value: (c) => {
      const w = clamp(parseInt(c.w.value) || 0, 1, 8192);
      const h = clamp(parseInt(c.h.value) || 0, 1, 8192);
      return { name: (c.name.value || 'UNTITLED').toUpperCase(), w, h, bg: c.bg.value };
    }},
  ]);
  if (res) {
    const bg = res.bg === 'fg' ? app.color.fg : res.bg;
    app.newDoc(res.w, res.h, { name: res.name, bg });
  }
  return res;
}

/* ---- selection radius prompts (feather / expand / contract) ---- */
async function selectRadiusDialog(title, label, def) {
  return dialog(title, (body) => {
    const n = numInput(def, 1, 250);
    body.appendChild(row(label, n));
    return { n };
  }, [
    { label: 'Cancel' },
    { label: 'OK', primary: true, value: (c) => {
      const v = clamp(parseInt(c.n.value) || 0, 1, 250);
      return v > 0 ? v : '__invalid__';
    }},
  ]);
}

/* ---- image / canvas size ---- */
async function imageSizeDialog(app) {
  const D = app.doc;
  const res = await dialog('IMAGE SIZE', (body) => {
    const w = numInput(D.width, 1, 8192), h = numInput(D.height, 1, 8192);
    const lock = el('input'); lock.type = 'checkbox'; lock.checked = true;
    const ratio = D.width / D.height;
    w.addEventListener('input', () => { if (lock.checked) h.value = Math.max(1, Math.round((parseInt(w.value) || 1) / ratio)); });
    h.addEventListener('input', () => { if (lock.checked) w.value = Math.max(1, Math.round((parseInt(h.value) || 1) * ratio)); });
    body.appendChild(row('Width px', w));
    body.appendChild(row('Height px', h));
    const lockRow = el('label', 'opt-check'); lockRow.append(lock, 'KEEP PROPORTIONS');
    body.appendChild(lockRow);
    return { w, h };
  }, [
    { label: 'Cancel' },
    { label: 'Resize', primary: true, value: (c) => ({ w: clamp(parseInt(c.w.value) || 1, 1, 8192), h: clamp(parseInt(c.h.value) || 1, 1, 8192) }) },
  ]);
  if (res) { D.resizeImage(res.w, res.h); app.fitView(); }
}
async function canvasSizeDialog(app) {
  const D = app.doc;
  const res = await dialog('CANVAS SIZE', (body) => {
    const w = numInput(D.width, 1, 8192), h = numInput(D.height, 1, 8192);
    const anchor = el('select');
    ['center', 'top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right']
      .forEach(v => { const o = el('option', null, v.toUpperCase()); o.value = v; anchor.appendChild(o); });
    body.appendChild(row('Width px', w));
    body.appendChild(row('Height px', h));
    body.appendChild(row('Anchor', anchor));
    return { w, h, anchor };
  }, [
    { label: 'Cancel' },
    { label: 'Apply', primary: true, value: (c) => ({ w: clamp(parseInt(c.w.value) || 1, 1, 8192), h: clamp(parseInt(c.h.value) || 1, 1, 8192), anchor: c.anchor.value }) },
  ]);
  if (res) { D.resizeCanvas(res.w, res.h, res.anchor); app.fitView(); }
}

/* ---- filter dialog with live preview ---- */
export async function filterDialog(app, filterId) {
  const D = app.doc;
  const layer = D.activeLayer;
  if (!layer) return;
  if (layer.type === 'text') { toast('RASTERIZE TEXT LAYER FIRST (Layer ▸ Rasterize)', true); return; }
  if (layer.type === 'adjust') { toast('ADJUSTMENT LAYER — FILTERS APPLY TO PIXEL LAYERS', true); return; }
  if (layer.locked) { toast('LAYER IS LOCKED', true); return; }
  const f = filterById(filterId);
  if (!f) return;
  const params = { ...defaultParams(filterId) };

  if (!f.params.length) {
    await D.withLayerSnapshotAsync(f.name, layer, () => applyFilterToLayerAsync(D, layer, filterId, params));
    app.noteFilter(filterId, params);
    app.requestRender();
    return;
  }

  const before = makeCanvas(layer.canvas.width, layer.canvas.height);
  before.getContext('2d').drawImage(layer.canvas, 0, 0);
  let previewTimer = null, previewGeneration = 0;
  const preview = () => {
    D.previewing = true;
    clearTimeout(previewTimer);
    const generation = ++previewGeneration;
    previewTimer = setTimeout(async () => {
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      layer.ctx.drawImage(before, 0, 0);
      const previewParams = { ...params };
      const input = layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      const pixels = await processFilterPixelsAsync(input.data, layer.canvas.width, layer.canvas.height, filterId, previewParams);
      if (generation !== previewGeneration) return;
      const output = layer.ctx.createImageData(layer.canvas.width, layer.canvas.height);
      output.data.set(pixels);
      layer.ctx.putImageData(output, 0, 0);
      if (D.selection) {
        const filtered = makeCanvas(layer.canvas.width, layer.canvas.height);
        filtered.getContext('2d').drawImage(layer.canvas, 0, 0);
        D.selection.maskCanvas(filtered);
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(before, 0, 0);
        layer.ctx.drawImage(filtered, 0, 0);
      }
      D.changed();
      app.requestRender();
    }, 60);
  };
  const restore = () => {
    D.previewing = false;
    previewGeneration++;
    clearTimeout(previewTimer);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.drawImage(before, 0, 0);
    D.changed();
    app.requestRender();
  };
  preview();

  const ok = await dialog(f.name.toUpperCase(), (body) => {
    for (const p of f.params) {
      const wrap = el('div', 'dlg-row');
      wrap.appendChild(el('label', null, p.label));
      const slider = el('input'); slider.type = 'range';
      slider.min = p.min; slider.max = p.max; slider.step = p.step; slider.value = params[p.key];
      slider.className = 'grow';
      const val = el('span', 'opt-val', String(params[p.key]));
      slider.addEventListener('input', () => {
        params[p.key] = parseFloat(slider.value);
        val.textContent = slider.value;
        preview();
      });
      wrap.append(slider, val);
      body.appendChild(wrap);
    }
  }, [
    { label: 'Cancel' },
    { label: 'Apply', primary: true, value: () => true },
  ]);

  restore();
  if (ok) {
    await D.withLayerSnapshotAsync(f.name, layer, () => applyFilterToLayerAsync(D, layer, filterId, params));
    app.noteFilter(filterId, params);
  }
  app.requestRender();
}

/* ---- adjustment layers ---------------------------------------------------- */

/* live, non-destructive param editor: slider ticks recompute the composite;
   OK commits through history, Cancel restores the previous params */
async function adjustmentLayerDialog(app, layer) {
  const D = app.doc;
  const f = filterById(layer.filter);
  if (!f || layer.type !== 'adjust') return;
  const before = { ...layer.params };
  let previewTimer = null, generation = 0;
  const applyPreview = () => {
    clearTimeout(previewTimer);
    const gen = ++generation;
    previewTimer = setTimeout(() => {
      if (gen !== generation) return;
      D.changed();
      app.requestRender();
    }, 60);
  };
  const ok = await dialog(f.name.toUpperCase(), (body) => {
    for (const p of f.params) {
      const wrap = el('div', 'dlg-row');
      wrap.appendChild(el('label', null, p.label));
      const slider = el('input'); slider.type = 'range';
      slider.min = p.min; slider.max = p.max; slider.step = p.step;
      slider.value = layer.params[p.key] ?? p.def;
      slider.className = 'grow';
      const val = el('span', 'opt-val', String(slider.value));
      slider.addEventListener('input', () => {
        layer.params[p.key] = parseFloat(slider.value);
        val.textContent = slider.value;
        applyPreview();
      });
      wrap.append(slider, val);
      body.appendChild(wrap);
    }
    body.appendChild(el('div', 'dlg-note', 'Adjusts every layer below this node. Paint its layer mask to limit where it bites.'));
  }, [
    { label: 'Cancel' },
    { label: 'OK', primary: true, value: () => true },
  ]);
  clearTimeout(previewTimer);
  if (ok) D.setAdjustParams(layer.id, { ...layer.params }, f.name);
  else { layer.params = { ...before }; D.changed(); }
  app.refreshLayers?.();
  app.requestRender();
}

/* ---- export ---- */
async function exportDialog(app, format) {
  const D = app.doc;
  const res = await dialog('EXPORT ' + format.toUpperCase(), (body) => {
    const name = el('input'); name.type = 'text';
    name.value = D.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'deadpixel';
    body.appendChild(row('Filename', name));
    let q = null;
    if (format !== 'png') {
      q = el('input'); q.type = 'range'; q.min = 10; q.max = 100; q.value = 92; q.className = 'grow';
      const qv = el('span', 'opt-val', '92');
      q.addEventListener('input', () => qv.textContent = q.value);
      const r = el('div', 'dlg-row');
      r.appendChild(el('label', null, 'Quality'));
      r.append(q, qv);
      body.appendChild(r);
    }
    body.appendChild(el('div', 'dlg-note', `${D.width}×${D.height}px, flattened${format === 'jpeg' ? ' on white' : ''}`));
    return { name, q };
  }, [
    { label: 'Cancel' },
    { label: 'Export', primary: true, value: (c) => ({ name: c.name.value || 'deadpixel', q: c.q ? parseInt(c.q.value) / 100 : .92 }) },
  ]);
  if (res) {
    const blob = await exportDoc(D, format, res.q);
    const ext = format === 'jpeg' ? 'jpg' : format;
    downloadBlob(blob, res.name + '.' + ext);
    toast('EXPORTED ' + res.name + '.' + ext);
  }
}

/* ---- about / shortcuts / windows ---- */
function aboutDialog() {
  dialog('ABOUT', (body) => {
    body.appendChild(el('div', 'about-hero', 'DEAD<em>PIXEL</em>'));
    body.appendChild(el('div', 'about-osd', 'LOCAL-FIRST IMAGE EDITOR · v' + APP_VERSION));
    body.appendChild(el('div', 'dlg-note',
      'A full-blooded editor running entirely in your browser — layer groups, masks, clipping masks and blend modes included. Nothing you make here ever leaves your machine — no uploads, no accounts, no telemetry. Just you and the pixels.<br><br>' +
      'By <a href="https://deadplug.digital" target="_blank" rel="noopener">deadplug.digital</a> · CH.404'));
  }, [{ label: 'Close', primary: true, value: () => true }]);
}
function shortcutsDialog() {
  const rows = [
    ['V', 'Move'], ['M', 'Marquee'], ['L', 'Lasso'], ['W', 'Magic wand'], ['Q', 'Select by color'], ['C', 'Crop'],
    ['I', 'Eyedropper'], ['B', 'Brush'], ['N', 'Pencil'], ['E', 'Eraser'], ['S', 'Clone stamp'],
    ['U', 'Smudge'], ['G', 'Fill / Gradient'], ['P', 'Shape'], ['K', 'Stamp'], ['T', 'Text'],
    ['H', 'Hand'], ['Z', 'Zoom'], ['X', 'Swap colors / mask fg'], ['[ ]', 'Brush size'],
    ['Space+drag', 'Pan'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
    ['Ctrl+T', 'Free transform'], ['Ctrl+A / Ctrl+D', 'Select all / Deselect'],
    ['Ctrl+Shift+I', 'Invert selection'], ['Ctrl+J', 'Duplicate layer'],
    ['Ctrl+E', 'Merge down / merge group'], ['Ctrl+F', 'Repeat last filter'],
    ['Ctrl+G', 'Group layers'], ['Ctrl+Alt+G', 'Create / release clipping mask'],
    ['Ctrl+S', 'Save .dpx'], ['Ctrl+O', 'Open'], ['Ctrl+Shift+E', 'Export PNG'],
    ['Ctrl+= / Ctrl+-', 'Zoom in / out'], ['Ctrl+0 / Ctrl+1', 'Fit / 100%'],
    ['Del', 'Clear selection'], ['Ctrl+V', 'Paste image'],
  ];
  dialog('KEYBOARD SHORTCUTS', (body) => {
    const g = el('div', 'short-grid');
    rows.forEach(([k, d]) => {
      g.appendChild(el('div', 'k', `<kbd>${k}</kbd>`));
      g.appendChild(el('div', null, d));
    });
    body.appendChild(g);
  }, [{ label: 'Close', primary: true, value: () => true }]);
}
function windowsDialog(app) {
  dialog('DEADPIXEL FOR WINDOWS', (body) => {
    body.appendChild(el('div', 'dlg-note',
      'Two ways to put DEADPIXEL on the desk:<br><br>' +
      '<b>1 · INSTALL AS APP (recommended)</b><br>' +
      'In Chrome or Edge: menu ▸ <i>Cast, save and share</i> ▸ <i>Install page as app</i>. ' +
      'You get a windowed app with its own icon that works offline and updates itself.<br><br>' +
      '<b>2 · WINDOWS INSTALLER (.exe)</b><br>' +
      'A classic installer with Start-menu entry, offline forever:<br>' +
      '<a href="https://github.com/urifranklin666/deadpixel/releases/download/v1.7.0/DeadPixel-Setup-1.7.0.exe">⭳ DeadPixel-Setup-1.7.0.exe</a>'));
    const btnRow = el('div', 'dlg-row');
    if (app.installPrompt) {
      const b = el('button', 'btn primary', 'INSTALL AS APP NOW');
      b.addEventListener('click', async () => {
        app.installPrompt.prompt();
        await app.installPrompt.userChoice;
        app.installPrompt = null;
        b.disabled = true;
      });
      btnRow.appendChild(b);
    }
    body.appendChild(btnRow);
  }, [{ label: 'Close', primary: true, value: () => true }]);
}

function diagnostics(app) {
  const D = app.doc;
  const flat = D?.flatLayers || [];
  return {
    generatedAt: new Date().toISOString(), app: 'DEADPIXEL', version: APP_VERSION,
    runtime: { userAgent: navigator.userAgent, language: navigator.language, online: navigator.onLine, deviceMemory: navigator.deviceMemory || null, hardwareConcurrency: navigator.hardwareConcurrency || null },
    capabilities: { workers: typeof Worker !== 'undefined', fileSystemAccess: 'showOpenFilePicker' in globalThis, offscreenCanvas: typeof OffscreenCanvas !== 'undefined', webGL2: !!document.createElement('canvas').getContext('webgl2') },
    document: D ? {
      width: D.width, height: D.height,
      layers: flat.filter(l => l.type !== 'group').length,
      groups: flat.filter(l => l.type === 'group').length,
      documentModules: D.effects.length,
      layerModules: flat.reduce((n, layer) => n + (layer.effects?.length || 0), 0),
      layerMasks: flat.filter(l => l.mask).length,
      signalMasks: D.signalMasks.size,
      historyEntries: D.history.entries.length, historyBytes: D.history.bytes,
    } : null,
    processing: { ...processingStats },
  };
}

function exportDiagnostics(app) {
  downloadBlob(new Blob([JSON.stringify(diagnostics(app), null, 2)], { type: 'application/json' }), 'deadpixel-diagnostics.json');
  toast('DIAGNOSTICS EXPORTED · NO PIXELS OR FILENAMES INCLUDED');
}

function reportIssue(app) {
  const report = diagnostics(app);
  const body = `Describe what happened:\n\n\nDiagnostics (no image pixels or filenames):\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
  window.open('https://github.com/urifranklin666/deadpixel/issues/new?title=' + encodeURIComponent('[Bug] ') + '&body=' + encodeURIComponent(body), '_blank', 'noopener');
}

function projectSettingsDialog() {
  dialog('LOCAL PROJECT SETTINGS', body => {
    const autosave = el('input'); autosave.type = 'checkbox'; autosave.checked = localStorage.getItem('deadpixel.autosave') !== 'off';
    const count = numInput(parseInt(localStorage.getItem('deadpixel.recoveryCount') || '3'), 1, 10);
    const updates = el('input'); updates.type = 'checkbox'; updates.checked = localStorage.getItem('deadpixel.updateChecks') !== 'off';
    body.append(row('Autosave recovery', autosave), row('Recovery snapshots', count), row('Check for updates', updates), el('div', 'dlg-note', 'Project and recovery data remains on this device. Update checks request only the public DEADPIXEL version file.'));
    return { save: () => { localStorage.setItem('deadpixel.autosave', autosave.checked ? 'on' : 'off'); localStorage.setItem('deadpixel.recoveryCount', String(Math.max(1, Math.min(10, parseInt(count.value) || 3)))); localStorage.setItem('deadpixel.updateChecks', updates.checked ? 'on' : 'off'); } };
  }, [{ label: 'Cancel' }, { label: 'Save', primary: true, value: ctl => { ctl.save(); return true; } }]);
}

const versionParts = value => String(value).split('.').map(x => parseInt(x) || 0);
const newerVersion = (remote, local) => {
  const a = versionParts(remote), b = versionParts(local);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
};

export async function checkForUpdates(silent = false) {
  try {
    const desktop = location.protocol === 'file:' || location.hostname === '127.0.0.1';
    const endpoint = desktop ? 'https://urifranklin666.github.io/deadpixel/version.json' : new URL('version.json', location.href).href;
    const response = await fetch(endpoint + '?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('update endpoint unavailable');
    const release = await response.json();
    if (!newerVersion(release.version, APP_VERSION)) { if (!silent) toast('DEADPIXEL IS CURRENT · v' + APP_VERSION); return false; }
    dialog('NEW TRANSMISSION · v' + release.version, body => body.append(el('div', 'dlg-note', (release.notes || []).map(note => '• ' + note).join('<br>'))), [
      { label: 'Later' }, { label: 'Open Release', primary: true, value: () => { window.open(release.url, '_blank', 'noopener'); return true; } },
    ]);
    return true;
  } catch (_) { if (!silent) toast('UPDATE CHECK FAILED', true); return false; }
}

/* ============================ commands ============================ */
export function buildCommands(app) {
  const D = () => app.doc;
  const needDoc = (fn) => () => { if (app.doc) fn(); };
  const cmds = {
    'file.new': { label: 'New…', key: 'Ctrl+Alt+N', run: () => newDocDialog(app) },
    'file.open': { label: 'Open… (.dpx / image)', key: 'Ctrl+O', run: () => app.openFilePicker(false) },
    'file.place': { label: 'Import As Layer…', key: null, run: needDoc(() => app.openFilePicker(true)) },
    'file.save': { label: 'Save Project', key: 'Ctrl+S', run: needDoc(async () => {
      try {
        const result = await saveProjectFile(D(), D()._fileHandle);
        D()._fileHandle = result.handle; D().dirty = false; app.refreshTitle();
        toast(result.native ? 'PROJECT SAVED' : 'PROJECT DOWNLOADED — KEEP IT SOMEWHERE SAFE');
      } catch (error) { if (error?.name !== 'AbortError') toast('PROJECT SAVE FAILED', true); }
    })},
    'file.saveas': { label: 'Save Project As…', key: 'Ctrl+Alt+S', run: needDoc(async () => {
      try {
        const result = await saveProjectFile(D(), null, true);
        D()._fileHandle = result.handle; D().dirty = false; app.refreshTitle(); toast('PROJECT SAVED AS ' + (result.handle?.name || 'DOWNLOAD'));
      } catch (error) { if (error?.name !== 'AbortError') toast('PROJECT SAVE FAILED', true); }
    })},
    'file.export.png': { label: 'Export PNG…', key: 'Ctrl+Shift+E', run: needDoc(() => exportDialog(app, 'png')) },
    'file.export.jpeg': { label: 'Export JPEG…', key: null, run: needDoc(() => exportDialog(app, 'jpeg')) },
    'file.export.webp': { label: 'Export WebP…', key: null, run: needDoc(() => exportDialog(app, 'webp')) },
    'file.windows': { label: 'Get Windows App…', key: null, run: () => windowsDialog(app) },

    'edit.undo': { label: 'Undo', key: 'Ctrl+Z', run: needDoc(() => { D().history.undo(); app.requestRender(); }) },
    'edit.redo': { label: 'Redo', key: 'Ctrl+Shift+Z', run: needDoc(() => { D().history.redo(); app.requestRender(); }) },
    'edit.fill': { label: 'Fill With Foreground', key: null, run: needDoc(() => app.fillActive()) },
    'edit.clear': { label: 'Clear', key: 'Delete', run: needDoc(() => app.clearActive()) },
    'edit.transform': { label: 'Free Transform', key: 'Ctrl+T', run: needDoc(() => app.enterTransform()) },

    'image.size': { label: 'Image Size…', key: null, run: needDoc(() => imageSizeDialog(app)) },
    'image.canvas': { label: 'Canvas Size…', key: null, run: needDoc(() => canvasSizeDialog(app)) },
    'image.cropsel': { label: 'Crop To Selection', key: null, run: needDoc(() => {
      const b = D().selection?.bounds;
      if (!b) { toast('NO SELECTION', true); return; }
      D().deselect(); D().crop(b); app.fitView();
    })},
    'image.rot90': { label: 'Rotate 90° CW', key: null, run: needDoc(() => { D().rotateDoc(90); app.fitView(); }) },
    'image.rot270': { label: 'Rotate 90° CCW', key: null, run: needDoc(() => { D().rotateDoc(270); app.fitView(); }) },
    'image.rot180': { label: 'Rotate 180°', key: null, run: needDoc(() => D().rotateDoc(180)) },
    'image.fliph': { label: 'Flip Horizontal', key: null, run: needDoc(() => D().flipDoc(true)) },
    'image.flipv': { label: 'Flip Vertical', key: null, run: needDoc(() => D().flipDoc(false)) },

    'layer.new': { label: 'New Layer', key: 'Ctrl+Shift+N', run: needDoc(() => D().addLayer()) },
    'layer.dupe': { label: 'Duplicate Layer', key: 'Ctrl+J', run: needDoc(() => D().duplicateLayer()) },
    'layer.delete': { label: 'Delete Layer', key: null, run: needDoc(() => D().removeLayer()) },
    'layer.up': { label: 'Move Layer Up', key: null, run: needDoc(() => D().moveWithinSiblings(D()._activeId, 1)) },
    'layer.down': { label: 'Move Layer Down', key: null, run: needDoc(() => D().moveWithinSiblings(D()._activeId, -1)) },
    'layer.group': { label: 'Group Layers', key: 'Ctrl+G', run: needDoc(() => D().groupFromActive()) },
    'layer.clip': { label: 'Create Clipping Mask', key: 'Ctrl+Alt+G', run: needDoc(() => D().setClipped()) },
    'layer.merge': { label: 'Merge Down', key: 'Ctrl+E', run: needDoc(() => {
      if (!D().mergeDown()) app.toast('MERGE DOWN NEEDS TWO LAYERS THAT CAN BE COMBINED WITHOUT CHANGING THE IMAGE', true);
    }) },
    'layer.rasterizegroup': { label: 'Merge Group Contents', key: null, run: needDoc(() => {
      const l = D().activeLayer;
      if (l?.type !== 'group') app.toast('SELECT A GROUP TO MERGE ITS CONTENTS', true);
      else if (!D().rasterizeGroup()) app.toast('PASS THROUGH NEEDS LAYERS OUTSIDE THIS GROUP', true);
    })},
    'layer.flatten': { label: 'Flatten Image', key: null, run: needDoc(() => D().flatten()) },
    'layer.rasterize': { label: 'Rasterize Text', key: null, run: needDoc(() => D().rasterizeLayer()) },

    'layer.maskreveal': { label: 'Layer Mask ▸ Reveal All', key: null, run: needDoc(() => { D().addLayerMask(null, 'reveal-all'); app.setMaskTarget(true); }) },
    'layer.maskhide': { label: 'Layer Mask ▸ Hide All', key: null, run: needDoc(() => { D().addLayerMask(null, 'hide-all'); app.setMaskTarget(true); }) },
    'layer.maskfromsel': { label: 'Layer Mask ▸ Reveal Selection', key: null, run: needDoc(() => {
      if (!D().selection) { app.toast('NO SELECTION — REVEALING ALL', true); }
      D().addLayerMask(null, 'reveal-sel', 'Reveal-selection mask');
      app.setMaskTarget(true);
    })},
    'layer.maskhidefromsel': { label: 'Layer Mask ▸ Hide Selection', key: null, run: needDoc(() => {
      if (!D().selection) { app.toast('NO SELECTION — HIDING ALL', true); }
      D().addLayerMask(null, 'hide-sel', 'Hide-selection mask');
      app.setMaskTarget(true);
    })},
    'layer.masktoggle': { label: 'Layer Mask ▸ Disable / Enable', key: null, run: needDoc(() => { D().toggleLayerMaskEnabled(); app.setMaskTarget(app.maskTarget); }) },
    'layer.maskapply': { label: 'Layer Mask ▸ Apply', key: null, run: needDoc(() => {
      const l = D().activeLayer;
      if (!l?.mask) { app.toast('THIS LAYER HAS NO MASK', true); return; }
      D().deleteLayerMask(null, true, 'Apply mask');
      app.setMaskTarget(false);
    })},
    'layer.maskdelete': { label: 'Layer Mask ▸ Delete', key: null, run: needDoc(() => {
      if (!D().activeLayer?.mask) { app.toast('THIS LAYER HAS NO MASK', true); return; }
      D().deleteLayerMask(null, false);
      app.setMaskTarget(false);
    })},

    'select.all': { label: 'Select All', key: 'Ctrl+A', run: needDoc(() => D().selectAll()) },
    'select.none': { label: 'Deselect', key: 'Ctrl+D', run: needDoc(() => D().deselect()) },
    'select.invert': { label: 'Invert Selection', key: 'Ctrl+Shift+I', run: needDoc(() => D().invertSelection()) },
    'select.quickmask': { label: 'Quick Mask (Q to exit)', key: 'Q', run: needDoc(() => app.setQuickMask(!app.quickMask)) },
    'select.bycolor': { label: 'Select By Color', key: null, run: needDoc(() => app.setTool('colorsel')) },
    'select.feather': { label: 'Feather Selection…', key: null, run: needDoc(async () => {
      if (!D().selection || D().selection.isEmpty) { app.toast('NOTHING SELECTED', true); return; }
      const px = await selectRadiusDialog('FEATHER SELECTION', 'Feather radius px', 4);
      if (px && !D().featherSelection(px)) app.toast('NOTHING SELECTED', true);
    }) },
    'select.expand': { label: 'Expand Selection…', key: null, run: needDoc(async () => {
      if (!D().selection || D().selection.isEmpty) { app.toast('NOTHING SELECTED', true); return; }
      const px = await selectRadiusDialog('EXPAND SELECTION', 'Expand by px', 4);
      if (px && !D().growSelection(px)) app.toast('NOTHING SELECTED', true);
    }) },
    'select.contract': { label: 'Contract Selection…', key: null, run: needDoc(async () => {
      if (!D().selection || D().selection.isEmpty) { app.toast('NOTHING SELECTED', true); return; }
      const px = await selectRadiusDialog('CONTRACT SELECTION', 'Contract by px', 4);
      if (px && !D().growSelection(px, true)) app.toast('NOTHING SELECTED', true);
    }) },

    'filter.repeat': { label: 'Repeat Last Filter', key: 'Ctrl+F', run: needDoc(() => app.repeatLastFilter()) },

    'view.zoomin': { label: 'Zoom In', key: 'Ctrl+=', run: needDoc(() => app.zoomAt(null, null, 1.25)) },
    'view.zoomout': { label: 'Zoom Out', key: 'Ctrl+-', run: needDoc(() => app.zoomAt(null, null, 1 / 1.25)) },
    'view.fit': { label: 'Fit On Screen', key: 'Ctrl+0', run: needDoc(() => app.fitView()) },
    'view.hundred': { label: 'Actual Pixels (100%)', key: 'Ctrl+1', run: needDoc(() => app.setZoom(1)) },
    'view.fullscreen': { label: 'Fullscreen', key: null, run: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    }},

    'help.shortcuts': { label: 'Keyboard Shortcuts', key: null, run: () => shortcutsDialog() },
    'help.diagnostics': { label: 'Export Diagnostics…', key: null, run: () => exportDiagnostics(app) },
    'help.report': { label: 'Report Issue… ↗', key: null, run: () => reportIssue(app) },
    'help.projectsettings': { label: 'Local Project Settings…', key: null, run: () => projectSettingsDialog() },
    'help.updates': { label: 'Check for Updates…', key: null, run: () => checkForUpdates(false) },
    'help.about': { label: 'About DEADPIXEL', key: null, run: () => aboutDialog() },
    'help.home': { label: 'deadplug.digital ↗', key: null, run: () => window.open('https://deadplug.digital', '_blank') },
  };
  // adjustments + filters as commands
  for (const f of FILTERS) {
    cmds['fx.' + f.id] = { label: f.name + (f.params.length ? '…' : ''), key: null, run: needDoc(() => filterDialog(app, f.id)) };
  }
  // adjustment layers (LAYER > New Adjustment Layer)
  for (const f of ADJUSTABLE) {
    cmds['adj.' + f.id] = { label: f.name + (f.params.length ? '…' : ''), key: null, run: needDoc(() => {
      const layer = D().addAdjustmentLayer(f.id, defaultParams(f.id), f.name);
      app.refreshLayers();
      app.requestRender();
      adjustmentLayerDialog(app, layer);
    }) };
  }
  return cmds;
}

const MENU_LAYOUT = [
  ['FILE', ['file.new', 'file.open', 'file.place', null, 'file.save', 'file.saveas', null, 'file.export.png', 'file.export.jpeg', 'file.export.webp', null, 'file.windows']],
  ['EDIT', ['edit.undo', 'edit.redo', null, 'edit.fill', 'edit.clear', null, 'edit.transform']],
  ['IMAGE', ['image.size', 'image.canvas', 'image.cropsel', null,
    { sub: 'ADJUSTMENTS', items: () => FILTERS.filter(f => f.group === 'adjust').map(f => 'fx.' + f.id) },
    null, 'image.rot90', 'image.rot270', 'image.rot180', 'image.fliph', 'image.flipv']],
  ['LAYER', ['layer.new', 'layer.dupe', 'layer.delete', null, 'layer.up', 'layer.down', null,
    'layer.group', 'layer.clip',
    { sub: 'NEW ADJUSTMENT LAYER', items: () => ADJUSTABLE.map(f => 'adj.' + f.id) },
    { sub: 'LAYER MASK', items: ['layer.maskreveal', 'layer.maskhide', 'layer.maskfromsel', 'layer.maskhidefromsel', null, 'layer.masktoggle', 'layer.maskapply', 'layer.maskdelete'] },
    null, 'layer.merge', 'layer.rasterizegroup', 'layer.rasterize', null, 'layer.flatten']],
  ['SELECT', ['select.all', 'select.none', 'select.invert', null, 'select.feather', 'select.expand', 'select.contract', null, 'select.quickmask', 'select.bycolor']],
  ['FILTER', ['filter.repeat', null, { sub: 'ALL FILTERS', items: () => FILTERS.filter(f => f.group === 'filter').map(f => 'fx.' + f.id) }]],
  ['VIEW', ['view.zoomin', 'view.zoomout', 'view.fit', 'view.hundred', null, 'view.fullscreen']],
  ['HELP', ['help.shortcuts', 'help.projectsettings', 'help.updates', 'help.diagnostics', 'help.report', null, 'help.about', 'file.windows', 'help.home']],
];

export function buildMenus(app) {
  const nav = $('#menus');
  nav.innerHTML = '';
  let openRoot = null;
  const closeAll = () => { nav.querySelectorAll('.menu-root.open').forEach(r => r.classList.remove('open')); openRoot = null; };
  document.addEventListener('pointerdown', (e) => { if (!nav.contains(e.target)) closeAll(); });

  const buildItems = (drop, ids) => {
    for (const id of ids) {
      if (id === null) { drop.appendChild(el('div', 'menu-sep')); continue; }
      if (typeof id === 'object' && id.sub) {
        const sub = el('div', 'menu-item menu-sub');
        sub.appendChild(el('span', 'mi-label', id.sub));
        sub.appendChild(el('span', 'mi-key', ''));
        const subDrop = el('div', 'menu-drop');
        buildItems(subDrop, typeof id.items === 'function' ? id.items() : id.items);
        sub.appendChild(subDrop);
        drop.appendChild(sub);
        continue;
      }
      const cmd = app.cmd[id];
      if (!cmd) continue;
      const item = el('button', 'menu-item');
      item.appendChild(el('span', 'mi-label', cmd.label));
      item.appendChild(el('span', 'mi-key', cmd.key || ''));
      item.addEventListener('click', () => { closeAll(); cmd.run(); });
      drop.appendChild(item);
    }
  };

  for (const [title, ids] of MENU_LAYOUT) {
    const root = el('div', 'menu-root');
    const btn = el('button', null, title);
    const drop = el('div', 'menu-drop');
    buildItems(drop, ids);
    btn.addEventListener('click', () => {
      const was = root.classList.contains('open');
      closeAll();
      if (!was) { root.classList.add('open'); openRoot = root; }
    });
    btn.addEventListener('pointerenter', () => {
      if (openRoot && openRoot !== root) { closeAll(); root.classList.add('open'); openRoot = root; }
    });
    root.append(btn, drop);
    nav.appendChild(root);
  }
}

/* ============================ toolbar ============================ */
export function buildToolbar(app) {
  const bar = $('#toolbar');
  bar.innerHTML = '';
  const groupBreaks = new Set(['crop', 'heal', 'fill', 'text', 'hand']);
  for (const t of TOOLS) {
    if (groupBreaks.has(t.id)) bar.appendChild(el('div', 'tool-sep'));
    const b = el('button', 'tool-btn', iconSvg(t.icon));
    b.title = t.key ? `${t.name} (${t.key.toUpperCase()})` : t.name;
    b.dataset.tool = t.id;
    b.addEventListener('click', () => app.setTool(t.id));
    bar.appendChild(b);
  }
  // fg/bg swatches
  const fgbg = el('div', 'tool-fgbg');
  fgbg.title = 'foreground / background · X swaps';
  const bg = el('div', 'sw bg'), fg = el('div', 'sw fg');
  fgbg.append(bg, fg);
  fgbg.addEventListener('click', () => app.swapColors());
  bar.appendChild(fgbg);
  app._fgSw = fg; app._bgSw = bg;
}

export function bindLaunchBay(app) {
  const bay = $('#launch-bay');
  if (!bay) return;
  bay.querySelector('[data-launch="open"]').addEventListener('click', () => app.openFilePicker(false));
  bay.querySelector('[data-launch="new"]').addEventListener('click', () => newDocDialog(app));
  bay.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => app.openSample(b.dataset.sample)));
}
export function reflectTool(app) {
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.tool === app.tool?.id));
  $('#st-hint').textContent = app.tool ? (app.tool.name + ' — ' + (app.tool.hint || '')) : '';
  $('#viewport').classList.toggle('tool-hand', app.tool?.id === 'hand');
}

/* ============================ options bar ============================ */
export function buildOptionsBar(app) {
  const bar = $('#optionsbar');
  bar.innerHTML = '';
  const tool = app.tool;
  if (!tool) return;

  if (app.maskTarget) {
    bar.appendChild(el('span', 'opt-chip',
      '⬒ LAYER MASK · light fg / brush REVEALS · dark fg or eraser HIDES · click the layer thumbnail to leave'));
  }

  if (app.quickMask) {
    bar.appendChild(el('span', 'opt-chip',
      '◐ QUICK MASK · brush/pencil ADD TO THE MASK · dark fg or eraser CARVES · Q exits and turns the mask into a selection'));
  }

  const title = el('span', 'opt-label', tool.name);
  title.style.color = 'var(--red)';
  bar.appendChild(title);

  const getStore = (opt) => {
    if (opt.scope === 'brush') return app.brush;
    if (opt.scope === 'text') return app.text;
    tool.state = tool.state || {};
    if (opt.def !== undefined && tool.state[opt.key] === undefined) tool.state[opt.key] = opt.def;
    return tool.state;
  };

  for (const opt of (tool.options || [])) {
    const store = getStore(opt);
    const g = el('div', 'opt-group');
    if (opt.type === 'slider') {
      g.appendChild(el('span', 'opt-label', opt.label));
      const s = el('input'); s.type = 'range';
      s.min = opt.min; s.max = opt.max; s.step = opt.step || 1;
      s.value = store[opt.key] ?? opt.def ?? opt.min;
      const v = el('span', 'opt-val', s.value + (opt.pct ? '%' : ''));
      s.addEventListener('input', () => {
        store[opt.key] = parseFloat(s.value);
        v.textContent = s.value + (opt.pct ? '%' : '');
        app.requestRender();
      });
      g.append(s, v);
    } else if (opt.type === 'check') {
      const lab = el('label', 'opt-check');
      const c = el('input'); c.type = 'checkbox';
      c.checked = !!(store[opt.key] ?? opt.def);
      store[opt.key] = c.checked;
      c.addEventListener('change', () => { store[opt.key] = c.checked; });
      lab.append(c, opt.label);
      g.appendChild(lab);
    } else if (opt.type === 'seg') {
      g.appendChild(el('span', 'opt-label', opt.label));
      const seg = el('div', 'seg');
      const cur = String(store[opt.key] ?? opt.def);
      store[opt.key] = isNaN(+cur) || opt.key === 'align' || opt.key === 'mode' || opt.key === 'shape' || opt.key === 'kind' || opt.key === 'blendTo' ? cur : cur;
      for (const [val, label] of opt.values) {
        const b = el('button', null, label);
        b.classList.toggle('on', String(val) === cur);
        b.addEventListener('click', () => {
          store[opt.key] = opt.key === 'weight' ? val : val;
          seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
          b.classList.add('on');
          app.onTextOptionChanged?.(opt.key);
          tool.optionChanged?.(app, opt.key);
        });
        seg.appendChild(b);
      }
      g.appendChild(seg);
    } else if (opt.type === 'select') {
      g.appendChild(el('span', 'opt-label', opt.label));
      const sel = el('select');
      for (const [val, label] of opt.values) {
        const o = el('option', null, label); o.value = val;
        sel.appendChild(o);
      }
      sel.value = store[opt.key] ?? opt.def;
      store[opt.key] = sel.value;
      sel.addEventListener('change', () => { store[opt.key] = sel.value; buildOptionsBar(app); });
      g.appendChild(sel);
    } else if (opt.type === 'button') {
      const b = el('button', 'pbtn', opt.label);
      b.addEventListener('click', () => tool.doAction?.(app, opt.action));
      g.appendChild(b);
    } else if (opt.type === 'stamp-picker') {
      const cur = store[opt.key] ?? opt.def;
      store[opt.key] = cur;
      const b = el('button', 'pbtn');
      const prev = el('canvas'); prev.width = prev.height = 22;
      prev.style.verticalAlign = 'middle';
      const drawPrev = () => {
        const c = prev.getContext('2d');
        c.clearRect(0, 0, 22, 22);
        c.drawImage(renderStamp(store[opt.key], 22, '#d8d2d3'), 0, 0);
      };
      drawPrev();
      b.append(prev, el('span', null, ' ▾'));
      b.addEventListener('click', () => {
        const pop = el('div', 'popover');
        const grid = el('div', 'stamp-grid');
        for (const st of STAMPS) {
          const cell = el('button', 'stamp-cell' + (st.id === store[opt.key] ? ' on' : ''));
          cell.title = st.name;
          const cv = el('canvas'); cv.width = cv.height = 36;
          cv.getContext('2d').drawImage(renderStamp(st.id, 36, '#d8d2d3'), 0, 0);
          cell.appendChild(cv);
          cell.addEventListener('click', () => { store[opt.key] = st.id; drawPrev(); pop.remove(); });
          grid.appendChild(cell);
        }
        pop.appendChild(grid);
        document.body.appendChild(pop);
        const r = b.getBoundingClientRect();
        pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 10) + 'px';
        pop.style.top = (r.bottom + 6) + 'px';
        const dismiss = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', dismiss, true); } };
        setTimeout(() => document.addEventListener('pointerdown', dismiss, true));
      });
      g.append(el('span', 'opt-label', 'Design'), b);
    } else if (opt.type === 'font-picker') {
      g.appendChild(el('span', 'opt-label', 'Font'));
      const sel = el('select');
      sel.id = 'font-select';
      const groups = {};
      for (const f of app.fonts) {
        const cat = f.category || 'other';
        if (!groups[cat]) {
          const grp = document.createElement('optgroup');
          grp.label = cat.toUpperCase();
          groups[cat] = grp;
          sel.appendChild(grp);
        }
        const o = el('option', null, f.family);
        o.value = f.family;
        o.style.fontFamily = `"${f.family}"`;
        o.style.fontSize = '15px';
        groups[cat].appendChild(o);
      }
      sel.value = app.text.family;
      sel.addEventListener('change', async () => {
        app.text.family = sel.value;
        await app.ensureFont(sel.value);
        app.onTextOptionChanged?.('family');
      });
      g.appendChild(sel);
    }
    bar.appendChild(g);
  }
}

/* ============================ panels ============================ */

function panelShell(id, title) {
  const p = el('section', 'panel');
  p.id = 'panel-' + id;
  const h = el('h2', null, title);
  const body = el('div', 'panel-body');
  h.addEventListener('click', () => p.classList.toggle('closed'));
  p.append(h, body);
  return [p, body];
}

/* ---- color panel ---- */
function buildColorPanel(app, host) {
  const [p, body] = panelShell('color', 'COLOR PICKER');
  const sv = el('canvas'); sv.id = 'sv-square'; sv.width = 240; sv.height = 180;
  const hue = el('canvas'); hue.id = 'hue-bar'; hue.width = 240; hue.height = 14;
  const rowEl = el('div', 'color-row');
  const hex = el('input'); hex.id = 'hex-in'; hex.maxLength = 7;
  rowEl.append(hex);
  const sw = el('div', 'swatches');
  const PALETTE = [
    '#ff2233', '#ff4455', '#8a0f18', '#4d060b', '#050505', '#0b0708', '#d8d2d3', '#f3ecec', '#7d7375', '#ffffff',
    '#000000', '#1a1a1a', '#333333', '#666666', '#999999', '#cccccc', '#ff6600', '#ffcc00', '#ccff00', '#66ff33',
    '#00ff99', '#00ffff', '#0099ff', '#0033ff', '#6600ff', '#cc00ff', '#ff00cc', '#ff0066', '#8b4513', '#f5deb3',
  ];
  PALETTE.forEach(c => {
    const s = el('button', 'swatch');
    s.style.background = c;
    s.title = c;
    s.addEventListener('click', (e) => app.setColor(e.altKey ? 'bg' : 'fg', c));
    sw.appendChild(s);
  });
  body.append(sv, hue, rowEl, sw);
  host.appendChild(p);

  const state = { h: 354, s: .87, v: 1 };
  const svCtx = sv.getContext('2d'), hueCtx = hue.getContext('2d');
  const drawHue = () => {
    const g = hueCtx.createLinearGradient(0, 0, hue.width, 0);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    hueCtx.fillStyle = g;
    hueCtx.fillRect(0, 0, hue.width, hue.height);
    const x = state.h / 360 * hue.width;
    hueCtx.fillStyle = '#fff';
    hueCtx.fillRect(x - 1.5, 0, 3, hue.height);
  };
  const drawSV = () => {
    const g1 = svCtx.createLinearGradient(0, 0, sv.width, 0);
    g1.addColorStop(0, '#fff');
    const { r, g, b } = hsvToRgb(state.h, 1, 1);
    g1.addColorStop(1, rgbToHex(r, g, b));
    svCtx.fillStyle = g1;
    svCtx.fillRect(0, 0, sv.width, sv.height);
    const g2 = svCtx.createLinearGradient(0, 0, 0, sv.height);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(1, '#000');
    svCtx.fillStyle = g2;
    svCtx.fillRect(0, 0, sv.width, sv.height);
    const x = state.s * sv.width, y = (1 - state.v) * sv.height;
    svCtx.strokeStyle = state.v > .5 ? '#000' : '#fff';
    svCtx.beginPath(); svCtx.arc(x, y, 5, 0, Math.PI * 2); svCtx.stroke();
  };
  const commit = () => {
    const { r, g, b } = hsvToRgb(state.h, state.s, state.v);
    app.setColor('fg', rgbToHex(r, g, b), true);
    drawHue(); drawSV();
  };
  const svPick = (e) => {
    const r = sv.getBoundingClientRect();
    state.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    state.v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    commit();
  };
  const huePick = (e) => {
    const r = hue.getBoundingClientRect();
    state.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
    commit();
  };
  const dragify = (cv, fn) => {
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      fn(e);
      const mv = (ev) => fn(ev);
      const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); };
      cv.addEventListener('pointermove', mv);
      cv.addEventListener('pointerup', up);
    });
  };
  dragify(sv, svPick);
  dragify(hue, huePick);
  hex.addEventListener('change', () => {
    const v = hex.value.startsWith('#') ? hex.value : '#' + hex.value;
    if (/^#[0-9a-f]{6}$/i.test(v)) app.setColor('fg', v.toLowerCase());
  });

  app.onColorChanged = () => {
    hex.value = app.color.fg;
    const { r, g, b } = hexToRgb(app.color.fg);
    const hsv = rgbToHsv(r, g, b);
    if (hsv.s > 0.001 && hsv.v > 0.001) state.h = hsv.h;
    state.s = hsv.s; state.v = hsv.v;
    drawHue(); drawSV();
    app._fgSw.style.background = app.color.fg;
    app._bgSw.style.background = app.color.bg;
  };
  app.onColorChanged();
}

/* ---- brushes panel ---- */
function buildBrushPanel(app, host) {
  const [p, body] = panelShell('brushes', 'BRUSHES');
  const grid = el('div', 'brush-grid');
  const name = el('div', 'brush-name');
  for (const preset of BRUSH_PRESETS) {
    const cell = el('button', 'brush-cell');
    cell.title = preset.name;
    const cv = el('canvas');
    cv.width = cv.height = 40;
    cv.getContext('2d').drawImage(renderTip(preset.tip, 36, preset.hardness ?? .8), 2, 2);
    cell.appendChild(cv);
    cell.addEventListener('click', () => {
      app.brush.preset = preset.id;
      grid.querySelectorAll('.brush-cell').forEach(c => c.classList.remove('on'));
      cell.classList.add('on');
      name.textContent = '▸ ' + preset.name;
      if (!['brush', 'eraser'].includes(app.tool?.id)) app.setTool('brush');
    });
    if (preset.id === app.brush.preset) { cell.classList.add('on'); name.textContent = '▸ ' + preset.name; }
    grid.appendChild(cell);
  }
  body.append(grid, name);
  host.appendChild(p);
}

/* ---- layers panel ---- */
function buildLayersPanel(app, host) {
  const [p, body] = panelShell('layers', 'LAYERS');
  const head = el('div', 'layers-head');
  const blend = el('select');
  BLEND_MODES.forEach(([v, label]) => {
    const o = el('option', null, label); o.value = v;
    blend.appendChild(o);
  });
  const op = el('input'); op.type = 'range'; op.id = 'layer-opacity';
  op.min = 0; op.max = 100; op.value = 100;
  const opv = el('span', 'opt-val', '100');
  head.append(blend, op, opv);
  const list = el('div'); list.id = 'layers-list';
  const btns = el('div', 'panel-btns');
  const mkBtn = (label, title, fn) => {
    const b = el('button', 'pbtn', label); b.title = title; b.type = 'button';
    b.addEventListener('click', fn);
    btns.appendChild(b);
    return b;
  };
  mkBtn('+', 'new layer', () => app.doc?.addLayer());
  mkBtn('▦', 'new group', () => app.doc?.addGroup());
  const maskBtn = mkBtn('◐', 'layer mask menu', () => showMaskMenu(maskBtn));
  mkBtn('⧉', 'duplicate', () => app.doc?.duplicateLayer());
  mkBtn('⇓', 'merge down / merge group contents', () => {
    const command = app.doc?.activeLayer?.type === 'group' ? 'layer.rasterizegroup' : 'layer.merge';
    app.cmd[command].run();
  });
  mkBtn('↳', 'toggle clipping mask', () => app.doc?.setClipped());
  const delBtn = mkBtn('🗑', 'delete layer', () => app.doc?.removeLayer());
  delBtn.classList.add('danger');
  body.append(head, list, btns);
  host.appendChild(p);

  /* layer-mask popover */
  function showMaskMenu(anchor) {
    const D = app.doc;
    if (!D) return;
    const pop = el('div', 'popover mask-pop');
    const add = (label, fn) => {
      const b = el('button', 'mask-pop-item', label); b.type = 'button';
      b.addEventListener('click', () => { pop.remove(); document.removeEventListener('pointerdown', dismiss, true); fn(); });
      pop.appendChild(b);
    };
    add('REVEAL ALL', () => { D.addLayerMask(null, 'reveal-all'); app.setMaskTarget(true); });
    add('HIDE ALL', () => { D.addLayerMask(null, 'hide-all'); app.setMaskTarget(true); });
    add('FROM SELECTION (REVEAL)', () => {
      if (!D.selection) app.toast('NO SELECTION — REVEALING ALL', true);
      D.addLayerMask(null, 'reveal-sel', 'Reveal-selection mask');
      app.setMaskTarget(true);
    });
    pop.appendChild(el('div', 'menu-sep'));
    const l = D.activeLayer;
    if (l?.mask) {
      add(l.maskEnabled ? 'DISABLE MASK' : 'ENABLE MASK', () => { D.toggleLayerMaskEnabled(); app.setMaskTarget(false); });
      add('APPLY MASK', () => { D.deleteLayerMask(null, true, 'Apply mask'); app.setMaskTarget(false); });
      add('DELETE MASK', () => { D.deleteLayerMask(null, false); app.setMaskTarget(false); });
    } else {
      pop.appendChild(el('div', 'mask-pop-item dim', 'no mask on the active layer'));
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 10) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    const dismiss = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', dismiss, true); } };
    setTimeout(() => document.addEventListener('pointerdown', dismiss, true));
  }

  blend.addEventListener('change', () => {
    const l = app.doc?.activeLayer;
    if (!l) return;
    l.blend = blend.value;
    app.doc.changed();
  });
  op.addEventListener('input', () => {
    const l = app.doc?.activeLayer;
    if (!l) return;
    l.opacity = parseInt(op.value) / 100;
    opv.textContent = op.value;
    app.doc.changed();
  });

  /* ---------- tree rendering (top of stack first) ---------- */
  let dragId = null;

  const selectNode = (node) => {
    const D = app.doc;
    D.activeIndex = D.flatLayers.findIndex(x => x.id === node.id);
    app.setMaskTarget(false);
    D.changed();
  };

  const drawCanvasThumb = (tc, source) => {
    const D = app.doc;
    const tctx = tc.getContext('2d');
    tctx.clearRect(0, 0, tc.width, tc.height);
    const scale = Math.min(tc.width / D.width, tc.height / D.height);
    tctx.imageSmoothingQuality = 'low';
    tctx.drawImage(source, (tc.width - D.width * scale) / 2, (tc.height - D.height * scale) / 2, D.width * scale, D.height * scale);
  };

  /* reparent on drop: above/below a sibling, or into a group (middle zone) */
  const reparentDrop = (dragId, target, zone) => {
    const D = app.doc;
    if (dragId === target.id) return;
    const locT = D.locate(target.id);
    const locD = D.locate(dragId);
    if (!locT || !locD) return;
    if (zone === 'into') {
      if (target.type !== 'group') return;
      if (D.isDescendantOf(target.id, dragId)) { app.toast("CAN'T NEST A GROUP INSIDE ITSELF", true); return; }
      const g = D.findLayer(target.id);
      g.expanded = true;
      D.reparent(dragId, target.id, g.children.length, 'Move into group');
      return;
    }
    const sameList = locT.list === locD.list;
    // insertion index refers to the array after the drag node is removed
    const ti = sameList && locD.index < locT.index ? locT.index - 1 : locT.index;
    if (sameList) {
      if (zone === 'above' && ti + 1 === locD.index) return;
      if (zone === 'below' && ti === locD.index) return;
    }
    // visually above a row = deeper in the stack list; below = shallower
    const parentId = locT.parent ? locT.parent.id : null;
    D.reparent(dragId, parentId, zone === 'above' ? ti + 1 : ti, 'Reorder layer');
  };

  const renderRow = (node, depth) => {
    const D = app.doc;
    const isGroup = node.type === 'group';
    const active = D.activeLayer === node;
    const rowE = el('div', 'layer-row' + (active ? ' on' : '') + (isGroup ? ' group' : ''));
    rowE.draggable = true;
    rowE.dataset.id = node.id;
    rowE.style.setProperty('--depth', depth);

    if (isGroup) {
      const disc = el('button', 'layer-disc' + (node.expanded ? ' open' : ''), node.expanded ? '▾' : '▸');
      disc.type = 'button'; disc.title = node.expanded ? 'collapse group' : 'expand group';
      disc.addEventListener('click', (e) => { e.stopPropagation(); node.expanded = !node.expanded; D.changed(); });
      rowE.appendChild(disc);
    }
    const eye = el('button', 'layer-eye' + (node.visible ? '' : ' off'), node.visible ? '👁' : '—');
    eye.type = 'button'; eye.title = 'toggle visibility';
    eye.addEventListener('click', (e) => { e.stopPropagation(); node.visible = !node.visible; D.changed(); });
    rowE.appendChild(eye);

    const thumb = el('button', 'layer-thumb' + (isGroup ? ' folder' : '') + (node.type === 'adjust' ? ' adjust' : '')); thumb.type = 'button';
    if (isGroup) {
      thumb.title = `${node.children.length} layer${node.children.length === 1 ? '' : 's'} in group — drop layers here`;
      thumb.textContent = '▦';
    } else if (node.type === 'adjust') {
      const f = filterById(node.filter);
      thumb.title = (f?.name || 'adjustment') + ' — click to edit parameters';
      thumb.textContent = 'ƒ';
      thumb.addEventListener('click', (e) => { e.stopPropagation(); adjustmentLayerDialog(app, node); });
    } else {
      const tc = el('canvas'); tc.width = 40; tc.height = 30;
      drawCanvasThumb(tc, node.canvas);
      thumb.title = 'click to edit layer pixels';
      thumb.appendChild(tc);
      thumb.addEventListener('click', (e) => { e.stopPropagation(); selectNode(node); });
    }
    rowE.appendChild(thumb);

    if (node.mask) {
      const mt = el('button', 'mask-thumb' + (app.maskTarget && active ? ' on' : '') + (node.maskEnabled ? '' : ' off'));
      mt.type = 'button';
      mt.title = node.maskEnabled ? 'click to paint this layer mask' : 'mask disabled — click thumbnail to enable editing';
      const mc = el('canvas'); mc.width = 20; mc.height = 15;
      const mctx = mc.getContext('2d');
      mctx.fillStyle = '#0c0c0c'; mctx.fillRect(0, 0, mc.width, mc.height);
      mctx.imageSmoothingQuality = 'low';
      mctx.drawImage(node.mask, 0, 0, mc.width, mc.height);
      mt.appendChild(mc);
      mt.addEventListener('click', (e) => {
        e.stopPropagation();
        const already = app.maskTarget && D.activeLayer === node;
        selectNode(node);
        app.setMaskTarget(!already);
      });
      rowE.appendChild(mt);
    }

    const nameE = el('div', 'layer-name', node.name);
    nameE.title = 'double-click to rename';
    nameE.addEventListener('dblclick', () => {
      const inp = el('input');
      inp.value = node.name;
      nameE.innerHTML = '';
      nameE.appendChild(inp);
      inp.focus(); inp.select();
      const done = () => { node.name = inp.value || node.name; app.refreshLayers(); };
      inp.addEventListener('blur', done);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
    });
    rowE.appendChild(nameE);

    if (node.clipped) {
      const clipTag = el('span', 'layer-clip', '↳');
      clipTag.title = 'clipped to the layer below';
      rowE.appendChild(clipTag);
    }
    const tag = el('span', 'layer-tag', node.type === 'text' ? 'T' : node.type === 'adjust' ? 'ƒ' : '');
    if (node.type === 'text') tag.title = 'text layer';
    if (node.type === 'adjust') tag.title = 'adjustment layer';
    rowE.appendChild(tag);
    const lock = el('button', 'layer-lock' + (node.locked ? ' locked' : ''), node.locked ? '🔒' : '🔓');
    lock.type = 'button'; lock.title = 'lock layer';
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      node.locked = !node.locked;
      app.refreshLayers();
    });
    rowE.appendChild(lock);

    rowE.addEventListener('click', () => selectNode(node));
    rowE.addEventListener('dragstart', () => { dragId = node.id; rowE.classList.add('dragging'); });
    rowE.addEventListener('dragend', () => { dragId = null; rowE.classList.remove('dragging'); });
    rowE.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = rowE.getBoundingClientRect();
      const ry = e.clientY - r.top;
      const zone = isGroup
        ? (ry < r.height * .35 ? 'above' : ry > r.height * .65 ? 'below' : 'into')
        : (ry < r.height / 2 ? 'above' : 'below');
      rowE.dataset.zone = zone;
      rowE.classList.toggle('dropabove', zone === 'above');
      rowE.classList.toggle('dropbelow', zone === 'below');
      rowE.classList.toggle('dropinto', zone === 'into');
    });
    rowE.addEventListener('dragleave', () => {
      rowE.classList.remove('dropabove', 'dropbelow', 'dropinto');
      rowE.dataset.zone = '';
    });
    rowE.addEventListener('drop', (e) => {
      e.preventDefault();
      const zone = rowE.dataset.zone || (isGroup ? 'into' : 'above');
      rowE.classList.remove('dropabove', 'dropbelow', 'dropinto');
      rowE.dataset.zone = '';
      if (dragId) reparentDrop(dragId, node, zone);
      dragId = null;
    });
    list.appendChild(rowE);
  };

  app.refreshLayers = () => {
    const D = app.doc;
    list.innerHTML = '';
    if (!D) return;
    const l = D.activeLayer;
    if (l) {
      // pass-through only exists for groups; everything else coerces to Normal
      blend.innerHTML = '';
      for (const [v, label] of BLEND_MODES) {
        if (v === 'pass-through' && l.type !== 'group') continue;
        const o = el('option', null, label); o.value = v;
        blend.appendChild(o);
      }
      blend.value = l.blend === 'pass-through' && l.type !== 'group' ? 'source-over' : l.blend;
      op.value = Math.round(l.opacity * 100); opv.textContent = op.value;
    }
    const walk = (nodes, depth) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        renderRow(node, depth);
        if (node.type === 'group' && node.expanded) walk(node.children, depth + 1);
      }
    };
    walk(D.layers, 0);
  };
}

/* ---- history panel ---- */
function buildHistoryPanel(app, host) {
  const [p, body] = panelShell('history', 'REWIND');
  const list = el('div'); list.id = 'history-list';
  body.appendChild(list);
  host.appendChild(p);
  app.refreshHistory = () => {
    const D = app.doc;
    list.innerHTML = '';
    if (!D) return;
    const H = D.history;
    const mk = (label, idx) => {
      const r = el('div', 'hist-row' + (idx === H.index ? ' current' : idx > H.index ? ' undone' : ''), label);
      r.addEventListener('click', () => { H.jumpTo(idx); app.requestRender(); });
      list.appendChild(r);
    };
    mk('⏮ OPEN', -1);
    H.entries.forEach((e, i) => mk(e.label, i));
    list.scrollTop = list.scrollHeight;
  };
}

/* ---- actions panel ---- */
function buildActionsPanel(app, host) {
  const [p, body] = panelShell('actions', 'SIGNAL RACK');
  const scopeSel = el('select', 'rack-scope');
  [['document', 'DOCUMENT OUTPUT'], ['layer', 'ACTIVE LAYER']].forEach(([value, label]) => {
    const option = el('option', null, label); option.value = value; scopeSel.appendChild(option);
  });
  const activeHead = el('div', 'rack-head');
  activeHead.append(el('span', null, 'LIVE CHAIN'), el('span', 'rack-count', '0 MODULES'));
  const activeList = el('div', 'rack-active');
  const empty = el('div', 'rack-empty', 'CLEAN SIGNAL. ADD A RECIPE BELOW.');
  activeList.appendChild(empty);
  const rackTools = el('div', 'rack-tools');
  const seedBox = el('div', 'rack-seed');
  seedBox.append(el('span', null, 'SEED'), el('code', null, '00000000'));
  const mutateBtn = el('button', null, 'MUTATE');
  const saveBtn = el('button', null, 'SAVE');
  const shareBtn = el('button', null, 'COPY LINK');
  const bypassBtn = el('button', null, 'BYPASS');
  const snapABtn = el('button', null, 'SET A');
  const snapBBtn = el('button', null, 'SET B');
  const compareABtn = el('button', null, 'SHOW A');
  rackTools.append(seedBox, mutateBtn, saveBtn, shareBtn, snapABtn, snapBBtn, compareABtn, bypassBtn);
  const presetHead = el('div', 'rack-head rack-presets');
  presetHead.append(el('span', null, 'RECIPE ARCHIVE'), el('span', null, 'NON-DESTRUCTIVE'));
  const list = el('div');
  const btns = el('div', 'panel-btns');
  const recBtn = el('button', 'pbtn', '● REC');
  const note = el('div', 'dlg-note');
  note.style.marginTop = '8px';
  note.textContent = 'Modules process the composite without touching layer pixels. They are saved inside the DPX project and included in exports.';
  btns.appendChild(recBtn);
  body.append(scopeSel, activeHead, rackTools, activeList, presetHead, list, btns, note);
  host.appendChild(p);

  const userActions = () => JSON.parse(localStorage.getItem('deadpixel.actions') || '[]');
  const saveUserActions = (a) => localStorage.setItem('deadpixel.actions', JSON.stringify(a));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let snapshots = { a: null, b: null }, showing = null;
  const target = () => {
    const D = app.doc;
    return scopeSel.value === 'layer' ? D?.activeLayer : D;
  };
  const replaceTarget = (next, label, seed = target()?.signalSeed) => {
    const D = app.doc, T = target(); if (!D || !T) return;
    if (T === D) D.replaceEffects(next, label, seed);
    else D.replaceLayerEffects(T, next, label, seed);
  };
  scopeSel.addEventListener('change', () => { showing = null; refreshActive(); });
  const changeStack = (label, mutate) => {
    const T = target(); if (!T) return;
    const next = clone(T.effects || []); mutate(next);
    replaceTarget(next, label); app.requestRender(); refreshActive();
  };

  const editMask = async (effectIndex) => {
    const D = app.doc, T = target(); if (!D || !T) return;
    let effect = T.effects[effectIndex];
    if (!effect.maskId || !D.signalMasks.has(effect.maskId)) {
      const id = D.createSignalMask(true);
      changeStack('Create paint mask', stack => { stack[effectIndex].mask = 'raster'; stack[effectIndex].maskId = id; });
      effect = target().effects[effectIndex];
    }
    const alpha = D.signalMasks.get(effect.maskId);
    const max = 480, scale = Math.min(1, max / Math.max(D.width, D.height));
    const w = Math.max(1, Math.round(D.width * scale)), h = Math.max(1, Math.round(D.height * scale));
    await dialog('PAINT SIGNAL MASK', bodyEl => {
      const source = makeCanvas(D.width, D.height), sctx = source.getContext('2d'), src = sctx.createImageData(D.width, D.height);
      for (let i = 0; i < alpha.length; i++) src.data.set([255, 255, 255, alpha[i]], i * 4);
      sctx.putImageData(src, 0, 0);
      const canvas = makeCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, w, h); ctx.drawImage(source, 0, 0, w, h);
      canvas.className = 'mask-editor';
      const tools = el('div', 'mask-tools');
      const mode = el('select'); [['paint', 'PAINT'], ['erase', 'ERASE']].forEach(([v, n]) => { const o = el('option', null, n); o.value = v; mode.appendChild(o); });
      const size = el('input'); size.type = 'range'; size.min = 2; size.max = 160; size.value = 36;
      const density = el('input'); density.type = 'range'; density.min = 1; density.max = 100; density.value = 100;
      const feather = el('input'); feather.type = 'range'; feather.min = 0; feather.max = 100; feather.value = 25;
      tools.append(el('span', null, 'MODE'), mode, el('span', null, 'SIZE'), size, el('span', null, 'DENSITY'), density, el('span', null, 'FEATHER'), feather);
      bodyEl.append(canvas, tools, el('div', 'dlg-note', 'White reveals the module; black protects the image. A selection seeds new masks.'));
      let drawing = false;
      const dab = e => {
        const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * w / r.width, y = (e.clientY - r.top) * h / r.height;
        const radius = Number(size.value) / 2, soft = Number(feather.value) / 100;
        const gradient = ctx.createRadialGradient(x, y, radius * (1 - soft), x, y, radius);
        const value = mode.value === 'erase' ? '0' : '255', a = Number(density.value) / 100;
        gradient.addColorStop(0, `rgba(${value},${value},${value},${a})`); gradient.addColorStop(1, `rgba(${value},${value},${value},0)`);
        ctx.save(); ctx.globalCompositeOperation = mode.value === 'erase' ? 'destination-out' : 'source-over'; ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      };
      canvas.addEventListener('pointerdown', e => { drawing = true; canvas.setPointerCapture(e.pointerId); dab(e); });
      canvas.addEventListener('pointermove', e => { if (drawing) dab(e); });
      canvas.addEventListener('pointerup', () => { drawing = false; });
      return { commit: () => {
        sctx.clearRect(0, 0, D.width, D.height); sctx.drawImage(canvas, 0, 0, D.width, D.height);
        const pixels = sctx.getImageData(0, 0, D.width, D.height).data;
        for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
        D.maskRevision++; D.changed(); app.requestRender();
      } };
    }, [{ label: 'Cancel' }, { label: 'Apply', primary: true, value: ctl => { ctl.commit(); return true; } }]);
    refreshActive();
  };

  mutateBtn.addEventListener('click', () => {
    const D = app.doc, T = target(); if (!T?.effects.length) return;
    const nextSeed = crypto.getRandomValues(new Uint32Array(1))[0];
    const rnd = seeded(nextSeed);
    const next = clone(T.effects);
    next.forEach(effect => {
      if (effect.locked) return;
      const f = filterById(effect.filter);
      for (const param of f?.params || []) {
        if (effect.paramLocks?.[param.key]) continue;
        const steps = Math.round((param.max - param.min) / param.step);
        effect.params ||= {};
        effect.params[param.key] = param.min + Math.floor(rnd() * (steps + 1)) * param.step;
      }
    });
    replaceTarget(next, 'Mutate signal', nextSeed); app.requestRender(); refreshActive();
    toast('SIGNAL MUTATED · SEED ' + nextSeed.toString(16).padStart(8, '0').toUpperCase());
  });
  const storeSnapshot = (slot) => {
    const T = target(); if (!T) return;
    snapshots[slot] = { effects: clone(T.effects), seed: T.signalSeed };
    toast('SIGNAL SNAPSHOT ' + slot.toUpperCase() + ' STORED');
  };
  snapABtn.addEventListener('click', () => storeSnapshot('a'));
  snapBBtn.addEventListener('click', () => storeSnapshot('b'));
  compareABtn.addEventListener('click', () => {
    const D = app.doc; if (!D) return;
    const slot = showing === 'a' ? 'b' : 'a';
    if (!snapshots[slot]) { toast('STORE SNAPSHOT ' + slot.toUpperCase() + ' FIRST', true); return; }
    showing = slot;
    replaceTarget(snapshots[slot].effects, 'Recall snapshot ' + slot.toUpperCase(), snapshots[slot].seed);
    compareABtn.textContent = 'SHOW ' + (slot === 'a' ? 'B' : 'A');
    refreshActive(); app.requestRender();
  });
  let bypassed = null;
  bypassBtn.addEventListener('pointerdown', () => {
    const doc = app.doc, owner = target();
    if (!doc || !owner || bypassed) return;
    bypassed = { doc, owner };
    doc.setEffectBypass(owner, true);
    app.requestRender();
    bypassBtn.classList.add('on');
  });
  const restoreBypass = () => {
    if (!bypassed) return;
    bypassed.doc.setEffectBypass(bypassed.owner, false);
    bypassed = null;
    app.requestRender();
    bypassBtn.classList.remove('on');
  };
  ['pointerup','pointercancel','pointerleave'].forEach(ev => bypassBtn.addEventListener(ev, restoreBypass));
  saveBtn.addEventListener('click', async () => {
    const D = app.doc, T = target(); if (!T?.effects.length) return;
    const name = await dialog('SAVE SIGNAL RECIPE', bodyEl => {
      const input = el('input'); input.type = 'text'; input.value = 'MY DAMAGE'; bodyEl.appendChild(row('Name', input)); return { input };
    }, [{ label: 'Cancel' }, { label: 'Save', primary: true, value: c => c.input.value.trim() || 'MY DAMAGE' }]);
    if (!name) return;
    const actions = userActions();
    actions.push({ id: 'rack_' + Date.now(), name: name.toUpperCase(), seed: T.signalSeed >>> 0, steps: clone(T.effects).map(x => ({ filter: x.filter, params: x.params, enabled: x.enabled, locked: x.locked, paramLocks: x.paramLocks, mix: x.mix })) });
    saveUserActions(actions); refresh(); toast('RECIPE ARCHIVED: ' + name.toUpperCase());
  });
  shareBtn.addEventListener('click', async () => {
    const T = target(); if (!T?.effects.length) return;
    const url = location.origin + location.pathname + recipeToHash(T);
    try { await navigator.clipboard.writeText(url); toast('RECIPE LINK COPIED · SETTINGS ONLY'); }
    catch (_) { prompt('COPY RECIPE LINK', url); }
  });

  const refreshActive = () => {
    const D = app.doc, T = target();
    activeList.innerHTML = '';
    const effects = T?.effects || [];
    seedBox.querySelector('code').textContent = T ? T.signalSeed.toString(16).padStart(8, '0').toUpperCase() : '00000000';
    activeHead.querySelector('.rack-count').textContent = effects.length + (effects.length === 1 ? ' MODULE' : ' MODULES');
    if (!effects.length) { activeList.appendChild(el('div', 'rack-empty', 'CLEAN SIGNAL. ADD A RECIPE BELOW.')); return; }
    effects.forEach((effect, index) => {
      const f = filterById(effect.filter);
      if (!f) return;
      const module = el('article', 'rack-module' + (effect.enabled === false ? ' bypassed' : ''));
      const top = el('div', 'rack-module-top');
      const power = el('button', 'rack-power', effect.enabled === false ? '○' : '●'); power.title = 'bypass module';
      const title = el('button', 'rack-module-name', `${String(index + 1).padStart(2, '0')}  ${f.name}`);
      const lock = el('button', 'rack-lock', effect.locked ? '◆' : '◇'), up = el('button', 'rack-move', '↑'), down = el('button', 'rack-move', '↓'), del = el('button', 'rack-delete', '×');
      power.addEventListener('click', () => changeStack('Bypass ' + f.name, s => { s[index].enabled = s[index].enabled === false; }));
      lock.addEventListener('click', () => changeStack('Lock ' + f.name, s => { s[index].locked = !s[index].locked; }));
      up.addEventListener('click', () => changeStack('Move signal module', s => { if (index) [s[index - 1], s[index]] = [s[index], s[index - 1]]; }));
      down.addEventListener('click', () => changeStack('Move signal module', s => { if (index < s.length - 1) [s[index + 1], s[index]] = [s[index], s[index + 1]]; }));
      del.addEventListener('click', () => changeStack('Remove ' + f.name, s => s.splice(index, 1)));
      top.append(power, title, lock, up, down, del); module.appendChild(top);
      const controls = el('div', 'rack-controls');
      const mixRow = el('label', 'rack-param');
      const mixLabel = el('span', null, 'Mix');
      const mixValue = el('output', null, Math.round((effect.mix == null ? 1 : effect.mix) * 100) + '%');
      const mixInput = el('input'); mixInput.type = 'range'; mixInput.min = 0; mixInput.max = 100; mixInput.step = 1;
      mixInput.value = Math.round((effect.mix == null ? 1 : effect.mix) * 100);
      let mixBefore = null;
      mixInput.addEventListener('pointerdown', () => { mixBefore = clone(T.effects); });
      mixInput.addEventListener('input', () => {
        T.effects[index].mix = parseInt(mixInput.value) / 100;
        mixValue.textContent = mixInput.value + '%'; D.changed(); app.requestRender();
      });
      mixInput.addEventListener('change', () => {
        const after = clone(T.effects), start = mixBefore || clone(T.effects); mixBefore = null;
        T.effects = start; replaceTarget(after, f.name + ': Mix'); refreshActive();
      });
      mixRow.append(mixLabel, mixValue, mixInput); controls.appendChild(mixRow);
      const maskRow = el('label', 'rack-param');
      const maskLabel = el('span', null, 'Mask');
      const maskSelect = el('select');
      [['', 'NONE'], ['luma', 'LUMINANCE'], ['alpha', 'ALPHA'], ['raster', 'PAINTED']].forEach(([value, label]) => {
        const option = el('option', null, label); option.value = value; option.selected = (effect.mask || '') === value; maskSelect.appendChild(option);
      });
      const invertMask = el('button', 'rack-param-lock', effect.maskInvert ? 'INV' : 'NOR'); invertMask.type = 'button';
      const editMaskBtn = el('button', 'rack-param-lock', 'EDIT'); editMaskBtn.type = 'button'; editMaskBtn.hidden = effect.mask !== 'raster';
      maskSelect.addEventListener('change', () => changeStack(f.name + ': Mask', s => { s[index].mask = maskSelect.value || null; }));
      invertMask.addEventListener('click', e => { e.preventDefault(); changeStack(f.name + ': Invert mask', s => { s[index].maskInvert = !s[index].maskInvert; } ); });
      editMaskBtn.addEventListener('click', e => { e.preventDefault(); editMask(index); });
      maskRow.append(maskLabel, invertMask, editMaskBtn, maskSelect); controls.appendChild(maskRow);
      if (effect.mask === 'raster' && D.signalMasks.has(effect.maskId)) {
        const maskTools = el('div', 'rack-mask-tools'), thumb = makeCanvas(96, 54), paintView = el('button', null, 'VIEW'), duplicate = el('button', null, 'DUP'), soften = el('button', null, 'SOFTEN'), remove = el('button', null, 'DELETE');
        thumb.className = 'rack-mask-thumb';
        const alpha = D.signalMasks.get(effect.maskId), preview = makeCanvas(D.width, D.height), pctx = preview.getContext('2d'), image = pctx.createImageData(D.width, D.height);
        for (let i = 0; i < alpha.length; i++) image.data.set([255, 255, 255, alpha[i]], i * 4);
        pctx.putImageData(image, 0, 0); thumb.getContext('2d').drawImage(preview, 0, 0, thumb.width, thumb.height);
        thumb.addEventListener('click', () => editMask(index));
        paintView.title = 'paint this mask directly over the image'; paintView.addEventListener('click', () => app.beginMaskPainting(effect.maskId));
        duplicate.addEventListener('click', () => {
          const id = D.createSignalMask(false); D.signalMasks.set(id, new Uint8ClampedArray(alpha));
          changeStack('Duplicate paint mask', stack => { stack[index].mask = 'raster'; stack[index].maskId = id; });
        });
        soften.addEventListener('click', () => {
          const src = makeCanvas(D.width, D.height), sctx = src.getContext('2d'), srcImage = sctx.createImageData(D.width, D.height);
          for (let i = 0; i < alpha.length; i++) srcImage.data.set([255, 255, 255, alpha[i]], i * 4);
          sctx.putImageData(srcImage, 0, 0); const out = makeCanvas(D.width, D.height), octx = out.getContext('2d', { willReadFrequently: true });
          octx.filter = 'blur(4px)'; octx.drawImage(src, 0, 0); const rgba = octx.getImageData(0, 0, D.width, D.height).data;
          for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
          D.maskRevision++; D.changed(); app.requestRender(); refreshActive();
        });
        remove.addEventListener('click', () => { const id = effect.maskId; changeStack('Delete paint mask', stack => { stack[index].mask = null; delete stack[index].maskId; }); D.signalMasks.delete(id); D.maskRevision++; });
        maskTools.append(thumb, paintView, duplicate, soften, remove); controls.appendChild(maskTools);
      }
      for (const param of f.params) {
        const rowEl = el('label', 'rack-param');
        const lab = el('span', null, param.label); const val = el('output', null, String(effect.params?.[param.key] ?? param.def));
        const paramLock = el('button', 'rack-param-lock', effect.paramLocks?.[param.key] ? '◆' : '◇'); paramLock.type = 'button'; paramLock.title = 'lock parameter during mutation';
        paramLock.addEventListener('click', e => { e.preventDefault(); changeStack('Lock parameter', s => { s[index].paramLocks ||= {}; s[index].paramLocks[param.key] = !s[index].paramLocks[param.key]; }); });
        const input = el('input'); input.type = 'range'; input.min = param.min; input.max = param.max; input.step = param.step; input.value = effect.params?.[param.key] ?? param.def;
        let before = null;
        input.addEventListener('focus', () => { before ||= clone(T.effects); });
        input.addEventListener('pointerdown', () => { before = clone(T.effects); });
        input.addEventListener('input', () => {
          T.effects[index].params ||= {}; T.effects[index].params[param.key] = parseFloat(input.value);
          val.textContent = input.value; D.changed(); app.requestRender();
        });
        input.addEventListener('change', () => {
          const after = clone(T.effects); const start = before || clone(T.effects); before = null;
          T.effects = start; replaceTarget(after, f.name + ': ' + param.label); refreshActive();
        });
        rowEl.append(lab, paramLock, val, input); controls.appendChild(rowEl);
      }
      if (!f.params.length) controls.appendChild(el('div', 'rack-fixed', 'FIXED-PARAMETER MODULE'));
      module.appendChild(controls);
      title.addEventListener('click', () => module.classList.toggle('open'));
      activeList.appendChild(module);
    });
  };

  const refresh = () => {
    list.innerHTML = '';
    const render = (action, deletable) => {
      const r = el('div', 'action-row signal-card');
      const preview = el('canvas', 'signal-preview'); preview.width = 220; preview.height = 96;
      const runB = el('button', 'a-run', 'ADD');
      runB.title = 'add recipe to non-destructive signal rack';
      runB.addEventListener('click', () => {
        const D = app.doc;
        if (!D) return;
        const T = target(); if (!T) return;
        const next = clone(T.effects || []);
        next.push(...action.steps.map((step, i) => ({
          id: 'fx_' + Date.now().toString(36) + '_' + i,
          filter: step.filter, params: { ...defaultParams(step.filter), ...(step.params || {}) }, enabled: step.enabled !== false,
          locked: !!step.locked, paramLocks: step.paramLocks || {},
        })));
        replaceTarget(next, 'Add recipe: ' + action.name, Number.isFinite(action.seed) ? action.seed : T.signalSeed);
        app.requestRender(); refreshActive();
        toast('RECIPE PATCHED IN: ' + action.name);
      });
      const meta = el('div', 'signal-meta');
      meta.append(el('span', 'a-name', action.name), el('span', 'signal-chain', action.steps.map(s => s.filter.replaceAll('-', ' ')).join(' ▸ ')));
      r.append(preview, meta, runB);
      if (deletable) {
        const d = el('button', 'a-del', '✕');
        d.addEventListener('click', () => {
          saveUserActions(userActions().filter(a => a.id !== action.id));
          refresh();
        });
        r.appendChild(d);
      }
      list.appendChild(r);
      const drawPreview = () => {
        const ctx = preview.getContext('2d'); ctx.clearRect(0, 0, preview.width, preview.height);
        ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, preview.width, preview.height);
        if (!app.doc) { ctx.fillStyle = '#ff2233'; ctx.font = '52px Big Shoulders'; ctx.fillText('NO SIGNAL', 14, 63); return; }
        const src = app.doc.flattenedCanvas();
        const scale = Math.max(preview.width / src.width, preview.height / src.height);
        const w = src.width * scale, h = src.height * scale;
        ctx.drawImage(src, (preview.width - w) / 2, (preview.height - h) / 2, w, h);
        const layer = { canvas: preview, ctx };
        for (const step of action.steps) applyFilterToLayer({ selection: null }, layer, step.filter, { ...defaultParams(step.filter), ...step.params });
      };
      drawPreview();
      r._drawPreview = drawPreview;
    };
    BUILTIN_ACTIONS.forEach(a => render(a, false));
    userActions().forEach(a => render(a, true));
  };
  refresh();
  app.refreshActions = () => {
    refreshActive();
    list.querySelectorAll('.signal-card').forEach(card => card._drawPreview?.());
  };
  refreshActive();

  recBtn.addEventListener('click', async () => {
    if (!app.recording) {
      app.recording = [];
      recBtn.textContent = '■ STOP';
      recBtn.style.color = 'var(--red)';
      $('#rec-light').hidden = false;
      toast('RECORDING — APPLY FILTERS NOW');
    } else {
      const steps = app.recording;
      app.recording = null;
      recBtn.textContent = '● REC';
      recBtn.style.color = '';
      $('#rec-light').hidden = true;
      if (!steps.length) { toast('NOTHING RECORDED', true); return; }
      const res = await dialog('SAVE RITUAL', (bodyEl) => {
        const name = el('input'); name.type = 'text'; name.value = 'MY RITUAL';
        bodyEl.appendChild(row('Name', name));
        bodyEl.appendChild(el('div', 'dlg-note', steps.length + ' step(s) recorded'));
        return { name };
      }, [
        { label: 'Discard' },
        { label: 'Save', primary: true, value: (c) => c.name.value || 'MY RITUAL' },
      ]);
      if (res) {
        const a = userActions();
        a.push({ id: 'u' + Date.now(), name: res.toUpperCase(), steps });
        saveUserActions(a);
        refresh();
        toast('RITUAL SAVED');
      }
    }
  });
}

/* ---- navigator panel ------------------------------------------------------ */

/* live thumbnail + draggable viewport box; click/drag centers the view */
function buildNavigatorPanel(app, host) {
  const [p, bodyEl] = panelShell('navigator', 'NAVIGATOR');
  const wrap = el('div', 'nav-wrap');
  const cv = el('canvas'); cv.id = 'nav-canvas';
  const box = el('canvas'); box.id = 'nav-rect';
  wrap.append(cv, box);
  const controls = el('div', 'nav-ctrl');
  const zoomOut = el('button', 'pbtn', '−'); zoomOut.title = 'zoom out';
  const fitBtn = el('button', 'pbtn', 'FIT'); fitBtn.title = 'fit on screen';
  const zoomIn = el('button', 'pbtn', '+'); zoomIn.title = 'zoom in';
  const zoomPct = el('span', 'opt-val', '—');
  controls.append(zoomOut, fitBtn, zoomIn, zoomPct);
  bodyEl.append(wrap, controls);
  host.appendChild(p);
  const TW = 260, TH = 172;
  cv.width = TW; cv.height = TH;
  box.width = TW; box.height = TH;

  const metrics = () => {
    const D = app.doc;
    if (!D) return null;
    const scale = Math.min(TW / D.width, TH / D.height);
    const w = D.width * scale, h = D.height * scale;
    const ox = (TW - w) / 2, oy = (TH - h) / 2;
    return { D, scale, w, h, ox, oy };
  };

  const drawThumb = () => {
    const m = metrics();
    if (!m) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, TW, TH);
    ctx.fillStyle = '#131313';
    ctx.fillRect(m.ox - 1, m.oy - 1, m.w + 2, m.h + 2);
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(app.doc._compoCtx.canvas, m.ox, m.oy, m.w, m.h);
  };

  const drawRect = () => {
    const m = metrics();
    if (!m) return;
    const ctx = box.getContext('2d');
    ctx.clearRect(0, 0, TW, TH);
    const { zoom, panX, panY } = app.view;
    const vw = app.viewCanvas.width / app.dpr / zoom, vh = app.viewCanvas.height / app.dpr / zoom;
    const x0 = (Math.max(0, -panX / zoom)) * m.scale + m.ox;
    const y0 = (Math.max(0, -panY / zoom)) * m.scale + m.oy;
    const w = Math.min(m.w, vw * m.scale), h = Math.min(m.h, vh * m.scale);
    ctx.strokeStyle = '#0d84ff';
    ctx.strokeRect(x0 + .5, y0 + .5, w - 1, h - 1);
    zoomPct.textContent = Math.round(zoom * 100) + '%';
  };

  const seek = (e) => {
    const m = metrics();
    if (!m) return;
    const r = box.getBoundingClientRect();
    const nx = clamp((e.clientX - r.left) * (TW / r.width), 0, TW);
    const ny = clamp((e.clientY - r.top) * (TH / r.height), 0, TH);
    const { zoom } = app.view;
    // center the viewport on the sampled point
    const dx = (nx - m.ox) / m.scale, dy = (ny - m.oy) / m.scale;
    app.view.panX = -dx * zoom + app.viewCanvas.width / app.dpr / 2;
    app.view.panY = -dy * zoom + app.viewCanvas.height / app.dpr / 2;
    app.requestRender();
  };
  box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); seek(e); });
  box.addEventListener('pointermove', (e) => { if (e.buttons & 1) seek(e); });
  zoomOut.addEventListener('click', () => { app.zoomAt(null, null, 1 / 1.25); app.requestRender(); });
  zoomIn.addEventListener('click', () => { app.zoomAt(null, null, 1.25); app.requestRender(); });
  fitBtn.addEventListener('click', () => { app.fitView(); app.requestRender(); });

  app.renderNav = () => {
    if (!app.doc) return;
    const mode = bodyEl.closest('.panel-mode'); // visibility lives on the tab body, not this shell
    if (!mode?.classList.contains('on')) return;
    if (app._navThumbDirty) {
      app._navThumbDirty = false;
      drawThumb();
    }
    drawRect();
  };
}

/* ---- histogram panel ------------------------------------------------------ */

/* luminance (or RGB) histogram from a 256×160 downsample of the composite */
function buildHistogramPanel(app, host) {
  const [p, bodyEl] = panelShell('histogram', 'HISTOGRAM');
  const seg = el('div', 'seg hist-mode');
  const lumBtn = el('button', 'on', 'LUM'); lumBtn.type = 'button';
  const rgbBtn = el('button', null, 'RGB'); rgbBtn.type = 'button';
  seg.append(lumBtn, rgbBtn);
  const cv = el('canvas'); cv.id = 'hist-canvas';
  const info = el('div', 'opt-val hist-info', '—');
  bodyEl.append(seg, cv, info);
  host.appendChild(p);
  cv.width = 256; cv.height = 128;
  let mode = 'lum';
  const setMode = (m) => {
    mode = m;
    lumBtn.classList.toggle('on', m === 'lum');
    rgbBtn.classList.toggle('on', m === 'rgb');
    app._histogramDirty = true;
    app.requestRender();
  };
  lumBtn.addEventListener('click', () => setMode('lum'));
  rgbBtn.addEventListener('click', () => setMode('rgb'));

  app.renderHistogram = () => {
    const D = app.doc;
    if (!D) return;
    if (!bodyEl.closest('.panel-mode')?.classList.contains('on')) return; // visibility lives on the tab body
    const samp = makeCanvas(256, 160);
    const sctx = samp.getContext('2d', { willReadFrequently: true });
    try { sctx.drawImage(D._compoCtx.canvas, 0, 0, 256, 160); } catch (_) { return; }
    const data = sctx.getImageData(0, 0, 256, 160).data;
    const bins = mode === 'lum'
      ? { lum: new Uint32Array(256) }
      : { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) };
    let sum = 0, area = 0;
    const lums = new Uint8Array(256 * 160);
    for (let i = 0, px = 0; i < data.length; i += 4, px++) {
      const a = data[i + 3];
      if (!a) continue;
      lums[area] = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
      sum += lums[area]; area++;
      if (mode === 'lum') bins.lum[lums[area - 1]]++;
      else { bins.r[data[i]]++; bins.g[data[i + 1]]++; bins.b[data[i + 2]]++; }
    }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#191919';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    for (let g = 1; g < 4; g++) {
      ctx.beginPath(); ctx.moveTo(g * 64 + .5, 0); ctx.lineTo(g * 64 + .5, cv.height); ctx.stroke();
    }
    const histMax = arr => Math.max(1, ...arr.slice(1, 255)); // clip outliers at the extremes
    if (mode === 'lum') {
      const peak = histMax(bins.lum);
      ctx.fillStyle = 'rgba(212,212,212,.85)';
      const step = cv.width / 256;
      for (let v = 0; v < 256; v++) {
        const bh = Math.round(Math.sqrt(bins.lum[v] / peak) * (cv.height - 4));
        ctx.fillRect(v * step, cv.height - bh, step, bh);
      }
    } else {
      const peak = Math.max(histMax(bins.r), histMax(bins.g), histMax(bins.b));
      const step = cv.width / 256;
      ctx.globalCompositeOperation = 'lighter';
      [['r', 'rgba(220,70,70,.6)'], ['g', 'rgba(70,200,90,.6)'], ['b', 'rgba(80,130,255,.6)']].forEach(([k, color]) => {
        ctx.fillStyle = color;
        for (let v = 0; v < 256; v++) {
          const bh = Math.round(Math.sqrt(bins[k][v] / peak) * (cv.height - 4));
          ctx.fillRect(v * step, cv.height - bh, step, bh);
        }
      });
      ctx.globalCompositeOperation = 'source-over';
    }
    if (area) {
      const mean = Math.round(sum / area);
      const mid = Array.from(lums.slice(0, area)).sort((x, y) => x - y)[area >> 1];
      info.textContent = `MEAN ${mean} · MEDIAN ${mid} · PIXELS ${(area).toLocaleString()}@¼`;
    } else info.textContent = 'EMPTY';
  };
}

export function buildPanels(app) {
  const host = $('#panels');
  host.innerHTML = '';
  /* two stacked tab groups, Photoshop-style: Color/Brush/Signal on top,
     Navigator/Layers/Histogram/History below (the layers list is the tall one) */
  const topTabs = el('div', 'panel-tabs');
  const bottomTabs = el('div', 'panel-tabs');
  host.append(topTabs, bottomTabs);
  const labels = { color: 'COLOR', brush: 'BRUSH', signal: 'SIGNAL RACK', navigator: 'NAVIGATOR', layers: 'LAYERS', histogram: 'HISTOGRAM', history: 'HISTORY' };
  const groups = {
    top: { order: ['color', 'brush', 'signal'], tabs: {}, current: 'color' },
    bottom: { order: ['navigator', 'layers', 'histogram', 'history'], tabs: {}, current: 'layers' },
  };
  const bodies = {};
  for (const [name, g] of Object.entries(groups)) {
    for (const mode of g.order) {
      const tab = el('button', mode === g.current ? 'on' : null, labels[mode]);
      tab.type = 'button';
      const bodyEl = el('div', 'panel-mode' + (mode === g.current ? ' on' : ''));
      bodyEl.dataset.mode = mode;
      g.tabs[mode] = tab;
      bodies[mode] = bodyEl;
      tab.addEventListener('click', () => activate(name, mode));
      host.appendChild(bodyEl);
    }
  }
  topTabs.append(groups.top.tabs.color, groups.top.tabs.brush, groups.top.tabs.signal);
  bottomTabs.append(groups.bottom.tabs.navigator, groups.bottom.tabs.layers, groups.bottom.tabs.histogram, groups.bottom.tabs.history);
  const activate = (groupName, mode) => {
    const g = groups[groupName];
    g.current = mode;
    for (const m of g.order) {
      g.tabs[m].classList.toggle('on', m === mode);
      bodies[m].classList.toggle('on', m === mode);
    }
    if (mode === 'signal') app.refreshActions?.();
    if (mode === 'layers') app.refreshLayers?.();
    if (mode === 'navigator') app._navThumbDirty = true;
    if (mode === 'histogram') app._histogramDirty = true;
  };
  app.activatePanelMode = (mode) => {
    if (groups.top.order.includes(mode)) return activate('top', mode);
    if (groups.bottom.order.includes(mode)) return activate('bottom', mode);
  };
  buildColorPanel(app, bodies.color);
  buildBrushPanel(app, bodies.brush);
  buildNavigatorPanel(app, bodies.navigator);
  buildLayersPanel(app, bodies.layers);
  buildHistogramPanel(app, bodies.histogram);
  buildHistoryPanel(app, bodies.history);
  buildActionsPanel(app, bodies.signal);
}
