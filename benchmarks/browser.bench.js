import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn('python3', ['-m', 'http.server', '4174', '--directory', 'site', '--bind', '127.0.0.1'], {
  stdio: 'ignore',
});
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

try {
  await wait(500);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => sessionStorage.setItem('dp_booted', '1'));
  await page.goto('http://127.0.0.1:4174');
  const result = await page.evaluate(async () => {
    const { Layer } = await import('/js/engine.js');
    const app = window.deadpixel;
    app.newDoc(1920, 1080, { name: 'BENCH', bg: '#050505' });
    for (let i = 1; i < 8; i++) {
      const layer = new Layer(1920, 1080, 'Bench ' + i);
      layer.ctx.fillStyle = `rgba(${20 * i},${255 - 20 * i},${30 * i},.18)`;
      layer.ctx.fillRect(i * 30, i * 20, 1600, 900);
      app.doc.addLayer(layer);
    }
    app.doc.effects = [
      { id: 'contrast', filter: 'brightness-contrast', params: { brightness: -8, contrast: 24 } },
      { id: 'noise', filter: 'noise', params: { amount: 12, mono: 1 }, mix: .65 },
    ];
    app.doc.changed();
    const compositeStart = performance.now();
    app.doc.compose();
    const compositeMs = performance.now() - compositeStart;
    app.doc.changed();
    const previewStart = performance.now();
    app.doc.composePreview();
    while (app.doc._compoPending) await new Promise(requestAnimationFrame);
    return { compositeMs, previewMs: performance.now() - previewStart, layers: app.doc.layers.length };
  });
  console.log(`Browser 1080p/${result.layers} layers  sync composite ${result.compositeMs.toFixed(1)} ms  worker preview ${result.previewMs.toFixed(1)} ms`);
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
