"""Tests for the community + event routes, using an in-memory-ish SQLite app."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def make_client():
    # a throwaway on-disk SQLite so each test app starts seeded and isolated
    tmp = tempfile.mkdtemp()
    os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tmp, "test.db")
    os.environ.pop("DB_SCHEMA", None)
    # import after env is set so create_app picks it up
    from mesh_api import create_app
    app = create_app()
    return app.test_client()


class UpdateCommunity(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_updates_fields(self):
        r = self.client.put("/api/communities/HW", json={"involvement": 40, "tone": "sky"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["involvement"], 40)
        self.assertEqual(r.get_json()["tone"], "sky")
        # persisted
        again = self.client.get("/api/communities").get_json()
        hw = next(c for c in again if c["id"] == "HW")
        self.assertEqual(hw["involvement"], 40)

    def test_ignores_unknown_keys_including_blob(self):
        r = self.client.put("/api/communities/HW", json={"blob": {"x": 1}, "bogus": 2, "note": "ok"})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("blob", r.get_json())
        self.assertEqual(r.get_json()["note"], "ok")

    def test_missing_is_404(self):
        self.assertEqual(self.client.put("/api/communities/NOPE", json={"note": "x"}).status_code, 404)

    def test_bad_values_are_400(self):
        self.assertEqual(self.client.put("/api/communities/HW", json={"tone": "purple"}).status_code, 400)
        self.assertEqual(self.client.put("/api/communities/HW", json={"involvement": 250}).status_code, 400)
        self.assertEqual(self.client.put("/api/communities/HW", json={"parseState": "meh"}).status_code, 400)


class CreateReadDeleteCommunity(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def test_create_generates_id_and_defaults(self):
        r = self.client.post("/api/communities", json={"name": "Robotics League", "involvement": 30})
        self.assertEqual(r.status_code, 201)
        body = r.get_json()
        self.assertEqual(body["id"], "RL")            # initials
        self.assertEqual(body["involvement"], 30)
        self.assertEqual(body["tone"], "sky")          # default
        self.assertEqual(body["parseState"], "ok")     # default
        # it shows up in the list
        ids = [c["id"] for c in self.client.get("/api/communities").get_json()]
        self.assertIn("RL", ids)

    def test_create_id_collision_suffixes(self):
        a = self.client.post("/api/communities", json={"name": "Robot League"}).get_json()
        b = self.client.post("/api/communities", json={"name": "Rocket Labs"}).get_json()
        self.assertEqual(a["id"], "RL")
        self.assertEqual(b["id"], "RL2")               # unique despite same initials

    def test_create_requires_name_and_validates(self):
        self.assertEqual(self.client.post("/api/communities", json={}).status_code, 400)
        self.assertEqual(self.client.post("/api/communities", json={"name": "X", "tone": "gold"}).status_code, 400)
        self.assertEqual(self.client.post("/api/communities", json={"name": "X", "involvement": -5}).status_code, 400)

    def test_get_one(self):
        self.assertEqual(self.client.get("/api/communities/HW").get_json()["name"], "NYC Hardware")
        self.assertEqual(self.client.get("/api/communities/NOPE").status_code, 404)

    def test_delete(self):
        self.assertEqual(self.client.delete("/api/communities/MM").status_code, 204)
        ids = [c["id"] for c in self.client.get("/api/communities").get_json()]
        self.assertNotIn("MM", ids)
        self.assertEqual(self.client.delete("/api/communities/MM").status_code, 404)  # already gone


class EventTagging(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def _make(self, **extra):
        body = {"date": "2026-03-10", "name": "sync", "time": "18:00", **extra}
        return self.client.post("/api/events", json=body).get_json()

    def test_create_with_tags(self):
        ev = self._make(communities=["HW", "CL"])
        self.assertEqual(set(ev["communities"]), {"HW", "CL"})

    def test_untagged_is_empty(self):
        self.assertEqual(self._make()["communities"], [])

    def test_unknown_community_ignored(self):
        ev = self._make(communities=["HW", "NOPE"])
        self.assertEqual(ev["communities"], ["HW"])

    def test_community_events_reverse_lookup(self):
        ev = self._make(communities=["HW"])
        rows = self.client.get("/api/communities/HW/events").get_json()
        self.assertIn(ev["id"], [r["id"] for r in rows])
        self.assertEqual(self.client.get("/api/communities/NOPE/events").status_code, 404)

    def test_update_retags(self):
        ev = self._make(communities=["HW"])
        upd = self.client.put(f"/api/events/{ev['id']}", json={"communities": ["MG"]}).get_json()
        self.assertEqual(upd["communities"], ["MG"])
        self.assertNotIn(ev["id"], [r["id"] for r in self.client.get("/api/communities/HW/events").get_json()])
        self.assertIn(ev["id"], [r["id"] for r in self.client.get("/api/communities/MG/events").get_json()])

    def test_deleting_community_untags_event(self):
        ev = self._make(communities=["HW", "CL"])
        self.assertEqual(self.client.delete("/api/communities/CL").status_code, 204)
        again = next(e for e in self.client.get("/api/events").get_json() if e["id"] == ev["id"])
        self.assertEqual(again["communities"], ["HW"])


class Contributions(unittest.TestCase):
    def setUp(self):
        self.client = make_client()

    def _add(self, cid="HW", **extra):
        body = {"date": "2026-09-01", "text": "shipped a thing", "mode": "built", "weight": 7, **extra}
        return self.client.post(f"/api/communities/{cid}/contributions", json=body)

    def test_create_and_list(self):
        r = self._add()
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.get_json()["communityId"], "HW")
        rows = self.client.get("/api/communities/HW/contributions").get_json()
        self.assertEqual(len(rows), 1)

    def test_defaults(self):
        b = self.client.post("/api/communities/HW/contributions", json={"date": "2026-09-01", "text": "x"}).get_json()
        self.assertEqual(b["mode"], "built")
        self.assertEqual(b["weight"], 5)

    def test_validation(self):
        bad = [
            {"text": "x", "date": "nope"},
            {"date": "2026-09-01"},                                   # no text
            {"date": "2026-09-01", "text": "x", "mode": "vibing"},
            {"date": "2026-09-01", "text": "x", "weight": 99},
        ]
        for body in bad:
            self.assertEqual(self.client.post("/api/communities/HW/contributions", json=body).status_code, 400)

    def test_community_404(self):
        self.assertEqual(self._add(cid="NOPE").status_code, 404)

    def test_update_and_delete(self):
        cid = self._add().get_json()["id"]
        up = self.client.put(f"/api/contributions/{cid}", json={"mode": "led", "weight": 9})
        self.assertEqual(up.status_code, 200)
        self.assertEqual(up.get_json()["mode"], "led")
        self.assertEqual(self.client.delete(f"/api/contributions/{cid}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/contributions/{cid}").status_code, 404)

    def test_presence_reflects_log(self):
        from datetime import date
        self.assertEqual(self.client.get("/api/communities/HW/presence").get_json()["involvement"], 0)
        self._add(date=date.today().isoformat(), weight=10, mode="built")
        s = self.client.get("/api/communities/HW/presence").get_json()
        self.assertGreater(s["involvement"], 0)
        self.assertEqual(s["modeMix"]["built"], 100)

    def test_delete_community_cascades_contributions(self):
        self._add(cid="MM")
        self.assertEqual(self.client.delete("/api/communities/MM").status_code, 204)
        self.assertEqual(self.client.get("/api/communities/MM/presence").status_code, 404)

    def _event(self):
        return self.client.post("/api/events", json={"date": "2026-09-01", "name": "hardware meetup"}).get_json()

    def test_standalone_contribution_not_orphaned(self):
        c = self._add().get_json()
        self.assertIsNone(c["eventId"])
        self.assertIsNone(c["sourceEventLabel"])
        self.assertFalse(c["orphaned"])

    def test_link_to_event_snapshots_label(self):
        ev = self._event()
        c = self._add(eventId=ev["id"]).get_json()
        self.assertEqual(c["eventId"], ev["id"])
        self.assertEqual(c["sourceEventLabel"], "2026-09-01 · hardware meetup")
        self.assertFalse(c["orphaned"])

    def test_relog_same_event_community_upserts(self):
        ev = self._event()
        first = self._add(eventId=ev["id"], text="attended").get_json()
        second = self._add(eventId=ev["id"], text="attended + demoed").get_json()
        self.assertEqual(first["id"], second["id"])           # same row
        self.assertEqual(second["text"], "attended + demoed")  # updated
        rows = self.client.get("/api/communities/HW/contributions").get_json()
        self.assertEqual(len([r for r in rows if r["eventId"] == ev["id"]]), 1)

    def test_deleting_event_orphans_contribution(self):
        ev = self._event()
        self._add(eventId=ev["id"])
        self.assertEqual(self.client.delete(f"/api/events/{ev['id']}").status_code, 204)
        c = self.client.get("/api/communities/HW/contributions").get_json()[0]
        self.assertIsNone(c["eventId"])
        self.assertEqual(c["sourceEventLabel"], "2026-09-01 · hardware meetup")  # tombstone kept
        self.assertTrue(c["orphaned"])

    def test_link_to_missing_event_400(self):
        self.assertEqual(self._add(eventId=999999).status_code, 400)


if __name__ == "__main__":
    unittest.main()
