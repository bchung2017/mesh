/** Fetch an element by id, asserting it exists (all ids live in index.html). */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`mesh: missing element #${id}`);
  return el as T;
}
