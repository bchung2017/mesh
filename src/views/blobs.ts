import type { Community } from '../types';
import { TONE_HEX } from '../field/palette';
import { byId } from '../dom';

/** Controls the blobs view: feed it community data whenever it arrives. */
export interface BlobsHandle {
  setCommunities(communities: Community[]): void;
}

/**
 * Boot the blobs list + detail sheet. Takes `show` from the tab bar so a clean
 * tap on a blob in the field can land on its full view here. All handlers are
 * wired immediately; call the returned `setCommunities` once data loads, so the
 * tab stays interactive even before (or without) the API.
 */
export function initBlobs(show: (id: string) => void): BlobsHandle {
  const list = byId('blob-list');
  const countEl = byId('blob-count');
  const modal = byId('blob-modal');
  const sheet = byId('blob-sheet');

  let communities: Community[] = [];

  function renderList(): void {
    countEl.textContent = communities.length + ' communities';
    list.innerHTML = '';
    communities.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'blob-row';
      const pillClass = b.involvement >= 60 ? 'hot' : b.involvement >= 30 ? 'cool' : 'cold';
      row.innerHTML =
        '<div class="mini-blob ' + b.tone + '"></div>' +
        '<div class="info"><div class="bname"></div>' +
        '<div class="bmeta">' + b.tenure + ' · ' + b.energy + '</div></div>' +
        '<span class="inv-pill ' + pillClass + '">' + b.involvement + '</span>' +
        '<span class="chev">›</span>';
      row.querySelector('.bname')!.textContent = b.name;
      row.addEventListener('click', () => openBlob(b));
      list.appendChild(row);
    });
  }

  function openBlob(b: Community): void {
    const deltaTxt = b.delta > 0 ? '▲ +' + b.delta : b.delta < 0 ? '▼ ' + b.delta : '— 0';
    const deltaColor = b.delta > 0 ? 'var(--ok)' : b.delta < 0 ? 'var(--warn)' : 'var(--ink-faint)';
    sheet.innerHTML =
      '<div class="sheet-head">' +
        '<div class="big-blob mini-blob ' + b.tone + '"></div>' +
        '<div><div class="bname"></div>' +
        '<div class="parse"><span class="parse-chip ' + b.parseState + '">parsed as ' + b.parse.replace(/</g, '&lt;') + '</span></div></div>' +
        '<button class="sheet-close" aria-label="close">&#215;</button>' +
      '</div>' +
      '<div class="sheet-section">' +
        '<span class="label">involvement</span>' +
        '<div class="inv-bar"><span style="width:' + b.involvement + '%;background:' + TONE_HEX[b.tone] + '"></span></div>' +
        '<div class="sheet-line"><b>' + b.involvement + '</b> <span style="color:' + deltaColor + ';font-weight:600;font-size:13px">' + deltaTxt + ' vs last month</span></div>' +
      '</div>' +
      '<div class="statgrid">' +
        '<div class="stat"><div class="num">' + b.tenure + '</div><div class="sub2">in this blob</div></div>' +
        '<div class="stat"><div class="num sky">' + b.energy + '</div><div class="sub2">energy</div></div>' +
      '</div>' +
      '<div class="sheet-section"><span class="label">last artifact</span><div class="sheet-line">' + b.lastArtifact + '</div></div>' +
      '<div class="sheet-section"><span class="label">next gathering</span><div class="sheet-line">' + b.nextGathering + '</div></div>' +
      '<div class="sheet-section"><span class="label">read</span><div class="sheet-line dim">' + b.note + '</div></div>';
    sheet.querySelector('.bname')!.textContent = b.name;
    sheet.querySelector('.sheet-close')!.addEventListener('click', closeBlob);
    modal.classList.add('open');
  }
  function closeBlob(): void { modal.classList.remove('open'); }
  modal.addEventListener('click', (e) => { if (e.target === modal) closeBlob(); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && modal.classList.contains('open')) closeBlob();
  });

  // field -> blob sheet: a clean tap on a blob in the field lands on its full view
  byId('field').addEventListener('blobclick', (e) => {
    const b = communities.find((x) => x.id === (e as CustomEvent).detail.id);
    if (!b) return;
    show('tab-blobs');
    openBlob(b);
  });

  return {
    setCommunities(next: Community[]): void {
      communities = next;
      renderList();
    },
  };
}
