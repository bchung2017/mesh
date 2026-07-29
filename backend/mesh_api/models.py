"""SQLAlchemy models for mesh. JSON serialization uses the camelCase keys the
frontend's TypeScript types already expect, so the API shape matches 1:1."""
from . import db


class Community(db.Model):
    __tablename__ = "communities"

    id = db.Column(db.String(8), primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    tone = db.Column(db.String(16), nullable=False)
    parse = db.Column(db.String(120), nullable=False)
    parse_state = db.Column(db.String(16), nullable=False, default="ok")
    involvement = db.Column(db.Integer, nullable=False, default=0)
    delta = db.Column(db.Integer, nullable=False, default=0)
    tenure = db.Column(db.String(32))
    energy = db.Column(db.String(32))
    last_artifact = db.Column(db.String(200))
    next_gathering = db.Column(db.String(200))
    note = db.Column(db.Text)
    position = db.Column(db.Integer, nullable=False, default=0)  # display order

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "tone": self.tone,
            "parse": self.parse,
            "parseState": self.parse_state,
            "involvement": self.involvement,
            "delta": self.delta,
            "tenure": self.tenure,
            "energy": self.energy,
            "lastArtifact": self.last_artifact,
            "nextGathering": self.next_gathering,
            "note": self.note,
        }


class Event(db.Model):
    __tablename__ = "events"

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.String(10), nullable=False, index=True)  # YYYY-MM-DD
    time = db.Column(db.String(5), nullable=False)               # HH:MM
    name = db.Column(db.String(120), nullable=False)
    tone = db.Column(db.String(8), nullable=False, default="warm")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "date": self.date,
            "time": self.time,
            "name": self.name,
            "tone": self.tone,
        }
