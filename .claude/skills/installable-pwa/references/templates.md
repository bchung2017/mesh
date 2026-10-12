# installable-pwa — templates

Proven copy-paste starting points. Paths assume a Vite app whose `public/` is
copied to the site root on build. Adjust names/colors to the app.

## 1. `public/manifest.webmanifest`

```json
{
  "name": "My App",
  "short_name": "My App",
  "description": "One line about the app.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

## 2. `public/sw.js`

Minimal, dependency-free. Precache the shell, SWR for assets, network-first
navigations with an offline fallback, never touch the API. Bump `CACHE` when the
shell changes.

```js
const CACHE = 'app-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;            // dynamic data: always network
  if (req.mode === 'navigate') {                           // fresh HTML online, shell offline
    e.respondWith(fetch(req).catch(() => caches.match('/').then((r) => r || caches.match('/index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then((cached) => {       // assets: stale-while-revalidate
    const net = fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});
```

## 3. HTML `<head>`

```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#ffffff">
<meta name="mobile-web-app-capable" content="yes">
<!-- iOS ignores the manifest for home-screen launch -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="My App">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
```

## 4. Register the service worker (entry module)

```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) =>
      console.warn('SW registration failed', err));
  });
}
```

## 5. Generate real icons (headless browser → PNG)

Renders a branded tile to exact-size PNGs. Node + Playwright (use the environment's
bundled Chromium path if there is one). `pad` is the content inset; the maskable
variant uses more padding for the mask safe zone.

```js
import { chromium } from 'playwright';          // or an absolute path to the installed package
const OUT = './public/icons';
function html(size, pad, label) {
  const inner = Math.round(size * (1 - pad * 2));
  const font = Math.round(inner * 0.26);
  return `<!doctype html><meta charset=utf-8><style>html,body{margin:0}
    .f{width:${size}px;height:${size}px;background:#ffffff;display:flex;align-items:center;justify-content:center}
    .b{width:${inner}px;height:${inner}px;border-radius:24%;background:#4f46e5;color:#fff;
       font:700 ${font}px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}</style>
    <div class="f"><div class="b">${label}</div></div>`;
}
const browser = await chromium.launch();
async function render(name, size, pad, label='App') {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(html(size, pad, label), { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${OUT}/${name}`, clip: { x: 0, y: 0, width: size, height: size } });
  await p.close();
}
await render('icon-192.png', 192, 0.10);
await render('icon-512.png', 512, 0.10);
await render('icon-maskable-512.png', 512, 0.20);  // extra padding for the mask
await browser.close();
```

## 6. Multi-stage Dockerfile — the critical lines (G1, G2)

```dockerfile
# ---- frontend build ----
FROM node:22-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# G1: without this, public/ is absent from the build and the PWA files 404 in prod.
# G2: this comment is on its OWN line — a comment after COPY breaks the build.
COPY public ./public
RUN npm run build        # emits /build/dist including public/*
```

## 7. Flask: serve the bundle + fix the manifest MIME (G3, G5)

```python
import mimetypes, os
from flask import Flask, send_from_directory
# G3: Werkzeug doesn't know .webmanifest — register it, or name the file manifest.json.
mimetypes.add_type("application/manifest+json", ".webmanifest")

app = Flask(__name__, static_folder="dist", static_url_path="")  # serves /manifest.webmanifest, /sw.js, /icons/*
# G5: ensure no catch-all returns index.html for those static paths; only fall back for real navigations.
```

## 8. Verification script (headless, proves first-try install)

Point `URL` at the running production artifact (local `dist` served by the backend,
or the deploy). Exits non-zero on any failure.

```js
import { chromium } from 'playwright';
const URL = process.env.URL || 'http://localhost:5000/';
const fails = [];
const ok = (c, m) => { console.log((c ? '✓' : '✗') + ' ' + m); if (!c) fails.push(m); };
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });

// files serve with sane types (catches G1/G3/G5)
for (const [p, re] of [['/manifest.webmanifest', /manifest\+json|application\/json/],
                       ['/sw.js', /javascript/], ['/icons/icon-192.png', /image\/png/]]) {
  const r = await page.request.get(new URL(p, URL).href);
  ok(r.status() === 200 && re.test(r.headers()['content-type'] || ''),
     `${p} → ${r.status()} ${r.headers()['content-type']}`);
}
// SW active + manifest parsed
ok(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active), 'service worker active');
const man = await page.evaluate(async () => {
  const m = await (await fetch(document.querySelector('link[rel=manifest]').href)).json();
  return { name: m.name, display: m.display, sizes: (m.icons||[]).map(i => i.sizes) };
});
ok(man.name && man.display === 'standalone' && man.sizes.includes('192x192') && man.sizes.includes('512x512'),
   'manifest installable (name + standalone + 192/512)');
// offline reload still renders (strongest signal)
await page.waitForTimeout(600);
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
ok(await page.evaluate(() => document.body && document.body.children.length > 0), 'app shell loads OFFLINE');
await ctx.setOffline(false);
await browser.close();
console.log(fails.length ? `\nFAILURES: ${fails.length}` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
```
