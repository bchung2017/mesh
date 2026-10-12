"""SQLAlchemy models for mesh. JSON serialization uses the camelCase keys the
frontend's TypeScript types already expect, so the API shape matches 1:1."""
from datetime import datetime, timezone

from . import db
from .presence import compute_presence

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
    tone = db.Column(db.String(16), nullable=False)      # colour family (manual)
    parse = db.Column(db.String(120), nullable=False)    # how you read them (manual)
    parse_state = db.Column(db.String(16), nullable=False, default="ok")
    tenure = db.Column(db.String(32))                    # how long you've shown up (manual)
    last_artifact = db.Column(db.String(200))
    next_gathering = db.Column(db.String(200))
    note = db.Column(db.Text)
    position = db.Column(db.Integer, nullable=False, default=0)  # display order

    # dated, typed log of what you've done for this community — the ONLY source of
    # involvement/delta/energy, which are derived from it, never stored or entered
    contributions = db.relationship(
        "Contribution", backref="community", cascade="all, delete-orphan",
        passive_deletes=True, order_by="Contribution.date",
    )

    def to_dict(self) -> dict:
        # involvement/delta/energy/modeMix are the derived presence read — there is
        # no stored involvement any more, so every surface reads the same number
        p = compute_presence(self.contributions)
        return {
            "id": self.id,
            "name": self.name,
            "tone": self.tone,
            "parse": self.parse,
            "parseState": self.parse_state,
            "tenure": self.tenure,
            "lastArtifact": self.last_artifact,
            "nextGathering": self.next_gathering,
            "note": self.note,
            # derived from the contribution log:
            "involvement": p["involvement"],
            "delta": p["delta"],
            "energy": p["energy"],
            "modeMix": p["modeMix"],
            "contributionCount": p["contributionCount"],
            "lastContribution": p["lastContribution"],
        }


class SyncJob(db.Model):
    """A background agent run (the Sync button). Lives in the DB so progress
    survives a page refresh and can be polled; the heavy work happens in a worker
    thread that updates this row. A new table, so create_all() ships it with no
    migration."""
    __tablename__ = "sync_jobs"

    id = db.Column(db.Integer, primary_key=True)
    status = db.Column(db.String(16), nullable=False, default="running")  # running|done|failed|cancelled
    kind = db.Column(db.String(16))                 # 'recent' | 'deep' (label only)
    instruction = db.Column(db.Text)
    steps_done = db.Column(db.Integer, nullable=False, default=0)
    steps_total = db.Column(db.Integer, nullable=False, default=40)
    changes = db.Column(db.Integer, nullable=False, default=0)   # tool calls that mutated
    summary = db.Column(db.Text)
    error = db.Column(db.Text)
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

    def percent(self) -> int:
        if self.status == "done":
            return 100
        if self.status in ("failed", "cancelled"):
            # freeze the bar where it stopped
            return min(100, round(100 * self.steps_done / max(1, self.steps_total)))
        return min(95, round(100 * self.steps_done / max(1, self.steps_total)))  # running caps <100

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "kind": self.kind,
            "percent": self.percent(),
            "stepsDone": self.steps_done,
            "stepsTotal": self.steps_total,
            "changes": self.changes,
            "summary": self.summary,
            "error": self.error,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }


class CommunityEmbedding(db.Model):
    """A cached static embedding of a community's name, for conceptual dedup.

    A SEPARATE table (not a column on Community) on purpose: create_all() adds a
    missing *table* to an existing schema, but never adds a column — so this ships
    to the live database with no migration and no data loss. Computed lazily and
    recomputed when the name changes (the row is dropped); CASCADE-removed with
    the community.
    """
    __tablename__ = "community_embeddings"

    community_id = db.Column(
        db.String(8), db.ForeignKey("communities.id", ondelete="CASCADE"), primary_key=True,
    )
    vector = db.Column(db.Text, nullable=False)   # JSON list of floats
    model = db.Column(db.String(64))              # which embedder produced it


class Event(db.Model):
    """A calendar thing, in two layers (see docs/presence-model.md):

    - the *source layer* (name/when/where/why) comes from where the event was
      born — typed in mesh, or mirrored from the subscribed iCal feed — and is
      refreshed one-way from that origin;
    - the *mesh layer* (note, community tags) is yours and survives every refresh.

    iCal occurrences live only in the feed until you annotate one (tag/note) or
    log a contribution from it — at that point it's *materialized* as a row here,
    keyed by `uid`, so the annotation has something durable to hang on.
    """
    __tablename__ = "events"
    __table_args__ = (
        # one materialized row per feed occurrence; mesh-native rows leave uid
        # NULL, and NULLs are distinct, so this never constrains them
        db.UniqueConstraint("source", "uid", name="uq_event_source_uid"),
    )

    id = db.Column(db.Integer, primary_key=True)
    source = db.Column(db.String(8), nullable=False, default="mesh")  # mesh | ical

    # feed identity (null for mesh-native events)
    uid = db.Column(db.String(255), index=True)         # per-occurrence key
    series_uid = db.Column(db.String(255), index=True)  # groups a recurring series

    # --- source layer (refreshed from the origin) ---
    date = db.Column(db.String(10), nullable=False, index=True)  # YYYY-MM-DD (when)
    time = db.Column(db.String(5), nullable=False)               # HH:MM, '' = all-day
    name = db.Column(db.String(200), nullable=False)             # what
    location = db.Column(db.String(200))                         # where
    source_description = db.Column(db.Text)                      # why, as the feed gives it
    source_synced_at = db.Column(db.DateTime)                    # last refresh from origin
    tone = db.Column(db.String(8), nullable=False, default="warm")

    # --- mesh layer (yours; survives every feed refresh) ---
    note = db.Column(db.Text)   # the real who/why — richest signal for the LLM

    # communities this event is tagged with (empty = untagged / "null")
    communities = db.relationship(
        "Community", secondary=event_communities, backref="events", passive_deletes=True,
    )

    def refresh_source(self, name: str, location=None, description=None) -> None:
        """Overwrite only the source layer from an origin pull; mesh layer intact."""
        self.name = name[:200]
        self.location = (location or None) and str(location)[:200]
        self.source_description = (description or None) and str(description)
        self.source_synced_at = datetime.now(timezone.utc)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "source": self.source,
            "uid": self.uid,
            "seriesUid": self.series_uid,
            "date": self.date,
            "time": self.time,
            "name": self.name,
            "location": self.location,
            "sourceDescription": self.source_description,
            "note": self.note,
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
