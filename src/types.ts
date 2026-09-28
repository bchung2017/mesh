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

/** A single dated thing on the calendar, as stored by the API. */
export interface CalEvent {
  id: number;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM
  name: string;
  tone: EventTone;
  communities: string[];   // community ids this event is tagged with (empty = untagged)
}

/** Fields needed to create a new event (the server assigns id; tags optional). */
export type NewEvent = Omit<CalEvent, 'id' | 'communities'> & { communities?: string[] };
