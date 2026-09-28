import type { CommunityData, CalEvent, NewEvent } from './types';

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

export async function deleteEvent(id: number): Promise<void> {
  const res = await fetch(`${BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`mesh api ${res.status} deleting event ${id}`);
}
