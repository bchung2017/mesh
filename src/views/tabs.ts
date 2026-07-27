import { byId } from '../dom';

interface TabDef { btn: string; view: string; }

const TABS: TabDef[] = [
  { btn: 'tab-btn-field', view: 'tab-field' },
  { btn: 'tab-btn-blobs', view: 'tab-blobs' },
  { btn: 'tab-btn-cal',   view: 'tab-cal' },
];
const HOME_SUB = 'Sunday, July 20 — 4 communities, 2 humming';

/** Wire the top tab bar. Returns `show(viewId)` so other views can switch tabs. */
export function initTabs(): { show: (id: string) => void } {
  const sub = byId('subline');

  function show(id: string): void {
    TABS.forEach((t) => {
      const on = t.view === id;
      byId(t.view).classList.toggle('on', on);
      const btn = byId(t.btn);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', String(on));
    });
    if (id !== 'tab-cal') { sub.textContent = HOME_SUB; }
    window.dispatchEvent(new Event('resize'));
  }

  TABS.forEach((t) =>
    byId(t.btn).addEventListener('click', () => show(t.view)));
  sub.textContent = HOME_SUB;

  return { show };
}
