import type { CalEvent, EventTone } from '../types';
import { byId } from '../dom';
import { getEvents, createEvent, deleteEvent } from '../api';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Boot the month calendar with its dynamically-placed day modal. The grid and
 *  all controls render immediately; events are loaded from (and persisted to)
 *  the API in the background, so the calendar works even if that load fails. */
export function initCalendar(): void {
  const key = (d: Date) => d.toISOString().slice(0, 10);
  const GAP = 8;          // breathing room between modal and selected row
  const MIN_H = 210;      // below this a region can't host the panel usefully

  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let view = new Date(now.getFullYear(), now.getMonth(), 1);
  let selected: Date | null = null;
  let tone: EventTone = 'warm';

  // events, keyed by YYYY-MM-DD, hydrated from the API in the background (below)
  const events: Record<string, CalEvent[]> = {};
  function ingest(list: CalEvent[]): void {
    for (const k in events) delete events[k];
    for (const ev of list) (events[ev.date] ??= []).push(ev);
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
    let warm = 0;
    for (const k in events) {
      const d = new Date(k + 'T00:00');
      if (d.getFullYear() === view.getFullYear() && d.getMonth() === view.getMonth())
        warm += events[k].filter((e) => e.tone === 'warm').length;
    }
    return warm;
  }

  function render(): void {
    monthName.textContent = MONTHS[view.getMonth()] + ' ' + view.getFullYear();
    // only own the subline while the calendar tab is showing (the tab bar owns
    // the home copy otherwise, and this render can resolve after tab setup)
    if (calTab.classList.contains('on')) {
      const warm = monthEventCount();
      subline.textContent = warm === 0 ? 'a quiet month so far'
        : warm === 1 ? '1 gathering this month'
        : warm + ' gatherings this month';
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
      if (evs.length) {
        const pips = document.createElement('div');
        pips.className = 'pips';
        evs.slice(0, 4).forEach((e) => {
          const p = document.createElement('span');
          p.className = 'pip ' + e.tone;
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

  function renderPanel(): void {
    if (!selected) return;
    panelDate.textContent = fmtDay(selected);
    const evs = (events[key(selected)] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
    panelCount.textContent = evs.length === 0 ? '' : evs.length === 1 ? '1 thing' : evs.length + ' things';
    eventList.innerHTML = '';

    if (!evs.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'nothing here yet — a free day is a fine thing';
      eventList.appendChild(e);
      return;
    }
    evs.forEach((ev) => {
      const row = document.createElement('div');
      row.className = 'event ' + ev.tone;
      row.innerHTML =
        '<span class="time">' + ev.time + '</span>' +
        '<span class="name"></span>' +
        '<button class="x" aria-label="remove">&#215;</button>';
      row.querySelector('.name')!.textContent = ev.name;
      row.querySelector('.x')!.addEventListener('click', (e) => {
        e.stopPropagation();
        removeEvent(ev);
      });
      eventList.appendChild(row);
    });
  }

  function removeEvent(ev: CalEvent): void {
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
      const created = await createEvent({ date: k, time: t, name: n, tone });
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

  document.querySelectorAll('.tone-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      tone = (chip as HTMLElement).dataset.tone as EventTone;
      document.querySelectorAll('.tone-chip').forEach((c) =>
        c.classList.toggle('on', c === chip));
    });
  });

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
  });
  byId('nextBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    closeModal();
  });
  byId('todayBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    view = new Date(now.getFullYear(), now.getMonth(), 1);
    selected = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    render(); openModal();
  });

  render();

  // hydrate events in the background; the calendar is already interactive
  getEvents()
    .then((list) => {
      ingest(list);
      render();
      if (selected && modal.classList.contains('open')) { renderPanel(); placeModal(); }
    })
    .catch((err) => console.error('mesh: could not load events', err));
}
