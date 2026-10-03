"""Seed the database with the mock community + event data the prototype shipped
with. Runs once, only when the tables are empty.

Involvement is derived, never stored, so the seed plants a small contribution
log per community instead of hard-coded numbers — enough that presence reads as
varied on first run (one humming, one warming, one settling, one cooling)."""
from datetime import date, timedelta

from . import db
from .models import Community, Contribution, Event

COMMUNITIES = [
    dict(id="HW", name="NYC Hardware", tone="coral", parse='"built the thing"', parse_state="ok",
         tenure="3 mo",
         last_artifact="charging writeup — 2 weeks ago",
         next_gathering="thursday meetup in 2 days",
         note="your strongest graph — keep bringing artifacts", position=0),
    dict(id="CL", name="Climate Circle", tone="salmon", parse="founder-type", parse_state="ok",
         tenure="2 mo",
         last_artifact="none yet — entered via intro",
         next_gathering="monthly circle in 9 days",
         note="fastest-growing blob; parser installed correctly at first contact", position=1),
    dict(id="MG", name="Makers Guild", tone="sky", parse="new face", parse_state="ok",
         tenure="3 wk",
         last_artifact="none yet",
         next_gathering="open shop night, saturday",
         note="too new to read — show up twice more before judging", position=2),
    dict(id="MM", name="Micromobility", tone="navy", parse="engineer", parse_state="stale",
         tenure="4 mo",
         last_artifact="BMS talk — 3 months ago",
         next_gathering="nothing on the calendar",
         note="parser stale — re-enter via artifact or let it fade deliberately", position=3),
]


def _seed_contributions() -> list[Contribution]:
    t = date.today()

    def ago(days: int) -> str:
        return (t - timedelta(days=days)).isoformat()

    def c(cid, days, text, mode, weight):
        return Contribution(community_id=cid, date=ago(days), text=text, mode=mode, weight=weight)

    return [
        # HW — recent and rising → humming, high presence
        c("HW", 2, "shipped the charging writeup", "built", 8),
        c("HW", 9, "ran the thursday soldering session", "organized", 7),
        c("HW", 20, "led the intake redesign", "led", 7),
        # CL — a couple recent, moderate → warming
        c("CL", 5, "introduced two members working on grids", "connected", 6),
        c("CL", 24, "helped run the monthly circle", "served", 5),
        # MG — one small recent → settling / steady
        c("MG", 12, "showed up and set up chairs", "served", 3),
        # MM — only old activity → cooling, low presence
        c("MM", 110, "gave the BMS talk", "built", 7),
        c("MM", 135, "organized the ride", "organized", 5),
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
        db.session.flush()   # communities exist before their contributions reference them
        db.session.add_all(_seed_contributions())
    if Event.query.count() == 0:
        db.session.add_all(_seed_events())
    db.session.commit()
