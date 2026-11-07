/**
 * HZW-032: Google Tasks API v1 (live): lijsten, taken lezen, toevoegen, verplaatsen (datum of naar de
 * Backlog-lijst), afvinken. Meerdere lijsten. De Tasks API heeft geen syncToken; de sync-motor pollt met
 * updatedMin (zie pollChanges).
 */
import type { TaskItem, TaskList } from '@hz/shared';
import type { TasksProvider } from '../types';
import { HttpClient, type LiveCredentials } from './http';
import { MemorySyncStore, type SyncStore } from './store';

export const GOOGLE_TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
export const BACKLOG_TITLE = 'Backlog';
const isBacklog = (title?: string) => /^backlog$/i.test((title ?? '').trim());

export interface GTaskList {
  id: string;
  title: string;
  updated?: string;
}
export interface GTask {
  id: string;
  title?: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
  completed?: string;
  updated?: string;
  deleted?: boolean;
  hidden?: boolean;
  parent?: string;
  webViewLink?: string;
}

export function mapTask(t: GTask, list: GTaskList): TaskItem {
  return {
    id: 'tk:' + t.id,
    type: 'task',
    rawId: t.id,
    tasklist: list.id,
    tasklistTitle: list.title,
    title: t.title || '(taak)',
    due: t.due ? t.due.slice(0, 10) : null,
    notes: t.notes || undefined,
    status: t.status === 'completed' ? 'completed' : 'needsAction',
    backlog: isBacklog(list.title) || undefined,
    entities: [],
    url: t.webViewLink ?? 'https://tasks.google.com/',
  };
}

/** Google Taken bewaart alleen een datum; de tijd is altijd 00:00 UTC (RFC 3339). */
export const dueToGoogle = (d: string) => `${d}T00:00:00.000Z`;

export class LiveTasks implements TasksProvider {
  readonly mode = 'live' as const;
  readonly http: HttpClient;
  readonly store: SyncStore;
  constructor(
    readonly creds: LiveCredentials,
    opts: { store?: SyncStore; base?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.http = new HttpClient('google_tasks', opts.base ?? GOOGLE_TASKS_BASE, creds, opts.fetchImpl);
    this.store = opts.store ?? new MemorySyncStore();
  }

  private async lists(): Promise<GTaskList[]> {
    const out: GTaskList[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.http.json<{ items?: GTaskList[]; nextPageToken?: string }>('/users/@me/lists', {
        query: { maxResults: 100, pageToken },
      });
      out.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async listTaskLists(): Promise<TaskList[]> {
    return (await this.lists()).map((l) => ({ id: l.id, title: l.title }));
  }

  private async tasksOf(list: GTaskList, q: Record<string, string | number | boolean | undefined> = {}) {
    const out: GTask[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.http.json<{ items?: GTask[]; nextPageToken?: string }>(
        `/lists/${encodeURIComponent(list.id)}/tasks`,
        { query: { maxResults: 100, showCompleted: false, ...q, pageToken } },
      );
      out.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async listTasks(): Promise<TaskItem[]> {
    const lists = await this.lists();
    const per = await Promise.all(lists.map(async (l) => ({ l, tasks: await this.tasksOf(l) })));
    const index: Record<string, string> = {};
    const out: TaskItem[] = [];
    for (const { l, tasks } of per)
      for (const t of tasks) {
        if (t.deleted || t.status === 'completed') continue;
        index[t.id] = l.id;
        out.push(mapTask(t, l));
      }
    await this.store.set('tasks:index', index);
    return out;
  }

  /** Lijst van een taak (uit de index van de laatste listTasks, anders zoeken). */
  private async listOf(taskId: string, lists: GTaskList[]): Promise<GTaskList> {
    const idx = (await this.store.get<Record<string, string>>('tasks:index')) ?? {};
    const hit = lists.find((l) => l.id === idx[taskId]);
    if (hit) return hit;
    for (const l of lists) {
      const tasks = await this.tasksOf(l, { showCompleted: true, showHidden: true });
      if (tasks.some((t) => t.id === taskId)) return l;
    }
    throw new Error(`onbekende taak ${taskId}`);
  }

  private async backlogList(lists: GTaskList[]): Promise<GTaskList> {
    const found = lists.find((l) => isBacklog(l.title));
    if (found) return found;
    return this.http.json<GTaskList>('/users/@me/lists', { method: 'POST', body: { title: BACKLOG_TITLE } });
  }

  async addTask(input: { title: string; due?: string | null; list?: string; notes?: string }): Promise<TaskItem> {
    const lists = await this.lists();
    if (!lists.length) throw new Error('geen takenlijst in Google Taken');
    const list = lists.find((l) => l.id === input.list) ?? lists.find((l) => !isBacklog(l.title)) ?? lists[0]!;
    const t = await this.http.json<GTask>(`/lists/${encodeURIComponent(list.id)}/tasks`, {
      method: 'POST',
      body: {
        title: input.title,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.due ? { due: dueToGoogle(input.due) } : {}),
      },
    });
    const idx = (await this.store.get<Record<string, string>>('tasks:index')) ?? {};
    idx[t.id] = list.id;
    await this.store.set('tasks:index', idx);
    return mapTask(t, list);
  }

  async updateTask(id: string, patch: { due?: string | null; done?: boolean; backlog?: boolean }): Promise<TaskItem> {
    const taskId = id.replace(/^tk:/, '');
    const lists = await this.lists();
    let list = await this.listOf(taskId, lists);
    let task: GTask | null = null;
    // Naar of uit de Backlog-lijst: verplaatsen tussen lijsten (tasks.move met destinationTasklist).
    if (patch.backlog !== undefined) {
      const target = patch.backlog
        ? await this.backlogList(lists)
        : (lists.find((l) => !isBacklog(l.title)) ?? list);
      if (target.id !== list.id) {
        task = await this.http.json<GTask>(
          `/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(taskId)}/move`,
          { method: 'POST', query: { destinationTasklist: target.id } },
        );
        list = target;
      }
    }
    const body: Record<string, unknown> = {};
    if (patch.backlog) body.due = null;
    if (patch.due !== undefined) body.due = patch.due ? dueToGoogle(patch.due) : null;
    if (patch.done !== undefined) {
      body.status = patch.done ? 'completed' : 'needsAction';
      if (!patch.done) body.completed = null;
    }
    const newId = task?.id ?? taskId;
    if (Object.keys(body).length)
      task = await this.http.json<GTask>(
        `/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(newId)}`,
        { method: 'PATCH', body },
      );
    if (!task)
      task = await this.http.json<GTask>(`/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(newId)}`);
    const idx = (await this.store.get<Record<string, string>>('tasks:index')) ?? {};
    idx[task.id] = list.id;
    await this.store.set('tasks:index', idx);
    return mapTask(task, list);
  }

  /**
   * Voor de sync-motor: aantal taken dat sinds de vorige poll veranderde (updatedMin, ook afgevinkt en
   * verwijderd). De eerste keer telt alleen als nulpunt.
   */
  async pollChanges(): Promise<{ changed: number; first: boolean }> {
    const since = await this.store.get<string>('tasks:updatedMin');
    const started = new Date().toISOString();
    if (!since) {
      await this.store.set('tasks:updatedMin', started);
      return { changed: 0, first: true };
    }
    const lists = await this.lists();
    let changed = 0;
    for (const l of lists)
      changed += (
        await this.tasksOf(l, { updatedMin: since, showCompleted: true, showDeleted: true, showHidden: true })
      ).length;
    await this.store.set('tasks:updatedMin', started);
    return { changed, first: false };
  }
}
