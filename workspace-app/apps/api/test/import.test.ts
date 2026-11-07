/**
 * HZW-021 goedkeuring "Robert ziet zijn tracker terug": na de import van een (synthetische) prototype-export laat de
 * API met HZ_STORE=db de tracker-items, weekdoelen, briefing, planning en vastgezette zoekopdrachten van Robert zien,
 * en niets daarvan aan een andere collega. Eigen, verse database (hz_e2_test_api_import).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type CommitItem } from '@hz/shared';
import { createProviders } from '@hz/providers';
import { createDb, ensureDatabase, importPrototype, runMigrations } from '@hz/db';
import { createApp, SESSION_COOKIE } from '../src/app';
import { loadConfig } from '../src/config';
import { DbStore } from '../src/store';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '../../../packages/db/test/fixtures/prototype-export.json');
const url =
  process.env.HZ_TEST_DATABASE_URL_API_IMPORT ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e2_test_api_import';

let store: DbStore;

function client() {
  const env = { HZ_STORE: 'db', DATABASE_URL: url };
  const { app } = createApp({ config: loadConfig({ NODE_ENV: 'test', ...env }), bundle: createProviders(env), store });
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
  const get = async (path: string) => (await req('GET', path)).json() as Promise<unknown>;
  return { req, get, login: (email: string) => req('POST', routes.devLogin.path, { email }) };
}

beforeAll(async () => {
  await ensureDatabase(url, { recreate: true });
  await runMigrations(url);
  const { db, close } = createDb(url, 2);
  try {
    const r = await importPrototype(db, { email: 'robert@homezero.nl', name: 'Robert', exportPath: FIXTURE });
    expect(r.klopt).toBe(true);
  } finally {
    await close();
  }
  store = new DbStore(url);
}, 30_000);

afterAll(async () => {
  await store?.close();
});

describe('na de import ziet Robert zijn tracker terug (HZ_STORE=db)', () => {
  it('tracker-items uit commitments, met dezelfde zichtbaarheid als in het prototype', async () => {
    const robert = client();
    await robert.login('robert@homezero.nl');
    const { items } = routes.items.response.parse(await robert.get('/api/items'));
    const commits = items.filter((i): i is CommitItem => i.type === 'commit');
    const ids = commits.map((c) => c.id);
    for (const id of ['cm:dc3', 'cm:dc4', 'cm:q1', 'cm:b1', 'cm:k1', 'cm:zonder-stroom']) expect(ids).toContain(id);
    // verborgen zoals commitVisible(): canvas-item, al in Google Taken, al overgezet naar de repo
    for (const id of ['cm:canvas-x', 'cm:old-gt', 'cm:ov1']) expect(ids).not.toContain(id);
    const dc3 = commits.find((c) => c.id === 'cm:dc3')!;
    expect(dc3).toMatchObject({ stroom: 'mijn', status: 'te_laat', aan: 'Marie-José', deadline: '2026-10-29' });
    expect(dc3.entities).toContain('feenstra');
    expect(commits.find((c) => c.id === 'cm:q1')).toMatchObject({ stroom: 'aan_mij', reminder: '2026-11-03' });
    expect(commits.find((c) => c.id === 'cm:dc4')).toMatchObject({ plan: '2026-11-02', moved: 1 });
    expect(commits.find((c) => c.id === 'cm:k1')!.status).toBe('klaar');
    // weekdoelen en roadmap komen ook als tracker-item mee
    expect(commits.filter((c) => c.stroom === 'weekdoel').map((c) => c.title)).toContain(
      'Isolatieflow TonZon live op acceptatie',
    );
    expect(commits.some((c) => c.stroom === 'roadmap')).toBe(true);
  });

  it('weekdoelen, briefing, planning en vastgezette zoekopdrachten', async () => {
    const robert = client();
    await robert.login('robert@homezero.nl');
    const t = routes.tracker.response.parse(await robert.get('/api/tracker'));
    const dg1 = t.weekdoelen.find((w) => w.wat === 'Isolatieflow TonZon live op acceptatie')!;
    expect(dg1).toMatchObject({ week: '2026-W44', health: 'groen', lastCheck: '2026-10-29', created: '2026-10-26' });
    expect(t.weekdoelen).toHaveLength(6);
    const b = routes.briefing.response.parse(await robert.get(routes.briefing.path));
    expect(b.briefing).toMatchObject({ date: '2026-10-30' });
    expect(b.briefing!.sections.map((s) => s.title)).toEqual([
      '🔴 Vandaag doen',
      '📅 Meetings vandaag',
      '🎯 Weekdoelen',
    ]);
    const p = routes.pins.response.parse(await robert.get('/api/pins'));
    expect(p.pins.map((x) => x.q)).toEqual(['feenstra, offerte', 'tonzon, tijdlijn']);
  });

  it('een andere collega ziet niets van Roberts import', async () => {
    const lisanne = client();
    await lisanne.login('lisanne@homezero.nl');
    const { items } = routes.items.response.parse(await lisanne.get('/api/items'));
    expect(items.filter((i) => i.type === 'commit')).toEqual([]);
    expect(routes.tracker.response.parse(await lisanne.get('/api/tracker')).weekdoelen).toEqual([]);
    expect(routes.briefing.response.parse(await lisanne.get(routes.briefing.path)).briefing).toBeNull();
    expect(routes.pins.response.parse(await lisanne.get('/api/pins')).pins).toEqual([]);
  });
});
