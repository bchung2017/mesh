# No-collision schema on a shared Supabase/Postgres instance

How to let an app live inside its own Postgres schema on a **shared** Supabase
project — isolated from everything else in the database, touching nothing
outside its namespace. This is a **direct Postgres connection** (via `pg` /
`psycopg`), not the Supabase SDK: there is no `SUPABASE_URL` or anon key, only a
`DATABASE_URL` connection string.

## Table of contents

- [Why a schema, not a project](#why-a-schema-not-a-project)
- [The connection string: use the Session pooler](#the-connection-string-use-the-session-pooler)
- [Step 1 — validate the schema name](#step-1--validate-the-schema-name)
- [Step 2 — pin search_path on the pool](#step-2--pin-search_path-on-the-pool)
- [Step 3 — apply the schema idempotently on first use](#step-3--apply-the-schema-idempotently-on-first-use)
- [Step 4 — write unqualified queries](#step-4--write-unqualified-queries)
- [The one-shot migration guard](#the-one-shot-migration-guard)
- [Environment variables](#environment-variables)
- [Failure modes and how this avoids them](#failure-modes-and-how-this-avoids-them)

## Why a schema, not a project

Spinning up a separate Supabase project per app is the "safe" default, but it
costs a project (and its free-tier limits) for every little service. A Postgres
**schema** is a namespace inside one database. Give each app its own — `cs2`,
`billing`, `analytics` — and their identically-named tables can't collide:
`cs2.snapshots` and `billing.snapshots` are distinct objects. Sharing is safe
because the other app's tables are simply not on your `search_path`.

## The connection string: use the Session pooler

Point `DATABASE_URL` at a Supabase **Session pooler** URI:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

- Port **`:5432`** on `*.pooler.supabase.com` is the **session** pooler.
- It's the **IPv4-compatible** host. The direct `db.*.supabase.co` host is
  IPv6-only, and many PaaS hosts (Render, etc.) have no IPv6 egress.
- **Session mode is mandatory here** because we pin `search_path` for the life
  of each connection (below). A transaction-mode pooler recycles session state
  between statements and would silently drop the `search_path`, sending your
  unqualified queries into `public`.

Supabase presents a TLS cert that doesn't chain to Node's default CA bundle;
`ssl: { rejectUnauthorized: false }` is the pragmatic default. For a local
plaintext Postgres, allow an env flag (`DATABASE_SSL=disable`) to turn SSL off.

## Step 1 — validate the schema name

The schema name is interpolated into DDL and into the connection `options`
string — places where bind parameters (`$1`) don't reach. An unvalidated value
is a SQL-injection vector. Accept only a bare identifier and throw otherwise:

```ts
export function pgSchema(): string {
  const s = process.env.DB_SCHEMA ?? "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(
      `Invalid DB_SCHEMA "${s}" — must be a bare SQL identifier ([A-Za-z_][A-Za-z0-9_]*).`,
    );
  }
  return s;
}
```

Defaulting to `public` means the isolation is opt-in: unset → the app behaves
exactly like an ordinary single-tenant app.

## Step 2 — pin search_path on the pool

Set `search_path` **once per connection** via the libpq startup `options`, not
per query. Every unqualified query then resolves inside your schema, with no
per-query qualification and no session-state race across pooled connections:

```ts
import { Pool, types } from "pg";

// pg returns BIGINT (OID 20) as a string; our BIGINTs are epoch-ms + ids inside
// JS's safe-integer range, so parse to Number to match the SQLite backend shape.
types.setTypeParser(20, (v) => (v == null ? null : Number(v)) as unknown as number);

const schema = pgSchema();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX ?? 3), // keep small behind the pooler / free tier
  options: `-c search_path=${schema}`,       // <-- the crux
});
```

Because this rides the libpq startup `options`, it needs the **session-mode**
connection from the previous section. That's the single most common way this
pattern breaks: transaction pooler → `search_path` silently ignored.

## Step 3 — apply the schema idempotently on first use

Keep the DDL as the single source of truth (a `schema.sql` file shared with the
migration script) and apply it — schema first, then tables — as one idempotent
batch on the first request. No manual migrate step to forget:

```ts
// schema.sql contains only unqualified `CREATE TABLE IF NOT EXISTS …`.
await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}; ${schemaSql()}`);
```

Do this lazily and memoize it (a `ready` promise), so it runs exactly once and
never at import/build time. Running `CREATE SCHEMA` + the tables in one batch
keeps them on a single connection, so the tables land in the just-created schema.

Example `schema.sql` (note: **unqualified** table names — `search_path` places
them; natural TEXT primary keys so a SQLite copy needs no sequence handling):

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  steamid    TEXT   PRIMARY KEY,
  fetched_at BIGINT NOT NULL,   -- epoch ms
  payload    TEXT   NOT NULL    -- JSON blob
);

CREATE TABLE IF NOT EXISTS item_meta (
  assetid     TEXT PRIMARY KEY,
  float       DOUBLE PRECISION,
  paint_seed  BIGINT,
  paint_index BIGINT,
  fetched_at  BIGINT NOT NULL
);
```

## Step 4 — write unqualified queries

Every query is unqualified — no `public.`, no hardcoded schema. `search_path`
resolves them into your namespace, so the *same SQL* works whether the app owns
the database or shares it:

```ts
await pool.query(
  "INSERT INTO snapshots(steamid,fetched_at,payload) VALUES($1,$2,$3) " +
  "ON CONFLICT(steamid) DO UPDATE SET fetched_at=excluded.fetched_at, payload=excluded.payload",
  [steamid, fetchedAt, payload],
);
```

Grep your data layer for a literal `public.` or any other schema name before
shipping — there should be none. A hardcoded schema is how a "shared" app
reaches into a neighbor's tables.

## The one-shot migration guard

When copying an existing SQLite DB into the shared Postgres schema, apply the
schema first (idempotent), then **refuse to run if the target tables already
hold rows** so a second accidental run can't double-insert:

```ts
const dst = new Pool({
  connectionString: dsn,
  ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  options: `-c search_path=${schema}`,
});
await dst.query(`CREATE SCHEMA IF NOT EXISTS ${schema}; ${schemaSql()}`);

for (const table of ["snapshots", "item_meta"]) {
  const n = Number((await dst.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  if (n) {
    console.error(`refusing to run: ${table} already has ${n} rows in Postgres`);
    process.exit(1);
  }
}
// …then copy rows verbatim (natural PKs, no sequences to advance).
```

## Environment variables

| Var            | Effect                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL` | Set → Postgres/Supabase backend; unset → on-disk SQLite.               |
| `DB_SCHEMA`    | Postgres schema (namespace) for this app's tables. Default `public`.   |
| `DATABASE_SSL` | `disable` for a local plaintext Postgres (Supabase needs TLS).         |
| `PGPOOL_MAX`   | Max pool connections (default 3). Keep small behind the pooler.        |

## Failure modes and how this avoids them

| Failure | Cause | This pattern's defense |
| --- | --- | --- |
| Queries land in `public` despite `DB_SCHEMA` | Using the **transaction** pooler; `search_path` reset between statements | Require the **Session pooler** (`:5432`); pin via connection `options` |
| SQL injection via schema name | Interpolating an untrusted `DB_SCHEMA` into DDL | Validate against `^[A-Za-z_][A-Za-z0-9_]*$`, throw otherwise |
| App clobbers a neighbor's `snapshots` | A hardcoded `public.snapshots` or cross-schema query | All queries unqualified; nothing outside the schema is on the path |
| Double-inserted rows after re-migrating | Migration script run twice | Guard: refuse if target tables are non-empty |
| Pool/handle opened during `build` | Backend constructed at import time | Lazy + memoized construction on first request |
| IPv6-only host unreachable from PaaS | Using `db.*.supabase.co` directly | Use the IPv4 `*.pooler.supabase.com` host |
