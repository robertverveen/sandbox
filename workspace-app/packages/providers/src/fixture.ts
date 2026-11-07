/**
 * Fixture-implementaties: werken op een dataset in het geheugen en onthouden wat je doet
 * (taak toevoegen, gelezen zetten, reageren), zodat schermen en tests echt gedrag zien.
 * Er gaat nooit iets naar buiten.
 */
import type { BusyBlock, Conversation, MeetingItem, Message, NewEvent, TaskItem } from '@hz/shared';
import { pd, ymd } from '@hz/shared/logic';
import type { FixtureDataset } from './fixtures/dataset';
import type {
  AnthropicProvider,
  CalendarProvider,
  CompletionRequest,
  CompletionResult,
  DateRange,
  GmailProvider,
  JiraProvider,
  SlackProvider,
  TasksProvider,
  WisprProvider,
} from './types';
import { SELF_EMAIL, SLACK_ME } from './fixtures/demo';

/** Gedeelde log van wat fixture-providers "deden" (voor tests: er gaat niets echt de deur uit). */
export interface FixtureLog {
  calls: Array<{ provider: string; op: string; args: unknown[] }>;
}

export class FixtureCalendar implements CalendarProvider {
  readonly mode = 'fixture' as const;
  constructor(
    private ds: FixtureDataset,
    private log: FixtureLog,
  ) {}
  async listCalendars() {
    return this.ds.calendars;
  }
  async listEvents(range: DateRange) {
    return this.ds.meetings.filter((m) => {
      const d = m.start.slice(0, 10);
      const e = (m.end || m.start).slice(0, 10);
      return e >= range.from && d < range.to;
    });
  }
  async respond(eventId: string, response: 'accepted' | 'tentative' | 'declined') {
    const m = this.ds.meetings.find((x) => x.id === eventId);
    if (!m) throw new Error(`onbekende afspraak ${eventId}`);
    m.needsAction = false;
    this.log.calls.push({ provider: 'calendar', op: 'respond', args: [eventId, response] });
  }
  /** Bezet = afspraken in de fixture waar die collega bij is (op voornaam), voor jezelf alle eigen afspraken. */
  async freeBusy(emails: string[], range: DateRange) {
    const events = await this.listEvents(range);
    return emails.map((email) => {
      const first = email.split('@')[0]!.split(/[.-]/)[0]!.toLowerCase();
      const self = email.toLowerCase() === SELF_EMAIL;
      const busy: BusyBlock[] = events
        .filter((m) => !m.ooo || self)
        .filter((m) =>
          self
            ? !m.agendaOnly
            : (m.attendees ?? []).some((a) => a.email.toLowerCase() === email.toLowerCase()) ||
              m.attendeeNames.some((n) => n.toLowerCase().split(/\s+/)[0] === first),
        )
        .map((m) => ({ start: m.start, end: m.end }));
      return { email, busy };
    });
  }
  async createEvent(e: NewEvent) {
    const id = `new-${this.ds.meetings.length + 1}`;
    const m: MeetingItem = {
      id,
      type: 'meeting',
      title: e.title,
      start: e.start,
      end: e.end,
      entities: [],
      attendeeNames: e.attendees.map((a) => a.split('@')[0]!),
      attendees: [
        { email: SELF_EMAIL, self: true, organizer: true, responseStatus: 'accepted' },
        ...e.attendees.map((email) => ({ email, responseStatus: 'needsAction' as const })),
      ],
      where: e.location ?? (e.meet ? 'Google Meet' : undefined),
      calId: e.calendarId ?? SELF_EMAIL,
      url: null,
    };
    this.ds.meetings.push(m);
    this.log.calls.push({ provider: 'calendar', op: 'createEvent', args: [e] });
    return m;
  }
}

export class FixtureGmail implements GmailProvider {
  readonly mode = 'fixture' as const;
  constructor(
    private ds: FixtureDataset,
    private log: FixtureLog,
  ) {}
  async listThreads() {
    return this.ds.mails;
  }
  async listConversations() {
    return this.ds.mailConvs;
  }
  async getThread(threadId: string) {
    return this.ds.mailThreads[threadId] ?? null;
  }
  async markRead(threadId: string, read: boolean) {
    for (const m of this.ds.mails) if (m.threadId === threadId) m.unread = !read;
    for (const c of this.ds.mailConvs) if (c.key === 'ml:' + threadId) c.unread = !read;
    this.log.calls.push({ provider: 'gmail', op: 'markRead', args: [threadId, read] });
  }
  async reply(threadId: string, body: string, opts: { replyAll: boolean }) {
    this.log.calls.push({ provider: 'gmail', op: 'reply', args: [threadId, body, opts] });
    return { id: `fx-${threadId}-${this.log.calls.length}` };
  }
}

export class FixtureTasks implements TasksProvider {
  readonly mode = 'fixture' as const;
  private seq = 0;
  constructor(
    private ds: FixtureDataset,
    private log: FixtureLog,
  ) {}
  async listTaskLists() {
    return this.ds.tasklists;
  }
  async listTasks() {
    return this.ds.tasks.filter((t) => t.status !== 'completed');
  }
  async addTask(input: { title: string; due?: string | null; list?: string; notes?: string }) {
    const list = this.ds.tasklists.find((l) => l.id === input.list) ?? this.ds.tasklists[0]!;
    const id = `fx-task-${++this.seq}`;
    const t: TaskItem = {
      id,
      type: 'task',
      rawId: id,
      tasklist: list.id,
      tasklistTitle: list.title,
      title: input.title,
      due: input.due ?? null,
      notes: input.notes,
      status: 'needsAction',
      entities: [],
    };
    this.ds.tasks.push(t);
    this.log.calls.push({ provider: 'tasks', op: 'add', args: [input] });
    return t;
  }
  async updateTask(id: string, patch: { due?: string | null; done?: boolean; backlog?: boolean }) {
    const t = this.ds.tasks.find((x) => x.id === id || x.rawId === id);
    if (!t) throw new Error(`onbekende taak ${id}`);
    if (patch.due !== undefined) t.due = patch.due;
    if (patch.done !== undefined) t.status = patch.done ? 'completed' : 'needsAction';
    if (patch.backlog !== undefined) {
      t.backlog = patch.backlog;
      if (patch.backlog) t.due = null;
    }
    this.log.calls.push({ provider: 'tasks', op: 'update', args: [id, patch] });
    return t;
  }
}

/** Slack-opmaak naar platte tekst voor previews (`<@U..>` -> @naam). */
export const cleanSlack = (s: string, me = SLACK_ME) =>
  String(s || '')
    .replace(new RegExp(`<@${me}>`, 'g'), '@Robert')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/[*_~]/g, '');

export class FixtureSlack implements SlackProvider {
  readonly mode = 'fixture' as const;
  private seq = 0;
  constructor(
    private ds: FixtureDataset,
    private log: FixtureLog,
  ) {}
  async listConversations(): Promise<Conversation[]> {
    const unread = new Set(
      this.ds.slack.filter((i) => !i.read && !i.fromMe && !i.bot && !i.answered).map((i) => i.channelId),
    );
    return this.ds.chans.map((c) => {
      const h = this.ds.history[c.id] ?? [];
      const last = [...h].sort((a, b) => a.time.localeCompare(b.time)).at(-1);
      return {
        key: 'sl:' + c.id,
        kind: c.kind,
        name: c.kind === 'ch' ? '#' + c.name : c.name,
        purpose: c.purpose,
        unread: unread.has(c.id),
        time: last?.time,
        preview: last ? `${last.me ? 'jij' : last.fromName}: ${cleanSlack(last.text).replace(/\s+/g, ' ')}` : c.purpose,
        entities: c.entities ?? [],
      };
    });
  }
  async history(channelId: string): Promise<Message[]> {
    return [...(this.ds.history[channelId] ?? [])].sort((a, b) => a.time.localeCompare(b.time));
  }
  async thread(channelId: string, ts: string): Promise<Message[]> {
    return this.ds.threads[`${channelId}|${ts}`] ?? (this.ds.history[channelId] ?? []).filter((m) => m.ts === ts);
  }
  async attention() {
    return this.ds.slack;
  }
  async markRead(channelId: string, ts: string) {
    for (const i of this.ds.slack) if (i.channelId === channelId && (!i.ts || i.ts <= ts)) i.read = true;
    this.log.calls.push({ provider: 'slack', op: 'markRead', args: [channelId, ts] });
  }
  async postMessage(channelId: string, text: string, threadTs?: string) {
    const ts = `${Math.floor(+this.ds.now / 1000)}.${String(++this.seq).padStart(6, '0')}`;
    const msg: Message = {
      ts,
      time: `${ymd(this.ds.now)}T${String(this.ds.now.getHours()).padStart(2, '0')}:${String(this.ds.now.getMinutes()).padStart(2, '0')}`,
      fromName: 'Robert Verveen',
      fromId: SLACK_ME,
      me: true,
      bot: false,
      text,
      replies: 0,
      files: [],
      reactions: [],
    };
    if (threadTs) (this.ds.threads[`${channelId}|${threadTs}`] ??= []).push(msg);
    else (this.ds.history[channelId] ??= []).push(msg);
    this.log.calls.push({ provider: 'slack', op: 'postMessage', args: [channelId, text, threadTs] });
    return { ts };
  }
  async react(channelId: string, ts: string, name: string) {
    const m = (this.ds.history[channelId] ?? []).find((x) => x.ts === ts);
    if (m) {
      const r = m.reactions.find((x) => x.name === name);
      if (r) {
        r.count += 1;
        r.mine = true;
      } else m.reactions.push({ name, count: 1, mine: true });
    }
    this.log.calls.push({ provider: 'slack', op: 'react', args: [channelId, ts, name] });
  }
}

export class FixtureJira implements JiraProvider {
  readonly mode = 'fixture' as const;
  constructor(private ds: FixtureDataset) {}
  async activeSprint() {
    return this.ds.jira;
  }
}

export class FixtureWispr implements WisprProvider {
  readonly mode = 'fixture' as const;
  constructor(private ds: FixtureDataset) {}
  async listMeetings(since: string) {
    return this.ds.recs.filter((r) => r.start >= since || pd(r.start) >= pd(since));
  }
}

/**
 * Nep-Anthropic: deterministisch antwoord op basis van de vraag, met tokentelling.
 * Gebruikt in alle tests; er gaat nooit een netwerkcall naar Anthropic.
 */
export class FakeAnthropic implements AnthropicProvider {
  readonly mode = 'fixture' as const;
  readonly requests: CompletionRequest[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const q = req.messages.at(-1)?.content ?? '';
    const words = (s: string) => Math.ceil(s.split(/\s+/).filter(Boolean).length * 1.3);
    return {
      text: `Voorbeeldantwoord (nep-Claude) op: “${q.slice(0, 120)}”. Dit is een concept; controleer de bronnen.`,
      model: `fake-${req.purpose}`,
      usage: {
        inputTokens: words(req.system) + req.messages.reduce((s, m) => s + words(m.content), 0),
        outputTokens: 24,
      },
    };
  }
}
