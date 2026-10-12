"""The autonomous mesh agent.

Claude is given tools that are 1:1 with the domain operations in services.py and
driven in a tool-use loop: it reads the current state, decides what to do, and
calls tools to create / update / delete communities, contributions and mesh
events — applying everything itself (fully autonomous). The real Google calendar
is exposed read-only; the agent can read it for context but never writes to it.

Gated behind MESH_AGENT_ENABLED (+ ANTHROPIC_API_KEY) because it changes real
data without asking. The deterministic rules still live in services.py — the LLM
only decides *which* operations to call, never bypasses their validation.
"""
import json
import os

from . import services
from .presence import MODES
from .services import ServiceError

MODEL = os.environ.get("MESH_AGENT_MODEL", "claude-haiku-4-5")
MAX_STEPS = 16          # hard cap on tool-use rounds, so a loop can't run away
MAX_TOKENS = 1024


class AgentError(Exception):
    """The agent could not run (no key, model/network failure, step cap)."""


def enabled() -> bool:
    return (
        os.environ.get("MESH_AGENT_ENABLED", "").strip().lower() in ("1", "true", "yes")
        and bool(os.environ.get("ANTHROPIC_API_KEY"))
    )


# ---------------- tools: thin wrappers over services, returning JSON-able dicts ----------------

def _community_props() -> dict:
    return {
        "name": {"type": "string"},
        "tone": {"type": "string", "enum": sorted(services.COMMUNITY_TONES)},
        "parse": {"type": "string", "description": "how you read this community, e.g. 'founder-type'"},
        "parseState": {"type": "string", "enum": sorted(services.PARSE_STATES)},
        "tenure": {"type": "string", "description": "how long you've shown up, e.g. '3 mo'"},
        "lastArtifact": {"type": "string"},
        "nextGathering": {"type": "string"},
        "note": {"type": "string"},
    }


def _tool(name, description, properties, required):
    return {
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object", "additionalProperties": False,
            "properties": properties, "required": required,
        },
    }


TOOLS = [
    _tool("list_communities", "List every community (blob) with its derived presence.", {}, []),
    _tool("create_community", "Create a new community. involvement is derived, so it starts at 0 until contributions are logged.",
          _community_props(), ["name"]),
    _tool("update_community", "Update a community's manual fields (not involvement/delta/energy — those are derived).",
          {"id": {"type": "string"}, **_community_props()}, ["id"]),
    _tool("delete_community", "Delete a community and all its contributions. Irreversible.",
          {"id": {"type": "string"}}, ["id"]),

    _tool("list_contributions", "List a community's contribution log (newest first).",
          {"communityId": {"type": "string"}}, ["communityId"]),
    _tool("log_contribution",
          "Log a contribution for a community — THIS is how you raise its presence (never edit involvement directly). "
          f"mode is one of {MODES}; weight is 1-10 impact/effort. Optionally link an eventId.",
          {"communityId": {"type": "string"}, "text": {"type": "string"},
           "date": {"type": "string", "description": "YYYY-MM-DD; defaults to today"},
           "mode": {"type": "string", "enum": list(MODES)},
           "weight": {"type": "integer", "minimum": 1, "maximum": 10},
           "eventId": {"type": "integer", "description": "a mesh event id this came from"}},
          ["communityId", "text"]),
    _tool("update_contribution", "Edit a contribution.",
          {"id": {"type": "integer"}, "text": {"type": "string"}, "date": {"type": "string"},
           "mode": {"type": "string", "enum": list(MODES)}, "weight": {"type": "integer", "minimum": 1, "maximum": 10}},
          ["id"]),
    _tool("delete_contribution", "Delete a contribution. Lowers the community's presence.",
          {"id": {"type": "integer"}}, ["id"]),

    _tool("list_events", "List mesh's own calendar events (not the read-only Google feed).", {}, []),
    _tool("create_event", "Create a mesh calendar event. Does NOT touch your real Google Calendar.",
          {"date": {"type": "string", "description": "YYYY-MM-DD"}, "name": {"type": "string"},
           "time": {"type": "string", "description": "HH:MM; defaults to 18:00"},
           "note": {"type": "string"},
           "communities": {"type": "array", "items": {"type": "string"}, "description": "community ids to tag"}},
          ["date", "name"]),
    _tool("update_event", "Update a mesh event — note, tags, or (mesh-native only) date/time/name.",
          {"id": {"type": "integer"}, "name": {"type": "string"}, "date": {"type": "string"},
           "time": {"type": "string"}, "note": {"type": "string"},
           "communities": {"type": "array", "items": {"type": "string"}}},
          ["id"]),
    _tool("delete_event", "Delete a mesh event. Its logged contributions are kept but unlinked.",
          {"id": {"type": "integer"}}, ["id"]),

    _tool("read_calendar",
          "Read the subscribed Google calendar (READ-ONLY mirror) for context — what's scheduled. "
          "Each occurrence has uid/seriesUid/date/time/name/location, and meshId+note+communities "
          "if already materialized. You cannot change the real calendar; use create_event for mesh's "
          "own records.",
          {"timeMin": {"type": "string", "description": "YYYY-MM-DD"},
           "timeMax": {"type": "string", "description": "YYYY-MM-DD"}}, []),
    _tool("materialize_event",
          "Persist a READ-ONLY calendar occurrence (from read_calendar) as a mesh event so you can "
          "tag it and log a contribution from it. Idempotent on uid — returns the existing mesh event "
          "if already materialized. Pass the occurrence's uid/date/name (and time/seriesUid/location "
          "when present). Then log_contribution with the returned event id so re-runs upsert, not "
          "duplicate.",
          {"uid": {"type": "string"}, "date": {"type": "string", "description": "YYYY-MM-DD"},
           "name": {"type": "string"}, "time": {"type": "string"},
           "seriesUid": {"type": "string"}, "location": {"type": "string"}},
          ["uid", "date", "name"]),
]


def _dispatch(name: str, inp: dict):
    if name == "list_communities":
        return {"communities": services.list_communities()}
    if name == "create_community":
        return services.create_community(inp)
    if name == "update_community":
        return services.update_community(inp["id"], {k: v for k, v in inp.items() if k != "id"})
    if name == "delete_community":
        services.delete_community(inp["id"])
        return {"deleted": inp["id"]}
    if name == "list_contributions":
        return {"contributions": services.list_contributions(inp["communityId"])}
    if name == "log_contribution":
        row, created = services.create_contribution(inp["communityId"],
            {k: v for k, v in inp.items() if k != "communityId"})
        return {"contribution": row, "created": created}
    if name == "update_contribution":
        return services.update_contribution(inp["id"], {k: v for k, v in inp.items() if k != "id"})
    if name == "delete_contribution":
        services.delete_contribution(inp["id"])
        return {"deleted": inp["id"]}
    if name == "list_events":
        return {"events": services.list_events()}
    if name == "create_event":
        return services.create_event(inp)
    if name == "update_event":
        return services.update_event(inp["id"], {k: v for k, v in inp.items() if k != "id"})
    if name == "delete_event":
        services.delete_event(inp["id"])
        return {"deleted": inp["id"]}
    if name == "read_calendar":
        return services.read_feed(inp.get("timeMin", ""), inp.get("timeMax", ""))
    if name == "materialize_event":
        row, created = services.materialize_event(inp)
        return {"event": row, "created": created}
    raise ServiceError(400, f"unknown tool {name}")


SYSTEM = (
    "You maintain 'mesh', an app tracking how present the user is in local communities. "
    "Each community is a soft-body 'blob'. Core rule: a community's involvement, delta and "
    "energy are DERIVED from its contribution log — you can never set them. To raise a "
    "community's presence, log a contribution (log_contribution); to lower it, delete one. "
    f"Contribution modes: {MODES}; weight is 1-10 impact/effort. Community tones: "
    f"{sorted(services.COMMUNITY_TONES)}.\n\n"
    "The Google calendar (read_calendar) is a READ-ONLY mirror — read it for context, but you "
    "cannot change it. You CAN create/edit/delete mesh's own events, which are separate records.\n\n"
    "You are autonomous: apply changes directly with the tools, no confirmation. Be deliberate — "
    "especially deletes. Do only what the instruction asks (or, with no instruction, a light, "
    "safe maintenance pass). Prefer doing nothing over guessing. When finished, reply with a short "
    "plain-text summary of exactly what you changed."
)

DEFAULT_INSTRUCTION = (
    "Do a light maintenance pass: review the communities and their recent contribution logs, and "
    "the upcoming calendar. Only make a change if it is clearly warranted; otherwise report that "
    "everything looks healthy and leave it untouched."
)


def run_agent(instruction: str | None = None) -> dict:
    """Run one autonomous session. Returns {summary, actions, steps}. Assumes an
    app context (the caller — the endpoint or the runner script — provides one)."""
    if not enabled():
        raise AgentError("agent not enabled (set MESH_AGENT_ENABLED=1 and ANTHROPIC_API_KEY)")
    try:
        import anthropic
    except ImportError as exc:
        raise AgentError("anthropic SDK not installed") from exc

    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": instruction or DEFAULT_INSTRUCTION}]
    actions: list[dict] = []

    for step in range(MAX_STEPS):
        try:
            resp = client.messages.create(
                model=MODEL, max_tokens=MAX_TOKENS, system=SYSTEM,
                tools=TOOLS, messages=messages,
            )
        except Exception as exc:
            raise AgentError(f"model call failed: {exc}") from exc

        messages.append({"role": "assistant", "content": resp.content})

        if resp.stop_reason != "tool_use":
            summary = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
            return {"summary": summary, "actions": actions, "steps": step + 1}

        tool_results = []
        for block in resp.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            try:
                result = _dispatch(block.name, dict(block.input))
                actions.append({"tool": block.name, "input": block.input, "ok": True, "result": result})
                tool_results.append({"type": "tool_result", "tool_use_id": block.id,
                                     "content": json.dumps(result, default=str)})
            except ServiceError as exc:
                actions.append({"tool": block.name, "input": block.input, "ok": False, "error": exc.message})
                tool_results.append({"type": "tool_result", "tool_use_id": block.id,
                                     "content": f"error: {exc.message}", "is_error": True})
        messages.append({"role": "user", "content": tool_results})

    raise AgentError(f"hit the {MAX_STEPS}-step cap without finishing")
