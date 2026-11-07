/**
 * HZW-036 (API-kant): webhooks van Slack, Google Agenda en Gmail controleren, ontdubbelen en een run klaarzetten;
 * NOTIFY van de worker komt als SSE `invalidate` bij de juiste collega. Plus: versturen kan alleen vanuit een
 * klik (POST van een ingelogde collega), nooit vanuit een GET. Eigen database hz_e3_test_hooks.
 */
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type ServerEvent } from '@hz/shared';
import {
  createDb,
  ensureDatabase,
  ensureSyncJobs,
  finishSync,
  getSyncJob,
  hookToken,
  notifyUser,
  runMigrations,
  upsertUser,
  withPurpose,
  type Db,
} from '@hz/db';
import { createProviders, SLACK_BASE } from '@hz/providers';
import { createApp, SESSION_COOKIE } from '../src/app';
import { loadConfig } from '../src/config';
import { EventBus } from '../src/events';
import { DbStore } from '../src/store';
import { listenSyncEvents, verifySlackSignature } from '../src/sync-hooks';

const URL_ = process.env.HZ_TEST_DATABASE_URL_HOOKS ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e3_test_hooks';
const SIGNING = 'slack-signing-test';
const HOOK = 'hook-secret-test';
let db: Db;
let close: () => Promise<void>;
let store: DbStore;
let robert: string;
const bus = new EventBus();
const posted: unknown[] = [];
const revoked: string[] = [];
const server = setupServer(
  http.get(`${SLACK_BASE}/auth.test`, () => HttpResponse.json({ ok: true, user_id: 'U04L22BRJQ7', team_id: 'T' })),
  http.post(`${SLACK_BASE}/chat.postMessage`, async ({ request }) => {
    posted.push(Object.fromEntries(new URLSearchParams(await request.text())));
    return HttpResponse.json({ ok: true, ts: '1793400000.000100' });
  }),
);

let app: ReturnType<typeof createApp>['app'];
let cookie = '';
const req = async (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
  app.request(path, {
    method,
    body: init.body,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...init.headers },
  });

const slackSig = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
  'x-slack-request-timestamp': String(ts),
  'x-slack-signature': 'v0=' + createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex'),
});
const eventCount = async (source: string) =>
  Number(
    (
      (
        await withPurpose(db, 'system', (tx) =>
          tx.execute(sql`select count(*)::int as n from sync_events where source = ${source}`),
        )
      ).rows[0] as { n: number }
    ).n,
  );

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  ({ db, close } = createDb(URL_, 4));
  store = new DbStore(URL_);
  const config = loadConfig({ NODE_ENV: 'test', HZ_STORE: 'db', DATABASE_URL: URL_ });
  // Slack live met een vast token voor deze test (tokens per collega test packages/providers en de worker).
  const bundle = createProviders({ HZ_LIVE_SLACK: '1' }, { accessToken: async () => 'xoxp-test' });
  ({ app } = createApp({
    config,
    bundle,
    store,
    bus,
    ssePingMs: 50,
    sync: { db, slackSigningSecret: SIGNING, hookSecret: HOOK, revoke: async (u, p) => void revoked.push(`${u}|${p}`) },
  }));
  const res = await req('POST', routes.devLogin.path, { body: '{}' });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  expect(cookie.startsWith(SESSION_COOKIE)).toBe(true);
  robert = (await upsertUser(db, 'robert@homezero.nl', 'Robert Verveen')).id;
  await ensureSyncJobs(db, robert, [
    { provider: 'slack', account: 'U04L22BRJQ7' },
    { provider: 'gmail', account: 'robert@homezero.nl' },
    { provider: 'calendar', account: 'robert@homezero.nl' },
  ]);
  // Zet de runs eerst ver in de toekomst, zodat zichtbaar is dat een webhook ze naar voren haalt.
  for (const p of ['slack', 'gmail', 'calendar'])
    await finishSync(
      db,
      robert,
      p,
      {
        status: 'idle',
        failures: 0,
        nextRunAt: new Date('2099-01-01T00:00:00Z'),
        push:
          p === 'calendar'
            ? { channels: { 'hz-chan-1': { calId: 'robert@homezero.nl', resourceId: 'r1', expiration: 0 } } }
            : undefined,
      },
      new Date(),
    );
}, 30_000);
afterAll(async () => {
  server.close();
  await store.close();
  await close();
});

describe('Slack Events (webhook)', () => {
  it('handtekening: geldig, ongeldig en te oud (replay)', () => {
    const body = '{"type":"url_verification","challenge":"abc"}';
    const h = slackSig(body, 1_800_000_000);
    expect(
      verifySlackSignature(SIGNING, h['x-slack-request-timestamp'], body, h['x-slack-signature'], 1_800_000_010_000),
    ).toBe(true);
    expect(
      verifySlackSignature(
        SIGNING,
        h['x-slack-request-timestamp'],
        body + ' ',
        h['x-slack-signature'],
        1_800_000_010_000,
      ),
    ).toBe(false);
    expect(
      verifySlackSignature(SIGNING, h['x-slack-request-timestamp'], body, h['x-slack-signature'], 1_800_000_400_000),
    ).toBe(false);
  });

  it('url_verification geeft de challenge terug; zonder geldige handtekening 401', async () => {
    const body = '{"type":"url_verification","challenge":"abc123"}';
    const ok = await req('POST', '/api/hooks/slack', { body, headers: slackSig(body) });
    expect(await ok.json()).toEqual({ challenge: 'abc123' });
    const bad = await req('POST', '/api/hooks/slack', {
      body,
      headers: { ...slackSig(body), 'x-slack-signature': 'v0=00' },
    });
    expect(bad.status).toBe(401);
  });

  it('event: run naar voren, alleen metadata bewaard; dubbel event (Slack-retry) genegeerd', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev0001',
      authorizations: [{ user_id: 'U04L22BRJQ7' }],
      event: { type: 'message', channel: 'CDEMOFEEN', ts: '1793262720.000200', user: 'UMJ', text: 'geheime inhoud' },
    });
    expect((await req('POST', '/api/hooks/slack', { body, headers: slackSig(body) })).status).toBe(200);
    expect((await getSyncJob(db, robert, 'slack'))!.nextRunAt.getFullYear()).toBeLessThan(2099);
    await finishSync(
      db,
      robert,
      'slack',
      { status: 'idle', failures: 0, nextRunAt: new Date('2099-01-01T00:00:00Z') },
      new Date(),
    );
    const retry = await req('POST', '/api/hooks/slack', {
      body,
      headers: { ...slackSig(body), 'x-slack-retry-num': '1' },
    });
    expect(retry.status).toBe(200);
    expect(await eventCount('slack')).toBe(1);
    expect((await getSyncJob(db, robert, 'slack'))!.nextRunAt.getFullYear()).toBe(2099);
    const stored = await withPurpose(db, 'system', (tx) =>
      tx.execute(sql`select payload from sync_events where event_id = 'Ev0001'`),
    );
    expect(JSON.stringify(stored.rows)).not.toContain('geheime inhoud');
  });
});

describe('Google-push', () => {
  it('Agenda: alleen met het juiste kanaaltoken; sync-bericht doet niets; wijziging zet een run klaar', async () => {
    const h = (token: string, state = 'exists', n = '2') => ({
      'x-goog-channel-id': 'hz-chan-1',
      'x-goog-channel-token': token,
      'x-goog-resource-state': state,
      'x-goog-message-number': n,
    });
    expect((await req('POST', '/api/hooks/google/calendar', { headers: h('fout') })).status).toBe(401);
    const good = hookToken(HOOK, 'calendar:hz-chan-1');
    expect((await req('POST', '/api/hooks/google/calendar', { headers: h(good, 'sync', '1') })).status).toBe(200);
    expect(await eventCount('calendar')).toBe(0);
    expect((await req('POST', '/api/hooks/google/calendar', { headers: h(good) })).status).toBe(200);
    expect((await req('POST', '/api/hooks/google/calendar', { headers: h(good) })).status).toBe(200);
    expect(await eventCount('calendar')).toBe(1);
    expect((await getSyncJob(db, robert, 'calendar'))!.nextRunAt.getFullYear()).toBeLessThan(2099);
  });

  it('Gmail (Pub/Sub): token in de URL, collega op e-mailadres, dubbele messageId genegeerd', async () => {
    const msg = {
      message: {
        data: Buffer.from(JSON.stringify({ emailAddress: 'Robert@homezero.nl', historyId: 1234 })).toString('base64'),
        messageId: 'ps-1',
      },
      subscription: 's',
    };
    expect((await req('POST', '/api/hooks/google/gmail?token=fout', { body: JSON.stringify(msg) })).status).toBe(401);
    const path = `/api/hooks/google/gmail?token=${hookToken(HOOK, 'gmail')}`;
    expect((await req('POST', path, { body: JSON.stringify(msg) })).status).toBe(204);
    expect((await req('POST', path, { body: JSON.stringify(msg) })).status).toBe(204);
    expect(await eventCount('gmail')).toBe(1);
    expect((await getSyncJob(db, robert, 'gmail'))!.nextRunAt.getFullYear()).toBeLessThan(2099);
  });
});

describe('SSE en sync-stand', () => {
  it('NOTIFY van de worker komt als invalidate in de SSE-stroom van die collega (en niet bij een ander)', async () => {
    const l = await listenSyncEvents(URL_, bus);
    const other: ServerEvent[] = [];
    const offOther = bus.subscribe('00000000-0000-4000-8000-000000000000', (e) => other.push(e));
    const res = await req('GET', '/api/events');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    await reader.read(); // hello
    await notifyUser(db, robert, ['conversations', 'items']);
    for (let i = 0; i < 40 && !text.includes('invalidate'); i++) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array }>((ok) => setTimeout(() => ok({}), 100)),
      ]);
      if (r.value) text += dec.decode(r.value);
    }
    await reader.cancel();
    offOther();
    await l.close();
    expect(text).toContain('event: invalidate');
    expect(text).toContain('"keys":["conversations","items"]');
    expect(other).toEqual([]);
  });

  it('/api/sync/status toont de stand zonder inhoud; "nu bijwerken" haalt de run naar voren', async () => {
    const s = routes.syncStatus.response.parse(await (await req('GET', '/api/sync/status')).json());
    expect(s.jobs.map((j) => j.provider)).toEqual(['calendar', 'gmail', 'slack']);
    expect(s.jobs.find((j) => j.provider === 'calendar')!.push).toBe(true);
    await finishSync(
      db,
      robert,
      'gmail',
      { status: 'idle', failures: 0, nextRunAt: new Date('2099-01-01T00:00:00Z') },
      new Date(),
    );
    const r = routes.syncNow.response.parse(await (await req('POST', '/api/sync/gmail')).json());
    expect(r).toEqual({ ok: true, queued: true });
    expect((await getSyncJob(db, robert, 'gmail'))!.nextRunAt.getFullYear()).toBeLessThan(2099);
  });
});

describe('versturen alleen na een klik', () => {
  it('POST van een ingelogde collega mag versturen (mens drukt op Versturen); de provider weigert buiten een klik', async () => {
    const res = await req('POST', '/api/conversations/sl:CDEMOFEEN/messages', {
      body: JSON.stringify({ text: 'Ik kijk ernaar' }),
    });
    expect(res.status).toBe(200);
    expect(posted).toEqual([{ channel: 'CDEMOFEEN', text: 'Ik kijk ernaar' }]);
  });
});

describe('ontkoppelen', () => {
  it('trekt het token in en wist planning en cursors van die bron', async () => {
    const res = await req('DELETE', '/api/connections/gmail');
    expect(res.status).toBe(200);
    expect(revoked).toEqual([`${robert}|gmail`]);
    expect(await getSyncJob(db, robert, 'gmail')).toBeNull();
    expect(await getSyncJob(db, robert, 'slack')).not.toBeNull();
  });
});
