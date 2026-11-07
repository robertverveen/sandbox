/**
 * HZW-036 zelftest (deel 2, met Postgres): planning per collega onder RLS, dubbele events in sync_events,
 * NOTIFY naar de API, ontkoppelen wist de sync-data, en een volledige run met tokens uit `connections`.
 * Eigen, verse database (hz_e3_test_sync). Nep-bronnen via msw.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EVENTS_CHANNEL,
  createDb,
  dbSyncStore,
  dbTokenStore,
  ensureDatabase,
  readConnectionToken,
  getSyncJob,
  recordSyncEvent,
  requestSync,
  runMigrations,
  saveConnectionToken,
  syncStatus,
  takeSyncEvents,
  upsertUser,
  userByAccount,
  wipeSyncData,
  withUser,
  type Db,
} from '@hz/db';
import { GOOGLE_TASKS_BASE, withUserScope } from '@hz/providers';
import { sql } from 'drizzle-orm';
import { createSyncDeps, planSync } from '../src/sync-db';
import { runSync } from '../src/sync';

const URL_ = process.env.HZ_TEST_DATABASE_URL_SYNC ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e3_test_sync';
const key = randomBytes(32);
let db: Db;
let close: () => Promise<void>;
let A: string;
let B: string;

const server = setupServer(
  http.get(`${GOOGLE_TASKS_BASE}/users/@me/lists`, ({ request }) =>
    request.headers.get('authorization') === 'Bearer ya29.van-anna'
      ? HttpResponse.json({ items: [{ id: 'L1', title: 'Mijn taken' }] })
      : HttpResponse.json({ error: { message: 'Invalid Credentials' } }, { status: 401 }),
  ),
  http.get(`${GOOGLE_TASKS_BASE}/lists/L1/tasks`, () =>
    HttpResponse.json({
      items: [{ id: 't1', title: 'Nieuw van telefoon', status: 'needsAction', updated: '2099-01-01T00:00:00Z' }],
    }),
  ),
);

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  ({ db, close } = createDb(URL_, 4));
  A = (await upsertUser(db, 'anna@homezero.nl', 'Anna')).id;
  B = (await upsertUser(db, 'bram@homezero.nl', 'Bram')).id;
  await saveConnectionToken(db, key, A, 'google_tasks', JSON.stringify({ access_token: 'ya29.van-anna' }), {
    account: 'anna@homezero.nl',
  });
  await saveConnectionToken(db, key, B, 'slack', 'xoxp-van-bram', { account: 'UBRAM' });
}, 30_000);
afterAll(async () => {
  server.close();
  await close?.();
});

describe('sync-motor op Postgres (HZW-036)', () => {
  it('planner maakt per gekoppelde bron een planningsrij en stuurt wat aan de beurt is', async () => {
    const sent: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const n = await planSync(db, {
      send: async (name: string, data: object, opts: object) => (sent.push({ name, data, opts }), 'id'),
    } as never);
    expect(n).toBe(2);
    expect(sent.map((s) => s.data)).toEqual(
      expect.arrayContaining([
        { userId: A, provider: 'google_tasks' },
        { userId: B, provider: 'slack' },
      ]),
    );
    // Eén job tegelijk per collega en bron.
    expect(sent.map((s) => (s.opts as { singletonKey: string }).singletonKey)).toEqual(
      expect.arrayContaining([`${A}:google_tasks`, `${B}:slack`]),
    );
    expect((await syncStatus(db, A)).map((j) => j.provider)).toEqual(['google_tasks']);
    expect(await userByAccount(db, 'slack', 'ubram')).toBe(B);
  });

  it('rij-beveiliging: collega A ziet de planning en cursors van B niet', async () => {
    const storeB = dbSyncStore(db, () => B);
    await storeB.set('slack:state:CX', { last_read: '1' });
    const seenByA = await withUser(db, A, (tx) => tx.execute(sql`select count(*)::int as n from sync_state`));
    expect((seenByA.rows[0] as { n: number }).n).toBe(0);
    const jobsByA = await withUser(db, A, (tx) => tx.execute(sql`select provider from sync_jobs`));
    expect(jobsByA.rows.map((r) => (r as { provider: string }).provider)).toEqual(['google_tasks']);
    expect(await dbSyncStore(db, () => A).get('slack:state:CX')).toBeNull();
    expect(await storeB.get('slack:state:CX')).toEqual({ last_read: '1' });
  });

  it('dubbele events: tweede keer genegeerd, verwerken gebeurt één keer', async () => {
    expect(await recordSyncEvent(db, 'slack', 'Ev123', B, { type: 'im_marked', channel: 'D1', ts: '2' })).toBe(true);
    expect(await recordSyncEvent(db, 'slack', 'Ev123', B, { type: 'im_marked', channel: 'D1', ts: '2' })).toBe(false);
    expect((await takeSyncEvents(db, B, 'slack')).map((e) => e.event_id)).toEqual(['Ev123']);
    expect(await takeSyncEvents(db, B, 'slack')).toEqual([]);
    expect(await takeSyncEvents(db, A, 'slack')).toEqual([]);
  });

  it('een run met het token uit connections; nieuwe data -> NOTIFY hz_events voor die collega', async () => {
    const listener = new pg.Client({ connectionString: URL_ });
    await listener.connect();
    const got: string[] = [];
    listener.on('notification', (n) => got.push(n.payload ?? ''));
    await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
    const deps = createSyncDeps({ db, masterKey: key, env: { HZ_LIVE_TASKS: '1' } });
    expect((await runSync(deps, A, 'google_tasks')).status).toBe('idle'); // nulpunt
    const o = await runSync(deps, A, 'google_tasks');
    expect(o).toMatchObject({ status: 'idle', changed: 1, ok: true });
    for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(got.map((p) => JSON.parse(p))).toEqual([{ userId: A, keys: ['tasks', 'items', 'dagstart', 'tracker'] }]);
    await listener.end();
    const job = await getSyncJob(db, A, 'google_tasks');
    expect(job).toMatchObject({ status: 'idle', failures: 0, lastChanged: 1 });
    expect(job!.lastOkAt).toBeInstanceOf(Date);
    // De cursor staat in sync_state van A.
    expect(await withUserScope(A, () => deps.store.get('tasks:updatedMin'))).toBeTruthy();
  });

  it('push: een webhook (requestSync -> NOTIFY hz_sync) laat de worker binnen seconden draaien', async () => {
    const { startWorker } = await import('../src/worker');
    const { createProviders } = await import('@hz/providers');
    const listener = new pg.Client({ connectionString: URL_ });
    await listener.connect();
    const got: string[] = [];
    listener.on('notification', (n) => got.push(n.payload ?? ''));
    await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
    const w = await startWorker({
      connectionString: URL_,
      schema: 'pgboss_e3_sync',
      bundle: createProviders({}),
      log: () => undefined,
      sync: { masterKey: key, env: { HZ_LIVE_TASKS: '1' }, cron: null },
    });
    try {
      const t0 = Date.now();
      await requestSync(db, A, 'google_tasks');
      for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(got.map((p) => JSON.parse(p).userId)).toContain(A);
      expect(Date.now() - t0).toBeLessThan(60_000);
    } finally {
      await w.stop();
      await listener.end();
    }
  }, 30_000);

  it('token afgewezen: koppeling en planning op needs_reauth', async () => {
    await saveConnectionToken(db, key, A, 'google_tasks', JSON.stringify({ access_token: 'ingetrokken' }), {
      account: 'anna@homezero.nl',
    });
    const deps = createSyncDeps({ db, masterKey: key, env: { HZ_LIVE_TASKS: '1' } });
    const o = await runSync(deps, A, 'google_tasks');
    expect(o.status).toBe('needs_reauth');
    const conn = await withUser(db, A, (tx) =>
      tx.execute(sql`select status from connections where provider = 'google_tasks'`),
    );
    expect((conn.rows[0] as { status: string }).status).toBe('needs_reauth');
    // Een webhook haalt een needs_reauth-run niet naar voren.
    await requestSync(db, A, 'google_tasks');
    expect((await getSyncJob(db, A, 'google_tasks'))!.status).toBe('needs_reauth');
  });

  it('ververst token wordt versleuteld opgeslagen (scopes blijven); ontkoppelen wist het token', async () => {
    const t = dbTokenStore(db, key);
    await saveConnectionToken(db, key, B, 'calendar', '{"access_token":"oud"}', {
      scopes: ['calendar.events'],
      account: 'bram@homezero.nl',
    });
    await t.save(B, 'calendar', '{"access_token":"nieuw","refresh_token":"1//r"}');
    expect(await readConnectionToken(db, key, B, 'calendar')).toBe('{"access_token":"nieuw","refresh_token":"1//r"}');
    const raw = await withUser(db, B, (tx) =>
      tx.execute(sql`select scopes, token_ciphertext from connections where provider = 'calendar'`),
    );
    const row = raw.rows[0] as { scopes: string[]; token_ciphertext: string };
    expect(row.scopes).toEqual(['calendar.events']);
    expect(row.token_ciphertext).not.toContain('nieuw');
    await t.clear(B, 'calendar');
    expect(await t.load(B, 'calendar')).toBeNull();
  });

  it('ontkoppelen wist planning, cursors en events van die bron', async () => {
    await recordSyncEvent(db, 'slack', 'Ev999', B, {});
    await wipeSyncData(db, B, 'slack');
    expect(await syncStatus(db, B)).toEqual([]);
    expect(await dbSyncStore(db, () => B).get('slack:state:CX')).toBeNull();
    expect(await takeSyncEvents(db, B, 'slack')).toEqual([]);
  });
});
