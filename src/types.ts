export type Tone = 'coral' | 'salmon' | 'sky' | 'navy';
export type ParseState = 'ok' | 'stale';
export type EventTone = 'warm' | 'cool';

/** A localized surface dent (contact/impact), keyed per neighbor or wall. */
export interface Dent { angle: number; depth: number; dvel: number; target: number; slow: number; }
/** A pre-contact surface lean toward a near neighbor. */
export interface Reach { angle: number; amt: number; target: number; }

/**
 * A community's runtime physics/render state. Runtime-only — NEVER serialized:
 * the API never sends it, the client attaches one on ingest, and it's stripped
 * from anything sent back. The engine owns and mutates it in place every frame.
 */
export interface Blob {
  x: number; y: number;
  vx: number; vy: number;
  px: number; py: number;          // previous position (for dragged-velocity)
  r: number;                       // derived from involvement
  phase: number;
  dents: Record<string, Dent>;
  reach: Record<string, Reach>;
  wobA: number; wobV: number; wobAng: number;
  tex: WebGLTexture | HTMLCanvasElement | null;   // baked from name + tone
}

/** A community you belong to — the single source of truth shared by every view. */
export interface Community {
  id: string;
  name: string;
  tone: Tone;
  parse: string;
  parseState: ParseState;
  involvement: number;
  delta: number;
  tenure: string;
  energy: string;
  lastArtifact: string;
  nextGathering: string;
  note: string;
  blob: Blob | null;               // runtime only, never serialized (see Blob)
}

/** The serialized shape the API sends/receives — a Community without its blob. */
export type CommunityData = Omit<Community, 'blob'>;

/** A single dated thing on the calendar, as stored by the API.
 *  Two layers (see docs/presence-model.md): the source fields (date/time/name/
 *  location) come from where it was born — typed in mesh or mirrored from the
 *  iCal feed — and `note`/`communities` are the mesh annotation layer. */
export interface CalEvent {
  id: number;
  source: 'mesh' | 'ical';
  uid: string | null;
  seriesUid: string | null;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM ('' = all-day)
  name: string;
  location: string | null;
  sourceDescription: string | null;
  note: string | null;              // mesh layer: the real who/why
  communities: string[];            // community ids this event is tagged with (empty = untagged)
}

/** Fields needed to create a new (mesh-native) event. */
export interface NewEvent {
  date: string;
  time: string;
  name: string;
  note?: string;
  communities?: string[];
}

/** The five contribution modes (kinds of involvement). */
export type Mode = 'built' | 'organized' | 'served' | 'led' | 'connected';

/** A dated thing you did for a community — the atom of presence. */
export interface Contribution {
  id: number;
  communityId: string;
  date: string;              // YYYY-MM-DD
  text: string;
  mode: Mode;
  weight: number;            // 1..10 (shown abstracted as magnitude dots)
  eventId: number | null;
  sourceEventLabel: string | null;  // snapshot kept even if the event is deleted
  orphaned: boolean;         // event_id null but label set → its event was deleted
}

/** Fields to create/update a contribution. */
export interface ContributionInput {
  date: string;
  text: string;
  mode?: Mode;
  weight?: number;
  eventId?: number;
  sourceEventLabel?: string;
}

/** The derived read on a community, computed only from its contributions. */
export interface Presence {
  involvement: number;                 // 0..100, saturating
  delta: number;                       // vs. a month ago
  modeMix: Record<Mode, number>;       // each mode's % share
  energy: string;                      // humming | warming | steady | cooling | quiet
  contributionCount: number;
  lastContribution: string | null;
}

/** The LLM's suggested classification for a contribution's free text. */
export interface ClassifySuggestion {
  mode: Mode;
  weight: number;
  rationale: string;
}
