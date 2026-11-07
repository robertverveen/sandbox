import { describe, expect, it } from 'vitest';
import { ContextSnapshot, Item, routes, pathFor, type MeetingItem, type TaskItem } from '../src';
import {
  amsterdamToInstant,
  bucketDate,
  bucketOf,
  calDefaults,
  catchGroups,
  ctxAge,
  ctxDagstart,
  dayLabel,
  focusDay,
  greeting,
  inbox,
  isoWeek,
  orgFromChannel,
  orgFromDomain,
  orgFromText,
  orgIndex,
  pd,
  plannedOn,
  relShort,
  sprintInfo,
  toLocal,
  weekdoelToItem,
} from '../src/logic';

const NOW = pd('2026-10-30T08:40'); // vrijdag

describe('tijd (Europe/Amsterdam)', () => {
  it('daglabels zoals het prototype', () => {
    expect(dayLabel(pd('2026-10-30T10:00'), NOW)).toBe('Vandaag');
    expect(dayLabel(pd('2026-10-29'), NOW)).toBe('Gisteren');
    expect(dayLabel(pd('2026-10-31'), NOW)).toBe('Morgen');
    expect(dayLabel(pd('2026-11-02'), NOW)).toBe('Maandag');
    expect(dayLabel(pd('2026-11-20'), NOW)).toBe('vr 20 nov');
    expect(relShort('2026-10-30T07:24', NOW)).toBe('07:24');
    expect(relShort('2026-10-29T07:24', NOW)).toBe('gisteren');
  });

  it('ISO-week', () => {
    expect(isoWeek(pd('2026-10-30'))).toBe('2026-W44');
    expect(isoWeek(pd('2027-01-01'))).toBe('2026-W53');
  });

  it('wandklok <-> moment rond zomertijd (25 okt 2026 03:00 -> 02:00)', () => {
    expect(amsterdamToInstant('2026-10-24T12:00').toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(amsterdamToInstant('2026-10-26T12:00').toISOString()).toBe('2026-10-26T11:00:00.000Z');
    expect(toLocal(new Date('2026-03-29T01:30:00Z'))).toBe('2026-03-29T03:30');
    expect(pd('2026-10-30T07:24:00+01:00').getHours()).toBe(7);
  });
});

const task = (id: string, due: string | null, extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  type: 'task',
  rawId: id,
  tasklist: 'L',
  title: id,
  due,
  status: 'needsAction',
  entities: [],
  ...extra,
});
const meeting = (id: string, start: string, end: string, extra: Partial<MeetingItem> = {}): MeetingItem => ({
  id,
  type: 'meeting',
  title: id,
  start,
  end,
  entities: [],
  attendeeNames: [],
  ...extra,
});

describe('Dagstart-logica', () => {
  const items = [
    task('vandaag', '2026-10-30'),
    task('telaat', '2026-10-28'),
    task('backlog', null, { backlog: true }),
    meeting('m1', '2026-10-30T10:00', '2026-10-30T11:00', { external: true }),
    meeting('m8', '2026-11-02T14:15', '2026-11-02T15:00', { needsAction: true, organizerName: 'Joost' }),
    {
      id: 's1',
      type: 'slack',
      channel: '#x-hz',
      channelId: 'CX',
      fromName: 'Anna',
      time: '2026-10-29T09:12',
      title: 'Kan iemand kijken?',
      mention: true,
      entities: [],
    },
    {
      id: 'e1',
      type: 'mail',
      threadId: 'T1',
      fromName: 'Bram',
      time: '2026-10-30T07:24',
      title: 'Vraag',
      direct: true,
      unread: true,
      entities: [],
    },
  ].map((x) => Item.parse(x));

  it('inbox sorteert op urgentie met een reden', () => {
    const box = inbox(items, NOW);
    // s1: 64 + 6 (vraag) - 23,5u/12 = 68,04; telaat: 66 + 2 = 68; prep: 68; invite: 74 - 3*3 = 65; mail: 62
    expect(box.map((b) => [b.kind, b.it.id])).toEqual([
      ['reply', 's1'],
      ['task', 'telaat'],
      ['prep', 'm1'],
      ['invite', 'm8'],
      ['reply', 'e1'],
    ]);
    expect(box[3]!.why).toBe('Uitnodiging van Joost · Maandag 14:15');
    expect(box[2]!.why).toBe('Extern · Vandaag 10:00 · nog geen prep gepland');
    expect(box[0]!.why).toBe('Noemt je in #x-hz · Anna · Gisteren 09:12');
  });

  it('gepland voor vandaag, buckets en capaciteit', () => {
    expect(plannedOn(items, bucketDate(items, 1, NOW), NOW).map((i) => i.id)).toEqual(['vandaag']);
    expect(bucketDate(items, 2, NOW)).toBe('2026-11-02');
    expect(bucketOf('2026-10-28', false, NOW)).toBe(-1);
    expect(bucketOf('2026-11-02', false, NOW)).toBe(2);
    expect(bucketOf('2026-11-05', false, NOW)).toBe(4);
    expect(bucketOf(null, true, NOW)).toBe(5);
  });

  it('agenda van vandaag en gesprekken om in te halen', () => {
    expect(focusDay(items, NOW).list.map((m) => m.id)).toEqual(['m1']);
    expect(focusDay(items, pd('2026-10-30T12:00')).day).toBe('2026-11-02');
    expect(catchGroups(items, NOW).map((g) => g.key)).toEqual(['ml:T1', 'sl:CX']);
  });

  it('begroeting', () => {
    expect(greeting(NOW, null, 0)).toBe('Welkom terug, Robert');
    expect(greeting(NOW, 1000, 2000)).toBe('Goedemorgen, Robert');
  });

  it('weekdoel als tracker-item, te laat na de deadline', () => {
    const it = weekdoelToItem(
      { id: 'w', wat: 'Doel', soort: 'weekdoel', week: '2026-W43', deadline: '2026-10-23', status: 'open', checks: [] },
      '2026-10-30',
    );
    expect(it).toMatchObject({ id: 'cm:w', stroom: 'weekdoel', status: 'te_laat' });
  });

  it('geïmporteerd weekdoel: item-sleutel cm:<doc-id uit het prototype>, docId blijft de rij (voor PATCH)', () => {
    const it = weekdoelToItem(
      { id: '6f1c', legacyId: 'dg1', wat: 'Doel', soort: 'weekdoel', status: 'open', checks: [] },
      '2026-10-30',
    );
    expect(it).toMatchObject({ id: 'cm:dg1', docId: '6f1c' });
  });
});

describe('agenda-lagen', () => {
  it('werk geel, Lou alleen in Agenda, collega’s uit', () => {
    const cals = calDefaults(
      [
        { id: 'robert@homezero.nl', summary: 'robert@homezero.nl', primary: true },
        { id: 'sport@import.calendar.google.com', summary: 'Sport' },
        { id: 'x@group.calendar.google.com', summary: 'Familie' },
        { id: 'collega@homezero.nl', summary: 'collega' },
      ],
      'robert@homezero.nl',
    );
    expect(cals.map((c) => [c.group, c.color, c.scope, c.on])).toEqual([
      ['werk', '#e2c25a', 'overal', true],
      ['lou', '#b39ddb', 'agenda', true],
      ['prive', '#e67c73', 'overal', true],
      ['collegas', '#3f51b5', 'agenda', false],
    ]);
  });
});

describe('sprint', () => {
  it('punten en dagen te gaan', () => {
    const sprint = { name: 'Sprint 73', startDate: '2026-10-22T21:54:00Z', endDate: '2026-11-05T10:58:00Z' };
    const issue = (key: string, status: string, cat: 'new' | 'indeterminate' | 'done', sp: number, mine = false) =>
      Item.parse({ id: key, type: 'jira', key, title: key, status, cat, assignee: '', sp, sprint, mine, entities: [] });
    const s = sprintInfo(
      [
        issue('A', 'Done', 'done', 2),
        issue('B', 'Ready to Accept', 'indeterminate', 3, true),
        issue('C', 'In Progress', 'indeterminate', 5),
      ] as never,
      NOW,
    );
    expect(s).toMatchObject({ daysLeft: 6, totalPts: 10, donePts: 2, acceptPts: 3, progPts: 5, mine: 1 });
  });
});

describe('contextlaag', () => {
  const snap = ContextSnapshot.parse({
    status: { status: '2026-10-28 | oranje | lek 0', geexporteerd: '2026-10-28T07:00:00+01:00' },
    partners: {
      zonnig: {
        slug: 'zonnig',
        soort: 'partner',
        naam: 'Zonnig',
        aliassen: ['Zon Installatie'],
        domeinen: ['zonnig.example'],
        slack: 'zonnig-hz',
      },
    },
    acties: {
      zonnig: {
        slug: 'zonnig',
        naam: 'Zonnig',
        acties: [
          { state: 'open', tekst: 'A', eigenaar: 'Robert', datum: '2026-10-29' },
          { state: 'open', tekst: 'B', eigenaar: 'Robert', datum: '2026-10-30', voorstel: true },
          { state: 'open', tekst: 'C', eigenaar: 'Lisanne', datum: '2026-10-29' },
          { state: 'open', tekst: 'D', eigenaar: 'Robert', datum: '2026-11-10' },
        ],
      },
    },
    pers: null,
  });

  it('eigen acties, voorstel apart, en versheid (> 36 uur)', () => {
    const d = ctxDagstart(snap, NOW, 'Robert')!;
    expect(d.confirmed.map((a) => a.tekst)).toEqual(['A']);
    expect(d.proposed.map((a) => a.tekst)).toEqual(['B']);
    expect(ctxAge(snap, NOW)).toMatchObject({ staleLayer: true, staleExport: true, color: 'oranje' });
  });

  it('organisaties herkennen op domein, kanaal en alias', () => {
    const idx = orgIndex(snap.partners);
    expect(orgFromDomain(idx, 'mail.zonnig.example')).toBe('zonnig');
    expect(orgFromChannel(idx, '#zonnig-hz')).toBe('zonnig');
    expect(orgFromText(idx, 'Zon Installatie')).toBe('zonnig');
    expect(orgFromDomain(idx, 'gmail.com')).toBeNull();
  });
});

describe('API-contract', () => {
  it('elke route heeft een uniek pad per methode en een antwoordschema', () => {
    const seen = new Set<string>();
    for (const [name, r] of Object.entries(routes)) {
      const k = `${r.method} ${r.path}`;
      expect(seen.has(k), name).toBe(false);
      seen.add(k);
      expect(r.path.startsWith('/api/')).toBe(true);
      expect(r.response).toBeDefined();
    }
    expect(Object.keys(routes).length).toBeGreaterThan(30);
  });

  it('pathFor vult en codeert parameters', () => {
    expect(pathFor(routes.conversation.path, { key: 'sl:C1' })).toBe('/api/conversations/sl%3AC1');
    expect(() => pathFor(routes.partner.path, {})).toThrow();
  });
});
