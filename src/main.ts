import './styles/tokens.css';
import './styles/base.css';
import './styles/field.css';
import './styles/calendar.css';
import './styles/blobs.css';

import { byId } from './dom';
import { initField } from './field/blobField';
import { initCalendar } from './views/calendar';
import { initTabs } from './views/tabs';
import { initBlobs } from './views/blobs';
import { initNudges } from './views/nudges';

// order mirrors the original prototype: the field and calendar boot first, then
// the tab bar resets the subline to the home copy, then blobs wires the
// field → sheet bridge, then nudges.
initField(byId<HTMLCanvasElement>('field'));
initCalendar();
const { show } = initTabs();
initBlobs(show);
initNudges();
