import type {
  CommunityData, CalEvent, NewEvent,
  Contribution, ContributionInput, Presence, ClassifySuggestion,
} from './types';

// All requests go to the Flask API. In dev, Vite proxies /api to the backend
// (see vite.config.ts); in production Flask serves this bundle and the API from
// the same origin, so a relative base works everywhere.
const BASE = '/api';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`mesh api ${res.status} ${res.statusText} ${detail}`.trim());
  }
  return res.json() as Promise<T>;
}

export function getCommunities(): Promise<CommunityData[]> {
  return fetch(`${BASE}/communities`).then((r) => asJson<CommunityData[]>(r));
}

/** Update a community's fields. The patch is CommunityData-shaped, so `blob`
 *  can't be sent; the server also ignores any unknown keys. */
export function updateCommunity(id: string, patch: Partial<CommunityData>): Promise<CommunityData> {
  return fetch(`${BASE}/communities/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => asJson<CommunityData>(r));
}

/** Create a community. The server generates the id + ordering. */
export function createCommunity(patch: Partial<CommunityData> & { name: string }): Promise<CommunityData> {
  return fetch(`${BASE}/communities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => asJson<CommunityData>(r));
}

/** Delete a community. */
export async function deleteCommunity(id: string): Promise<void> {
  const res = await fetch(`${BASE}/communities/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`mesh api ${res.status} deleting community ${id}`);
}

export function getEvents(): Promise<CalEvent[]> {
  return fetch(`${BASE}/events`).then((r) => asJson<CalEvent[]>(r));
}

export function createEvent(input: NewEvent): Promise<CalEvent> {
  return fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => asJson<CalEvent>(r));
}

/** Update an event's source fields (mesh-native only), note, and/or tags. */
export function updateEvent(id: number, patch: Partial<Pick<CalEvent, 'name' | 'time' | 'date' | 'note' | 'communities'>>): Promise<CalEvent> {
  return fetch(`${BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => asJson<CalEvent>(r));
}

/** Persist a feed occurrence so its mesh layer (note/tags) has a durable home.
 *  Idempotent on uid — returns the existing row if already materialized. */
export function materializeEvent(occ: {
  uid: string; seriesUid?: string | null; date: string; time?: string;
  name: string; location?: string | null; description?: string | null;
}): Promise<CalEvent> {
  return fetch(`${BASE}/events/materialize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(occ),
  }).then((r) => asJson<CalEvent>(r));
}

/** The own calendar events tagged with a community. */
export function getCommunityEvents(id: string): Promise<CalEvent[]> {
  return fetch(`${BASE}/communities/${encodeURIComponent(id)}/events`).then((r) => asJson<CalEvent[]>(r));
}

export async function deleteEvent(id: number): Promise<void> {
  const res = await fetch(`${BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`mesh api ${res.status} deleting event ${id}`);
}

/** An event mirrored from the subscribed external calendar. Carries the source
 *  fields plus, once it's been annotated (materialized), its mesh layer:
 *  `meshId` is the persisted event's id, and `note`/`communities` ride along. */
export interface FeedEvent {
  seriesUid: string;
  uid: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM, or '' for all-day
  allDay: boolean;
  name: string;
  location: string | null;
  description: string | null;
  // present only once materialized + annotated:
  meshId?: number;
  note?: string | null;
  communities?: string[];
}

/** Fetch subscribed-calendar events in [timeMin, timeMax) (YYYY-MM-DD).
 *  `fresh` bypasses the server's feed cache to re-pull from the source. */
export function getFeedEvents(timeMin: string, timeMax: string, fresh = false): Promise<{ configured: boolean; events: FeedEvent[] }> {
  const q = `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}${fresh ? '&fresh=1' : ''}`;
  return fetch(`${BASE}/ical/events${q}`).then((r) => asJson<{ configured: boolean; events: FeedEvent[] }>(r));
}

// ---------------- contributions + presence ----------------

/** The derived presence read for a community (computed from its log). */
export function getPresence(id: string): Promise<Presence> {
  return fetch(`${BASE}/communities/${encodeURIComponent(id)}/presence`).then((r) => asJson<Presence>(r));
}

/** A community's contribution log, newest first. */
export function getContributions(id: string): Promise<Contribution[]> {
  return fetch(`${BASE}/communities/${encodeURIComponent(id)}/contributions`).then((r) => asJson<Contribution[]>(r));
}

export function createContribution(id: string, input: ContributionInput): Promise<Contribution> {
  return fetch(`${BASE}/communities/${encodeURIComponent(id)}/contributions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => asJson<Contribution>(r));
}

export function updateContribution(cid: number, patch: Partial<ContributionInput>): Promise<Contribution> {
  return fetch(`${BASE}/contributions/${cid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => asJson<Contribution>(r));
}

export async function deleteContribution(cid: number): Promise<void> {
  const res = await fetch(`${BASE}/contributions/${cid}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`mesh api ${res.status} deleting contribution ${cid}`);
}

/** Ask the backend's optional LLM to classify free text into mode + weight.
 *  Resolves null when autofill isn't available (no key → 503, or any failure),
 *  so callers fall back to manual entry without a hard error. */
export async function classifyContribution(text: string, eventContext?: string): Promise<ClassifySuggestion | null> {
  try {
    const res = await fetch(`${BASE}/contributions/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, eventContext }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ClassifySuggestion;
  } catch {
    return null;
  }
}
