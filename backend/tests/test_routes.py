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


if __name__ == "__main__":
    unittest.main()
