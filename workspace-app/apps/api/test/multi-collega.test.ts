/**
 * Meerdere collega's in één proces (stuk E3, ronde 2). Live staat per proces aan (HZ_LIVE_SLACK=1, HZ_LIVE_GMAIL=1),
 * maar elke collega koppelt zelf. Getest met echte tokens per collega (versleuteld in Postgres, eigen database
 * hz_e3_test_multi) en een nep-Slack en nep-Gmail in msw die per token antwoorden:
 *
 * - wie Slack niet gekoppeld heeft krijgt bij /api/conversations een 200 met zijn Gmail-gesprekken;
 * - een 401 op de gedeelde Google-koppeling zet `connections` echt op needs_reauth;
 * - Agenda ontkoppelen op de gedeelde koppeling trekt in bij Google, wist het token en de agenda-data;
 * - Slack gelezen zetten gaat tot het gelezen bericht (niet tot het nieuwste); read=false zonder ts is een 400.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@hz/shared';
import {
  connectedProviders,
  createDb,
  dbSyncStore,
  dbTokenStore,
  disconnectSource,
  ensureDatabase,
  readConnectionToken,
  runMigrations,
  saveConnectionToken,
  withUser,
  type Db,
} from '@hz/db';
import {
  GMAIL_BASE,
  GOOGLE_REVOKE_URL,
  SLACK_BASE,
  createProviders,
  createUserCredentials,
  currentUserId,
  revokeToken,
} from '@hz/providers';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { DbStore } from '../src/store';

const URL_ = process.env.HZ_TEST_DATABASE_URL_MULTI ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e3_test_multi';
const KEY = randomBytes(32);
const SCOPE = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  tasks: 'https://www.googleapis.com/auth/tasks',
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const hdr = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
const thread = (id: string, from: string, to: string, subject: string) => ({
  id,
  messages: [
    {
      id: `${id}-m1`,
      threadId: id,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Synthetisch bericht',
      payload: {
        mimeType: 'text/plain',
        headers: hdr({ From: from, To: to, Subject: subject, Date: 'Thu, 05 Nov 2026 10:00:00 +0100' }),
        body: { data: b64('Synthetisch bericht') },
      },
    },
  ],
});
/** Per Google-token een eigen mailbox (synthetisch, *.example). */
const MAILBOX: Record<string, { email: string; threads: Record<string, ReturnType<typeof thread>> }> = {
  'ya29.lisanne': {
    email: 'lisanne@homezero.nl',
    threads: { thL: thread('thL', 'Anna <anna@zonnig.example>', 'lisanne@homezero.nl', 'Vragenlijst Zonnig') },
  },
  'ya29.robert': {
    email: 'robert@homezero.nl',
    threads: { thR: thread('thR', 'Piet <piet@warmtehuis.example>', 'robert@homezero.nl', 'Planning Warmtehuis') },
  },
};
const bearer = (r: Request) => (r.headers.get('authorization') ?? '').replace(/^Bearer /, '');
const unauth = () => HttpResponse.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 });

/** Slack van Robert: één kanaal met drie berichten (oud -> nieuw). */
const SLACK_MSGS = [
  { type: 'message', ts: '1793350000.000100', user: 'UANNA', text: 'Eerste' },
  { type: 'message', ts: '1793350100.000200', user: 'UANNA', text: 'Tweede' },
  { type: 'message', ts: '1793350200.000300', user: 'UANNA', text: 'Derde (nog ongelezen)' },
];
const marks: Array<{ channel: string; ts: string }> = [];
const revoked: string[] = [];
const slackOk = (r: Request, body: Record<string, unknown>) =>
  bearer(r) === 'xoxp-robert'
    ? HttpResponse.json({ ok: true, ...body })
    : HttpResponse.json({ ok: false, error: 'invalid_auth' });

const server = setupServer(
  http.get(`${GMAIL_BASE}/users/me/profile`, ({ request }) => {
    const m = MAILBOX[bearer(request)];
    return m ? HttpResponse.json({ emailAddress: m.email, historyId: '1' }) : unauth();
  }),
  http.get(`${GMAIL_BASE}/users/me/threads`, ({ request }) => {
    const m = MAILBOX[bearer(request)];
    return m ? HttpResponse.json({ threads: Object.keys(m.threads).map((id) => ({ id })) }) : unauth();
  }),
  http.get(`${GMAIL_BASE}/users/me/threads/:id`, ({ request, params }) => {
    const t = MAILBOX[bearer(request)]?.threads[String(params.id)];
    return t ? HttpResponse.json(t) : unauth();
  }),
  http.post(GOOGLE_REVOKE_URL, async ({ request }) => {
    revoked.push(new URLSearchParams(await request.text()).get('token') ?? '');
    return new HttpResponse(null, { status: 200 });
  }),
  http.get(`${SLACK_BASE}/auth.test`, ({ request }) => slackOk(request, { user_id: 'UROBERT', team_id: 'T1' })),
  http.get(`${SLACK_BASE}/users.list`, ({ request }) =>
    slackOk(request, { members: [{ id: 'UANNA', name: 'anna', real_name: 'Anna' }] }),
  ),
  http.get(`${SLACK_BASE}/users.conversations`, ({ request }) =>
    slackOk(request, { channels: [{ id: 'CZONNIG', name: 'zonnig-hz', is_channel: true, is_member: true }] }),
  ),
  http.get(`${SLACK_BASE}/conversations.info`, ({ request }) =>
    slackOk(request, { channel: { id: 'CZONNIG', name: 'zonnig-hz', last_read: SLACK_MSGS[0]!.ts } }),
  ),
  http.get(`${SLACK_BASE}/conversations.history`, ({ request }) =>
    slackOk(request, { messages: [...SLACK_MSGS].reverse(), has_more: false }),
  ),
  http.post(`${SLACK_BASE}/conversations.mark`, async ({ request }) => {
    const b = Object.fromEntries(new URLSearchParams(await request.text()));
    marks.push({ channel: b.channel!, ts: b.ts! });
    return slackOk(request, {});
  }),
);

let db: Db;
let close: () => Promise<void>;
let store: DbStore;
let app: ReturnType<typeof createApp>['app'];
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const req = (who: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie: cookies[who]! },
  });

async function connRow(userId: string, provider: string) {
  return withUser(db, userId, async (tx) => {
    const r = await tx.execute(
      sql`select status, scopes, token_ciphertext is not null as has_token from connections where provider = ${provider}`,
    );
    return r.rows[0] as { status: string; scopes: string[]; has_token: boolean } | undefined;
  });
}

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  ({ db, close } = createDb(URL_, 4));
  store = new DbStore(URL_);
  const config = loadConfig({ NODE_ENV: 'test', HZ_STORE: 'db', DATABASE_URL: URL_ });
  const tokens = dbTokenStore(db, KEY);
  const bundle = createProviders({ HZ_LIVE_SLACK: '1', HZ_LIVE_GMAIL: '1' }, createUserCredentials({ store: tokens }), {
    store: dbSyncStore(db, currentUserId),
  });
  ({ app } = createApp({
    config,
    bundle,
    store,
    sync: {
      db,
      revoke: (userId, provider) => disconnectSource(db, KEY, userId, provider, (p, t) => revokeToken(p, t)),
    },
  }));
  for (const [who, email] of [
    ['robert', 'robert@homezero.nl'],
    ['lisanne', 'lisanne@homezero.nl'],
    ['mike', 'mike@homezero.nl'],
  ] as const) {
    const res = await app.request(routes.devLogin.path, {
      method: 'POST',
      body: JSON.stringify({ email }),
      headers: { 'content-type': 'application/json' },
    });
    cookies[who] = res.headers.get('set-cookie')!.split(';')[0]!;
    ids[who] = ((await res.json()) as { user: { id: string } }).user.id;
  }
  // Robert: Slack en één gedeelde Google-koppeling (Agenda, Taken, Gmail). Lisanne: alleen Gmail, geen Slack.
  // Mike: Gmail met een token dat Google afwijst.
  await saveConnectionToken(db, KEY, ids.robert!, 'slack', 'xoxp-robert', { account: 'UROBERT' });
  await saveConnectionToken(
    db,
    KEY,
    ids.robert!,
    'google',
    JSON.stringify({ access_token: 'ya29.robert', refresh_token: '1//robert' }),
    { scopes: [SCOPE.calendar, SCOPE.tasks, SCOPE.gmail], account: 'robert@homezero.nl' },
  );
  await saveConnectionToken(db, KEY, ids.lisanne!, 'google', JSON.stringify({ access_token: 'ya29.lisanne' }), {
    scopes: [SCOPE.gmail],
    account: 'lisanne@homezero.nl',
  });
  await saveConnectionToken(db, KEY, ids.mike!, 'google', JSON.stringify({ access_token: 'ya29.dood' }), {
    scopes: [SCOPE.gmail],
    account: 'mike@homezero.nl',
  });
}, 30_000);

afterAll(async () => {
  server.close();
  await store.close();
  await close();
});

describe('live per collega, niet per proces', () => {
  it('collega zonder Slack-token: /api/conversations geeft 200 met zijn Gmail-gesprekken', async () => {
    const res = await req('lisanne', 'GET', '/api/conversations');
    expect(res.status).toBe(200);
    const body = routes.conversations.response.parse(await res.json());
    expect(body.conversations.map((c) => c.key)).toEqual(['ml:thL']);
    expect(body.sources).toEqual(
      expect.arrayContaining([
        { provider: 'slack', status: 'niet gekoppeld' },
        { provider: 'gmail', status: 'ok' },
      ]),
    );
    // Robert ziet zijn eigen mail (en niet die van Lisanne).
    const rob = routes.conversations.response.parse(await (await req('robert', 'GET', '/api/conversations')).json());
    expect(rob.conversations.map((c) => c.key)).toContain('ml:thR');
    expect(rob.conversations.map((c) => c.key)).not.toContain('ml:thL');
    expect(rob.conversations.map((c) => c.key)).toContain('sl:CZONNIG');
    expect(rob.sources).toEqual(expect.arrayContaining([{ provider: 'slack', status: 'ok' }]));
  });

  it('één Slack-gesprek zonder koppeling: 409 met uitleg, geen 500; zoeken werkt gewoon', async () => {
    const res = await req('lisanne', 'GET', '/api/conversations/sl:CZONNIG');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_connected' });
    const s = await req('lisanne', 'GET', '/api/search?q=vragenlijst');
    expect(s.status).toBe(200);
    expect(routes.search.response.parse(await s.json()).conversations.map((c) => c.key)).toEqual(['ml:thL']);
  });

  it('401 op de gedeelde Google-koppeling: connections echt op needs_reauth (rij google), route blijft 200', async () => {
    const res = await req('mike', 'GET', '/api/conversations');
    expect(res.status).toBe(200);
    const body = routes.conversations.response.parse(await res.json());
    expect(body.conversations).toEqual([]);
    expect(body.sources).toEqual(expect.arrayContaining([{ provider: 'gmail', status: 'opnieuw koppelen' }]));
    expect((await connRow(ids.mike!, 'google'))!.status).toBe('needs_reauth');
    expect(await connRow(ids.mike!, 'gmail')).toBeUndefined();
  });
});

describe('ontkoppelen met de gedeelde Google-koppeling', () => {
  it('DELETE /api/connections/calendar: ingetrokken bij Google, geen token, geen calendar:*-rijen, scope weg', async () => {
    const r = ids.robert!;
    const sync = dbSyncStore(db, () => r);
    await sync.set('calendar:sync:robert@homezero.nl', { syncToken: 'sync-1' });
    await sync.set('tasks:lists', { at: 1 });
    await sync.set('slack:self', { user_id: 'UROBERT', team_id: 'T1' });
    const res = await req('robert', 'DELETE', '/api/connections/calendar');
    expect(res.status).toBe(200);
    expect(revoked).toEqual(['1//robert']);
    expect(await readConnectionToken(db, KEY, r, 'google')).toBeNull();
    expect(await readConnectionToken(db, KEY, r, 'calendar')).toBeNull();
    expect(await sync.get('calendar:sync:robert@homezero.nl')).toBeNull();
    // Google trekt alles tegelijk in: Taken en Gmail moeten opnieuw gekoppeld worden; Slack blijft.
    expect(await sync.get('tasks:lists')).toBeNull();
    expect(await sync.get('slack:self')).not.toBeNull();
    const g = (await connRow(r, 'google'))!;
    expect(g).toMatchObject({ has_token: false, status: 'needs_reauth' });
    expect(g.scopes).toEqual([SCOPE.tasks, SCOPE.gmail]);
    // Niets meer om te synchroniseren voor Google (planSync maakt geen agenda-job meer aan; zie worker-test).
    expect((await connectedProviders(db, r)).map((c) => c.provider)).toEqual(['slack']);
    const conns = routes.connections.response.parse(await (await req('robert', 'GET', '/api/connections')).json());
    const st = Object.fromEntries(conns.connections.map((c) => [c.provider, c.status]));
    expect(st).toMatchObject({ calendar: 'disconnected', google_tasks: 'needs_reauth', gmail: 'needs_reauth' });
  });
});

describe('Slack gelezen zetten tot het gelezen bericht (HZW-033)', () => {
  const path = '/api/conversations/sl:CZONNIG/read';
  it('read=true met ts: leescursor tot dat bericht, het nieuwere blijft ongelezen', async () => {
    marks.splice(0);
    expect((await req('robert', 'POST', path, { read: true, ts: SLACK_MSGS[1]!.ts })).status).toBe(200);
    expect(marks).toEqual([{ channel: 'CZONNIG', ts: SLACK_MSGS[1]!.ts }]);
  });

  it('read=false met ts: leescursor op het bericht ervoor (terug te draaien)', async () => {
    marks.splice(0);
    expect((await req('robert', 'POST', path, { read: false, ts: SLACK_MSGS[1]!.ts })).status).toBe(200);
    expect(marks).toEqual([{ channel: 'CZONNIG', ts: SLACK_MSGS[0]!.ts }]);
  });

  it('read=false zonder ts, op het oudste bericht of met een onbekende ts: duidelijke fout, niets gemarkeerd', async () => {
    marks.splice(0);
    const a = await req('robert', 'POST', path, { read: false });
    expect(a.status).toBe(400);
    expect(((await a.json()) as { message: string }).message).toMatch(/ts/);
    expect((await req('robert', 'POST', path, { read: false, ts: SLACK_MSGS[0]!.ts })).status).toBe(400);
    expect((await req('robert', 'POST', path, { read: true, ts: '1793359999.000999' })).status).toBe(404);
    expect(marks).toEqual([]);
  });

  it('zonder ts (gesprek geopend): tot het nieuwste bericht', async () => {
    marks.splice(0);
    expect((await req('robert', 'POST', path, {})).status).toBe(200);
    expect(marks).toEqual([{ channel: 'CZONNIG', ts: SLACK_MSGS[2]!.ts }]);
  });
});
