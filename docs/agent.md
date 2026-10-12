# mesh: the autonomous agent

An optional layer that lets Claude maintain the blobs on its own — create, update
and delete communities, log contributions, and manage mesh's own calendar events
— on a schedule and on demand.

## How it's wired

```
scheduler (GitHub Action)  ──POST /api/agent/run──▶  run_agent()  ──tools──▶  services.py  ──▶  DB
   (or you, manually)            + shared secret       (Claude loop)     (the same code the REST API uses)
```

- **`services.py`** holds every domain operation (the single source of the rules
  and validation). The REST routes and the agent both call it — the agent can
  never drift from the API or bypass its checks.
- **`agent.py`** gives Claude one tool per operation and runs a tool-use loop
  (`MAX_STEPS` cap). Claude decides *which* tools to call; the deterministic math
  and validation stay in `services.py`.
- **`POST /api/agent/run`** runs one session now. **`agent_run.py`** is the same
  thing from the command line, for a scheduler.

### What it can and can't touch

| Can | Can't |
|---|---|
| Create / update / delete communities | Set involvement/delta/energy (derived — it logs contributions instead) |
| Log / edit / delete contributions | Write to your real Google Calendar (read-only mirror) |
| Create / edit / delete **mesh** events | — |
| **Read** the Google-calendar feed for context | — |

It's **fully autonomous**: changes apply with no confirmation. That's why it's
triple-gated (see below) and capped at `MAX_STEPS` tool rounds per run.

## Enabling it

On the Render service (**Environment**), set all three:

- `ANTHROPIC_API_KEY` — your key (also powers contribution autofill).
- `MESH_AGENT_ENABLED` = `1` — the on switch. Unset ⇒ the endpoint returns 503.
- `MESH_AGENT_TOKEN` — a long random string; the endpoint requires it as
  `Authorization: Bearer <token>` once set.

Optional: `MESH_AGENT_MODEL` (default `claude-haiku-4-5`; bump to
`claude-sonnet-5-5` for tougher judgment at higher cost).

## Triggering it

**Manually / from a scheduler** — POST the endpoint:

```sh
curl -X POST https://<your-app>/api/agent/run \
  -H "Authorization: Bearer $MESH_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instruction": "log a contribution to NYC Hardware for last night’s meetup"}'
```

No `instruction` ⇒ a light, safe maintenance pass (it reviews state and only acts
when clearly warranted). The response is `{summary, actions, steps}`.

**On a schedule** — `.github/workflows/agent.yml` runs daily (and has a manual
"Run workflow" button). Set two repo secrets: `MESH_URL` (your app URL) and
`MESH_AGENT_TOKEN` (the same value as on Render). Render's free tier has no cron,
so the Action is the scheduler; all the work still happens server-side.

**From the command line** (e.g. a Render Shell, where the env is already set):

```sh
cd /app/backend && python agent_run.py "tidy up stale communities"
```

## Calendar-driven mode (generate everything from your calendar)

The agent can keep mesh purely a reflection of your Google calendar: a **one-time
backfill** of the year so far, then a **daily incremental** run. It's idempotent —
re-running never double-counts — because it materializes each feed occurrence
(stable `uid`) and logs a contribution linked to it, and `(event, community)` is a
unique upsert. Requires `MESH_ICS_URL` (the calendar feed) set on the service.

**One-time backfill** — run once (manually, or via the GitHub Action's "Run
workflow" box):

> Read my calendar from 2026-01-01 to today in month-sized windows. For each
> event that represents involvement with a community (a meetup, workshop, build
> night, volunteer shift, organizing call), decide which community it belongs to —
> create the community if it doesn't exist yet — then materialize the event and
> log a contribution linked to it, choosing a mode and weight that fit. Skip
> purely personal events (appointments, travel, errands). Summarize what you
> created and logged.

**Daily incremental** — the scheduled run's instruction (edit it in the Action, or
rely on the default maintenance pass):

> Read my calendar for the last 10 days. For each community event not already
> logged, materialize it and log a contribution. Don't touch anything already
> logged.

Tuning knobs you own: how an event maps to a community (title/attendees), what
counts as "a community event" vs. personal, and the mode/weight heuristics — all
live in the instruction text, so you refine behavior by editing the prompt, not
the code. Involvement still falls out of the logged contributions automatically
(decayed over time), so a community you stop showing up for fades on its own.

## Turning it off

Unset `MESH_AGENT_ENABLED` (or remove the key). The endpoint goes back to 503 and
nothing can run.
