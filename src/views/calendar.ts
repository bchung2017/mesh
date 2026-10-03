import type { CalEvent, Community } from '../types';
import { byId } from '../dom';
import { TONE_HEX } from '../field/palette';
import { getEvents, createEvent, updateEvent, deleteEvent, materializeEvent, getFeedEvents, type FeedEvent } from '../api';
import { buildContribForm } from './contrib';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NULL_COLOR = '#cfd6e4';   // untagged / zero-involvement: neutral "null" color

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
/** Mix `base` toward `grey` by t (t=1 → base, t=0 → grey). */
function mixToward(base: string, grey: string, t: number): string {
  const a = hexToRgb(base), b = hexToRgb(grey);
  const k = Math.max(0, Math.min(1, t));
  const c = a.map((v, i) => Math.round(v * k + b[i] * (1 - k)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Boot the month calendar with its dynamically-placed day modal. The grid and
 *  all controls render immediately; events are loaded from (and persisted to)
 *  the API in the background, so the calendar works even if that load fails.
 *  `communities` (the shared store) drives event tag colors + the tag picker. */
export function initCalendar(communities: Community[]): { refresh: () => void } {
  const key = (d: Date) => d.toISOString().slice(0, 10);
  const GAP = 8;          // breathing room between modal and selected row
  const MIN_H = 210;      // below this a region can't host the panel usefully

  // an event's color = its (first) tagged community's tone, its SATURATION set
  // by that community's involvement (more involved → more vibrant; less → faded
  // toward the null grey). Untagged events are the null color.
  const colorForTags = (ids: string[]): string => {
    const id = ids[0];
    const c = id ? communities.find((x) => x.id === id) : undefined;
    if (!c) return NULL_COLOR;
    return mixToward(TONE_HEX[c.tone], NULL_COLOR, c.involvement / 100);
  };

  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let view = new Date(now.getFullYear(), now.getMonth(), 1);
  let selected: Date | null = null;

  // events, keyed by YYYY-MM-DD, hydrated from the API in the background (below)
  const events: Record<string, CalEvent[]> = {};
  function ingest(list: CalEvent[]): void {
    for (const k in events) delete events[k];
    for (const ev of list) (events[ev.date] ??= []).push(ev);
  }

  // read-only events mirrored from the subscribed external calendar, keyed the
  // same way as the day cells so lookups line up
  const feedEvents: Record<string, FeedEvent[]> = {};
  function monthBounds(): [string, string] {
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [
      fmt(new Date(view.getFullYear(), view.getMonth(), 1)),
      fmt(new Date(view.getFullYear(), view.getMonth() + 1, 1)),
    ];
  }
  function loadFeed(force = false): Promise<void> {
    const [timeMin, timeMax] = monthBounds();
    return getFeedEvents(timeMin, timeMax, force)
      .then(({ events: feed }) => {
        for (const k in feedEvents) delete feedEvents[k];
        for (const fe of feed) (feedEvents[key(new Date(fe.date + 'T00:00'))] ??= []).push(fe);
        render();
        if (selected && modal.classList.contains('open')) { renderPanel(); placeModal(); }
      })
      .catch((err) => console.error('mesh: could not load calendar feed', err));
  }

  const card = byId('calCard');
  const grid = byId('grid');
  const dowRow = byId('dowRow');
  const modal = byId('dayModal');
  const monthName = byId('monthName');
  const calTab = byId('tab-cal');
  const subline = byId('subline');
  const panelDate = byId('panelDate');
  const panelCount = byId('panelCount');
  const eventList = byId('eventList');

  function fmtDay(d: Date): string {
    if (d.getTime() === today0.getTime()) return 'today';
    const tmr = new Date(today0); tmr.setDate(tmr.getDate() + 1);
    if (d.getTime() === tmr.getTime()) return 'tomorrow';
    return MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate();
  }

  function monthEventCount(): number {
    let n = 0;
    for (const k in events) {
      const d = new Date(k + 'T00:00');
      if (d.getFullYear() === view.getFullYear() && d.getMonth() === view.getMonth())
        n += events[k].length;
    }
    return n;
  }

  function render(): void {
    monthName.textContent = MONTHS[view.getMonth()] + ' ' + view.getFullYear();
    // only own the subline while the calendar tab is showing (the tab bar owns
    // the home copy otherwise, and this render can resolve after tab setup)
    if (calTab.classList.contains('on')) {
      const n = monthEventCount();
      subline.textContent = n === 0 ? 'a quiet month so far'
        : n === 1 ? '1 event this month'
        : n + ' events this month';
    }

    grid.innerHTML = '';
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7; // monday start
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();

    for (let i = 0; i < lead; i++) {
      const b = document.createElement('div');
      b.className = 'day blank';
      grid.appendChild(b);
    }
    for (let d = 1; d <= days; d++) {
      const date = new Date(view.getFullYear(), view.getMonth(), d);
      const cell = document.createElement('button');
      cell.className = 'day';
      cell.dataset.time = String(date.getTime());
      if (date.getTime() === today0.getTime()) cell.classList.add('today');
      if (selected && date.getTime() === selected.getTime()) cell.classList.add('selected');

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(d);
      cell.appendChild(num);

      if (cell.classList.contains('today')) {
        const dot = document.createElement('span');
        dot.className = 'today-dot';
        cell.appendChild(dot);
      }

      const evs = events[key(date)] || [];
      const feed = feedEvents[key(date)] || [];
      if (evs.length || feed.length) {
        const pips = document.createElement('div');
        pips.className = 'pips';
        const meshShown = Math.min(evs.length, 4);
        evs.slice(0, meshShown).forEach((e) => {
          const p = document.createElement('span');
          p.className = 'pip';
          p.style.background = colorForTags(e.communities);   // tagged → community tone, untagged → null color
          pips.appendChild(p);
        });
        feed.slice(0, Math.max(0, 5 - meshShown)).forEach(() => {
          const p = document.createElement('span');
          p.className = 'pip feed';
          pips.appendChild(p);
        });
        cell.appendChild(pips);
      }

      cell.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selected = date;
        render();
        openModal();
      });
      grid.appendChild(cell);
    }
  }

  /* ---- dynamic placement ----
     Rectangular regions only: the row-band above the selected row, or the
     row-band below it. Each is scored by the time-value of what it hides:
       past day  -> 0      (peripheral past is worthless, cover freely)
       today     -> 1000   (never bury the coral dot)
       future    -> 1/(1+daysAhead)  (tomorrow is precious, day 20 is cheap)
     Lowest total cost wins among regions tall enough to host the panel.
     Third condition, applied after feasibility and time-cost: within the
     winning band, the modal hugs the selected row — no dead space between
     the selection and the panel. */
  interface Row { top: number; bottom: number; cells: Element[]; }
  function rowGeometry(): Row[] {
    const cardTop = card.getBoundingClientRect().top;
    const rows: Row[] = [];
    for (const cell of Array.from(grid.children)) {
      const r = cell.getBoundingClientRect();
      const top = r.top - cardTop;
      let row = rows.find((x) => Math.abs(x.top - top) < 4);
      if (!row) { row = { top, bottom: r.bottom - cardTop, cells: [] }; rows.push(row); }
      row.bottom = Math.max(row.bottom, r.bottom - cardTop);
      row.cells.push(cell);
    }
    rows.sort((a, b) => a.top - b.top);
    return rows;
  }

  function dayCost(cell: Element): number {
    const time = (cell as HTMLElement).dataset.time;
    if (!time) return 0;                    // blank leaders are free
    const t = +time;
    if (t === today0.getTime()) return 1000;
    if (t < today0.getTime()) return 0;
    const ahead = Math.round((t - today0.getTime()) / 86400000);
    return 1 / (1 + ahead);
  }

  function regionCost(rows: Row[]): number {
    return rows.reduce((s, r) => s + r.cells.reduce((c, el) => c + dayCost(el), 0), 0);
  }

  function placeModal(): void {
    const selCell = grid.querySelector('.day.selected');
    if (!selCell) return;
    // on mobile the modal is a bottom sheet positioned by CSS — clear any
    // desktop inline geometry and let the media query take over
    if (window.matchMedia('(max-width: 600px)').matches) {
      modal.style.cssText = '';
      return;
    }
    const cardRect = card.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const rows = rowGeometry();
    const selRowIdx = rows.findIndex((r) => r.cells.includes(selCell));

    // measure natural height at grid width
    modal.style.width = gridRect.width + 'px';
    modal.style.left = (gridRect.left - cardRect.left) + 'px';
    modal.style.height = 'auto';
    modal.style.visibility = 'hidden';
    modal.style.display = 'block';
    const needed = modal.offsetHeight;

    const aboveRows = rows.slice(0, selRowIdx);
    const belowRows = rows.slice(selRowIdx + 1);

    const aboveTop = dowRow.getBoundingClientRect().top - cardRect.top;  // dow labels are coverable
    const aboveH = rows[selRowIdx].top - GAP - aboveTop;
    const belowTop = rows[selRowIdx].bottom + GAP;
    const belowH = (gridRect.bottom - cardRect.top) - belowTop;

    const regions = [
      { name: 'above', h: aboveH, cost: regionCost(aboveRows), top: aboveTop, anchor: 'bottom' },
      { name: 'below', h: belowH, cost: regionCost(belowRows), top: belowTop, anchor: 'top' },
    ].filter((r) => r.h > 40);

    let pick = regions.filter((r) => r.h >= Math.min(needed, MIN_H))
                      .sort((a, b) => a.cost - b.cost)[0];
    if (!pick) pick = regions.sort((a, b) => b.h - a.h)[0];   // nowhere fits: take the taller band, scroll inside
    if (!pick) { modal.style.display = 'none'; modal.style.visibility = ''; return; }

    const h = Math.min(needed, pick.h);
    modal.style.height = h + 'px';
    // hug the selection: above-band grows upward from selRow, below-band grows downward
    modal.style.top = (pick.anchor === 'bottom' ? pick.top + pick.h - h : pick.top) + 'px';
    modal.style.visibility = '';
  }

  function openModal(): void {
    renderPanel();
    modal.classList.remove('open');
    placeModal();
    void modal.offsetWidth;   // restart settle animation
    modal.classList.add('open');
    byId<HTMLInputElement>('evName').focus();
  }

  function closeModal(): void {
    modal.classList.remove('open');
    modal.style.display = 'none';
    selected = null;
    render();
  }

  // A uniform annotation view over both event kinds. The source fields are
  // read-only for feed events; the mesh layer (note + tags) is editable on both.
  // A feed event has no mesh id until it's materialized — which happens lazily
  // the first time you annotate or log from it (ensureId below).
  interface Annotatable {
    kind: 'mesh' | 'feed';
    id: number | null;            // mesh event id; null for an un-materialized feed occurrence
    date: string; time: string; name: string;
    location: string | null;
    note: string | null;
    communities: string[];
    raw: CalEvent | FeedEvent;    // the live object in the store/feed (we write back to it)
  }

  function asAnnotatable(ev: CalEvent): Annotatable {
    return { kind: 'mesh', id: ev.id, date: ev.date, time: ev.time, name: ev.name,
      location: ev.location, note: ev.note, communities: ev.communities, raw: ev };
  }
  function feedAnnotatable(fe: FeedEvent): Annotatable {
    return { kind: 'feed', id: fe.meshId ?? null, date: fe.date, time: fe.time, name: fe.name,
      location: fe.location, note: fe.note ?? null, communities: fe.communities ?? [], raw: fe };
  }

  // write the mesh layer back onto the underlying store/feed object so it
  // survives re-renders within the session
  function writeBack(a: Annotatable): void {
    if (a.kind === 'mesh') {
      const ev = a.raw as CalEvent; ev.communities = a.communities; ev.note = a.note;
    } else {
      const fe = a.raw as FeedEvent; fe.communities = a.communities; fe.note = a.note;
      if (a.id != null) fe.meshId = a.id;
    }
  }

  // ensure the occurrence is a persisted row and hand back its id (materializing
  // a feed occurrence on first write — idempotent on the server by uid)
  function ensureId(a: Annotatable): Promise<number> {
    if (a.id != null) return Promise.resolve(a.id);
    const fe = a.raw as FeedEvent;
    return materializeEvent({
      uid: fe.uid, seriesUid: fe.seriesUid, date: fe.date, time: fe.time,
      name: fe.name, location: fe.location, description: fe.description,
    }).then((ev) => { a.id = ev.id; fe.meshId = ev.id; return ev.id; });
  }

  // who/what/where/when, for the LLM when logging from this event
  const contextOf = (a: Annotatable): string =>
    [a.name, a.date + (a.time ? ' ' + a.time : ''), a.location ? 'at ' + a.location : '']
      .filter(Boolean).join(' · ');

  function renderPanel(): void {
    if (!selected) return;
    panelDate.textContent = fmtDay(selected);
    const evs = (events[key(selected)] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
    const feed = (feedEvents[key(selected)] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
    const total = evs.length + feed.length;
    panelCount.textContent = total === 0 ? '' : total === 1 ? '1 thing' : total + ' things';
    eventList.innerHTML = '';

    if (!total) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'nothing here yet — a free day is a fine thing';
      eventList.appendChild(e);
      return;
    }
    evs.forEach((ev) => eventList.appendChild(eventBlock(asAnnotatable(ev))));
    feed.forEach((fe) => eventList.appendChild(eventBlock(feedAnnotatable(fe))));
  }

  function eventBlock(a: Annotatable): HTMLElement {
    const block = document.createElement('div');
    block.className = 'event-block' + (a.kind === 'feed' ? ' feed-block' : '');

    const row = document.createElement('div');
    row.className = 'event' + (a.kind === 'feed' ? ' feed' : '');
    row.style.borderLeft = '3px solid ' + colorForTags(a.communities);
    row.innerHTML =
      '<span class="time"></span><span class="name"></span>' +
      (a.kind === 'mesh' ? '<button class="x" aria-label="remove">&#215;</button>'
                         : '<span class="feed-tag">calendar</span>');
    (row.querySelector('.time') as HTMLElement).textContent = a.time || 'all day';
    (row.querySelector('.name') as HTMLElement).textContent = a.name;
    if (a.kind === 'mesh') {
      row.querySelector('.x')!.addEventListener('click', (e) => { e.stopPropagation(); removeMeshEvent(a.raw as CalEvent); });
    }
    block.appendChild(row);

    // community tags (both kinds)
    if (communities.length) {
      const tags = document.createElement('div');
      tags.className = 'event-tags';
      communities.forEach((c) => {
        const on = a.communities.includes(c.id);
        const chip = document.createElement('button');
        chip.className = 'tagchip' + (on ? ' on' : '');
        chip.textContent = c.name;
        if (on) { chip.style.background = TONE_HEX[c.tone]; chip.style.color = '#fff'; }
        chip.addEventListener('click', (e) => { e.stopPropagation(); toggleTag(a, c.id); });
        tags.appendChild(chip);
      });
      block.appendChild(tags);
    }

    // mesh-layer note (both kinds): the real who/why, and the LLM's best context
    const noteWrap = document.createElement('div');
    noteWrap.className = 'event-note';
    const ta = document.createElement('textarea');
    ta.rows = 1; ta.maxLength = 500;
    ta.placeholder = 'note — who you met, why it mattered';
    ta.value = a.note || '';
    ta.addEventListener('click', (e) => e.stopPropagation());
    ta.addEventListener('blur', () => saveNote(a, ta.value.trim()));
    noteWrap.appendChild(ta);
    block.appendChild(noteWrap);

    // the "log a contribution" door — one button per tagged community (tag first,
    // then log what you did for that community from this event)
    const log = document.createElement('div');
    log.className = 'event-log';
    if (!a.communities.length) {
      log.innerHTML = '<span class="log-hint">tag a community to log a contribution from this</span>';
    } else {
      const lbl = document.createElement('span'); lbl.className = 'log-lbl'; lbl.textContent = 'log →';
      log.appendChild(lbl);
      a.communities.forEach((cid) => {
        const c = communities.find((x) => x.id === cid); if (!c) return;
        const b = document.createElement('button');
        b.className = 'log-chip'; b.textContent = c.name;
        b.addEventListener('click', (e) => { e.stopPropagation(); openEventLogger(a, cid, block); });
        log.appendChild(b);
      });
    }
    block.appendChild(log);
    return block;
  }

  function removeMeshEvent(ev: CalEvent): void {
    // optimistic: drop it locally, then tell the server
    const k = ev.date;
    const arr = events[k];
    if (arr) {
      arr.splice(arr.indexOf(ev), 1);
      if (!arr.length) delete events[k];
    }
    render(); renderPanel(); placeModal();
    deleteEvent(ev.id).catch((err) => console.error('mesh: failed to delete event', err));
  }

  function toggleTag(a: Annotatable, communityId: string): void {
    a.communities = a.communities.includes(communityId)
      ? a.communities.filter((x) => x !== communityId)
      : [...a.communities, communityId];
    writeBack(a);
    // re-render the panel (tags + log door) and the month pips; state lives on raw
    renderPanel(); render(); placeModal();
    ensureId(a)
      .then((id) => updateEvent(id, { communities: a.communities }))
      .catch((err) => console.error('mesh: failed to update tags', err));
  }

  function saveNote(a: Annotatable, note: string): void {
    if ((a.note || '') === note) return;
    a.note = note || null;
    writeBack(a);
    ensureId(a)
      .then((id) => updateEvent(id, { note }))
      .catch((err) => console.error('mesh: failed to save note', err));
  }

  function openEventLogger(a: Annotatable, communityId: string, block: HTMLElement): void {
    block.querySelector('.contrib-form')?.remove();
    ensureId(a)
      .then((id) => {
        if (block.querySelector('.contrib-form')) return;   // double-click guard
        const form = buildContribForm({
          communityId, eventId: id, eventContext: contextOf(a), defaultDate: a.date,
          onSaved: () => {
            form.remove();
            const ok = document.createElement('div');
            ok.className = 'logged-flash'; ok.textContent = 'logged ✓';
            block.appendChild(ok);
            setTimeout(() => ok.remove(), 1800);
            placeModal();
          },
          onCancel: () => { form.remove(); placeModal(); },
        });
        form.addEventListener('click', (e) => e.stopPropagation());
        block.appendChild(form);
        (form.querySelector('[name="text"]') as HTMLTextAreaElement).focus();
        placeModal();
      })
      .catch((err) => console.error('mesh: could not open logger', err));
  }

  byId('addBtn').addEventListener('click', addEvent);
  byId('evName').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') addEvent();
  });
  async function addEvent(): Promise<void> {
    if (!selected) return;
    const nameEl = byId<HTMLInputElement>('evName');
    const n = nameEl.value.trim();
    if (!n) { nameEl.focus(); return; }
    const t = byId<HTMLInputElement>('evTime').value || '18:00';
    const k = key(selected);
    const btn = byId<HTMLButtonElement>('addBtn');
    btn.disabled = true;
    try {
      const created = await createEvent({ date: k, time: t, name: n });
      (events[k] ??= []).push(created);
      nameEl.value = '';
      render(); renderPanel(); placeModal();
    } catch (err) {
      console.error('mesh: failed to add event', err);
    } finally {
      btn.disabled = false;
      nameEl.focus();
    }
  }

  modal.addEventListener('click', (e) => e.stopPropagation());
  byId('closeBtn').addEventListener('click', closeModal);
  document.addEventListener('click', (e) => {
    if (modal.classList.contains('open') && !(e.target as HTMLElement).closest('.day')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && modal.classList.contains('open')) closeModal();
  });
  window.addEventListener('resize', () => {
    if (modal.classList.contains('open')) placeModal();
  });

  byId('prevBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
    closeModal();
    loadFeed();
  });
  byId('nextBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    closeModal();
    loadFeed();
  });
  byId('todayBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const changedMonth = view.getFullYear() !== now.getFullYear() || view.getMonth() !== now.getMonth();
    view = new Date(now.getFullYear(), now.getMonth(), 1);
    selected = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    render(); openModal();
    if (changedMonth) loadFeed();
  });

  // manual force-refresh: revalidate communities (fires main's focus handler)
  // and re-pull the calendar feed bypassing the server cache
  byId('refreshBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = byId('refreshBtn');
    if (btn.classList.contains('spinning')) return;
    btn.classList.add('spinning');
    window.dispatchEvent(new Event('focus'));
    loadFeed(true).finally(() => btn.classList.remove('spinning'));
  });

  render();

  // hydrate own events + the subscribed feed in the background; the calendar is
  // already interactive
  getEvents()
    .then((list) => {
      ingest(list);
      render();
      if (selected && modal.classList.contains('open')) { renderPanel(); placeModal(); }
    })
    .catch((err) => console.error('mesh: could not load events', err));
  loadFeed();

  // re-render when the shared community store changes (loaded/edited elsewhere)
  // so event colors reflect current tags + involvement-driven saturation
  function refresh(): void {
    render();
    if (selected && modal.classList.contains('open')) { renderPanel(); placeModal(); }
  }
  return { refresh };
}
