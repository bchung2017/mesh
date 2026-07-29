"""mesh API — a small Flask + SQLAlchemy service behind the mesh frontend."""
import os

from flask import Flask, send_from_directory
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from dotenv import load_dotenv

db = SQLAlchemy()

# repo root (…/mesh), where the frontend build lands in dist/
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIST_DIR = os.path.join(REPO_ROOT, "dist")


def _resolve_database_url(instance_path: str) -> str:
    """Pick the database URL from the environment, defaulting to a local SQLite file.

    Set DATABASE_URL to point at any SQLAlchemy-supported database. A bare
    ``postgres://`` URL (as some providers hand out) is normalized to the
    ``postgresql://`` form SQLAlchemy expects.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        return "sqlite:///" + os.path.join(instance_path, "mesh.db")
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


def create_app() -> Flask:
    load_dotenv()

    app = Flask(
        __name__,
        instance_relative_config=True,
        static_folder=DIST_DIR,
        static_url_path="",
    )
    os.makedirs(app.instance_path, exist_ok=True)

    app.config["SQLALCHEMY_DATABASE_URI"] = _resolve_database_url(app.instance_path)
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

    db.init_app(app)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    from .routes import api
    app.register_blueprint(api)

    with app.app_context():
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
