/**
 * HZW-034 zelftest: contracttests tegen opgenomen (synthetische) Atlassian-antwoorden. Lopende sprint van HOM,
 * storypoints, Tester-veld; contextlaag eerst: na de volledige stand alleen wat sinds de laatste sync veranderde.
 * Alleen lezen: de test eist dat er geen enkel schrijfverzoek naar Jira gaat.
 */
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { JiraItem } from '@hz/shared';
import { ATLASSIAN_API as A, LiveJira, MemorySyncStore, jqlDate } from '../../src';
import { creds, mockServer } from './msw';

const CLOUD = 'cloud-demo-1';
const J = `${A}/ex/jira/${CLOUD}`;
const ME = 'acc-robert';
const SPRINT = {
  id: 63,
  name: 'Sprint 63',
  state: 'active',
  startDate: '2026-10-26T08:00:00.000Z',
  endDate: '2026-11-09T08:00:00.000Z',
  goal: 'Planning en leads',
};
const issue = (
  key: string,
  o: Partial<{
    summary: string;
    status: string;
    cat: string;
    sp: number;
    tester: string | null;
    sprint: number | null;
    updated: string;
    assignee: string;
  }>,
) => ({
  key,
  fields: {
    summary: o.summary ?? key,
    updated: o.updated ?? '2026-10-27T10:00:00.000+0100',
    status: { name: o.status ?? 'To Do', statusCategory: { key: o.cat ?? 'new' } },
    assignee: o.assignee ? { accountId: 'acc-' + o.assignee, displayName: o.assignee } : null,
    customfield_10016: o.sp,
    customfield_10050: o.tester ? { accountId: o.tester, displayName: 'Robert Verveen' } : null,
    customfield_10020: o.sprint === null ? null : [{ id: o.sprint ?? 63, name: 'Sprint 63', state: 'active' }],
  },
});

let jql: string[];
let delta: unknown[];
beforeEach(() => {
  jql = [];
  delta = [];
});

const { server, requests } = mockServer(
  http.get(`${A}/oauth/token/accessible-resources`, () =>
    HttpResponse.json([
      { id: 'cloud-other', url: 'https://ander-bedrijf.atlassian.net', name: 'Ander' },
      { id: CLOUD, url: 'https://homezero.atlassian.net', name: 'HomeZero', scopes: ['read:jira-work'] },
    ]),
  ),
  http.get(`${J}/rest/api/3/field`, () =>
    HttpResponse.json([
      { id: 'summary', name: 'Summary' },
      { id: 'customfield_10016', name: 'Story point estimate', custom: true },
      {
        id: 'customfield_10050',
        name: 'Tester',
        custom: true,
        schema: { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' },
      },
      {
        id: 'customfield_10020',
        name: 'Sprint',
        custom: true,
        schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
      },
    ]),
  ),
  http.get(`${J}/rest/api/3/myself`, () => HttpResponse.json({ accountId: ME, displayName: 'Robert Verveen' })),
  http.get(`${J}/rest/agile/1.0/board`, ({ request }) => {
    expect(new URL(request.url).searchParams.get('projectKeyOrId')).toBe('HOM');
    return HttpResponse.json({ values: [{ id: 12, type: 'scrum', name: 'HOM bord' }] });
  }),
  http.get(`${J}/rest/agile/1.0/board/12/sprint`, () => HttpResponse.json({ values: [SPRINT] })),
  http.get(`${J}/rest/api/3/search/jql`, ({ request }) => {
    const u = new URL(request.url);
    const q = u.searchParams.get('jql')!;
    jql.push(q);
    if (q === 'sprint = 63') {
      if (!u.searchParams.get('nextPageToken'))
        return HttpResponse.json({
          issues: [
            issue('HOM-2650', {
              summary: 'Taak bij taggen in opdracht',
              status: 'In Progress',
              cat: 'indeterminate',
              sp: 5,
              tester: ME,
              assignee: 'Emiel',
            }),
            issue('HOM-3049', { summary: 'Takenoverzicht op mobiel', sp: 3 }),
          ],
          nextPageToken: 'pg2',
          isLast: false,
        });
      return HttpResponse.json({
        issues: [
          issue('HOM-1777', {
            summary: 'Documenten-teller',
            status: 'Done',
            cat: 'done',
            sp: 2,
            updated: '2026-11-06T22:00:00.000+0100',
          }),
        ],
        isLast: true,
      });
    }
    return HttpResponse.json({ issues: delta, isLast: true });
  }),
);

const nightRun = new Date('2026-11-07T01:32:00Z');
const make = (store = new MemorySyncStore(), now = new Date('2026-11-07T08:00:00Z')) =>
  new LiveJira(creds(), {
    store,
    site: 'homezero.atlassian.net',
    lastNightRun: async () => nightRun,
    layerKeys: async () =>
      new Map([
        ['HOM-2650', '2026-11-07'],
        ['HOM-3049', '2026-11-07'],
        ['HOM-1777', '2026-11-07'],
      ]),
    now: () => now,
  });

describe('Jira live, alleen lezen (HZW-034)', () => {
  it('lopende sprint van HOM met storypoints en Tester-veld, in de contractvorm', async () => {
    const r = await make().activeSprint();
    expect(r.sprint).toEqual({
      id: 63,
      name: 'Sprint 63',
      state: 'active',
      startDate: SPRINT.startDate,
      endDate: SPRINT.endDate,
      goal: 'Planning en leads',
    });
    for (const i of r.issues) expect(() => JiraItem.parse(i)).not.toThrow();
    expect(r.issues.map((i) => i.key)).toEqual(['HOM-1777', 'HOM-2650', 'HOM-3049']);
    const t = r.issues.find((i) => i.key === 'HOM-2650')!;
    expect(t).toMatchObject({
      id: 'jr:HOM-2650',
      sp: 5,
      mine: true,
      cat: 'indeterminate',
      status: 'In Progress',
      assignee: 'Emiel',
      url: 'https://homezero.atlassian.net/browse/HOM-2650',
    });
    expect(r.issues.find((i) => i.key === 'HOM-3049')).toMatchObject({ sp: 3, mine: false });
    expect(r.issues.reduce((s, i) => s + i.sp, 0)).toBe(10);
    // De juiste site (cloud-id) uit accessible-resources, ook als er meer sites zijn.
    expect(requests.some((x) => x.url.pathname.startsWith(`/ex/jira/${CLOUD}/`))).toBe(true);
    expect(requests.some((x) => x.url.pathname.includes('cloud-other'))).toBe(false);
  });

  it('herkomst per issue: niet gewijzigd sinds de nachtrun en in de laag = laag (met datum), anders live', async () => {
    const r = await make().activeSprint();
    expect(r.issues.find((i) => i.key === 'HOM-2650')).toMatchObject({ source: 'laag', asOf: '2026-11-07' });
    // HOM-1777 veranderde om 22:00 (CET) op 6 nov = 21:00Z, vóór de nachtrun van 01:32Z: ook laag.
    expect(r.issues.find((i) => i.key === 'HOM-1777')).toMatchObject({ source: 'laag' });
  });

  it('na de volledige stand alleen wijzigingen (updated >= vorige sync), ook uit de sprint gehaald', async () => {
    const store = new MemorySyncStore();
    await make(store).activeSprint();
    expect(jql).toEqual(['sprint = 63', 'sprint = 63']);
    jql = [];
    delta = [
      issue('HOM-3049', {
        summary: 'Takenoverzicht op mobiel',
        status: 'In Review',
        cat: 'indeterminate',
        sp: 3,
        updated: '2026-11-07T09:30:00.000+0100',
      }),
      issue('HOM-1777', { sprint: null, updated: '2026-11-07T09:31:00.000+0100' }),
      issue('HOM-4000', { summary: 'Nieuw in sprint', sp: 1, updated: '2026-11-07T09:32:00.000+0100' }),
    ];
    const r = await make(store, new Date('2026-11-07T09:00:00Z')).activeSprint();
    expect(jql).toHaveLength(1);
    expect(jql[0]).toBe(`project = HOM AND updated >= "${jqlDate(new Date('2026-11-07T08:00:00Z'))}"`);
    expect(jql[0]).toBe('project = HOM AND updated >= "2026/11/07 07:55"');
    expect(r.issues.map((i) => i.key)).toEqual(['HOM-2650', 'HOM-3049', 'HOM-4000']);
    expect(r.issues.find((i) => i.key === 'HOM-3049')).toMatchObject({ status: 'In Review', source: 'live' });
    expect(r.issues.find((i) => i.key === 'HOM-4000')).toMatchObject({ source: 'live' });
  });

  it('nooit schrijven naar Jira', async () => {
    await make().activeSprint();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((x) => x.method === 'GET')).toBe(true);
  });

  it('geen lopende sprint: lege sprint, geen zoekvraag', async () => {
    server.use(http.get(`${J}/rest/agile/1.0/board/12/sprint`, () => HttpResponse.json({ values: [] })));
    expect(await make().activeSprint()).toEqual({ sprint: null, issues: [] });
    expect(jql).toEqual([]);
  });
});
