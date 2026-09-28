import type { Community, CommunityData, Tone, ParseState } from '../types';
import { TONE_HEX } from '../field/palette';
import type { FieldHandle } from '../field/blobField';
import { byId } from '../dom';
import { createCommunity, updateCommunity, deleteCommunity } from '../api';
import { applyUpsert, applyRemove } from '../store';

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
    const deltaTxt = b.delta > 0 ? '▲ +' + b.delta : b.delta < 0 ? '▼ ' + b.delta : '— 0';
    const deltaColor = b.delta > 0 ? 'var(--ok)' : b.delta < 0 ? 'var(--warn)' : 'var(--ink-faint)';
    sheet.innerHTML =
      '<div class="sheet-head">' +
        '<div class="big-blob mini-blob ' + b.tone + '"></div>' +
        '<div><div class="bname"></div>' +
        '<div class="parse"><span class="parse-chip ' + b.parseState + '">parsed as ' + esc(b.parse) + '</span></div></div>' +
        '<button class="sheet-close" aria-label="close">&#215;</button>' +
      '</div>' +
      '<div class="sheet-section">' +
        '<span class="label">involvement</span>' +
        '<div class="inv-bar"><span style="width:' + b.involvement + '%;background:' + TONE_HEX[b.tone] + '"></span></div>' +
        '<div class="sheet-line"><b>' + b.involvement + '</b> <span style="color:' + deltaColor + ';font-weight:600;font-size:13px">' + deltaTxt + ' vs last month</span></div>' +
      '</div>' +
      '<div class="statgrid">' +
        '<div class="stat"><div class="num"></div><div class="sub2">in this blob</div></div>' +
        '<div class="stat"><div class="num sky"></div><div class="sub2">energy</div></div>' +
      '</div>' +
      '<div class="sheet-section"><span class="label">last artifact</span><div class="sheet-line lastArtifact"></div></div>' +
      '<div class="sheet-section"><span class="label">next gathering</span><div class="sheet-line nextGathering"></div></div>' +
      '<div class="sheet-section"><span class="label">read</span><div class="sheet-line dim note"></div></div>' +
      '<div class="sheet-actions">' +
        '<button class="btn-ghost" data-act="edit">edit</button>' +
        '<button class="btn-danger" data-act="delete">delete</button>' +
      '</div>';
    sheet.querySelector('.bname')!.textContent = b.name;
    (sheet.querySelector('.statgrid .num') as HTMLElement).textContent = b.tenure;
    (sheet.querySelector('.statgrid .num.sky') as HTMLElement).textContent = b.energy;
    sheet.querySelector('.lastArtifact')!.textContent = b.lastArtifact;
    sheet.querySelector('.nextGathering')!.textContent = b.nextGathering;
    sheet.querySelector('.note')!.textContent = b.note;
    sheet.querySelector('.sheet-close')!.addEventListener('click', closeModal);
    sheet.querySelector('[data-act="edit"]')!.addEventListener('click', () => openEditor(b));
    sheet.querySelector('[data-act="delete"]')!.addEventListener('click', () => removeBlob(b));
    modal.classList.add('open');
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
        '<div class="field"><span class="label">involvement <em class="inv-val"></em></span>' +
          '<input name="involvement" type="range" min="0" max="100" step="1"></div>' +
        '<label class="field"><span class="label">parse</span><input name="parse" type="text" maxlength="120" autocomplete="off"></label>' +
        '<div class="field"><span class="label">parse state</span><div class="state-chips">' +
          PARSE_STATE_LIST.map((s) => '<button type="button" class="state-chip" data-state="' + s + '">' + s + '</button>').join('') +
        '</div></div>' +
        '<div class="two-col">' +
          '<label class="field"><span class="label">energy</span><input name="energy" type="text" maxlength="40" autocomplete="off"></label>' +
          '<label class="field"><span class="label">tenure</span><input name="tenure" type="text" maxlength="40" autocomplete="off"></label>' +
        '</div>' +
        '<label class="field"><span class="label">delta (vs last month)</span><input name="delta" type="number" step="1"></label>' +
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
    (el('energy') as HTMLInputElement).value = existing ? existing.energy : 'settling';
    (el('tenure') as HTMLInputElement).value = existing ? existing.tenure : 'new';
    (el('delta') as HTMLInputElement).value = String(existing ? existing.delta : 0);
    (el('lastArtifact') as HTMLInputElement).value = existing ? existing.lastArtifact : '';
    (el('nextGathering') as HTMLInputElement).value = existing ? existing.nextGathering : '';
    (el('note') as HTMLTextAreaElement).value = existing ? existing.note : '';
    const invEl = el('involvement') as HTMLInputElement;
    invEl.value = String(existing ? existing.involvement : 20);
    const invVal = sheet.querySelector('.inv-val') as HTMLElement;
    const syncInv = () => { invVal.textContent = invEl.value; };
    invEl.addEventListener('input', syncInv); syncInv();

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
    const showErr = (msg: string) => { errEl.textContent = msg; errEl.hidden = false; };

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
        involvement: Number(invEl.value),
        delta: Math.trunc(Number((el('delta') as HTMLInputElement).value) || 0),
        energy: (el('energy') as HTMLInputElement).value.trim() || 'settling',
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
        showErr('could not save — try again');
        saveBtn.disabled = false;
      }
    });

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
