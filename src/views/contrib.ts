import type { Contribution, Mode, Presence } from '../types';
import { createContribution, updateContribution, classifyContribution } from '../api';

export const MODE_LIST: Mode[] = ['built', 'organized', 'served', 'led', 'connected'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// weight (1..10) is never shown as a raw number — it reads as a 3-dot magnitude,
// so presence can't be mistaken for a gameable score
const MAGS = [
  { w: 3, dots: '·', label: 'light' },
  { w: 6, dots: '··', label: 'solid' },
  { w: 9, dots: '···', label: 'major' },
];
export function magnitudeBucket(weight: number): number {
  return weight <= 3 ? 0 : weight <= 6 ? 1 : 2;
}
export function magnitudeDots(weight: number): string {
  return MAGS[magnitudeBucket(weight)].dots;
}

/** Whether the user has the LLM autofill toggle on (per-browser, best-effort). */
export function autofillOn(): boolean {
  try { return localStorage.getItem('mesh.autofill') === '1'; } catch { return false; }
}
function setAutofill(on: boolean): void {
  try { localStorage.setItem('mesh.autofill', on ? '1' : '0'); } catch { /* ignore */ }
}

export interface ContribFormOpts {
  communityId: string;
  eventId?: number;
  eventContext?: string;      // who/what/where/when, handed to the LLM for context
  existing?: Contribution;    // present → edit mode
  defaultDate?: string;       // YYYY-MM-DD for a new entry (event date, or today)
  onSaved(c: Contribution): void;
  onCancel(): void;
}

/** Build the contribution logger: free text + mode + magnitude, with an optional
 *  LLM autofill toggle that pre-fills mode/magnitude from the text (confirm or
 *  override — your pick always wins and is never re-overwritten). Returns the
 *  form element; the caller mounts it. */
export function buildContribForm(opts: ContribFormOpts): HTMLElement {
  const ex = opts.existing;
  let mode: Mode = ex ? ex.mode : 'built';
  let weight: number = ex ? ex.weight : 6;
  let touched = !!ex;   // did the user set mode/weight by hand (so the LLM won't clobber)

  const form = document.createElement('form');
  form.className = 'contrib-form';
  form.innerHTML =
    '<label class="field"><span class="label">what you did</span>' +
      '<textarea name="text" rows="2" maxlength="280" autocomplete="off" placeholder="shipped the intake form, ran the Tuesday session…"></textarea></label>' +
    '<div class="field"><span class="label">kind</span><div class="mode-chips">' +
      MODE_LIST.map((m) => '<button type="button" class="mode-chip" data-mode="' + m + '">' + m + '</button>').join('') +
    '</div></div>' +
    '<div class="field"><span class="label">magnitude</span><div class="mag-chips">' +
      MAGS.map((g, i) => '<button type="button" class="mag-chip" data-i="' + i + '" title="' + g.label + '">' + g.dots + '</button>').join('') +
    '</div></div>' +
    '<label class="autofill"><input type="checkbox" name="autofill"><span>suggest kind + magnitude from the text</span></label>' +
    '<div class="llm-why" hidden></div>' +
    '<div class="contrib-error" role="alert" hidden></div>' +
    '<div class="contrib-actions">' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn-ghost" data-act="cancel">cancel</button>' +
      '<button type="submit" class="btn" data-act="save">' + (ex ? 'save' : 'log it') + '</button>' +
    '</div>';

  const textEl = form.querySelector('[name="text"]') as HTMLTextAreaElement;
  const autofillEl = form.querySelector('[name="autofill"]') as HTMLInputElement;
  const whyEl = form.querySelector('.llm-why') as HTMLElement;
  const errEl = form.querySelector('.contrib-error') as HTMLElement;
  if (ex) textEl.value = ex.text;

  const paintMode = () => form.querySelectorAll('.mode-chip').forEach((c) =>
    c.classList.toggle('on', (c as HTMLElement).dataset.mode === mode));
  const paintMag = () => form.querySelectorAll('.mag-chip').forEach((c) =>
    c.classList.toggle('on', Number((c as HTMLElement).dataset.i) === magnitudeBucket(weight)));
  paintMode(); paintMag();

  form.querySelectorAll('.mode-chip').forEach((c) => c.addEventListener('click', () => {
    mode = (c as HTMLElement).dataset.mode as Mode; touched = true; paintMode();
  }));
  form.querySelectorAll('.mag-chip').forEach((c) => c.addEventListener('click', () => {
    weight = MAGS[Number((c as HTMLElement).dataset.i)].w; touched = true; paintMag();
  }));

  // --- LLM autofill (optional, non-load-bearing) ---
  autofillEl.checked = autofillOn();
  autofillEl.addEventListener('change', () => {
    setAutofill(autofillEl.checked);
    if (autofillEl.checked && textEl.value.trim() && !touched) void suggest();
    if (!autofillEl.checked) { whyEl.hidden = true; }
  });
  async function suggest(): Promise<void> {
    const text = textEl.value.trim();
    if (!autofillEl.checked || !text || touched) return;   // never override a hand pick
    whyEl.hidden = false; whyEl.textContent = 'thinking…'; whyEl.classList.remove('err');
    const s = await classifyContribution(text, opts.eventContext);
    if (!s) {   // no key / failure → silently leave the manual chips be
      whyEl.textContent = 'autofill unavailable — pick the chips yourself';
      whyEl.classList.add('err');
      return;
    }
    if (touched) { whyEl.hidden = true; return; }   // user picked while we waited
    mode = s.mode; weight = s.weight; paintMode(); paintMag();
    whyEl.textContent = '“' + s.rationale + '”';
  }
  textEl.addEventListener('blur', () => { void suggest(); });

  const showErr = (m: string) => { errEl.textContent = m; errEl.hidden = false; };
  form.querySelector('[data-act="cancel"]')!.addEventListener('click', opts.onCancel);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textEl.value.trim();
    if (!text) { showErr('say what you did'); textEl.focus(); return; }
    const saveBtn = form.querySelector('[data-act="save"]') as HTMLButtonElement;
    saveBtn.disabled = true; errEl.hidden = true;
    try {
      let row: Contribution;
      if (ex) {
        row = await updateContribution(ex.id, { text, mode, weight });
      } else {
        row = await createContribution(opts.communityId, {
          date: opts.defaultDate || new Date().toISOString().slice(0, 10),
          text, mode, weight,
          ...(opts.eventId ? { eventId: opts.eventId } : {}),
        });
      }
      opts.onSaved(row);
    } catch (err) {
      console.error('mesh: contribution save failed', err);
      showErr('could not save — try again');
      saveBtn.disabled = false;
    }
  });

  return form;
}

/** Paint the derived presence read into a container (bar, energy, mode mix). */
export function renderPresence(el: HTMLElement, p: Presence): void {
  const deltaTxt = p.delta > 0 ? '▲ +' + p.delta : p.delta < 0 ? '▼ ' + p.delta : '— steady';
  const deltaColor = p.delta > 0 ? 'var(--ok)' : p.delta < 0 ? 'var(--warn)' : 'var(--ink-faint)';
  // mode mix as a thin stacked bar, biggest shares first, zero modes dropped
  const mix = MODE_LIST.map((m) => ({ m, pct: p.modeMix[m] || 0 })).filter((x) => x.pct > 0)
    .sort((a, b) => b.pct - a.pct);
  const segs = mix.map((x) => '<span class="mm-seg mode-' + x.m + '" style="width:' + x.pct + '%" title="' + x.m + ' ' + x.pct + '%"></span>').join('');
  const legend = mix.map((x) => '<span class="mm-key"><i class="mm-dot mode-' + x.m + '"></i>' + esc(x.m) + ' ' + x.pct + '%</span>').join('');
  const count = p.contributionCount === 0 ? 'nothing logged yet'
    : p.contributionCount === 1 ? '1 contribution' : p.contributionCount + ' contributions';

  el.innerHTML =
    '<div class="presence-head">' +
      '<span class="presence-energy">' + esc(p.energy) + '</span>' +
      '<span class="presence-delta" style="color:' + deltaColor + '">' + deltaTxt + '</span>' +
    '</div>' +
    '<div class="inv-bar"><span style="width:' + p.involvement + '%"></span></div>' +
    '<div class="presence-sub"><b>' + p.involvement + '</b> presence · ' + count +
      (p.lastContribution ? ' · last ' + esc(p.lastContribution) : '') + '</div>' +
    (mix.length ? '<div class="mode-mix">' + segs + '</div><div class="mode-legend">' + legend + '</div>' : '');
}
