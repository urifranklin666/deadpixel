/* DeadPixel desktop shell — serves the bundled site on a loopback port
   (ES modules and fetch() don't run from file://) and opens it in a window. */
const { app, BrowserWindow, shell, Menu } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE = app.isPackaged
  ? path.join(process.resourcesPath, 'site')
  : path.join(__dirname, '..', 'site');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.resolve(SITE, '.' + p);
      const relative = path.relative(SITE, file);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // DEADPIXEL draws its own menu bar
  const port = await serve();
  const win = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    title: 'DEADPIXEL',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // external links (deadplug.digital) open in the real browser
  const openExternal = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1' && target.port === String(port)) return;
    event.preventDefault();
    openExternal(url);
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
});

app.on('window-all-closed', () => app.quit());
