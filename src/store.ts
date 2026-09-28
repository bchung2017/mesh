import type { Community, CommunityData } from './types';
import type { FieldHandle } from './field/blobField';

/**
 * Reconcile incoming API data into the shared `Community[]` store, in place.
 * Fields flow one way: existing communities get their fields overwritten (minus
 * `blob`, which the API never sends, so it survives); new ids are attached;
 * ids the API no longer returns are detached (freeing their texture); and a
 * changed involvement or tone triggers a rebake. The engine mutates each
 * community's `blob`; nothing here clones or replaces the array.
 */
export function reconcile(store: Community[], incoming: CommunityData[], field: FieldHandle): void {
  const byId = new Map(store.map((c) => [c.id, c]));
  const incomingIds = new Set(incoming.map((c) => c.id));

  // drop communities the API no longer returns (free the GPU texture first)
  for (let i = store.length - 1; i >= 0; i--) {
    if (!incomingIds.has(store[i].id)) {
      field.detach(store[i]);
      store.splice(i, 1);
    }
  }

  for (const inc of incoming) {
    const existing = byId.get(inc.id);
    if (!existing) {
      store.push({ ...inc, blob: null });          // new: attached below, once the array is settled
    } else {
      const changed = existing.involvement !== inc.involvement || existing.tone !== inc.tone;
      Object.assign(existing, inc);                 // inc has no `blob` key, so the live blob is preserved
      if (changed) field.rebake(existing);
    }
  }

  // attach any community still without a blob (the new ones), now that indices are final
  for (const c of store) if (!c.blob) field.attach(c);
}

/**
 * Apply one created/updated community into the store in place. If it exists,
 * its fields are overwritten (minus `blob`, which survives) and it rebakes when
 * involvement or tone changed; otherwise it's added and a blob is attached.
 * Returns the live Community in the store.
 */
export function applyUpsert(store: Community[], data: CommunityData, field: FieldHandle): Community {
  const existing = store.find((c) => c.id === data.id);
  if (existing) {
    const changed = existing.involvement !== data.involvement || existing.tone !== data.tone;
    Object.assign(existing, data);
    if (changed) field.rebake(existing);
    return existing;
  }
  const created: Community = { ...data, blob: null };
  store.push(created);
  field.attach(created);
  return created;
}

/** Remove one community from the store in place, freeing its blob's texture. */
export function applyRemove(store: Community[], id: string, field: FieldHandle): void {
  const i = store.findIndex((c) => c.id === id);
  if (i < 0) return;
  field.detach(store[i]);
  store.splice(i, 1);
}
