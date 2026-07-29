"""HTTP routes for the mesh API, all under /api."""
import re

from flask import Blueprint, jsonify, request

from . import db
from .models import Community, Event

api = Blueprint("api", __name__, url_prefix="/api")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
TONES = {"warm", "cool"}


@api.get("/health")
def health():
    return {"status": "ok"}


@api.get("/communities")
def list_communities():
    rows = Community.query.order_by(Community.position, Community.id).all()
    return jsonify([c.to_dict() for c in rows])


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
    db.session.add(event)
    db.session.commit()
    return jsonify(event.to_dict()), 201


@api.delete("/events/<int:event_id>")
def delete_event(event_id: int):
    event = db.session.get(Event, event_id)
    if event is None:
        return jsonify({"error": "not found"}), 404
    db.session.delete(event)
    db.session.commit()
    return "", 204
