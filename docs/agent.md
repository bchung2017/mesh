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

## Turning it off

Unset `MESH_AGENT_ENABLED` (or remove the key). The endpoint goes back to 503 and
nothing can run.
