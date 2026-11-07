/**
 * HZW-037 (spike): Slack-to-do's als takenbron, achter de vlag HZ_SLACK_TODOS=1. Zie docs/spike-slack-todos.md.
 *
 * - Herinneringen (reminders.list, user token, scope reminders:read): open herinneringen als taken. Let op: volgens
 *   de officiële documentatie zijn de reminders-methoden sinds maart 2023 "degraded or useless" en komt wat via
 *   Later wordt bewaard niet mee; daarom staat dit achter een vlag en is het advies: niet bouwen.
 * - Slack Lists (slackLists.items.list, scope lists:read): items van de lijsten die de collega koppelt (list-id's;
 *   er is geen methode om "al mijn lijsten" op te vragen). Kolomvormen verschillen per lijst, dus defensief lezen.
 * - "Later" (bewaarde items): geen publieke API; niet ondersteund.
 * Schrijven (herinnering toevoegen of afvinken) alleen na een klik van een mens; Lists-items bijwerken nog niet.
 */
import type { TaskItem, TaskList } from '@hz/shared';
import { toLocal } from '@hz/shared/logic';
import type { TasksProvider } from '../types';
import type { LiveSlack } from './slack';
import { assertHumanAction } from './tokens';

export interface SlackReminder {
  id: string;
  text?: string;
  user?: string;
  creator?: string;
  recurring?: boolean;
  time?: number;
  complete_ts?: number;
}
export interface SlackListItem {
  id: string;
  list_id?: string;
  date_created?: number;
  updated_timestamp?: string;
  fields?: Array<{
    key?: string;
    column_id?: string;
    value?: unknown;
    text?: string;
    date?: string[];
    checkbox?: boolean;
  }>;
}

export const REMINDERS_LIST = { id: 'slack:reminders', title: 'Slack-herinneringen' } as const;

export function mapReminder(r: SlackReminder): TaskItem {
  return {
    id: 'tk:slr-' + r.id,
    type: 'task',
    rawId: 'slr-' + r.id,
    tasklist: REMINDERS_LIST.id,
    tasklistTitle: REMINDERS_LIST.title,
    title: r.text?.trim() || '(herinnering)',
    due: r.time ? toLocal(new Date(r.time * 1000)).slice(0, 10) : null,
    status: r.complete_ts ? 'completed' : 'needsAction',
    entities: [],
    url: null,
  };
}

/** Lists-item -> taak: eerste tekstkolom als titel, eerste datum als deadline, een aangevinkt vakje = klaar. */
export function mapListItem(i: SlackListItem, listId: string, listTitle: string): TaskItem {
  const f = i.fields ?? [];
  const title = f.find((x) => typeof x.text === 'string' && x.text.trim())?.text?.trim() ?? '(item)';
  const date =
    f.find((x) => Array.isArray(x.date) && x.date.length)?.date?.[0] ??
    (f.find((x) => typeof x.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.value as string))?.value as
      | string
      | undefined);
  const done = f.some((x) => x.checkbox === true || (x.key === 'todo_completed' && x.value === true));
  return {
    id: `tk:sll-${listId}-${i.id}`,
    type: 'task',
    rawId: `sll-${listId}-${i.id}`,
    tasklist: `slack:list:${listId}`,
    tasklistTitle: listTitle,
    title,
    due: date ?? null,
    status: done ? 'completed' : 'needsAction',
    entities: [],
    url: null,
  };
}

export class SlackTodos implements TasksProvider {
  readonly mode = 'live' as const;
  constructor(
    readonly slack: LiveSlack,
    readonly lists: Array<{ id: string; title: string }> = [],
  ) {}

  async listTaskLists(): Promise<TaskList[]> {
    return [REMINDERS_LIST, ...this.lists.map((l) => ({ id: `slack:list:${l.id}`, title: l.title }))];
  }

  async reminders(): Promise<SlackReminder[]> {
    const r = await this.slack.call<{ reminders?: SlackReminder[] }>('reminders.list');
    return r.reminders ?? [];
  }

  async listItems(listId: string): Promise<SlackListItem[]> {
    const out: SlackListItem[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.slack.call<{ items?: SlackListItem[]; response_metadata?: { next_cursor?: string } }>(
        'slackLists.items.list',
        { list_id: listId, limit: 100, ...(cursor ? { cursor } : {}) },
        true,
      );
      out.push(...(r.items ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  async listTasks(): Promise<TaskItem[]> {
    const me = (await this.slack.self()).user_id;
    const rem = (await this.reminders()).filter((r) => !r.complete_ts && (!r.user || r.user === me)).map(mapReminder);
    const items = (
      await Promise.all(
        this.lists.map(async (l) => (await this.listItems(l.id)).map((i) => mapListItem(i, l.id, l.title))),
      )
    ).flat();
    return [...rem, ...items.filter((t) => t.status !== 'completed')];
  }

  /** Nieuwe herinnering (alleen na een klik). Datum zonder tijd: 09:00 Amsterdamse tijd. */
  async addTask(input: { title: string; due?: string | null }): Promise<TaskItem> {
    assertHumanAction('slack', 'een herinnering aanmaken');
    const { amsterdamToInstant } = await import('@hz/shared/logic');
    const time = input.due ? Math.floor(+amsterdamToInstant(`${input.due}T09:00`) / 1000) : 'in 1 hour';
    const r = await this.slack.call<{ reminder: SlackReminder }>('reminders.add', { text: input.title, time }, true);
    return mapReminder(r.reminder);
  }

  async updateTask(id: string, patch: { done?: boolean }): Promise<TaskItem> {
    const raw = id.replace(/^tk:/, '');
    if (!raw.startsWith('slr-') || patch.done !== true)
      throw new Error('Slack-to-do: alleen herinneringen afvinken kan (spike HZW-037); Lists bijwerken nog niet');
    assertHumanAction('slack', 'een herinnering afvinken');
    const reminder = raw.slice(4);
    await this.slack.call('reminders.complete', { reminder }, true);
    const info = await this.slack.call<{ reminder: SlackReminder }>('reminders.info', { reminder });
    return mapReminder(info.reminder);
  }
}

/** Google Taken (leidend) plus Slack-to-do's (alleen lezen en herinneringen), voor de vlag HZ_SLACK_TODOS=1. */
export class CombinedTasks implements TasksProvider {
  readonly mode: 'fixture' | 'live';
  constructor(
    readonly primary: TasksProvider,
    readonly slack: SlackTodos,
  ) {
    this.mode = primary.mode;
  }
  async listTaskLists() {
    return [...(await this.primary.listTaskLists()), ...(await this.slack.listTaskLists())];
  }
  async listTasks() {
    const [a, b] = await Promise.all([this.primary.listTasks(), this.slack.listTasks().catch(() => [] as TaskItem[])]);
    // Dubbelingen (zelfde titel en datum) één keer tonen; Google Taken wint.
    const key = (t: TaskItem) => `${t.title.trim().toLowerCase()}|${t.due ?? ''}`;
    const seen = new Set(a.map(key));
    return [...a, ...b.filter((t) => !seen.has(key(t)))];
  }
  addTask(input: { title: string; due?: string | null; list?: string; notes?: string }) {
    return input.list?.startsWith('slack:') ? this.slack.addTask(input) : this.primary.addTask(input);
  }
  updateTask(id: string, patch: { due?: string | null; done?: boolean; backlog?: boolean }) {
    return /^(tk:)?sl[lr]-/.test(id) ? this.slack.updateTask(id, patch) : this.primary.updateTask(id, patch);
  }
}

export interface ProbeResult {
  soort: 'herinneringen' | 'lists' | 'later';
  kan: boolean;
  detail: string;
  scopes?: string;
}

/**
 * Proef voor de spike (tools/spike-slack-todos.ts): wat kan met déze user token? Alleen lezen, tenzij write=true
 * (dan een testherinnering aanmaken en weer verwijderen).
 */
export async function probeSlackTodos(
  slack: LiveSlack,
  o: { listId?: string; write?: boolean } = {},
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    const r = await slack.call<{ reminders?: SlackReminder[] }>('reminders.list');
    out.push({ soort: 'herinneringen', kan: true, detail: `${r.reminders?.length ?? 0} herinneringen gelezen` });
    if (o.write) {
      const add = await slack.call<{ reminder: SlackReminder }>(
        'reminders.add',
        { text: 'HZW-037 proefherinnering (mag weg)', time: 'in 2 days' },
        true,
      );
      await slack.call('reminders.delete', { reminder: add.reminder.id }, true);
      out.push({ soort: 'herinneringen', kan: true, detail: 'aanmaken en verwijderen gelukt (reminders:write)' });
    }
  } catch (e) {
    out.push({ soort: 'herinneringen', kan: false, detail: err(e) });
  }
  if (o.listId) {
    try {
      const r = await slack.call<{ items?: SlackListItem[] }>(
        'slackLists.items.list',
        { list_id: o.listId, limit: 20 },
        true,
      );
      out.push({ soort: 'lists', kan: true, detail: `${r.items?.length ?? 0} items gelezen uit ${o.listId}` });
    } catch (e) {
      out.push({ soort: 'lists', kan: false, detail: err(e) });
    }
  } else out.push({ soort: 'lists', kan: false, detail: 'geen testlijst opgegeven (SLACK_TEST_LIST_ID)' });
  try {
    const r = await slack.call<{ items?: unknown[] }>('stars.list', { limit: 5 });
    out.push({
      soort: 'later',
      kan: false,
      detail: `stars.list gaf ${r.items?.length ?? 0} items; dat zijn niet de items onder Later (geen publieke API)`,
    });
  } catch (e) {
    out.push({ soort: 'later', kan: false, detail: `geen publieke API (${err(e)})` });
  }
  return out;
}
