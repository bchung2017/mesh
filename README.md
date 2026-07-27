# mesh

A warm map of the communities you belong to. Each community is a soft-body
"blob" sized by how involved you are; drag them around the field, browse them as
a list, or plan gatherings on the calendar.

This started life as a single self-contained HTML prototype and has been split
into a proper Vite + TypeScript project.

## Stack

- **[Vite](https://vitejs.dev/)** — dev server + build
- **TypeScript** — typed, no runtime framework (the app is canvas + imperative DOM)
- **WebGL** with a 2D-canvas fallback for the blob field

## Getting started

```bash
npm install
npm run dev      # start the dev server
npm run build    # typecheck + production build to dist/
npm run preview  # preview the production build
```

## Layout

```
index.html              markup only (no inline styles or scripts)
src/
  main.ts               entry point — imports styles, boots every view
  types.ts              shared types (Community, CalEvent, tones…)
  dom.ts                byId() helper
  data/
    communities.ts      single source of truth for community data
  styles/
    tokens.css          design tokens (colors, fonts)
    base.css            reset, layout, tabs
    field.css           the blob field + nudges
    calendar.css        month grid + day modal
    blobs.css           blob list + detail sheet
  field/
    palette.ts          per-tone color specs (WebGL + hex)
    texture.ts          bakes each blob's shaded ball + lens-warped label
    blobField.ts        the soft-body physics engine + renderers
  views/
    tabs.ts             top tab bar
    blobs.ts            blob list + detail sheet + field→sheet bridge
    calendar.ts         month calendar with dynamic modal placement
    nudges.ts           the nudges toggle
```

## The three views

- **the field** — a WebGL soft-body simulation. Blobs breathe, drift, dent each
  other on contact, and lean toward nearby neighbors. Radius encodes
  involvement. Falls back to a 2D-canvas renderer where WebGL is unavailable.
- **blobs** — every community as a row; tap for a detail sheet (involvement
  trend, tenure, energy, last artifact, next gathering, and the read).
- **calendar** — a month grid where the day modal is placed dynamically so it
  never buries today or a precious near-future day.

All data is mock and community-level only — no people, no rosters.
