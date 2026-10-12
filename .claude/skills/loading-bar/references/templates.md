# loading-bar — templates

Proven starting points (Flask + SQLAlchemy backend, vanilla TS frontend). Rename
`Job`/`do_work` to your domain. Ports: the shape is the same in Express/FastAPI/
Rails — a job row with JSON `state`, a `step` function, four endpoints, and a
client step-loop.

## 1. Job model (SQLAlchemy)

```python
import json
from datetime import datetime, timezone
from . import db

class Job(db.Model):
    __tablename__ = "jobs"
    id = db.Column(db.Integer, primary_key=True)
    status = db.Column(db.String(16), nullable=False, default="running")  # running|done|failed|cancelled
    kind = db.Column(db.String(32))               # label for the UI (e.g. "import", "deep sync")
    steps_done = db.Column(db.Integer, nullable=False, default=0)
    steps_total = db.Column(db.Integer, nullable=False, default=100)
    summary = db.Column(db.Text)
    error = db.Column(db.Text)
    state = db.Column(db.Text)                     # JSON — everything needed to resume
    updated_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

    def percent(self) -> int:
        if self.status == "done":
            return 100
        return min(95, round(100 * self.steps_done / max(1, self.steps_total)))  # <100 while running

    def to_dict(self) -> dict:
        return {"id": self.id, "status": self.status, "kind": self.kind,
                "percent": self.percent(), "stepsDone": self.steps_done,
                "stepsTotal": self.steps_total, "summary": self.summary, "error": self.error}
```

## 2. The step — ONE bounded unit of work over serializable state

```python
def do_work_step(state: dict):
    """Run one step. Return (state, finished, summary). Keep it short and bounded.
    `state` must stay JSON-serializable so the job can be saved and resumed.

    `finished` must mean the work ACTUALLY happened (G8) — not merely "this step
    had nothing more to schedule." Returning finished=True early snaps the bar to
    100% over a job that did nothing."""
    cursor = state.get("cursor", 0)
    total = state.get("total")
    # ... do a small chunk of work here (one item, one page, one model call) ...
    # convert any response objects to plain dicts before storing them in state (G6)
    cursor += 1
    state["cursor"] = cursor
    if cursor >= total:
        return state, True, f"Done — processed {cursor} items."
    return state, False, None
```

### The finished-detection trap in an AI/agent step (G8)

A tool-use loop ends when the model stops asking for tools. The trap is treating
*every* non-tool-call stop as "done" — a response truncated at the token cap
(`stop_reason == "max_tokens"`) then ends the run right before the model acts:

```python
def agent_step(messages, actions):
    resp = client.messages.create(model=MODEL, max_tokens=4096,   # room to plan AND act
                                   system=SYSTEM, tools=TOOLS, messages=messages)
    messages = messages + [{"role": "assistant", "content": serialize(resp.content)}]

    if resp.stop_reason == "tool_use":
        # ...dispatch tools, append tool_result, return finished=False...
        return messages, actions, False, None
    if resp.stop_reason == "max_tokens":
        # NOT done — it ran out of room mid-thought. Nudge it to continue, don't finish.
        messages = messages + [{"role": "user", "content": "continue"}]
        return messages, actions, False, None
    # a genuine end_turn → done. Use the model's final text as the summary — but only
    # a real end_turn, never a truncated plan (that becomes a garbage "done" message).
    summary = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
    return messages, actions, True, summary
```

Give the model enough `max_tokens` to reason *and* emit its tool calls in one
step, and keep the system prompt pointed at acting-with-tools over narrating a
long plan first, so a step doesn't burn its whole budget before doing anything.

## 3. jobs.py — start / step / cancel / active (no threads)

```python
import json
from datetime import datetime, timezone
from . import db
from .models import Job

def _now(): return datetime.now(timezone.utc)

def start(kind=None, initial_state=None, steps_total=100) -> Job:
    job = Job(status="running", kind=kind, steps_total=steps_total,
              state=json.dumps(initial_state or {}))
    db.session.add(job); db.session.commit()
    return job

def do_step(job_id: int):
    job = db.session.get(Job, job_id)
    if job is None: return None
    if job.status != "running": return job            # terminal → idempotent no-op
    if not job.state:                                  # old/other-format job → retire (G7)
        job.status, job.error = "failed", "stale job — start again"; db.session.commit(); return job
    try:
        state, finished, summary = do_work_step(json.loads(job.state))
    except Exception as exc:                           # never 500 the loop — mark failed
        db.session.rollback(); job = db.session.get(Job, job_id)
        job.status, job.error, job.updated_at = "failed", str(exc)[:500], _now(); db.session.commit(); return job
    job.steps_done += 1
    job.state = json.dumps(state, default=str)
    job.updated_at = _now()
    if finished: job.status, job.summary = "done", summary
    db.session.commit()
    return job

def cancel(job_id: int):
    job = db.session.get(Job, job_id)
    if job is not None and job.status == "running":
        job.status, job.updated_at = "cancelled", _now(); db.session.commit()
    return job

def active():
    job = Job.query.filter_by(status="running").order_by(Job.id.desc()).first()
    if job is not None and not job.state:              # old-format running job → retire (G7)
        job.status = "failed"; db.session.commit(); return None
    return job
```

## 4. Endpoints (Flask)

```python
@api.post("/job")
def job_start():
    # ...auth / validation...
    job = jobs.start(kind=request.json.get("kind"), initial_state={"cursor": 0, "total": 42}, steps_total=42)
    return jsonify(job.to_dict()), 202

@api.post("/job/<int:job_id>/step")
def job_step(job_id):
    job = jobs.do_step(job_id)
    return (jsonify(job.to_dict()) if job else (jsonify({"error": "not found"}), 404))

@api.post("/job/<int:job_id>/cancel")
def job_cancel(job_id):
    job = jobs.cancel(job_id)
    return (jsonify(job.to_dict()) if job else (jsonify({"error": "not found"}), 404))

@api.get("/job/active")
def job_active():
    job = jobs.active()
    return jsonify({"active": job.to_dict() if job else None})
```

## 5. Self-healing migration for the job table's columns (G3)

`create_all()` / `migrate` tools don't add a column to an existing table, so a new
field 500s against an older schema. Add this after `create_all()` on boot:

```python
def ensure_columns(db, schema=None):
    """Idempotent additive migrations create_all() can't do. SQLite + Postgres."""
    from sqlalchemy import inspect as sa_inspect, text
    wanted = [("jobs", "state", "TEXT")]   # (table, column, type)
    insp = sa_inspect(db.engine)
    for table, column, coltype in wanted:
        try:
            if not insp.has_table(table, schema=schema): continue
            cols = [c["name"] for c in insp.get_columns(table, schema=schema)]
        except Exception:
            continue
        if column not in cols:
            qualified = (f'"{schema}".' if schema else "") + table
            db.session.execute(text(f"ALTER TABLE {qualified} ADD COLUMN {column} {coltype}"))
            db.session.commit()
```

(Alternative: keep resumable `state` in a *separate* table from the start — a new
table create_all WILL create, so there's no column migration at all.)

## 6. Frontend — API wrappers (TS)

```ts
export interface Job { id: number; status: 'running'|'done'|'failed'|'cancelled';
  kind: string|null; percent: number; stepsDone: number; stepsTotal: number;
  summary: string|null; error: string|null; }
const BASE = '/api';

export async function startJob(kind: string): Promise<{ok:boolean; status:number; job?:Job}> {
  const res = await fetch(`${BASE}/job`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({kind}) });
  return res.ok ? { ok:true, status:res.status, job: await res.json() } : { ok:false, status:res.status };
}
export function stepJob(id: number, timeoutMs = 90000): Promise<Job> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);     // G5/G2: a stuck step can't wedge the loop
  return fetch(`${BASE}/job/${id}/step`, { method:'POST', signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error('step '+r.status); return r.json() as Promise<Job>; })
    .finally(() => window.clearTimeout(t));
}
export function cancelJob(id: number): Promise<Job> {
  return fetch(`${BASE}/job/${id}/cancel`, { method:'POST' }).then(r => r.json());
}
export function activeJob(): Promise<Job|null> {
  return fetch(`${BASE}/job/active`).then(r => r.json()).then((d:{active:Job|null}) => d.active);
}
```

## 7. Frontend — the controller (step loop + bulletproof cancel + resume)

```ts
import { startJob, stepJob, cancelJob, activeJob, type Job } from './api';

const bar = document.getElementById('job-bar')!;
const fill = document.getElementById('job-bar-fill')!;
const label = document.getElementById('job-bar-label')!;
const cancelBtn = document.getElementById('job-bar-cancel') as HTMLButtonElement;
let activeId: number | null = null;
let last: Job | null = null;
let stepping = false;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function paint(job: Job) {
  last = job; bar.hidden = false;
  (fill as HTMLElement).style.width = job.percent + '%';
  fill.className = 'job-bar-fill' + (job.status === 'failed' ? ' failed' : '');
  label.textContent = job.status === 'running' ? `${job.kind ?? 'working'} · ${job.percent}%`
    : job.status === 'done' ? 'done' : job.status === 'cancelled' ? 'cancelled' : 'failed';
  cancelBtn.hidden = job.status !== 'running';
}
function finish(job: Job) {
  activeId = null;
  // notify the rest of the app that data changed, if relevant:
  window.dispatchEvent(new Event('job:done'));
  paint(job);
  setTimeout(() => { bar.hidden = true; (fill as HTMLElement).style.width = '0%'; }, 2500);
}
async function loop(id: number) {
  if (stepping) return; stepping = true; let errors = 0;
  try {
    while (activeId === id) {
      let job: Job;
      try { job = await stepJob(id); errors = 0; }
      catch { if (++errors >= 3) { if (last) finish({ ...last, status:'failed' }); break; } await sleep(2000); continue; }
      if (activeId !== id) break;                 // G5: cancelled while the step was in flight
      paint(job);
      if (job.status !== 'running') { finish(job); break; }
      await sleep(150);
    }
  } finally { stepping = false; }
}
function attach(job: Job) { activeId = job.id; cancelBtn.disabled = false; paint(job); job.status === 'running' ? loop(job.id) : finish(job); }

cancelBtn.addEventListener('click', () => {            // bulletproof: clear locally first (G5)
  if (activeId === null) return;
  const id = activeId; activeId = null; cancelBtn.disabled = true; label.textContent = 'cancelling…';
  cancelJob(id).catch(() => {});
  finish({ ...(last as Job), id, status: 'cancelled' });
});

export async function start(kind: string) {
  if (activeId !== null) return;                       // one at a time
  const r = await startJob(kind);
  if (r.ok && r.job) attach(r.job);
}

// resume after a refresh (state is server-side)
activeJob().then(j => { if (j && j.status === 'running') attach(j); }).catch(() => {});
```

## 8. HTML + CSS (fixed, full-width, phone-friendly)

```html
<div class="job-bar" id="job-bar" hidden>
  <div class="job-bar-track"><div class="job-bar-fill" id="job-bar-fill"></div></div>
  <div class="job-bar-row">
    <span class="job-bar-label" id="job-bar-label">working…</span>
    <button class="job-bar-cancel" id="job-bar-cancel" type="button">cancel</button>
  </div>
</div>
```

```css
.job-bar{ position:fixed; top:0; left:0; right:0; z-index:70; background:#fff;
  box-shadow:0 2px 14px rgba(0,0,0,0.12); padding-top:env(safe-area-inset-top); }
.job-bar[hidden]{ display:none }
.job-bar-track{ height:4px; background:#eee; overflow:hidden }
.job-bar-fill{ height:100%; width:0; background:#3b82f6; transition:width .5s ease }
.job-bar-fill.failed{ background:#ef4444 }
.job-bar-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 16px }
.job-bar-label{ font:600 13px system-ui,sans-serif }
.job-bar-cancel{ border:none; background:#f1f1f1; cursor:pointer; font:700 12px system-ui,sans-serif;
  padding:6px 14px; border-radius:999px; flex-shrink:0 }
.job-bar-cancel[hidden]{ display:none }
@media (pointer: coarse){ .job-bar-cancel{ min-height:40px } }
```

## Verify (headless, before handoff)

- POST `/job/<id>/step` with a forced error → returns `failed` **fast** (not a hang).
- Start → bar appears, `%` advances to `done`.
- A `done` job actually did the work (G8); an AI step truncated at `max_tokens`
  **continues** the loop instead of finishing at 100% over nothing.
- Reload mid-run → `/job/active` returns it, bar resumes at the right `%`.
- Cancel → bar clears instantly, job is `cancelled` server-side.
