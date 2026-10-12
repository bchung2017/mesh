"""Agent syncs as resumable, frontend-driven jobs — no background threads.

A job holds the full conversation state in the DB. The frontend starts a job,
then calls /step repeatedly; each call runs ONE agent step (one model call + any
tool calls) inside that normal request — the exact path that works — and saves
progress. So progress is real, cancel is immediate, and a refresh resumes from
the saved state. Nothing runs in a thread, so nothing can hang a worker.
"""
import json
from datetime import datetime, timezone

from . import agent, db
from .models import SyncJob


def _now() -> datetime:
    return datetime.now(timezone.utc)


def start(instruction: str | None, kind: str | None = None) -> SyncJob:
    job = SyncJob(
        status="running", kind=kind, instruction=instruction, steps_total=agent.MAX_STEPS,
        state=json.dumps({"messages": agent.init_messages(instruction), "actions": []}),
    )
    db.session.add(job)
    db.session.commit()
    return job


def do_step(job_id: int) -> SyncJob | None:
    """Advance a job by one step. All work happens in this request context."""
    job = db.session.get(SyncJob, job_id)
    if job is None:
        return None
    if job.status != "running":
        return job
    if not job.state:   # a pre-stepping (threaded) job with no resumable state
        job.status, job.error, job.updated_at = "failed", "stale job — run sync again", _now()
        db.session.commit()
        return job
    if job.steps_done >= job.steps_total:
        job.status = "done"
        if not job.summary:
            job.summary = f"Reached the step limit after {job.changes} change(s) — run sync again to continue."
        job.updated_at = _now()
        db.session.commit()
        return job

    try:
        state = json.loads(job.state)
        messages, actions, finished, summary = agent.step(state.get("messages", []), state.get("actions", []))
    except agent.AgentError as exc:
        job.status, job.error, job.updated_at = "failed", str(exc)[:500], _now()
        db.session.commit()
        return job
    except Exception as exc:
        db.session.rollback()
        job = db.session.get(SyncJob, job_id)
        if job is not None:
            job.status, job.error, job.updated_at = "failed", str(exc)[:500], _now()
            db.session.commit()
        return job

    job.steps_done += 1
    job.changes = agent.changes_count(actions)
    job.state = json.dumps({"messages": messages, "actions": actions}, default=str)
    job.updated_at = _now()
    if finished:
        job.status, job.summary = "done", summary
    db.session.commit()
    return job


def cancel(job_id: int) -> SyncJob | None:
    job = db.session.get(SyncJob, job_id)
    if job is not None and job.status == "running":
        job.status = "cancelled"
        job.summary = f"Cancelled after {job.changes} change(s)."
        job.updated_at = _now()
        db.session.commit()
    return job


def get(job_id: int) -> SyncJob | None:
    return db.session.get(SyncJob, job_id)


def active() -> SyncJob | None:
    """The current running job (for resuming the progress bar on reload)."""
    job = SyncJob.query.filter_by(status="running").order_by(SyncJob.id.desc()).first()
    if job is not None and not job.state:   # old threaded job — retire it, don't resume
        job.status, job.error = "failed", "interrupted — run sync again"
        db.session.commit()
        return None
    return job
