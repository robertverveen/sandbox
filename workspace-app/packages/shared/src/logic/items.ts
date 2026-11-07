/**
 * Wat vraagt nu om een besluit, wat staat er gepland, welke afspraken: de logica van Dagstart en
 * Planning uit het prototype, als pure functies met een expliciete klok.
 */
import type { CommitItem, Item, MeetingItem, TaskItem, Weekdoel } from '../domain';
import { addDays, addWorkdays, baseDay, dayDiff, dayLabel, fmtDate, hm, nextWork, pd, weekStart, ymd } from './time';

export const DAY_CAP = 10;

export const STROOM: Record<string, string> = {
  mijn: 'Ik beloofde',
  aan_mij: 'Wachten op',
  voornemen: 'Eigen voornemen',
  bespreken: 'Bespreken bij contact',
  weekdoel: 'Weekdoel',
  roadmap: 'Roadmap',
};
export const STATUS: Record<string, string> = {
  open: 'Open',
  waarschijnlijk_klaar: 'Waarschijnlijk klaar',
  klaar: 'Klaar',
  te_laat: 'Te laat',
  overgedragen: 'Overgedragen',
  losgelaten: 'Losgelaten',
};
export const BUCKETS: Record<number, string> = {
  1: 'Vandaag',
  2: 'Morgen',
  3: 'Later deze week',
  4: 'Volgende week',
  5: 'Backlog',
};
export const HEALTH: Record<string, [string, string]> = {
  groen: ['🟢', 'Op koers'],
  oranje: ['🟠', 'Risico'],
  rood: ['🔴', 'Blokkade'],
  af: ['✅', 'Af'],
};

export type Kind =
  | 'reply'
  | 'mega'
  | 'task'
  | 'commit'
  | 'waiting'
  | 'bespreken'
  | 'invite'
  | 'meeting'
  | 'prep'
  | 'process'
  | 'jira'
  | 'other';

export const KIND: Record<Kind | 'late' | 'review', [string, string]> = {
  review: ['k-prep', 'Weekreview'],
  late: ['k-late', 'Te laat'],
  commit: ['k-commit', 'Toezegging'],
  prep: ['k-prep', 'Prep'],
  invite: ['k-invite', 'Uitnodiging'],
  reply: ['k-reply', 'Reageren'],
  mega: ['k-reply', '📣 To-do'],
  task: ['k-task', 'Taak'],
  process: ['k-process', 'Verwerken'],
  waiting: ['k-wait', 'Wachten op'],
  bespreken: ['k-prep', 'Bespreken'],
  meeting: ['k-process', 'Meeting'],
  jira: ['k-process', 'Jira'],
  other: ['k-process', ''],
};

/** Moment van een item als wandklok-Date. */
export function when(it: Item, now: Date): Date {
  if ('start' in it && it.start) return pd(it.start);
  if ('time' in it && it.time) return pd(it.time);
  if (it.type === 'task' && it.due) return pd(it.due + 'T09:00');
  if (it.type === 'commit' && it.due) return pd(it.due + 'T09:00');
  return new Date(now);
}

export const isPast = (m: { end?: string }, now: Date) => !!m.end && pd(m.end) <= now;
export const isDone = (it: Item) => it.type === 'commit' && ['klaar', 'overgedragen', 'losgelaten'].includes(it.status);

export function kindOf(it: Item): Kind {
  switch (it.type) {
    case 'slack':
      return it.mega ? 'mega' : 'reply';
    case 'mail':
      return 'reply';
    case 'task':
      return 'task';
    case 'commit':
      return it.stroom === 'aan_mij' ? 'waiting' : it.stroom === 'bespreken' ? 'bespreken' : 'commit';
    case 'meeting':
      return it.needsAction ? 'invite' : 'meeting';
    case 'rec':
      return 'process';
    case 'jira':
      return 'jira';
    default:
      return 'other';
  }
}

/** Weekdoel of roadmapdoel als tracker-item (zelfde vorm als commitItems() in het prototype). */
export function weekdoelToItem(w: Weekdoel, today: string): CommitItem {
  const status = w.status === 'open' && w.deadline && w.deadline < today ? 'te_laat' : w.status;
  return {
    id: 'cm:' + (w.legacyId ?? w.id),
    docId: w.id,
    type: 'commit',
    title: w.wat,
    entities: [],
    stroom: w.soort,
    status,
    deadline: w.deadline ?? null,
    plan: null,
    reminder: null,
    week: w.week,
    health: w.health,
    time: w.created ? w.created + 'T09:00' : null,
    body: w.bron?.label,
  };
}

/** Afgeleide velden (zoals decorate() in het prototype): over tijd, weekdoel, prep-taak bij een meeting. */
export function decorate(items: Item[], now: Date): Item[] {
  const T = ymd(now);
  const tasks = items.filter((i): i is TaskItem => i.type === 'task');
  return items.map((it) => {
    if (it.type === 'task') {
      return {
        ...it,
        overdue: !!it.due && it.due < T,
        weekgoal:
          it.weekgoal || /^🎯/.test(it.title) || (/\[weekprep\]/.test(it.notes || '') && /doel/i.test(it.notes || '')),
        prep: /prep/i.test(it.title) && /^🛠/.test(it.title),
      };
    }
    if (it.type === 'meeting') {
      const words = [
        ...it.entities.map((e) => e.toLowerCase()),
        ...String(it.title)
          .toLowerCase()
          .split(/[^a-z0-9à-ÿ]+/)
          .filter((w) => w.length > 4 && !['homezero', 'sessie', 'meeting', 'check'].includes(w)),
      ].slice(0, 4);
      const day = ymd(pd(it.start));
      const prep = tasks.find(
        (t) =>
          t.due &&
          t.due <= day &&
          (/prep/i.test(t.title) || /\[briefing\]|\[weekprep\]/.test(t.notes || '')) &&
          words.some((w) => t.title.toLowerCase().includes(w)),
      );
      return { ...it, prepTask: prep?.id ?? null };
    }
    return it;
  });
}

/* ---------- Planning: 1 vandaag · 2 morgen · 3 later deze week · 4 volgende week · 5 backlog ---------- */
export function plannedOn(items: Item[], date: string, now: Date): Item[] {
  const lo = date === ymd(baseDay(now)) ? ymd(now) : date;
  const inRange = (d?: string | null) => !!d && d >= lo && d <= date;
  return items.filter(
    (it) =>
      !isDone(it) &&
      ((it.type === 'task' && !it.backlog && inRange(it.due)) ||
        (it.type === 'commit' && !it.linkedTask && ['mijn', 'voornemen'].includes(it.stroom) && inRange(it.plan))),
  );
}

export function bucketDate(items: Item[], n: number, now: Date): string {
  const b = baseDay(now);
  if (n === 1) return ymd(b);
  const tm = nextWork(b);
  if (n === 2) return ymd(tm);
  const loadOf = (d: string) => plannedOn(items, d, now).length;
  const least = (days: Date[]) =>
    days
      .map(ymd)
      .sort(
        (a, c) =>
          Number(loadOf(a) >= DAY_CAP) - Number(loadOf(c) >= DAY_CAP) || loadOf(a) - loadOf(c) || a.localeCompare(c),
      )[0]!;
  const wkB = weekStart(0, b);
  if (n === 3) {
    const later = [2, 3, 4].map((i) => addDays(wkB, i)).filter((d) => d > tm);
    return least(later.length ? later : [addDays(wkB, 7), addDays(wkB, 8)]);
  }
  return least([0, 1, 2, 3, 4].map((i) => addDays(wkB, 7 + i)));
}

export function bucketOf(date: string | null | undefined, backlog: boolean | undefined, now: Date): number {
  if (backlog) return 5;
  if (!date) return 0;
  const b = ymd(baseDay(now));
  const tm = ymd(nextWork(baseDay(now)));
  if (date < ymd(now)) return -1;
  if (date <= b) return 1;
  if (date === tm) return 2;
  const wkB = weekStart(0, baseDay(now));
  if (pd(date) < addDays(wkB, 7)) return 3;
  if (pd(date) < addDays(wkB, 14)) return 4;
  return 6;
}

export interface InboxEntry {
  kind: Kind;
  it: Item;
  score: number;
  why: string;
}

/** Wat vraagt nu om een besluit, gesorteerd op urgentie (inbox() in het prototype). */
export function inbox(items: Item[], now: Date): InboxEntry[] {
  const T = ymd(now);
  const out: InboxEntry[] = [];
  const add = (kind: Kind, it: Item, score: number, why: string) => out.push({ kind, it, score, why });
  const horizon = ymd(addWorkdays(now, 2));
  for (const it of items) {
    if (it.type === 'slack' && !it.read && !it.fromMe && !it.bot) {
      if (it.mega) add('mega', it, 70, `📣 Door jou gemarkeerd · ${it.channel}`);
      else if (!it.answered && (it.dm || it.mention)) {
        const ageH = (+now - +when(it, now)) / 36e5;
        add(
          'reply',
          it,
          (it.dm ? 72 : 64) + (/\?/.test(it.title) ? 6 : 0) - Math.min(14, ageH / 12),
          `${it.dm ? 'DM' : 'Noemt je in ' + it.channel} · ${it.fromName} · ${dayLabel(when(it, now), now)} ${hm(when(it, now))}`,
        );
      }
    }
    if (it.type === 'mail' && it.direct && !it.read) add('reply', it, 62, `Mail aan jou · ${it.fromName}`);
    if (it.type === 'task' && !it.backlog && (!it.due || it.due < T)) {
      add(
        'task',
        it,
        it.due ? 66 + Math.min(10, -dayDiff(pd(it.due), now)) : 36,
        it.due
          ? `Google Tasks · over tijd sinds ${fmtDate(it.due)}${(it.moved ?? 0) >= 2 ? ' · ' + it.moved + 'e keer doorgeschoven' : ''}`
          : 'Google Tasks · nog geen datum',
      );
    }
    if (it.type === 'commit' && !isDone(it)) {
      if (['mijn', 'voornemen'].includes(it.stroom)) {
        const s = STROOM[it.stroom];
        if (it.status === 'waarschijnlijk_klaar') add('commit', it, 50, `Bewijs gevonden · bevestig met x`);
        else if (it.status === 'te_laat' && !(it.plan && it.plan >= T))
          add('commit', it, 90, `${s}${it.aan ? ' · ' + it.aan : ''} · deadline was ${fmtDate(it.deadline ?? T)}`);
        else if (!it.backlog && (!it.plan || it.plan < T))
          add(
            'commit',
            it,
            it.plan ? 68 : 46,
            `${s}${it.aan ? ' · ' + it.aan : ''}${it.plan ? ' · stond op ' + fmtDate(it.plan) : ' · nog niet gepland'}${(it.moved ?? 0) >= 2 ? ' · ' + it.moved + 'e keer doorgeschoven' : ''}`,
          );
      } else if (it.stroom === 'aan_mij' && !it.backlog && it.reminder && it.reminder <= T) {
        add(
          'waiting',
          it,
          58,
          `Wachten op ${it.aan || 'iemand'} sinds ${fmtDate(it.reminder)} · nog geen reactie, nudge?`,
        );
      }
    }
    if (it.type === 'meeting' && pd(it.end || it.start) > now) {
      if (it.needsAction)
        add(
          'invite',
          it,
          74 - Math.min(7, Math.max(0, dayDiff(pd(it.start), now))) * 3,
          `Uitnodiging van ${it.organizerName || 'onbekend'} · ${dayLabel(pd(it.start), now)}${it.allDay ? '' : ' ' + hm(pd(it.start))}`,
        );
      else if (it.external && !it.prepTask && !it.skipPrep && ymd(pd(it.start)) <= horizon)
        add(
          'prep',
          it,
          68 - Math.max(0, dayDiff(pd(it.start), now)) * 4,
          `Extern · ${dayLabel(pd(it.start), now)} ${hm(pd(it.start))} · nog geen prep gepland`,
        );
    }
    if (
      it.type === 'rec' &&
      it.entities.length &&
      !it.processed &&
      !it.recapSession &&
      pd(it.end) < now &&
      dayDiff(pd(it.start), now) >= -7
    ) {
      add(
        'process',
        it,
        60 - Math.min(10, -dayDiff(pd(it.start), now)),
        `Opname ${dayLabel(pd(it.start), now).toLowerCase()}${it.recapDone ? ' · recap staat in #klanten' : ' · nog geen recap'}`,
      );
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** De eerstvolgende dag met afspraken (vandaag zolang er nog iets komt). */
export function focusDay(items: Item[], now: Date): { day: string; k: number; list: MeetingItem[] } {
  const evs = items.filter((i): i is MeetingItem => i.type === 'meeting' && !i.allDay && !i.ooo);
  for (let k = 0; k < 8; k++) {
    const day = ymd(addDays(now, k));
    const list = evs.filter((e) => ymd(pd(e.start)) === day && (k > 0 || pd(e.end) > now));
    if (list.length)
      return {
        day,
        k,
        list: evs.filter((e) => ymd(pd(e.start)) === day).sort((a, b) => +pd(a.start) - +pd(b.start)),
      };
  }
  return { day: ymd(now), k: 0, list: [] };
}

export function openCommits(items: Item[]): CommitItem[] {
  return items.filter((i): i is CommitItem => i.type === 'commit' && !isDone(i));
}

/** Gesprekken om in te halen (catchGroups() in het prototype). */
export function catchGroups(items: Item[], now: Date) {
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    let key: string | null = null;
    if (it.type === 'slack' && !it.read && !it.fromMe && !it.bot && !it.answered && it.channelId)
      key = 'sl:' + it.channelId;
    else if (it.type === 'mail' && !it.read && it.threadId) key = 'ml:' + it.threadId;
    if (!key) continue;
    const g = groups.get(key) ?? [];
    g.push(it);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      list.sort((a, b) => +when(a, now) - +when(b, now));
      const last = list[list.length - 1]!;
      const prio = list.some(
        (i) => (i.type === 'slack' && (i.dm || i.mention || i.mega)) || (i.type === 'mail' && i.direct),
      )
        ? 1
        : 0;
      return { key, items: list, last, prio, time: +when(last, now) };
    })
    .sort((a, b) => b.prio - a.prio || b.time - a.time);
}

export function greeting(now: Date, lastSeen: number | null, nowMs: number, name = 'Robert'): string {
  const h = now.getHours();
  const away = !!lastSeen && nowMs - lastSeen > 10 * 36e5;
  if (away || !lastSeen) return `Welkom terug, ${name}`;
  return (h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond') + `, ${name}`;
}
