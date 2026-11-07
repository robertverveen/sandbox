/**
 * HZW-030: Google Calendar API v3 (live).
 *
 * - Alle agenda's in het werkaccount (calendarList.list), ook gedeelde privé-agenda's en die van Lou.
 * - Incrementele sync per agenda met nextSyncToken: eerst een volledige sync over een venster, daarna alleen
 *   wijzigingen (geannuleerd = weg uit de cache). 410 Gone -> opnieuw volledig. De cache staat in de SyncStore.
 * - Tijden altijd Europe/Amsterdam-wandklok (toLocal); bij aanmaken stuurt de app wandklok + timeZone mee,
 *   zodat zomer- en wintertijd kloppen.
 * - Afspraak maken alleen na een klik van een mens; Google stuurt de uitnodigingen (sendUpdates=all).
 * - Push: events.watch per agenda (kanaal wekelijks vernieuwen, zie de sync-motor in de worker).
 */
import type { BusyBlock, MeetingItem, NewEvent } from '@hz/shared';
import { addDays, amsterdamToInstant, toLocal, TZ, ymd } from '@hz/shared/logic';
import type { CalendarProvider, DateRange } from '../types';
import { GoneError, HttpClient, type LiveCredentials } from './http';
import { MemorySyncStore, type SyncStore } from './store';
import { assertHumanAction } from './tokens';

export const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/** Kleuren van Google (colorId -> hex), zoals in het prototype. */
export const EVENT_COLORS: Record<string, string> = {
  1: '#7986cb',
  2: '#33b679',
  3: '#8e24aa',
  4: '#e67c73',
  5: '#f6bf26',
  6: '#f4511e',
  7: '#039be5',
  8: '#616161',
  9: '#3f51b5',
  10: '#0b8043',
  11: '#d50000',
};

export interface GCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  backgroundColor?: string;
  accessRole?: string;
  hidden?: boolean;
  deleted?: boolean;
}

export interface GEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}
export interface GAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: 'needsAction' | 'accepted' | 'tentative' | 'declined';
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  optional?: boolean;
}
export interface GEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  iCalUID?: string;
  colorId?: string;
  visibility?: string;
  eventType?: string;
  start?: GEventTime;
  end?: GEventTime;
  originalStartTime?: GEventTime;
  attendees?: GAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

interface EventsPage {
  items?: GEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface CalendarCache {
  /** Venster van de volledige sync (JJJJ-MM-DD, from inclusief, to exclusief). */
  from: string;
  to: string;
  syncToken: string | null;
  syncedAt: number;
  events: Record<string, GEvent>;
}

/** Naam uit e-mail (zoals nameFromEmail() in het prototype). */
export function nameFromEmail(email?: string): string {
  if (!email) return '';
  const m = /^\s*"?([^"<]+?)"?\s*<([^>]+)>/.exec(email);
  if (m) return m[1]!.trim();
  const local = email.split('@')[0]!.replace(/[0-9]+$/, '');
  const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
  const parts = local.split(/[._-]/).filter(Boolean);
  return parts.length > 1 ? parts.map(cap).join(' ') : cap(local);
}

const stripHtml = (s?: string) =>
  (s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

/** Google-tijd -> wandklok. Hele dag blijft JJJJ-MM-DD (einde exclusief, zoals Google). */
export function gTimeToLocal(t?: GEventTime): string {
  if (!t) return '';
  if (t.dateTime) return toLocal(new Date(t.dateTime));
  return t.date ?? '';
}

export interface MapOptions {
  calId: string;
  selfEmail: string;
}

/** Ruwe afspraak -> MeetingItem (null als hij niet getoond hoort: geannuleerd, werklocatie, afgewezen). */
export function mapEvent(ev: GEvent, o: MapOptions): MeetingItem | null {
  if (!ev?.id || ev.status === 'cancelled' || ev.eventType === 'workingLocation') return null;
  const selfDomain = o.selfEmail.split('@')[1]?.toLowerCase() ?? '';
  const atts = (ev.attendees ?? [])
    .filter((a) => !a.resource)
    .map((a) => ({
      email: (a.email ?? '').toLowerCase(),
      name: a.displayName || nameFromEmail(a.email),
      responseStatus: a.responseStatus,
      self: !!a.self,
      organizer: !!a.organizer,
    }));
  const me = atts.find((a) => a.self);
  if (me?.responseStatus === 'declined') return null;
  const meet =
    ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? undefined;
  const external = atts.some((a) => {
    const d = a.email.split('@')[1] ?? '';
    return d && d !== selfDomain && !d.endsWith('calendar.google.com');
  });
  return {
    id: 'ev:' + ev.id,
    type: 'meeting',
    title: ev.summary || (ev.visibility === 'private' ? '(privé)' : '(geen titel)'),
    start: gTimeToLocal(ev.start),
    end: gTimeToLocal(ev.end) || gTimeToLocal(ev.start),
    allDay: !ev.start?.dateTime,
    calId: o.calId,
    attendeeNames: atts.map((a) => a.name),
    attendees: atts.map(({ name, ...a }) => ({ ...a, name })),
    where: ev.location || (meet ? 'Google Meet' : undefined),
    meet,
    url: ev.htmlLink ?? null,
    external,
    needsAction: me?.responseStatus === 'needsAction',
    organizerName: ev.organizer?.self ? 'jij' : ev.organizer?.displayName || nameFromEmail(ev.organizer?.email),
    ooo: ev.eventType === 'outOfOffice',
    evColor: ev.colorId ? EVENT_COLORS[ev.colorId] : undefined,
    entities: [],
    ...(ev.description ? { body: stripHtml(ev.description).slice(0, 2000) } : {}),
  } as MeetingItem;
}

export interface LiveCalendarOptions {
  store?: SyncStore;
  /** Zo lang geldt de cache als vers zonder incrementele sync (ms). */
  freshMs?: number;
  /** Standaardvenster van een volledige sync rond vandaag (dagen terug, dagen vooruit). */
  window?: { back: number; ahead: number };
  now?: () => Date;
  base?: string;
  fetchImpl?: typeof fetch;
}

export class LiveCalendar implements CalendarProvider {
  readonly mode = 'live' as const;
  readonly http: HttpClient;
  readonly store: SyncStore;
  private o: Required<Omit<LiveCalendarOptions, 'store' | 'base' | 'fetchImpl'>>;

  constructor(
    readonly creds: LiveCredentials,
    opts: LiveCalendarOptions = {},
  ) {
    this.http = new HttpClient('calendar', opts.base ?? GOOGLE_CALENDAR_BASE, creds, opts.fetchImpl);
    this.store = opts.store ?? new MemorySyncStore();
    this.o = {
      freshMs: opts.freshMs ?? 60_000,
      window: opts.window ?? { back: 35, ahead: 120 },
      now: opts.now ?? (() => new Date()),
    };
  }

  async rawCalendars(): Promise<GCalendarListEntry[]> {
    const out: GCalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.http.json<{ items?: GCalendarListEntry[]; nextPageToken?: string }>(
        '/users/me/calendarList',
        { query: { maxResults: 250, pageToken } },
      );
      out.push(...(r.items ?? []).filter((c) => !c.deleted));
      pageToken = r.nextPageToken;
    } while (pageToken);
    await this.store.set('calendar:list', { at: Date.now(), items: out });
    return out;
  }

  private async calendarsCached(): Promise<GCalendarListEntry[]> {
    const c = await this.store.get<{ at: number; items: GCalendarListEntry[] }>('calendar:list');
    if (c && Date.now() - c.at < 10 * 60_000) return c.items;
    return this.rawCalendars();
  }

  async listCalendars() {
    return (await this.calendarsCached()).map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      primary: !!c.primary,
      ...(c.backgroundColor ? { backgroundColor: c.backgroundColor } : {}),
    }));
  }

  private cacheKey = (calId: string) => `calendar:events:${calId}`;

  /** Volledige sync over een venster; bewaart nextSyncToken. */
  async fullSync(calId: string, from: string, to: string): Promise<CalendarCache> {
    const events: Record<string, GEvent> = {};
    let pageToken: string | undefined;
    let syncToken: string | null = null;
    do {
      const r = await this.http.json<EventsPage>(`/calendars/${encodeURIComponent(calId)}/events`, {
        query: {
          singleEvents: true,
          maxResults: 2500,
          timeMin: amsterdamToInstant(from).toISOString(),
          timeMax: amsterdamToInstant(to).toISOString(),
          timeZone: TZ,
          pageToken,
        },
      });
      for (const ev of r.items ?? []) if (ev.status !== 'cancelled') events[ev.id] = ev;
      pageToken = r.nextPageToken;
      if (r.nextSyncToken) syncToken = r.nextSyncToken;
    } while (pageToken);
    const cache: CalendarCache = { from, to, syncToken, syncedAt: Date.now(), events };
    await this.store.set(this.cacheKey(calId), cache);
    return cache;
  }

  /**
   * Incrementele sync met de syncToken: alleen wijzigingen. Geeft het aantal gewijzigde afspraken terug,
   * zodat de worker weet of er een SSE-event nodig is. 410 -> volledige sync.
   */
  async syncCalendar(
    calId: string,
    opts: { force?: boolean; range?: DateRange } = {},
  ): Promise<{ cache: CalendarCache; changed: number; full: boolean }> {
    const now = this.o.now();
    const want = opts.range ?? {
      from: ymd(addDays(now, -this.o.window.back)),
      to: ymd(addDays(now, this.o.window.ahead)),
    };
    const cur = await this.store.get<CalendarCache>(this.cacheKey(calId));
    const covers = cur && cur.from <= want.from && cur.to >= want.to;
    if (!cur || !covers || !cur.syncToken) {
      const from = cur && cur.from < want.from ? cur.from : want.from;
      const to = cur && cur.to > want.to ? cur.to : want.to;
      const cache = await this.fullSync(calId, from, to);
      return { cache, changed: Object.keys(cache.events).length, full: true };
    }
    if (!opts.force && Date.now() - cur.syncedAt < this.o.freshMs) return { cache: cur, changed: 0, full: false };
    let changed = 0;
    let pageToken: string | undefined;
    let syncToken = cur.syncToken;
    try {
      do {
        const r = await this.http.json<EventsPage>(`/calendars/${encodeURIComponent(calId)}/events`, {
          query: { singleEvents: true, maxResults: 2500, syncToken: cur.syncToken, pageToken },
        });
        for (const ev of r.items ?? []) {
          changed++;
          if (ev.status === 'cancelled') delete cur.events[ev.id];
          else cur.events[ev.id] = ev;
        }
        pageToken = r.nextPageToken;
        if (r.nextSyncToken) syncToken = r.nextSyncToken;
      } while (pageToken);
    } catch (e) {
      if (e instanceof GoneError) {
        const cache = await this.fullSync(calId, cur.from, cur.to);
        return { cache, changed: Object.keys(cache.events).length, full: true };
      }
      throw e;
    }
    const cache = { ...cur, syncToken, syncedAt: Date.now() };
    await this.store.set(this.cacheKey(calId), cache);
    return { cache, changed, full: false };
  }

  private async selfEmail(cals: GCalendarListEntry[]) {
    return (cals.find((c) => c.primary)?.id ?? '').toLowerCase();
  }

  async listEvents(range: DateRange): Promise<MeetingItem[]> {
    const cals = await this.calendarsCached();
    const self = await this.selfEmail(cals);
    // Eigen agenda eerst, zodat jouw reactie (accepted/needsAction) leidend is bij dubbele afspraken.
    const ordered = [...cals].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
    const synced = await Promise.all(
      ordered.map(async (c) => ({
        calId: c.id,
        cache: (await this.syncCalendar(c.id, { range: this.widen(range) })).cache,
      })),
    );
    const seen = new Set<string>();
    const seenTitle = new Set<string>();
    const out: MeetingItem[] = [];
    for (const { calId, cache } of synced) {
      for (const ev of Object.values(cache.events)) {
        const startKey = ev.originalStartTime?.dateTime || ev.start?.dateTime || ev.start?.date || '';
        const k = ev.iCalUID ? `${ev.iCalUID}|${startKey}` : ev.id;
        const k2 = `${(ev.summary ?? '').trim().toLowerCase()}|${ev.start?.dateTime ? +new Date(ev.start.dateTime) : ev.start?.date}`;
        if (seen.has(k) || (ev.summary && seenTitle.has(k2))) continue;
        const m = mapEvent(ev, { calId, selfEmail: self });
        if (!m) continue;
        const d = m.start.slice(0, 10);
        const e = (m.end || m.start).slice(0, 10);
        if (!(e >= range.from && d < range.to)) continue;
        seen.add(k);
        if (ev.summary) seenTitle.add(k2);
        out.push(m);
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  /** Vraag minstens het standaardvenster op, zodat kleine verschuivingen geen volledige sync geven. */
  private widen(r: DateRange): DateRange {
    const now = this.o.now();
    const from = ymd(addDays(now, -this.o.window.back));
    const to = ymd(addDays(now, this.o.window.ahead));
    return { from: r.from < from ? r.from : from, to: r.to > to ? r.to : to };
  }

  /** In welke agenda staat deze afspraak (eigen agenda eerst). */
  private async locate(rawId: string): Promise<string> {
    const cals = [...(await this.calendarsCached())].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
    for (const c of cals) {
      const cache = await this.store.get<CalendarCache>(this.cacheKey(c.id));
      if (cache?.events[rawId]) return c.id;
    }
    return 'primary';
  }

  async respond(eventId: string, response: 'accepted' | 'tentative' | 'declined'): Promise<void> {
    assertHumanAction('calendar', 'reageren op een uitnodiging');
    const rawId = eventId.replace(/^ev:/, '');
    const calId = await this.locate(rawId);
    const path = `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(rawId)}`;
    const ev = await this.http.json<GEvent>(path);
    const attendees = (ev.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: response } : a));
    if (!attendees.some((a) => a.self)) throw new Error('je staat niet op de gastenlijst van deze afspraak');
    const next = await this.http.json<GEvent>(path, { method: 'PATCH', body: { attendees } });
    const key = this.cacheKey(calId);
    const cache = await this.store.get<CalendarCache>(key);
    if (cache) {
      cache.events[rawId] = next;
      await this.store.set(key, cache);
    }
  }

  async freeBusy(emails: string[], range: DateRange) {
    const r = await this.http.json<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }>;
    }>('/freeBusy', {
      method: 'POST',
      body: {
        timeMin: amsterdamToInstant(range.from).toISOString(),
        timeMax: amsterdamToInstant(range.to).toISOString(),
        timeZone: TZ,
        items: emails.map((id) => ({ id })),
      },
    });
    return emails.map((email) => {
      const c = r.calendars?.[email] ?? r.calendars?.[email.toLowerCase()];
      const busy: BusyBlock[] = (c?.busy ?? []).map((b) => ({
        start: toLocal(new Date(b.start)),
        end: toLocal(new Date(b.end)),
      }));
      const err = c?.errors?.[0]?.reason ?? (c ? undefined : 'notFound');
      return err ? { email, busy, error: err } : { email, busy };
    });
  }

  async createEvent(e: NewEvent): Promise<MeetingItem> {
    assertHumanAction('calendar', 'een afspraak met uitnodigingen maken');
    const calId = e.calendarId ?? 'primary';
    const sec = (s: string) => (s.length === 16 ? `${s}:00` : s);
    const body: Record<string, unknown> = {
      summary: e.title,
      description: e.description,
      location: e.location,
      start: { dateTime: sec(e.start), timeZone: TZ },
      end: { dateTime: sec(e.end), timeZone: TZ },
      attendees: e.attendees.map((email) => ({ email })),
    };
    if (e.meet)
      body.conferenceData = {
        createRequest: {
          requestId: `hz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    const ev = await this.http.json<GEvent>(`/calendars/${encodeURIComponent(calId)}/events`, {
      method: 'POST',
      query: { sendUpdates: 'all', conferenceDataVersion: e.meet ? 1 : undefined },
      body,
    });
    const cals = await this.calendarsCached().catch(() => []);
    const self = (await this.selfEmail(cals)) || '';
    const realCal = calId === 'primary' ? (cals.find((c) => c.primary)?.id ?? calId) : calId;
    const key = this.cacheKey(realCal);
    const cache = await this.store.get<CalendarCache>(key);
    if (cache) {
      cache.events[ev.id] = ev;
      await this.store.set(key, cache);
    }
    return mapEvent(ev, { calId: realCal, selfEmail: self })!;
  }

  /** Push-kanaal (events.watch). Google stuurt dan een POST naar `address` bij elke wijziging. */
  async watch(calId: string, ch: { id: string; address: string; token: string; ttlSeconds?: number }) {
    return this.http.json<{ id: string; resourceId: string; expiration?: string }>(
      `/calendars/${encodeURIComponent(calId)}/events/watch`,
      {
        method: 'POST',
        body: {
          id: ch.id,
          type: 'web_hook',
          address: ch.address,
          token: ch.token,
          params: { ttl: String(ch.ttlSeconds ?? 7 * 24 * 3600) },
        },
      },
    );
  }

  async stopWatch(id: string, resourceId: string) {
    await this.http.json('/channels/stop', { method: 'POST', body: { id, resourceId } });
  }
}
