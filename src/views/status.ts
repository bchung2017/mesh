import { byId } from '../dom';

// A small loading/error affordance for the data fetch, covering the field
// (spinner overlay) and the blobs list (a text note). The field spinner is
// revealed on a short delay so a fast API doesn't make it flash.

const REVEAL_DELAY = 200;
let revealTimer = 0;

function fieldStatus() { return byId('field-status'); }
function fieldText() { return byId('field-status-text'); }
function blobList() { return byId('blob-list'); }

export function statusLoading(): void {
  blobList().innerHTML = '<div class="list-note">loading communities…</div>';
  window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => {
    const s = fieldStatus();
    s.classList.remove('error');
    fieldText().textContent = 'loading your field…';
    s.hidden = false;
  }, REVEAL_DELAY);
}

export function statusReady(): void {
  window.clearTimeout(revealTimer);
  fieldStatus().hidden = true;   // blobs are drawing now; the blob list is filled by initBlobs
}

export function statusError(message = 'couldn’t reach the server — try again in a moment'): void {
  window.clearTimeout(revealTimer);
  const s = fieldStatus();
  s.classList.add('error');
  fieldText().textContent = message;
  s.hidden = false;
  blobList().innerHTML = '<div class="list-note error"></div>';
  (blobList().firstElementChild as HTMLElement).textContent = message;
}
