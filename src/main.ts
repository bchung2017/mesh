import './styles/tokens.css';
import './styles/base.css';
import './styles/field.css';
import './styles/calendar.css';
import './styles/blobs.css';

import type { Community } from './types';
import { byId } from './dom';
import { getCommunities } from './api';
import { reconcile } from './store';
import { initField } from './field/blobField';
import { initCalendar } from './views/calendar';
import { initTabs } from './views/tabs';
import { initBlobs } from './views/blobs';
import { initNudges } from './views/nudges';
import { statusLoading, statusReady, statusError } from './views/status';

// One shared store. The field engine and the blobs list both hold this exact
// array (never a clone); reconcile() mutates it in place as data arrives.
const communities: Community[] = [];

// Boot every view immediately so the whole UI is interactive up front — tabs,
// calendar, nudges, and the (empty) field all work without waiting on the API.
// Then load community data progressively. A slow or failing API can no longer
// blank the interface.
statusLoading();

const field = initField(byId<HTMLCanvasElement>('field'), communities);
initCalendar(communities);
const { show } = initTabs();
const blobs = initBlobs(show, communities, field);
initNudges();

let loaded = false;
let inFlight = false;

// Load (and later revalidate) community data: refetch, then reconcile into the
// shared store in place — new communities attach, changed involvement/tone
// rebake, departed ones detach, and every surviving blob keeps its position and
// texture. Failures never blank a good UI.
function load(): void {
  if (inFlight) return;
  inFlight = true;
  getCommunities()
    .then((data) => {
      reconcile(communities, data, field);
      blobs.render();
      loaded = true;
      statusReady();                 // also clears the error state on a recovered load
    })
    .catch((err) => {
      console.error('mesh: could not load communities', err);
      if (!loaded) statusError();    // keep the last good data on a failed revalidate
    })
    .finally(() => { inFlight = false; });
}

// Revalidate when the tab regains focus/visibility (SWR-style): picks up any
// server-side change with blobs surviving, and recovers a first load that
// failed on a cold start. No polling.
window.addEventListener('focus', load);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

load();
