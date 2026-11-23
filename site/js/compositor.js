import { makeCanvas, copyCanvas } from './canvas.js';

let adjustmentFilters = [];
export function setAdjustFilters(filters) { adjustmentFilters = filters || []; }

export function adjustDefaults(filterId) {
  const filter = adjustmentFilters.find(item => item.id === filterId);
  return Object.fromEntries((filter?.params || []).map(param => [param.key, param.def]));
}

const visible = layer => layer.visible && layer.opacity > 0;
const blendMode = layer => layer.blend === 'pass-through' ? 'source-over' : layer.blend;

function blend(ctx, canvas, layer) {
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = blendMode(layer);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

function maskCanvas(canvas, mask) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

function samePixels(first, second) {
  const { width, height } = first;
  const rows = Math.max(1, Math.floor(262144 / width));
  const firstCtx = first.getContext('2d'), secondCtx = second.getContext('2d');
  for (let y = 0; y < height; y += rows) {
    const count = Math.min(rows, height - y);
    const a = new Uint32Array(firstCtx.getImageData(0, y, width, count).data.buffer);
    const b = new Uint32Array(secondCtx.getImageData(0, y, width, count).data.buffer);
    if (!a.every((pixel, index) => pixel === b[index])) return false;
  }
  return true;
}

export class Compositor {
  #frame;
  #frameMode = null;
  #frameComplete = false;
  #jobs = new Map();
  #bypassed = new Set();
  #rackCache = new WeakMap();
  #groupCache = new WeakMap();
  #nextContentId = 0;

  constructor(doc) {
    this.doc = doc;
  }

  get canvas() {
    const { width, height } = this.doc;
    if (!this.#frame || this.#frame.width !== width || this.#frame.height !== height) {
      this.#frame = makeCanvas(width, height);
    }
    return this.#frame;
  }

  get context() { return this.canvas.getContext('2d', { willReadFrequently: true }); }
  get complete() { return this.#frameComplete; }
  get pending() { return this.#jobs.values().next().value ?? null; }

  invalidate() {
    this.#frameMode = null;
    this.#frameComplete = false;
    for (const owner of this.#jobs.keys()) this.#finishJob(owner);
  }

  setBypass(owner, bypass) {
    if (this.#bypassed.has(owner) === bypass) return;
    if (bypass) this.#bypassed.add(owner);
    else this.#bypassed.delete(owner);
    this.invalidate();
  }

  compose(preview = false, onReady = null) {
    const mode = preview ? 'preview' : 'full';
    if (this.#frameMode === mode || (preview && this.#frameMode === 'full' && !this.#bypassed.size)) {
      return this.canvas;
    }
    if (!preview) this.invalidate();
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const options = { preview, onReady };
    const tree = this.#render(this.doc.layers, ctx, options);
    const frame = this.#applyRack(this.doc, this.canvas, tree, options);
    if (frame.canvas !== this.canvas) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(frame.canvas, 0, 0);
    }
    this.#frameMode = mode;
    this.#frameComplete = frame.complete;
    return this.canvas;
  }

  mergePair(list, index, replacement) {
    const pair = list.slice(index - 1, index + 1);
    this.#render(pair, replacement.ctx, {});
    return this.#preservesFrame(list, index - 1, 2, replacement);
  }

  bakeGroup(list, index, replacement, keepMask) {
    const group = list[index];
    const content = this.#layerContent(group, {}, !keepMask);
    replacement.ctx.drawImage(content.canvas, 0, 0);
    // Pass Through can depend on pixels outside the group even when its own blend is Normal after rasterizing.
    return group.blend !== 'pass-through' || this.#preservesFrame(list, index, 1, replacement);
  }

  #preservesFrame(list, index, count, replacement) {
    // Check the replacement in context before the document-wide rack can obscure pixel differences.
    const original = makeCanvas(this.doc.width, this.doc.height);
    const candidate = makeCanvas(this.doc.width, this.doc.height);
    this.#render(this.doc.layers, original.getContext('2d', { willReadFrequently: true }), {});
    this.#render(this.doc.layers, candidate.getContext('2d', { willReadFrequently: true }), {
      substitution: { list, layers: [...list.slice(0, index), replacement, ...list.slice(index + count)] },
    });
    return samePixels(original, candidate);
  }

  #render(layers, ctx, options) {
    const list = layers === options.substitution?.list ? options.substitution.layers : layers;
    const lastClipped = list.findLastIndex(layer => visible(layer) && layer.clipped);
    let clipBase = null;
    let complete = true;
    const key = [];
    for (let index = 0; index < list.length; index++) {
      const layer = list[index];
      if (!visible(layer)) continue;
      const laterClipped = index < lastClipped;
      if (layer.type === 'group' && layer.blend === 'pass-through' && layer.opacity >= 1
        && !layer.mask && !layer.effects?.length && !layer.clipped && !laterClipped) {
        const result = this.#render(layer.children, ctx, options);
        key.push(result.key);
        complete &&= result.complete;
        continue;
      }

      const content = layer.type === 'adjust'
        ? this.#adjust(layer, ctx.canvas, complete)
        : this.#layerContent(layer, options);
      if (layer.clipped && clipBase) {
        if (layer.blend !== 'source-over' || layer.opacity < 1) {
          const clipped = copyCanvas(ctx.canvas);
          blend(clipped.getContext('2d'), content.canvas, layer);
          maskCanvas(clipped, clipBase);
          ctx.drawImage(clipped, 0, 0);
        } else {
          const clipped = copyCanvas(content.canvas);
          maskCanvas(clipped, clipBase);
          ctx.drawImage(clipped, 0, 0);
        }
      } else {
        blend(ctx, content.canvas, layer);
      }
      if (laterClipped && !layer.clipped) clipBase = copyCanvas(content.canvas);
      key.push([layer.id, layer.opacity, layer.blend, layer.clipped, content.key]);
      complete &&= content.complete;
    }
    return { key, complete };
  }

  #layerContent(layer, options, applyMask = true) {
    const input = layer.type === 'group'
      ? this.#groupContents(layer, options)
      : { canvas: layer.canvas, key: String(layer.revision), complete: true };
    const content = this.#applyRack(layer, input.canvas, input, options);
    return applyMask ? this.#applyMask(layer, content) : content;
  }

  #groupContents(group, options) {
    const { width, height, maskRevision } = this.doc;
    const render = () => {
      const canvas = makeCanvas(width, height);
      return { ...this.#render(group.children, canvas.getContext('2d', { willReadFrequently: true }), options), canvas };
    };
    if (options.substitution) return render();

    const nodeState = layer => [
      layer.id, layer.revision, layer.visible, layer.opacity, layer.blend, layer.clipped,
      layer.mask ? [layer.maskEnabled, layer.maskRevision] : null,
      layer.filter, layer.params, layer.effects, layer.signalSeed,
      Boolean(options.preview && this.#bypassed.has(layer)),
      layer.children?.map(nodeState),
    ];
    const signature = JSON.stringify([width, height, maskRevision, Boolean(options.preview), group.children.map(nodeState)]);
    const cached = this.#groupCache.get(group);
    if (cached?.signature === signature) return cached.content;
    const content = render();
    if (content.complete) this.#groupCache.set(group, { signature, content });
    return content;
  }

  #adjust(layer, backdrop, complete) {
    const filter = adjustmentFilters.find(item => item.id === layer.filter);
    const key = [layer.filter, layer.params];
    if (!filter) return { canvas: backdrop, key, complete };
    const canvas = copyCanvas(backdrop);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    filter.apply(image, canvas.width, canvas.height, { ...adjustDefaults(layer.filter), ...layer.params });
    ctx.putImageData(image, 0, 0);
    // The preceding draw keys already describe the backdrop for later siblings.
    return this.#applyMask(layer, { canvas, key, complete });
  }

  #applyMask(layer, content) {
    if (!layer.mask || !layer.maskEnabled) return content;
    const canvas = copyCanvas(content.canvas);
    maskCanvas(canvas, layer.mask);
    return { ...content, canvas, key: [content.key, layer.maskRevision] };
  }

  #applyRack(owner, source, input, { preview, onReady }) {
    const { effects, signalSeed } = owner;
    const { effectProcessor, effectProcessorAsync, maskRevision } = this.doc;
    const raw = { ...input, canvas: source };
    if (!effects?.length || !effectProcessor || (preview && this.#bypassed.has(owner))) return raw;
    if (!input.complete) return raw;

    // Full-resolution and asynchronous preview stages can contain different pixels.
    const inputKey = JSON.stringify([source.width, source.height, input.key, maskRevision]);
    const key = JSON.stringify([inputKey, signalSeed, effects]);
    let caches = this.#rackCache.get(owner);
    if (!caches) { caches = {}; this.#rackCache.set(owner, caches); }
    const full = caches.full;
    if (full?.effectKey === key) return full;
    const mode = preview && effectProcessorAsync ? 'preview' : 'full';
    const previous = caches[mode];
    if (previous?.effectKey === key) return previous;
    const stages = previous?.inputKey === inputKey
      ? { keys: previous.stages.keys, stages: previous.stages.stages?.slice() }
      : { stages: [] };
    const canvas = copyCanvas(source);
    const ready = { canvas, key: ++this.#nextContentId, effectKey: key, inputKey, stages, complete: true };
    if (mode === 'full') {
      effectProcessor(canvas, effects, signalSeed, stages);
      caches.full = ready;
      return ready;
    }

    if (this.#jobs.get(owner)?.key !== key) {
      this.#finishJob(owner);
      const job = { key };
      this.#jobs.set(owner, job);
      this.doc.onProcessingChange?.(true);
      const accept = pixels => {
        if (this.#jobs.get(owner) !== job) return;
        this.#finishJob(owner);
        if (pixels) {
          const ctx = canvas.getContext('2d');
          const image = ctx.createImageData(canvas.width, canvas.height);
          image.data.set(pixels);
          ctx.putImageData(image, 0, 0);
        } else {
          effectProcessor(canvas, effects, signalSeed, stages);
        }
        caches.preview = ready;
        this.#frameMode = null;
        this.compose(true, onReady);
        onReady?.();
      };
      effectProcessorAsync(canvas, effects, signalSeed, stages).then(accept, () => accept(null));
    }
    return { ...raw, complete: false };
  }

  #finishJob(owner) {
    if (this.#jobs.delete(owner)) this.doc.onProcessingChange?.(false);
  }
}
