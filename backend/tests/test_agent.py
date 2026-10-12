"""Tests for the autonomous agent: the tool loop dispatches to the real services
(so a model 'decision' actually mutates data), and the endpoint is gated."""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def make_app():
    tmp = tempfile.mkdtemp()
    os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tmp, "agent.db")
    os.environ.pop("DB_SCHEMA", None)
    from mesh_api import create_app
    return create_app()


class Block:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def resp(content, stop_reason):
    return Block(content=content, stop_reason=stop_reason)


def fake_anthropic(script):
    """A stand-in `anthropic` module whose client replays `script` responses."""
    state = {"i": 0}

    class Messages:
        def create(self, **kw):
            r = script[state["i"]]
            state["i"] += 1
            return r

    class Client:
        def __init__(self, *a, **k):
            self.messages = Messages()

    mod = types.ModuleType("anthropic")
    mod.Anthropic = Client
    return mod


# a two-round script: call create_community, then finish with a summary
def create_script():
    return [
        resp([Block(type="tool_use", name="create_community",
                    input={"name": "Robotics League", "tone": "sky"}, id="t1")], "tool_use"),
        resp([Block(type="text", text="Created Robotics League.")], "end_turn"),
    ]


ENABLED = {"MESH_AGENT_ENABLED": "1", "ANTHROPIC_API_KEY": "test-key"}


class AgentLoop(unittest.TestCase):
    def test_tool_call_actually_mutates_via_services(self):
        app = make_app()
        with mock.patch.dict(os.environ, ENABLED), \
             mock.patch.dict(sys.modules, {"anthropic": fake_anthropic(create_script())}), \
             app.app_context():
            from mesh_api import services
            from mesh_api.agent import run_agent
            out = run_agent("make a community called Robotics League")
            self.assertIn("Created", out["summary"])
            self.assertTrue(any(a["tool"] == "create_community" and a["ok"] for a in out["actions"]))
            self.assertIn("RL", [c["id"] for c in services.list_communities()])

    def test_tool_error_is_reported_not_raised(self):
        # deleting a missing community → ServiceError surfaced as a failed action,
        # the loop keeps going and still returns a summary
        script = [
            resp([Block(type="tool_use", name="delete_community", input={"id": "NOPE"}, id="t1")], "tool_use"),
            resp([Block(type="text", text="That community didn't exist.")], "end_turn"),
        ]
        app = make_app()
        with mock.patch.dict(os.environ, ENABLED), \
             mock.patch.dict(sys.modules, {"anthropic": fake_anthropic(script)}), \
             app.app_context():
            from mesh_api.agent import run_agent
            out = run_agent("delete NOPE")
            bad = [a for a in out["actions"] if a["tool"] == "delete_community"]
            self.assertTrue(bad and bad[0]["ok"] is False)

    def test_materialize_tool_creates_ical_event(self):
        # the calendar-driven path: materialize a feed occurrence so a
        # contribution can link to it idempotently
        script = [
            resp([Block(type="tool_use", name="materialize_event",
                        input={"uid": "u::2026-02-01", "date": "2026-02-01", "name": "build night"}, id="t1")], "tool_use"),
            resp([Block(type="text", text="materialized.")], "end_turn"),
        ]
        app = make_app()
        with mock.patch.dict(os.environ, ENABLED), \
             mock.patch.dict(sys.modules, {"anthropic": fake_anthropic(script)}), \
             app.app_context():
            from mesh_api.agent import run_agent
            from mesh_api.models import Event
            out = run_agent("materialize the build night")
            act = [a for a in out["actions"] if a["tool"] == "materialize_event"]
            self.assertTrue(act and act[0]["ok"])
            self.assertIsNotNone(Event.query.filter_by(source="ical", uid="u::2026-02-01").first())

    def test_disabled_raises(self):
        app = make_app()
        with mock.patch.dict(os.environ, {}, clear=False), app.app_context():
            os.environ.pop("MESH_AGENT_ENABLED", None)
            from mesh_api.agent import run_agent, AgentError
            with self.assertRaises(AgentError):
                run_agent("do something")


class AgentEndpoint(unittest.TestCase):
    def test_disabled_is_503(self):
        app = make_app()
        client = app.test_client()
        os.environ.pop("MESH_AGENT_ENABLED", None)
        self.assertEqual(client.post("/api/agent/run", json={}).status_code, 503)

    def test_enabled_runs_and_returns_summary(self):
        app = make_app()
        client = app.test_client()
        with mock.patch.dict(os.environ, ENABLED), \
             mock.patch.dict(sys.modules, {"anthropic": fake_anthropic(create_script())}):
            r = client.post("/api/agent/run", json={"instruction": "make a community called Robotics League"})
            self.assertEqual(r.status_code, 200)
            body = r.get_json()
            self.assertIn("summary", body)
            self.assertIn("RL", [c["id"] for c in client.get("/api/communities").get_json()])

    def test_token_required_when_set(self):
        app = make_app()
        client = app.test_client()
        with mock.patch.dict(os.environ, {**ENABLED, "MESH_AGENT_TOKEN": "s3cret"}):
            # wrong/missing token → 403, before the model is ever called
            self.assertEqual(client.post("/api/agent/run", json={}).status_code, 403)
            self.assertEqual(
                client.post("/api/agent/run", headers={"Authorization": "Bearer nope"}, json={}).status_code, 403)
            # correct token → runs
            with mock.patch.dict(sys.modules, {"anthropic": fake_anthropic(create_script())}):
                r = client.post("/api/agent/run", headers={"Authorization": "Bearer s3cret"},
                                json={"instruction": "make a community called Robotics League"})
                self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
