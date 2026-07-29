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

// Fetch community data from the API, then boot the views. Order mirrors the
// original prototype: field and calendar first, then the tab bar resets the
// subline to the home copy, then blobs wires the field → sheet bridge.
async function boot(): Promise<void> {
  const communities = await getCommunities();

  initField(byId<HTMLCanvasElement>('field'), communities);
  void initCalendar();
  const { show } = initTabs();
  initBlobs(show, communities);
  initNudges();
}

boot().catch((err) => console.error('mesh: failed to start', err));
