/**
 * Sync-motor (HZW-036): achtergrondjobs per collega en bron.
 *
 * - Push waar het kan (Slack Events, Agenda-kanalen via events.watch, Gmail via Pub/Sub), anders pollen.
 *   Een webhook haalt de run naar voren (requestSync + NOTIFY hz_sync); de planner draait elke minuut.
 * - Elke run werkt voor één collega onder RLS (withUserScope + withUser in de opslag).
 * - Fouten: rate limit -> wachten volgens Retry-After (minstens de terugval); token afgewezen -> needs_reauth;
 *   tijdelijk -> exponentiële terugval met spreiding; niet gekoppeld -> pauze.
 * - Dubbele events worden bij binnenkomst al genegeerd (sync_events, primaire sleutel); een event wordt hooguit
 *   één keer verwerkt (takeSyncEvents markeert in dezelfde transactie).
 * - Nieuwe data -> NOTIFY hz_events -> de API stuurt SSE `invalidate` naar de browser van die collega.
 * - De worker verstuurt nooit iets: hij roept geen postMessage, createEvent of reply aan.
 */
import type { SyncJobRow, SyncOutcome } from '@hz/db';
import {
  AuthError,
  GitHubContext,
  LiveCalendar,
  LiveGmail,
  LiveJira,
  LiveSlack,
  LiveTasks,
  NotConnectedError,
  RateLimitError,
  UserScopedGitHubContext,
  withUserScope,
  type Providers,
  type SyncStore,
} from '@hz/providers';
import { addDays, toLocal } from '@hz/shared/logic';

export const SYNC_QUEUES = { plan: 'sync.plan', run: 'sync.run' } as const;

/** Poll-interval per bron (ms). Met een actief push-kanaal alleen een veiligheidspoll. */
export const POLL_MS: Record<string, number> = {
  calendar: 5 * 60_000,
  google_tasks: 2 * 60_000,
  gmail: 2 * 60_000,
  slack: 3 * 60_000,
  jira: 15 * 60_000,
  wispr: 15 * 60_000,
  github: 10 * 60_000,
};
export const PUSH_POLL_MS = 30 * 60_000;

/** Welke querykeys in de browser opnieuw moeten bij nieuwe data van deze bron. */
export const INVALIDATE: Record<string, string[]> = {
  calendar: ['agenda', 'items', 'dagstart'],
  google_tasks: ['tasks', 'items', 'dagstart', 'tracker'],
  gmail: ['conversations', 'items', 'dagstart'],
  slack: ['conversations', 'items', 'dagstart'],
  jira: ['sprint', 'items', 'dagstart'],
  wispr: ['items', 'dagstart'],
  github: ['partners', 'items', 'dagstart', 'tracker', 'contextStatus'],
};

/** Exponentiële terugval met spreiding (±20%), van 30 s tot 30 min. */
export function backoffMs(failures: number, rand = Math.random, base = 30_000, max = 30 * 60_000) {
  const raw = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  return Math.round(raw * (0.8 + 0.4 * rand()));
}

/** Opslag van planning en events (Postgres in productie, geheugen in unit-tests). */
export interface SyncRepo {
  getJob(userId: string, provider: string): Promise<SyncJobRow | null>;
  markRunning(userId: string, provider: string, now: Date): Promise<void>;
  finish(userId: string, provider: string, o: SyncOutcome, now: Date): Promise<void>;
  takeEvents(userId: string, source: string): Promise<Array<{ event_id: string; payload: Record<string, unknown> }>>;
  notify(userId: string, keys: string[]): Promise<void>;
  markReauth?(userId: string, provider: string, reason: string): Promise<void>;
}

export interface SyncDeps {
  repo: SyncRepo;
  providers: Providers;
  store: SyncStore;
  now?: () => Date;
  rand?: () => number;
  log?: (m: string) => void;
  /** Publieke basis-URL voor push-kanalen (Agenda); zonder: alleen pollen. */
  publicUrl?: string;
  /** Pub/Sub-topic voor Gmail-push; zonder: alleen pollen. */
  gmailTopic?: string;
  /** Token voor een Agenda-kanaal (HMAC van het kanaal-id); de webhook controleert hem. */
  channelToken?: (channelId: string) => string;
}

interface Result {
  changed: number;
  push?: Record<string, unknown>;
  pushActive?: boolean;
}

async function syncCalendar(p: Providers, d: SyncDeps, job: SyncJobRow): Promise<Result> {
  const cal = p.calendar;
  if (!(cal instanceof LiveCalendar)) return { changed: 0 };
  const cals = await cal.rawCalendars();
  let changed = 0;
  for (const c of cals) changed += (await cal.syncCalendar(c.id, { force: true })).changed;
  // Push-kanalen per agenda; vernieuwen als ze binnen een dag verlopen (Google: max. ~7 dagen).
  if (!d.publicUrl || !d.channelToken) return { changed };
  const now = (d.now ?? (() => new Date()))();
  const channels = {
    ...((job.push.channels as Record<string, { calId: string; resourceId: string; expiration: number }>) ?? {}),
  };
  for (const c of cals) {
    const cur = Object.entries(channels).find(([, v]) => v.calId === c.id);
    if (cur && cur[1].expiration - +now > 864e5) continue;
    const id = `hz-${job.userId.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}`;
    const w = await cal.watch(c.id, {
      id,
      address: `${d.publicUrl}/api/hooks/google/calendar`,
      token: d.channelToken(id),
    });
    if (cur) {
      await cal.stopWatch(cur[0], cur[1].resourceId).catch(() => undefined);
      delete channels[cur[0]];
    }
    channels[id] = { calId: c.id, resourceId: w.resourceId, expiration: Number(w.expiration ?? +now + 7 * 864e5) };
  }
  return { changed, push: { ...job.push, channels }, pushActive: true };
}

async function syncGmail(p: Providers, d: SyncDeps, job: SyncJobRow): Promise<Result> {
  const g = p.gmail;
  if (!(g instanceof LiveGmail)) return { changed: 0 };
  // Pub/Sub-meldingen zeggen alleen "er is iets"; history.list vertelt wat. Meldingen zijn daarmee verwerkt.
  await d.repo.takeEvents(job.userId, 'gmail');
  const r = await g.pollChanges();
  if (!d.gmailTopic) return { changed: r.changed };
  const now = +(d.now ?? (() => new Date()))();
  const exp = Number(job.push.gmailExpiration ?? 0);
  if (exp - now > 864e5) return { changed: r.changed, pushActive: true };
  const w = await g.watch(d.gmailTopic);
  return { changed: r.changed, push: { ...job.push, gmailExpiration: Number(w.expiration) }, pushActive: true };
}

async function syncTasks(p: Providers): Promise<Result> {
  return p.tasks instanceof LiveTasks ? { changed: (await p.tasks.pollChanges()).changed } : { changed: 0 };
}

async function syncSlack(p: Providers, d: SyncDeps, job: SyncJobRow): Promise<Result> {
  const s = p.slack;
  if (!(s instanceof LiveSlack)) return { changed: 0 };
  let changed = 0;
  for (const e of await d.repo.takeEvents(job.userId, 'slack'))
    if (await s.applyEvent(e.payload as Parameters<LiveSlack['applyEvent']>[0])) changed++;
  const sig = (await s.listConversations())
    .filter((c) => c.unread)
    .map((c) => `${c.key}@${c.time ?? ''}`)
    .sort()
    .join('|');
  const prev = await d.store.get<string>('slack:unreadsig');
  if (prev !== sig) {
    await d.store.set('slack:unreadsig', sig);
    if (prev !== null) changed++;
  }
  return { changed, pushActive: true };
}

async function syncJira(p: Providers): Promise<Result> {
  return p.jira instanceof LiveJira ? { changed: (await p.jira.pollChanges()).changed } : { changed: 0 };
}

async function syncWispr(p: Providers, d: SyncDeps): Promise<Result> {
  if (p.wispr.mode !== 'live') return { changed: 0 };
  const now = (d.now ?? (() => new Date()))();
  const recs = await p.wispr.listMeetings(toLocal(addDays(now, -7)));
  const ids = recs.map((r) => r.rawId).sort();
  const prev = (await d.store.get<string[]>('wispr:seen')) ?? [];
  await d.store.set('wispr:seen', ids);
  return { changed: ids.filter((i) => !prev.includes(i)).length };
}

async function syncGithub(p: Providers, d: SyncDeps): Promise<Result> {
  const c = p.context;
  if (!(c instanceof UserScopedGitHubContext) && !(c instanceof GitHubContext)) return { changed: 0 };
  c.invalidate();
  const snap = await c.snapshot();
  const head = `${snap.status?.commit_context ?? ''}|${snap.status?.commit_prive ?? ''}`;
  const prev = await d.store.get<string>('github:head');
  await d.store.set('github:head', head);
  return { changed: prev !== null && prev !== head ? 1 : 0 };
}

const SYNCERS: Record<string, (p: Providers, d: SyncDeps, job: SyncJobRow) => Promise<Result>> = {
  calendar: syncCalendar,
  gmail: syncGmail,
  google_tasks: (p) => syncTasks(p),
  slack: syncSlack,
  jira: (p) => syncJira(p),
  wispr: (p, d) => syncWispr(p, d),
  github: (p, d) => syncGithub(p, d),
};

/** Eén run voor één collega en bron. Gooit nooit: de uitkomst staat in sync_jobs. */
export async function runSync(d: SyncDeps, userId: string, provider: string): Promise<SyncOutcome> {
  const now = (d.now ?? (() => new Date()))();
  const log = d.log ?? (() => undefined);
  const job = await d.repo.getJob(userId, provider);
  if (!job) return { status: 'disconnected', failures: 0, nextRunAt: now };
  const syncer = SYNCERS[provider];
  if (!syncer) {
    const o: SyncOutcome = {
      status: 'idle',
      failures: 0,
      nextRunAt: new Date(+now + 3600_000),
      error: 'onbekende bron',
    };
    await d.repo.finish(userId, provider, o, now);
    return o;
  }
  await d.repo.markRunning(userId, provider, now);
  let o: SyncOutcome;
  try {
    const r = await withUserScope(userId, () => syncer(d.providers, d, job));
    const interval = r.pushActive ? PUSH_POLL_MS : (POLL_MS[provider] ?? 10 * 60_000);
    o = {
      status: 'idle',
      failures: 0,
      nextRunAt: new Date(+now + interval),
      changed: r.changed,
      ok: true,
      push: r.push,
    };
    if (r.changed > 0) await d.repo.notify(userId, INVALIDATE[provider] ?? ['items']);
    log(`${provider} ${userId.slice(0, 8)}: ${r.changed} gewijzigd`);
  } catch (e) {
    const failures = job.failures + 1;
    if (e instanceof RateLimitError) {
      const wait = Math.max(e.retryAfterMs, backoffMs(failures, d.rand));
      o = {
        status: 'backoff',
        failures,
        nextRunAt: new Date(+now + wait),
        error: `rate limit (${Math.ceil(wait / 1000)} s)`,
      };
    } else if (e instanceof AuthError) {
      await d.repo.markReauth?.(userId, provider, 'token afgewezen');
      o = { status: 'needs_reauth', failures, nextRunAt: new Date(+now + 864e5), error: 'opnieuw koppelen' };
      await d.repo.notify(userId, ['connections']);
    } else if (e instanceof NotConnectedError) {
      o = { status: 'disconnected', failures: 0, nextRunAt: new Date(+now + 3600_000), error: 'niet gekoppeld' };
    } else {
      o = {
        status: 'error',
        failures,
        nextRunAt: new Date(+now + backoffMs(failures, d.rand)),
        // Geen inhoud in de foutmelding: alleen soort en status.
        error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : 'onbekende fout',
      };
    }
    log(`${provider} ${userId.slice(0, 8)}: ${o.status} (${o.error})`);
  }
  await d.repo.finish(userId, provider, o, now);
  return o;
}
