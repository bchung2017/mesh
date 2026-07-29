# mesh

A warm map of the communities you belong to. Each community is a soft-body
"blob" sized by how involved you are; drag them around the field, browse them as
a list, or plan gatherings on the calendar.

Full stack: a **Vite + TypeScript** frontend talking to a **Flask + SQLite**
backend over a small JSON API.

## Stack

**Frontend**
- **[Vite](https://vitejs.dev/)** — dev server + build
- **TypeScript** — typed, no runtime framework (the app is canvas + imperative DOM)
- **WebGL** with a 2D-canvas fallback for the blob field

**Backend**
- **[Flask](https://flask.palletsprojects.com/)** — JSON API + serves the built frontend
- **[Flask-SQLAlchemy](https://flask-sqlalchemy.palletsprojects.com/)** over **SQLite** by default
- Swaps to **Postgres/Supabase** via `DATABASE_URL`, isolated in its own schema
  so it can share one database with other apps without colliding

## Getting started

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python wsgi.py            # serves the API on http://localhost:5000
```

On first run it creates the SQLite database (`backend/instance/mesh.db`) and
seeds it with the mock communities and a few events.

To use a different database, copy `backend/.env.example` to `backend/.env` and
set `DATABASE_URL`, or export it in the shell:

```bash
export DATABASE_URL=postgresql://user:pass@host:5432/mesh
```

### Sharing one Postgres/Supabase project (no-collision schema)

mesh can live inside its own Postgres **schema** on a database it shares with
other apps, isolated so it never touches anything outside its namespace. This
follows the `stackify-v1` pattern (`.claude/skills/stackify-v1/`).

```bash
# Supabase SESSION pooler host (port :5432 — required, see below)
export DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
export DB_SCHEMA=mesh        # mesh's tables live here; default is public
```

How it stays collision-proof:

- **`DB_SCHEMA` is validated** as a bare SQL identifier before it's ever
  interpolated (`^[A-Za-z_][A-Za-z0-9_]*$`), then the schema is created
  idempotently (`CREATE SCHEMA IF NOT EXISTS`) on first boot.
- **`search_path` is pinned to the schema per connection** (via libpq
  `options`), so every unqualified query resolves inside mesh's namespace — a
  neighbor app's `events` table is simply not on the path.
- **Session pooler required.** Pinning `search_path` needs a session-mode
  connection; the Supabase Session pooler (`:5432`) provides it (and is
  IPv4-friendly). The transaction pooler would drop the path.
- **`postgres://` URLs are normalized** to `postgresql+psycopg://` (psycopg 3).
- **Unset `DATABASE_URL` → SQLite, unset `DB_SCHEMA` → `public`.** Isolation is
  opt-in; nothing changes for single-tenant use.

Migrate an existing SQLite database into the shared schema (guards against
double-inserting into non-empty tables):

```bash
cd backend
python scripts/migrate_sqlite_to_pg.py [path/to/mesh.db]
```

Additional env vars: `DATABASE_SSL=disable` (local plaintext Postgres only),
`PGPOOL_MAX` (max pool connections, default 3). See `backend/.env.example`.

Run the backend tests:

```bash
cd backend && python -m unittest discover -s tests
```

### 2. Frontend

```bash
npm install
npm run dev              # http://localhost:5173, proxies /api to :5000
```

Vite proxies `/api/*` to the Flask server, so both run side by side in dev.
Override the target with `MESH_API_URL` if the backend is elsewhere.

### Production (single origin)

```bash
npm run build            # emits dist/
cd backend && python wsgi.py   # Flask serves dist/ AND the API on one port
```

Or point a WSGI server at it: `gunicorn wsgi:app` (from `backend/`).

## Deploy (Render Blueprint)

The repo ships a `render.yaml` Blueprint and a multi-stage `Dockerfile` (Node
build stage → Python runtime; Flask serves `dist/` + the API on one port).

1. Push to GitHub.
2. In Render: **New → Blueprint**, point it at this repo. It reads `render.yaml`
   and creates one Docker web service.
3. Set the secret **`DATABASE_URL`** in the service's Environment tab — the
   Supabase **Session pooler** URL (`:5432`). `DB_SCHEMA` defaults to `mesh`.
   Leave `DATABASE_URL` unset to run on ephemeral SQLite (data resets on deploy).
4. Deploy. Health check is `/api/health` (reports the active backend + schema).

Build the image locally the same way Render does:

```bash
docker build -t mesh .
docker run -p 5000:5000 -e DATABASE_URL=... -e DB_SCHEMA=mesh mesh
```

`WEB_CONCURRENCY` is 1 by default so first-boot seeding can't race across
workers; raise it once seeding is gated for your deployment.

## API

Base path `/api`. All community/event fields use the same camelCase keys as the
frontend TypeScript types.

| Method   | Path               | Purpose                                   |
| -------- | ------------------ | ----------------------------------------- |
| `GET`    | `/health`          | liveness + active backend/schema          |
| `GET`    | `/communities`     | list communities (field + blobs data)     |
| `GET`    | `/events`          | list calendar events                      |
| `POST`   | `/events`          | create an event `{date,time,name,tone}`   |
| `DELETE` | `/events/:id`      | delete an event                           |

## Layout

```
index.html              markup only (no inline styles or scripts)
vite.config.ts          build + /api dev proxy
src/
  main.ts               entry — loads data from the API, boots every view
  api.ts                typed fetch wrappers for the backend
  types.ts              shared types (Community, CalEvent, tones…)
  dom.ts                byId() helper
  styles/               design tokens + per-view CSS
  field/                blob field: palette, texture bake, physics engine
  views/                tabs, blobs list + sheet, calendar, nudges
backend/
  wsgi.py               dev entry / WSGI app (wsgi:app)
  requirements.txt
  .env.example
  mesh_api/
    __init__.py         create_app factory, db init, schema creation, static serving
    config.py           backend selection + no-collision schema isolation
    models.py           Community, Event (to_dict → camelCase JSON)
    routes.py           /api blueprint
    seed.py             one-time seed of mock data when tables are empty
  scripts/
    migrate_sqlite_to_pg.py   one-shot SQLite → Postgres copier (guarded)
  tests/
    test_config.py      backend-selection + schema-isolation unit tests
```

## The three views

- **the field** — a WebGL soft-body simulation. Blobs breathe, drift, dent each
  other on contact, and lean toward nearby neighbors. Radius encodes
  involvement. Falls back to a 2D-canvas renderer where WebGL is unavailable.
- **blobs** — every community as a row; tap for a detail sheet (involvement
  trend, tenure, energy, last artifact, next gathering, and the read).
- **calendar** — a month grid where the day modal is placed dynamically so it
  never buries today or a precious near-future day. Events are loaded from and
  persisted to the backend.

All data is mock and community-level only — no people, no rosters.
