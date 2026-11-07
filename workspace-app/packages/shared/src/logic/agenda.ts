/**
 * Agenda-logica zonder tijdzones: alles is wandklok Europe/Amsterdam (`JJJJ-MM-DDTHH:MM`), zoals in het domein.
 * Live providers rekenen Google-antwoorden eerst om met toLocal().
 */
import type { BusyBlock } from '../domain';

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (s: string) => s.slice(0, 10);
const minOf = (s: string) => (s.length > 10 ? +s.slice(11, 13) * 60 + +s.slice(14, 16) : 0);
const at = (date: string, min: number) => `${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const weekday = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();
const nextDate = (date: string, n = 1) => {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Werkdagen optellen (ma–vr), zoals het schema voor reminders en nudges vraagt. */
export function addWorkdaysYmd(date: string, n: number): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = nextDate(d);
    const w = weekday(d);
    if (w !== 0 && w !== 6) left--;
  }
  return d;
}

export interface FreeSlotOptions {
  /** Minuten. */
  duration: number;
  /** Werktijd, standaard 09:00–17:30. */
  dayStart?: string;
  dayEnd?: string;
  /** Raster in minuten (standaard 30). */
  step?: number;
  /** Niet eerder dan dit moment (wandklok). */
  notBefore?: string;
  /** Maximaal aantal voorstellen. */
  limit?: number;
}

/**
 * Tijden waarop iedereen kan: binnen werktijd op ma–vr, niet over een bezet blok van wie dan ook heen.
 * `from` inclusief, `to` exclusief (JJJJ-MM-DD). Blokken over middernacht worden per dag afgekapt.
 */
export function freeSlots(busy: BusyBlock[], from: string, to: string, opts: FreeSlotOptions): BusyBlock[] {
  const step = opts.step ?? 30;
  const ds = minOf('0000-00-00T' + (opts.dayStart ?? '09:00'));
  const de = minOf('0000-00-00T' + (opts.dayEnd ?? '17:30'));
  const out: BusyBlock[] = [];
  for (let d = from; d < to; d = nextDate(d)) {
    const w = weekday(d);
    if (w === 0 || w === 6) continue;
    const blocks = busy
      .filter((b) => dateOf(b.start) <= d && dateOf(b.end || b.start) >= d)
      .map((b) => [dateOf(b.start) < d ? 0 : minOf(b.start), dateOf(b.end) > d ? 24 * 60 : minOf(b.end)] as const)
      // Hele-dag-afspraak (alleen datum) blokkeert de hele dag.
      .map(([s, e]) => (e <= s ? ([0, 24 * 60] as const) : ([s, e] as const)));
    let start = Math.ceil(ds / step) * step;
    if (opts.notBefore && dateOf(opts.notBefore) === d)
      start = Math.max(start, Math.ceil(minOf(opts.notBefore) / step) * step);
    if (opts.notBefore && dateOf(opts.notBefore) > d) continue;
    for (let s = start; s + opts.duration <= de; s += step) {
      const e = s + opts.duration;
      if (blocks.some(([bs, be]) => bs < e && be > s)) continue;
      out.push({ start: at(d, s), end: at(d, e) });
      if (opts.limit && out.length >= opts.limit) return out;
    }
  }
  return out;
}
