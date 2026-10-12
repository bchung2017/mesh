"""Run agent syncs as background jobs so the HTTP request returns instantly and
the work continues server-side — pollable (progress bar), cancellable, and
survives a page refresh because the state lives in the DB (SyncJob).

Single-worker friendly: the request handler spawns a daemon thread that updates
the job row as it goes; poll requests read that row. Cancellation is an in-memory
flag (one process), checked between steps.
"""
import threading
from datetime import datetime, timedelta, timezone

from . import agent, db
from .models import SyncJob

STALE_SECONDS = 150          # no heartbeat this long → the worker died; fail the job
_cancel: set[int] = set()    # in-memory cancel flags (single process)
_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def start(app, instruction: str | None, kind: str | None = None) -> SyncJob:
    """Create a job and run it in a background thread. Returns the job row."""
    job = SyncJob(status="running", kind=kind, instruction=instruction,
                  steps_total=agent.MAX_STEPS)
    db.session.add(job)
    db.session.commit()
    jid = job.id
    threading.Thread(target=run_job, args=(app, jid, instruction), daemon=True).start()
    return job


def request_cancel(job_id: int) -> None:
    with _lock:
        _cancel.add(job_id)


def run_job(app, job_id: int, instruction: str | None) -> None:
    """The synchronous body of a job (also called directly in tests)."""
    with app.app_context():
        try:
            def on_progress(steps_done: int, changes: int) -> None:
                j = db.session.get(SyncJob, job_id)
                if j is None:
                    return
                j.steps_done, j.changes, j.updated_at = steps_done, changes, _now()
                db.session.commit()

            def cancelled() -> bool:
                with _lock:
                    return job_id in _cancel

            result = agent.run_agent(instruction, on_progress=on_progress, cancelled=cancelled)
            j = db.session.get(SyncJob, job_id)
            j.status = "cancelled" if result.get("cancelled") else "done"
            j.summary = result.get("summary")
            j.steps_done = result.get("steps", j.steps_done)
            j.changes = sum(1 for a in result.get("actions", []) if a.get("ok"))
            j.updated_at = _now()
            db.session.commit()
        except Exception as exc:  # AgentError or anything else — record it, don't crash the worker
            db.session.rollback()
            j = db.session.get(SyncJob, job_id)
            if j is not None:
                j.status, j.error, j.updated_at = "failed", str(exc)[:500], _now()
                db.session.commit()
        finally:
            with _lock:
                _cancel.discard(job_id)
            db.session.remove()


def _reap_if_stale(job: SyncJob | None) -> SyncJob | None:
    """A job left 'running' with no recent heartbeat means its worker died
    (deploy/restart). Mark it failed so the UI stops waiting on it."""
    if job is not None and job.status == "running":
        if _now() - _aware(job.updated_at) > timedelta(seconds=STALE_SECONDS):
            job.status = "failed"
            job.error = "interrupted — the server restarted mid-sync; run sync again (it resumes safely)"
            job.updated_at = _now()
            db.session.commit()
    return job


def get(job_id: int) -> SyncJob | None:
    return _reap_if_stale(db.session.get(SyncJob, job_id))


def active() -> SyncJob | None:
    """The current running job, if any (for resuming the progress bar on reload)."""
    job = SyncJob.query.filter_by(status="running").order_by(SyncJob.id.desc()).first()
    return _reap_if_stale(job)
