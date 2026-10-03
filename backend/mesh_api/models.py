"""SQLAlchemy models for mesh. JSON serialization uses the camelCase keys the
frontend's TypeScript types already expect, so the API shape matches 1:1."""
from . import db

# many-to-many: an event can be tagged with zero or more communities
event_communities = db.Table(
    "event_communities",
    db.Column("event_id", db.Integer, db.ForeignKey("events.id", ondelete="CASCADE"), primary_key=True),
    db.Column("community_id", db.String(8), db.ForeignKey("communities.id", ondelete="CASCADE"), primary_key=True),
)


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

    # dated, typed log of what you've done for this community (drives Standing)
    contributions = db.relationship(
        "Contribution", backref="community", cascade="all, delete-orphan",
        passive_deletes=True, order_by="Contribution.date",
    )

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

    # communities this event is tagged with (empty = untagged / "null")
    communities = db.relationship(
        "Community", secondary=event_communities, backref="events", passive_deletes=True,
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "date": self.date,
            "time": self.time,
            "name": self.name,
            "communities": [c.id for c in self.communities],
        }


class Contribution(db.Model):
    __tablename__ = "contributions"

    id = db.Column(db.Integer, primary_key=True)
    community_id = db.Column(
        db.String(8), db.ForeignKey("communities.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    date = db.Column(db.String(10), nullable=False)   # YYYY-MM-DD (when it happened)
    text = db.Column(db.String(280), nullable=False)  # what you did
    mode = db.Column(db.String(16), nullable=False, default="built")  # built|organized|served|led|connected
    weight = db.Column(db.Integer, nullable=False, default=5)         # 1..10 impact/effort

    # optional provenance: the event that produced this contribution
    event_id = db.Column(
        db.Integer, db.ForeignKey("events.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    source_event_label = db.Column(db.String(200))   # snapshot at link time; survives event delete

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "communityId": self.community_id,
            "date": self.date,
            "text": self.text,
            "mode": self.mode,
            "weight": self.weight,
            "eventId": self.event_id,
            "sourceEventLabel": self.source_event_label,
            # derived: no event but a label means the event was deleted (tombstone)
            "orphaned": self.event_id is None and self.source_event_label is not None,
        }
