"""Tests for iCal feed parsing (pure, no network)."""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mesh_api.ical import parse_events  # noqa: E402

ICS = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//mesh//EN
BEGIN:VEVENT
UID:timed-1
DTSTART:20260115T190000Z
DTEND:20260115T200000Z
SUMMARY:Hardware meetup
END:VEVENT
BEGIN:VEVENT
UID:allday-1
DTSTART;VALUE=DATE:20260120
DTEND;VALUE=DATE:20260121
SUMMARY:Offsite
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
DTSTART:20260105T100000Z
DTEND:20260105T103000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Standup
END:VEVENT
END:VCALENDAR
"""


class ParseEvents(unittest.TestCase):
    def setUp(self):
        self.events = parse_events(ICS, date(2026, 1, 1), date(2026, 2, 1))
        self.byname = {}
        for e in self.events:
            self.byname.setdefault(e["name"], []).append(e)

    def test_timed_event_maps_date_and_time(self):
        m = self.byname["Hardware meetup"][0]
        self.assertEqual(m["date"], "2026-01-15")
        self.assertEqual(m["time"], "19:00")

    def test_all_day_has_empty_time(self):
        o = self.byname["Offsite"][0]
        self.assertEqual(o["date"], "2026-01-20")
        self.assertEqual(o["time"], "")

    def test_recurrence_expands_to_each_monday_in_window(self):
        # Mondays in Jan 2026: 5, 12, 19, 26
        dates = sorted(e["date"] for e in self.byname["Standup"])
        self.assertEqual(dates, ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"])

    def test_sorted_by_date_then_time(self):
        keys = [(e["date"], e["time"]) for e in self.events]
        self.assertEqual(keys, sorted(keys))

    def test_window_excludes_out_of_range(self):
        # a narrow window catches only the 2026-01-12 standup
        only = parse_events(ICS, date(2026, 1, 12), date(2026, 1, 13))
        self.assertEqual([e["name"] for e in only], ["Standup"])
        self.assertEqual(only[0]["date"], "2026-01-12")

    def test_series_uid_is_the_master_uid(self):
        # every Standup occurrence shares one seriesUid (the series handle)...
        series = {e["seriesUid"] for e in self.byname["Standup"]}
        self.assertEqual(series, {"weekly-1"})

    def test_occurrence_uid_is_unique_per_instance(self):
        # ...but each occurrence gets its own uid, so one can be annotated alone
        uids = [e["uid"] for e in self.byname["Standup"]]
        self.assertEqual(len(uids), len(set(uids)))
        self.assertEqual(self.byname["Standup"][0]["uid"].split("::")[0], "weekly-1")

    def test_all_day_flag(self):
        self.assertTrue(self.byname["Offsite"][0]["allDay"])
        self.assertFalse(self.byname["Hardware meetup"][0]["allDay"])


if __name__ == "__main__":
    unittest.main()
