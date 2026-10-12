"""Run the mesh autonomous agent once, from the command line.

This is the scheduled entrypoint: a Render Cron Job (or any scheduler) runs

    python agent_run.py ["free-text instruction"]

on a cadence. It needs the same env as the web service — DATABASE_URL (+
DB_SCHEMA), ANTHROPIC_API_KEY — plus MESH_AGENT_ENABLED=1. With no argument it
does the agent's default light maintenance pass. The force-refresh endpoint
(POST /api/agent/run) runs the exact same run_agent().
"""
import json
import sys

from mesh_api import create_app
from mesh_api.agent import AgentError, run_agent


def main() -> int:
    instruction = " ".join(sys.argv[1:]).strip() or None
    app = create_app()
    with app.app_context():
        try:
            result = run_agent(instruction)
        except AgentError as exc:
            print(f"mesh agent: {exc}", file=sys.stderr)
            return 1
    print(result.get("summary") or "(no summary)")
    print(f"\n{len(result.get('actions', []))} action(s) in {result.get('steps')} step(s):")
    for a in result.get("actions", []):
        mark = "ok" if a.get("ok") else "ERR"
        detail = a.get("error") if not a.get("ok") else json.dumps(a.get("input"), default=str)
        print(f"  [{mark}] {a['tool']} {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
