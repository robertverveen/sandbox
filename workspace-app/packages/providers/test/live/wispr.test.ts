/**
 * HZW-035 zelftest: meeting van gisteren zichtbaar, ook als de nachtdienst hem nog niet had. De laag levert de
 * verwerkte meetings; live Wispr (nep-MCP-server in msw) alleen wat na de laatste nachtrun kwam.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ContextSnapshot, RecItem } from '@hz/shared';
import {
  ContextFirstWispr,
  FixtureContext,
  LiveWispr,
  NotConnectedError,
  OwnerScopedContext,
  RepoContext,
  createProviders,
  currentUserName,
  withUserScope,
  type WisprProvider,
} from '../../src';
import { creds, mockServer } from './msw';

const MCP = 'https://wispr-mcp.test.invalid/mcp';

const snapshot = (nachtdienst: string): ContextSnapshot =>
  ContextSnapshot.parse({
    status: { status: '2026-11-07 | groen', nachtdienst, geexporteerd: '2026-11-07T06:00:00+00:00', partners: 1 },
    partners: {
      feenstra: {
        slug: 'feenstra',
        soort: 'partner',
        naam: 'Feenstra',
        meetings: [
          {
            bestand: '2026-11-05-maandelijkse-check-in-robert.md',
            datum: '2026-11-05',
            titel: 'maandelijkse check in',
            meeting_id: 'wm-0511',
            opgenomen_door: 'Robert',
            bron: 'https://notes.wisprflow.ai/shared/wm-0511',
          },
          {
            bestand: '2026-11-04-werksessie-lisanne.md',
            datum: '2026-11-04',
            titel: 'werksessie',
            meeting_id: 'wm-lis',
            opgenomen_door: 'Lisanne',
            bron: '',
          },
          {
            bestand: '2026-10-01-oud-robert.md',
            datum: '2026-10-01',
            titel: 'oud',
            meeting_id: 'wm-oud',
            opgenomen_door: 'Robert',
            bron: '',
          },
        ],
      },
    },
    acties: {},
    pers: null,
  });

let calls: Array<{ method: string; params: Record<string, unknown> }>;
/** Aan: search_meetings geeft pagina's van één meeting met has_more/next_cursor (zoals de echte Wispr-server). */
let paged = false;
beforeEach(() => {
  calls = [];
  paged = false;
});

const { server } = mockServer(
  http.post(MCP, async ({ request }) => {
    const b = (await request.json()) as { id?: number; method: string; params: Record<string, unknown> };
    calls.push({ method: b.method, params: b.params });
    if (b.method === 'initialize')
      return HttpResponse.json(
        {
          jsonrpc: '2.0',
          id: b.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wispr-nep' } },
        },
        { headers: { 'mcp-session-id': 'sess-1' } },
      );
    if (b.method === 'notifications/initialized') return new HttpResponse(null, { status: 202 });
    expect(request.headers.get('mcp-session-id')).toBe('sess-1');
    const meetings = [
      // Gisteren, ná de nachtrun: nog niet in de laag.
      {
        id: 'wm-0611',
        title: 'TonZon x HomeZero',
        start: '2026-11-06T14:00:00Z',
        end: '2026-11-06T15:00:00Z',
        attendees: ['Peter', 'Robert Verveen', 'Mike'],
        has_transcript: true,
        share_link: 'https://notes.wisprflow.ai/shared/wm-0611',
      },
      // Al verwerkt door de nachtdienst (zelfde id): wordt één item.
      {
        id: 'wm-0511',
        title: 'Feenstra maandelijkse check-in',
        start: '2026-11-05T09:00:00Z',
        end: '2026-11-05T10:00:00Z',
        attendees: ['Marie-José'],
        share_link: 'https://notes.wisprflow.ai/shared/wm-0511',
      },
    ];
    let payload: Record<string, unknown> = { meetings };
    if (paged) {
      // Drie pagina's: c1 -> c2 -> einde. Pagina 2 herhaalt een meeting (mag geen dubbel item worden).
      const cur = (b.params.arguments as { cursor?: string }).cursor;
      const extra = {
        id: 'wm-0411',
        title: 'Oudere opname',
        start: '2026-11-06T08:00:00Z',
        end: '2026-11-06T08:30:00Z',
      };
      payload =
        cur === undefined
          ? { meetings: [meetings[0]], has_more: true, next_cursor: 'c1', more: '2 meer' }
          : cur === 'c1'
            ? { meetings: [meetings[1], meetings[0]], has_more: true, next_cursor: 'c2' }
            : { meetings: [extra], has_more: false, next_cursor: null };
    }
    // Antwoord als SSE (streamable HTTP), zoals een MCP-server mag doen.
    return new HttpResponse(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`,
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  }),
);

const NOW = () => new Date('2026-11-07T08:00:00Z');

describe('meetings: contextlaag eerst, live Wispr na de nachtrun (HZW-035)', () => {
  it('meeting van gisteren is zichtbaar, ook als de nachtdienst hem nog niet had', async () => {
    // Laatste nachtrun van Robert: 6 nov 00:16Z, dus de meeting van 6 nov 15:00 kon er nog niet in staan.
    const ctx = new FixtureContext(snapshot('2026-11-06 00:16Z | groen | gezien 1 | verwerkt 1'));
    const w = new ContextFirstWispr(new LiveWispr(creds(), { url: MCP }), ctx, { owner: 'Robert', now: NOW });
    const items = await w.listMeetings('2026-10-31');
    for (const i of items) expect(() => RecItem.parse(i)).not.toThrow();
    const gisteren = items.find((i) => i.rawId === 'wm-0611')!;
    expect(gisteren).toMatchObject({
      title: 'TonZon x HomeZero',
      start: '2026-11-06T15:00',
      end: '2026-11-06T16:00',
      transcript: true,
    });
    expect(gisteren.processed).toBeFalsy();
    // De verwerkte meeting staat er één keer in, als verwerkt, met de partner uit de laag.
    const feen = items.filter((i) => i.rawId === 'wm-0511');
    expect(feen).toHaveLength(1);
    expect(feen[0]).toMatchObject({ processed: true, entities: ['feenstra'], start: '2026-11-05' });
    // Alleen eigen opnames uit de laag, en niet ouder dan gevraagd.
    expect(items.map((i) => i.rawId)).not.toContain('wm-lis');
    expect(items.map((i) => i.rawId)).not.toContain('wm-oud');
    // Live alleen vanaf de nachtrun (min. 30 minuten marge), niet vanaf de gevraagde 31 oktober.
    const call = calls.find((c) => c.method === 'tools/call')!;
    expect(call.params).toEqual({
      name: 'search_meetings',
      arguments: { since: '2026-11-05T23:46:00.000Z', limit: 100 },
    });
    expect(w.lastWindow).toMatchObject({ basis: 'nachtrun', missedNight: false });
  });

  it('mist er een nacht, dan vraagt live Wispr verder terug', async () => {
    const ctx = new FixtureContext(snapshot('2026-11-03 00:16Z | groen | gezien 0'));
    const w = new ContextFirstWispr(new LiveWispr(creds(), { url: MCP }), ctx, { owner: 'Robert', now: NOW });
    const items = await w.listMeetings('2026-10-31');
    // Nu komt de verwerkte meeting ook live terug: één item, verwerkt, met de tijden uit Wispr.
    expect(items.filter((i) => i.rawId === 'wm-0511')).toEqual([
      expect.objectContaining({ processed: true, start: '2026-11-05T10:00', entities: ['feenstra'] }),
    ]);
    const since = (calls.find((c) => c.method === 'tools/call')!.params.arguments as { since: string }).since;
    expect(since).toBe('2026-11-02T23:46:00.000Z');
    expect(w.lastWindow!.missedNight).toBe(true);
  });

  it('zonder Wispr-koppeling: alleen de laag, geen fout', async () => {
    const ctx = new FixtureContext(snapshot('2026-11-06 00:16Z | groen'));
    const off: WisprProvider = {
      mode: 'live',
      listMeetings: async () => Promise.reject(new NotConnectedError('wispr')),
    };
    const items = await new ContextFirstWispr(off, ctx, { owner: 'Robert', now: NOW }).listMeetings('2026-10-31');
    expect(items.map((i) => i.rawId)).toEqual(['wm-0511']);
    expect(items[0]).toMatchObject({ processed: true, start: '2026-11-05' });
  });

  it('LiveWispr volgt has_more en next_cursor tot het einde (geen stop na één pagina)', async () => {
    paged = true;
    const items = await new LiveWispr(creds(), { url: MCP }).listMeetings('2026-11-01T00:00');
    expect(items.map((i) => i.rawId).sort()).toEqual(['wm-0411', 'wm-0511', 'wm-0611']);
    const pages = calls.filter((c) => c.method === 'tools/call').map((c) => c.params.arguments);
    expect(pages).toEqual([
      { since: '2026-10-31T23:00:00.000Z', limit: 100 },
      { since: '2026-10-31T23:00:00.000Z', limit: 100, cursor: 'c1' },
      { since: '2026-10-31T23:00:00.000Z', limit: 100, cursor: 'c2' },
    ]);
  });

  it('LiveWispr zonder endpoint gooit NotConnectedError (geen stille terugval)', async () => {
    await expect(new LiveWispr(creds()).listMeetings('2026-11-06')).rejects.toBeInstanceOf(NotConnectedError);
    void server;
  });
});

/* ---------- Meerdere collega's: owner per ingelogde collega, niet de globale HZ_OWNER ---------- */

const FIX = join(import.meta.dirname, '../../../context/test/fixtures');
const tmp = mkdtempSync(join(tmpdir(), 'hz-wispr-owner-'));
const ctxDir = join(tmp, 'ctx');
const priveDir = join(tmp, 'prive');
cpSync(join(FIX, 'ctx'), ctxDir, { recursive: true });
cpSync(join(FIX, 'prive'), priveDir, { recursive: true });
// Synthetisch: Lisanne heeft een eigen nachtrun (later dan die van Robert) en een eigen opname in de laag.
writeFileSync(
  join(ctxDir, '_systeem/routines/lisanne.md'),
  '---\ntitel: Heartbeat (synthetisch)\n---\n# Heartbeat\n\n- 2026-11-06 00:20Z | groen | gezien 1 | verwerkt 1\n',
);
writeFileSync(
  join(ctxDir, 'partners/zonnig/meetings/2026-11-05-demo-lisanne.md'),
  '---\nmeeting_id: evt-demo-lisanne\ndatum: 2026-11-05\npartners: [zonnig]\nopgenomen_door: Lisanne\nbron: -\n---\n## Samenvatting\n- Demo gegeven.\n',
);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("meetings per collega (twee collega's, één proces)", () => {
  it('elke collega eigen laagmeetings en eigen nachtrun-venster', async () => {
    const ctx = new OwnerScopedContext(
      (who) => new RepoContext(ctxDir, who === 'Robert' ? priveDir : null, who),
      () => currentUserName() ?? 'Robert',
    );
    const w = new ContextFirstWispr(new LiveWispr(creds(), { url: MCP }), ctx, {
      owner: () => currentUserName() ?? 'Robert',
      statusOwner: 'Robert',
      now: NOW,
    });
    const robert = await withUserScope('u-robert', () => w.listMeetings('2026-10-15'), { name: 'Robert' });
    const robertSince = (calls.filter((c) => c.method === 'tools/call').at(-1)!.params.arguments as { since: string })
      .since;
    const lisanne = await withUserScope('u-lisanne', () => w.listMeetings('2026-10-15'), { name: 'Lisanne' });
    const lisanneSince = (calls.filter((c) => c.method === 'tools/call').at(-1)!.params.arguments as { since: string })
      .since;
    const layer = (xs: RecItem[]) => xs.filter((i) => i.processed && i.rawId.startsWith('evt-')).map((i) => i.rawId);
    expect(layer(robert).sort()).toEqual(['evt-kickoff', 'evt-werksessie']);
    expect(layer(lisanne)).toEqual(['evt-demo-lisanne']);
    // Robert: laatste run 4 nov 00:16 Amsterdam (= 3 nov 23:16Z) min 30 min; Lisanne: 6 nov 00:20Z min 30 min.
    expect(robertSince).toBe('2026-11-03T22:46:00.000Z');
    expect(lisanneSince).toBe('2026-11-05T23:50:00.000Z');
    // Zonder eigen heartbeat: geen run van een ander lenen, maar het ruime venster (7 dagen).
    await withUserScope('u-mike', () => w.listMeetings('2026-10-15'), { name: 'Mike' });
    expect(w.lastWindow).toMatchObject({ basis: 'geen-run', missedNight: true });
  });

  it('createProviders: owner, Persoonlijk-repo en heartbeat volgen de ingelogde collega', async () => {
    const b = createProviders(
      {
        HZ_CONTEXT_REPO: ctxDir,
        HZ_PERSOONLIJK_REPO: priveDir,
        HZ_OWNER: 'Robert',
        HZ_LIVE_WISPR: '1',
        HZ_WISPR_MCP_URL: MCP,
      },
      creds(),
    );
    const w = b.providers.wispr as ContextFirstWispr;
    const r = await withUserScope(
      'u-robert',
      async () => ({ owner: w.owner(), snap: await b.providers.context.snapshot() }),
      {
        name: 'Robert',
      },
    );
    const l = await withUserScope(
      'u-lisanne',
      async () => ({
        owner: w.owner(),
        snap: await b.providers.context.snapshot(),
        runs: await w.nightRuns(w.owner()),
      }),
      { name: 'Lisanne' },
    );
    expect(r.owner).toBe('Robert');
    expect(l.owner).toBe('Lisanne');
    // De Persoonlijk-repo op schijf is van Robert: Lisanne ziet hem niet.
    expect(r.snap.pers).not.toBeNull();
    expect(l.snap.pers).toBeNull();
    expect(r.snap.status?.nachtdienst).toMatch(/^2026-11-04 00:16/);
    expect(l.snap.status?.nachtdienst).toMatch(/^2026-11-06 00:20Z/);
    expect(l.runs[0]!.at.toISOString()).toBe('2026-11-06T00:20:00.000Z');
  });
});
