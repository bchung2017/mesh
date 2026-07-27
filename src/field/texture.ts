import type { Tone } from '../types';
import { TONES } from './palette';

export interface TextureSource {
  r: number;
  tone: Tone;
  name: string;
  parse: string;
  id: string;
}

/**
 * Bake a blob's shaded ball + label into an offscreen canvas (later uploaded as
 * a GL texture, or drawn directly in the 2D fallback). The label is printed flat
 * then warped through a spherical-lens map so it reads as ink on a curved surface
 * even at rest: magnified at the pole, foreshortened at the rim.
 */
export function bakeTexture(b: TextureSource): HTMLCanvasElement {
  const scale = 2;
  const R = b.r, S = Math.ceil(R * 2 * scale);
  const tex = document.createElement('canvas');
  tex.width = S; tex.height = S;
  const t = tex.getContext('2d')!;
  const c = S / 2, tr = R * scale;
  const tone = TONES[b.tone];

  const g = t.createRadialGradient(c - tr * 0.35, c - tr * 0.4, tr * 0.1, c, c, tr);
  g.addColorStop(0, tone.hi);
  g.addColorStop(0.55, tone.fill);
  g.addColorStop(1, tone.lo);
  t.beginPath(); t.arc(c, c, tr * 0.995, 0, Math.PI * 2);
  t.fillStyle = g; t.fill();

  t.beginPath(); t.arc(c - tr * 0.3, c - tr * 0.38, tr * 0.32, 0, Math.PI * 2);
  t.fillStyle = 'rgba(255,255,255,0.20)'; t.fill();

  // text is printed flat, then warped through a spherical-lens map so it reads as
  // ink on a curved surface even at rest: magnified at the pole, foreshortened at the rim
  const txt = document.createElement('canvas');
  txt.width = S; txt.height = S;
  const tt = txt.getContext('2d')!;
  tt.fillStyle = '#ffffff'; tt.textAlign = 'center';
  if (R > 44) {
    tt.font = '700 ' + (14 * scale) + 'px "Helvetica Neue",Helvetica,Arial,sans-serif';
    tt.fillText(b.name, c, c - 2 * scale);
    tt.font = '400 ' + (11 * scale) + 'px "Helvetica Neue",Helvetica,Arial,sans-serif';
    tt.fillStyle = 'rgba(255,255,255,0.88)';
    tt.fillText(b.parse, c, c + 14 * scale);
  } else {
    tt.font = '700 ' + (13 * scale) + 'px "Helvetica Neue",Helvetica,Arial,sans-serif';
    tt.fillText(b.id, c, c + 4 * scale);
  }

  const BULGE = 0.6;   // 0 = flat print, 1 = full orthographic sphere wrap
  const src = tt.getImageData(0, 0, S, S);
  const dst = t.createImageData(S, S);
  const sd = src.data, dd = dst.data;
  for (let y = 0; y < S; y++) {
    const dy = y - c;
    for (let x = 0; x < S; x++) {
      const dx = x - c;
      const rd = Math.hypot(dx, dy) / tr;
      if (rd > 1) continue;
      // inverse lens: dst radius rd samples source at rs = (2/pi)·asin(rd) < rd,
      // so glyphs at the pole spread (magnify) and rim glyphs compress
      const rs = rd < 1e-4 ? rd : (rd * (1 - BULGE) + (2 / Math.PI) * Math.asin(rd) * BULGE);
      const f = rd < 1e-4 ? 1 : rs / rd;
      const sx = c + dx * f, sy = c + dy * f;
      // bilinear sample
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= S - 1 || y0 >= S - 1) continue;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * S + x0) * 4, i10 = i00 + 4, i01 = i00 + S * 4, i11 = i01 + 4;
      const di = (y * S + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        dd[di + ch] =
          sd[i00 + ch] * (1 - fx) * (1 - fy) + sd[i10 + ch] * fx * (1 - fy) +
          sd[i01 + ch] * (1 - fx) * fy + sd[i11 + ch] * fx * fy;
      }
    }
  }
  // composite warped print over the shaded ball
  const warped = document.createElement('canvas');
  warped.width = S; warped.height = S;
  warped.getContext('2d')!.putImageData(dst, 0, 0);
  t.drawImage(warped, 0, 0);
  return tex;
}
