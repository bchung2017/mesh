import './styles/tokens.css';
import './styles/base.css';
import './styles/field.css';
import './styles/calendar.css';
import './styles/blobs.css';

import { byId } from './dom';
import { getCommunities } from './api';
import { initField } from './field/blobField';
import { initCalendar } from './views/calendar';
import { initTabs } from './views/tabs';
import { initBlobs } from './views/blobs';
import { initNudges } from './views/nudges';

// Boot every view immediately so the whole UI is interactive up front — tabs,
// calendar, nudges, and the (empty) field all work without waiting on the API.
// Then load community data progressively and hand it to the field + blobs when
// it arrives. A slow or failing API can no longer blank the interface.
const field = initField(byId<HTMLCanvasElement>('field'));
initCalendar();
const { show } = initTabs();
const blobs = initBlobs(show);
initNudges();

getCommunities()
  .then((communities) => {
    field.setCommunities(communities);
    blobs.setCommunities(communities);
  })
  .catch((err) => console.error('mesh: could not load communities', err));
