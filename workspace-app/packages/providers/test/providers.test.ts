import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportContext, writeExport } from '@hz/context';
import { ContextSnapshot, Conversation, Item, Message, Weekdoel } from '@hz/shared';
import { ymd } from '@hz/shared/logic';
import { createProviders, loadFixtureSet, NotConnectedError, type Providers } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, '../../context/test/fixtures');

describe('fixture-datasets passen op het domeinmodel', () => {
  for (const name of ['demo', 'harness'] as const) {
    it(`${name}: alle items, gesprekken en weekdoelen valideren`, () => {
      const ds = loadFixtureSet(name, name === 'harness' ? new Date(2026, 10, 7, 9, 0) : undefined);
      const items = [
        ...ds.meetings,
        ...ds.recs,
        ...ds.mails,
        ...ds.slack,
        ...ds.tasks,
        ...ds.jira.issues,
        ...ds.legacyCommits,
      ];
      for (const it of items) expect(() => Item.parse(it), it.id).not.toThrow();
      for (const c of ds.mailConvs) Conversation.parse(c);
      for (const list of Object.values(ds.history)) list.forEach((m) => Message.parse(m));
      ds.weekdoelen.forEach((w) => Weekdoel.parse(w));
      ContextSnapshot.parse(ds.context);
    });
  }

  it('demo heeft de klok van het prototype (vr 30 okt 2026 08:40)', () => {
    const { now, info } = createProviders({});
    expect(ymd(now())).toBe('2026-10-30');
    expect(now().getHours()).toBe(8);
    expect(info).toMatchObject({ fixtureSet: 'demo', contextSource: 'fixture', live: [] });
  });

  it('harness rekent vanaf nu: Feenstra-afspraak vandaag, Warmwaterwerk morgen', () => {
    const { dataset, now } = createProviders({ HZ_FIXTURE_SET: 'harness', HZ_NOW: '2026-11-07T09:00' });
    expect(ymd(now())).toBe('2026-11-07');
    expect(dataset.meetings.map((m) => m.start)).toEqual(['2026-11-07T13:00', '2026-11-08T11:00']);
    expect(dataset.tasks.find((t) => t.id === 'g2')?.due).toBe('2026-11-07');
  });
});

describe('fixture-providers onthouden wat je doet, en sturen niets', () => {
  const fresh = () => createProviders({});

  it('taken: toevoegen, verplaatsen, afvinken', async () => {
    const { providers: p, log } = fresh();
    const t = await p.tasks.addTask({ title: 'Nieuwe taak', due: '2026-10-30' });
    expect((await p.tasks.listTasks()).map((x) => x.title)).toContain('Nieuwe taak');
    await p.tasks.updateTask(t.id, { due: '2026-11-02' });
    await p.tasks.updateTask(t.id, { done: true });
    expect((await p.tasks.listTasks()).find((x) => x.id === t.id)).toBeUndefined();
    expect(log.calls.map((c) => c.op)).toEqual(['add', 'update', 'update']);
  });

  it('slack: gelezen zetten, reageren, bericht (alleen in het geheugen)', async () => {
    const { providers: p } = fresh();
    const before = await p.slack.listConversations();
    expect(before.find((c) => c.key === 'sl:CDEMOFEEN')?.unread).toBe(true);
    const items = await p.slack.attention();
    await p.slack.markRead('CDEMOFEEN', items.find((i) => i.id === 's1')!.ts!);
    expect((await p.slack.listConversations()).find((c) => c.key === 'sl:CDEMOFEEN')?.unread).toBe(false);
    const h = await p.slack.history('CDEMOFEEN');
    await p.slack.react('CDEMOFEEN', h[0]!.ts, 'eyes');
    expect((await p.slack.history('CDEMOFEEN'))[0]!.reactions).toEqual([{ name: 'eyes', count: 1, mine: true }]);
    const thread = await p.slack.thread('CDEMOFEEN', h[2]!.ts);
    expect(thread).toHaveLength(3);
  });

  it('gmail: gelezen zetten is terug te draaien', async () => {
    const { providers: p } = fresh();
    await p.gmail.markRead('demo-zsb', true);
    expect((await p.gmail.listThreads()).find((m) => m.threadId === 'demo-zsb')?.unread).toBe(false);
    await p.gmail.markRead('demo-zsb', false);
    expect((await p.gmail.listThreads()).find((m) => m.threadId === 'demo-zsb')?.unread).toBe(true);
    expect((await p.gmail.getThread('demo-zsb'))?.msgs).toHaveLength(2);
  });

  it('agenda: periode en reageren op een uitnodiging', async () => {
    const { providers: p } = fresh();
    const evs = await p.calendar.listEvents({ from: '2026-10-30', to: '2026-10-31' });
    expect(evs.map((e) => e.id)).toEqual(['m1', 'm2', 'm3', 'lou1']);
    await p.calendar.respond('m8', 'accepted');
    expect((await p.calendar.listEvents({ from: '2026-11-02', to: '2026-11-03' }))[0]!.needsAction).toBe(false);
  });

  it('agenda: bezet per collega (op e-mail of voornaam) en afspraak maken, alles in het geheugen', async () => {
    const { providers: p, log } = fresh();
    const fb = await p.calendar.freeBusy(['robert@homezero.nl', 'lisanne@homezero.nl', 'onbekend@homezero.nl'], {
      from: '2026-10-30',
      to: '2026-10-31',
    });
    expect(fb[1]!.busy).toEqual([
      { start: '2026-10-30T10:00', end: '2026-10-30T11:00' },
      { start: '2026-10-30T13:00', end: '2026-10-30T13:45' },
    ]);
    expect(fb[0]!.busy.length).toBeGreaterThanOrEqual(3);
    expect(fb[2]!.busy).toEqual([]);
    const ev = await p.calendar.createEvent({
      title: 'Afstemmen',
      start: '2026-11-02T14:00',
      end: '2026-11-02T14:30',
      attendees: ['lisanne@homezero.nl'],
      meet: true,
    });
    expect((await p.calendar.listEvents({ from: '2026-11-02', to: '2026-11-03' })).map((e) => e.id)).toContain(ev.id);
    expect(log.calls.at(-1)).toMatchObject({ provider: 'calendar', op: 'createEvent' });
  });

  it('jira en nep-Anthropic', async () => {
    const { providers: p } = fresh();
    const sp = await p.jira.activeSprint();
    expect(sp.sprint?.name).toBe('Sprint 73');
    expect(sp.issues.filter((i) => i.mine).map((i) => i.key)).toEqual(['DEMO-12', 'DEMO-15']);
    const r = await p.anthropic.complete({
      purpose: 'ask',
      system: 'sys',
      messages: [{ role: 'user', content: 'Wat speelt er bij Feenstra?' }],
    });
    expect(r.text).toContain('Feenstra');
    expect(r.model).toBe('fake-ask');
  });
});

describe('live-implementaties zijn lege schillen', () => {
  it('HZ_LIVE_<BRON>=1 kiest live; zonder bouw gooit die NotConnectedError', async () => {
    const { providers: p, info } = createProviders({ HZ_LIVE_SLACK: '1', HZ_LIVE_CALENDAR: '1' });
    expect(info.live).toEqual(['calendar', 'slack']);
    expect(p.slack.mode).toBe('live');
    await expect(p.slack.listConversations()).rejects.toBeInstanceOf(NotConnectedError);
    await expect(p.calendar.listCalendars()).rejects.toBeInstanceOf(NotConnectedError);
    expect(p.gmail.mode).toBe('fixture');
  });

  it('alle live-methodes gooien (geen stille terugval op nepdata)', async () => {
    const all = ['CALENDAR', 'GMAIL', 'TASKS', 'SLACK', 'JIRA', 'WISPR', 'ANTHROPIC'];
    const { providers } = createProviders(Object.fromEntries(all.map((k) => [`HZ_LIVE_${k}`, '1'])));
    const calls: Array<[keyof Providers, () => Promise<unknown>]> = [
      ['calendar', () => providers.calendar.listEvents({ from: 'a', to: 'b' })],
      ['calendar', () => providers.calendar.freeBusy(['a@homezero.nl'], { from: 'a', to: 'b' })],
      [
        'calendar',
        () => providers.calendar.createEvent({ title: 'x', start: 'a', end: 'b', attendees: [], meet: false }),
      ],
      ['gmail', () => providers.gmail.listThreads()],
      ['tasks', () => providers.tasks.listTasks()],
      ['slack', () => providers.slack.attention()],
      ['jira', () => providers.jira.activeSprint()],
      ['wispr', () => providers.wispr.listMeetings('2026-01-01')],
      ['anthropic', () => providers.anthropic.complete({ purpose: 'ask', system: '', messages: [] })],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toBeInstanceOf(NotConnectedError);
  });
});

describe('context-provider', () => {
  it('HZ_CONTEXT_EXPORT leest een export-map', async () => {
    const out = mkdtempSync(join(tmpdir(), 'hz-prov-'));
    writeExport(out, exportContext(join(FX, 'ctx'), join(FX, 'prive'), { today: '2026-11-05' }));
    const { providers, info } = createProviders({ HZ_CONTEXT_EXPORT: out });
    expect(info.contextSource).toBe('export');
    const snap = await providers.context.snapshot();
    expect(Object.keys(snap.partners)).toContain('zonnig');
    expect(snap.pers?.taken.open).toHaveLength(2);
  });

  it('HZ_CONTEXT_REPO parset de repo zelf (alleen lezen)', async () => {
    const { providers, info } = createProviders({
      HZ_CONTEXT_REPO: join(FX, 'ctx'),
      HZ_PERSOONLIJK_REPO: join(FX, 'prive'),
    });
    expect(info.contextSource).toBe('repo');
    const snap = await providers.context.snapshot();
    expect(snap.acties.zonnig?.acties.length).toBeGreaterThan(0);
    expect(JSON.stringify(snap)).not.toContain('GEHEIM-ADMIN-MARKER');
  });

  it('zonder variabelen: DEMO_CTX', async () => {
    const snap = await createProviders({}).providers.context.snapshot();
    expect(Object.keys(snap.partners)).toEqual(['feenstra', 'tonzon', 'sunergy']);
  });
});
