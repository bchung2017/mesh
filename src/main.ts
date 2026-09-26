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
initCalendar();
const { show } = initTabs();
const blobs = initBlobs(show, communities);
initNudges();

getCommunities()
  .then((data) => {
    reconcile(communities, data, field);   // attaches a blob to each community
    blobs.render();
    statusReady();
  })
  .catch((err) => {
    console.error('mesh: could not load communities', err);
    statusError();
  });
