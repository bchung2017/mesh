"""The mesh domain operations, decoupled from HTTP.

Every create/read/update/delete lives here as a plain function that works on the
database (within an app context) and raises ServiceError on bad input or a
missing row. Both the HTTP layer (routes.py, which just translates to JSON +
status codes) and the autonomous agent (agent.py, which exposes these as tools)
call the SAME functions — so there is exactly one implementation of the rules,
and the agent can never drift from the API.
"""
import re
from datetime import date, timedelta

from . import db
from .ical import get_feed_events
from .models import Community, Contribution, Event
from .presence import MODES, compute_presence

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
EVENT_TONES = {"warm", "cool"}
COMMUNITY_TONES = {"coral", "salmon", "sky", "navy"}
PARSE_STATES = {"ok", "stale"}

# Mutable community fields: incoming camelCase key -> model attribute. involvement
# /delta/energy are absent on purpose — they're derived from the contribution log.
COMMUNITY_FIELDS = {
    "name": "name", "tone": "tone", "parse": "parse", "parseState": "parse_state",
    "tenure": "tenure", "lastArtifact": "last_artifact",
    "nextGathering": "next_gathering", "note": "note",
}
COMMUNITY_DEFAULTS = {
    "tone": "sky", "parse": "new face", "parseState": "ok", "tenure": "new",
    "lastArtifact": "none yet", "nextGathering": "nothing on the calendar", "note": "",
}


class ServiceError(Exception):
    """A domain error carrying an HTTP-ish status (400 bad input, 404 missing)."""
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------- validation helpers ----------------

def _field_error(key: str, value) -> str | None:
    if key == "tone" and value not in COMMUNITY_TONES:
        return f"tone must be one of {sorted(COMMUNITY_TONES)}"
    if key == "parseState" and value not in PARSE_STATES:
        return f"parseState must be one of {sorted(PARSE_STATES)}"
    return None


def _generate_id(name: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", name)
    base = ("".join(w[0] for w in words)[:8] or "C").upper()
    cand, n = base, 2
    while db.session.get(Community, cand) is not None:
        suffix = str(n)
        cand = base[: 8 - len(suffix)] + suffix
        n += 1
    return cand


def _resolve_communities(ids) -> list:
    if not isinstance(ids, list) or not ids:
        return []
    return Community.query.filter(Community.id.in_([str(i) for i in ids])).all()


def _require_community(cid: str) -> Community:
    c = db.session.get(Community, cid)
    if c is None:
        raise ServiceError(404, f"no community '{cid}'")
    return c


def _contribution_error(data: dict, partial: bool = False) -> str | None:
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


# ---------------- communities ----------------

def list_communities() -> list[dict]:
    rows = Community.query.order_by(Community.position, Community.id).all()
    return [c.to_dict() for c in rows]


def get_community(cid: str) -> dict:
    return _require_community(cid).to_dict()


def create_community(data: dict) -> dict:
    name = (data.get("name") or "").strip()
    if not name:
        raise ServiceError(400, "name is required")
    values = dict(COMMUNITY_DEFAULTS)
    for key in COMMUNITY_FIELDS:
        if key == "name" or key not in data:
            continue
        err = _field_error(key, data[key])
        if err:
            raise ServiceError(400, err)
        values[key] = data[key]
    max_pos = db.session.query(db.func.max(Community.position)).scalar()
    community = Community(
        id=_generate_id(name), name=name[:120],
        tone=values["tone"], parse=values["parse"], parse_state=values["parseState"],
        tenure=values["tenure"], last_artifact=values["lastArtifact"],
        next_gathering=values["nextGathering"], note=values["note"],
        position=(max_pos or 0) + 1,
    )
    db.session.add(community)
    db.session.commit()
    return community.to_dict()


def update_community(cid: str, data: dict) -> dict:
    community = _require_community(cid)
    for key, value in data.items():
        attr = COMMUNITY_FIELDS.get(key)
        if attr is None:
            continue  # ignore unknown keys (blob, derived fields, …)
        err = _field_error(key, value)
        if err:
            raise ServiceError(400, err)
        setattr(community, attr, value)
    db.session.commit()
    return community.to_dict()


def delete_community(cid: str) -> None:
    db.session.delete(_require_community(cid))
    db.session.commit()


def community_events(cid: str) -> list[dict]:
    community = _require_community(cid)
    return [e.to_dict() for e in sorted(community.events, key=lambda e: (e.date, e.time))]


def community_presence(cid: str) -> dict:
    return compute_presence(_require_community(cid).contributions)


# ---------------- contributions ----------------

def list_contributions(cid: str) -> list[dict]:
    community = _require_community(cid)
    rows = sorted(community.contributions, key=lambda c: (c.date, c.id), reverse=True)
    return [c.to_dict() for c in rows]


def create_contribution(cid: str, data: dict) -> tuple[dict, bool]:
    """Returns (contribution, created) — created is False when an event-linked
    contribution upserted an existing row rather than making a new one."""
    _require_community(cid)
    err = _contribution_error(data)
    if err:
        raise ServiceError(400, err)

    event_id = data.get("eventId")
    label = (data.get("sourceEventLabel") or "").strip() or None
    if event_id is not None:
        ev = db.session.get(Event, event_id)
        if ev is None:
            raise ServiceError(400, "event not found")
        if label is None:
            label = f"{ev.date} · {ev.name}"[:200]
        existing = Contribution.query.filter_by(community_id=cid, event_id=event_id).first()
        if existing is not None:
            existing.date = data["date"].strip()
            existing.text = data["text"].strip()[:280]
            existing.mode = data.get("mode", existing.mode)
            existing.weight = data.get("weight", existing.weight)
            existing.source_event_label = label
            db.session.commit()
            return existing.to_dict(), False

    c = Contribution(
        community_id=cid, date=data["date"].strip(), text=data["text"].strip()[:280],
        mode=data.get("mode", "built"), weight=data.get("weight", 5),
        event_id=event_id, source_event_label=label,
    )
    db.session.add(c)
    db.session.commit()
    return c.to_dict(), True


def update_contribution(contribution_id: int, data: dict) -> dict:
    c = db.session.get(Contribution, contribution_id)
    if c is None:
        raise ServiceError(404, f"no contribution {contribution_id}")
    err = _contribution_error(data, partial=True)
    if err:
        raise ServiceError(400, err)
    if "date" in data:
        c.date = data["date"].strip()
    if "text" in data:
        c.text = data["text"].strip()[:280]
    if "mode" in data:
        c.mode = data["mode"]
    if "weight" in data:
        c.weight = data["weight"]
    db.session.commit()
    return c.to_dict()


def delete_contribution(contribution_id: int) -> None:
    c = db.session.get(Contribution, contribution_id)
    if c is None:
        raise ServiceError(404, f"no contribution {contribution_id}")
    db.session.delete(c)
    db.session.commit()


# ---------------- events (mesh records; the Google feed is read-only) ----------------

def list_events() -> list[dict]:
    rows = Event.query.filter_by(source="mesh").order_by(Event.date, Event.time).all()
    return [e.to_dict() for e in rows]


def create_event(data: dict) -> dict:
    d = (data.get("date") or "").strip()
    name = (data.get("name") or "").strip()
    time = (data.get("time") or "18:00").strip()
    tone = (data.get("tone") or "warm").strip()
    if not DATE_RE.match(d):
        raise ServiceError(400, "date must be YYYY-MM-DD")
    if not name:
        raise ServiceError(400, "name is required")
    if not TIME_RE.match(time):
        raise ServiceError(400, "time must be HH:MM")
    if tone not in EVENT_TONES:
        raise ServiceError(400, f"tone must be one of {sorted(EVENT_TONES)}")
    event = Event(source="mesh", date=d, name=name[:200], time=time, tone=tone)
    if "note" in data:
        event.note = (data.get("note") or "").strip() or None
    if "communities" in data:
        event.communities = _resolve_communities(data.get("communities"))
    db.session.add(event)
    db.session.commit()
    return event.to_dict()


def materialize_event(data: dict) -> tuple[dict, bool]:
    uid = (data.get("uid") or "").strip()
    d = (data.get("date") or "").strip()
    name = (data.get("name") or "").strip()
    if not uid:
        raise ServiceError(400, "uid is required")
    if not DATE_RE.match(d):
        raise ServiceError(400, "date must be YYYY-MM-DD")
    if not name:
        raise ServiceError(400, "name is required")
    existing = Event.query.filter_by(source="ical", uid=uid).first()
    if existing is not None:
        return existing.to_dict(), False
    time = (data.get("time") or "").strip()
    if time and not TIME_RE.match(time):
        raise ServiceError(400, "time must be HH:MM")
    event = Event(
        source="ical", uid=uid,
        series_uid=(data.get("seriesUid") or "").strip() or None, date=d, time=time,
    )
    event.refresh_source(name, data.get("location"), data.get("description"))
    db.session.add(event)
    db.session.commit()
    return event.to_dict(), True


def update_event(event_id: int, data: dict) -> dict:
    event = db.session.get(Event, event_id)
    if event is None:
        raise ServiceError(404, f"no event {event_id}")
    # source-layer fields only hand-editable on mesh-native events
    if "name" in data and event.source == "mesh":
        name = (data.get("name") or "").strip()
        if not name:
            raise ServiceError(400, "name is required")
        event.name = name[:200]
    if "date" in data and event.source == "mesh":
        d = (data.get("date") or "").strip()
        if not DATE_RE.match(d):
            raise ServiceError(400, "date must be YYYY-MM-DD")
        event.date = d
    if "time" in data and event.source == "mesh":
        time = (data.get("time") or "").strip()
        if time and not TIME_RE.match(time):
            raise ServiceError(400, "time must be HH:MM")
        event.time = time
    if "tone" in data:
        if data["tone"] not in EVENT_TONES:
            raise ServiceError(400, f"tone must be one of {sorted(EVENT_TONES)}")
        event.tone = data["tone"]
    if "note" in data:
        event.note = (data.get("note") or "").strip() or None
    if "communities" in data:
        event.communities = _resolve_communities(data.get("communities"))
    db.session.commit()
    return event.to_dict()


def delete_event(event_id: int) -> None:
    event = db.session.get(Event, event_id)
    if event is None:
        raise ServiceError(404, f"no event {event_id}")
    for c in Contribution.query.filter_by(event_id=event_id).all():
        c.event_id = None  # orphan, keep the label tombstone
    db.session.delete(event)
    db.session.commit()


# ---------------- external calendar feed (read-only Google mirror) ----------------

def read_feed(time_min: str = "", time_max: str = "", fresh: bool = False) -> dict:
    """The subscribed calendar's occurrences in [timeMin, timeMax), with the mesh
    layer (note/tags/meshId) folded onto any we've materialized. Read-only."""
    def parse_day(value: str, fallback: date) -> date:
        try:
            return date.fromisoformat(value)
        except (TypeError, ValueError):
            return fallback

    today = date.today()
    start = parse_day(time_min, date(today.year, today.month, 1))
    end = parse_day(time_max, start + timedelta(days=31))
    try:
        configured, events = get_feed_events(start, end, force=fresh)
    except Exception as exc:
        raise ServiceError(502, "could not fetch calendar feed") from exc

    if events:
        by_uid = {e.uid: e for e in Event.query.filter_by(source="ical").all() if e.uid}
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
    return {"configured": configured, "events": events}
