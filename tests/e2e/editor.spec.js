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
    const blue = boxCtx.getImageData(0, 0, 260, 172).data;
    let blueCount = 0;
    for (let i = 2; i < blue.length; i += 4) if (blue[i] > 90 && blue[i - 2] < 90) blueCount++;
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
      blueCount, zoomPct, histBars, info,
      panelTabs: Array.from(document.querySelectorAll('.panel-tabs button')).map(b => b.textContent),
    };
  });
  // navigator thumbnail shows the red square; viewport box strokes blue; zoom readout live
  expect(result.navCenterAlpha).toBeGreaterThan(128);
  expect(result.navCenterRed).toBeGreaterThan(150);
  expect(result.blueCount).toBeGreaterThan(20);
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
