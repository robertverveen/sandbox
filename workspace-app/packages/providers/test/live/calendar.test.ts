/**
 * HZW-030 zelftest: contracttests tegen opgenomen (synthetische) Google Calendar-antwoorden en tijdzonetests rond
 * zomertijd. msw vangt alle verzoeken af; niets gaat naar Google.
 */
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { MeetingItem } from '@hz/shared';
import {
  GOOGLE_CALENDAR_BASE as G,
  LiveCalendar,
  MemorySyncStore,
  NotHumanError,
  RateLimitError,
  mapEvent,
  withHumanAction,
  withUserScope,
} from '../../src';
import { creds, mockServer } from './msw';

const SELF = 'robert@homezero.nl';
const CALS = [
  { id: SELF, summary: SELF, primary: true, backgroundColor: '#039be5', accessRole: 'owner' },
  { id: 'robertverveen@gmail.com', summary: 'Privé', backgroundColor: '#f4511e', accessRole: 'reader' },
  { id: 'lou.family@group.calendar.google.com', summary: 'Lou', backgroundColor: '#8e24aa', accessRole: 'reader' },
  { id: 'nl.dutch#holiday@group.v.calendar.google.com', summary: 'Feestdagen in Nederland', accessRole: 'reader' },
];

/** Opgenomen Google-vorm (synthetisch, uit de demodata van het prototype). */
const feenstra = {
  id: 'evfeen1',
  status: 'confirmed',
  summary: 'Feenstra · maandelijkse check-in',
  iCalUID: 'evfeen1@google.com',
  htmlLink: 'https://www.google.com/calendar/event?eid=evfeen1',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  start: { dateTime: '2026-10-30T10:00:00+01:00', timeZone: 'Europe/Amsterdam' },
  end: { dateTime: '2026-10-30T11:00:00+01:00', timeZone: 'Europe/Amsterdam' },
  organizer: { email: SELF, self: true },
  attendees: [
    { email: SELF, self: true, organizer: true, responseStatus: 'accepted' },
    { email: 'marie-jose@feenstra.example', displayName: 'Marie-José', responseStatus: 'needsAction' },
    { email: 'lisanne@homezero.nl', displayName: 'Lisanne', responseStatus: 'accepted' },
  ],
};
const sunergy = {
  id: 'evsun1',
  status: 'confirmed',
  summary: 'Sunergy',
  iCalUID: 'evsun1@google.com',
  start: { dateTime: '2026-11-02T14:15:00+01:00' },
  end: { dateTime: '2026-11-02T15:00:00+01:00' },
  organizer: { email: 'bjorn@sunergy.example', displayName: 'Bjorn' },
  attendees: [
    { email: 'bjorn@sunergy.example', displayName: 'Bjorn', organizer: true, responseStatus: 'accepted' },
    { email: SELF, self: true, responseStatus: 'needsAction' },
  ],
};
const declined = {
  ...sunergy,
  id: 'evdecl',
  iCalUID: 'evdecl@google.com',
  summary: 'Afgewezen',
  attendees: [{ email: SELF, self: true, responseStatus: 'declined' }],
};
const workLoc = {
  id: 'evwl',
  status: 'confirmed',
  eventType: 'workingLocation',
  summary: 'Kantoor',
  start: { date: '2026-10-30' },
  end: { date: '2026-10-31' },
};
const priveSport = {
  id: 'evsport',
  status: 'confirmed',
  summary: 'Sport',
  start: { dateTime: '2026-10-30T18:00:00+01:00' },
  end: { dateTime: '2026-10-30T19:00:00+01:00' },
};
const vakantie = {
  id: 'evvak',
  status: 'confirmed',
  summary: 'Vakantie Lou',
  start: { date: '2026-11-02' },
  end: { date: '2026-11-07' },
  colorId: '3',
};
/** Dezelfde afspraak, ook zichtbaar in de privé-agenda (gedeeld): mag maar één keer verschijnen. */
const feenstraDup = { ...feenstra, attendees: feenstra.attendees.map((a) => ({ ...a, self: false })) };

let state: Record<string, { items: unknown[]; token: string; changes?: unknown[]; gone?: boolean }>;
beforeEach(() => {
  state = {
    [SELF]: { items: [feenstra, sunergy, declined, workLoc], token: 'sync-self-1' },
    'robertverveen@gmail.com': { items: [priveSport, feenstraDup], token: 'sync-prive-1' },
    'lou.family@group.calendar.google.com': { items: [vakantie], token: 'sync-lou-1' },
    'nl.dutch#holiday@group.v.calendar.google.com': { items: [], token: 'sync-hol-1' },
  };
});

const { server, requests, clear } = mockServer(
  http.get(`${G}/users/me/calendarList`, () => HttpResponse.json({ kind: 'calendar#calendarList', items: CALS })),
  http.get(`${G}/calendars/:cal/events`, ({ params, request }) => {
    const cal = decodeURIComponent(String(params.cal));
    const u = new URL(request.url);
    const s = state[cal];
    if (!s) return HttpResponse.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
    const sync = u.searchParams.get('syncToken');
    if (sync) {
      if (s.gone)
        return HttpResponse.json({ error: { code: 410, message: 'Sync token is no longer valid' } }, { status: 410 });
      const items = s.changes ?? [];
      s.changes = [];
      return HttpResponse.json({ items, nextSyncToken: s.token + '+' });
    }
    // Volledige sync in twee pagina's voor de eigen agenda (paginering).
    if (cal === SELF && !u.searchParams.get('pageToken'))
      return HttpResponse.json({ items: s.items.slice(0, 2), nextPageToken: 'p2' });
    if (cal === SELF) return HttpResponse.json({ items: s.items.slice(2), nextSyncToken: s.token });
    return HttpResponse.json({ items: s.items, nextSyncToken: s.token });
  }),
);

const NOW = () => new Date('2026-10-30T07:40:00Z');
const make = () => new LiveCalendar(creds(), { store: new MemorySyncStore(), now: NOW, freshMs: 0 });
const RANGE = { from: '2026-10-26', to: '2026-11-09' };

describe('Google Agenda live (HZW-030)', () => {
  it('toont alle agenda’s in het werkaccount, ook gedeelde privé-agenda’s en Lou', async () => {
    const cals = await make().listCalendars();
    expect(cals.map((c) => c.id)).toEqual(CALS.map((c) => c.id));
    expect(cals[0]).toMatchObject({ primary: true, backgroundColor: '#039be5' });
    expect(cals.find((c) => c.id === 'robertverveen@gmail.com')?.summary).toBe('Privé');
  });

  it('afspraken per periode: contractvorm, dubbel weg, afgewezen en werklocatie niet getoond', async () => {
    const events = await make().listEvents(RANGE);
    for (const e of events) expect(() => MeetingItem.parse(e)).not.toThrow();
    const titles = events.map((e) => e.title);
    expect(titles.filter((t) => t.startsWith('Feenstra'))).toHaveLength(1);
    expect(titles).not.toContain('Afgewezen');
    expect(titles).not.toContain('Kantoor');
    expect(titles).toEqual(expect.arrayContaining(['Sport', 'Vakantie Lou', 'Sunergy']));
    const f = events.find((e) => e.title.startsWith('Feenstra'))!;
    expect(f).toMatchObject({
      id: 'ev:evfeen1',
      start: '2026-10-30T10:00',
      end: '2026-10-30T11:00',
      calId: SELF,
      meet: 'https://meet.google.com/abc-defg-hij',
      where: 'Google Meet',
      external: true,
      organizerName: 'jij',
    });
    expect(f.attendeeNames).toEqual(['Robert', 'Marie-José', 'Lisanne']);
    expect(events.find((e) => e.title === 'Sunergy')).toMatchObject({ needsAction: true, organizerName: 'Bjorn' });
    expect(events.find((e) => e.title === 'Vakantie Lou')).toMatchObject({
      allDay: true,
      start: '2026-11-02',
      calId: 'lou.family@group.calendar.google.com',
      evColor: '#8e24aa',
    });
    // Volledige sync met tijdvenster, paginering en timeZone.
    const full = requests.filter((r) => r.url.pathname.endsWith(`/calendars/${encodeURIComponent(SELF)}/events`));
    expect(full).toHaveLength(2);
    expect(full[0]!.url.searchParams.get('singleEvents')).toBe('true');
    expect(full[0]!.url.searchParams.get('timeZone')).toBe('Europe/Amsterdam');
    expect(full[0]!.url.searchParams.get('timeMin')).toBeTruthy();
    expect(full[1]!.url.searchParams.get('pageToken')).toBe('p2');
    expect(requests.every((r) => r.headers.get('authorization') === 'Bearer test-token')).toBe(true);
  });

  it('incrementele sync met syncToken: alleen wijzigingen, geannuleerd verdwijnt, 410 geeft volledige sync', async () => {
    const cal = make();
    await cal.listEvents(RANGE);
    clear();
    state[SELF]!.changes = [
      { id: 'evsun1', status: 'cancelled' },
      {
        ...feenstra,
        id: 'evnew',
        iCalUID: 'evnew@google.com',
        summary: 'Nieuw: TonZon x HomeZero',
        start: { dateTime: '2026-10-30T15:00:00+01:00' },
        end: { dateTime: '2026-10-30T16:00:00+01:00' },
      },
    ];
    const r = await cal.syncCalendar(SELF, { force: true });
    expect(r).toMatchObject({ changed: 2, full: false });
    const inc = requests.find((x) => x.url.searchParams.get('syncToken'))!;
    expect(inc.url.searchParams.get('syncToken')).toBe('sync-self-1');
    // Bij een syncToken geen tijdvenster (Google weigert die combinatie).
    expect(inc.url.searchParams.get('timeMin')).toBeNull();
    const titles = (await cal.listEvents(RANGE)).map((e) => e.title);
    expect(titles).toContain('Nieuw: TonZon x HomeZero');
    expect(titles).not.toContain('Sunergy');

    state[SELF]!.gone = true;
    clear();
    const g = await cal.syncCalendar(SELF, { force: true });
    expect(g.full).toBe(true);
    expect(requests.some((x) => x.url.searchParams.get('timeMin'))).toBe(true);
  });

  it('elke collega heeft een eigen cache (geen gedeelde agenda tussen collega’s)', async () => {
    const store = new MemorySyncStore();
    const cal = new LiveCalendar(creds(), { store, now: NOW });
    await withUserScope('user-a', () => cal.listEvents(RANGE));
    const keys = [...store.data.keys()];
    expect(keys.every((k) => k.startsWith('user-a|'))).toBe(true);
    clear();
    await withUserScope('user-b', () => cal.listEvents(RANGE));
    expect(requests.some((x) => !x.url.searchParams.get('syncToken') && x.url.pathname.includes('/events'))).toBe(true);
  });

  it('reageren op een uitnodiging: alleen de eigen deelnemer, alleen na een klik', async () => {
    let patched: unknown = null;
    server.use(
      http.get(`${G}/calendars/:cal/events/:id`, () => HttpResponse.json(sunergy)),
      http.patch(`${G}/calendars/:cal/events/:id`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ ...sunergy, ...(patched as object) });
      }),
    );
    const cal = make();
    await cal.listEvents(RANGE);
    await expect(cal.respond('ev:evsun1', 'accepted')).rejects.toBeInstanceOf(NotHumanError);
    await withHumanAction('u1', () => withUserScope('u1', () => cal.respond('ev:evsun1', 'accepted')));
    expect(patched).toEqual({
      attendees: [
        { email: 'bjorn@sunergy.example', displayName: 'Bjorn', organizer: true, responseStatus: 'accepted' },
        { email: SELF, self: true, responseStatus: 'accepted' },
      ],
    });
  });

  it('vrije tijden: freebusy.query in Europe/Amsterdam, per collega bezet of fout', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${G}/freeBusy`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          calendars: {
            [SELF]: { busy: [{ start: '2026-10-26T09:00:00Z', end: '2026-10-26T10:00:00Z' }] },
            'mike@homezero.nl': { busy: [{ start: '2026-10-24T22:30:00Z', end: '2026-10-25T01:30:00Z' }] },
            'onbekend@homezero.nl': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
          },
        });
      }),
    );
    const r = await make().freeBusy([SELF, 'mike@homezero.nl', 'onbekend@homezero.nl'], {
      from: '2026-10-25',
      to: '2026-10-27',
    });
    // 25 oktober 2026: zomertijd eindigt (03:00 CEST -> 02:00 CET).
    expect(body).toMatchObject({
      timeMin: '2026-10-24T22:00:00.000Z',
      timeMax: '2026-10-26T23:00:00.000Z',
      timeZone: 'Europe/Amsterdam',
    });
    expect(r[0]).toEqual({ email: SELF, busy: [{ start: '2026-10-26T10:00', end: '2026-10-26T11:00' }] });
    expect(r[1]!.busy).toEqual([{ start: '2026-10-25T00:30', end: '2026-10-25T02:30' }]);
    expect(r[2]).toMatchObject({ email: 'onbekend@homezero.nl', error: 'notFound' });
  });

  it('afspraak maken: wandklok + timeZone, Meet, uitnodigingen via Google (sendUpdates=all), alleen na een klik', async () => {
    let req: { url: URL; body: Record<string, unknown> } | null = null;
    server.use(
      http.post(`${G}/calendars/:cal/events`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        req = { url: new URL(request.url), body };
        return HttpResponse.json({
          id: 'evcreated',
          status: 'confirmed',
          summary: body.summary,
          start: { dateTime: '2026-03-30T10:00:00+02:00' },
          end: { dateTime: '2026-03-30T10:30:00+02:00' },
          hangoutLink: 'https://meet.google.com/new-meet-xyz',
          organizer: { email: SELF, self: true },
          attendees: [
            { email: SELF, self: true, organizer: true, responseStatus: 'accepted' },
            { email: 'mike@homezero.nl', responseStatus: 'needsAction' },
          ],
        });
      }),
    );
    const cal = make();
    const input = {
      title: 'Sparren partnerovereenkomst',
      start: '2026-03-30T10:00',
      end: '2026-03-30T10:30',
      attendees: ['mike@homezero.nl'],
      meet: true,
    };
    await expect(cal.createEvent(input)).rejects.toBeInstanceOf(NotHumanError);
    expect(req).toBeNull();
    const ev = await withHumanAction('u1', () => withUserScope('u1', () => cal.createEvent(input)));
    expect(req!.url.searchParams.get('sendUpdates')).toBe('all');
    expect(req!.url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(req!.body).toMatchObject({
      summary: 'Sparren partnerovereenkomst',
      start: { dateTime: '2026-03-30T10:00:00', timeZone: 'Europe/Amsterdam' },
      end: { dateTime: '2026-03-30T10:30:00', timeZone: 'Europe/Amsterdam' },
      attendees: [{ email: 'mike@homezero.nl' }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    // Eerste werkdag na de overgang naar zomertijd (29 maart 2026): 10:00 blijft 10:00.
    expect(ev).toMatchObject({
      id: 'ev:evcreated',
      start: '2026-03-30T10:00',
      end: '2026-03-30T10:30',
      meet: 'https://meet.google.com/new-meet-xyz',
    });
  });

  it('rate limit (429) wordt een RateLimitError met Retry-After', async () => {
    server.use(
      http.get(
        `${G}/users/me/calendarList`,
        () => new HttpResponse('{}', { status: 429, headers: { 'retry-after': '12' } }),
      ),
    );
    const e = await make()
      .listCalendars()
      .catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).retryAfterMs).toBe(12_000);
  });
});

describe('tijdzone rond zomertijd (Europe/Amsterdam)', () => {
  const at = (dateTime: string) =>
    mapEvent({ id: 'x', start: { dateTime }, end: { dateTime } }, { calId: SELF, selfEmail: SELF })!.start;
  it('voorjaar: 29 maart 2026 02:00 CET -> 03:00 CEST', () => {
    expect(at('2026-03-29T00:59:00Z')).toBe('2026-03-29T01:59');
    expect(at('2026-03-29T01:00:00Z')).toBe('2026-03-29T03:00');
    expect(at('2026-03-29T09:00:00+02:00')).toBe('2026-03-29T09:00');
  });
  it('najaar: 25 oktober 2026 03:00 CEST -> 02:00 CET (02:30 komt twee keer voor)', () => {
    expect(at('2026-10-25T00:30:00Z')).toBe('2026-10-25T02:30');
    expect(at('2026-10-25T01:30:00Z')).toBe('2026-10-25T02:30');
    expect(at('2026-10-26T09:00:00Z')).toBe('2026-10-26T10:00');
  });
  it('afspraak in een andere tijdzone komt in Amsterdamse tijd', () => {
    expect(at('2026-07-01T09:00:00-04:00')).toBe('2026-07-01T15:00');
  });
});
