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
