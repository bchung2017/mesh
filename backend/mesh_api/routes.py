"""HTTP routes for the mesh API, all under /api."""
import re
from datetime import date, timedelta

from flask import Blueprint, current_app, jsonify, request

from . import db, llm
from .ical import get_feed_events
from .models import Community, Contribution, Event
from .presence import MODES, compute_presence

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


def _contribution_error(data: dict, partial: bool = False) -> str | None:
    """Validate a contribution payload. partial=True skips required-field checks."""
    if not partial or "date" in data:
        if not DATE_RE.match((data.get("date") or "").strip()):
            return "date must be YYYY-MM-DD"
    if not partial or "text" in data:
        if not (data.get("text") or "").strip():
            return "text is required"
    if "mode" in data and data["mode"] not in MODES:
        return f"mode must be one of {MODES}"
    if "weight" in data:
        w = data["weight"]
        if not (isinstance(w, int) and not isinstance(w, bool) and 1 <= w <= 10):
            return "weight must be an integer 1–10"
    return None


@api.get("/communities/<cid>/contributions")
def list_contributions(cid: str):
    community = db.session.get(Community, cid)
    if community is None:
        return jsonify({"error": "not found"}), 404
    rows = sorted(community.contributions, key=lambda c: (c.date, c.id), reverse=True)
    return jsonify([c.to_dict() for c in rows])


@api.post("/communities/<cid>/contributions")
def create_contribution(cid: str):
    community = db.session.get(Community, cid)
    if community is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(silent=True) or {}
    err = _contribution_error(data)
    if err:
        return jsonify({"error": err}), 400

    # optional link to the event that produced this contribution
    event_id = data.get("eventId")
    label = (data.get("sourceEventLabel") or "").strip() or None
    if event_id is not None:
        ev = db.session.get(Event, event_id)
        if ev is None:
            return jsonify({"error": "event not found"}), 400
        if label is None:
            label = f"{ev.date} · {ev.name}"[:200]   # snapshot a tombstone-able label
        # one contribution per (event, community) — re-logging upserts
        existing = Contribution.query.filter_by(community_id=cid, event_id=event_id).first()
        if existing is not None:
            existing.date = data["date"].strip()
            existing.text = data["text"].strip()[:280]
            existing.mode = data.get("mode", existing.mode)
            existing.weight = data.get("weight", existing.weight)
            existing.source_event_label = label
            db.session.commit()
            return jsonify(existing.to_dict())

    c = Contribution(
        community_id=cid,
        date=data["date"].strip(),
        text=data["text"].strip()[:280],
        mode=data.get("mode", "built"),
        weight=data.get("weight", 5),
        event_id=event_id,
        source_event_label=label,
    )
    db.session.add(c)
    db.session.commit()
    return jsonify(c.to_dict()), 201


@api.put("/contributions/<int:contribution_id>")
def update_contribution(contribution_id: int):
    c = db.session.get(Contribution, contribution_id)
    if c is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(silent=True) or {}
    err = _contribution_error(data, partial=True)
    if err:
        return jsonify({"error": err}), 400
    if "date" in data:
        c.date = data["date"].strip()
    if "text" in data:
        c.text = data["text"].strip()[:280]
    if "mode" in data:
        c.mode = data["mode"]
    if "weight" in data:
        c.weight = data["weight"]
    db.session.commit()
    return jsonify(c.to_dict())


@api.delete("/contributions/<int:contribution_id>")
def delete_contribution(contribution_id: int):
    c = db.session.get(Contribution, contribution_id)
    if c is None:
        return jsonify({"error": "not found"}), 404
    db.session.delete(c)
    db.session.commit()
    return "", 204


@api.get("/communities/<cid>/presence")
def community_presence(cid: str):
    """Presence derived from the contribution log (see presence.py)."""
    community = db.session.get(Community, cid)
    if community is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(compute_presence(community.contributions))


@api.post("/contributions/classify")
def classify_contribution():
    """Optional LLM autofill: suggest {mode, weight, rationale} from free text.

    503 when no key is configured, 502 on any model/network failure — either way
    the frontend keeps the manual chips, so this is never load-bearing. When the
    contribution is being logged from an event, pass `eventContext` so the model
    sees the who/what/where/when."""
    if not llm.configured():
        return jsonify({"error": "llm not configured"}), 503
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    try:
        return jsonify(llm.classify(text, (data.get("eventContext") or "").strip() or None))
    except Exception:
        current_app.logger.warning("mesh: contribution classify failed", exc_info=True)
        return jsonify({"error": "could not classify"}), 502


@api.get("/events")
def list_events():
    # only mesh-native events; materialized iCal rows reach the calendar through
    # the feed (GET /ical/events enriches each occurrence), so returning them
    # here too would double-render them
    rows = Event.query.filter_by(source="mesh").order_by(Event.date, Event.time).all()
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

    event = Event(source="mesh", date=date, name=name[:200], time=time, tone=tone)
    if "note" in data:
        event.note = (data.get("note") or "").strip() or None
    if "communities" in data:
        event.communities = _resolve_communities(data.get("communities"))
    db.session.add(event)
    db.session.commit()
    return jsonify(event.to_dict()), 201


@api.post("/events/materialize")
def materialize_event():
    """Persist a feed occurrence so its mesh layer (note/tags) has a home.

    Idempotent on (source='ical', uid): first call creates the row from the
    occurrence's source fields; later calls just return the existing row (its
    mesh layer already lives on it). This is what the frontend hits the moment
    you first annotate or log from a read-only calendar event.
    """
    data = request.get_json(silent=True) or {}
    uid = (data.get("uid") or "").strip()
    date = (data.get("date") or "").strip()
    name = (data.get("name") or "").strip()
    if not uid:
        return jsonify({"error": "uid is required"}), 400
    if not DATE_RE.match(date):
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    if not name:
        return jsonify({"error": "name is required"}), 400

    existing = Event.query.filter_by(source="ical", uid=uid).first()
    if existing is not None:
        return jsonify(existing.to_dict())

    time = (data.get("time") or "").strip()
    if time and not TIME_RE.match(time):
        return jsonify({"error": "time must be HH:MM"}), 400
    event = Event(
        source="ical", uid=uid,
        series_uid=(data.get("seriesUid") or "").strip() or None,
        date=date, time=time,
    )
    event.refresh_source(name, data.get("location"), data.get("description"))
    db.session.add(event)
    db.session.commit()
    return jsonify(event.to_dict()), 201


@api.put("/events/<int:event_id>")
def update_event(event_id: int):
    event = db.session.get(Event, event_id)
    if event is None:
        return jsonify({"error": "not found"}), 404

    data = request.get_json(silent=True) or {}
    # source-layer fields (name/time/date) are only hand-editable on mesh-native
    # events; on a materialized iCal row they're owned by the feed and would be
    # clobbered on the next refresh, so we ignore them there
    if "name" in data and event.source == "mesh":
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name is required"}), 400
        event.name = name[:200]
    if "date" in data and event.source == "mesh":
        d = (data.get("date") or "").strip()
        if not DATE_RE.match(d):
            return jsonify({"error": "date must be YYYY-MM-DD"}), 400
        event.date = d
    if "time" in data and event.source == "mesh":
        time = (data.get("time") or "").strip()
        if time and not TIME_RE.match(time):
            return jsonify({"error": "time must be HH:MM"}), 400
        event.time = time
    if "tone" in data:
        if data["tone"] not in TONES:
            return jsonify({"error": f"tone must be one of {sorted(TONES)}"}), 400
        event.tone = data["tone"]
    # mesh-layer fields are editable on any event, feed or native
    if "note" in data:
        event.note = (data.get("note") or "").strip() or None
    if "communities" in data:
        event.communities = _resolve_communities(data.get("communities"))

    db.session.commit()
    return jsonify(event.to_dict())


@api.delete("/events/<int:event_id>")
def delete_event(event_id: int):
    event = db.session.get(Event, event_id)
    if event is None:
        return jsonify({"error": "not found"}), 404
    # orphan any contributions this event produced — keep them + their label
    # tombstone (explicit so it holds regardless of DB-level FK enforcement)
    for c in Contribution.query.filter_by(event_id=event_id).all():
        c.event_id = None
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

    # fold the mesh layer onto any occurrence we've materialized: the feed owns
    # the source fields (refresh them by uid), mesh owns note + tags (carry them
    # out so the calendar can show annotations on feed events and route further
    # edits to the existing row instead of making a second one)
    if events:
        by_uid = {
            e.uid: e for e in Event.query.filter_by(source="ical").all() if e.uid
        }
        dirty = False
        for occ in events:
            row = by_uid.get(occ.get("uid"))
            if row is None:
                continue
            row.refresh_source(occ["name"], occ.get("location"), occ.get("description"))
            dirty = True
            occ["meshId"] = row.id
            occ["note"] = row.note
            occ["communities"] = [c.id for c in row.communities]
        if dirty:
            db.session.commit()
    return jsonify({"configured": configured, "events": events})
