/* DEADPIXEL io — .dpx project format (zip), export, import, autosave.
   .dpx = zip{ doc.json, layers/<id>.png } — fflate global from vendor. */

import { Doc, Layer, TextLayer, makeCanvas } from './engine.js';

const FORMAT_VERSION = 1;

function canvasToPngBytes(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

export async function serializeDoc(doc) {
  const meta = {
    app: 'DEADPIXEL', version: FORMAT_VERSION,
    name: doc.name, width: doc.width, height: doc.height,
    activeIndex: doc.activeIndex,
    layers: [],
  };
  const files = {};
  for (const l of doc.layers) {
    const entry = {
      id: l.id, name: l.name, type: l.type,
      visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked,
    };
    if (l.type === 'text') entry.text = { ...l.t };
    else files['layers/' + l.id + '.png'] = await canvasToPngBytes(l.canvas);
    meta.layers.push(entry);
  }
  files['doc.json'] = new TextEncoder().encode(JSON.stringify(meta));
  return files;
}

export async function saveDpx(doc) {
  const files = await serializeDoc(doc);
  const zipped = fflate.zipSync(files, { level: 6 });
  return new Blob([zipped], { type: 'application/zip' });
}

function loadImageFromBytes(bytes) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad layer image')); };
    img.src = url;
  });
}

export async function docFromFiles(files) {
  const meta = JSON.parse(new TextDecoder().decode(files['doc.json']));
  const doc = new Doc(meta.width, meta.height, { name: meta.name, bg: 'transparent' });
  doc.layers = [];
  for (const le of meta.layers) {
    let layer;
    if (le.type === 'text') {
      layer = new TextLayer(meta.width, meta.height, { name: le.name, t: le.text });
    } else {
      layer = new Layer(meta.width, meta.height, le.name);
      const bytes = files['layers/' + le.id + '.png'];
      if (bytes) {
        const img = await loadImageFromBytes(bytes);
        layer.ctx.drawImage(img, 0, 0);
      }
    }
    layer.visible = le.visible; layer.opacity = le.opacity;
    layer.blend = le.blend; layer.locked = le.locked;
    doc.layers.push(layer);
  }
  if (!doc.layers.length) doc.layers.push(new Layer(meta.width, meta.height, 'Background'));
  doc.activeIndex = Math.min(meta.activeIndex || 0, doc.layers.length - 1);
  doc.dirty = false;
  return doc;
}

export async function openDpx(arrayBuffer) {
  const files = fflate.unzipSync(new Uint8Array(arrayBuffer));
  if (!files['doc.json']) throw new Error('not a DEADPIXEL file');
  return docFromFiles(files);
}

/* ---- export ---- */
export function exportDoc(doc, format = 'png', quality = .92) {
  const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[format];
  const bg = format === 'jpeg' ? '#ffffff' : null;
  const canvas = doc.flattenedCanvas(bg);
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---- import ---- */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unsupported image')); };
    img.src = url;
  });
}

export function docFromImage(img, name) {
  const doc = new Doc(img.naturalWidth, img.naturalHeight, { name: name || 'IMPORTED', bg: 'transparent' });
  doc.layers[0].ctx.drawImage(img, 0, 0);
  doc.layers[0].name = 'Image';
  doc.dirty = false;
  return doc;
}

/* ---- autosave (IndexedDB, crash recovery) ---- */
const DB_NAME = 'deadpixel', STORE = 'autosave';
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function autosave(doc) {
  try {
    const files = await serializeDoc(doc);
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ when: Date.now(), name: doc.name, files }, 'last');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    d.close();
  } catch (e) { /* autosave is best-effort */ }
}
export async function loadAutosave() {
  try {
    const d = await db();
    const rec = await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('last');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    d.close();
    return rec || null;
  } catch (e) { return null; }
}
export async function clearAutosave() {
  try {
    const d = await db();
    await new Promise((resolve) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('last');
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    d.close();
  } catch (e) { /* ignore */ }
}
