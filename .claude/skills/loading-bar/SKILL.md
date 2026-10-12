---
name: loading-bar
description: >-
  Add a full-stack, responsive progress/loading bar for a long-running backend
  operation (a sync, import, batch job, migration, multi-step AI/agent run, report
  build) that is SESSION-PROOF (survives a page refresh and resumes), CANCELLABLE
  from the UI, and shows real percentage — WITHOUT background workers or threads.
  The core pattern: don't run long work in a background thread (it hangs on single
  worker hosts) or one long request (it times out); instead persist it as a
  resumable job and have the frontend drive it one short step at a time. Use this
  whenever a request takes long enough to need a progress bar, when a "sync/
  processing" bar gets stuck at 0% or a long request times out (502), when you
  need a cancel button that actually works, or when progress must survive a
  reload. Especially on constrained PaaS (Render/Fly/Railway free tiers, single
  gunicorn/uWSGI worker, short request timeouts). Backend-agnostic; templates are
  Flask + vanilla TS, with notes to port.
---

# loading-bar

A progress bar is the easy part. The hard part is the thing behind it: a job that
can run for a minute, show real progress, be cancelled, and still be there after a
refresh — on hosting that kills long requests and where background threads are
unreliable. This skill is that architecture.

Copy-paste templates (job model, endpoints, the step function, the frontend
controller, CSS) are in `references/templates.md`. Read it when you start.

## The one idea

**Don't hold the work open. Persist it and step it.**

- ❌ A **background thread** spawned from a request handler: on a single sync
  worker it hangs or dies when the worker recycles, so the bar sticks at 0% and
  cancel can't interrupt it. (This is the failure that motivated the skill.)
- ❌ One **long synchronous request** doing all the work: it blows past the host's
  request timeout → 502 → "failed", and there's no progress or cancel.
- ✅ A **job row** that holds the work's resumable state, advanced **one short step
  per request**, with the **client driving the loop**. Each step runs on the exact
  normal request path that already works, so it can't hang. Progress, cancel, and
  resume all fall out of this for free.

## The pieces

### Backend

1. **A job table** (`Job`): `id`, `status` (running|done|failed|cancelled),
   `steps_done`, `steps_total`, `summary`/`error`, and **`state`** — a JSON blob
   holding everything needed to resume (the cursor, the accumulated work, an
   AI conversation, whatever). `percent()` = `steps_done/steps_total`, **capped
   below 100 while running** so it only hits 100 when truly done.

2. **A `step(state) -> (state, finished, summary)` function**: does ONE unit of
   work — fast, bounded — over plain JSON-serializable state, so a run can be
   saved and resumed across requests. No global/loop state.

3. **Four endpoints**:
   - `POST /job` → create the job (status running, initial `state`), return it.
   - `POST /job/<id>/step` → load state, run one `step`, save progress, return the
     job. Short request. On a step error → mark the job `failed` (never 500 the
     loop). If already terminal → return as-is (idempotent).
   - `POST /job/<id>/cancel` → set status `cancelled` immediately.
   - `GET /job/active` → the current running job, for **resume on reload**.

### Frontend

4. **A global progress bar** (fixed, full-width, one gutter on mobile): a fill
   whose width is `job.percent`, a label (`"<verb> · <percent>% · <detail>"`), and
   a **cancel** button. One element, visible on every view.

5. **A step loop**: `start` → POST `/job` → then `await step` in a `while` loop,
   painting the bar after each, until `status !== 'running'`. Each `/step` is a
   short request, so the loop is naturally paced; give each a **client-side
   timeout** (AbortController) so one slow step can't wedge it, and a small
   **consecutive-error cap** so a dead server ends the loop instead of spinning.

6. **Bulletproof cancel**: on click, stop the loop and clear the bar **locally
   first** (so the user is never stuck even if the server is unresponsive), then
   best-effort POST `/cancel`. Guard the loop so a step whose response arrives
   after cancel is ignored.

7. **Resume on load**: call `GET /job/active`; if one is running, show the bar and
   re-enter the step loop — it continues from the server-side `state`. (Belt-and-
   suspenders: also stash the job id in `localStorage`.)

## Gotchas that will bite (each cost real debugging here)

- **G1 — no background threads for the work.** On a single sync worker they hang
  (bar stuck at 0%) and can't be cancelled. The whole point of stepping is to
  avoid them. If you think you need a thread, you need a step loop.
- **G2 — a long request times out.** Keep each `/step` short (one unit of work).
  Don't "just raise the gunicorn timeout" to cover a 2-minute request — the host's
  own proxy will still cut it.
- **G3 — adding the job table's columns later breaks the deploy.** `create_all`
  (and bare ORMs) only create missing *tables*, never add a column to an existing
  one — so a new field (like `state`) 500s against an older schema. Self-heal it
  on boot with an idempotent `ALTER TABLE … ADD COLUMN` (SQLite + Postgres), or
  put resumable state in a *separate* table from day one. (See the migration
  helper in the templates.)
- **G4 — cap the percent below 100 while running**, and only snap to 100 on
  `done`; otherwise a fast job flickers to 100% then "finishes."
- **G5 — the step loop must stop on cancel even mid-request.** Capture the job id,
  null your "active" marker synchronously on cancel, and check it again after each
  `await` so an in-flight step's result is discarded.
- **G6 — don't persist non-serializable state.** Convert SDK/response objects to
  plain dicts before saving `state` (so it survives JSON round-trips across steps).
- **G7 — reap orphans.** A job abandoned mid-run stays `running`. Either resume it
  on next load (the feature), or retire stale/old-format jobs so they don't block
  new ones. Jobs with no resumable `state` (e.g. from an older design) → mark
  failed, don't try to resume.
- **G8 — "finished" must mean the work actually happened, not just "this step
  produced no more work to schedule."** The bar hitting 100% is only honest if the
  job really did the thing. The nastiest version: the step *thinks* it's done when
  it isn't, so the loop stops, the bar snaps to 100%, and nothing was written —
  which looks like success. This bites hardest in **AI/agent loops**: a model
  response that got cut off at the token cap (`stop_reason: "max_tokens"`), or an
  intermediate "I'll now do X:" narration, is NOT a completion — but code that
  finishes on "anything that isn't another tool call" treats it as one, ending the
  run right before the actual work. Detect the *genuine* terminal condition (the
  model's natural end, the cursor truly reaching the end, the goal satisfied); on
  an inconclusive stop (truncation, "needs another turn"), **continue the loop or
  raise the budget** — don't finish. Corollary: don't pipe the step's raw
  intermediate text into the job summary / completion toast, or a truncated plan
  becomes a garbage "done" message. (This one cost real debugging: a sync bar that
  reached 100% every time and never changed a thing.)

## Verify before handoff

- A step returns in well under the host timeout (ideally < a few seconds); it
  **fails fast, never hangs** (test with a forced error — you want `failed`, not a
  spinner).
- Start → the bar appears and the **percentage advances** step by step to `done`.
- A **`done` job actually did the work** — the rows were written / the goal met —
  not just reported done (G8). For an AI/agent step, force a truncated response
  (`max_tokens`) and confirm the loop **continues** instead of finishing at 100%.
- **Refresh mid-run** → the bar reappears at the right % and continues (session-
  proof).
- **Cancel** → the bar clears instantly and the job is marked cancelled server-side.
- The bar fits phone width (fixed, full-width, 16px gutters, no horizontal scroll).
