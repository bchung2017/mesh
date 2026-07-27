import type { Tone } from '../types';

export interface ToneSpec {
  fill: string;
  hi: string;
  lo: string;
  halo: [number, number, number, number];
}

export const TONES: Record<Tone, ToneSpec> = {
  coral:  { fill: '#ff6f61', hi: '#ff9a90', lo: '#d94f42', halo: [1.0, 0.435, 0.38, 0.22] },
  salmon: { fill: '#ffa08c', hi: '#ffc4b6', lo: '#e07f6b', halo: [1.0, 0.627, 0.549, 0.22] },
  sky:    { fill: '#5aa9e6', hi: '#8fc7f2', lo: '#3f86c2', halo: [0.353, 0.663, 0.902, 0.22] },
  navy:   { fill: '#1b2a4a', hi: '#3a4f7d', lo: '#101b33', halo: [0.106, 0.165, 0.29, 0.15] },
};

export const TONE_HEX: Record<Tone, string> = {
  coral: '#ff6f61', salmon: '#ffa08c', sky: '#5aa9e6', navy: '#1b2a4a',
};
