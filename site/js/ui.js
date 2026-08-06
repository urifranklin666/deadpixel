/* DEADPIXEL ui — menus, options bar, panels, dialogs, commands. */

import { BLEND_MODES, Selection, hexToRgb, rgbToHex, hsvToRgb, rgbToHsv, clamp, makeCanvas } from './engine.js';
import { TOOLS, toolById, iconSvg } from './tools.js';
import { BRUSH_PRESETS, renderTip, STAMPS, renderStamp } from './brushes.js';
import { FILTERS, filterById, defaultParams, applyFilterToLayer, BUILTIN_ACTIONS } from './filters.js';
import { saveDpx, openDpx, exportDoc, downloadBlob, loadImageFile, docFromImage } from './io.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

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
  if (layer.locked) { toast('LAYER IS LOCKED', true); return; }
  const f = filterById(filterId);
  if (!f) return;
  const params = { ...defaultParams(filterId) };

  if (!f.params.length) {
    D.withLayerSnapshot(f.name, layer, () => applyFilterToLayer(D, layer, filterId, params));
    app.noteFilter(filterId, params);
    app.requestRender();
    return;
  }

  const before = makeCanvas(layer.canvas.width, layer.canvas.height);
  before.getContext('2d').drawImage(layer.canvas, 0, 0);
  let previewTimer = null;
  const preview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      layer.ctx.drawImage(before, 0, 0);
      applyFilterToLayer(D, layer, filterId, params);
      D.changed();
      app.requestRender();
    }, 60);
  };
  const restore = () => {
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
    D.withLayerSnapshot(f.name, layer, () => applyFilterToLayer(D, layer, filterId, params));
    app.noteFilter(filterId, params);
  }
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
    body.appendChild(el('div', 'about-osd', 'RASTER SURGERY SUITE · v1.1'));
    body.appendChild(el('div', 'dlg-note',
      'A full-blooded image editor running entirely in your browser. Nothing you make here ever leaves your machine — no uploads, no accounts, no telemetry. Just you and the pixels.<br><br>' +
      'A transmission from <a href="https://deadplug.digital" target="_blank" rel="noopener">deadplug.digital</a> · CH.404'));
  }, [{ label: 'Close', primary: true, value: () => true }]);
}
function shortcutsDialog() {
  const rows = [
    ['V', 'Move'], ['M', 'Marquee'], ['L', 'Lasso'], ['W', 'Magic wand'], ['Q', 'Select by color'], ['C', 'Crop'],
    ['I', 'Eyedropper'], ['B', 'Brush'], ['N', 'Pencil'], ['E', 'Eraser'], ['S', 'Clone stamp'],
    ['U', 'Smudge'], ['G', 'Fill / Gradient'], ['P', 'Shape'], ['K', 'Stamp'], ['T', 'Text'],
    ['H', 'Hand'], ['Z', 'Zoom'], ['X', 'Swap colors'], ['[ ]', 'Brush size'],
    ['Space+drag', 'Pan'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
    ['Ctrl+T', 'Free transform'], ['Ctrl+A / Ctrl+D', 'Select all / Deselect'],
    ['Ctrl+Shift+I', 'Invert selection'], ['Ctrl+J', 'Duplicate layer'],
    ['Ctrl+E', 'Merge down'], ['Ctrl+F', 'Repeat last filter'],
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
      '<a href="downloads/DeadPixel-Setup-1.0.0.exe" download>⭳ DeadPixel-Setup-1.0.0.exe</a>'));
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

/* ============================ commands ============================ */
export function buildCommands(app) {
  const D = () => app.doc;
  const needDoc = (fn) => () => { if (app.doc) fn(); };
  const cmds = {
    'file.new': { label: 'New…', key: 'Ctrl+Alt+N', run: () => newDocDialog(app) },
    'file.open': { label: 'Open… (.dpx / image)', key: 'Ctrl+O', run: () => app.openFilePicker(false) },
    'file.place': { label: 'Import As Layer…', key: null, run: needDoc(() => app.openFilePicker(true)) },
    'file.save': { label: 'Save Project (.dpx)', key: 'Ctrl+S', run: needDoc(async () => {
      const blob = await saveDpx(D());
      downloadBlob(blob, D().name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') + '.dpx');
      D().dirty = false; app.refreshTitle();
      toast('PROJECT SAVED — KEEP IT SOMEWHERE SAFE');
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
    'layer.merge': { label: 'Merge Down', key: 'Ctrl+E', run: needDoc(() => D().mergeDown()) },
    'layer.flatten': { label: 'Flatten Image', key: null, run: needDoc(() => D().flatten()) },
    'layer.rasterize': { label: 'Rasterize Text', key: null, run: needDoc(() => D().rasterizeLayer()) },
    'layer.up': { label: 'Move Layer Up', key: null, run: needDoc(() => D().moveLayer(D().activeIndex, D().activeIndex + 1)) },
    'layer.down': { label: 'Move Layer Down', key: null, run: needDoc(() => D().moveLayer(D().activeIndex, D().activeIndex - 1)) },

    'select.all': { label: 'Select All', key: 'Ctrl+A', run: needDoc(() => D().selectAll()) },
    'select.none': { label: 'Deselect', key: 'Ctrl+D', run: needDoc(() => D().deselect()) },
    'select.invert': { label: 'Invert Selection', key: 'Ctrl+Shift+I', run: needDoc(() => D().invertSelection()) },
    'select.bycolor': { label: 'Select By Color', key: 'Q', run: needDoc(() => app.setTool('colorsel')) },

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
    'help.about': { label: 'About DEADPIXEL', key: null, run: () => aboutDialog() },
    'help.home': { label: 'deadplug.digital ↗', key: null, run: () => window.open('https://deadplug.digital', '_blank') },
  };
  // adjustments + filters as commands
  for (const f of FILTERS) {
    cmds['fx.' + f.id] = { label: f.name + (f.params.length ? '…' : ''), key: null, run: needDoc(() => filterDialog(app, f.id)) };
  }
  return cmds;
}

const MENU_LAYOUT = [
  ['FILE', ['file.new', 'file.open', 'file.place', null, 'file.save', null, 'file.export.png', 'file.export.jpeg', 'file.export.webp', null, 'file.windows']],
  ['EDIT', ['edit.undo', 'edit.redo', null, 'edit.fill', 'edit.clear', null, 'edit.transform']],
  ['IMAGE', ['image.size', 'image.canvas', 'image.cropsel', null,
    { sub: 'ADJUSTMENTS', items: () => FILTERS.filter(f => f.group === 'adjust').map(f => 'fx.' + f.id) },
    null, 'image.rot90', 'image.rot270', 'image.rot180', 'image.fliph', 'image.flipv']],
  ['LAYER', ['layer.new', 'layer.dupe', 'layer.delete', null, 'layer.merge', 'layer.flatten', 'layer.rasterize', null, 'layer.up', 'layer.down']],
  ['SELECT', ['select.all', 'select.none', 'select.invert', null, 'select.bycolor']],
  ['FILTER', ['filter.repeat', null, { sub: 'ALL FILTERS', items: () => FILTERS.filter(f => f.group === 'filter').map(f => 'fx.' + f.id) }]],
  ['VIEW', ['view.zoomin', 'view.zoomout', 'view.fit', 'view.hundred', null, 'view.fullscreen']],
  ['HELP', ['help.shortcuts', 'help.about', null, 'file.windows', 'help.home']],
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
        buildItems(subDrop, id.items());
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
  const groupBreaks = new Set(['crop', 'brush', 'fill', 'text', 'hand']);
  for (const t of TOOLS) {
    if (groupBreaks.has(t.id)) bar.appendChild(el('div', 'tool-sep'));
    const b = el('button', 'tool-btn', iconSvg(t.icon));
    b.title = `${t.name} (${t.key.toUpperCase()})`;
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
      for (const f of app.fonts) {
        const o = el('option', null, f.family);
        o.value = f.family;
        o.style.fontFamily = `"${f.family}"`;
        o.style.fontSize = '15px';
        sel.appendChild(o);
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
  const [p, body] = panelShell('color', 'BLOOD BANK');
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
  const [p, body] = panelShell('brushes', 'BRUSH MORGUE');
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
  const [p, body] = panelShell('layers', 'STRATA');
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
    const b = el('button', 'pbtn', label); b.title = title;
    b.addEventListener('click', fn);
    btns.appendChild(b);
    return b;
  };
  mkBtn('+', 'new layer', () => app.doc?.addLayer());
  mkBtn('⧉', 'duplicate', () => app.doc?.duplicateLayer());
  mkBtn('▲', 'move up', () => app.doc?.moveLayer(app.doc.activeIndex, app.doc.activeIndex + 1));
  mkBtn('▼', 'move down', () => app.doc?.moveLayer(app.doc.activeIndex, app.doc.activeIndex - 1));
  mkBtn('⇓', 'merge down', () => app.doc?.mergeDown());
  const delBtn = mkBtn('🗑', 'delete layer', () => app.doc?.removeLayer());
  delBtn.classList.add('danger');
  body.append(head, list, btns);
  host.appendChild(p);

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

  let dragFrom = null;
  app.refreshLayers = () => {
    const D = app.doc;
    list.innerHTML = '';
    if (!D) return;
    const l = D.activeLayer;
    if (l) { blend.value = l.blend; op.value = Math.round(l.opacity * 100); opv.textContent = op.value; }
    // top layer first in UI
    for (let i = D.layers.length - 1; i >= 0; i--) {
      const layer = D.layers[i];
      const rowE = el('div', 'layer-row' + (i === D.activeIndex ? ' on' : ''));
      rowE.draggable = true;
      rowE.dataset.idx = i;
      const eye = el('button', 'layer-eye' + (layer.visible ? '' : ' off'), layer.visible ? '👁' : '—');
      eye.title = 'toggle visibility';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        D.changed();
      });
      const thumb = el('div', 'layer-thumb');
      const tc = el('canvas'); tc.width = 40; tc.height = 30;
      const tctx = tc.getContext('2d');
      const scale = Math.min(40 / D.width, 30 / D.height);
      tctx.imageSmoothingQuality = 'low';
      tctx.drawImage(layer.canvas, (40 - D.width * scale) / 2, (30 - D.height * scale) / 2, D.width * scale, D.height * scale);
      thumb.appendChild(tc);
      const nameE = el('div', 'layer-name', layer.name);
      nameE.title = 'double-click to rename';
      nameE.addEventListener('dblclick', () => {
        const inp = el('input');
        inp.value = layer.name;
        nameE.innerHTML = '';
        nameE.appendChild(inp);
        inp.focus(); inp.select();
        const done = () => { layer.name = inp.value || layer.name; app.refreshLayers(); };
        inp.addEventListener('blur', done);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
      });
      const tag = el('span', 'layer-tag', layer.type === 'text' ? 'T' : '');
      const lock = el('button', 'layer-lock' + (layer.locked ? ' locked' : ''), layer.locked ? '🔒' : '🔓');
      lock.title = 'lock layer';
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.locked = !layer.locked;
        app.refreshLayers();
      });
      rowE.append(eye, thumb, nameE, tag, lock);
      rowE.addEventListener('click', () => {
        D.activeIndex = i;
        D.changed();
      });
      rowE.addEventListener('dragstart', () => { dragFrom = i; rowE.classList.add('dragging'); });
      rowE.addEventListener('dragend', () => rowE.classList.remove('dragging'));
      rowE.addEventListener('dragover', (e) => {
        e.preventDefault();
        const r = rowE.getBoundingClientRect();
        rowE.classList.toggle('dropabove', e.clientY < r.top + r.height / 2);
        rowE.classList.toggle('dropbelow', e.clientY >= r.top + r.height / 2);
      });
      rowE.addEventListener('dragleave', () => rowE.classList.remove('dropabove', 'dropbelow'));
      rowE.addEventListener('drop', (e) => {
        e.preventDefault();
        const r = rowE.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2; // above in UI = higher index
        rowE.classList.remove('dropabove', 'dropbelow');
        if (dragFrom == null) return;
        let to = above ? i : i - 0;
        to = above ? i : Math.max(0, i - 1 + (dragFrom < i ? 1 : 0));
        if (dragFrom === i) return;
        // translate: dropping above row i → position after i in array ordering
        let target = above ? i + (dragFrom > i ? 1 : 0) : i - (dragFrom < i ? 0 : 0);
        target = clamp(above ? (dragFrom > i ? i + 1 : i) : (dragFrom > i ? i : i - 1), 0, D.layers.length - 1);
        D.moveLayer(dragFrom, target);
        dragFrom = null;
      });
      list.appendChild(rowE);
    }
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
  const activeHead = el('div', 'rack-head');
  activeHead.append(el('span', null, 'LIVE CHAIN'), el('span', 'rack-count', '0 MODULES'));
  const activeList = el('div', 'rack-active');
  const empty = el('div', 'rack-empty', 'CLEAN SIGNAL. ADD A RECIPE BELOW.');
  activeList.appendChild(empty);
  const presetHead = el('div', 'rack-head rack-presets');
  presetHead.append(el('span', null, 'RECIPE ARCHIVE'), el('span', null, 'NON-DESTRUCTIVE'));
  const list = el('div');
  const btns = el('div', 'panel-btns');
  const recBtn = el('button', 'pbtn', '● REC');
  const note = el('div', 'dlg-note');
  note.style.marginTop = '8px';
  note.textContent = 'Modules process the composite without touching layer pixels. They are saved inside the DPX project and included in exports.';
  btns.appendChild(recBtn);
  body.append(activeHead, activeList, presetHead, list, btns, note);
  host.appendChild(p);

  const userActions = () => JSON.parse(localStorage.getItem('deadpixel.actions') || '[]');
  const saveUserActions = (a) => localStorage.setItem('deadpixel.actions', JSON.stringify(a));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const changeStack = (label, mutate) => {
    const D = app.doc;
    if (!D) return;
    const next = clone(D.effects || []); mutate(next);
    D.replaceEffects(next, label); app.requestRender(); refreshActive();
  };

  const refreshActive = () => {
    const D = app.doc;
    activeList.innerHTML = '';
    const effects = D?.effects || [];
    activeHead.querySelector('.rack-count').textContent = effects.length + (effects.length === 1 ? ' MODULE' : ' MODULES');
    if (!effects.length) { activeList.appendChild(el('div', 'rack-empty', 'CLEAN SIGNAL. ADD A RECIPE BELOW.')); return; }
    effects.forEach((effect, index) => {
      const f = filterById(effect.filter);
      if (!f) return;
      const module = el('article', 'rack-module' + (effect.enabled === false ? ' bypassed' : ''));
      const top = el('div', 'rack-module-top');
      const power = el('button', 'rack-power', effect.enabled === false ? '○' : '●'); power.title = 'bypass module';
      const title = el('button', 'rack-module-name', `${String(index + 1).padStart(2, '0')}  ${f.name}`);
      const up = el('button', 'rack-move', '↑'), down = el('button', 'rack-move', '↓'), del = el('button', 'rack-delete', '×');
      power.addEventListener('click', () => changeStack('Bypass ' + f.name, s => { s[index].enabled = s[index].enabled === false; }));
      up.addEventListener('click', () => changeStack('Move signal module', s => { if (index) [s[index - 1], s[index]] = [s[index], s[index - 1]]; }));
      down.addEventListener('click', () => changeStack('Move signal module', s => { if (index < s.length - 1) [s[index + 1], s[index]] = [s[index], s[index + 1]]; }));
      del.addEventListener('click', () => changeStack('Remove ' + f.name, s => s.splice(index, 1)));
      top.append(power, title, up, down, del); module.appendChild(top);
      const controls = el('div', 'rack-controls');
      for (const param of f.params) {
        const rowEl = el('label', 'rack-param');
        const lab = el('span', null, param.label); const val = el('output', null, String(effect.params?.[param.key] ?? param.def));
        const input = el('input'); input.type = 'range'; input.min = param.min; input.max = param.max; input.step = param.step; input.value = effect.params?.[param.key] ?? param.def;
        let before = null;
        input.addEventListener('focus', () => { before ||= clone(D.effects); });
        input.addEventListener('pointerdown', () => { before = clone(D.effects); });
        input.addEventListener('input', () => {
          D.effects[index].params ||= {}; D.effects[index].params[param.key] = parseFloat(input.value);
          val.textContent = input.value; D.changed(); app.requestRender();
        });
        input.addEventListener('change', () => {
          const after = clone(D.effects); const start = before || clone(D.effects); before = null;
          D.effects = start; D.replaceEffects(after, f.name + ': ' + param.label); refreshActive();
        });
        rowEl.append(lab, val, input); controls.appendChild(rowEl);
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
        changeStack('Add recipe: ' + action.name, stack => stack.push(...action.steps.map((step, i) => ({
          id: 'fx_' + Date.now().toString(36) + '_' + i,
          filter: step.filter, params: { ...defaultParams(step.filter), ...(step.params || {}) }, enabled: true,
        }))));
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

export function buildPanels(app) {
  const host = $('#panels');
  host.innerHTML = '';
  const tabs = el('div', 'panel-tabs');
  const editTab = el('button', 'on', 'LAYERS');
  const signalTab = el('button', null, 'SIGNAL RACK');
  tabs.append(editTab, signalTab); host.appendChild(tabs);
  const editHost = el('div', 'panel-mode on'); editHost.dataset.mode = 'edit';
  const signalHost = el('div', 'panel-mode'); signalHost.dataset.mode = 'signal';
  host.append(editHost, signalHost);
  const activate = (mode) => {
    editTab.classList.toggle('on', mode === 'edit'); signalTab.classList.toggle('on', mode === 'signal');
    editHost.classList.toggle('on', mode === 'edit'); signalHost.classList.toggle('on', mode === 'signal');
    if (mode === 'signal') app.refreshActions?.();
  };
  app.activatePanelMode = activate;
  editTab.addEventListener('click', () => activate('edit')); signalTab.addEventListener('click', () => activate('signal'));
  buildColorPanel(app, editHost);
  buildBrushPanel(app, editHost);
  buildLayersPanel(app, editHost);
  buildHistoryPanel(app, editHost);
  buildActionsPanel(app, signalHost);
}
