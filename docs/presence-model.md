# mesh: Event → Contribution → Presence

The data model behind "how involved am I, really." This note is the agreed
design; see **Build status** at the end for what's implemented vs. specced.

## The pipeline

```
Event  ──(LLM reads full context)──▶  Contribution  ──(decayed sum)──▶  Presence
(who/what/where/when + your notes)     (mode/weight toward a community)   (per-community read)
```

- An **Event** is a calendar thing (meetup, workshop) with a source layer
  (who/what/where/when) and a mesh layer (your notes, tags) on top.
- A **Contribution** is the atom of involvement: a dated thing you did *for a
  community*, with a `mode` and a `weight`. It may be born from an event or
  logged directly.
- **Presence** is the derived read on a community, computed only from its
  contributions. Intrinsic and per-community — never a leaderboard.

Three nouns, one rule that keeps them untangled: **a contribution is a
self-contained snapshot.** Presence reads only contributions; it never walks to
an event. So anything that happens to the calendar can't silently shift your
presence.

---

## Event

One table, a `source` discriminator, two layers.

```
Event
  id                 # mesh PK
  source             # 'mesh' | 'ical'
  series_uid         # iCal master UID — same across all occurrences of a series;
                     #   null for one-offs / mesh-native. Grouping handle for rollups.
  uid                # per-occurrence key = master UID + occurrence start (RECURRENCE-ID);
                     #   just the UID for a one-off. UNIQUE per (source, uid).
                     #   The reconcile match key AND the annotation anchor.
  # --- source layer (refreshed from the origin) ---
  title              # WHAT   (SUMMARY / name)
  start / end        # WHEN   (date or datetime; all_day flag)
  location           # WHERE  (iCal LOCATION)
  attendees          # WHO    (iCal ATTENDEE/ORGANIZER, JSON list)
  source_description # WHY    (iCal DESCRIPTION, as given)
  source_synced_at
  # --- mesh layer (yours, survives every refresh) ---
  note               # WHY    (your reason / what happened / who you actually met)
  communities        # tags (m2m) — which communities this event is relevant to
```

**The five W's** map to the source layer, with one honest caveat: a personal
Google iCal feed usually ships `when` and `what`, often omits `where`, and
almost always omits `who`. So in practice **your `note` carries the real who +
why** — which is why the mesh layer is the richest signal for the LLM.

**Lazy materialization (iCal).** An iCal occurrence stays ephemeral
(live-fetched, display-only) until you annotate it (note/tag) or log a
contribution from it. At that moment we persist a row keyed by `uid`, caching a
snapshot of the source fields. Unannotated occurrences are never persisted — no
recurring-event row explosion.

**Reconcile.** On each feed pull, materialized rows get their *source layer*
refreshed by `uid`; the *mesh layer* is never touched. Same pattern as the
community store (source flows one way; the layer you own survives).

**Recurrence.** `series_uid` groups a recurring commitment; annotations attach
per occurrence (`uid`). Roll up "my standup contributions" by `series_uid`
without series-wide propagation of a single note.

---

## Contribution

The atom of presence. Self-contained: it owns everything presence needs.

```
Contribution
  id
  community_id        → Community.id   # the community this counts toward (ON DELETE CASCADE)
  date                # YYYY-MM-DD (when it happened)
  text                # what you did
  mode                # built | organized | served | led | connected
  weight              # 1..10 impact/effort (LLM- or hand-set; shown abstracted, not as a raw number)
  # --- optional provenance (an event that produced it) ---
  event_id            → Event.id       # live link, nullable, ON DELETE SET NULL
  source_event_label  # durable snapshot taken at link time, e.g. "Oct 12 · hardware meetup"
  UNIQUE (event_id, community_id)       # when event_id not null — dedup / upsert key
```

**Two doors, one atom:**
- **From the calendar** — annotate an event → "log this" → contribution *with*
  `event_id` + `source_event_label`.
- **Directly** — "+ add" on a community → contribution with no event. This is
  the *common* path: most builder work (shipping, writing, async intros) never
  touches a calendar, and must count toward presence.

**One event → 0..N contributions** (one per credited community; usually 0–1).
`UNIQUE(event_id, community_id)` makes re-logging an upsert, not a duplicate.

**Provenance state** is derived, no stored flag:

| State | `event_id` | `source_event_label` | meaning |
|---|---|---|---|
| **Linked** | set | set | live; event still exists |
| **Orphaned** | null | **set** | its event was deleted — snapshot survives as a tombstone |
| **Standalone** | null | null | never had an event (the 2am writeup) |

`to_dict` exposes `orphaned = event_id is None and source_event_label is not None`.

**Deleting an event keeps its contributions** (`ON DELETE SET NULL`, handled
explicitly so it holds on SQLite too): the FK nulls, the label remains, the
contribution flips to *orphaned* and stays readable. Deleting a calendar entry
can never erase earned involvement — made visible, not silent. The delete-event
flow confirms this: *"Its N logged contributions will be kept and marked
unlinked."*

---

## Presence (computed, never entered)

Pure function over a community's contributions (`backend/mesh_api/presence.py`).

For each contribution with weight `w` and age `t` days:

```
decay   d = exp(-t / TAU)        # TAU = 90d  → half-life ≈ 62 days
score   s = w · d
R       = Σ s
involvement = round(100 · (1 - exp(-R / K)))   # K = 15; saturating 0..100, standalone per community
delta       = involvement − involvement(all ages + 30d)   # honest month-over-month
modeMix[m]  = (Σ s for mode m) / R             # "mostly builder, no leadership"
energy      = humming | warming | steady | cooling | quiet   # from recency + delta
```

- **Involvement** is the raw 0..100 number; **Presence** is the whole bundle
  (involvement + delta + modeMix + energy). Intrinsic, not comparative.
- Decay is the "cooling" model made real: stop showing up, presence fades.
- Knobs `TAU` (fade half-life) and `K` (what a "strong" community scores) are
  tunable; they only bite once there's real log data.

---

## LLM layer (optional autofill)

Not a separate frontend — one contribution form whose `mode`/`weight` fields the
LLM pre-fills from your free text, behind a user-facing on/off toggle.

- **Architecture:** LLM at the edges, deterministic math at the core. One
  `POST /contributions/classify {text, eventContext?}` returns `{mode, weight,
  rationale}`; `create`/`update` stay deterministic value-stores. Zero LLM at
  read/render time.
- **Flow:** type free text → on blur the backend classifies → mode chip lights
  up, magnitude fills, one-line "why" shows → you confirm/override → save
  (`source: 'user'` when you touch it, so the LLM never re-overwrites your call).
- **Full context:** when a contribution is logged from an event, the classify
  call gets the event's who/what/where/when/why — that's the point of the Event
  object.
- **Degrades:** slow/failed/no-key → the chip stays for you to pick, the entry
  still saves. The LLM is never load-bearing.
- **Model/cost:** Claude Haiku 4.5, ~$0.001/contribution; the toggle is the kill
  switch (off = pure manual, $0).
- **Weight is abstracted** to a 3-dot magnitude (· / ·· / ···), never shown as a
  raw number — keeps presence from reading like a gameable score.

---

## Decisions locked

- Event + Contribution are **separate, linked** objects (not merged).
- Feed events **lazy-materialize** on first annotation.
- **One** Event table, `source` discriminator.
- Recurring: **`series_uid` groups, annotate per occurrence.**
- Event delete → contributions **orphaned** (`SET NULL` + label tombstone), never deleted.
- Presence is **per-community and intrinsic** — no cross-community ranking.
- The term is **Presence**; the raw number stays `involvement`.

## Build status

- ✅ Contribution model + CRUD, Presence computation + endpoint (`/communities/:id/presence`).
- ⏳ (this slice) Contribution ↔ Event link: `event_id`, `source_event_label`, orphan states, event-delete orphaning.
- ⛔ Not yet: the Event two-layer rework + iCal materialization/annotation; the LLM classify endpoint; all frontend (contribution log UI, presence readout, autofill).
