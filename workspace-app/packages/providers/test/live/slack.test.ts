/**
 * HZW-033 zelftest: contracttests tegen een nep-Slack (synthetische, opgenomen vormen) en de test dat gelezen in
 * de app ook gelezen is in Slack (conversations.mark verschuift last_read in Slack zelf, zoals Slack-mobiel ziet).
 */
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { Conversation, Message, SlackItem } from '@hz/shared';
import {
  AuthError,
  LiveSlack,
  MemorySyncStore,
  NotHumanError,
  RateLimitError,
  SLACK_BASE as S,
  withHumanAction,
  withUserScope,
} from '../../src';
import { mockServer } from './msw';

const ME = 'U04L22BRJQ7';
const users = [
  { id: ME, name: 'robert', real_name: 'Robert Verveen', profile: { display_name: 'Robert' } },
  { id: 'UMJ', name: 'mj', real_name: 'Femke', profile: { display_name: '' } },
  { id: 'UMIKE', name: 'mike', real_name: 'Mike', profile: { display_name: 'Mike' } },
];
const convs = [
  { id: 'CDEMOFEEN', name: 'feenstra-hz', is_channel: true, purpose: { value: 'Partnerkanaal Feenstra' } },
  { id: 'DDEMOMIKE', is_im: true, user: 'UMIKE' },
  { id: 'CDEMOINT', name: '02-intern', is_channel: true, is_private: true },
];
let slack: {
  lastRead: Record<string, string>;
  history: Record<string, Array<Record<string, unknown>>>;
  posted: unknown[];
  reactions: unknown[];
};
beforeEach(() => {
  slack = {
    lastRead: { CDEMOFEEN: '1793260000.000100', DDEMOMIKE: '1793300000.000100', CDEMOINT: '1793350000.000300' },
    history: {
      CDEMOFEEN: [
        {
          ts: '1793262720.000200',
          user: 'UMJ',
          text: 'De leads van gisteravond staan niet in de planning, <@U04L22BRJQ7> kan je kijken?',
          reply_count: 2,
          latest_reply: '1793263000.000100',
          reactions: [{ name: 'eyes', count: 2, users: ['UMIKE', ME] }],
        },
        { ts: '1793261000.000100', user: ME, text: 'Goedemorgen' },
      ],
      DDEMOMIKE: [{ ts: '1793299000.000100', user: 'UMIKE', text: 'Kan jij Peter van TonZon nog een keer bellen?' }],
      CDEMOINT: [{ ts: '1793350000.000300', user: 'UMIKE', text: 'Gelezen bericht', files: [{ name: 'plan.pdf' }] }],
    },
    posted: [],
    reactions: [],
  };
});

const form = async (r: Request) => Object.fromEntries(new URLSearchParams(await r.text()));
const q = (r: Request) => Object.fromEntries(new URL(r.url).searchParams);

const { server, requests, clear } = mockServer(
  http.get(`${S}/auth.test`, () =>
    HttpResponse.json({ ok: true, user_id: ME, team_id: 'TDEMO', url: 'https://homezero-demo.slack.com/' }),
  ),
  http.get(`${S}/users.list`, () =>
    HttpResponse.json({ ok: true, members: users, response_metadata: { next_cursor: '' } }),
  ),
  http.get(`${S}/users.conversations`, ({ request }) => {
    const c = q(request).cursor;
    return HttpResponse.json(
      c
        ? { ok: true, channels: convs.slice(2), response_metadata: { next_cursor: '' } }
        : { ok: true, channels: convs.slice(0, 2), response_metadata: { next_cursor: 'next1' } },
    );
  }),
  http.get(`${S}/conversations.info`, ({ request }) => {
    const ch = q(request).channel!;
    return HttpResponse.json({
      ok: true,
      channel: { ...convs.find((c) => c.id === ch), last_read: slack.lastRead[ch] },
    });
  }),
  http.get(`${S}/conversations.history`, ({ request }) => {
    const { channel, limit } = q(request);
    const h = [...(slack.history[channel!] ?? [])].sort((a, b) => parseFloat(String(b.ts)) - parseFloat(String(a.ts)));
    return HttpResponse.json({ ok: true, messages: h.slice(0, Number(limit ?? 100)) });
  }),
  http.get(`${S}/conversations.replies`, () =>
    HttpResponse.json({
      ok: true,
      messages: [
        slack.history.CDEMOFEEN![0],
        { ts: '1793263000.000100', user: ME, text: 'Ik kijk!', thread_ts: '1793262720.000200' },
      ],
    }),
  ),
  http.get(`${S}/search.messages`, ({ request }) => {
    const query = q(request).query!;
    const m = (ch: (typeof convs)[number], msg: Record<string, unknown>) => ({
      ...msg,
      channel: { id: ch.id, name: ch.name, is_im: !!ch.is_im },
      permalink: `https://homezero-demo.slack.com/archives/${ch.id}/p${String(msg.ts).replace('.', '')}`,
    });
    if (query.startsWith('to:me'))
      return HttpResponse.json({ ok: true, messages: { matches: [m(convs[1]!, slack.history.DDEMOMIKE![0]!)] } });
    if (query.startsWith('<@'))
      return HttpResponse.json({ ok: true, messages: { matches: [m(convs[0]!, slack.history.CDEMOFEEN![0]!)] } });
    return HttpResponse.json({ ok: true, messages: { matches: [m(convs[2]!, slack.history.CDEMOINT![0]!)] } });
  }),
  http.post(`${S}/conversations.mark`, async ({ request }) => {
    const b = await form(request);
    slack.lastRead[b.channel!] = b.ts!;
    return HttpResponse.json({ ok: true });
  }),
  http.post(`${S}/chat.postMessage`, async ({ request }) => {
    slack.posted.push(await form(request));
    return HttpResponse.json({ ok: true, ts: '1793400000.000100', channel: 'CDEMOFEEN' });
  }),
  http.post(`${S}/reactions.add`, async ({ request }) => {
    slack.reactions.push(await form(request));
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${S}/emoji.list`, () =>
    HttpResponse.json({
      ok: true,
      emoji: { mega: 'https://emoji.slack-edge.com/TDEMO/mega/abc.png', hz: 'alias:mega' },
    }),
  ),
);

const creds = () => {
  const rejected: string[] = [];
  return { accessToken: async () => 'xoxp-test', rejected: async (p: string) => void rejected.push(p), list: rejected };
};
const make = (c = creds()) =>
  new LiveSlack(c, { store: new MemorySyncStore(), stateTtlMs: 0, now: () => new Date('2026-10-30T07:40:00Z') });

describe('Slack live met user token (HZW-033)', () => {
  it('kanalen, DM’s en groepen (gepagineerd) met echte ongelezen-status uit last_read', async () => {
    const list = await make().listConversations();
    for (const c of list) expect(() => Conversation.parse(c)).not.toThrow();
    expect(list.map((c) => c.key).sort()).toEqual(['sl:CDEMOFEEN', 'sl:CDEMOINT', 'sl:DDEMOMIKE']);
    const feen = list.find((c) => c.key === 'sl:CDEMOFEEN')!;
    expect(feen).toMatchObject({ kind: 'ch', name: '#feenstra-hz', unread: true, purpose: 'Partnerkanaal Feenstra' });
    expect(feen.preview).toBe('Femke: De leads van gisteravond staan niet in de planning, @Robert kan je kijken?');
    expect(list.find((c) => c.key === 'sl:DDEMOMIKE')).toMatchObject({ kind: 'dm', name: 'Mike', unread: false });
    expect(list.find((c) => c.key === 'sl:CDEMOINT')).toMatchObject({ unread: false });
    expect(requests.every((r) => r.headers.get('authorization') === 'Bearer xoxp-test')).toBe(true);
  });

  it('geschiedenis en threads in de contractvorm (reacties met eigen markering, bestanden)', async () => {
    const s = make();
    const h = await s.history('CDEMOFEEN');
    for (const m of h) expect(() => Message.parse(m)).not.toThrow();
    expect(h.map((m) => m.ts)).toEqual(['1793261000.000100', '1793262720.000200']);
    expect(h[1]).toMatchObject({
      fromName: 'Femke',
      me: false,
      replies: 2,
      latest: '1793263000.000100',
      time: '2026-10-29T09:32',
      reactions: [{ name: 'eyes', count: 2, mine: true }],
    });
    expect(h[0]).toMatchObject({ me: true, fromName: 'Robert' });
    expect((await s.history('CDEMOINT'))[0]!.files).toEqual(['plan.pdf']);
    const t = await s.thread('CDEMOFEEN', '1793262720.000200');
    expect(t.map((m) => m.text)).toEqual([expect.stringContaining('De leads'), 'Ik kijk!']);
  });

  it('aandacht: DM’s, vermeldingen en eigen markeringen, met gelezen-status uit Slack', async () => {
    const items = await make().attention();
    for (const i of items) expect(() => SlackItem.parse(i)).not.toThrow();
    const byCh = Object.fromEntries(items.map((i) => [i.channelId, i]));
    expect(byCh.CDEMOFEEN).toMatchObject({
      mention: true,
      read: false,
      channel: '#feenstra-hz',
      fromName: 'Femke',
    });
    expect(byCh.DDEMOMIKE).toMatchObject({ dm: true, read: true, channel: 'DM Mike' });
    expect(byCh.CDEMOINT).toMatchObject({ mega: true });
    const queries = requests
      .filter((r) => r.url.pathname.endsWith('search.messages'))
      .map((r) => r.url.searchParams.get('query'));
    expect(queries).toEqual(['to:me after:2026-10-23', `<@${ME}> after:2026-10-23`, 'hasmy::mega:']);
  });

  it('gelezen in de app is gelezen in Slack (conversations.mark): Slack zelf geeft daarna de nieuwe last_read', async () => {
    const s = make();
    expect((await s.listConversations()).find((c) => c.key === 'sl:CDEMOFEEN')!.unread).toBe(true);
    await s.markRead('CDEMOFEEN', '1793262720.000200');
    // Wat Slack (en dus Slack-mobiel) nu als gelezen-tot heeft:
    expect(slack.lastRead.CDEMOFEEN).toBe('1793262720.000200');
    const mark = requests.find((r) => r.url.pathname.endsWith('conversations.mark'))!;
    expect(mark.method).toBe('POST');
    expect(mark.body).toEqual({ channel: 'CDEMOFEEN', ts: '1793262720.000200' });
    // Een verse lezer (andere app, lege cache) ziet het ook als gelezen.
    const other = make();
    expect((await other.listConversations()).find((c) => c.key === 'sl:CDEMOFEEN')!.unread).toBe(false);
    expect((await other.attention()).find((i) => i.channelId === 'CDEMOFEEN')!.read).toBe(true);
  });

  it('gelezen in een andere Slack-app (event channel_marked) werkt de status bij', async () => {
    const s = new LiveSlack(creds(), { store: new MemorySyncStore(), stateTtlMs: 60_000 });
    expect((await s.listConversations()).find((c) => c.key === 'sl:CDEMOFEEN')!.unread).toBe(true);
    expect(await s.applyEvent({ type: 'channel_marked', channel: 'CDEMOFEEN', ts: '1793262720.000200' })).toBe(true);
    clear();
    expect((await s.listConversations()).find((c) => c.key === 'sl:CDEMOFEEN')!.unread).toBe(false);
    expect(requests.some((r) => r.url.pathname.endsWith('conversations.info'))).toBe(false);
  });

  it('versturen en reageren alleen na een klik van een mens', async () => {
    const s = make();
    await expect(s.postMessage('CDEMOFEEN', 'Ik kijk ernaar')).rejects.toBeInstanceOf(NotHumanError);
    await expect(s.react('CDEMOFEEN', '1793262720.000200', 'eyes')).rejects.toBeInstanceOf(NotHumanError);
    expect(slack.posted).toHaveLength(0);
    expect(requests.some((r) => r.url.pathname.endsWith('chat.postMessage'))).toBe(false);
    await withUserScope('u1', () =>
      withHumanAction('u1', async () => {
        expect(await s.postMessage('CDEMOFEEN', 'Ik kijk ernaar', '1793262720.000200')).toEqual({
          ts: '1793400000.000100',
        });
        await s.react('CDEMOFEEN', '1793262720.000200', ':white_check_mark:');
      }),
    );
    expect(slack.posted).toEqual([{ channel: 'CDEMOFEEN', text: 'Ik kijk ernaar', thread_ts: '1793262720.000200' }]);
    expect(slack.reactions).toEqual([
      { channel: 'CDEMOFEEN', timestamp: '1793262720.000200', name: 'white_check_mark' },
    ]);
    // Een klik van collega A geldt niet voor collega B.
    await expect(
      withUserScope('u2', () => withHumanAction('u1', () => s.postMessage('CDEMOFEEN', 'x'))),
    ).rejects.toBeInstanceOf(NotHumanError);
  });

  it('eigen workspace-emoji', async () => {
    expect(await make().customEmoji()).toEqual({ mega: expect.stringContaining('mega'), hz: 'alias:mega' });
  });

  it('fouten: {ok:false, invalid_auth} -> AuthError en koppeling afgewezen; 429 -> RateLimitError', async () => {
    const c = creds();
    server.use(http.get(`${S}/auth.test`, () => HttpResponse.json({ ok: false, error: 'invalid_auth' })));
    await expect(make(c).history('CDEMOFEEN')).rejects.toBeInstanceOf(AuthError);
    expect(c.list).toContain('slack');
    server.use(
      http.get(`${S}/auth.test`, () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '3' } })),
    );
    const e = await make()
      .history('CDEMOFEEN')
      .catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.retryAfterMs).toBe(3000);
  });
});

describe('leescursor in beide richtingen en gelezen op een ander apparaat (HZW-033, ronde 3)', () => {
  const FEEN = 'sl:CDEMOFEEN';
  const NEW = '1793262720.000200';
  const OLD = '1793261000.000100';
  /** Lange cache (zoals in productie, 5 min): de app moet zijn eigen bewaarde stand goed hebben. */
  const cached = () => new LiveSlack(creds(), { store: new MemorySyncStore(), stateTtlMs: 5 * 60_000 });
  const calls = (m: string) => requests.filter((r) => r.url.pathname.endsWith(m)).length;

  it('ongelezen zetten (leescursor terug) toont het gesprek en het aandacht-item direct weer als ongelezen', async () => {
    const s = cached();
    await s.markRead('CDEMOFEEN', NEW);
    expect((await s.listConversations()).find((c) => c.key === FEEN)!.unread).toBe(false);
    expect((await s.attention()).find((i) => i.channelId === 'CDEMOFEEN')!.read).toBe(true);
    // Terug naar het bericht ervoor: Slack staat op OLD, en de app (uit de cache, binnen 5 min) ook.
    await s.markRead('CDEMOFEEN', OLD);
    expect(slack.lastRead.CDEMOFEEN).toBe(OLD);
    clear();
    expect((await s.listConversations()).find((c) => c.key === FEEN)!.unread).toBe(true);
    expect((await s.attention()).find((i) => i.channelId === 'CDEMOFEEN')!.read).toBe(false);
    expect(calls('conversations.info')).toBe(0); // het kwam uit de eigen stand, niet uit een verse ophaalronde
  });

  it('gelezen op Slack-mobiel: pollReadState haalt last_read buiten de cache om op, alleen voor ongelezen gesprekken', async () => {
    const s = cached();
    expect((await s.listConversations()).find((c) => c.key === FEEN)!.unread).toBe(true);
    slack.lastRead.CDEMOFEEN = NEW; // gelezen op een ander apparaat; er komt geen event (Events API kent geen *_marked)
    clear();
    expect((await s.listConversations()).find((c) => c.key === FEEN)!.unread).toBe(true); // cache: nog oud
    const r = await s.pollReadState({ events: true });
    expect(r).toEqual({ read: 1, full: 0 });
    const info = requests.filter((x) => x.url.pathname.endsWith('conversations.info'));
    expect(info.map((x) => x.url.searchParams.get('channel'))).toEqual(['CDEMOFEEN']);
    expect(calls('conversations.history')).toBe(0);
    clear();
    expect((await s.listConversations({ fetch: false })).find((c) => c.key === FEEN)!.unread).toBe(false);
    expect(requests.some((x) => x.url.pathname.startsWith('/api/conversations.'))).toBe(false);
  });

  it('ongelezen gezet op een ander apparaat: zonder Events ververst de poll verouderde standen volledig', async () => {
    let t = 1_000_000;
    const real = Date.now;
    Date.now = () => t;
    try {
      const s = cached();
      await s.markRead('CDEMOFEEN', NEW);
      await s.listConversations();
      slack.lastRead.CDEMOFEEN = OLD; // elders ongelezen gezet
      t += 5 * 60_000; // na stateTtl
      clear();
      const r = await s.pollReadState({ events: false });
      expect(r.full).toBe(3);
      expect((await s.listConversations({ fetch: false })).find((c) => c.key === FEEN)!.unread).toBe(true);
      // Met Events: dezelfde stand is pas na 30 minuten "verouderd" (vangnet); binnen die tijd geen calls.
      clear();
      t += 60_000;
      expect(await s.pollReadState({ events: true })).toEqual({ read: 1, full: 0 }); // alleen het ongelezen gesprek
    } finally {
      Date.now = real;
    }
  });

  it('een event zonder tekst (webhook bewaart geen inhoud): de poll haalt dat gesprek volledig op', async () => {
    const s = cached();
    await s.markRead('CDEMOFEEN', NEW);
    await s.listConversations();
    slack.history.CDEMOFEEN!.push({ ts: '1793263500.000100', user: 'UMIKE', text: 'Nieuw bericht' });
    expect(await s.applyEvent({ type: 'message', channel: 'CDEMOFEEN', ts: '1793263500.000100', user: 'UMIKE' })).toBe(
      true,
    );
    clear();
    expect(await s.pollReadState({ events: true })).toEqual({ read: 0, full: 1 });
    const c = (await s.listConversations({ fetch: false })).find((x) => x.key === FEEN)!;
    expect(c).toMatchObject({ unread: true, preview: 'Mike: Nieuw bericht' });
  });

  it('rate limit bij een koude start: RateLimitError gaat door, geen gesprekken die stil als gelezen tonen', async () => {
    server.use(
      http.get(
        `${S}/conversations.info`,
        () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '7' } }),
      ),
    );
    const e = await cached()
      .listConversations()
      .catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.retryAfterMs).toBe(7000);
    const a = await cached()
      .attention()
      .catch((x) => x);
    expect(a).toBeInstanceOf(RateLimitError);
  });

  it('rate limit met een bekende stand: de bewaarde (echte) stand blijft, de worker-poll krijgt de fout', async () => {
    let t = 1_000_000;
    const real = Date.now;
    Date.now = () => t;
    try {
      const s = cached();
      await s.listConversations();
      t += 10 * 60_000;
      server.use(http.get(`${S}/conversations.info`, () => HttpResponse.json({ ok: false, error: 'ratelimited' })));
      const list = await s.listConversations();
      expect(list.find((c) => c.key === FEEN)!.unread).toBe(true);
      await expect(s.pollReadState()).rejects.toBeInstanceOf(RateLimitError);
    } finally {
      Date.now = real;
    }
  });

  it('koude start begrensd: max. 20 gesprekken (20x info + 20x history) per verzoek, max. 3 tegelijk', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `CMANY${i}`, name: `kanaal-${i}`, is_channel: true }));
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    };
    server.use(
      http.get(`${S}/users.conversations`, () => HttpResponse.json({ ok: true, channels: many })),
      http.get(`${S}/conversations.info`, async ({ request }) => {
        await slow();
        return HttpResponse.json({ ok: true, channel: { id: q(request).channel, last_read: '1793262720.000200' } });
      }),
      http.get(`${S}/conversations.history`, async () => {
        await slow();
        return HttpResponse.json({ ok: true, messages: [{ ts: '1793262720.000200', user: 'UMJ', text: 'x' }] });
      }),
    );
    const s = cached();
    clear();
    const list = await s.listConversations();
    expect(list).toHaveLength(45);
    expect(calls('conversations.info')).toBe(20);
    expect(calls('conversations.history')).toBe(20);
    expect(peak).toBeLessThanOrEqual(6); // 3 gesprekken tegelijk, elk info + history
    // De worker vult de rest aan binnen zijn budget (40 calls = 20 volledige standen per run).
    clear();
    expect(await s.pollReadState({ events: true })).toEqual({ read: 0, full: 20 });
  });
});
