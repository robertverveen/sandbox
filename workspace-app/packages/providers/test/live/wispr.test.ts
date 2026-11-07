/**
 * HZW-035 zelftest: meeting van gisteren zichtbaar, ook als de nachtdienst hem nog niet had. De laag levert de
 * verwerkte meetings; live Wispr (nep-MCP-server in msw) alleen wat na de laatste nachtrun kwam.
 */
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContextSnapshot, RecItem } from '@hz/shared';
import { ContextFirstWispr, FixtureContext, LiveWispr, NotConnectedError, type WisprProvider } from '../../src';
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
beforeEach(() => {
  calls = [];
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
    // Antwoord als SSE (streamable HTTP), zoals een MCP-server mag doen.
    return new HttpResponse(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: JSON.stringify({ meetings }) }] } })}\n\n`,
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
      arguments: { since: '2026-11-05T23:46:00.000Z', limit: 60 },
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

  it('LiveWispr zonder endpoint gooit NotConnectedError (geen stille terugval)', async () => {
    await expect(new LiveWispr(creds()).listMeetings('2026-11-06')).rejects.toBeInstanceOf(NotConnectedError);
    void server;
  });
});
