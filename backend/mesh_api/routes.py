"""HTTP routes for the mesh API, all under /api.

Thin controllers: they parse the request, call a function in services.py (the
single source of domain logic), and translate the result — or a ServiceError —
into JSON + a status code. The autonomous agent calls those same services.
"""
import os

from flask import Blueprint, current_app, jsonify, request

from . import llm, services
from .services import ServiceError

api = Blueprint("api", __name__, url_prefix="/api")


@api.errorhandler(ServiceError)
def _handle_service_error(err: ServiceError):
    return jsonify({"error": err.message}), err.status


def _body() -> dict:
    return request.get_json(silent=True) or {}


@api.get("/health")
def health():
    return {
        "status": "ok",
        "backend": current_app.config.get("MESH_BACKEND"),
        "schema": current_app.config.get("MESH_DB_SCHEMA"),
    }


# ---------------- communities ----------------

@api.get("/communities")
def list_communities():
    return jsonify(services.list_communities())


@api.get("/communities/<cid>")
def get_community(cid: str):
    return jsonify(services.get_community(cid))


@api.post("/communities")
def create_community():
    return jsonify(services.create_community(_body())), 201


@api.put("/communities/<cid>")
def update_community(cid: str):
    return jsonify(services.update_community(cid, _body()))


@api.delete("/communities/<cid>")
def delete_community(cid: str):
    services.delete_community(cid)
    return "", 204


@api.get("/communities/<cid>/events")
def community_events(cid: str):
    return jsonify(services.community_events(cid))


@api.get("/communities/<cid>/presence")
def community_presence(cid: str):
    return jsonify(services.community_presence(cid))


# ---------------- contributions ----------------

@api.get("/communities/<cid>/contributions")
def list_contributions(cid: str):
    return jsonify(services.list_contributions(cid))


@api.post("/communities/<cid>/contributions")
def create_contribution(cid: str):
    row, created = services.create_contribution(cid, _body())
    return jsonify(row), (201 if created else 200)


@api.put("/contributions/<int:contribution_id>")
def update_contribution(contribution_id: int):
    return jsonify(services.update_contribution(contribution_id, _body()))


@api.delete("/contributions/<int:contribution_id>")
def delete_contribution(contribution_id: int):
    services.delete_contribution(contribution_id)
    return "", 204


@api.post("/contributions/classify")
def classify_contribution():
    """Optional LLM autofill: suggest {mode, weight, rationale} from free text.
    503 when no key is configured, 502 on any failure — never load-bearing."""
    if not llm.configured():
        return jsonify({"error": "llm not configured"}), 503
    data = _body()
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    try:
        return jsonify(llm.classify(text, (data.get("eventContext") or "").strip() or None))
    except Exception:
        current_app.logger.warning("mesh: contribution classify failed", exc_info=True)
        return jsonify({"error": "could not classify"}), 502


# ---------------- events (mesh records) ----------------

@api.get("/events")
def list_events():
    return jsonify(services.list_events())


@api.post("/events")
def create_event():
    return jsonify(services.create_event(_body())), 201


@api.post("/events/materialize")
def materialize_event():
    row, created = services.materialize_event(_body())
    return jsonify(row), (201 if created else 200)


@api.put("/events/<int:event_id>")
def update_event(event_id: int):
    return jsonify(services.update_event(event_id, _body()))


@api.delete("/events/<int:event_id>")
def delete_event(event_id: int):
    services.delete_event(event_id)
    return "", 204


# ---------------- external calendar feed (read-only) ----------------

@api.get("/ical/events")
def ical_events():
    """Read-only events from the subscribed external calendar (MESH_ICS_URL),
    within [timeMin, timeMax) (YYYY-MM-DD; defaults to ~the current month)."""
    return jsonify(services.read_feed(
        request.args.get("timeMin", ""),
        request.args.get("timeMax", ""),
        request.args.get("fresh") in ("1", "true", "yes"),
    ))


# ---------------- autonomous agent ----------------

def _agent_authorized() -> bool:
    """When MESH_AGENT_TOKEN is set, require it (Bearer header or ?token=) — the
    endpoint mutates data autonomously, so a scheduler needs a shared secret.
    When unset, MESH_AGENT_ENABLED alone gates it."""
    token = os.environ.get("MESH_AGENT_TOKEN")
    if not token:
        return True
    header = request.headers.get("Authorization", "")
    provided = header[7:].strip() if header.startswith("Bearer ") else request.args.get("token", "")
    return provided == token


@api.post("/agent/run")
def agent_run():
    """Run the autonomous agent once. Gated behind MESH_AGENT_ENABLED + a key,
    and a shared secret (MESH_AGENT_TOKEN) when set.
    Body: {instruction?: str}. Returns {summary, actions, steps}."""
    from . import agent  # lazy import avoids a module-load cycle (agent → services)
    if not agent.enabled():
        return jsonify({"error": "agent not enabled"}), 503
    if not _agent_authorized():
        return jsonify({"error": "unauthorized"}), 403
    instruction = (_body().get("instruction") or "").strip() or None
    try:
        return jsonify(agent.run_agent(instruction))
    except agent.AgentError as exc:
        return jsonify({"error": str(exc)}), 502
