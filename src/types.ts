export type Tone = 'coral' | 'salmon' | 'sky' | 'navy';
export type ParseState = 'ok' | 'stale';
export type EventTone = 'warm' | 'cool';

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
}

/** A single dated thing on the calendar. */
export interface CalEvent {
  t: string;
  n: string;
  tone: EventTone;
}
