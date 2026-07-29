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

/** A single dated thing on the calendar, as stored by the API. */
export interface CalEvent {
  id: number;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM
  name: string;
  tone: EventTone;
}

/** Fields needed to create a new event (the server assigns id). */
export type NewEvent = Omit<CalEvent, 'id'>;
