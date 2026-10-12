import type { Community, CommunityData, Tone, ParseState } from '../types';
import type { FieldHandle } from '../field/blobField';
import { byId } from '../dom';
import {
  createCommunity, updateCommunity, deleteCommunity, getCommunityEvents,
  getPresence, getContributions, deleteContribution,
  startSync, getSyncJob, getActiveSyncJob, cancelSyncJob, type SyncJob,
} from '../api';
import type { Contribution } from '../types';
import { applyUpsert, applyRemove } from '../store';
import { renderPresence, buildContribForm, magnitudeDots } from './contrib';

/** Controls the blobs view: re-render the list after the store changes. */
export interface BlobsHandle {
  render(): void;
}

const TONE_LIST: Tone[] = ['coral', 'salmon', 'sky', 'navy'];
const PARSE_STATE_LIST: ParseState[] = ['ok', 'stale'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Boot the blobs view over the shared `communities` store: a scrollable list, a
 * read sheet, and a full create/edit/delete editor. Mutations go to the API and
 * are applied to the store in place (blobs surviving) via the field handle.
 */
export function initBlobs(show: (id: string) => void, communities: Community[], field: FieldHandle): BlobsHandle {
  const list = byId('blob-list');
  const countEl = byId('blob-count');
  const modal = byId('blob-modal');
  const sheet = byId('blob-sheet');

  function renderList(): void {
    countEl.textContent = communities.length + (communities.length === 1 ? ' community' : ' communities');
    list.innerHTML = '';
    if (!communities.length) {
      list.innerHTML = '<div class="list-note">no communities yet — add one with “+ new”.</div>';
      return;
    }
    communities.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'blob-row';
      const pillClass = b.involvement >= 60 ? 'hot' : b.involvement >= 30 ? 'cool' : 'cold';
      row.innerHTML =
        '<div class="mini-blob ' + b.tone + '"></div>' +
        '<div class="info"><div class="bname"></div>' +
        '<div class="bmeta">' + esc(b.tenure) + ' · ' + esc(b.energy) + '</div></div>' +
        '<span class="inv-pill ' + pillClass + '">' + b.involvement + '</span>' +
        '<span class="chev">›</span>';
      row.querySelector('.bname')!.textContent = b.name;
      row.addEventListener('click', () => openBlob(b));
      list.appendChild(row);
    });
  }

  // ---------------- read sheet ----------------
  function openBlob(b: Community): void {
    sheet.innerHTML =
      '<div class="sheet-head">' +
        '<div class="big-blob mini-blob ' + b.tone + '"></div>' +
        '<div><div class="bname"></div>' +
        '<div class="parse"><span class="parse-chip ' + b.parseState + '">parsed as ' + esc(b.parse) + '</span></div></div>' +
        '<button class="sheet-close" aria-label="close">&#215;</button>' +
      '</div>' +
      // presence is the one number now — derived from the log, no stored involvement
      '<div class="sheet-section"><span class="label">presence</span>' +
        '<div class="presence-box"><div class="list-note">loading…</div></div></div>' +
      '<div class="statgrid">' +
        '<div class="stat"><div class="num tenure"></div><div class="sub2">tenure</div></div>' +
        '<div class="stat"><div class="num sky last-active">—</div><div class="sub2">last active</div></div>' +
      '</div>' +
      '<div class="sheet-section"><span class="label">last artifact</span><div class="sheet-line lastArtifact"></div></div>' +
      '<div class="sheet-section"><span class="label">next gathering</span><div class="sheet-line nextGathering"></div></div>' +
      '<div class="sheet-section"><span class="label">read</span><div class="sheet-line dim note"></div></div>' +
      '<div class="sheet-section"><span class="label">on the calendar</span><div class="community-events"><div class="list-note">loading…</div></div></div>' +
      '<div class="sheet-section"><div class="log-head"><span class="label">contribution log</span>' +
        '<button class="btn-ghost sm" data-act="log">+ log</button></div>' +
        '<div class="contrib-box"><div class="list-note">loading…</div></div></div>' +
      '<div class="sheet-actions">' +
        '<button class="btn-ghost" data-act="edit">edit</button>' +
        '<button class="btn-danger" data-act="delete">delete</button>' +
      '</div>';
    sheet.querySelector('.bname')!.textContent = b.name;
    (sheet.querySelector('.statgrid .tenure') as HTMLElement).textContent = b.tenure;
    sheet.querySelector('.lastArtifact')!.textContent = b.lastArtifact;
    sheet.querySelector('.nextGathering')!.textContent = b.nextGathering;
    sheet.querySelector('.note')!.textContent = b.note;
    sheet.querySelector('.sheet-close')!.addEventListener('click', closeModal);
    sheet.querySelector('[data-act="edit"]')!.addEventListener('click', () => openEditor(b));
    sheet.querySelector('[data-act="delete"]')!.addEventListener('click', () => removeBlob(b));
    sheet.querySelector('[data-act="log"]')!.addEventListener('click', () => openLogForm(b.id));
    modal.classList.add('open');
    loadCommunityEvents(b.id);
    loadPresence(b.id);
    loadLog(b.id);
  }

  // ---------------- presence (derived) + contribution log ----------------
  function loadPresence(id: string): void {
    getPresence(id)
      .then((p) => {
        const box = sheet.querySelector('.presence-box') as HTMLElement | null;
        if (box) renderPresence(box, p);
        const la = sheet.querySelector('.last-active') as HTMLElement | null;
        if (la) la.textContent = p.lastContribution || '—';
      })
      .catch((err) => {
        console.error('mesh: failed to load presence', err);
        const box = sheet.querySelector('.presence-box') as HTMLElement | null;
        if (box) box.innerHTML = '<div class="list-note">couldn’t load presence</div>';
      });
  }

  function loadLog(id: string): void {
    getContributions(id)
      .then((rows) => renderLog(id, rows))
      .catch((err) => {
        console.error('mesh: failed to load contributions', err);
        const box = sheet.querySelector('.contrib-box') as HTMLElement | null;
        if (box) box.innerHTML = '<div class="list-note">couldn’t load the log</div>';
      });
  }

  function renderLog(id: string, rows: Contribution[]): void {
    const box = sheet.querySelector('.contrib-box') as HTMLElement | null;
    if (!box) return;
    box.innerHTML = '';
    if (!rows.length) {
      box.innerHTML = '<div class="list-note">nothing logged — “+ log” what you’ve done here.</div>';
      return;
    }
    rows.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'clog-row';
      const prov = c.orphaned ? '<span class="prov orphan" title="its calendar event was deleted">unlinked</span>'
        : c.eventId != null ? '<span class="prov linked" title="' + (c.sourceEventLabel || 'from an event') + '">event</span>'
        : '';
      row.innerHTML =
        '<div class="clog-main">' +
          '<span class="clog-mode mode-' + c.mode + '">' + c.mode + '</span>' +
          '<span class="clog-mag" title="magnitude">' + magnitudeDots(c.weight) + '</span>' +
          '<span class="clog-text"></span>' +
        '</div>' +
        '<div class="clog-meta"><span class="clog-date">' + c.date + '</span>' + prov +
          '<span class="spacer"></span>' +
          '<button class="linklike" data-act="edit">edit</button>' +
          '<button class="linklike danger" data-act="del">delete</button></div>';
      (row.querySelector('.clog-text') as HTMLElement).textContent = c.text;
      row.querySelector('[data-act="edit"]')!.addEventListener('click', () => openLogForm(id, c));
      row.querySelector('[data-act="del"]')!.addEventListener('click', () => {
        if (!window.confirm('Delete this contribution?')) return;
        deleteContribution(c.id)
          .then(() => { loadLog(id); loadPresence(id); window.dispatchEvent(new Event('mesh:changed')); })
          .catch((err) => console.error('mesh: failed to delete contribution', err));
      });
      box.appendChild(row);
    });
  }

  function openLogForm(id: string, existing?: Contribution): void {
    const box = sheet.querySelector('.contrib-box') as HTMLElement | null;
    if (!box) return;
    box.innerHTML = '';
    const form = buildContribForm({
      communityId: id,
      existing,
      onSaved: () => { loadLog(id); loadPresence(id); },
      onCancel: () => loadLog(id),
    });
    box.appendChild(form);
    (form.querySelector('[name="text"]') as HTMLTextAreaElement).focus();
  }

  // tagged calendar events for a community, rendered into its open detail sheet
  function loadCommunityEvents(id: string): void {
    getCommunityEvents(id)
      .then((evts) => {
        const box = sheet.querySelector('.community-events') as HTMLElement | null;
        if (!box) return;   // sheet changed/closed while loading
        box.innerHTML = '';
        if (!evts.length) {
          box.innerHTML = '<div class="list-note">no tagged events yet — tag events in the calendar.</div>';
          return;
        }
        evts.forEach((ev) => {
          const row = document.createElement('div');
          row.className = 'ce-row';
          row.innerHTML = '<span class="ce-date"></span><span class="ce-name"></span>';
          (row.querySelector('.ce-date') as HTMLElement).textContent = ev.date + (ev.time ? ' · ' + ev.time : '');
          (row.querySelector('.ce-name') as HTMLElement).textContent = ev.name;
          box.appendChild(row);
        });
      })
      .catch((err) => {
        console.error('mesh: failed to load community events', err);
        const box = sheet.querySelector('.community-events') as HTMLElement | null;
        if (box) box.innerHTML = '<div class="list-note">couldn’t load events</div>';
      });
  }

  // ---------------- editor (create / edit) ----------------
  function openEditor(existing: Community | null): void {
    let tone: Tone = existing ? existing.tone : 'sky';
    let parseState: ParseState = existing ? existing.parseState : 'ok';

    sheet.innerHTML =
      '<div class="sheet-head">' +
        '<div class="editor-title"></div>' +
        '<button class="sheet-close" aria-label="close">&#215;</button>' +
      '</div>' +
      '<form class="editor" novalidate>' +
        '<label class="field"><span class="label">name</span><input name="name" type="text" maxlength="120" autocomplete="off"></label>' +
        '<div class="field"><span class="label">tone</span><div class="tone-swatches">' +
          TONE_LIST.map((t) => '<button type="button" class="swatch mini-blob ' + t + '" data-tone="' + t + '" aria-label="' + t + '"></button>').join('') +
        '</div></div>' +
        '<p class="editor-hint">involvement, delta and energy are derived from the contribution log — log what you did and they follow.</p>' +
        '<label class="field"><span class="label">parse</span><input name="parse" type="text" maxlength="120" autocomplete="off"></label>' +
        '<div class="field"><span class="label">parse state</span><div class="state-chips">' +
          PARSE_STATE_LIST.map((s) => '<button type="button" class="state-chip" data-state="' + s + '">' + s + '</button>').join('') +
        '</div></div>' +
        '<label class="field"><span class="label">tenure</span><input name="tenure" type="text" maxlength="40" autocomplete="off"></label>' +
        '<label class="field"><span class="label">last artifact</span><input name="lastArtifact" type="text" maxlength="200" autocomplete="off"></label>' +
        '<label class="field"><span class="label">next gathering</span><input name="nextGathering" type="text" maxlength="200" autocomplete="off"></label>' +
        '<label class="field"><span class="label">read</span><textarea name="note" rows="2" maxlength="400"></textarea></label>' +
        '<div class="editor-error" role="alert" hidden></div>' +
        '<div class="editor-actions">' +
          (existing ? '<button type="button" class="btn-danger" data-act="delete">delete</button>' : '') +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn-ghost" data-act="cancel">cancel</button>' +
          '<button type="submit" class="btn" data-act="save">' + (existing ? 'save' : 'create') + '</button>' +
        '</div>' +
      '</form>';

    (sheet.querySelector('.editor-title') as HTMLElement).textContent = existing ? 'edit ' + existing.name : 'new community';
    const form = sheet.querySelector('form') as HTMLFormElement;
    const el = (n: string) => form.elements.namedItem(n) as HTMLInputElement | HTMLTextAreaElement;

    // seed values
    (el('name') as HTMLInputElement).value = existing ? existing.name : '';
    (el('parse') as HTMLInputElement).value = existing ? existing.parse : 'new face';
    (el('tenure') as HTMLInputElement).value = existing ? existing.tenure : 'new';
    (el('lastArtifact') as HTMLInputElement).value = existing ? existing.lastArtifact : '';
    (el('nextGathering') as HTMLInputElement).value = existing ? existing.nextGathering : '';
    (el('note') as HTMLTextAreaElement).value = existing ? existing.note : '';

    const paintTone = () => sheet.querySelectorAll('.swatch').forEach((s) =>
      s.classList.toggle('on', (s as HTMLElement).dataset.tone === tone));
    sheet.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => {
      tone = (s as HTMLElement).dataset.tone as Tone; paintTone();
    }));
    paintTone();

    const paintState = () => sheet.querySelectorAll('.state-chip').forEach((s) =>
      s.classList.toggle('on', (s as HTMLElement).dataset.state === parseState));
    sheet.querySelectorAll('.state-chip').forEach((s) => s.addEventListener('click', () => {
      parseState = (s as HTMLElement).dataset.state as ParseState; paintState();
    }));
    paintState();

    const errEl = sheet.querySelector('.editor-error') as HTMLElement;
    const showErr = (msg: string) => { errEl.classList.remove('as-prompt'); errEl.textContent = msg; errEl.hidden = false; };

    sheet.querySelector('.sheet-close')!.addEventListener('click', closeModal);
    sheet.querySelector('[data-act="cancel"]')!.addEventListener('click', () => {
      existing ? openBlob(existing) : closeModal();
    });
    const del = sheet.querySelector('[data-act="delete"]');
    if (del && existing) del.addEventListener('click', () => removeBlob(existing));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (el('name') as HTMLInputElement).value.trim();
      if (!name) { showErr('name is required'); (el('name') as HTMLInputElement).focus(); return; }
      const patch: Partial<CommunityData> & { name: string } = {
        name,
        tone,
        parseState,
        parse: (el('parse') as HTMLInputElement).value.trim() || 'new face',
        tenure: (el('tenure') as HTMLInputElement).value.trim() || 'new',
        lastArtifact: (el('lastArtifact') as HTMLInputElement).value.trim(),
        nextGathering: (el('nextGathering') as HTMLInputElement).value.trim(),
        note: (el('note') as HTMLTextAreaElement).value.trim(),
      };
      const saveBtn = sheet.querySelector('[data-act="save"]') as HTMLButtonElement;
      saveBtn.disabled = true; errEl.hidden = true;
      try {
        const row = existing
          ? await updateCommunity(existing.id, patch)
          : await createCommunity(patch);
        applyUpsert(communities, row, field);
        renderList();
        openBlob(communities.find((c) => c.id === row.id)!);   // land on the saved record
      } catch (err) {
        console.error('mesh: save failed', err);
        const c = err as { conflict?: boolean; kind?: string; suggestion?: { id: string; name: string }; message?: string };
        if (c && c.conflict && c.suggestion) {
          showConflict(c.kind === 'similar', c.suggestion, patch);
        } else {
          showErr(/exists/.test(c?.message || '') ? (c.message as string) : 'could not save — try again');
        }
        saveBtn.disabled = false;
      }
    });

    // a duplicate/near-duplicate prompt: open the match, or (for a soft 'similar'
    // match) create anyway with force
    function showConflict(similar: boolean, sug: { id: string; name: string }, patch: Partial<CommunityData> & { name: string }): void {
      errEl.classList.add('as-prompt');
      errEl.hidden = false;
      errEl.innerHTML = '';
      const line = document.createElement('div');
      line.textContent = similar ? 'This looks a lot like “' + sug.name + '”.'
                                  : 'A community named “' + sug.name + '” already exists.';
      const actions = document.createElement('div');
      actions.className = 'dup-actions';
      const openBtn = document.createElement('button');
      openBtn.type = 'button'; openBtn.className = 'linklike'; openBtn.textContent = 'open ' + sug.name;
      openBtn.addEventListener('click', () => {
        const ex = communities.find((x) => x.id === sug.id);
        if (ex) openBlob(ex);
      });
      actions.appendChild(openBtn);
      if (similar) {
        const anyway = document.createElement('button');
        anyway.type = 'button'; anyway.className = 'linklike'; anyway.textContent = 'create anyway';
        anyway.addEventListener('click', async () => {
          anyway.disabled = true;
          try {
            const row = await createCommunity(patch, true);
            applyUpsert(communities, row, field);
            renderList();
            openBlob(communities.find((x) => x.id === row.id)!);
          } catch (e2) {
            console.error('mesh: forced create failed', e2);
            showErr('could not save — try again');
          }
        });
        actions.appendChild(anyway);
      }
      errEl.appendChild(line);
      errEl.appendChild(actions);
    }

    modal.classList.add('open');
    (el('name') as HTMLInputElement).focus();
  }

  function removeBlob(b: Community): void {
    if (!window.confirm('Delete “' + b.name + '”? This can’t be undone.')) return;
    deleteCommunity(b.id)
      .then(() => { applyRemove(communities, b.id, field); renderList(); closeModal(); })
      .catch((err) => console.error('mesh: delete failed', err));
  }

  function closeModal(): void { modal.classList.remove('open'); }

  byId('new-blob').addEventListener('click', () => openEditor(null));

  // ---------------- sync: run the agent from the calendar as a background job ----------------
  // explicit date windows so the model never has to guess "today" (which it gets wrong)
  const isoDaysAgo = (n: number): string => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const todayIso = (): string => new Date().toISOString().slice(0, 10);

  function recentInstruction(): string {
    return 'Sync from my calendar for the window ' + isoDaysAgo(14) + ' to ' + todayIso() + ' (inclusive). ' +
      'For each community-relevant event in that window not already logged, materialize it and log a ' +
      'contribution (sensible mode and weight). Skip purely personal events. Leave anything already ' +
      'logged alone. Reply with a one-line summary of what changed.';
  }
  function deepInstruction(): string {
    return 'Deep sync from my calendar for ' + todayIso().slice(0, 4) + '-01-01 to ' + todayIso() +
      ', working in month-sized windows. For each community-relevant event not already logged, ' +
      'materialize it and log a contribution (sensible mode and weight). If an event clearly belongs ' +
      'to a community that doesn’t exist yet, create it — otherwise reuse the existing one. Skip purely ' +
      'personal events. Leave anything already logged alone. Summarize what you created and logged.';
  }

  function toast(msg: string): void {
    let t = document.querySelector('.mesh-toast') as (HTMLElement & { _timer?: number }) | null;
    if (!t) { t = document.createElement('div'); t.className = 'mesh-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    window.clearTimeout(t._timer);
    t._timer = window.setTimeout(() => t!.classList.remove('show'), 5000);
  }

  // ---- progress bar controller (session-proof: job state lives on the server) ----
  const bar = byId('sync-bar');
  const barFill = byId('sync-bar-fill');
  const barLabel = byId('sync-bar-label');
  const barCancel = byId<HTMLButtonElement>('sync-bar-cancel');
  let activeJobId: number | null = null;
  let pollTimer: number | null = null;

  function paintJob(job: SyncJob): void {
    bar.hidden = false;
    barFill.style.width = job.percent + '%';
    barFill.className = 'sync-bar-fill' + (job.status === 'failed' ? ' failed' : '');
    const verb = job.kind === 'deep' ? 'deep syncing' : 'syncing';
    const logged = job.changes ? ' · ' + job.changes + ' logged' : '';
    barLabel.textContent =
      job.status === 'running' ? verb + ' from your calendar · ' + job.percent + '%' + logged
      : job.status === 'done' ? 'sync complete' + logged
      : job.status === 'cancelled' ? 'sync cancelled' + logged
      : 'sync failed';
    barCancel.hidden = job.status !== 'running';
  }

  function stopPolling(): void { if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; } }

  function finishJob(job: SyncJob): void {
    stopPolling();
    activeJobId = null;
    try { localStorage.removeItem('mesh.syncJob'); } catch { /* ignore */ }
    window.dispatchEvent(new Event('mesh:changed'));
    paintJob(job);
    toast(job.status === 'done' ? (job.summary?.trim() || 'synced — nothing to change')
        : job.status === 'cancelled' ? 'sync cancelled'
        : (job.error?.trim() || 'sync failed — try again'));
    window.setTimeout(() => { bar.hidden = true; barFill.style.width = '0%'; }, 2800);
  }

  function pollJob(id: number): void {
    stopPolling();
    pollTimer = window.setInterval(() => {
      getSyncJob(id)
        .then((job) => { job.status === 'running' ? paintJob(job) : finishJob(job); })
        .catch((err) => console.error('mesh: sync poll failed', err));   // transient — keep polling
    }, 1500);
  }

  function attachJob(job: SyncJob): void {
    activeJobId = job.id;
    try { localStorage.setItem('mesh.syncJob', String(job.id)); } catch { /* ignore */ }
    barCancel.disabled = false;
    paintJob(job);
    pollJob(job.id);
  }

  barCancel.addEventListener('click', () => {
    if (activeJobId === null) return;
    barCancel.disabled = true;
    barLabel.textContent = 'cancelling…';
    cancelSyncJob(activeJobId).catch((err) => console.error('mesh: cancel failed', err));
  });

  async function startSyncJob(kind: 'recent' | 'deep'): Promise<void> {
    if (activeJobId !== null) { toast('a sync is already running'); return; }
    const instruction = kind === 'deep' ? deepInstruction() : recentInstruction();
    try {
      const r = await startSync(instruction, kind);
      if (r.ok && r.job) attachJob(r.job);
      else if (r.status === 503) toast('sync isn’t enabled on the server yet');
      else toast('could not start sync — try again');
    } catch (err) {
      console.error('mesh: could not start sync', err);
      toast('could not start sync — check your connection');
    }
  }

  // resume a running job after a page refresh (state is server-side)
  getActiveSyncJob().then((job) => { if (job && job.status === 'running') attachJob(job); }).catch(() => { /* ignore */ });

  // ---- sync dropdown ----
  const syncBtn = byId<HTMLButtonElement>('sync-blobs');
  const syncMenu = byId('sync-menu');
  function closeSyncMenu(): void { syncMenu.hidden = true; syncBtn.setAttribute('aria-expanded', 'false'); }
  syncBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !syncMenu.hidden;
    syncMenu.hidden = open;
    syncBtn.setAttribute('aria-expanded', String(!open));
  });
  syncMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeSyncMenu);
  document.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') closeSyncMenu(); });
  syncMenu.querySelectorAll('[data-mode]').forEach((item) =>
    item.addEventListener('click', () => {
      const kind: 'recent' | 'deep' = (item as HTMLElement).dataset.mode === 'deep' ? 'deep' : 'recent';
      closeSyncMenu();
      void startSyncJob(kind);
    }));
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && modal.classList.contains('open')) closeModal();
  });

  // field -> blob sheet: a clean tap on a blob in the field lands on its full view
  byId('field').addEventListener('blobclick', (e) => {
    const b = communities.find((x) => x.id === (e as CustomEvent).detail.id);
    if (!b) return;
    show('tab-blobs');
    openBlob(b);
  });

  return {
    render(): void {
      renderList();
    },
  };
}
