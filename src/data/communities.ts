import type { Community } from '../types';

/**
 * The communities you belong to. Community-level data only — no people, no
 * rosters (mock). Both the field renderer and the blobs list read from here,
 * so a change to involvement or tone shows up everywhere at once.
 */
export const COMMUNITIES: Community[] = [
  {
    id: 'HW', name: 'NYC Hardware', tone: 'coral', parse: '"built the thing"', parseState: 'ok',
    involvement: 82, delta: +6, tenure: '3 mo', energy: 'humming',
    lastArtifact: 'charging writeup — 2 weeks ago',
    nextGathering: 'thursday meetup in 2 days',
    note: 'your strongest graph — keep bringing artifacts',
  },
  {
    id: 'CL', name: 'Climate Circle', tone: 'salmon', parse: 'founder-type', parseState: 'ok',
    involvement: 55, delta: +12, tenure: '2 mo', energy: 'warming',
    lastArtifact: 'none yet — entered via intro',
    nextGathering: 'monthly circle in 9 days',
    note: 'fastest-growing blob; parser installed correctly at first contact',
  },
  {
    id: 'MG', name: 'Makers Guild', tone: 'sky', parse: 'new face', parseState: 'ok',
    involvement: 34, delta: 0, tenure: '3 wk', energy: 'settling',
    lastArtifact: 'none yet',
    nextGathering: 'open shop night, saturday',
    note: 'too new to read — show up twice more before judging',
  },
  {
    id: 'MM', name: 'Micromobility', tone: 'navy', parse: 'engineer', parseState: 'stale',
    involvement: 18, delta: -9, tenure: '4 mo', energy: 'cooling',
    lastArtifact: 'BMS talk — 3 months ago',
    nextGathering: 'nothing on the calendar',
    note: 'parser stale — re-enter via artifact or let it fade deliberately',
  },
];
