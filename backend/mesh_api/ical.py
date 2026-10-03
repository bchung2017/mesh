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


def fetch_ics(url: str, force: bool = False) -> str:
    """Fetch the iCal text, cached for a few minutes per URL (force to bypass)."""
    now = time.time()
    hit = _CACHE.get(url)
    if hit and not force and now - hit[1] < _TTL_SECONDS:
        return hit[0]
    resp = requests.get(url, timeout=_FETCH_TIMEOUT)
    resp.raise_for_status()
    _CACHE[url] = (resp.text, now)
    return resp.text


def parse_events(ics_text: str, start: date, end: date) -> list[dict]:
    """Expand the feed's events between [start, end) and map to mesh's shape.

    Pure (no network): given iCal text and a window, returns a list of
    occurrences sorted by date then time, each carrying both the display fields
    (date/time/name) and the identity + context the mesh layer needs to
    materialize and annotate it:

      seriesUid  the event's master UID — stable across every occurrence
      uid        per-occurrence key (master UID + the occurrence's start), so a
                 single instance of a recurring series can be annotated on its own
      name/location/description   the source layer's what/where/why
      allDay     True for date-only events (time is '')

    All-day events have time ''.
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
            day, tm, all_day = dt.date().isoformat(), dt.strftime("%H:%M"), False
        else:  # date -> all-day
            day, tm, all_day = dt.isoformat(), "", True

        master = str(ev.get("UID", "")) or f"anon-{day}-{tm}"
        location = ev.get("LOCATION")
        description = ev.get("DESCRIPTION")
        out.append({
            "seriesUid": master,
            "uid": f"{master}::{day}{('T' + tm) if tm else ''}",
            "date": day,
            "time": tm,
            "allDay": all_day,
            "name": str(ev.get("SUMMARY", "(busy)")),
            "location": str(location) if location else None,
            "description": str(description) if description else None,
        })
    out.sort(key=lambda e: (e["date"], e["time"]))
    return out


def get_feed_events(start: date, end: date, force: bool = False) -> tuple[bool, list[dict]]:
    """(configured, events). configured is False when MESH_ICS_URL is unset."""
    url = os.environ.get("MESH_ICS_URL")
    if not url:
        return False, []
    return True, parse_events(fetch_ics(url, force=force), start, end)
