/**
 * Samenstellen van wat de schermen nodig hebben uit de providers, de app-opslag en de contextlaag.
 * Eén plek, zodat Dagstart, Planning en zoeken dezelfde items zien (zoals rebuild() in het prototype).
 */
import type { CalendarInfo, ContextSnapshot, Item, MeetingItem, Partner, ProviderName, User } from '@hz/shared';
import {
  addDays,
  calDefaults,
  catchGroups,
  decorate,
  isMine,
  orgFromChannel,
  orgFromDomain,
  orgIndex,
  weekdoelToItem,
  ymd,
  type OrgIndex,
} from '@hz/shared/logic';
import type { ProviderBundle } from '@hz/providers';
import type { AppStore } from './store';

export interface Ctx {
  bundle: ProviderBundle;
  store: AppStore;
  user: User;
  /** Stuk E1: heeft deze bron een OAuth-flow (client ingericht)? Dan levert hij alleen iets als hij gekoppeld is. */
  hasFlow?: (p: ProviderName) => Promise<boolean>;
}

/** Stuk E1: bronnen met een eigen koppeling (wispr komt uit de contextlaag en heeft er geen). */
const GATED: ProviderName[] = ['google_tasks', 'calendar', 'gmail', 'slack', 'jira', 'github'];
export type Readable = (p: ProviderName) => boolean;

/**
 * Mag de app deze bron lezen? Met een OAuth-flow alleen als de koppeling 'connected' is (geen rij, ontkoppeld,
 * fout of opnieuw verbinden = niets). Zonder flow (fixture-modus zonder client) staat hij aan tot je hem ontkoppelt.
 */
export function sourceReadable(status: string | undefined, hasFlow: boolean) {
  return hasFlow ? status === 'connected' : status !== 'disconnected';
}

export async function readableSources(ctx: Ctx): Promise<Readable> {
  const conns = await ctx.store.connections(ctx.user.id);
  const flows = new Map<ProviderName, boolean>();
  if (ctx.hasFlow) await Promise.all(GATED.map(async (p) => flows.set(p, await ctx.hasFlow!(p))));
  return (p) => sourceReadable(conns[p]?.status, flows.get(p) ?? false);
}

/** Persoonlijk-repo (taken.md, wachten-op.md) alleen met een gekoppelde GitHub. */
export const persFor = (snap: ContextSnapshot, readable: Readable) => (readable('github') ? snap.pers : null);

export interface SourceError {
  provider: ProviderName;
  message: string;
}

async function safe<T>(provider: ProviderName, errors: SourceError[], fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errors.push({ provider, message: e instanceof Error ? e.message : String(e) });
    return fallback;
  }
}

const GENERIC =
  /(^|\.)(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.nl|icloud\.com|me\.com|google\.com|atlassian\.net|slack\.com)$/;

/** Organisaties herkennen op e-maildomein, Slack-kanaal en naam in de tekst (register is leidend). */
export function recognize(items: Item[], idx: OrgIndex, selfDomain: string): Item[] {
  const slugs = Object.keys(idx.bySlug).filter((s) => s.length >= 4);
  return items.map((it) => {
    if (it.entities.length) return it;
    const found = new Set<string>();
    const from = 'from' in it && typeof it.from === 'string' ? it.from : undefined;
    if (from) {
      const dom = from.split('@')[1]?.toLowerCase() ?? '';
      if (dom && dom !== selfDomain && !GENERIC.test(dom)) {
        const s = orgFromDomain(idx, dom);
        if (s) found.add(s);
      }
    }
    if (it.type === 'meeting' && it.attendees) {
      for (const a of it.attendees) {
        const dom = a.email.split('@')[1]?.toLowerCase() ?? '';
        const s = dom && dom !== selfDomain ? orgFromDomain(idx, dom) : null;
        if (s) found.add(s);
      }
    }
    if (it.type === 'slack') {
      const s = orgFromChannel(idx, it.channel);
      if (s) found.add(s);
    }
    if (!found.size) {
      const hay = String(it.title + ' ' + (it.type === 'rec' ? '' : ('body' in it && it.body) || ''))
        .toLowerCase()
        .slice(0, 4000);
      for (const s of slugs) if (new RegExp('\\b' + s.replace(/[-]/g, '[- ]?')).test(hay)) found.add(s);
      for (const [norm, slug] of Object.entries(idx.byNorm))
        if (
          norm.length >= 4 &&
          hay
            .replace(/[^a-z0-9]/g, ' ')
            .split(/\s+/)
            .includes(norm)
        )
          found.add(slug);
    }
    return found.size ? { ...it, entities: [...found].slice(0, 2) } : it;
  });
}

export interface Collected {
  now: Date;
  items: Item[];
  agenda: MeetingItem[];
  calendars: CalendarInfo[];
  context: ContextSnapshot;
  errors: SourceError[];
}

/** Alle items voor de ingelogde collega (allItems() + AGENDA_EVENTS uit het prototype). */
export async function collect(ctx: Ctx, range?: { from?: string; to?: string }): Promise<Collected> {
  const { providers: p, now: clock } = ctx.bundle;
  const now = clock();
  const errors: SourceError[] = [];
  const T = ymd(now);
  const from = range?.from ?? ymd(addDays(now, -7));
  const to = range?.to ?? ymd(addDays(now, 28));
  const selfDomain = ctx.user.email.split('@')[1] ?? 'homezero.nl';

  // Stuk E1: een bron levert alleen iets als hij gekoppeld is (ook niet uit fixtures); zie sourceReadable.
  const readable = await readableSources(ctx);
  const src = <T>(prov: ProviderName, fallback: T, fn: () => Promise<T>) =>
    readable(prov) ? safe(prov, errors, fallback, fn) : Promise.resolve(fallback);

  const [rawCals, meetings, mails, slack, tasks, recs, jira, snapshot, state, goals, legacy] = await Promise.all([
    src('calendar', [], () => p.calendar.listCalendars()),
    src('calendar', [], () => p.calendar.listEvents({ from, to })),
    src('gmail', [], () => p.gmail.listThreads()),
    src('slack', [], () => p.slack.attention()),
    src('google_tasks', [], () => p.tasks.listTasks()),
    src('wispr', [], () => p.wispr.listMeetings(ymd(addDays(now, -7)))),
    src('jira', { sprint: null, issues: [] }, () => p.jira.activeSprint()),
    safe<ContextSnapshot>('github', errors, { status: null, partners: {}, acties: {}, pers: null }, () =>
      p.context.snapshot(),
    ),
    ctx.store.itemStates(ctx.user.id),
    ctx.store.weekdoelen(ctx.user.id),
    ctx.store.legacyCommits(ctx.user.id),
  ]);
  const context: ContextSnapshot = { ...snapshot, pers: persFor(snapshot, readable) };

  const calendars = calDefaults(rawCals, ctx.user.email);
  const calById = new Map(calendars.map((c) => [c.id, c]));
  const annotated = meetings
    .map((m) => {
      const cal = m.calId ? calById.get(m.calId) : undefined;
      return {
        ...m,
        evColor: m.evColor ?? cal?.color,
        calName: cal?.summary,
        agendaOnly: cal ? cal.scope === 'agenda' : false,
        _on: cal ? cal.on : true,
      };
    })
    .filter((m) => m._on)
    .map(({ _on, ...m }) => m as MeetingItem);

  // Status zoals commitStatus() in het prototype: open met een verstreken deadline is te laat.
  const commitItems = [
    ...legacy.map((c) => ({
      ...c,
      status: c.status === 'open' && c.deadline && c.deadline < T ? ('te_laat' as const) : c.status,
      due: c.plan || c.deadline || null,
    })),
    ...goals.map((g) => weekdoelToItem(g, T)),
  ];
  let items: Item[] = [...annotated, ...recs, ...mails, ...slack, ...tasks, ...jira.issues, ...commitItems];
  items = recognize(items, orgIndex(context.partners), selfDomain);
  items = items.map((it) => {
    const key = stateKey(it);
    const st = state[key];
    if (!st) return it;
    const next = { ...it, read: st.read ?? it.read } as Item;
    if (next.type === 'rec') next.processed = st.processed ?? next.processed;
    if (next.type === 'meeting') next.skipPrep = st.skipPrep ?? next.skipPrep;
    if (next.type === 'slack' && st.answeredBy) next.answered = true;
    return next;
  });
  items = decorate(items, now);
  const agenda = items.filter((i): i is MeetingItem => i.type === 'meeting');
  return {
    now,
    items: items.filter((i) => !(i.type === 'meeting' && i.agendaOnly)),
    agenda,
    calendars,
    context,
    errors,
  };
}

/** Sleutel voor itemstate (zoals stateKey() in het prototype). */
export const stateKey = (it: Item) =>
  it.type === 'task'
    ? 'tk:' + it.rawId
    : it.type === 'rec'
      ? 'wm:' + it.rawId
      : it.id.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 190);

/** Slanke partnerlijst voor Dagstart (namen en geheim_voor; geen Kern of meetings). */
export function slimContext(snap: ContextSnapshot): ContextSnapshot {
  const partners: Record<string, Partner> = {};
  for (const [slug, p] of Object.entries(snap.partners)) {
    partners[slug] = { ...p, kern: '', stand: [], contacten: [], meetings: [], log: [] };
  }
  return { ...snap, partners };
}

export const firstName = (u: User) => (u.name || u.email.split('@')[0] || '').split(/\s+/)[0]!;

export function catchCount(items: Item[], now: Date) {
  return catchGroups(items, now).length;
}

export function myPartnerActies(snap: ContextSnapshot, user: User) {
  const fn = firstName(user);
  return Object.values(snap.acties)
    .map((d) => ({ ...d, acties: d.acties.filter((a) => a.state === 'open' && isMine(a, fn)) }))
    .filter((d) => d.acties.length);
}
