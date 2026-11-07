import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pathFor, routes, ServerEvent, type RouteName } from '@hz/shared';
import { createProviders } from '@hz/providers';
import { createApp, SESSION_COOKIE } from '../src/app';
import { ConfigError, loadConfig } from '../src/config';
import { DbStore, MemoryStore, type AppStore } from '../src/store';

function setup(env: Record<string, string> = {}, store?: AppStore) {
  const config = loadConfig({ NODE_ENV: 'test', ...env });
  const bundle = createProviders(env);
  const s = store ?? new MemoryStore(bundle.dataset);
  const { app, bus } = createApp({ config, bundle, store: s, ssePingMs: 50 });
  let cookie = '';
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set?.startsWith(SESSION_COOKIE + '=')) cookie = set.split(';')[0]!;
    return res;
  };
  const login = async (email?: string) => (await req('POST', routes.devLogin.path, email ? { email } : {})).json();
  return { app, bus, bundle, store: s, req, login, cookie: () => cookie };
}

describe('health en sessie', () => {
  it('/api/health is openbaar', async () => {
    const { req } = setup();
    const res = await req('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(routes.health.response.parse(await res.json())).toMatchObject({ ok: true, mode: 'fixture', db: 'off' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('zonder sessie: 401; na dev-login: de vaste testgebruiker met de klok van de fixtures', async () => {
    const { req, login, cookie } = setup();
    expect((await req('GET', '/api/session')).status).toBe(401);
    const s = routes.session.response.parse(await login());
    expect(s.user).toMatchObject({ email: 'robert@homezero.nl', role: 'admin' });
    expect(s.now).toBe('2026-10-30T08:40:00');
    expect(cookie()).toMatch(/^hz_session=/);
    expect((await req('GET', '/api/session')).status).toBe(200);
  });

  it('cookie is HttpOnly en SameSite=Lax; uitloggen trekt de sessie in', async () => {
    const { app, req, login } = setup();
    const res = await app.request('/api/auth/dev-login', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    const sc = res.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    await login();
    expect((await req('POST', '/api/auth/logout')).status).toBe(200);
    expect((await req('GET', '/api/session')).status).toBe(401);
  });

  it('dev-login weigert adressen buiten @homezero.nl en is uit in productie', async () => {
    const { req } = setup();
    expect((await req('POST', '/api/auth/dev-login', { email: 'iemand@gmail.com' })).status).toBe(403);
    const off = setup({ HZ_DEV_LOGIN: '0' });
    expect((await off.req('POST', '/api/auth/dev-login', {})).status).toBe(404);
  });
});

describe('configuratie (HZW-006)', () => {
  it('weigert te starten in productie zonder verplichte secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (e) {
      expect((e as ConfigError).missing).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'HZ_TOKEN_KEY', 'HZ_STORE=db']),
      );
    }
    const ok = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      HZ_STORE: 'db',
      HZ_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    expect(ok.devLogin).toBe(false);
    expect(ok.secureCookies).toBe(true);
  });
});

describe('contract: elke GET-route antwoordt volgens zijn schema', () => {
  const samples: Partial<Record<RouteName, Record<string, string>>> = {
    conversation: { key: 'sl:CDEMOFEEN' },
    thread: { key: 'sl:CDEMOFEEN', ts: '' },
    partner: { slug: 'feenstra' },
  };
  const gets = (Object.entries(routes) as Array<[RouteName, (typeof routes)[RouteName]]>).filter(
    ([n, r]) => r.method === 'GET' && n !== 'events',
  );

  const queries: Partial<Record<RouteName, string>> = {
    search: '?q=feenstra',
    freeBusy: '?people=lisanne@homezero.nl&from=2026-10-30&to=2026-11-03',
  };

  it('elke route uit het contract is geregistreerd in de API (geen route zonder handler)', () => {
    const { app } = setup();
    const registered = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    const missing = (Object.values(routes) as Array<{ method: string; path: string }>)
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !registered.has(k));
    expect(missing).toEqual([]);
  });

  for (const [name, def] of gets) {
    it(`${def.method} ${def.path}`, async () => {
      const { req, login, bundle } = setup();
      await login();
      const params = { ...samples[name] };
      if (name === 'thread') params.ts = bundle.dataset.slack.find((s) => s.id === 's1')!.ts!;
      if (name === 'repoQueueEntry') {
        const e = await req('POST', '/api/repo/queue', {
          kind: 'bespreken',
          tekst: 'Flows nalopen',
          klant: 'feenstra',
        });
        params.id = ((await e.json()) as { id: string }).id;
      }
      const res = await req('GET', pathFor(def.path, params) + (queries[name] ?? ''));
      expect(res.status, await res.clone().text()).toBe(200);
      const parsed = (def.response as z.ZodType).safeParse(await res.json());
      expect(parsed.success, parsed.success ? '' : z.prettifyError(parsed.error)).toBe(true);
    });
  }
});

describe('Dagstart met de demodata van het prototype', () => {
  it('items, briefing, sprint, weekdoelen en contextlaag', async () => {
    const { req, login } = setup();
    await login();
    const d = routes.dagstart.response.parse(await (await req('GET', '/api/dagstart')).json());
    const ids = d.items.map((i) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining(['m1', 'm2', 'm3', 'm8', 'r1', 'e5', 's1', 't1', 'cm:dc3', 'cm:dg1', 'jr:DEMO-12']),
    );
    // Lou-agenda's staan alleen in Agenda, niet in Dagstart.
    expect(ids).not.toContain('lou1');
    expect(d.briefing?.title).toContain('Briefing vr 30 okt');
    expect(d.sprint.sprint?.name).toBe('Sprint 73');
    expect(d.context.status?.commit_context).toBe('demo123');
    expect(d.context.partners.feenstra!.kern).toBe('');
    expect(d.catchCount).toBe(5);
    expect(d.sourceErrors).toEqual([]);
    const m1 = d.items.find((i) => i.id === 'm1');
    expect(m1).toMatchObject({ evColor: '#e2c25a', prepTask: null });
    const m3 = d.items.find((i) => i.id === 'm3');
    expect(m3).toMatchObject({ prepTask: 't1' });
  });

  it('itemstate: gelezen zetten verandert de items en stuurt een invalidate-event', async () => {
    const { req, login, bus } = setup();
    const s = routes.session.response.parse(await login());
    const events: unknown[] = [];
    bus.subscribe(s.user.id, (e) => events.push(e));
    await req('PUT', pathFor(routes.itemState.path, { key: 's1' }), { read: true });
    const d = routes.dagstart.response.parse(await (await req('GET', '/api/dagstart')).json());
    expect(d.items.find((i) => i.id === 's1')?.read).toBe(true);
    expect(events).toEqual([{ type: 'invalidate', keys: ['items', 'dagstart'] }]);
  });

  it('een kapotte bron geeft een melding in plaats van een fout', async () => {
    const { req, login } = setup({ HZ_LIVE_SLACK: '1' });
    await login();
    const d = routes.dagstart.response.parse(await (await req('GET', '/api/dagstart')).json());
    expect(d.sourceErrors.map((e) => e.provider)).toContain('slack');
    expect(d.items.some((i) => i.type === 'slack')).toBe(false);
  });
});

describe('schrijfroutes op de fixtures', () => {
  it('taak toevoegen en afvinken', async () => {
    const { req, login } = setup();
    await login();
    const t = routes.addTask.response.parse(
      await (await req('POST', '/api/tasks', { title: 'Bellen met Peter', due: '2026-10-30' })).json(),
    );
    const tasks = async () =>
      routes.tasks.response.parse(await (await req('GET', '/api/tasks')).json()).tasks.map((x) => x.title);
    expect(await tasks()).toContain('Bellen met Peter');
    await req('PATCH', pathFor(routes.updateTask.path, { id: t.id }), { done: true });
    expect(await tasks()).not.toContain('Bellen met Peter');
  });

  it('ongeldige invoer geeft 400 met uitleg', async () => {
    const { req, login } = setup();
    await login();
    const res = await req('POST', '/api/tasks', { title: '' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid');
  });

  it('weekdoel toevoegen en gezondheid bijwerken', async () => {
    const { req, login } = setup();
    await login();
    const w = routes.addWeekdoel.response.parse(
      await (await req('POST', '/api/weekdoelen', { wat: 'Release notes sprint 74', week: '2026-W44' })).json(),
    );
    const u = routes.updateWeekdoel.response.parse(
      await (await req('PATCH', `/api/weekdoelen/${w.id}`, { health: 'oranje', note: 'Wacht op Lisanne' })).json(),
    );
    expect(u.checks).toEqual([{ d: '2026-10-30', h: 'oranje', note: 'Wacht op Lisanne' }]);
  });

  it('bericht versturen en reageren blijven in de fixtures, met auditregel', async () => {
    const { req, login, bundle, store } = setup();
    await login();
    const r = await req('POST', pathFor(routes.sendMessage.path, { key: 'sl:CDEMOFEEN' }), { text: 'Ik kijk ernaar' });
    expect(r.status).toBe(200);
    expect(bundle.log.calls.map((c) => `${c.provider}.${c.op}`)).toContain('slack.postMessage');
    expect((store as MemoryStore).auditLog.map((a) => a.action)).toContain('message.sent');
  });

  it('koppelingen: lijst, ontkoppelen en opnieuw verbinden', async () => {
    const { req, login } = setup();
    await login();
    const list = routes.connections.response.parse(await (await req('GET', '/api/connections')).json());
    expect(list.connections.map((c) => c.provider)).toEqual([
      'google_tasks',
      'calendar',
      'gmail',
      'slack',
      'jira',
      'github',
      'wispr',
    ]);
    await req('DELETE', '/api/connections/slack');
    const after = routes.connections.response.parse(await (await req('GET', '/api/connections')).json());
    expect(after.connections.find((c) => c.provider === 'slack')?.status).toBe('disconnected');
    const re = routes.connect.response.parse(await (await req('POST', '/api/connections/slack/connect')).json());
    expect(re.connection.status).toBe('connected');
  });

  it('Vraag Claude gebruikt de nep-Anthropic', async () => {
    const { req, login } = setup();
    await login();
    const a = routes.ask.response.parse(
      await (await req('POST', '/api/claude/ask', { q: 'Wat speelt er bij TonZon?' })).json(),
    );
    expect(a.model).toBe('fake-ask');
    expect(a.answer).toContain('TonZon');
  });

  it('partnerpagina: onbekende slug geeft 404, admin-data komt er nooit in', async () => {
    const { req, login } = setup();
    await login();
    expect((await req('GET', '/api/partners/bestaat-niet')).status).toBe(404);
    const p = routes.partner.response.parse(await (await req('GET', '/api/partners/feenstra')).json());
    expect(p.items.map((i) => i.id)).toEqual(expect.arrayContaining(['m1', 'e5', 's1']));
    expect(JSON.stringify(p)).not.toMatch(/MRR|admin\.md/);
  });
});

describe('wegschrijven naar de contextlaag via de wachtrij', () => {
  it('Inhalen w: wachten-op-regel in de rij, item verwerkt, status te volgen', async () => {
    const { req, login } = setup();
    await login();
    const res = await req('POST', '/api/repo/queue', {
      kind: 'wachten-op',
      tekst: 'Akkoord op de nieuwe offerteflow',
      wie: 'Marie-José',
      klant: 'feenstra',
      bron: 'https://homezero-workspace.slack.com/archives/CDEMOFEEN/p1',
      itemKey: 's1',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const e = routes.repoQueue.response.parse(await res.json());
    expect(e).toMatchObject({ repo: 'persoonlijk', path: 'wachten-op.md', op: 'append', status: 'queued' });
    expect(e.line).toBe(
      '- [ ] Akkoord op de nieuwe offerteflow [wie:: Marie-José] [sinds:: 2026-10-30] [reminder:: 2026-11-04] [bron:: https://homezero-workspace.slack.com/archives/CDEMOFEEN/p1] [klant:: feenstra]',
    );
    const got = routes.repoQueueEntry.response.parse(await (await req('GET', `/api/repo/queue/${e.id}`)).json());
    expect(got.id).toBe(e.id);
    const list = routes.repoQueueList.response.parse(await (await req('GET', '/api/repo/queue?status=queued')).json());
    expect(list.entries.map((x) => x.id)).toEqual([e.id]);
  });

  it('partneractie: actieregel met oplopend id per slug en dag', async () => {
    const { req, login } = setup();
    await login();
    const body = {
      kind: 'partneractie',
      slug: 'tonzon',
      tekst: 'Offerte nasturen',
      eigenaar: 'Robert',
      ligt: 'bij-ons',
      bron: 'https://x/1',
    };
    const a = routes.repoQueue.response.parse(await (await req('POST', '/api/repo/queue', body)).json());
    const b = routes.repoQueue.response.parse(await (await req('POST', '/api/repo/queue', body)).json());
    expect(a.path).toBe('partners/tonzon/acties.md');
    expect(a.line).toMatch(/\[id:: tonzon-20261030-1\]$/);
    expect(b.line).toMatch(/\[id:: tonzon-20261030-2\]$/);
  });

  it('meeting: nieuw bestand bij de eerste partner', async () => {
    const { req, login } = setup();
    await login();
    const e = routes.repoQueue.response.parse(
      await (
        await req('POST', '/api/repo/queue', {
          kind: 'meeting',
          slug: 'feenstra',
          meetingId: 'm1',
          datum: '2026-10-30',
          onderwerp: 'Maandelijkse check-in',
          partners: ['feenstra'],
          label: 'bestaande-klant',
          opgenomenDoor: 'Robert Verveen',
          bron: 'https://notes.example/m1',
          samenvatting: ['Leads lopen goed'],
        })
      ).json(),
    );
    expect(e).toMatchObject({
      op: 'new-file',
      path: 'partners/feenstra/meetings/2026-10-30-maandelijkse-check-in-robert.md',
    });
  });

  it('onbekende slug: 422; regel met [ ] of > 300 tekens: 400; andere collega ziet de rij niet', async () => {
    const { req, login, store } = setup();
    await login();
    expect(
      (await req('POST', '/api/repo/queue', { kind: 'bespreken', tekst: 'x', klant: 'bestaat-niet' })).status,
    ).toBe(422);
    expect(
      (await req('POST', '/api/repo/queue', { kind: 'bespreken', tekst: 'x [id:: y]', klant: 'feenstra' })).status,
    ).toBe(400);
    const e = routes.repoQueue.response.parse(
      await (await req('POST', '/api/repo/queue', { kind: 'bespreken', tekst: 'ok', klant: 'feenstra' })).json(),
    );
    const { req: reqB, login: loginB } = setup({}, store);
    await loginB('lisanne@homezero.nl');
    expect((await reqB('GET', `/api/repo/queue/${e.id}`)).status).toBe(404);
    const listB = routes.repoQueueList.response.parse(await (await reqB('GET', '/api/repo/queue')).json());
    expect(listB.entries).toEqual([]);
    expect(e.status).toBe('queued');
  });
});

describe('vastgezet, voorkeuren en agenda (HZW-020, HZW-030)', () => {
  it('zoekopdracht en view vastzetten en weer losmaken', async () => {
    const { req, login } = setup();
    await login();
    const p = routes.addPin.response.parse(
      await (
        await req('POST', '/api/pins', { kind: 'search', label: 'Feenstra offertes', q: 'feenstra, offerte' })
      ).json(),
    );
    await req('POST', '/api/pins', { kind: 'view', label: 'Wachten op', view: '/tracker?tab=wachten' });
    expect(
      (await req('POST', '/api/pins', { kind: 'view', label: 'Kapot', view: 'https://evil.example' })).status,
    ).toBe(400);
    const list = routes.pins.response.parse(await (await req('GET', '/api/pins')).json());
    expect(list.pins.map((x) => x.label)).toEqual(['Feenstra offertes', 'Wachten op']);
    expect((await req('DELETE', `/api/pins/${p.id}`)).status).toBe(200);
    expect((await req('DELETE', `/api/pins/${p.id}`)).status).toBe(404);
  });

  it('voorkeuren: thema en agendakleur met overal/alleen in Agenda; Agenda past ze toe', async () => {
    const { req, login } = setup();
    await login();
    expect(routes.preferences.response.parse(await (await req('GET', '/api/preferences')).json())).toEqual({
      theme: 'system',
      calendars: {},
    });
    const cal = routes.agenda.response.parse(
      await (await req('GET', '/api/agenda?from=2026-10-26&to=2026-11-02')).json(),
    ).calendars[0]!;
    const p = routes.updatePreferences.response.parse(
      await (
        await req('PATCH', '/api/preferences', {
          theme: 'dark',
          calendars: { [cal.id]: { color: '#0022c4', scope: 'agenda' } },
        })
      ).json(),
    );
    expect(p.theme).toBe('dark');
    const after = routes.agenda.response.parse(
      await (await req('GET', '/api/agenda?from=2026-10-26&to=2026-11-02')).json(),
    );
    expect(after.calendars.find((c) => c.id === cal.id)).toMatchObject({ color: '#0022c4', scope: 'agenda' });
    expect((await req('PATCH', '/api/preferences', { theme: 'paars' })).status).toBe(400);
  });

  it('vrije tijden: niet over afspraken van jou of de collega heen, binnen werktijd', async () => {
    const { req, login } = setup();
    await login();
    const fb = routes.freeBusy.response.parse(
      await (
        await req('GET', '/api/agenda/freebusy?people=lisanne@homezero.nl&from=2026-10-30&to=2026-11-03&duration=60')
      ).json(),
    );
    expect(fb.people.map((p) => p.email)).toEqual(['robert@homezero.nl', 'lisanne@homezero.nl']);
    const lis = fb.people[1]!.busy;
    expect(lis).toEqual(expect.arrayContaining([{ start: '2026-10-30T10:00', end: '2026-10-30T11:00' }]));
    const all = fb.people.flatMap((p) => p.busy);
    for (const f of fb.free) {
      expect(f.start >= '2026-10-30T08:40').toBe(true);
      expect(f.start.slice(11) >= '09:00' && f.end.slice(11) <= '17:30').toBe(true);
      expect(all.some((b) => b.start < f.end && b.end > f.start)).toBe(false);
    }
    // Zaterdag en zondag vallen af.
    expect(fb.free.some((f) => f.start.startsWith('2026-10-31') || f.start.startsWith('2026-11-01'))).toBe(false);
    expect(fb.free.some((f) => f.start.startsWith('2026-11-02'))).toBe(true);
  });

  it('afspraak maken: verschijnt in Agenda, blijft in de fixtures, met auditregel', async () => {
    const { req, login, bundle, store } = setup();
    await login();
    const ev = routes.createEvent.response.parse(
      await (
        await req('POST', '/api/agenda/events', {
          title: 'Sprintplanning',
          start: '2026-11-02T10:00',
          end: '2026-11-02T10:30',
          attendees: ['lisanne@homezero.nl'],
          meet: true,
        })
      ).json(),
    );
    const ag = routes.agenda.response.parse(
      await (await req('GET', '/api/agenda?from=2026-11-02&to=2026-11-03')).json(),
    );
    expect(ag.events.map((e) => e.id)).toContain(ev.id);
    expect(bundle.log.calls.map((c) => `${c.provider}.${c.op}`)).toContain('calendar.createEvent');
    expect((store as MemoryStore).auditLog.map((a) => a.action)).toContain('calendar.event.created');
    expect(
      (await req('POST', '/api/agenda/events', { title: 'x', start: '2026-11-02T10:00', end: '2026-11-02T09:00' }))
        .status,
    ).toBe(400);
  });
});

describe('server-sent events', () => {
  it('stuurt hello, dan invalidate na een wijziging', async () => {
    const { app, login, cookie, bus } = setup();
    const s = routes.session.response.parse(await login());
    const res = await app.request('/api/events', { headers: { cookie: cookie() } });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const next = async () => {
      while (!/\n\n/.test(buf)) buf += dec.decode((await reader.read()).value);
      const i = buf.indexOf('\n\n');
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      return ServerEvent.parse(
        JSON.parse(
          chunk
            .split('\n')
            .find((l) => l.startsWith('data:'))!
            .slice(5)
            .trim(),
        ),
      );
    };
    expect((await next()).type).toBe('hello');
    bus.invalidate(s.user.id, 'items');
    expect(await next()).toEqual({ type: 'invalidate', keys: ['items'] });
    expect((await next()).type).toBe('ping');
    await reader.cancel();
  });

  it('zonder sessie geen stream', async () => {
    const { app } = setup();
    expect((await app.request('/api/events')).status).toBe(401);
  });
});

describe('HZ_STORE=db: zelfde API op Postgres met RLS', () => {
  const url = process.env.HZ_TEST_DATABASE_URL_API ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_fundament_test_api';
  it('dev-login, itemstate en weekdoelen per gebruiker gescheiden', async () => {
    const { ensureDatabase, runMigrations } = await import('@hz/db');
    await ensureDatabase(url, { recreate: true });
    await runMigrations(url);
    const store = new DbStore(url);
    try {
      const a = setup({ HZ_STORE: 'db', DATABASE_URL: url }, store);
      await a.login('robert@homezero.nl');
      await a.req('PUT', pathFor(routes.itemState.path, { key: 's1' }), { read: true });
      await a.req('POST', '/api/weekdoelen', { wat: 'Doel van Robert', week: '2026-W44' });
      const b = setup({ HZ_STORE: 'db', DATABASE_URL: url }, store);
      await b.login('lisanne@homezero.nl');
      const wb = routes.weekdoelen.response.parse(await (await b.req('GET', '/api/weekdoelen')).json());
      expect(wb.weekdoelen).toEqual([]);
      const wa = routes.weekdoelen.response.parse(await (await a.req('GET', '/api/weekdoelen')).json());
      expect(wa.weekdoelen.map((w) => w.wat)).toEqual(['Doel van Robert']);
      const da = routes.dagstart.response.parse(await (await a.req('GET', '/api/dagstart')).json());
      const db_ = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
      expect(da.items.find((i) => i.id === 's1')?.read).toBe(true);
      expect(db_.items.find((i) => i.id === 's1')?.read).toBeFalsy();
      const health = routes.health.response.parse(await (await a.req('GET', '/api/health')).json());
      expect(health.db).toBe('ok');

      // Planning zit in item_state (één plek), wachtrij, vastgezet en voorkeuren per gebruiker.
      const st = routes.itemState.response.parse(
        await (
          await a.req('PUT', pathFor(routes.itemState.path, { key: 'e5' }), { plan: '2026-11-02', moved: 1 })
        ).json(),
      );
      expect(st).toMatchObject({ plan: '2026-11-02', moved: 1 });
      const q = routes.repoQueue.response.parse(
        await (
          await a.req('POST', '/api/repo/queue', {
            kind: 'partneractie',
            slug: 'feenstra',
            tekst: 'Prijzen sturen',
            eigenaar: 'Robert',
            ligt: 'bij-hen',
            bron: 'https://x/1',
          })
        ).json(),
      );
      expect(q.line).toMatch(/\[id:: feenstra-20261030-\d+\]$/);
      expect((await b.req('GET', `/api/repo/queue/${q.id}`)).status).toBe(404);
      await a.req('POST', '/api/pins', { kind: 'search', label: 'Feenstra', q: 'feenstra' });
      await a.req('PATCH', '/api/preferences', { theme: 'dark' });
      expect(routes.pins.response.parse(await (await b.req('GET', '/api/pins')).json()).pins).toEqual([]);
      expect(routes.preferences.response.parse(await (await b.req('GET', '/api/preferences')).json()).theme).toBe(
        'system',
      );
      expect(routes.preferences.response.parse(await (await a.req('GET', '/api/preferences')).json()).theme).toBe(
        'dark',
      );
    } finally {
      await store.close();
    }
  }, 20_000);
});
