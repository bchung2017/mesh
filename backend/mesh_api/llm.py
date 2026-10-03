"""Optional LLM autofill for contributions (see docs/presence-model.md).

The deal, in one line: **LLM at the edges, deterministic math at the core.** This
module only ever *suggests* a `mode` and a `weight` from your free text (plus an
event's context when the contribution is logged from one). The suggestion is
confirmed/overridden in the UI; `create`/`update` stay plain value-stores and the
presence math never calls a model. So the LLM is never load-bearing: no key, no
network, a slow or bad response — the contribution still saves, you just pick the
chips yourself.

Enabled by setting ANTHROPIC_API_KEY (Claude Haiku 4.5, ~$0.001/suggestion). The
toggle in the UI is the kill switch; absent a key the classify endpoint reports
"not configured" and the frontend quietly falls back to manual.
"""
import os

from .presence import MODES

MODEL = "claude-haiku-4-5"

_SYSTEM = (
    "You classify a single thing a person did for a community into mesh's "
    "contribution schema. Be decisive and terse.\n"
    "- mode: the kind of contribution.\n"
    f"    {MODES[0]} — made/shipped/wrote something concrete.\n"
    f"    {MODES[1]} — organized/ran/scheduled/coordinated.\n"
    f"    {MODES[2]} — served/helped/supported other people.\n"
    f"    {MODES[3]} — led/decided/set direction/owned an outcome.\n"
    f"    {MODES[4]} — connected/introduced/brought people together.\n"
    "- weight: 1..10 impact+effort. 1–3 small/passive (showed up, a quick "
    "message), 4–6 solid work, 7–8 substantial, 9–10 rare and defining.\n"
    "- rationale: one short clause, no more."
)

_TOOL = {
    "name": "classify_contribution",
    "description": "Record the classification of one contribution.",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "mode": {"type": "string", "enum": list(MODES)},
            "weight": {"type": "integer", "minimum": 1, "maximum": 10},
            "rationale": {"type": "string"},
        },
        "required": ["mode", "weight", "rationale"],
    },
}


def configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def classify(text: str, event_context: str | None = None) -> dict:
    """Suggest {mode, weight, rationale} for a contribution. Raises on any
    failure (no key, import error, API/network error, malformed result) — the
    caller degrades to manual entry."""
    import anthropic  # lazy: the package/key are optional, import only on use

    prompt = f"Contribution: {text.strip()}"
    if event_context:
        prompt += f"\n\nLogged from this calendar event (who/what/where/when):\n{event_context.strip()}"

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    resp = client.messages.create(
        model=MODEL,
        max_tokens=200,
        system=_SYSTEM,
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "classify_contribution"},
        messages=[{"role": "user", "content": prompt}],
    )
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            out = block.input
            mode = out.get("mode")
            weight = out.get("weight")
            if mode not in MODES or not isinstance(weight, int):
                raise ValueError("model returned an invalid classification")
            return {
                "mode": mode,
                "weight": max(1, min(10, weight)),
                "rationale": str(out.get("rationale", ""))[:200],
            }
    raise ValueError("model returned no classification")
