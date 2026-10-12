---
name: installable-pwa
description: >-
  Make a web app installable as a PWA — "Add to Home Screen" / "Install app" on
  Android and iOS — correctly on the FIRST try, and fix the deployment-stack
  gotchas that silently make PWA files 404 in production even when the code is
  right. Covers the five required pieces (web app manifest, service worker with
  a fetch handler, real PNG icons incl. a maskable one, the HTML head tags, and
  service-worker registration) PLUS the pre-flight checklist of mistakes that
  break installability on a bundled + containerized stack: the build context
  missing `public/`, inline comments on Dockerfile `COPY` lines, the
  `.webmanifest` MIME type, static serving returning 404/HTML, HTTPS, and icon
  reachability. Use whenever the user wants to make an app installable, add PWA
  support, "add to home screen", get an install prompt to appear, or when the
  browser says the app "can't be installed". Especially for a Vite/bundler
  frontend served by a backend (Flask/Express) inside a multi-stage Docker image
  on a host like Render/Fly/Railway.
---

# installable-pwa

A PWA needs five things, and then it needs its five files to actually *ship and
serve*. The code is the easy half; the deployment stack is where installability
silently dies. This skill does both, and ends with a verification that proves it
before you hand it over — so it installs on the first try.

Copy-paste templates (manifest, service worker, HTML head, SW registration, icon
generator, verification script) are in `references/templates.md`. Read it when
you start writing files.

## The five required pieces

Put static assets where the bundler publishes them at the site root. For **Vite**
that is `public/` → copied to `dist/` as-is; for CRA/Next/Vue it's the equivalent
`public/`. All paths below are **root-absolute** (`/manifest.webmanifest`, not
`./`), because the manifest's `start_url`/`scope` and the SW's scope are origin-root.

1. **Web app manifest** — `public/manifest.webmanifest`. Required fields for
   installability: `name`, `start_url` (`/`), `display` (`standalone`), and
   icons with at least a **192×192** and a **512×512** PNG of `purpose: "any"`.
   Add `short_name`, `scope` (`/`), `background_color`, `theme_color`, and a
   **maskable** 512 icon for Android's adaptive mask.

2. **Icons** — real PNGs in `public/icons/`, not placeholders. **192 and 512**
   `any`, plus a **maskable 512** with ~20% safe-zone padding on a full-bleed
   background (the OS crops maskables to a circle/squircle). Generate them from
   the app's own look — a headless-browser render of an HTML/SVG tile is reliable
   and matches the brand (see the generator in the templates). Don't ship an app
   that references icons that 404 — Chrome refuses to install.

3. **Service worker** — `public/sw.js`. Installability requires a registered SW
   **with a `fetch` handler**. Precache the app shell; serve static assets
   stale-while-revalidate; make navigations network-first with an offline
   fallback to the cached shell; and **never cache the API** (dynamic data must
   stay live). Bundled asset filenames are hashed, so runtime-cache them rather
   than precaching by name.

4. **HTML head** — link the manifest and set theme color, plus iOS fallbacks
   (iOS ignores the manifest for home-screen launch):
   `<link rel="manifest">`, `<meta name="theme-color">`,
   `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`,
   `<link rel="apple-touch-icon">`.

5. **Register the SW** — in the app's entry module, on `load`:
   `navigator.serviceWorker.register('/sw.js')`, guarded by a feature check and a
   `.catch`. Registration only happens on a real load, so a cached old page won't
   pick it up until reloaded.

## Deployment-stack pre-flight (where installability actually dies)

These are the failures that make everything look right locally and 404 in
production. Check every one before declaring done — each has cost real debugging
time:

- **G1 — the build context must include the static dir.** The bundler copies
  `public/` into the build output, but a multi-stage Dockerfile only has the
  files you `COPY` into it. If the frontend stage copies `src/` and configs but
  **not `public/`**, the manifest/SW/icons are silently absent from `dist/` and
  404 in prod while the HTML still links them. Add `COPY public ./public` before
  the build step. *(This is the single most common cause.)*

- **G2 — no inline comments on Dockerfile `COPY`/`ADD`.** Unlike `RUN` (where
  `#` is a shell comment), a `#` after `COPY` is parsed as **arguments**, so the
  build fails (often cryptically, e.g. on a stray character). Put the comment on
  its own line.

- **G3 — serve `.webmanifest` with the right MIME type.** Many servers
  (Werkzeug/Flask included) don't know the extension and send
  `application/octet-stream` or `text/html`, which a strict browser rejects. Fix
  it at the server: e.g. Flask `mimetypes.add_type("application/manifest+json",
  ".webmanifest")`. Or sidestep it by naming the file `manifest.json`
  (`application/json`, which browsers accept).

- **G4 — HTTPS (or localhost).** Service workers and install require a secure
  context. `localhost` counts for dev; production must be HTTPS (Render/Fly/etc.
  give it free).

- **G5 — the files must serve at the root, 200 not 404/HTML.** When the backend
  serves the bundle as static root (e.g. Flask `static_url_path=""`), confirm
  `/manifest.webmanifest`, `/sw.js`, and `/icons/*` return **200** with the right
  content-type — not a 404 page and not the SPA's `index.html` from a catch-all.

- **G6 — icons reachable and spec-correct.** At least one 192 and one 512 PNG,
  `purpose` set, URLs resolving. One 404 icon fails the whole manifest.

- **G7 — SW scope covers the app.** Serve `sw.js` from the origin root so its
  default scope is `/`. A SW under `/assets/` only controls `/assets/`.

## Verify before handoff (prove first-try install)

Don't claim it's installable — show it. Build, serve the production artifact, and:

1. **curl each PWA file** on the serving origin and assert **HTTP 200** + the
   expected content-type (manifest → `application/manifest+json` or
   `application/json`; `sw.js` → a JS type; icons → `image/png`). A 404 or
   `text/html` here is the bug, every time — this catches G1/G3/G5 instantly.

2. **Headless Chromium check** (Playwright/Puppeteer): load the page and assert
   - `navigator.serviceWorker.ready` resolves with an active worker,
   - the manifest parses with `name`, `display: "standalone"`, and 192+512 icons,
   - with the network set **offline**, a reload still renders the app shell.

   The offline-reload passing is the strongest single signal that the SW + shell
   caching are wired correctly. The verification script is in the templates.

3. On the live deploy, re-run the curl checks against the real URL — a passing
   local build with 404s in prod means a **G1/G5** deployment gap, not a code bug.

If the browser still says "can't be installed" after all this, open DevTools →
Application → Manifest (desktop) for the exact unmet criterion, and check that the
deploy actually serves the latest build (a stale deploy or a cached old service
worker is a common red herring — clear site data and reload).
