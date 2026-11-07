/**
 * HZW-037 (spike) zelftest in de repo: het proefscript en de provider-schil tegen een nep-Slack. Het echte
 * proefscript tegen de HomeZero-workspace draait een mens met een user token (tools/spike-slack-todos.ts).
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { TaskItem } from '@hz/shared';
import {
  CombinedTasks,
  LiveSlack,
  MemorySyncStore,
  NotHumanError,
  SLACK_BASE as S,
  SlackTodos,
  createProviders,
  probeSlackTodos,
  withHumanAction,
  withUserScope,
} from '../../src';
import { mockServer } from './msw';

const reminders = [
  {
    id: 'Rm1',
    creator: 'UME',
    user: 'UME',
    text: 'Offerte TonZon nalopen',
    time: 1793350800,
    complete_ts: 0,
    recurring: false,
  },
  { id: 'Rm2', creator: 'UME', user: 'UME', text: 'Al gedaan', time: 1793264400, complete_ts: 1793265000 },
  { id: 'Rm3', creator: 'UME', user: 'UANDER', text: 'Voor een ander', time: 1793350800, complete_ts: 0 },
];
const completed: string[] = [];
const added: unknown[] = [];

const { server, requests } = mockServer(
  http.get(`${S}/auth.test`, () => HttpResponse.json({ ok: true, user_id: 'UME', team_id: 'T' })),
  http.get(`${S}/reminders.list`, () => HttpResponse.json({ ok: true, reminders })),
  http.get(`${S}/reminders.info`, ({ request }) => {
    const id = new URL(request.url).searchParams.get('reminder');
    return HttpResponse.json({
      ok: true,
      reminder: { ...reminders.find((r) => r.id === id), complete_ts: 1793400000 },
    });
  }),
  http.post(`${S}/reminders.complete`, async ({ request }) => {
    completed.push(new URLSearchParams(await request.text()).get('reminder')!);
    return HttpResponse.json({ ok: true });
  }),
  http.post(`${S}/reminders.add`, async ({ request }) => {
    const b = Object.fromEntries(new URLSearchParams(await request.text()));
    added.push(b);
    return HttpResponse.json({
      ok: true,
      reminder: { id: 'RmNew', text: b.text, time: Number(b.time) || 0, complete_ts: 0, user: 'UME' },
    });
  }),
  http.post(`${S}/reminders.delete`, () => HttpResponse.json({ ok: true })),
  http.post(`${S}/slackLists.items.list`, async ({ request }) => {
    const b = Object.fromEntries(new URLSearchParams(await request.text()));
    if (b.list_id !== 'F0LIST1') return HttpResponse.json({ ok: false, error: 'list_not_found' });
    return HttpResponse.json({
      ok: true,
      items: [
        {
          id: 'Rec1',
          list_id: 'F0LIST1',
          fields: [
            { key: 'name', text: 'Partnerovereenkomst 3.0 doorlezen' },
            { key: 'due', date: ['2026-11-04'] },
            { key: 'todo_completed', value: false },
          ],
        },
        {
          id: 'Rec2',
          list_id: 'F0LIST1',
          fields: [
            { key: 'name', text: 'Klaar item' },
            { key: 'todo_completed', value: true },
          ],
        },
      ],
      response_metadata: { next_cursor: '' },
    });
  }),
  http.get(`${S}/stars.list`, () => HttpResponse.json({ ok: false, error: 'method_deprecated' })),
);

const slack = () => new LiveSlack({ accessToken: async () => 'xoxp-test' }, { store: new MemorySyncStore() });

describe('spike Slack-to-do’s (HZW-037)', () => {
  it('proefscript: per soort wel/niet (herinneringen ja, Lists met testlijst ja, Later nee)', async () => {
    const r = await probeSlackTodos(slack(), { listId: 'F0LIST1', write: true });
    expect(r.map((x) => [x.soort, x.kan])).toEqual([
      ['herinneringen', true],
      ['herinneringen', true],
      ['lists', true],
      ['later', false],
    ]);
    expect(added).toEqual([{ text: 'HZW-037 proefherinnering (mag weg)', time: 'in 2 days' }]);
    expect(requests.some((x) => x.url.pathname.endsWith('reminders.delete'))).toBe(true);
    const zonder = await probeSlackTodos(slack(), { listId: 'F0ONBEKEND' });
    expect(zonder.find((x) => x.soort === 'lists')).toMatchObject({
      kan: false,
      detail: expect.stringContaining('list_not_found'),
    });
  });

  it('schil: open eigen herinneringen en open Lists-items als taken (contractvorm)', async () => {
    const t = await new SlackTodos(slack(), [{ id: 'F0LIST1', title: 'Mijn to-do' }]).listTasks();
    for (const x of t) expect(() => TaskItem.parse(x)).not.toThrow();
    expect(t.map((x) => x.title)).toEqual(['Offerte TonZon nalopen', 'Partnerovereenkomst 3.0 doorlezen']);
    expect(t[0]).toMatchObject({ rawId: 'slr-Rm1', tasklist: 'slack:reminders', due: '2026-10-30' });
    expect(t[1]).toMatchObject({ tasklist: 'slack:list:F0LIST1', tasklistTitle: 'Mijn to-do', due: '2026-11-04' });
  });

  it('afvinken van een herinnering alleen na een klik; Lists bijwerken nog niet', async () => {
    const p = new SlackTodos(slack());
    await expect(p.updateTask('tk:slr-Rm1', { done: true })).rejects.toBeInstanceOf(NotHumanError);
    const done = await withUserScope('u', () => withHumanAction('u', () => p.updateTask('tk:slr-Rm1', { done: true })));
    expect(completed).toEqual(['Rm1']);
    expect(done.status).toBe('completed');
    await expect(withHumanAction('u', () => p.updateTask('tk:sll-F0LIST1-Rec1', { done: true }))).rejects.toThrow(
      /Lists bijwerken nog niet/,
    );
  });

  it('achter de vlag: HZ_SLACK_TODOS=1 voegt Slack-to-do’s toe naast Google Taken, zonder dubbelingen', async () => {
    const off = createProviders({ HZ_LIVE_SLACK: '1' }, { accessToken: async () => 'xoxp-test' });
    expect(off.providers.tasks).not.toBeInstanceOf(CombinedTasks);
    const on = createProviders(
      { HZ_LIVE_SLACK: '1', HZ_SLACK_TODOS: '1', HZ_SLACK_TODO_LISTS: 'F0LIST1:Mijn to-do' },
      { accessToken: async () => 'xoxp-test' },
    );
    expect(on.providers.tasks).toBeInstanceOf(CombinedTasks);
    expect(on.info.live).toContain('slack_todos');
    const titles = (await on.providers.tasks.listTasks()).map((t) => t.title);
    // Fixture-Google-Taken plus de Slack-items.
    expect(titles).toEqual(expect.arrayContaining(['Offerte TonZon nalopen', 'Partnerovereenkomst 3.0 doorlezen']));
    expect((await on.providers.tasks.listTaskLists()).map((l) => l.id)).toEqual(
      expect.arrayContaining(['slack:reminders', 'slack:list:F0LIST1']),
    );
    void server;
  });
});
