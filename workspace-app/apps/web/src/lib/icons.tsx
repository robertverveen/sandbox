/** Iconen uit het prototype (16x16, lijn). */
import type { ReactElement } from 'react';

export const ICONS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  meeting: '<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>',
  mail: '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2"/><path d="m2.5 4.5 5.5 4 5.5-4"/>',
  slack: '<path d="M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.5 5.8h11M2 10.2h11"/>',
  context: '<path d="M8 1.8 14 5 8 8.2 2 5z"/><path d="m2 8 6 3.2L14 8"/><path d="m2 11 6 3.2 6-3.2"/>',
  task: '<circle cx="8" cy="8" r="6"/><path d="m5.4 8.2 1.8 1.8 3.4-3.6"/>',
  file: '<path d="M4 1.8h5l3.2 3.2v9.2H4z"/><path d="M9 1.8V5h3.2"/>',
  commit: '<path d="M3.5 14.5V2"/><path d="M3.5 2.5h8.5l-1.8 3.2 1.8 3.3H3.5"/>',
  chat: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  git: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
  spark: '<path d="M8 1.8c.4 3.2 1.9 4.8 5.2 5.2-3.3.4-4.8 2-5.2 5.2C7.6 9 6.1 7.4 2.8 7c3.3-.4 4.8-2 5.2-5.2z"/>',
  arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  out: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5"/><path d="M12 10v3.5H2.5V4H6"/>',
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  chevL: '<path d="m10 3-5 5 5 5"/>',
  chevR: '<path d="m6 3 5 5-5 5"/>',
  bookmark: '<path d="M4 2h8v12l-4-3-4 3z"/>',
  users:
    '<circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13.2c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6"/><path d="M10.5 3.4a2.2 2.2 0 0 1 0 4.3M12 9.8c1.2.5 2 1.6 2.2 3.4"/>',
  mic: '<rect x="5.5" y="1.8" width="5" height="8" rx="2.5"/><path d="M3.2 7.5a4.8 4.8 0 0 0 9.6 0M8 12.3v2"/>',
  send: '<path d="M2 8 14 2.5 10.5 14 8 9z"/><path d="m8 9 6-6.5"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  undo: '<path d="M5 3 2 6l3 3"/><path d="M2 6h7a4 4 0 0 1 0 8H6"/>',
  refresh: '<path d="M13 3v3.5H9.5"/><path d="M13 6.5A5.5 5.5 0 1 0 13.5 9"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9"/>',
  inbox: '<path d="M2 9.5 3.8 3h8.4L14 9.5V13H2z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
  gear: '<path d="M2.5 4.5h6M12 4.5h1.5M2.5 11.5h1.5M7.5 11.5h6"/><circle cx="10.2" cy="4.5" r="1.7"/><circle cx="5.8" cy="11.5" r="1.7"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }): ReactElement {
  return (
    <svg
      className={className ? `i ${className}` : 'i'}
      viewBox="0 0 16 16"
      aria-hidden="true"
      // Paden zijn vaste, eigen strings (geen gebruikersinvoer).
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
