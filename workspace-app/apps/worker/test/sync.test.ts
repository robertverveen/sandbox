/**
 * HZW-036 zelftest (deel 1, zonder database): herhaalpogingen, rate limits, token afgewezen, en dat dubbele events
 * maar één keer verwerkt worden. Nep-bronnen via msw; niets gaat naar Google of Slack.
 */
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SyncJobRow, SyncOutcome } from '@hz/db';
import { createProviders, MemorySyncStore, GOOGLE_TASKS_BASE, SLACK_BASE, type LiveCredentials } from '@hz/providers';
import { backoffMs, INVALIDATE, POLL_MS, runSync, type SyncDeps, type SyncRepo } from '../src/sync';

const seen: Array<{ method: string; url: string }> = [];
const server = setupServer();
server.events.on('request:start', ({ request }) => void seen.push({ method: request.method, url: request.url }));
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class MemoryRepo implements SyncRepo {
  jobs = new Map<string, SyncJobRow>();
  events: Array<{
    userId: string;
    source: string;
    event_id: string;
    payload: Record<string, unknown>;
    done?: boolean;
  }> = [];
  notified: Array<{ userId: string; keys: string[] }> = [];
  reauth: string[] = [];
  add(userId: string, provider: string) {
    this.jobs.set(`${userId}|${provider}`, {
      userId,
      provider,
      account: null,
      status: 'idle',
      failures: 0,
      nextRunAt: new Date(0),
      lastRunAt: null,
      lastOkAt: null,
      lastChanged: 0,
      lastError: null,
      push: {},
    });
  }
  async getJob(u: string, p: string) {
    return this.jobs.get(`${u}|${p}`) ?? null;
  }
  async markRunning(u: string, p: string, now: Date) {
    Object.assign(this.jobs.get(`${u}|${p}`)!, { status: 'running', lastRunAt: now });
  }
  async finish(u: string, p: string, o: SyncOutcome, now: Date) {
    const j = this.jobs.get(`${u}|${p}`)!;
    Object.assign(j, {
      status: o.status,
      failures: o.failures,
      nextRunAt: o.nextRunAt,
      lastChanged: o.changed ?? 0,
      lastError: o.error ?? null,
    });
    if (o.ok) j.lastOkAt = now;
    if (o.push) j.push = o.push;
  }
  /** Zoals sync_events: (bron, event_id) uniek; dubbel = genegeerd. */
  record(userId: string, source: string, event_id: string, payload: Record<string, unknown>) {
    if (this.events.some((e) => e.source === source && e.event_id === event_id)) return false;
    this.events.push({ userId, source, event_id, payload });
    return true;
  }
  async takeEvents(u: string, s: string) {
    const out = this.events.filter((e) => e.userId === u && e.source === s && !e.done);
    for (const e of out) e.done = true;
    return out;
  }
  async notify(userId: string, keys: string[]) {
    this.notified.push({ userId, keys });
  }
  async markReauth(u: string, p: string) {
    this.reauth.push(`${u}|${p}`);
  }
}

const U = '11111111-1111-4111-8111-111111111111';
const creds: LiveCredentials = { accessToken: async () => 'tok' };
let now = new Date('2026-11-07T08:00:00Z');
let repo: MemoryRepo;
let deps: SyncDeps;
beforeEach(() => {
  seen.length = 0;
  now = new Date('2026-11-07T08:00:00Z');
  repo = new MemoryRepo();
  const store = new MemorySyncStore();
  const { providers } = createProviders({ HZ_LIVE_TASKS: '1', HZ_LIVE_SLACK: '1' }, creds, { store });
  deps = { repo, providers, store, now: () => now, rand: () => 0.5 };
});

const tasksOk = (items: unknown[] = []) => [
  http.get(`${GOOGLE_TASKS_BASE}/users/@me/lists`, () =>
    HttpResponse.json({ items: [{ id: 'L1', title: 'Mijn taken' }] }),
  ),
  http.get(`${GOOGLE_TASKS_BASE}/lists/L1/tasks`, () => HttpResponse.json({ items })),
];

describe('terugval en herhaalpogingen', () => {
  it('backoff groeit exponentieel, met spreiding, en heeft een plafond', () => {
    expect(backoffMs(1, () => 0.5)).toBe(30_000);
    expect(backoffMs(2, () => 0.5)).toBe(60_000);
    expect(backoffMs(5, () => 0.5)).toBe(480_000);
    expect(backoffMs(20, () => 0.5)).toBe(30 * 60_000);
    expect(backoffMs(3, () => 0)).toBe(96_000);
    expect(backoffMs(3, () => 1)).toBe(144_000);
  });

  it('rate limit: wachten volgens Retry-After (minstens de terugval), daarna herstel en een SSE-melding', async () => {
    repo.add(U, 'google_tasks');
    server.use(
      http.get(
        `${GOOGLE_TASKS_BASE}/users/@me/lists`,
        () =>
          new HttpResponse('{"error":{"message":"Rate Limit Exceeded"}}', {
            status: 429,
            headers: { 'retry-after': '120' },
          }),
      ),
    );
    // Eerste run zet het nulpunt van updatedMin; de lijsten-call komt pas bij de tweede.
    let o = await runSync(deps, U, 'google_tasks');
    expect(o).toMatchObject({ status: 'idle', failures: 0 });
    now = new Date(+now + POLL_MS.google_tasks!);
    o = await runSync(deps, U, 'google_tasks');
    expect(o.status).toBe('backoff');
    expect(o.failures).toBe(1);
    expect(+o.nextRunAt - +now).toBe(120_000);
    expect(o.error).toMatch(/rate limit/);
    // Nog een keer: Retry-After kleiner dan de terugval -> de terugval wint.
    server.use(
      http.get(
        `${GOOGLE_TASKS_BASE}/users/@me/lists`,
        () => new HttpResponse('{}', { status: 429, headers: { 'retry-after': '1' } }),
      ),
    );
    now = o.nextRunAt;
    o = await runSync(deps, U, 'google_tasks');
    expect(o.failures).toBe(2);
    expect(+o.nextRunAt - +now).toBe(60_000);
    // Herstel: een gewijzigde taak -> idle, teller op 0, gewone poll, invalidate naar de browser.
    server.use(...tasksOk([{ id: 't1', title: 'Nieuw', status: 'needsAction', updated: '2026-11-07T08:05:00Z' }]));
    now = o.nextRunAt;
    o = await runSync(deps, U, 'google_tasks');
    expect(o).toMatchObject({ status: 'idle', failures: 0, changed: 1, ok: true });
    expect(+o.nextRunAt - +now).toBe(POLL_MS.google_tasks);
    expect(repo.notified).toEqual([{ userId: U, keys: INVALIDATE.google_tasks }]);
  });

  it('tijdelijke fout (500): status error met terugval; geen melding naar de browser', async () => {
    repo.add(U, 'google_tasks');
    await runSync(deps, U, 'google_tasks');
    server.use(
      http.get(`${GOOGLE_TASKS_BASE}/users/@me/lists`, () =>
        HttpResponse.json({ error: { message: 'Backend Error' } }, { status: 503 }),
      ),
    );
    const o = await runSync(deps, U, 'google_tasks');
    expect(o).toMatchObject({ status: 'error', failures: 1 });
    expect(+o.nextRunAt - +now).toBe(30_000);
    expect(repo.notified).toEqual([]);
  });

  it('token afgewezen (401): needs_reauth, koppeling gemarkeerd, geen nieuwe pogingen voor een dag', async () => {
    repo.add(U, 'slack');
    server.use(
      http.get(`${SLACK_BASE}/users.conversations`, () => HttpResponse.json({ ok: false, error: 'token_revoked' })),
    );
    server.use(http.get(`${SLACK_BASE}/users.list`, () => HttpResponse.json({ ok: true, members: [] })));
    server.use(
      http.get(`${SLACK_BASE}/auth.test`, () => HttpResponse.json({ ok: true, user_id: 'UME', team_id: 'T' })),
    );
    const o = await runSync(deps, U, 'slack');
    expect(o.status).toBe('needs_reauth');
    expect(+o.nextRunAt - +now).toBe(864e5);
    expect(repo.reauth).toEqual([`${U}|slack`]);
    expect(repo.notified).toEqual([{ userId: U, keys: ['connections'] }]);
  });
});

describe('dubbele events', () => {
  it('een Slack-event dat twee keer binnenkomt wordt één keer verwerkt', async () => {
    repo.add(U, 'slack');
    let lastRead = '1793262000.000100';
    server.use(
      http.get(`${SLACK_BASE}/auth.test`, () => HttpResponse.json({ ok: true, user_id: 'UME', team_id: 'T' })),
      http.get(`${SLACK_BASE}/users.list`, () =>
        HttpResponse.json({ ok: true, members: [{ id: 'UMJ', real_name: 'Marie-José' }] }),
      ),
      http.get(`${SLACK_BASE}/users.conversations`, () =>
        HttpResponse.json({ ok: true, channels: [{ id: 'CFEEN', name: 'feenstra-hz', is_channel: true }] }),
      ),
      http.get(`${SLACK_BASE}/conversations.info`, () =>
        HttpResponse.json({ ok: true, channel: { id: 'CFEEN', last_read: lastRead } }),
      ),
      http.get(`${SLACK_BASE}/conversations.history`, () =>
        HttpResponse.json({ ok: true, messages: [{ ts: '1793262720.000200', user: 'UMJ', text: 'Leads?' }] }),
      ),
    );
    await runSync(deps, U, 'slack'); // nulpunt
    const ev = { type: 'channel_marked', channel: 'CFEEN', ts: '1793262720.000200' };
    expect(repo.record(U, 'slack', 'Ev01', ev)).toBe(true);
    expect(repo.record(U, 'slack', 'Ev01', ev)).toBe(false); // Slack herhaalt bij een trage 200
    lastRead = '1793262720.000200';
    const first = await runSync(deps, U, 'slack');
    expect(first.changed).toBeGreaterThanOrEqual(1);
    const second = await runSync(deps, U, 'slack');
    expect(second.changed).toBe(0);
    expect(repo.events.filter((e) => e.event_id === 'Ev01')).toHaveLength(1);
  });

  it('de worker verstuurt nooit iets (geen bericht, reactie, concept of uitnodiging)', async () => {
    repo.add(U, 'slack');
    repo.add(U, 'google_tasks');
    server.use(
      ...tasksOk(),
      http.get(`${SLACK_BASE}/auth.test`, () => HttpResponse.json({ ok: true, user_id: 'UME', team_id: 'T' })),
      http.get(`${SLACK_BASE}/users.list`, () => HttpResponse.json({ ok: true, members: [] })),
      http.get(`${SLACK_BASE}/users.conversations`, () => HttpResponse.json({ ok: true, channels: [] })),
    );
    for (let i = 0; i < 3; i++) {
      await runSync(deps, U, 'slack');
      await runSync(deps, U, 'google_tasks');
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.some((r) =>
        /chat\.postMessage|reactions\.add|conversations\.mark|\/drafts|\/messages\/send|\/events$/.test(r.url),
      ),
    ).toBe(false);
    expect(seen.every((r) => r.method === 'GET')).toBe(true);
  });
});
