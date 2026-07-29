---
name: stackify-v1
description: >-
  Stand up a portable persistence stack that runs on zero-config SQLite by
  default and swaps to Postgres/Supabase when a connection string is present —
  and, crucially, isolates its tables inside a dedicated Postgres schema so it
  can share ONE Supabase project with other apps without their tables ever
  colliding (the "no-collision schema" pattern). Use this skill whenever the
  user wants to: share a single Supabase/Postgres instance across multiple apps
  or services without them stepping on each other; namespace an app's tables so
  it never touches `public`; add a SQLite-first cache/store that upgrades to
  Postgres on deploy; wire `search_path`/`DB_SCHEMA` isolation; or scaffold a
  small Python Flask + SQLite backend (with the same optional Postgres swap).
  Trigger on mentions of shared Supabase, DB_SCHEMA, search_path, schema
  isolation, "multiple apps one database", session pooler, SQLite-to-Postgres
  migration, or a Flask + SQLite stack — even if the user doesn't name this
  skill.
---

# stackify-v1

Two proven, portable persistence patterns you can drop into a project:

1. **The no-collision schema** — how to let an app live inside its own Postgres
   schema on a *shared* Supabase project, isolated from everything else in the
   database, touching nothing outside its namespace.
2. **The dual-backend store** — one async interface, SQLite by default (zero
   config), Postgres/Supabase when a connection string is set. Ships in both a
   TypeScript (Node) and a Python (Flask) flavor.

The goal is a stack that runs with **no setup** in dev and on ephemeral hosts,
persists across restarts/deploys in prod, and can **coexist with other apps in
one database** without a dedicated project per app.

## When to reach for this

- "I have one Supabase project and three little apps — I don't want to pay for
  three projects or risk their tables colliding."
- "Give this service its own namespace so it can never read/write/drop anything
  in `public`."
- "Start on SQLite, upgrade to Postgres later without rewriting the data layer."
- "Scaffold a small Flask + SQLite backend I can host on a free tier."

## The core idea: one schema per app

A Postgres **schema** is a namespace for tables. `public` is just the default
one. If every app that shares a database gets its own schema (`cs2`, `billing`,
`analytics`, …), their `snapshots` tables can't collide — `cs2.snapshots` and
`billing.snapshots` are different tables. The app:

- **creates** its schema idempotently (`CREATE SCHEMA IF NOT EXISTS <s>`),
- **pins** `search_path` to that schema on every pooled connection, so every
  unqualified query resolves inside it — no per-query qualification, no leakage,
- **never** reads, writes, drops, or truncates anything outside its schema.

That last rule is what makes sharing safe: another app's data is simply not on
the `search_path`, so a stray `DELETE FROM snapshots` can only ever hit *your*
`snapshots`.

### The five rules that make it collision-proof

1. **Validate the schema name as a bare SQL identifier before interpolating
   it.** It goes into DDL and connection options where bind parameters don't
   reach, so an unvalidated value is an injection vector. Accept only
   `^[A-Za-z_][A-Za-z0-9_]*$`; reject everything else loudly.
2. **Pin `search_path` at the connection level, not per query.** Set it once
   via the libpq startup `options` (`-c search_path=<schema>`) so it holds for
   the connection's whole life. Keeps every unqualified query honest and avoids
   a session-state race across pooled connections.
3. **This requires a *session-mode* connection.** A transaction-mode pooler
   resets session state between statements and won't preserve `search_path`. On
   Supabase that means the **Session pooler** (port `:5432` on
   `*.pooler.supabase.com`), which is the IPv4-friendly host you want anyway.
4. **DDL is unqualified; `search_path` places it.** `CREATE SCHEMA IF NOT
   EXISTS <s>;` then unqualified `CREATE TABLE IF NOT EXISTS …` — the tables
   land in `<s>` because it's first on the path. Ship the DDL as one idempotent
   batch applied on first use, so there's no manual migration step.
5. **Default to `public` and change nothing.** Unset schema → `public` → the
   app behaves exactly as a single-tenant app would. Isolation is opt-in.

Full walkthrough with copy-pasteable Node/`pg` code, the migration guard, and
the failure modes: **`references/nocollision-schema.md`**.

## The dual-backend store

Put both backends behind one interface and select by env at first use
(connection string present → Postgres, else SQLite). Keep the interface to raw
row-level reads/writes — domain logic (health checks, rate-limit guards, price
attachment) lives above it, so the two backends stay trivially swappable and
row-for-row identical.

Key properties to preserve across both backends:
- **Lazy + memoized construction** — pick and open the backend on first request,
  never at import/build time, so a production build doesn't open a DB handle or
  a pool. Pin the instance on a global so hot-reload doesn't reopen it.
- **Idempotent schema on first use** — both backends apply `CREATE TABLE IF NOT
  EXISTS …` themselves; no separate migrate step to forget.
- **Natural TEXT primary keys** (e.g. `steamid`, `assetid`) — no SERIAL
  sequences, so a SQLite→Postgres copy is a verbatim row insert with nothing to
  advance.
- **One-shot migration with a guard** — the SQLite→Postgres copier applies the
  schema, then *refuses to run if the target tables already hold rows*, so a
  second accidental run can't double-insert.

## Choose your flavor

- **TypeScript / Node** (Next.js route handlers, `pg`, `better-sqlite3`): the
  interface + both backends + the schema-isolation wiring →
  **`references/nocollision-schema.md`**.
- **Python / Flask + SQLite** (stdlib `sqlite3`, optional `psycopg` Postgres
  swap with the same schema isolation): project layout, app factory,
  blueprints, config, and both store backends →
  **`references/flask-sqlite-stack.md`**.

Both flavors implement the *same* no-collision rules above — the schema
isolation is identical; only the driver syntax differs.

## Quick checklist when applying this

- [ ] Schema name validated against `^[A-Za-z_][A-Za-z0-9_]*$` before any
      interpolation.
- [ ] `search_path` pinned via connection `options`, not per statement.
- [ ] Using the **Session pooler** (`:5432`), not the transaction pooler.
- [ ] `CREATE SCHEMA IF NOT EXISTS` + unqualified idempotent DDL, applied on
      first use.
- [ ] No query anywhere references another schema or a hardcoded `public.`.
- [ ] Backend chosen lazily by env; SQLite is the zero-config default.
- [ ] Migration copier guards against re-running into non-empty tables.
- [ ] Unset schema → `public`, behavior unchanged.
