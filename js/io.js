/* DEADPIXEL io — .dpx project format (zip), export, import, autosave.
   .dpx = zip{ doc.json, layers/<id>.png } — fflate global from vendor. */

import { Doc, Layer, TextLayer, makeCanvas } from './engine.js';

const FORMAT_VERSION = 1;
const MAX_DIMENSION = 32768;
const MAX_PIXELS = 128 * 1024 * 1024;
const MAX_LAYERS = 256;

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('Could not encode layer image')); return; }
      try { resolve(new Uint8Array(await blob.arrayBuffer())); }
      catch (error) { reject(error); }
    }, 'image/png');
  });
}

let encodeWorker = null;
let encodeJobId = 0;
const encodeJobs = new Map();

function getEncodeWorker() {
  if (encodeWorker || typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') return encodeWorker;
  try {
    encodeWorker = new Worker(new URL('./encode-worker.js', import.meta.url));
    encodeWorker.onmessage = ({ data }) => {
      const job = encodeJobs.get(data.id);
      if (!job) return;
      encodeJobs.delete(data.id);
      data.error ? job.fallback() : job.resolve(new Uint8Array(data.buffer));
    };
    encodeWorker.onerror = () => {
      for (const job of encodeJobs.values()) job.fallback();
      encodeJobs.clear();
      encodeWorker?.terminate(); encodeWorker = null;
    };
  } catch (_) { encodeWorker = null; }
  return encodeWorker;
}

async function canvasToPngBytesAsync(canvas) {
  const worker = getEncodeWorker();
  if (!worker) return canvasToPngBytes(canvas);
  const bitmap = await createImageBitmap(canvas);
  const id = ++encodeJobId;
  return new Promise((resolve, reject) => {
    const fallback = () => canvasToPngBytes(canvas).then(resolve, reject);
    encodeJobs.set(id, { resolve, reject, fallback });
    worker.postMessage({ id, bitmap }, [bitmap]);
  });
}

const autosaveLayerCache = new WeakMap();

export function validateProjectMeta(meta) {
  if (!meta || meta.app !== 'DEADPIXEL') throw new Error('not a DEADPIXEL file');
  if (!Number.isInteger(meta.version) || meta.version < 1 || meta.version > FORMAT_VERSION) {
    throw new Error('unsupported DEADPIXEL project version');
  }
  const { width, height } = meta;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('invalid or oversized project dimensions');
  }
  if (!Array.isArray(meta.layers) || meta.layers.length > MAX_LAYERS) {
    throw new Error('invalid or oversized layer list');
  }
  for (const layer of meta.layers) {
    if (!layer || !['raster', 'text'].includes(layer.type) || typeof layer.id !== 'string') {
      throw new Error('invalid layer metadata');
    }
  }
  return meta;
}

export async function serializeDoc(doc, options = {}) {
  const meta = {
    app: 'DEADPIXEL', version: FORMAT_VERSION,
    name: doc.name, width: doc.width, height: doc.height,
    activeIndex: doc.activeIndex,
    effects: doc.effects || [],
    signalSeed: doc.signalSeed >>> 0,
    layers: [],
  };
  const files = {};
  for (const l of doc.layers) {
    const entry = {
      id: l.id, name: l.name, type: l.type,
      visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked,
      effects: l.effects || [], signalSeed: l.signalSeed >>> 0,
    };
    if (l.type === 'text') entry.text = { ...l.t };
    else {
      let bytes = options.incremental ? autosaveLayerCache.get(l) : null;
      if (!bytes || bytes.revision !== l.revision) {
        bytes = { revision: l.revision, data: await canvasToPngBytesAsync(l.canvas) };
        if (options.incremental) autosaveLayerCache.set(l, bytes);
      }
      files['layers/' + l.id + '.png'] = bytes.data;
    }
    meta.layers.push(entry);
  }
  files['doc.json'] = new TextEncoder().encode(JSON.stringify(meta));
  return files;
}

let zipWorker = null;
let zipJobId = 0;
const zipJobs = new Map();

function getZipWorker() {
  if (zipWorker || typeof Worker === 'undefined') return zipWorker;
  try {
    zipWorker = new Worker(new URL('./io-worker.js', import.meta.url));
    zipWorker.onmessage = ({ data }) => {
      const job = zipJobs.get(data.id);
      if (!job) return;
      zipJobs.delete(data.id);
      data.error ? job.reject(new Error(data.error)) : job.resolve(new Uint8Array(data.buffer));
    };
    zipWorker.onerror = (event) => {
      for (const job of zipJobs.values()) {
        try { job.resolve(fflate.zipSync(job.files, { level: 6 })); }
        catch (error) { job.reject(error); }
      }
      zipJobs.clear();
      zipWorker?.terminate();
      zipWorker = null;
    };
  } catch (_) { zipWorker = null; }
  return zipWorker;
}

export function zipFilesAsync(files) {
  const worker = getZipWorker();
  if (!worker) return Promise.resolve(fflate.zipSync(files, { level: 6 }));
  const id = ++zipJobId;
  return new Promise((resolve, reject) => {
    zipJobs.set(id, { resolve, reject, files });
    // Keep the originals available for an automatic main-thread fallback.
    worker.postMessage({ id, files });
  });
}

export async function saveDpx(doc) {
  const files = await serializeDoc(doc);
  const zipped = await zipFilesAsync(files);
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
  if (!files || !files['doc.json']) throw new Error('not a DEADPIXEL file');
  const meta = validateProjectMeta(JSON.parse(new TextDecoder().decode(files['doc.json'])));
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
    layer.effects = Array.isArray(le.effects) ? le.effects : [];
    if (Number.isFinite(le.signalSeed)) layer.signalSeed = le.signalSeed >>> 0;
    doc.layers.push(layer);
  }
  if (!doc.layers.length) doc.layers.push(new Layer(meta.width, meta.height, 'Background'));
  doc.activeIndex = Math.min(meta.activeIndex || 0, doc.layers.length - 1);
  doc.effects = Array.isArray(meta.effects) ? meta.effects : [];
  if (Number.isFinite(meta.signalSeed)) doc.signalSeed = meta.signalSeed >>> 0;
  doc.dirty = false;
  return doc;
}

export async function openDpx(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength > 1024 * 1024 * 1024) {
    throw new Error('invalid or oversized DEADPIXEL file');
  }
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
let autosaveInFlight = null;
let autosavePending = null;
let autosaveReporter = () => {};
export const setAutosaveReporter = (reporter) => { autosaveReporter = typeof reporter === 'function' ? reporter : () => {}; };

async function writeAutosave(doc) {
  autosaveReporter('saving');
  try {
    const files = await serializeDoc(doc, { incremental: true });
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const get = store.get('history');
      get.onsuccess = () => {
        const history = Array.isArray(get.result) ? get.result : [];
        history.push({ when: Date.now(), name: doc.name, files });
        store.put(history.slice(-3), 'history');
        store.delete('last');
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    d.close();
    autosaveReporter('saved');
  } catch (e) { autosaveReporter('error', e); }
}

export function autosave(doc) {
  if (autosaveInFlight) {
    autosavePending = doc;
    return autosaveInFlight;
  }
  autosaveInFlight = writeAutosave(doc).finally(() => {
    autosaveInFlight = null;
    const pending = autosavePending;
    autosavePending = null;
    if (pending) autosave(pending);
  });
  return autosaveInFlight;
}
export async function loadAutosave() {
  try {
    const d = await db();
    const rec = await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get('history');
      req.onsuccess = () => {
        const history = req.result;
        if (Array.isArray(history) && history.length) { resolve(history[history.length - 1]); return; }
        const legacy = store.get('last');
        legacy.onsuccess = () => resolve(legacy.result);
        legacy.onerror = () => reject(legacy.error);
      };
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
      tx.objectStore(STORE).delete('history');
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    d.close();
  } catch (e) { /* ignore */ }
}
