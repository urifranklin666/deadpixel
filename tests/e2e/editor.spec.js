import { test, expect } from 'playwright/test';

test.beforeEach(async ({ page }) => {
  page._pageErrors = [];
  page.on('pageerror', (err) => { page._pageErrors.push(String(err)); });
  await page.addInitScript(() => sessionStorage.setItem('dp_booted', '1'));
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#boot')).toHaveClass(/off/);
});

test.afterEach(async ({ page }) => {
  expect(page._pageErrors).toEqual([]);
});

test('sample, brush stroke, undo, and redo form a complete editing flow', async ({ page }) => {
  await page.getByRole('button', { name: /MIDNIGHT BROADCAST/ }).click();
  await expect(page.locator('#doc-title')).toContainText('BROADCAST');
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#doc-title')).toHaveClass(/dirty/);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.deadpixel.doc.history.canRedo)).toBe(true);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => page.evaluate(() => window.deadpixel.doc.history.canUndo)).toBe(true);
});

test('Signal Rack resolves worker processing without leaving a stale frame', async ({ page }) => {
  await page.getByRole('button', { name: /SIGNAL LOST/ }).click();
  await page.evaluate(() => {
    const app = window.deadpixel;
    app.doc.replaceEffects([{ id: 'e2e', filter: 'noise', params: { amount: 20, mono: 1 } }], 'E2E signal', 404);
    app.requestRender();
  });
  await expect.poll(() => page.evaluate(() => window.deadpixel.doc._compoEffectsApplied)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.deadpixel.doc._compoPending === null)).toBe(true);
});

test('superseded Signal Rack jobs settle on the newest generation', async ({ page }) => {
  await page.getByRole('button', { name: /SIGNAL LOST/ }).click();
  await page.evaluate(() => {
    const app = window.deadpixel;
    for (let amount = 5; amount <= 35; amount += 5) {
      app.doc.effects = [{ id: 'rapid', filter: 'noise', params: { amount, mono: 1 } }];
      app.doc.changed(); app.requestRender();
    }
  });
  await expect.poll(() => page.evaluate(() => window.deadpixel.doc._compoPending === null)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.deadpixel.doc._compoEffectsApplied)).toBe(true);
  expect(await page.evaluate(() => window.deadpixel.doc.effects[0].params.amount)).toBe(35);
});

test('synchronous export invalidates pending preview and exports a complete frame', async ({ page }) => {
  await page.getByRole('button', { name: /SIGNAL LOST/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    app.doc.effects = [{ id: 'export', filter: 'gaussian-blur', params: { radius: 20 } }];
    app.doc.changed(); app.requestRender();
    const { exportDoc } = await import('/js/io.js');
    const blob = await exportDoc(app.doc, 'png');
    return { size: blob.size, pending: app.doc._compoPending, applied: app.doc._compoEffectsApplied };
  });
  expect(result.size).toBeGreaterThan(1000);
  expect(result.pending).toBeNull();
  expect(result.applied).toBe(true);
});

test('DPX save and project loader round-trip document structure', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const { saveDpx, openDpx } = await import('/js/io.js');
    const blob = await saveDpx(window.deadpixel.doc);
    const restored = await openDpx(await blob.arrayBuffer());
    return { width: restored.width, height: restored.height, layers: restored.layers.length, effects: restored.effects.length };
  });
  expect(result).toEqual({ width: 1280, height: 800, layers: 1, effects: 0 });
});

test('layer groups composite children and toggle visibility as a unit', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const pixels = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'TREE TEST' }));
    const D = app.doc, top = D.addLayer(null, 'TOP');
    top.ctx.fillStyle = '#00ff00'; top.ctx.fillRect(10, 10, 40, 40); top.revision++;
    D.changed();
    const group = D.groupFromActive();
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    const shown = px(30, 30), outside = px(58, 58);
    group.visible = false; D.changed();
    const hidden = px(30, 30);
    return { activeType: D.activeLayer.type, flat: D.flatLayers.map(l => l.name), shown, outside, hidden };
  });
  expect(pixels.activeType).toBe('raster'); // active selection stays on the moved child
  expect(pixels.flat).toEqual(['Background', 'Group 1', 'TOP']);
  expect(pixels.shown).toEqual([0, 255, 0, 255]);
  expect(pixels.outside).toEqual([0, 0, 0, 0]);
  expect(pixels.hidden).toEqual([0, 0, 0, 0]);
});

test('layer masks hide and reveal composited pixels', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'MASK TEST' }));
    const D = app.doc, layer = D.addLayer(null, 'MASKED');
    layer.ctx.fillStyle = '#0000ff'; layer.ctx.fillRect(0, 20, 64, 30); layer.revision++;
    D.addLayerMask(layer.id, 'reveal-all');
    D.withMaskSnapshot('Paint mask', layer, mctx => {
      mctx.globalCompositeOperation = 'destination-out';
      mctx.fillRect(0, 20, 64, 12);
    });
    D.changed();
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    const hidden = px(20, 25), shown = px(20, 45);
    D.toggleLayerMaskEnabled(layer.id);
    const restored = px(20, 25);
    return { maskPresent: !!layer.mask, hidden, shown, restored };
  });
  expect(result.maskPresent).toBe(true);
  expect(result.hidden).toEqual([0, 0, 0, 0]);
  expect(result.shown).toEqual([0, 0, 255, 255]);
  expect(result.restored).toEqual([0, 0, 255, 255]);
});

test('clipping masks confine a layer to the layer below', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'CLIP TEST' }));
    const D = app.doc;
    const base = D.activeLayer;
    base.ctx.fillStyle = '#ff0000'; base.ctx.fillRect(8, 8, 32, 32); base.revision++;
    const over = D.addLayer(null, 'OVER');
    over.ctx.fillStyle = '#00ffff'; over.ctx.fillRect(0, 0, 64, 64); over.revision++;
    D.setClipped(over.id, true);
    D.changed();
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    const inside = px(20, 20), outside = px(50, 50);
    D.releaseClip(over.id);
    const unclipped = px(50, 50);
    return { clipped: over.clipped, inside, outside, unclipped };
  });
  expect(result.clipped).toBe(false); // releaseClip ran at the end of the flow
  expect(result.inside).toEqual([0, 255, 255, 255]);
  expect(result.outside).toEqual([0, 0, 0, 0]);
  expect(result.unclipped).toEqual([0, 255, 255, 255]);
});

test('adjustment layers filter layers below and track parameter history', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'ADJ TEST' }));
    const D = app.doc;
    const base = D.activeLayer;
    base.ctx.fillStyle = '#406080'; base.ctx.fillRect(0, 0, 64, 64); base.revision++;
    const adj = D.addAdjustmentLayer('exposure', { stops: 5, offset: 0 });
    D.changed();
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    const exposed = px(30, 30);
    D.setAdjustParams(adj.id, { stops: -5, offset: 0 }, 'E2E exposure');
    D.changed();
    const darkened = px(30, 30);
    D.history.undo(); D.changed(); // params restored to +5 (layer stays)
    const undone = px(30, 30);
    adj.visible = false; D.changed();
    const off = px(30, 30);
    adj.visible = true; D.changed();
    const restored = px(30, 30);
    return {
      type: adj.type, name: adj.name,
      exposed, darkened, undone, off, restored,
      lastLabel: D.history.entries[D.history.index].label,
    };
  });
  expect(result.type).toBe('adjust');
  expect(result.name).toBe('exposure');
  expect(result.exposed).toEqual([91, 136, 181, 255]); // ×2^(5/10)
  expect(result.darkened).toEqual([45, 68, 91, 255]); // ×2^(-5/10)
  expect(result.undone).toEqual(result.exposed);
  expect(result.off).toEqual([64, 96, 128, 255]);
  expect(result.restored).toEqual(result.exposed);
  expect(result.lastLabel).toBe('New adjustment layer');
});

test('multiply blend composites pixel layers against the layers below', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'BLEND TEST' }));
    const D = app.doc;
    const base = D.activeLayer;
    base.ctx.fillStyle = '#ff0000'; base.ctx.fillRect(0, 0, 64, 64); base.revision++;
    const over = D.addLayer(null, 'MULT');
    over.ctx.fillStyle = '#00ffff'; over.ctx.fillRect(0, 0, 64, 64); over.revision++;
    over.blend = 'multiply';
    D.changed();
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    const multiplied = px(30, 30);
    over.blend = 'source-over'; D.changed();
    const plain = px(30, 30);
    return { multiplied, plain };
  });
  expect(result.multiplied).toEqual([0, 0, 0, 255]); // red × cyan
  expect(result.plain).toEqual([0, 255, 255, 255]);
});

test('pass-through groups blend children against the backdrop, not the buffer', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'PT TEST' }));
    const D = app.doc;
    const base = D.activeLayer;
    base.ctx.fillStyle = '#ff0000'; base.ctx.fillRect(0, 0, 64, 64); base.revision++;
    const gray = D.addLayer(null, 'GRAY');
    gray.ctx.fillStyle = '#808080'; gray.ctx.fillRect(0, 0, 64, 64); gray.revision++;
    gray.blend = 'multiply';
    const g = D.groupFromActive(); // group sits above Background; gray stays active
    const white = D.addLayer(null, 'GLINT'); // sibling of gray, inside the group
    white.ctx.fillStyle = '#ffffff'; white.ctx.fillRect(0, 0, 64, 64); white.revision++;
    white.opacity = .5;
    D.changed();
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    g.blend = 'multiply'; D.changed();
    const buffered = px(30, 30);
    g.blend = 'pass-through'; D.changed();
    const through = px(30, 30);
    return { childCount: g.children.length, buffered, through };
  });
  expect(result.childCount).toBe(2);
  // buffered: the group renders gray-ish, then multiplies with red → green channel dies
  expect(result.buffered[0]).toBeGreaterThanOrEqual(185);
  expect(result.buffered[1]).toBeLessThanOrEqual(6);
  // pass-through: white half-blends the multiply result → green channel lives
  expect(result.through[0]).toBeGreaterThanOrEqual(185);
  expect(result.through[1]).toBeGreaterThanOrEqual(120);
});

test('Navigator and Histogram panels paint live document views', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'PANEL TEST' }));
    const D = app.doc;
    D.activeLayer.ctx.fillStyle = '#e02020'; D.activeLayer.ctx.fillRect(8, 8, 48, 48); D.activeLayer.revision++;
    D.changed(); D.compose(); // panels sample D._compoCtx — build it now

    app.activatePanelMode('navigator'); // sets _navThumbDirty
    app.renderNav();
    const navCtx = document.getElementById('nav-canvas').getContext('2d');
    const center = navCtx.getImageData(130, 86, 1, 1).data;
    const boxCtx = document.getElementById('nav-rect').getContext('2d');
    const px = boxCtx.getImageData(0, 0, 260, 172).data;
    let accentCount = 0; // viewport box strokes in the signal red accent
    for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 90 && px[i + 2] < 90 && px[i + 3] > 0) accentCount++;
    const zoomPct = document.querySelector('#panel-navigator .nav-ctrl .opt-val').textContent;

    app.activatePanelMode('histogram'); // sets _histogramDirty
    app.renderHistogram();
    const hcv = document.getElementById('hist-canvas');
    const histPixels = hcv.getContext('2d').getImageData(0, 0, hcv.width, hcv.height).data;
    let histBars = 0;
    for (let i = 0; i < histPixels.length; i += 4) if (histPixels[i] > 120) histBars++; // bars ~184 over the #191919 bg
    const info = document.querySelector('#panel-histogram .hist-info').textContent;
    return {
      navCenterAlpha: center[3], navCenterRed: center[0],
      accentCount, zoomPct, histBars, info,
      panelTabs: Array.from(document.querySelectorAll('.panel-tabs button')).map(b => b.textContent),
    };
  });
  // navigator thumbnail shows the red square; viewport box strokes in the accent; zoom readout live
  expect(result.navCenterAlpha).toBeGreaterThan(128);
  expect(result.navCenterRed).toBeGreaterThan(150);
  expect(result.accentCount).toBeGreaterThan(20);
  expect(result.zoomPct).toMatch(/%$/);
  // histogram bars present; mean/median of #e02020 luminance ≈ 89
  expect(result.histBars).toBeGreaterThan(50);
  expect(result.info).toMatch(/MEAN (8[7-9]|90) · MEDIAN (8[7-9]|90) ·/);
  expect(result.panelTabs).toEqual(expect.arrayContaining(['NAVIGATOR', 'HISTOGRAM']));
});

test('v4 projects round-trip adjustment layers through DPX', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    const io = await import('/js/io.js');
    app.attachDoc(new Doc(64, 64, { name: 'V4 RP' }));
    const D = app.doc;
    const base = D.activeLayer;
    base.ctx.fillStyle = '#406080'; base.ctx.fillRect(0, 0, 64, 64); base.revision++;
    const adj = D.addAdjustmentLayer('exposure', { stops: 5, offset: 0 });
    D.addLayerMask(adj.id, 'reveal-all');
    D.withMaskSnapshot('Paint mask', adj, mctx => {
      mctx.globalCompositeOperation = 'destination-out';
      mctx.fillRect(0, 0, 64, 16); // top strip stays unadjusted
    });
    D.changed();
    const px = (doc, x, y) => { doc.compose(); return Array.from(doc._compoCtx.getImageData(x, y, 1, 1).data); };
    const before = { shown: px(D, 30, 30), strip: px(D, 30, 8) };
    const files = await io.serializeDoc(D);
    const meta = JSON.parse(new TextDecoder().decode(files['doc.json']));
    const restored = await io.docFromFiles(files);
    app.attachDoc(restored);
    restored.changed();
    const radj = restored.flatLayers.find(l => l.type === 'adjust');
    const after = { shown: px(restored, 30, 30), strip: px(restored, 30, 8) };
    return {
      version: meta.version,
      filter: radj.filter, params: radj.params, masked: !!radj.mask,
      maskKey: String(meta.layersTree[1].mask).startsWith('layer-'),
      maskBytes: Object.keys(files).some(k => k.startsWith('masks/layer-')),
      before, after,
      names: restored.flatLayers.map(l => l.name),
    };
  });
  expect(result.version).toBe(4);
  expect(result.filter).toBe('exposure');
  expect(result.params).toEqual({ stops: 5, offset: 0 });
  expect(result.masked).toBe(true);
  expect(result.maskKey).toBe(true);
  expect(result.maskBytes).toBe(true);
  expect(result.names).toEqual(['Background', 'exposure']);
  expect(result.before.shown).toEqual([91, 136, 181, 255]); // exposed below the mask edge
  expect(result.before.strip).toEqual([64, 96, 128, 255]); // erased strip stays raw
  expect(result.after).toEqual(result.before);
});

test('v3 projects round-trip groups, masks, and clipping through DPX', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    const io = await import('/js/io.js');
    app.attachDoc(new Doc(64, 64, { name: 'TREE RP' }));
    const D = app.doc;
    const art = D.addLayer(null, 'ART');
    art.ctx.fillStyle = '#ff0000'; art.ctx.fillRect(8, 8, 24, 24); art.revision++;
    D.addLayerMask(art.id, 'reveal-all');
    D.withMaskSnapshot('Paint mask', art, mctx => {
      mctx.globalCompositeOperation = 'destination-out';
      mctx.fillRect(0, 20, 64, 12);
    });
    const over = D.addLayer(null, 'OVER');
    over.ctx.fillStyle = '#00ffff'; over.ctx.fillRect(0, 0, 64, 64); over.revision++;
    D.setClipped(over.id, true);
    const group = D.addGroup('SET');
    D.reparent(art.id, group.id, 0, 'Round trip');
    D.reparent(over.id, group.id, 1, 'Round trip');
    D.changed();
    const px = (doc, x, y) => { doc.compose(); return Array.from(doc._compoCtx.getImageData(x, y, 1, 1).data); };
    const before = { inside: px(D, 20, 14), maskedOut: px(D, 20, 26), far: px(D, 50, 50) };

    const blob = await io.saveDpx(D);
    const restored = await io.openDpx(await blob.arrayBuffer());
    app.attachDoc(restored);
    restored.changed();
    const rart = restored.flatLayers.find(l => l.name === 'ART');
    const rover = restored.flatLayers.find(l => l.name === 'OVER');
    const rgroup = restored.flatLayers.find(l => l.type === 'group');
    const after = { inside: px(restored, 20, 14), maskedOut: px(restored, 20, 26), far: px(restored, 50, 50) };

    const files = await io.serializeDoc(D);
    const meta = JSON.parse(new TextDecoder().decode(files['doc.json']));
    return {
      before, after,
      names: restored.flatLayers.map(l => l.name),
      parentIsGroup: rgroup.name === 'SET' && rgroup.children.length === 2,
      artMasked: !!rart.mask && rart.maskEnabled === true,
      overClipped: rover.clipped === true,
      metaVersion: meta.version,
      treeShape: [meta.layersTree.length, meta.layersTree[1].type, meta.layersTree[1].children.length],
      clipFlag: meta.layersTree[1].children[1].clipped,
      maskKey: String(meta.layersTree[1].children[0].mask).startsWith('layer-'),
      maskBytes: Object.keys(files).some(k => k.startsWith('masks/layer-')),
    };
  });
  expect(result.before).toEqual({ inside: [0, 255, 255, 255], maskedOut: [0, 0, 0, 0], far: [0, 0, 0, 0] });
  expect(result.after).toEqual(result.before);
  expect(result.names).toEqual(['Background', 'SET', 'ART', 'OVER']);
  expect(result.parentIsGroup).toBe(true);
  expect(result.artMasked).toBe(true);
  expect(result.overClipped).toBe(true);
  expect(result.metaVersion).toBe(3);
  expect(result.treeShape).toEqual([2, 'group', 2]);
  expect(result.clipFlag).toBe(true);
  expect(result.maskKey).toBe(true);
  expect(result.maskBytes).toBe(true);
});

test('treeless documents still serialize as v2 bytes', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    const io = await import('/js/io.js');
    app.attachDoc(new Doc(64, 64, { name: 'FLAT' }));
    app.doc.addLayer(null, 'EXTRA');
    const files = await io.serializeDoc(app.doc);
    const meta = JSON.parse(new TextDecoder().decode(files['doc.json']));
    return {
      version: meta.version,
      flatLayers: meta.layers?.length ?? null,
      hasTree: 'layersTree' in meta,
      layerMaskFiles: Object.keys(files).filter(k => k.startsWith('masks/layer-')).length,
    };
  });
  expect(result).toEqual({ version: 2, flatLayers: 2, hasTree: false, layerMaskFiles: 0 });
});

test('v1.0-v1.4 project metadata without newer fields remains compatible', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const io = await import('/js/io.js');
    const files = await io.serializeDoc(window.deadpixel.doc);
    const meta = JSON.parse(new TextDecoder().decode(files['doc.json']));
    delete meta.effects; delete meta.signalSeed;
    for (const layer of meta.layers) { delete layer.effects; delete layer.signalSeed; }
    files['doc.json'] = new TextEncoder().encode(JSON.stringify(meta));
    const restored = await io.docFromFiles(files);
    return {
      size: [restored.width, restored.height],
      documentEffects: restored.effects.length,
      layerEffects: restored.activeLayer.effects.length,
    };
  });
  expect(result).toEqual({ size: [1280, 800], documentEffects: 0, layerEffects: 0 });
});

test('per-layer rack settings survive a DPX round trip', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const effects = await page.evaluate(async () => {
    const app = window.deadpixel, layer = app.doc.activeLayer;
    app.doc.replaceLayerEffects(layer, [{ id: 'layer', filter: 'invert', params: {}, mix: .5, mask: 'luma' }], 'Layer rack', 99);
    const { saveDpx, openDpx } = await import('/js/io.js');
    const restored = await openDpx(await (await saveDpx(app.doc)).arrayBuffer());
    return { effects: restored.activeLayer.effects, seed: restored.activeLayer.signalSeed };
  });
  expect(effects.seed).toBe(99);
  expect(effects.effects[0]).toMatchObject({ mix: .5, mask: 'luma' });
});

test('Signal Rack controls add and recall an active-layer recipe', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  await page.getByRole('button', { name: 'SIGNAL' }).last().click();
  await page.locator('.rack-scope').selectOption('layer');
  await page.locator('.signal-card .a-run').first().click();
  await expect.poll(() => page.evaluate(() => window.deadpixel.doc.activeLayer.effects.length)).toBeGreaterThan(0);
  await page.locator('.rack-module-name').first().click();
  await expect(page.locator('.rack-controls select').first()).toBeVisible();
  await page.getByRole('button', { name: 'SET A' }).click();
  await page.getByRole('button', { name: 'SHOW A' }).click();
  await expect(page.getByRole('button', { name: 'SHOW B' })).toBeVisible();
});

test('autosave rotates recovery records and restores the newest one', async ({ page }) => {
  await page.getByRole('button', { name: /MIDNIGHT BROADCAST/ }).click();
  const recovered = await page.evaluate(async () => {
    const io = await import('/js/io.js');
    await io.clearAutosave();
    for (const name of ['ONE', 'TWO', 'THREE', 'FOUR']) {
      window.deadpixel.doc.name = name;
      await io.autosave(window.deadpixel.doc);
    }
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('deadpixel', 2); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const count = await new Promise(resolve => {
      const req = db.transaction('autosave').objectStore('autosave').get('history');
      req.onsuccess = () => resolve(req.result.length);
    });
    db.close();
    return { latest: (await io.loadAutosave()).name, count };
  });
  expect(recovered).toEqual({ latest: 'FOUR', count: 3 });
});

test('native project save writes through a file handle', async ({ page }) => {
  await page.getByRole('button', { name: /MIDNIGHT BROADCAST/ }).click();
  const result = await page.evaluate(async () => {
    const writes = [];
    const handle = {
      name: 'native.dpx',
      createWritable: async () => ({ write: async blob => writes.push(blob.size), close: async () => writes.push('closed') }),
    };
    const io = await import('/js/io.js');
    const saved = await io.saveProjectFile(window.deadpixel.doc, handle);
    return { native: saved.native, wrote: writes[0] > 0, closed: writes[1] };
  });
  expect(result).toEqual({ native: true, wrote: true, closed: 'closed' });
});

test('painted Signal Rack masks survive a DPX round trip', async ({ page }) => {
  await page.getByRole('button', { name: /MIDNIGHT BROADCAST/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel, io = await import('/js/io.js');
    const id = app.doc.createSignalMask(false), mask = app.doc.signalMasks.get(id);
    mask.fill(0); mask[0] = 255; mask[1] = 127;
    app.doc.effects = [{ id: 'painted', filter: 'invert', params: {}, mask: 'raster', maskId: id }];
    const restored = await io.docFromFiles(await io.serializeDoc(app.doc));
    const restoredMask = restored.signalMasks.get(id);
    return { count: restored.signalMasks.size, first: restoredMask[0], second: restoredMask[1], maskId: restored.effects[0].maskId };
  });
  expect(result).toEqual(expect.objectContaining({ count: 1, first: 255, second: 127 }));
  expect(result.maskId).toMatch(/^ML/);
});

test('Signal Rack reuses unchanged module stages', async ({ page }) => {
  await page.getByRole('button', { name: /MIDNIGHT BROADCAST/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel, filters = await import('/js/filters.js');
    app.doc.effects = [
      { id: 'cached-a', filter: 'invert', params: {} },
      { id: 'cached-b', filter: 'brightness-contrast', params: { brightness: 5, contrast: 2 } },
    ];
    app.doc.changed(); app.doc.compose();
    const before = filters.processingStats.stageHits;
    app.doc.effects[1].params.brightness = 12; app.doc.changed(); app.doc.compose();
    return { reused: filters.processingStats.stageHits - before, bytes: filters.processingStats.cacheBytes };
  });
  expect(result.reused).toBeGreaterThanOrEqual(1);
  expect(result.bytes).toBeGreaterThan(0);
});

test('local project settings and update controls are exposed', async ({ page }) => {
  await page.getByText('HELP', { exact: true }).click();
  await expect(page.getByText('Local Project Settings…', { exact: true })).toBeVisible();
  await expect(page.getByText('Check for Updates…', { exact: true })).toBeVisible();
});

test('painted masks can be edited directly over the document view', async ({ page }) => {
  await page.getByRole('button', { name: /MIDNIGHT BROADCAST/ }).click();
  const painted = await page.evaluate(() => {
    const app = window.deadpixel, id = app.doc.createSignalMask(false), alpha = app.doc.signalMasks.get(id); alpha.fill(0);
    app.beginMaskPainting(id); app.brush.size = 30; app._dabMask({ x: 20, y: 20 }, false); app._commitMaskPaint(true);
    return { value: alpha[20 * app.doc.width + 20], active: !!app.maskPaint };
  });
  expect(painted.value).toBeGreaterThan(0);
  expect(painted.active).toBe(false);
});

test('deleting a Signal Rack mask preserves shared coverage and restores the last attachment on undo', async ({ page }) => {
  await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const app = window.deadpixel, doc = new Doc(64, 64, { bg: '#222222' });
    app.attachDoc(doc);
    const maskId = doc.createSignalMask(false);
    doc.signalMasks.get(maskId)[0] = 127;
    doc.replaceEffects([{ id: 'document', filter: 'invert', mask: 'raster', maskId }]);
    doc.replaceLayerEffects(doc.activeLayer, [{ id: 'layer', filter: 'invert', mask: 'raster', maskId }]);
    app.refreshActions();
  });
  await page.getByRole('button', { name: 'SIGNAL' }).last().click();
  await page.locator('.rack-module-name').click();
  await page.getByRole('button', { name: 'DELETE', exact: true }).click();
  expect(await page.evaluate(() => {
    const doc = window.deadpixel.doc;
    return doc.signalMasks.get(doc.activeLayer.effects[0].maskId)[0];
  })).toBe(127);
  await page.locator('.rack-scope').selectOption('layer');
  await page.locator('.rack-module-name').click();
  await page.getByRole('button', { name: 'DELETE', exact: true }).click();
  expect(await page.evaluate(() => window.deadpixel.doc.signalMasks.size)).toBe(0);
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: 'DELETE', exact: true })).toBeVisible();
  expect(await page.evaluate(() => {
    const doc = window.deadpixel.doc;
    return doc.signalMasks.get(doc.activeLayer.effects[0].maskId)[0];
  })).toBe(127);
  await page.keyboard.press('Control+Shift+z');
  expect(await page.evaluate(() => window.deadpixel.doc.signalMasks.size)).toBe(0);
});

test('A/B snapshots preserve painted coverage and DUP separates a shared mask', async ({ page }) => {
  await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const app = window.deadpixel, doc = new Doc(64, 64);
    app.attachDoc(doc);
    const maskId = doc.createSignalMask(false);
    doc.signalMasks.get(maskId)[0] = 127;
    doc.replaceEffects(['first', 'second'].map(id => ({ id, filter: 'invert', mask: 'raster', maskId })));
    app.refreshActions();
  });
  await page.getByRole('button', { name: 'SIGNAL' }).last().click();
  await page.getByRole('button', { name: 'SET A', exact: true }).click();
  await page.evaluate(() => {
    const doc = window.deadpixel.doc, { maskId } = doc.effects[0];
    const coverage = doc.signalMasks.get(maskId).slice();
    coverage[0] = 31;
    doc.paintSignalMask(maskId, coverage);
  });
  await page.getByRole('button', { name: 'SET B', exact: true }).click();
  const maskState = () => page.evaluate(() => {
    const doc = window.deadpixel.doc, [first, second] = doc.effects;
    return { shared: first.maskId === second.maskId, values: doc.effects.map(effect => doc.signalMasks.get(effect.maskId)[0]) };
  });
  await page.getByRole('button', { name: 'SHOW A', exact: true }).click();
  expect(await maskState()).toEqual({ shared: true, values: [127, 127] });
  await page.locator('.rack-module-name').first().click();
  await page.getByRole('button', { name: 'DUP', exact: true }).click();
  expect(await maskState()).toEqual({ shared: false, values: [127, 127] });
  await page.getByRole('button', { name: 'SHOW B', exact: true }).click();
  expect(await maskState()).toEqual({ shared: true, values: [31, 31] });
});

test('one completed mask stroke is reversible and Escape drops an unfinished stroke', async ({ page }) => {
  const points = await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const app = window.deadpixel, doc = new Doc(64, 64);
    app.attachDoc(doc);
    const maskId = doc.createSignalMask(false);
    doc.signalMasks.get(maskId).fill(0);
    doc.replaceEffects([{ id: 'paint', filter: 'invert', mask: 'raster', maskId }]);
    app.brush.size = 12;
    app.refreshActions();
    const rect = app.viewCanvas.getBoundingClientRect();
    return [[16, 16], [48, 48]].map(([x, y]) => {
      const [sx, sy] = app.docToScreen(x, y);
      return [rect.left + sx, rect.top + sy];
    });
  });
  await page.getByRole('button', { name: 'SIGNAL' }).last().click();
  await page.locator('.rack-module-name').click();
  await page.locator('.rack-mask-tools').getByRole('button', { name: 'VIEW', exact: true }).click();
  await page.mouse.click(...points[0]);
  await page.mouse.move(...points[1]);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const state = () => page.evaluate(() => {
    const { doc, maskPaint } = window.deadpixel;
    const alpha = doc.signalMasks.get(doc.effects[0].maskId);
    return { coverage: [alpha[16 * 64 + 16], alpha[48 * 64 + 48]], painting: !!maskPaint, history: doc.history.index };
  });
  expect(await state()).toEqual({ coverage: [255, 0], painting: false, history: 1 });
  await page.keyboard.press('Control+z');
  expect(await state()).toEqual({ coverage: [0, 0], painting: false, history: 0 });
  await page.keyboard.press('Control+Shift+z');
  expect(await state()).toEqual({ coverage: [255, 0], painting: false, history: 1 });
});

test('mask dialog Cancel leaves the rack alone and Apply records one edit', async ({ page }) => {
  await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const app = window.deadpixel;
    app.attachDoc(new Doc(64, 64));
    app.doc.replaceEffects([{ id: 'paint', filter: 'invert', mask: 'raster' }]);
    app.refreshActions();
  });
  await page.getByRole('button', { name: 'SIGNAL' }).last().click();
  await page.locator('.rack-module-name').click();
  const edit = page.locator('.rack-controls').getByRole('button', { name: 'EDIT', exact: true });
  const state = () => page.evaluate(() => {
    const doc = window.deadpixel.doc;
    return { coverage: doc.signalMasks.get(doc.effects[0].maskId)?.[0], history: doc.history.index };
  });
  await edit.click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await state()).toEqual({ coverage: undefined, history: 0 });
  await edit.click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  expect(await state()).toEqual({ coverage: 255, history: 1 });
  await page.keyboard.press('Control+z');
  expect(await state()).toEqual({ coverage: undefined, history: 0 });
  await page.keyboard.press('Control+Shift+z');
  expect(await state()).toEqual({ coverage: 255, history: 1 });
});

test('editor shell fits desktop and compact viewports', async ({ page }) => {
  for (const size of [{ width: 1440, height: 900 }, { width: 900, height: 600 }]) {
    await page.setViewportSize(size);
    const fit = await page.evaluate(() => ['menubar', 'workspace', 'statusbar'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }));
    for (const region of fit) {
      expect(region.left, region.id).toBeGreaterThanOrEqual(0);
      expect(region.top, region.id).toBeGreaterThanOrEqual(0);
      expect(region.right, region.id).toBeLessThanOrEqual(size.width);
      expect(region.bottom, region.id).toBeLessThanOrEqual(size.height);
    }
  }
});

test('cached editor shell starts while offline', async ({ page, context }) => {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.getByRole('button', { name: /OPEN IMAGE/ })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

/* ---------------- Phase 2: selection refining, quick mask, retouch, pen, transform ---------------- */

test('feather, expand and contract reshape the selection alpha', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc, Selection } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'SEL REFINE' }));
    const D = app.doc;
    D.setSelection(Selection.fromRect(D.width, D.height, 20, 20, 24, 24), 'E2E seed');
    const a = (x, y) => D.selection.mctx.getImageData(x, y, 1, 1).data[3];
    const seed = D.selection.bounds;

    D.growSelection(2); // expand
    const expanded = D.selection.bounds;
    const softCorner = a(18, 18), core = a(24, 24);

    D.growSelection(2, true); // contract back
    const contracted = D.selection.bounds;
    const roundedCorner = a(20, 20);

    D.featherSelection(3);
    const feathered = D.selection.bounds; // blur spreads alpha ~±6 beyond the rect
    const edge = a(20, 26), mid = a(32, 32), fringe = a(18, 26);
    return { seed, expanded, contracted, feathered, softCorner, core, roundedCorner, edge, mid, fringe, label: D.history.entries[D.history.index].label };
  });
  expect(result.seed).toEqual({ x: 20, y: 20, w: 24, h: 24 });
  expect(result.expanded).toEqual({ x: 18, y: 18, w: 28, h: 28 });
  expect(result.softCorner).toBeGreaterThanOrEqual(30); // soft euclidean rim on the diagonal
  expect(result.softCorner).toBeLessThanOrEqual(90);
  expect(result.core).toBe(255);
  expect(result.contracted).toEqual({ x: 20, y: 20, w: 24, h: 24 });
  expect(result.roundedCorner).toBeGreaterThan(120); // corners round instead of squaring off
  expect(result.roundedCorner).toBeLessThan(250);
  expect(result.feathered).toEqual({ x: 14, y: 14, w: 36, h: 36 }); // alpha>8 tail extends ~6px each way
  expect(result.edge).toEqual(137); // edge alpha drops to roughly half
  expect(result.mid).toBe(255);
  expect(result.fringe).toBeGreaterThanOrEqual(40); // soft falloff outside the original rect
  expect(result.fringe).toBeLessThanOrEqual(130);
  expect(result.label).toBe('Feather selection');
});

test('quick mask paints a live selection mask and bakes it on exit', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'QM TEST' }));
    const D = app.doc;
    app.setTool('brush');
    app.brush.preset = 'hard-round';
    app.brush.size = 20; app.brush.hardness = 100; app.brush.flow = 100;
    app.color.fg = '#ffffff'; // light fg paints coverage
    app.setQuickMask(true);
    const chipOn = document.body.classList.contains('quick-mask');
    const chipShown = document.querySelector('#optionsbar').textContent.includes('QUICK MASK');

    const pt = (x, y) => { const [sx, sy] = app.docToScreen(x, y); return { x, y, sx, sy, pressure: 1, e: null }; };
    app.tool.onDown(app, pt(16, 32));
    app.tool.onMove(app, pt(32, 32));
    app.tool.onMove(app, pt(48, 32));
    app.tool.onUp(app);
    const painted = app._quickMask.getContext('2d').getImageData(30, 32, 1, 1).data[3];

    app.setQuickMask(false);
    const sel = D.selection;
    return {
      chipOn, chipShown, painted,
      bounds: sel?.bounds,
      covered: sel?.mctx.getImageData(30, 32, 1, 1).data[3],
      outside: sel?.mctx.getImageData(30, 4, 1, 1).data[3],
      label: D.history.entries[D.history.index].label,
      bodyClass: document.body.classList.contains('quick-mask'),
      chipGone: !document.querySelector('#optionsbar').textContent.includes('QUICK MASK'),
    };
  });
  expect(result.chipOn).toBe(true);
  expect(result.chipShown).toBe(true);
  expect(result.painted).toBe(255);
  expect(result.bounds.x).toBeGreaterThanOrEqual(5); // capsule around the 16..48 sweep
  expect(result.bounds.x).toBeLessThanOrEqual(7);
  expect(result.bounds.y).toBeGreaterThanOrEqual(22);
  expect(result.bounds.y).toBeLessThanOrEqual(24);
  expect(result.bounds.w).toBeGreaterThanOrEqual(50);
  expect(result.bounds.h).toBeGreaterThanOrEqual(18);
  expect(result.bounds.h).toBeLessThanOrEqual(22);
  expect(result.covered).toBe(255);
  expect(result.outside).toBe(0);
  expect(result.label).toBe('Quick mask');
  expect(result.bodyClass).toBe(false);
  expect(result.chipGone).toBe(true);
});

test('dodge, burn and sponge retouch only the pixels they dab', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'TONER TEST' }));
    const D = app.doc, layer = D.activeLayer;
    layer.ctx.fillStyle = '#808080'; layer.ctx.fillRect(0, 0, 64, 64); layer.revision++;
    D.changed();
    app.brush.size = 20; app.brush.hardness = 100; app.brush.flow = 100;
    const pt = (x, y) => { const [sx, sy] = app.docToScreen(x, y); return { x, y, sx, sy, pressure: 1, e: null }; };
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };

    app.setTool('dodge');
    app.tool.onDown(app, pt(16, 32)); app.tool.onUp(app);
    const dodged = px(16, 32), untouched = px(48, 32);

    app.setTool('burn');
    app.tool.onDown(app, pt(48, 32)); app.tool.onUp(app);
    const burned = px(48, 32);

    layer.ctx.fillStyle = '#ff0000'; layer.ctx.fillRect(0, 0, 64, 64); layer.revision++;
    D.changed();
    app.setTool('sponge'); // defaults to DESAT
    app.tool.onDown(app, pt(32, 32)); app.tool.onUp(app);
    return { dodged, untouched, burned, sponged: px(32, 32), label: D.history.entries[D.history.index].label };
  });
  expect(result.dodged).toEqual([255, 255, 255, 255]); // gray 128 through a light source full-blast dodge
  expect(result.untouched).toEqual([128, 128, 128, 255]);
  expect(result.burned).toEqual([0, 0, 0, 255]);
  const [r, g, b] = result.sponged;
  expect(r).toBeLessThan(110); // pure red desaturates toward its luminosity ≈ 54
  expect(Math.abs(r - g)).toBeLessThan(8);
  expect(Math.abs(g - b)).toBeLessThan(8);
  expect(result.label).toBe('Sponge');
});

test('heal brush blends a blemish away to its local median', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'HEAL TEST' }));
    const D = app.doc, layer = D.activeLayer;
    layer.ctx.fillStyle = 'rgb(200,200,200)'; layer.ctx.fillRect(0, 0, 64, 64);
    layer.ctx.fillStyle = 'rgb(20,20,20)'; layer.ctx.fillRect(30, 30, 4, 4);
    layer.revision++; D.changed();
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    const blemish = px(31, 31);

    app.brush.size = 52; app.brush.hardness = 100; app.brush.flow = 100;
    app.setTool('heal');
    const pt = (x, y) => { const [sx, sy] = app.docToScreen(x, y); return { x, y, sx, sy, pressure: 1, e: null }; };
    app.tool.onDown(app, pt(32, 32)); app.tool.onUp(app);
    return { blemish, healed: px(32, 32), spot: px(31, 31), field: px(8, 8), label: D.history.entries[D.history.index].label };
  });
  expect(result.blemish).toEqual([20, 20, 20, 255]);
  expect(result.healed).toEqual([200, 200, 200, 255]); // 4px spot is a minority in the 9px median window
  expect(result.spot).toEqual([200, 200, 200, 255]);
  expect(result.field).toEqual([200, 200, 200, 255]);
  expect(result.label).toBe('Heal brush');
});

test('pen anchors close into a path and convert to a selection', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'PEN TEST' }));
    const D = app.doc;
    app.setTool('pen');
    const pen = app.tool;
    const pt = (x, y) => { const [sx, sy] = app.docToScreen(x, y); return { x, y, sx, sy, pressure: 1, e: null }; };
    for (const [x, y] of [[10, 10], [50, 15], [20, 50]]) { pen.onDown(app, pt(x, y)); pen.onUp(app); }
    const anchored = pen.pts.length;
    pen.onDown(app, pt(10, 10)); pen.onUp(app); // click the first anchor to close
    const closed = pen.closed;
    pen.doAction(app, 'select');
    return { anchored, closed, bounds: D.selection?.bounds, label: D.history.entries[D.history.index].label };
  });
  expect(result.anchored).toBe(3);
  expect(result.closed).toBe(true);
  expect(result.bounds.x).toBe(10); // triangle bbox
  expect(result.bounds.y).toBe(10);
  expect(result.bounds.w).toBeGreaterThanOrEqual(39);
  expect(result.bounds.w).toBeLessThanOrEqual(41);
  expect(result.bounds.h).toBeGreaterThanOrEqual(39);
  expect(result.bounds.h).toBeLessThanOrEqual(41);
  expect(result.label).toBe('Make selection');
});

test('transform SKEW shears the layer horizontally by depth', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'SKEW TEST' }));
    const D = app.doc;
    D.activeLayer.ctx.fillStyle = '#c04040'; D.activeLayer.ctx.fillRect(16, 16, 32, 32); D.activeLayer.revision++;
    D.changed();
    app.enterTransform();
    const T = app.tool; // transformTool
    T.state.mode = 'skew';
    T.tx.skx = .3; // y shifts by .3 · (x − 32): box midline maps src row 32 to doc row 35.75
    T.applyPreview(app);
    T.doAction(app, 'apply');
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    return {
      transforming: app.transforming,
      shifted: px(44, 36),   // src (44,32) → 32 + .3·(44−32) ≈ 35.6
      emptied: px(44, 12),   // src column 44 top rows fall above the sheared band
      label: D.history.entries[D.history.index].label,
    };
  });
  expect(result.transforming).toBe(false);
  expect(result.shifted).toEqual([192, 64, 64, 255]);
  expect(result.emptied).toEqual([0, 0, 0, 0]);
  expect(result.label).toBe('Transform');
});

test('transform DISTORT maps free corners per-triangle', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  const result = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'DISTORT TEST' }));
    const D = app.doc;
    D.activeLayer.ctx.fillStyle = '#c04040'; D.activeLayer.ctx.fillRect(16, 16, 32, 32); D.activeLayer.revision++;
    D.changed();
    app.enterTransform();
    const T = app.tool;
    T.state.mode = 'distort';
    T.optionChanged(app, 'mode'); // freeCorners ← box quad (TL, TR, BR, BL)
    T.freeCorners = [{ x: 8, y: 8 }, { x: 48, y: 16 }, { x: 40, y: 48 }, { x: 16, y: 40 }];
    T.applyPreview(app);
    T.doAction(app, 'apply');
    const px = (x, y) => { D.compose(); return Array.from(D._compoCtx.getImageData(x, y, 1, 1).data); };
    return {
      transforming: app.transforming,
      atTL: px(12, 12),   // near the pulled TL corner, inside the dst triangle
      mapped: px(32, 24), // tri1 centroid: samples src ≈ (37.8, 27) inside the quad
      outside: px(10, 40), // left-bottom is outside both destination triangles
      label: D.history.entries[D.history.index].label,
    };
  });
  expect(result.transforming).toBe(false);
  expect(result.atTL).toEqual([192, 64, 64, 255]);
  expect(result.mapped).toEqual([192, 64, 64, 255]);
  expect(result.outside).toEqual([0, 0, 0, 0]);
  expect(result.label).toBe('Transform');
});

test('phase 2 tools and commands are wired into the shell', async ({ page }) => {
  await page.getByRole('button', { name: /XEROX GOSPEL/ }).click();
  await expect(page.locator('[data-tool="pen"]')).toHaveAttribute('title', /PEN \(P\)/);
  await expect(page.locator('[data-tool="heal"]')).toHaveAttribute('title', /HEAL \(J\)/);
  const wired = await page.evaluate(async () => {
    const app = window.deadpixel;
    const { Doc } = await import('/js/engine.js');
    app.attachDoc(new Doc(64, 64, { name: 'WIRE TEST' }));
    return { quickmaskCmd: !!app.cmd['select.quickmask'] && app.cmd['select.quickmask'].key === 'Q' };
  });
  expect(wired.quickmaskCmd).toBe(true);
  await page.evaluate(() => window.deadpixel.setQuickMask(true));
  await expect(page.locator('#optionsbar')).toContainText('QUICK MASK');
  await page.evaluate(() => window.deadpixel.setQuickMask(false));
  await expect(page.locator('#optionsbar')).not.toContainText('QUICK MASK');
});

test('export completes a pending layer rack and ignores stale preview pixels', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Doc, makeCanvas } = await import('/js/engine.js');
    const { exportDoc } = await import('/js/io.js');
    const doc = new Doc(1, 1, { bg: '#f00' });
    const layer = doc.activeLayer;
    layer.effects = [{ id: 'pending' }];
    doc.effectProcessor = canvas => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f0';
      ctx.fillRect(0, 0, 1, 1);
    };
    let finishPreview;
    doc.effectProcessorAsync = () => new Promise(resolve => { finishPreview = resolve; });
    const processing = [];
    doc.onProcessingChange = active => processing.push(active);
    const pixel = canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data);
    const preview = pixel(doc.composePreview());
    const exportedPixel = async () => {
      const decoded = await createImageBitmap(await exportDoc(doc));
      const canvas = makeCanvas(1, 1);
      canvas.getContext('2d').drawImage(decoded, 0, 0);
      decoded.close();
      return pixel(canvas);
    };
    const exported = await exportedPixel();
    finishPreview(new Uint8ClampedArray([0, 0, 255, 255]));
    await Promise.resolve();
    const final = pixel(doc.composePreview());
    doc.setEffectBypass(layer, true);
    const exportedDuringBypass = await exportedPixel();
    const bypassed = pixel(doc.composePreview());
    doc.setEffectBypass(layer, false);
    doc.replaceLayerEffects(layer, [{ id: 'next-preview' }]);
    const viewport = doc.composePreview();
    finishPreview(new Uint8ClampedArray([0, 0, 255, 255]));
    await Promise.resolve();
    const settledPreview = pixel(viewport);
    const fullAfterPreview = await exportedPixel();
    return { preview, exported, exportedDuringBypass, bypassed, final, settledPreview, fullAfterPreview, processing };
  });
  expect(result).toEqual({
    preview: [255, 0, 0, 255],
    exported: [0, 255, 0, 255],
    exportedDuringBypass: [0, 255, 0, 255],
    bypassed: [255, 0, 0, 255],
    final: [0, 255, 0, 255],
    settledPreview: [0, 0, 255, 255],
    fullAfterPreview: [0, 255, 0, 255],
    processing: [true, false, true, false],
  });
});

test('flatten applies the document rack once and undo restores the editable rack', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const doc = new Doc(1, 1, { bg: 'rgb(20, 0, 0)' });
    doc.addLayer();
    doc.replaceEffects([{ id: 'add-red' }], 'Rack', 99);
    doc.effectProcessor = canvas => {
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, 1, 1);
      pixels.data[0] += 30;
      ctx.putImageData(pixels, 0, 0);
    };
    const state = () => ({
      red: doc.compose().getContext('2d').getImageData(0, 0, 1, 1).data[0],
      layers: doc.layers.length,
      effects: doc.effects.length,
      seed: doc.signalSeed,
    });
    const before = state();
    doc.flatten();
    const flattened = state();
    doc.history.undo();
    const undone = state();
    doc.history.redo();
    return { before, flattened, undone, redone: state() };
  });
  const original = { red: 50, layers: 2, effects: 1, seed: 99 };
  const flattened = { ...original, layers: 1, effects: 0 };
  expect(result).toEqual({ before: original, flattened, undone: original, redone: flattened });
});

test('merge group bakes its rack and keeps a soft mask editable', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Doc, makeCanvas } = await import('/js/engine.js');
    const doc = new Doc(1, 1, { bg: '#f00' });
    const group = doc.groupFromActive();
    group.effects = [{ id: 'group-rack' }];
    doc.effectProcessor = canvas => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#00f';
      ctx.fillRect(0, 0, 1, 1);
    };
    group.mask = makeCanvas(1, 1);
    const maskCtx = group.mask.getContext('2d');
    maskCtx.fillStyle = 'rgba(255,255,255,0.5)';
    maskCtx.fillRect(0, 0, 1, 1);
    const pixel = () => Array.from(doc.compose().getContext('2d').getImageData(0, 0, 1, 1).data);
    const before = pixel();
    const merged = doc.rasterizeGroup(group.id);
    const after = pixel();
    merged.maskEnabled = false;
    doc.changed();
    return { before, after, unmasked: pixel(), effects: merged.effects.length };
  });
  expect(result.before).toEqual([0, 0, 255, 128]);
  expect(result.after).toEqual(result.before);
  expect(result.unmasked).toEqual([0, 0, 255, 255]);
  expect(result.effects).toBe(0);
});

test('Merge Group Contents explains why a backdrop-dependent Pass Through group cannot be baked', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const app = window.deadpixel;
    const doc = new Doc(1, 1, { bg: '#f00' });
    const overlay = doc.addLayer();
    overlay.ctx.fillStyle = '#00f';
    overlay.ctx.fillRect(0, 0, 1, 1);
    overlay.blend = 'multiply';
    const group = doc.groupFromActive();
    group.blend = 'pass-through';
    doc.setActiveId(group.id);
    app.attachDoc(doc);
    const history = doc.history.index;
    app.cmd['layer.rasterizegroup'].run();
    return { sameGroup: doc.activeLayer === group, sameHistory: doc.history.index === history };
  });
  expect(result).toEqual({ sameGroup: true, sameHistory: true });
  await expect(page.getByText('PASS THROUGH NEEDS LAYERS OUTSIDE THIS GROUP')).toBeVisible();
});

test('merge down preserves ordinary pairs and refuses an adjustment that also affects earlier siblings', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const doc = new Doc(2, 1, { bg: '#f00' });
    const middle = doc.addLayer();
    middle.ctx.fillStyle = '#00f';
    middle.ctx.fillRect(0, 0, 1, 1);
    const pixel = () => Array.from(doc.compose().getContext('2d').getImageData(0, 0, 2, 1).data);
    doc.addAdjustmentLayer('invert');
    const before = pixel();
    const index = doc.history.index;
    const refused = !doc.mergeDown();
    const untouched = index === doc.history.index && doc.layers.length === 3 && pixel().every((value, i) => value === before[i]);
    doc.history.undo();
    const plain = pixel();
    const merged = doc.mergeDown();
    return { refused, untouched, merged, plain, after: pixel(), layers: doc.layers.length };
  });
  expect(result).toEqual({
    refused: true,
    untouched: true,
    merged: true,
    plain: [0, 0, 255, 255, 255, 0, 0, 255],
    after: [0, 0, 255, 255, 255, 0, 0, 255],
    layers: 1,
  });
});

test('an adjustment sees changes to the layers below it inside a group', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Doc } = await import('/js/engine.js');
    const doc = new Doc(1, 1, { bg: '#f00' });
    const group = doc.groupFromActive();
    const base = doc.activeLayer;
    doc.addAdjustmentLayer('invert');
    const pixel = () => Array.from(doc.compose().getContext('2d').getImageData(0, 0, 1, 1).data);
    const before = pixel();
    base.opacity = 0.5;
    doc.changed();
    const after = pixel();
    const merged = doc.rasterizeGroup(group.id);
    return { before, after, merged: merged.type, baked: pixel() };
  });
  expect(result.before).toEqual([0, 255, 255, 255]);
  expect(result.after[3]).toBeLessThan(255);
  expect(result.after).not.toEqual(result.before);
  expect(result.merged).toBe('raster');
  expect(result.baked).toEqual(result.after);
});
