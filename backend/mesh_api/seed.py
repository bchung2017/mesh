"""Seed the database with the mock community + event data the prototype shipped
with. Runs once, only when the tables are empty."""
from datetime import date, timedelta

from . import db
from .models import Community, Event

COMMUNITIES = [
    dict(id="HW", name="NYC Hardware", tone="coral", parse='"built the thing"', parse_state="ok",
         involvement=82, delta=6, tenure="3 mo", energy="humming",
         last_artifact="charging writeup — 2 weeks ago",
         next_gathering="thursday meetup in 2 days",
         note="your strongest graph — keep bringing artifacts", position=0),
    dict(id="CL", name="Climate Circle", tone="salmon", parse="founder-type", parse_state="ok",
         involvement=55, delta=12, tenure="2 mo", energy="warming",
         last_artifact="none yet — entered via intro",
         next_gathering="monthly circle in 9 days",
         note="fastest-growing blob; parser installed correctly at first contact", position=1),
    dict(id="MG", name="Makers Guild", tone="sky", parse="new face", parse_state="ok",
         involvement=34, delta=0, tenure="3 wk", energy="settling",
         last_artifact="none yet",
         next_gathering="open shop night, saturday",
         note="too new to read — show up twice more before judging", position=2),
    dict(id="MM", name="Micromobility", tone="navy", parse="engineer", parse_state="stale",
         involvement=18, delta=-9, tenure="4 mo", energy="cooling",
         last_artifact="BMS talk — 3 months ago",
         next_gathering="nothing on the calendar",
         note="parser stale — re-enter via artifact or let it fade deliberately", position=3),
]


def _seed_events() -> list[Event]:
    today = date.today()
    plus2 = today + timedelta(days=2)
    plus5 = today + timedelta(days=5)
    the28 = today.replace(day=28)
    return [
        Event(date=plus2.isoformat(), time="19:00", name="hardware meetup", tone="warm"),
        Event(date=plus5.isoformat(), time="12:30", name="book circle", tone="warm"),
        Event(date=plus5.isoformat(), time="09:00", name="dentist", tone="cool"),
        Event(date=the28.isoformat(), time="18:00", name="monthly review", tone="cool"),
    ]


def seed_if_empty() -> None:
    if Community.query.count() == 0:
        db.session.add_all(Community(**c) for c in COMMUNITIES)
    if Event.query.count() == 0:
        db.session.add_all(_seed_events())
    db.session.commit()
