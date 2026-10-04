"""mesh API — a small Flask + SQLAlchemy service behind the mesh frontend.

Zero-config SQLite by default; set DATABASE_URL (+ optional DB_SCHEMA) to swap
to Postgres/Supabase, isolated inside its own schema so mesh can share one
database with other apps without collisions. See mesh_api/config.py and the
stackify-v1 skill for the pattern.
"""
import os

from flask import Flask, send_from_directory
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from dotenv import load_dotenv

from .config import resolve_config

db = SQLAlchemy()

# repo root (…/mesh), where the frontend build lands in dist/
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIST_DIR = os.path.join(REPO_ROOT, "dist")


def create_app() -> Flask:
    load_dotenv()

    app = Flask(
        __name__,
        instance_relative_config=True,
        static_folder=DIST_DIR,
        static_url_path="",
    )
    os.makedirs(app.instance_path, exist_ok=True)

    cfg = resolve_config(app.instance_path)
    app.config["SQLALCHEMY_DATABASE_URI"] = cfg["uri"]
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = cfg["engine_options"]
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["MESH_BACKEND"] = cfg["backend"]
    app.config["MESH_DB_SCHEMA"] = cfg["schema"]

    db.init_app(app)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    from .routes import api
    app.register_blueprint(api)

    with app.app_context():
        # On Postgres, create the app's schema first (idempotent) so the
        # unqualified CREATE TABLEs below land in it — search_path is already
        # pinned to it on the connection. (stackify-v1 rule 4)
        schema = cfg["schema"]
        if cfg["backend"] == "postgres" and schema and schema != "public":
            db.session.execute(text(f"CREATE SCHEMA IF NOT EXISTS {schema}"))
            db.session.commit()

        # Escape hatch for a schema that create_all() can't migrate in place (it
        # only creates missing *tables*, never alters an existing one). Set
        # MESH_DB_RESET=1 to drop mesh's tables and rebuild them from the current
        # models at boot — the ONLY reliable way past a stale schema when an old
        # deploy keeps recreating it. DESTRUCTIVE: wipes all rows every boot it's
        # set, so remove the env var again once the new schema is live.
        if os.environ.get("MESH_DB_RESET", "").strip().lower() in ("1", "true", "yes"):
            app.logger.warning(
                "MESH_DB_RESET set — dropping ALL mesh tables and rebuilding from "
                "the current models (remove the env var once the schema is live)."
            )
            db.drop_all()

        db.create_all()
        from .seed import seed_if_empty
        seed_if_empty()

    # Serve the built frontend (after `npm run build`) so the whole app can run
    # from Flask alone in production. In dev, Vite serves the frontend and
    # proxies /api here, so these routes simply go unused.
    @app.route("/")
    def index():
        if os.path.exists(os.path.join(DIST_DIR, "index.html")):
            return send_from_directory(DIST_DIR, "index.html")
        return {"service": "mesh-api", "status": "ok"}

    return app
