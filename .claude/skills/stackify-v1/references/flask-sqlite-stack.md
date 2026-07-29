# Python Flask + SQLite stack (with optional shared-Supabase swap)

A small, portable Flask backend that runs on zero-config SQLite by default and
swaps to Postgres/Supabase when `DATABASE_URL` is set — applying the **same**
no-collision schema isolation as the Node flavor (see
`nocollision-schema.md`; only the driver syntax differs). This is a **direct
Postgres connection** via `psycopg`, not the Supabase SDK.

## Table of contents

- [When to pick this stack](#when-to-pick-this-stack)
- [Project layout](#project-layout)
- [Dependencies](#dependencies)
- [Config: choose the backend by env](#config-choose-the-backend-by-env)
- [The store interface](#the-store-interface)
- [SQLite backend (default)](#sqlite-backend-default)
- [Postgres backend (shared Supabase, schema-isolated)](#postgres-backend-shared-supabase-schema-isolated)
- [App factory + blueprint](#app-factory--blueprint)
- [Entry point and running it](#entry-point-and-running-it)
- [One-shot SQLite → Postgres migration](#one-shot-sqlite--postgres-migration)

## When to pick this stack

- A small service you want to host on a free tier with **no database to
  provision** — SQLite is a file, it just works.
- Later, on a real deploy, point `DATABASE_URL` at a **shared** Supabase project
  and the same code persists across restarts — isolated in its own schema so it
  can coexist with other apps in that one project.
- You want an explicit, dependency-light data layer (stdlib `sqlite3` +
  `psycopg`) rather than a full ORM.

## Project layout

```
myapp/
├── app/
│   ├── __init__.py          # create_app() factory
│   ├── config.py            # env -> config; backend selection
│   ├── stores/
│   │   ├── __init__.py       # get_store(): pick backend by env, memoized
│   │   ├── base.py           # Store ABC (the interface)
│   │   ├── sqlite_store.py    # default backend
│   │   └── postgres_store.py  # shared-Supabase backend (psycopg)
│   ├── api/
│   │   └── routes.py         # a Blueprint of endpoints
│   └── schema.sql            # single source of truth for table DDL (unqualified)
├── scripts/
│   └── migrate_sqlite_to_pg.py
├── wsgi.py                   # gunicorn entry: app = create_app()
├── requirements.txt
└── .env.example
```

## Dependencies

`requirements.txt`:

```
Flask>=3.0
psycopg[binary]>=3.1   # only needed when DATABASE_URL is set
python-dotenv>=1.0     # optional: load .env in dev
gunicorn>=21.0         # prod WSGI server
```

`sqlite3` is in the Python stdlib — no dependency for the default backend.

## Config: choose the backend by env

`app/config.py`:

```python
import os
import re

# Same rule as the Node flavor: the schema name is interpolated into DDL and the
# connection options, where bind params don't reach — validate it as a bare SQL
# identifier or refuse to start.
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def pg_schema() -> str:
    s = os.environ.get("DB_SCHEMA", "public")
    if not _IDENT.match(s):
        raise ValueError(
            f'Invalid DB_SCHEMA "{s}" — must be a bare SQL identifier '
            r"([A-Za-z_][A-Za-z0-9_]*)."
        )
    return s


class Config:
    DATABASE_URL = os.environ.get("DATABASE_URL")          # set -> Postgres
    DATABASE_SSL = os.environ.get("DATABASE_SSL")           # "disable" for local PG
    SQLITE_PATH = os.environ.get("SQLITE_PATH", "loader.db")
    PGPOOL_MAX = int(os.environ.get("PGPOOL_MAX", "3"))
    USE_POSTGRES = bool(DATABASE_URL)
```

## The store interface

`app/stores/base.py` — keep it to raw row-level reads/writes; domain logic lives
in the routes/services above it, so the two backends stay swappable and
row-for-row identical:

```python
from abc import ABC, abstractmethod


class Store(ABC):
    backend: str

    @abstractmethod
    def get_snapshot(self, key: str) -> dict | None: ...

    @abstractmethod
    def upsert_snapshot(self, key: str, fetched_at: int, payload: str) -> None: ...

    @abstractmethod
    def all_snapshots(self) -> list[dict]: ...

    @abstractmethod
    def delete_snapshot(self, key: str) -> int: ...

    @abstractmethod
    def delete_all(self) -> int: ...
```

`app/stores/__init__.py` — select by env at first use and memoize, so the
backend is chosen once and never at import time:

```python
from functools import lru_cache
from ..config import Config
from .base import Store


@lru_cache(maxsize=1)
def get_store() -> Store:
    if Config.USE_POSTGRES:
        from .postgres_store import PostgresStore
        return PostgresStore()
    from .sqlite_store import SqliteStore
    return SqliteStore()
```

`app/schema.sql` — unqualified DDL, natural TEXT primary keys (so a
SQLite→Postgres copy needs no sequence handling). Written to be valid in both
engines:

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  key        TEXT PRIMARY KEY,
  fetched_at BIGINT NOT NULL,
  payload    TEXT   NOT NULL
);
```

## SQLite backend (default)

`app/stores/sqlite_store.py` — opens the file lazily, applies the schema on
first use, uses `sqlite3.Row` for dict-like access. Note `check_same_thread=
False` + a lock because Flask serves requests on multiple threads:

```python
import sqlite3
import threading
from pathlib import Path
from ..config import Config
from .base import Store


class SqliteStore(Store):
    backend = "sqlite"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._db = sqlite3.connect(Config.SQLITE_PATH, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL;")
        ddl = (Path(__file__).resolve().parent.parent / "schema.sql").read_text()
        self._db.executescript(ddl)

    def get_snapshot(self, key: str) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT key, fetched_at, payload FROM snapshots WHERE key=?", (key,)
            ).fetchone()
        return dict(row) if row else None

    def upsert_snapshot(self, key: str, fetched_at: int, payload: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO snapshots(key,fetched_at,payload) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET "
                "fetched_at=excluded.fetched_at, payload=excluded.payload",
                (key, fetched_at, payload),
            )
            self._db.commit()

    def all_snapshots(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT key, fetched_at, payload FROM snapshots"
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_snapshot(self, key: str) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM snapshots WHERE key=?", (key,))
            self._db.commit()
            return cur.rowcount

    def delete_all(self) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM snapshots")
            self._db.commit()
            return cur.rowcount
```

## Postgres backend (shared Supabase, schema-isolated)

`app/stores/postgres_store.py` — a `psycopg` connection pool with `search_path`
pinned to the app's schema via the libpq startup `options`, exactly like the
Node flavor. Read `nocollision-schema.md` for the *why* behind each line; the
five rules are identical.

```python
from pathlib import Path
from psycopg_pool import ConnectionPool
from ..config import Config, pg_schema
from .base import Store


class PostgresStore(Store):
    backend = "postgres"

    def __init__(self) -> None:
        schema = pg_schema()  # validated bare identifier
        sslmode = "disable" if Config.DATABASE_SSL == "disable" else "require"
        # Pin search_path for the whole connection via libpq `options`. This
        # needs a SESSION-mode connection: the Supabase Session pooler (:5432).
        # A transaction pooler would reset it between statements.
        conninfo = (
            f"{Config.DATABASE_URL}"
            f"?sslmode={sslmode}&options=-c%20search_path%3D{schema}"
        )
        self._pool = ConnectionPool(
            conninfo, min_size=1, max_size=Config.PGPOOL_MAX, open=True
        )
        ddl = (Path(__file__).resolve().parent.parent / "schema.sql").read_text()
        with self._pool.connection() as conn:
            # Schema first, then unqualified tables — search_path places them.
            conn.execute(f"CREATE SCHEMA IF NOT EXISTS {schema};")
            conn.execute(ddl)

    def get_snapshot(self, key: str) -> dict | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT key, fetched_at, payload FROM snapshots WHERE key=%s", (key,)
            ).fetchone()
        if not row:
            return None
        return {"key": row[0], "fetched_at": row[1], "payload": row[2]}

    def upsert_snapshot(self, key: str, fetched_at: int, payload: str) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO snapshots(key,fetched_at,payload) VALUES(%s,%s,%s) "
                "ON CONFLICT(key) DO UPDATE SET "
                "fetched_at=excluded.fetched_at, payload=excluded.payload",
                (key, fetched_at, payload),
            )

    def all_snapshots(self) -> list[dict]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                "SELECT key, fetched_at, payload FROM snapshots"
            ).fetchall()
        return [{"key": r[0], "fetched_at": r[1], "payload": r[2]} for r in rows]

    def delete_snapshot(self, key: str) -> int:
        with self._pool.connection() as conn:
            cur = conn.execute("DELETE FROM snapshots WHERE key=%s", (key,))
            return cur.rowcount

    def delete_all(self) -> int:
        with self._pool.connection() as conn:
            cur = conn.execute("DELETE FROM snapshots")
            return cur.rowcount
```

Every query above is **unqualified** — no `public.`, no hardcoded schema — so
the identical SQL works whether the app owns the database or shares it. That's
what keeps a stray `DELETE FROM snapshots` inside your own namespace.

## App factory + blueprint

`app/api/routes.py`:

```python
from flask import Blueprint, jsonify, request
from ..stores import get_store

bp = Blueprint("api", __name__, url_prefix="/api")


@bp.get("/health")
def health():
    return jsonify(backend=get_store().backend)


@bp.get("/snapshots/<key>")
def read(key: str):
    row = get_store().get_snapshot(key)
    return (jsonify(row), 200) if row else (jsonify(error="not found"), 404)


@bp.put("/snapshots/<key>")
def write(key: str):
    body = request.get_json(force=True)
    get_store().upsert_snapshot(key, body["fetched_at"], body["payload"])
    return jsonify(ok=True)
```

`app/__init__.py`:

```python
from flask import Flask
from .config import Config


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)
    from .api.routes import bp
    app.register_blueprint(bp)
    return app
```

## Entry point and running it

`wsgi.py`:

```python
from app import create_app
app = create_app()
```

```bash
# dev — zero config, SQLite:
flask --app wsgi run --debug            # http://127.0.0.1:5000

# prod — shared Supabase, isolated schema:
export DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
export DB_SCHEMA=myapp
gunicorn wsgi:app
```

Unset `DATABASE_URL` → SQLite. Set it (Session pooler URI) + `DB_SCHEMA` →
Postgres, isolated in `myapp`. Nothing else changes.

## One-shot SQLite → Postgres migration

`scripts/migrate_sqlite_to_pg.py` — apply schema, guard against a non-empty
target, then copy rows verbatim (natural PKs, nothing to advance):

```python
import os
import sqlite3
import sys
from pathlib import Path
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import Config, pg_schema  # noqa: E402


def main() -> None:
    src_path = sys.argv[1] if len(sys.argv) > 1 else Config.SQLITE_PATH
    dsn = os.environ["DATABASE_URL"]
    schema = pg_schema()
    ddl = (Path(__file__).resolve().parent.parent / "app" / "schema.sql").read_text()

    src = sqlite3.connect(src_path)
    src.row_factory = sqlite3.Row
    opts = f"-c search_path={schema}"
    with psycopg.connect(dsn, options=opts) as dst:
        dst.execute(f"CREATE SCHEMA IF NOT EXISTS {schema};")
        dst.execute(ddl)
        # Refuse to double-insert into a populated table.
        (n,) = dst.execute("SELECT count(*) FROM snapshots").fetchone()
        if n:
            sys.exit(f"refusing to run: snapshots already has {n} rows in Postgres")
        rows = src.execute("SELECT key, fetched_at, payload FROM snapshots").fetchall()
        with dst.cursor() as cur:
            cur.executemany(
                "INSERT INTO snapshots(key,fetched_at,payload) VALUES(%s,%s,%s)",
                [(r["key"], r["fetched_at"], r["payload"]) for r in rows],
            )
        print(f"copied {len(rows)} rows into schema {schema}")


if __name__ == "__main__":
    main()
```
