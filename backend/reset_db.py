"""Destructively rebuild mesh's tables and reseed the default data.

Use this once after a schema change when there's nothing worth preserving — the
involvement flip dropped columns and earlier slices added some, and
`create_all()` only creates missing *tables*, it never alters an existing one.
So an existing Postgres/Supabase deploy keeps its stale schema and breaks. This
drops every mesh table in the configured schema, recreates them from the current
models, and reseeds the default communities + demo contribution log + events.

    cd backend
    DATABASE_URL="<postgres session-pooler url>" DB_SCHEMA="<schema>" \
        ./venv/bin/python reset_db.py --yes

Omit DATABASE_URL to rebuild the local SQLite database instead. It only ever
touches mesh's own tables (inside DB_SCHEMA when set), never a neighbour app's.
Requires --yes because it deletes all existing rows.
"""
import sys

from mesh_api import create_app, db
from mesh_api.seed import seed_if_empty


def main() -> int:
    if "--yes" not in sys.argv:
        print("refusing to run without --yes — this DROPS all mesh tables.")
        return 2

    app = create_app()
    with app.app_context():
        backend = app.config.get("MESH_BACKEND")
        schema = app.config.get("MESH_DB_SCHEMA") or "(search_path default)"
        print(f"mesh: rebuilding tables — backend={backend} schema={schema}")

        db.drop_all()      # mesh's tables only (create_all made them under this search_path)
        db.create_all()    # fresh from the current models
        seed_if_empty()    # default communities + demo log + events
        db.session.commit()

        from mesh_api.models import Community, Contribution, Event
        print(
            f"mesh: reseeded {Community.query.count()} communities, "
            f"{Contribution.query.count()} contributions, "
            f"{Event.query.count()} events."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
