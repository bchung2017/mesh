import { byId } from '../dom';

/** Toggle the "nudges" panel open/closed from the status line link. */
export function initNudges(): void {
  const toggle = byId<HTMLAnchorElement>('nudges-toggle');
  toggle.addEventListener('click', function (this: HTMLAnchorElement, e) {
    e.preventDefault();
    const v = byId('nudges-view');
    const open = v.style.display !== 'none';
    v.style.display = open ? 'none' : 'block';
    this.textContent = open ? 'nudges →' : 'nudges ←';
  });
}
