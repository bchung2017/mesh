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

/** A 409 from create: an exact duplicate ('exact', hard) or a conceptually
 *  similar name ('similar', bypass with force). Carries the matched community. */
export interface CreateConflict extends Error {
  conflict: true;
  kind?: 'exact' | 'similar';
  suggestion?: { id: string; name: string; score?: number };
}

/** Create a community. The server generates the id + ordering. On a duplicate or
 *  a conceptually-similar name it rejects (409) with a suggestion; pass
 *  force=true to create despite a 'similar' warning. */
export async function createCommunity(patch: Partial<CommunityData> & { name: string }, force = false): Promise<CommunityData> {
  const res = await fetch(`${BASE}/communities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(force ? { ...patch, force: true } : patch),
  });
  if (res.status === 409) {
    let body: { error?: string; kind?: 'exact' | 'similar'; suggestion?: { id: string; name: string; score?: number } } = {};
    try { body = await res.json(); } catch { /* ignore */ }
    const e = new Error(body.error || 'that community already exists') as CreateConflict;
    e.conflict = true; e.kind = body.kind; e.suggestion = body.suggestion;
    throw e;
  }
  return asJson<CommunityData>(res);
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

/** A background sync job (the Sync button runs the agent as one of these). */
export interface SyncJob {
  id: number;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  kind: 'recent' | 'deep' | null;
  percent: number;
  stepsDone: number;
  stepsTotal: number;
  changes: number;
  summary: string | null;
  error: string | null;
  updatedAt: string | null;
}

/** Start an agent sync. Resolves {ok, status, job?} — status 503 means the agent
 *  isn't enabled on the server. The run continues server-side; poll getSyncJob. */
export async function startSync(instruction: string, kind: 'recent' | 'deep'): Promise<{ ok: boolean; status: number; job?: SyncJob }> {
  const res = await fetch(`${BASE}/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, kind }),
  });
  if (res.ok) return { ok: true, status: res.status, job: (await res.json()) as SyncJob };
  return { ok: false, status: res.status };
}

/** Advance a sync job by one step (one model call + its tools). The frontend
 *  calls this in a loop to drive the run — each is a short request, with a
 *  client-side timeout so a stuck step can't hang the loop. */
export function stepSyncJob(id: number, timeoutMs = 90000): Promise<SyncJob> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(`${BASE}/agent/jobs/${id}/step`, { method: 'POST', signal: ctrl.signal })
    .then((r) => asJson<SyncJob>(r))
    .finally(() => window.clearTimeout(t));
}

/** The current running sync job, if any (to resume the progress bar on reload). */
export function getActiveSyncJob(): Promise<SyncJob | null> {
  return fetch(`${BASE}/agent/job`).then((r) => asJson<{ active: SyncJob | null }>(r)).then((d) => d.active);
}

export function cancelSyncJob(id: number): Promise<SyncJob> {
  return fetch(`${BASE}/agent/jobs/${id}/cancel`, { method: 'POST' }).then((r) => asJson<SyncJob>(r));
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
