/**
 * HZW-034: Jira Cloud via Atlassian OAuth 3LO, alleen lezen (live).
 *
 * Contextlaag eerst (keuze 08): de info-nachtdienst zet issues per epic in `product/jira/`. Live vragen we
 * alleen wat de laag niet heeft: de lopende sprint van HOM (naam, data, doel), storypoints en het Tester-veld.
 * - De sprintstand wordt één keer per nachtrun volledig opgehaald (de laag kent geen sprint of storypoints),
 *   daarna alleen issues met `updated >= laatste sync` (JQL), ook als ze uit de sprint zijn gehaald.
 * - Bij elk issue staat of het uit de laag komt (met datum) of live is (`source`, `asOf`).
 * - Nooit schrijven (AGENTS.md); alleen read-scopes.
 */
import type { JiraItem, JiraSprint } from '@hz/shared';
import type { JiraProvider } from '../types';
import { HttpClient, type LiveCredentials } from './http';
import { MemorySyncStore, type SyncStore } from './store';

export const ATLASSIAN_API = 'https://api.atlassian.com';

interface JField {
  id: string;
  name: string;
  custom?: boolean;
  schema?: { type?: string; custom?: string };
}
interface JUser {
  accountId: string;
  displayName?: string;
}
interface JSprintRaw {
  id: number;
  name: string;
  state?: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
}
export interface JIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    updated?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    assignee?: JUser | null;
  };
}

interface FieldIds {
  storyPoints: string[];
  tester: string | null;
  sprint: string;
}

interface SprintCache {
  sprintId: number;
  /** Nachtrun waarop de volledige stand gebaseerd is (ISO), zodat na elke nacht één keer vers. */
  basis: string;
  syncedAt: string;
  issues: Record<string, JiraItem & { updated?: string }>;
}

const CAT = new Set(['new', 'indeterminate', 'done']);
/** Atlassian JQL-datum (`yyyy/MM/dd HH:mm`) in UTC; we vragen 5 minuten extra terug. */
export const jqlDate = (d: Date) => {
  const x = new Date(+d - 5 * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}/${p(x.getUTCMonth() + 1)}/${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
};

export interface LiveJiraOptions {
  store?: SyncStore;
  base?: string;
  fetchImpl?: typeof fetch;
  /** Projectsleutel van het bord (standaard HOM). */
  project?: string;
  /** Site, bijv. homezero.atlassian.net (kiest de juiste cloud-id als er meer zijn). */
  site?: string;
  /** Moment van de laatste nachtrun van de info-nachtdienst (Jira in de laag). */
  lastNightRun?: () => Promise<Date | null>;
  /** Issues die in de laag staan (key -> stand-datum). */
  layerKeys?: () => Promise<Map<string, string>>;
  now?: () => Date;
}

export class LiveJira implements JiraProvider {
  readonly mode = 'live' as const;
  readonly http: HttpClient;
  readonly store: SyncStore;
  private o: LiveJiraOptions;
  constructor(
    readonly creds: LiveCredentials,
    opts: LiveJiraOptions = {},
  ) {
    this.http = new HttpClient('jira', opts.base ?? ATLASSIAN_API, creds, opts.fetchImpl);
    this.store = opts.store ?? new MemorySyncStore();
    this.o = opts;
  }

  private now = () => (this.o.now ?? (() => new Date()))();

  async cloudId(): Promise<string> {
    const c = await this.store.get<string>('jira:cloud');
    if (c) return c;
    const r = await this.http.json<Array<{ id: string; url?: string; name?: string }>>('/oauth/token/accessible-resources');
    const site = this.o.site?.replace(/^https?:\/\//, '');
    const hit = (site && r.find((x) => x.url?.includes(site))) || r[0];
    if (!hit) throw new Error('geen Jira-site met toegang voor dit account');
    await this.store.set('jira:cloud', hit.id);
    return hit.id;
  }

  private async api<T>(path: string, query?: Record<string, string | number | undefined>) {
    return this.http.json<T>(`/ex/jira/${await this.cloudId()}${path}`, { query });
  }

  private async fieldIds(): Promise<FieldIds> {
    const c = await this.store.get<{ at: number; ids: FieldIds }>('jira:fields');
    if (c && Date.now() - c.at < 7 * 864e5) return c.ids;
    const fields = await this.api<JField[]>('/rest/api/3/field');
    const byName = (re: RegExp) => fields.filter((f) => re.test(f.name)).map((f) => f.id);
    const ids: FieldIds = {
      storyPoints: [...new Set([...byName(/^story point/i), 'customfield_10016'])],
      tester: fields.find((f) => /^tester$/i.test(f.name))?.id ?? null,
      sprint: fields.find((f) => f.schema?.custom?.endsWith(':gh-sprint'))?.id ?? byName(/^sprint$/i)[0] ?? 'customfield_10020',
    };
    await this.store.set('jira:fields', { at: Date.now(), ids });
    return ids;
  }

  private async myself(): Promise<string> {
    const c = await this.store.get<string>('jira:me');
    if (c) return c;
    const me = await this.api<JUser>('/rest/api/3/myself');
    await this.store.set('jira:me', me.accountId);
    return me.accountId;
  }

  private async board(): Promise<number | null> {
    const c = await this.store.get<number>('jira:board');
    if (c) return c;
    const r = await this.api<{ values?: Array<{ id: number; type?: string }> }>('/rest/agile/1.0/board', {
      projectKeyOrId: this.o.project ?? 'HOM',
      type: 'scrum',
    });
    const id = r.values?.[0]?.id ?? null;
    if (id) await this.store.set('jira:board', id);
    return id;
  }

  private async sprint(): Promise<JSprintRaw | null> {
    const board = await this.board();
    if (!board) return null;
    const r = await this.api<{ values?: JSprintRaw[] }>(`/rest/agile/1.0/board/${board}/sprint`, { state: 'active' });
    return r.values?.[0] ?? null;
  }

  private async search(jql: string, fields: string[]): Promise<JIssue[]> {
    const out: JIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const r = await this.api<{ issues?: JIssue[]; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
        jql,
        fields: fields.join(','),
        maxResults: 100,
        nextPageToken,
      });
      out.push(...(r.issues ?? []));
      nextPageToken = r.isLast === false || r.nextPageToken ? r.nextPageToken : undefined;
    } while (nextPageToken);
    return out;
  }

  private toItem(i: JIssue, f: FieldIds, me: string, sprint: JiraSprint, siteUrl: string): JiraItem & { updated?: string } {
    const sp = f.storyPoints.map((id) => i.fields[id]).find((v) => typeof v === 'number') as number | undefined;
    const tester = f.tester ? (i.fields[f.tester] as JUser | JUser[] | null | undefined) : null;
    const testers = Array.isArray(tester) ? tester : tester ? [tester] : [];
    const cat = i.fields.status?.statusCategory?.key ?? 'new';
    return {
      id: 'jr:' + i.key,
      type: 'jira',
      key: i.key,
      title: i.fields.summary ?? i.key,
      status: i.fields.status?.name ?? '',
      cat: (CAT.has(cat) ? cat : 'new') as JiraItem['cat'],
      assignee: i.fields.assignee?.displayName ?? '',
      sp: sp ?? 0,
      sprint,
      mine: testers.some((t) => t.accountId === me),
      entities: [],
      url: `${siteUrl}/browse/${i.key}`,
      updated: i.fields.updated,
      source: 'live',
    } as JiraItem & { updated?: string };
  }

  private inSprint(i: JIssue, f: FieldIds, sprintId: number) {
    const v = i.fields[f.sprint] as Array<{ id: number }> | null | undefined;
    return Array.isArray(v) && v.some((s) => s.id === sprintId);
  }

  async activeSprint(): Promise<{ sprint: JiraSprint | null; issues: JiraItem[] }> {
    const raw = await this.sprint();
    if (!raw) return { sprint: null, issues: [] };
    const sprint: JiraSprint = {
      id: raw.id,
      name: raw.name,
      state: raw.state,
      startDate: raw.startDate ?? '',
      endDate: raw.endDate ?? '',
      ...(raw.goal ? { goal: raw.goal } : {}),
    };
    const [f, me, run] = await Promise.all([this.fieldIds(), this.myself(), this.o.lastNightRun?.() ?? null]);
    const siteUrl = this.o.site ? `https://${this.o.site.replace(/^https?:\/\//, '')}` : 'https://homezero.atlassian.net';
    const fields = ['summary', 'status', 'assignee', 'updated', f.sprint, ...f.storyPoints, ...(f.tester ? [f.tester] : [])];
    const basis = run ? run.toISOString() : this.now().toISOString().slice(0, 10);
    const key = 'jira:sprint';
    const startedAt = this.now();
    let cache = await this.store.get<SprintCache>(key);
    if (!cache || cache.sprintId !== raw.id || cache.basis !== basis) {
      const issues = await this.search(`sprint = ${raw.id}`, fields);
      cache = {
        sprintId: raw.id,
        basis,
        syncedAt: startedAt.toISOString(),
        issues: Object.fromEntries(issues.map((i) => [i.key, this.toItem(i, f, me, sprint, siteUrl)])),
      };
    } else {
      // Alleen wat sinds de vorige sync veranderde (ook issues die uit de sprint gingen).
      const project = this.o.project ?? 'HOM';
      const changed = await this.search(`project = ${project} AND updated >= "${jqlDate(new Date(cache.syncedAt))}"`, fields);
      for (const i of changed) {
        if (this.inSprint(i, f, raw.id)) cache.issues[i.key] = this.toItem(i, f, me, sprint, siteUrl);
        else delete cache.issues[i.key];
      }
      cache.syncedAt = startedAt.toISOString();
    }
    await this.store.set(key, cache);
    // Herkomst per issue: niet gewijzigd sinds de nachtrun en in de laag -> uit de laag (met stand-datum).
    const layer = (await this.o.layerKeys?.()) ?? new Map<string, string>();
    const issues = Object.values(cache.issues).map(({ updated, ...it }) => {
      const asOf = layer.get(it.key);
      if (asOf && run && updated && new Date(updated) <= run) return { ...it, source: 'laag' as const, asOf };
      return { ...it, source: 'live' as const, asOf: updated };
    });
    return { sprint, issues: issues.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true })) };
  }

  /** Voor de sync-motor: aantal issues dat sinds de vorige poll veranderde. */
  async pollChanges(): Promise<{ changed: number }> {
    const before = await this.store.get<SprintCache>('jira:sprint');
    await this.activeSprint();
    const after = await this.store.get<SprintCache>('jira:sprint');
    if (!before || !after) return { changed: Object.keys(after?.issues ?? {}).length };
    let changed = 0;
    for (const k of new Set([...Object.keys(before.issues), ...Object.keys(after.issues)])) {
      const a = before.issues[k];
      const b = after.issues[k];
      if (!a || !b || a.updated !== b.updated || a.status !== b.status) changed++;
    }
    return { changed };
  }
}
