/**
 * HZW-031 zelftest: contracttests tegen opgenomen (synthetische) Gmail-antwoorden; gelezen zetten is terug te
 * draaien; antwoorden wordt een concept in Gmail en er wordt nooit iets verstuurd.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ConversationDetail, MailItem } from '@hz/shared';
import { GMAIL_BASE as M, LiveGmail, MemorySyncStore, splitQuoted } from '../../src';
import { creds, mockServer } from './msw';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const hdr = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

const m1 = {
  id: 'm1',
  threadId: 'th1',
  labelIds: ['INBOX'],
  snippet: 'Hoi Robert, de ZSB-flow',
  internalDate: '1793350000000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: hdr({
      From: '"Femke" <femke@feenstra.example>',
      To: 'Robert Verveen <robert@homezero.nl>',
      Cc: 'lisanne@homezero.nl',
      Subject: 'ZSB-flow: personen en warmwatervraag',
      Date: 'Thu, 29 Oct 2026 16:05:00 +0100',
      'Message-ID': '<m1@feenstra.example>',
    }),
    parts: [
      {
        mimeType: 'text/plain',
        body: { data: b64('Hoi Robert,\n\nKunnen we de ZSB-flow aanpassen?\n\nGroet, Femke') },
      },
      { mimeType: 'application/pdf', filename: 'flow.pdf', body: { attachmentId: 'a1', size: 1000 } },
    ],
  },
};
const m2 = {
  id: 'm2',
  threadId: 'th1',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'Aanvulling',
  internalDate: '1',
  payload: {
    mimeType: 'text/html',
    headers: hdr({
      From: 'Femke <femke@feenstra.example>',
      To: 'robert@homezero.nl',
      Subject: 'Re: ZSB-flow: personen en warmwatervraag',
      // Zomertijd voorbij: 30 oktober is CET. De Date-header is leidend, niet internalDate.
      Date: 'Fri, 30 Oct 2026 08:12:00 +0000 (UTC)',
      'Message-ID': '<m2@feenstra.example>',
      References: '<m1@feenstra.example>',
    }),
    body: {
      data: b64(
        '<p>Aanvulling: ook <b>aantal personen</b>.</p><div>Op 29 okt 2026 schreef Robert:<br>&gt; eerder</div>',
      ),
    },
  },
};
const cc = {
  id: 'm3',
  threadId: 'th2',
  labelIds: ['INBOX'],
  snippet: 'Ter info',
  payload: {
    headers: hdr({
      From: 'Rens <rens@homezero.nl>',
      To: 'team@homezero.nl',
      Cc: 'robert@homezero.nl',
      Subject: 'Ter info',
      Date: 'Wed, 28 Oct 2026 09:00:00 +0100',
    }),
  },
};
const threads: Record<string, { id: string; messages: unknown[] }> = {
  th1: { id: 'th1', messages: [m1, m2] },
  th2: { id: 'th2', messages: [cc] },
};

const { server, requests, clear } = mockServer(
  http.get(`${M}/users/me/profile`, () => HttpResponse.json({ emailAddress: 'Robert@homezero.nl', historyId: '1000' })),
  http.get(`${M}/users/me/threads`, () =>
    HttpResponse.json({ threads: [{ id: 'th1' }, { id: 'th2' }], resultSizeEstimate: 2 }),
  ),
  http.get(`${M}/users/me/threads/:id`, ({ params }) => {
    const t = threads[String(params.id)];
    return t
      ? HttpResponse.json(t)
      : HttpResponse.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
  }),
  http.post(`${M}/users/me/threads/:id/modify`, async ({ params, request }) => {
    const b = (await request.json()) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    for (const m of threads[String(params.id)]!.messages as Array<{ labelIds: string[] }>) {
      m.labelIds = m.labelIds.filter((l) => !(b.removeLabelIds ?? []).includes(l));
      for (const l of b.addLabelIds ?? []) if (!m.labelIds.includes(l)) m.labelIds.push(l);
    }
    return HttpResponse.json({ id: params.id });
  }),
  http.get(`${M}/users/me/settings/sendAs`, () =>
    HttpResponse.json({
      sendAs: [
        { sendAsEmail: 'robert@homezero.nl', isPrimary: true, signature: '<div>Robert Verveen<br>HomeZero</div>' },
      ],
    }),
  ),
  http.post(`${M}/users/me/drafts`, async ({ request }) =>
    HttpResponse.json({
      id: 'draft-1',
      message: { id: 'dm1', threadId: ((await request.json()) as { message: { threadId: string } }).message.threadId },
    }),
  ),
);

const make = () => new LiveGmail(creds(), { store: new MemorySyncStore() });

describe('Gmail live (HZW-031)', () => {
  it('threads in de inbox als items: datum uit de Date-header, ongelezen, direct of cc', async () => {
    const items = await make().listThreads();
    for (const i of items) expect(() => MailItem.parse(i)).not.toThrow();
    const a = items.find((i) => i.threadId === 'th1')!;
    expect(a).toMatchObject({
      id: 'ml:th1',
      title: 'ZSB-flow: personen en warmwatervraag',
      fromName: 'Femke',
      from: 'femke@feenstra.example',
      time: '2026-10-30T09:12',
      unread: true,
      direct: true,
      count: 2,
    });
    expect(items.find((i) => i.threadId === 'th2')).toMatchObject({
      direct: false,
      unread: false,
      time: '2026-10-28T09:00',
    });
    const conv = await make().listConversations();
    expect(conv[0]).toMatchObject({ key: 'ml:th1', kind: 'mail', unread: true });
  });

  it('volledige thread: tekst (ook uit html), geciteerd deel apart, bijlagen, adressen', async () => {
    const t = (await make().getThread('th1'))!;
    expect(() => ConversationDetail.shape.mail.parse(t)).not.toThrow();
    expect(t.subject).toBe('ZSB-flow: personen en warmwatervraag');
    expect(t.msgs[0]).toMatchObject({
      fromName: 'Femke',
      to: ['robert@homezero.nl'],
      cc: ['lisanne@homezero.nl'],
      time: '2026-10-29T16:05',
      files: ['flow.pdf'],
      unread: false,
    });
    expect(t.msgs[0]!.body).toContain('Kunnen we de ZSB-flow aanpassen?');
    expect(t.msgs[1]!.body).toBe('Aanvulling: ook aantal personen.');
    expect(t.msgs[1]!.quoted).toMatch(/^Op 29 okt 2026 schreef Robert/);
    expect(await make().getThread('bestaat-niet')).toBeNull();
  });

  it('gelezen zetten is terug te draaien (UNREAD eraf en er weer op), ook echt in Gmail', async () => {
    const g = make();
    await g.markRead('th1', true);
    expect((await g.listThreads()).find((i) => i.threadId === 'th1')!.unread).toBe(false);
    await g.markRead('th1', false);
    expect((await g.listThreads()).find((i) => i.threadId === 'th1')!.unread).toBe(true);
    const mods = requests.filter((r) => r.url.pathname.endsWith('/modify')).map((r) => r.body);
    expect(mods).toEqual([{ removeLabelIds: ['UNREAD'] }, { addLabelIds: ['UNREAD'] }]);
  });

  it('antwoorden met handtekening wordt een concept in de thread; er wordt nooit verstuurd', async () => {
    clear();
    const r = await make().reply('th1', 'Dank, ik pas het aan.', { replyAll: true });
    expect(r).toEqual({ id: 'draft-1' });
    expect(requests.some((x) => /\/messages\/send|\/drafts\/send/.test(x.url.pathname))).toBe(false);
    const d = requests.find((x) => x.url.pathname.endsWith('/drafts'))!;
    const msg = (d.body as { message: { threadId: string; raw: string } }).message;
    expect(msg.threadId).toBe('th1');
    const raw = Buffer.from(msg.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: femke@feenstra.example');
    expect(raw).toContain('Subject: Re: ZSB-flow: personen en warmwatervraag');
    expect(raw).toContain('In-Reply-To: <m2@feenstra.example>');
    expect(raw).toContain('References: <m1@feenstra.example> <m2@feenstra.example>');
    expect(raw).toMatch(/Dank, ik pas het aan\.\r\n\r\n--\r\nRobert Verveen\r\nHomeZero/);
  });

  it('history voor de sync-motor: historyId bewaren, wijzigingen tellen, te oude historyId herstellen', async () => {
    const g = make();
    expect(await g.pollChanges()).toMatchObject({ first: true, historyId: '1000' });
    server.use(
      http.get(`${M}/users/me/history`, () =>
        HttpResponse.json({ history: [{ id: '1001' }, { id: '1002' }], historyId: '1002' }),
      ),
    );
    expect(await g.pollChanges()).toEqual({ changed: 2, historyId: '1002', first: false });
    server.use(
      http.get(`${M}/users/me/history`, () =>
        HttpResponse.json({ error: { code: 404, message: 'Requested entity was not found.' } }, { status: 404 }),
      ),
    );
    expect(await g.pollChanges()).toMatchObject({ changed: 1, historyId: '1000' });
  });

  it('geciteerde tekst afsplitsen (Engels en Nederlands)', () => {
    expect(splitQuoted('Prima!\n\nOn Thu, Oct 29, 2026 at 4:05 PM Mike wrote:\n> vraag')).toEqual({
      body: 'Prima!',
      quoted: 'On Thu, Oct 29, 2026 at 4:05 PM Mike wrote:\n> vraag',
    });
    expect(splitQuoted('Alleen tekst').quoted).toBe('');
  });
});
