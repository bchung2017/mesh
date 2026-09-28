"""Read-only subscription to an external calendar's iCal (.ics) feed.

Set MESH_ICS_URL to a calendar's iCal address (e.g. Google Calendar's "Secret
address in iCal format"). We fetch it (cached), expand recurrences within the
requested window, and map each occurrence to mesh's calendar shape. No OAuth —
the URL itself is the (bearer) credential, so keep it secret.
"""
import os
import time
from datetime import date, datetime

import icalendar
import recurring_ical_events
import requests

_CACHE: dict[str, tuple[str, float]] = {}
_TTL_SECONDS = 300           # Google's feed lags anyway; don't refetch per request
_FETCH_TIMEOUT = 10


def fetch_ics(url: str) -> str:
    """Fetch the iCal text, cached for a few minutes per URL."""
    now = time.time()
    hit = _CACHE.get(url)
    if hit and now - hit[1] < _TTL_SECONDS:
        return hit[0]
    resp = requests.get(url, timeout=_FETCH_TIMEOUT)
    resp.raise_for_status()
    _CACHE[url] = (resp.text, now)
    return resp.text


def parse_events(ics_text: str, start: date, end: date) -> list[dict]:
    """Expand the feed's events between [start, end) and map to mesh's shape.

    Pure (no network): given iCal text and a window, returns
    [{date, time, name}] sorted by date then time. All-day events have time ''.
    """
    cal = icalendar.Calendar.from_ical(ics_text)
    occurrences = recurring_ical_events.of(cal).between(start, end)
    out: list[dict] = []
    for ev in occurrences:
        dtstart = ev.get("DTSTART")
        if dtstart is None:
            continue
        dt = dtstart.dt
        if isinstance(dt, datetime):
            day, tm = dt.date().isoformat(), dt.strftime("%H:%M")
        else:  # date -> all-day
            day, tm = dt.isoformat(), ""
        out.append({
            "date": day,
            "time": tm,
            "name": str(ev.get("SUMMARY", "(busy)")),
        })
    out.sort(key=lambda e: (e["date"], e["time"]))
    return out


def get_feed_events(start: date, end: date) -> tuple[bool, list[dict]]:
    """(configured, events). configured is False when MESH_ICS_URL is unset."""
    url = os.environ.get("MESH_ICS_URL")
    if not url:
        return False, []
    return True, parse_events(fetch_ics(url), start, end)
