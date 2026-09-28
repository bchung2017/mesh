"""HTTP routes for the mesh API, all under /api."""
import re
from datetime import date, timedelta

from flask import Blueprint, current_app, jsonify, request

from . import db
from .ical import get_feed_events
from .models import Community, Event

api = Blueprint("api", __name__, url_prefix="/api")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
TONES = {"warm", "cool"}

# Community tones (the field's four) and parse states.
COMMUNITY_TONES = {"coral", "salmon", "sky", "navy"}
PARSE_STATES = {"ok", "stale"}

# Mutable community fields: incoming camelCase JSON key -> model attribute.
COMMUNITY_FIELDS = {
    "name": "name", "tone": "tone", "parse": "parse", "parseState": "parse_state",
    "involvement": "involvement", "delta": "delta", "tenure": "tenure",
    "energy": "energy", "lastArtifact": "last_artifact",
    "nextGathering": "next_gathering", "note": "note",
}

# Defaults for fields omitted on create.
COMMUNITY_DEFAULTS = {
    "tone": "sky", "parse": "new face", "parseState": "ok",
    "involvement": 0, "delta": 0, "tenure": "new", "energy": "settling",
    "lastArtifact": "none yet", "nextGathering": "nothing on the calendar", "note": "",
}


def _field_error(key: str, value) -> str | None:
    """Validate a single community field value; return an error message or None."""
    if key == "tone" and value not in COMMUNITY_TONES:
        return f"tone must be one of {sorted(COMMUNITY_TONES)}"
    if key == "parseState" and value not in PARSE_STATES:
        return f"parseState must be one of {sorted(PARSE_STATES)}"
    if key == "involvement" and not (isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 100):
        return "involvement must be an integer 0–100"
    if key == "delta" and not (isinstance(value, int) and not isinstance(value, bool)):
        return "delta must be an integer"
    return None


def _generate_id(name: str) -> str:
    """A short, unique, human-ish id from a name's initials (fits the id column)."""
    words = re.findall(r"[A-Za-z0-9]+", name)
    base = ("".join(w[0] for w in words)[:8] or "C").upper()
    cand, n = base, 2
    while db.session.get(Community, cand) is not None:
        suffix = str(n)
        cand = base[: 8 - len(suffix)] + suffix
        n += 1
    return cand


def _resolve_communities(ids) -> list:
    """Community rows for the given ids; unknown ids are silently dropped."""
    if not isinstance(ids, list) or not ids:
        return []
    wanted = [str(i) for i in ids]
    return Community.query.filter(Community.id.in_(wanted)).all()


@api.get("/health")
def health():
    return {
        "status": "ok",
        "backend": current_app.config.get("MESH_BACKEND"),
        "schema": current_app.config.get("MESH_DB_SCHEMA"),
    }


@api.get("/communities")
def list_communities():
    rows = Community.query.order_by(Community.position, Community.id).all()
    return jsonify([c.to_dict() for c in rows])


@api.get("/communities/<cid>")
def get_community(cid: str):
    community = db.session.get(Community, cid)
    if community is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(community.to_dict())


@api.post("/communities")
def create_community():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    # merge provided fields over defaults, validating each
    values = dict(COMMUNITY_DEFAULTS)
    for key in COMMUNITY_FIELDS:
        if key == "name" or key not in data:
            continue
        err = _field_error(key, data[key])
        if err:
            return jsonify({"error": err}), 400
        values[key] = data[key]

    max_pos = db.session.query(db.func.max(Community.position)).scalar()
    community = Community(
        id=_generate_id(name),
        name=name[:120],
        tone=values["tone"], parse=values["parse"], parse_state=values["parseState"],
        involvement=values["involvement"], delta=values["delta"], tenure=values["tenure"],
        energy=values["energy"], last_artifact=values["lastArtifact"],
        next_gathering=values["nextGathering"], note=values["note"],
        position=(max_pos or 0) + 1,
    )
    db.session.add(community)
    db.session.commit()
    return jsonify(community.to_dict()), 201


@api.put("/communities/<cid>")
def update_community(cid: str):
    community = db.session.get(Community, cid)
    if community is None:
        return jsonify({"error": "not found"}), 404

    data = request.get_json(silent=True) or {}
    for key, value in data.items():
        attr = COMMUNITY_FIELDS.get(key)
        if attr is None:
            continue  # ignore unknown keys (including any client-side `blob`)
        err = _field_error(key, value)
        if err:
            return jsonify({"error": err}), 400
        setattr(community, attr, value)

    db.session.commit()
    return jsonify(community.to_dict())


@api.delete("/communities/<cid>")
def delete_community(cid: str):
    community = db.session.get(Community, cid)
    if community is None:
        return jsonify({"error": "not found"}), 404
    db.session.delete(community)
    db.session.commit()
    return "", 204


@api.get("/communities/<cid>/events")
def community_events(cid: str):
    """The (own) calendar events tagged with this community, date/time sorted."""
    community = db.session.get(Community, cid)
    if community is None:
        return jsonify({"error": "not found"}), 404
    rows = sorted(community.events, key=lambda e: (e.date, e.time))
    return jsonify([e.to_dict() for e in rows])


@api.get("/events")
def list_events():
    rows = Event.query.order_by(Event.date, Event.time).all()
    return jsonify([e.to_dict() for e in rows])


@api.post("/events")
def create_event():
    data = request.get_json(silent=True) or {}

    date = (data.get("date") or "").strip()
    name = (data.get("name") or "").strip()
    time = (data.get("time") or "18:00").strip()
    tone = (data.get("tone") or "warm").strip()

    if not DATE_RE.match(date):
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    if not name:
        return jsonify({"error": "name is required"}), 400
    if not TIME_RE.match(time):
        return jsonify({"error": "time must be HH:MM"}), 400
    if tone not in TONES:
        return jsonify({"error": f"tone must be one of {sorted(TONES)}"}), 400

    event = Event(date=date, name=name[:120], time=time, tone=tone)
    if "communities" in data:
        event.communities = _resolve_communities(data.get("communities"))
    db.session.add(event)
    db.session.commit()
    return jsonify(event.to_dict()), 201


@api.put("/events/<int:event_id>")
def update_event(event_id: int):
    event = db.session.get(Event, event_id)
    if event is None:
        return jsonify({"error": "not found"}), 404

    data = request.get_json(silent=True) or {}
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name is required"}), 400
        event.name = name[:120]
    if "time" in data:
        time = (data.get("time") or "").strip()
        if not TIME_RE.match(time):
            return jsonify({"error": "time must be HH:MM"}), 400
        event.time = time
    if "tone" in data:
        if data["tone"] not in TONES:
            return jsonify({"error": f"tone must be one of {sorted(TONES)}"}), 400
        event.tone = data["tone"]
    if "communities" in data:
        event.communities = _resolve_communities(data.get("communities"))

    db.session.commit()
    return jsonify(event.to_dict())


@api.delete("/events/<int:event_id>")
def delete_event(event_id: int):
    event = db.session.get(Event, event_id)
    if event is None:
        return jsonify({"error": "not found"}), 404
    db.session.delete(event)
    db.session.commit()
    return "", 204


@api.get("/ical/events")
def ical_events():
    """Read-only events from the subscribed external calendar (MESH_ICS_URL),
    within [timeMin, timeMax) (YYYY-MM-DD; defaults to ~the current month)."""
    def parse_day(value: str, fallback: date) -> date:
        try:
            return date.fromisoformat(value)
        except (TypeError, ValueError):
            return fallback

    today = date.today()
    start = parse_day(request.args.get("timeMin", ""), date(today.year, today.month, 1))
    end = parse_day(request.args.get("timeMax", ""), start + timedelta(days=31))
    force = request.args.get("fresh") in ("1", "true", "yes")

    try:
        configured, events = get_feed_events(start, end, force=force)
    except Exception:  # feed unreachable / unparseable — don't blank the calendar
        current_app.logger.warning("mesh: iCal feed fetch failed", exc_info=True)
        return jsonify({"error": "could not fetch calendar feed"}), 502
    return jsonify({"configured": configured, "events": events})
