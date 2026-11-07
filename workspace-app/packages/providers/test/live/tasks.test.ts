/**
 * HZW-032 zelftest: contracttests tegen opgenomen (synthetische) Google Tasks-antwoorden en de snel-toevoegen-test.
 * Een kleine nep-Tasks-server in msw houdt lijsten en taken bij; niets gaat naar Google.
 */
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { TaskItem } from '@hz/shared';
import { GOOGLE_TASKS_BASE as T, LiveTasks, MemorySyncStore } from '../../src';
import { creds, mockServer } from './msw';

type GT = {
  id: string;
  title: string;
  status: string;
  due?: string;
  notes?: string;
  updated: string;
  deleted?: boolean;
};
let lists: Array<{ id: string; title: string }>;
let tasks: Record<string, GT[]>;
let seq = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 30, 8, 0, seq++)).toISOString();

beforeEach(() => {
  seq = 0;
  lists = [
    { id: 'L-mine', title: 'Mijn taken' },
    { id: 'L-feen', title: 'Feenstra' },
  ];
  tasks = {
    'L-mine': [
      {
        id: 't1',
        title: 'Offerte TonZon nalopen',
        status: 'needsAction',
        due: '2026-10-30T00:00:00.000Z',
        updated: stamp(),
      },
      { id: 't2', title: 'Klaar ding', status: 'completed', updated: stamp() },
    ],
    'L-feen': [
      {
        id: 't3',
        title: 'ZSB-flow aanpassen op acceptatie',
        status: 'needsAction',
        notes: 'zie meeting 30 okt',
        updated: stamp(),
      },
    ],
  };
});

const find = (id: string) => {
  for (const [l, ts] of Object.entries(tasks)) {
    const t = ts.find((x) => x.id === id);
    if (t) return { l, t };
  }
  return null;
};

const { requests, clear } = mockServer(
  http.get(`${T}/users/@me/lists`, () => HttpResponse.json({ kind: 'tasks#taskLists', items: lists })),
  http.post(`${T}/users/@me/lists`, async ({ request }) => {
    const b = (await request.json()) as { title: string };
    const l = { id: `L-${b.title.toLowerCase()}`, title: b.title };
    lists.push(l);
    tasks[l.id] = [];
    return HttpResponse.json(l);
  }),
  http.get(`${T}/lists/:list/tasks`, ({ params, request }) => {
    const u = new URL(request.url);
    const showCompleted = u.searchParams.get('showCompleted') === 'true';
    const updatedMin = u.searchParams.get('updatedMin');
    let items = tasks[String(params.list)] ?? [];
    if (!showCompleted) items = items.filter((t) => t.status !== 'completed');
    if (updatedMin) items = items.filter((t) => t.updated >= updatedMin);
    return HttpResponse.json({ items });
  }),
  http.post(`${T}/lists/:list/tasks`, async ({ params, request }) => {
    const b = (await request.json()) as Partial<GT>;
    const t: GT = {
      id: `new${seq}`,
      title: b.title!,
      status: 'needsAction',
      due: b.due,
      notes: b.notes,
      updated: stamp(),
    };
    tasks[String(params.list)]!.push(t);
    return HttpResponse.json(t);
  }),
  http.patch(`${T}/lists/:list/tasks/:id`, async ({ params, request }) => {
    const b = (await request.json()) as Record<string, unknown>;
    const hit = find(String(params.id))!;
    Object.assign(hit.t, b, { updated: stamp() });
    if (b.due === null) delete hit.t.due;
    return HttpResponse.json(hit.t);
  }),
  http.post(`${T}/lists/:list/tasks/:id/move`, ({ params, request }) => {
    const dest = new URL(request.url).searchParams.get('destinationTasklist')!;
    const hit = find(String(params.id))!;
    tasks[hit.l] = tasks[hit.l]!.filter((x) => x !== hit.t);
    tasks[dest]!.push(hit.t);
    hit.t.updated = stamp();
    return HttpResponse.json(hit.t);
  }),
);

const make = () => new LiveTasks(creds(), { store: new MemorySyncStore() });

describe('Google Taken live (HZW-032)', () => {
  it('meerdere lijsten en open taken over alle lijsten, in de contractvorm', async () => {
    const p = make();
    expect(await p.listTaskLists()).toEqual(lists);
    const all = await p.listTasks();
    for (const t of all) expect(() => TaskItem.parse(t)).not.toThrow();
    expect(all.map((t) => t.title)).toEqual(['Offerte TonZon nalopen', 'ZSB-flow aanpassen op acceptatie']);
    expect(all[0]).toMatchObject({
      id: 'tk:t1',
      rawId: 't1',
      tasklist: 'L-mine',
      tasklistTitle: 'Mijn taken',
      due: '2026-10-30',
      status: 'needsAction',
    });
    expect(all[1]).toMatchObject({ tasklist: 'L-feen', notes: 'zie meeting 30 okt' });
    expect(
      requests
        .filter((r) => r.url.pathname.endsWith('/tasks'))
        .every((r) => r.url.searchParams.get('showCompleted') === 'false'),
    ).toBe(true);
  });

  it('snel toevoegen bij Vandaag en Morgen: datum als RFC 3339 in de eerste gewone lijst', async () => {
    const p = make();
    clear();
    const t = await p.addTask({ title: 'Bel Marie-José over capaciteit', due: '2026-10-31' });
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.url.pathname).toBe('/tasks/v1/lists/L-mine/tasks');
    expect(post.body).toEqual({ title: 'Bel Marie-José over capaciteit', due: '2026-10-31T00:00:00.000Z' });
    expect(t).toMatchObject({ title: 'Bel Marie-José over capaciteit', due: '2026-10-31', tasklist: 'L-mine' });
    expect((await p.listTasks()).map((x) => x.title)).toContain('Bel Marie-José over capaciteit');
    // Zonder datum en naar een gekozen lijst.
    const t2 = await p.addTask({ title: 'Notitie zonder datum', list: 'L-feen' });
    expect(t2).toMatchObject({ due: null, tasklist: 'L-feen' });
  });

  it('verplaatsen (datum), afvinken en terugdraaien', async () => {
    const p = make();
    await p.listTasks();
    const moved = await p.updateTask('tk:t1', { due: '2026-11-02' });
    expect(moved.due).toBe('2026-11-02');
    const done = await p.updateTask('t1', { done: true });
    expect(done.status).toBe('completed');
    expect((await p.listTasks()).map((t) => t.rawId)).not.toContain('t1');
    const undone = await p.updateTask('t1', { done: false });
    expect(undone.status).toBe('needsAction');
    const patches = requests.filter((r) => r.method === 'PATCH').map((r) => r.body);
    expect(patches).toEqual([
      { due: '2026-11-02T00:00:00.000Z' },
      { status: 'completed' },
      { status: 'needsAction', completed: null },
    ]);
  });

  it('Backlog-lijst: wordt aangemaakt als hij ontbreekt, taak verhuist en verliest zijn datum', async () => {
    const p = make();
    await p.listTasks();
    const b = await p.updateTask('t1', { backlog: true });
    expect(lists.map((l) => l.title)).toContain('Backlog');
    expect(b).toMatchObject({ tasklist: 'L-backlog', backlog: true, due: null });
    expect(
      requests.some(
        (r) => r.url.pathname.endsWith('/t1/move') && r.url.searchParams.get('destinationTasklist') === 'L-backlog',
      ),
    ).toBe(true);
    const back = await p.updateTask('t1', { backlog: false, due: '2026-11-03' });
    expect(back).toMatchObject({ tasklist: 'L-mine', due: '2026-11-03' });
    expect(back.backlog).toBeUndefined();
  });

  it('poll voor de sync-motor: updatedMin telt nieuwe en afgevinkte taken', async () => {
    const p = make();
    expect(await p.pollChanges()).toEqual({ changed: 0, first: true });
    tasks['L-mine']!.push({
      id: 't9',
      title: 'Nieuw van telefoon',
      status: 'needsAction',
      updated: new Date(Date.now() + 1000).toISOString(),
    });
    const r = await p.pollChanges();
    expect(r).toEqual({ changed: 1, first: false });
    const q = requests.filter((x) => x.url.searchParams.get('updatedMin'));
    expect(q.every((x) => x.url.searchParams.get('showDeleted') === 'true')).toBe(true);
  });
});
