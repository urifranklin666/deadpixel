import { test, expect } from 'playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('dp_booted', '1'));
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
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
