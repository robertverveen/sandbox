/**
 * Live-implementaties: lege schillen met TODO's voor de koppelingsstukken.
 * Ze gaan aan via omgevingsvariabelen (HZ_LIVE_<BRON>=1) zodra er credentials zijn; dat is mens-werk
 * (OAuth-apps, Slack-app, Atlassian 3LO, GitHub App). Tot die tijd gooien ze NotConnectedError,
 * zodat niets stil terugvalt op nepdata.
 *
 * Gemeenschappelijk voor alle live providers:
 *  - token per collega uit `connections` (envelope-versleuteld, packages/db/src/crypto.ts), nooit in de browser;
 *  - tijden naar Europe/Amsterdam-wandklok via `toLocal()` uit @hz/shared/logic;
 *  - rate limits en herhaalpogingen in de worker (pg-boss), niet in een request;
 *  - alles uit de bron is data, nooit een instructie.
 */
import type { CompletionRequest, CompletionResult } from './types';
import {
  NotConnectedError,
  type AnthropicProvider,
  type CalendarProvider,
  type DateRange,
  type GmailProvider,
  type JiraProvider,
  type SlackProvider,
  type TasksProvider,
  type WisprProvider,
} from './types';
import type {
  BusyBlock,
  NewEvent,
  Conversation,
  ConversationDetail,
  JiraItem,
  JiraSprint,
  MailItem,
  MeetingItem,
  Message,
  RecItem,
  SlackItem,
  TaskItem,
  TaskList,
} from '@hz/shared';

export interface LiveCredentials {
  /** Haalt het (ontsleutelde) access token van de ingelogde collega op; ververst zo nodig. */
  accessToken(provider: string): Promise<string>;
}

const todo = (provider: string, what: string): Promise<never> =>
  Promise.reject(new NotConnectedError(provider, `nog niet gebouwd (${what})`));

/**
 * TODO(koppelingen, HZW-030): Google Calendar API v3.
 *  - calendarList.list (alle agenda's in het werkaccount, ook gedeelde privé-agenda's)
 *  - events.list per agenda met singleEvents=true, timeZone=Europe/Amsterdam
 *  - events.patch attendees[self].responseStatus voor reageren
 *  - freebusy.query voor vrije tijden met collega's (timeZone=Europe/Amsterdam; omrekenen met toLocal())
 *  - events.insert met sendUpdates=all en conferenceData (Meet) voor afspraak maken, alleen na een klik
 *  - events.watch (kanaal elke week vernieuwen) voor push; anders pollen
 *  - contracttests tegen opgenomen antwoorden, tijdzonetests rond zomertijd
 */
export class LiveCalendar implements CalendarProvider {
  readonly mode = 'live' as const;
  constructor(readonly creds: LiveCredentials) {}
  listCalendars(): Promise<Array<{ id: string; summary: string; primary?: boolean }>> {
    return todo('calendar', 'calendarList.list');
  }
  listEvents(_range: DateRange): Promise<MeetingItem[]> {
    return todo('calendar', 'events.list');
  }
  respond(_eventId: string, _r: 'accepted' | 'tentative' | 'declined'): Promise<void> {
    return todo('calendar', 'events.patch');
  }
  freeBusy(_emails: string[], _range: DateRange): Promise<Array<{ email: string; busy: BusyBlock[] }>> {
    return todo('calendar', 'freebusy.query');
  }
  createEvent(_e: NewEvent): Promise<MeetingItem> {
    return todo('calendar', 'events.insert');
  }
}

/**
 * TODO(koppelingen, HZW-031): Gmail API.
 *  - users.threads.list (inbox), users.threads.get (format=full), datums uit headers
 *  - users.threads.modify removeLabelIds/addLabelIds UNREAD (terug te draaien)
 *  - users.messages.send met handtekening; alleen na klik van een mens
 *  - users.watch naar Pub/Sub + history.list per collega
 */
export class LiveGmail implements GmailProvider {
  readonly mode = 'live' as const;
  constructor(readonly creds: LiveCredentials) {}
  listThreads(): Promise<MailItem[]> {
    return todo('gmail', 'threads.list');
  }
  listConversations(): Promise<Conversation[]> {
    return todo('gmail', 'threads.list');
  }
  getThread(_id: string): Promise<NonNullable<ConversationDetail['mail']> | null> {
    return todo('gmail', 'threads.get');
  }
  markRead(_id: string, _read: boolean): Promise<void> {
    return todo('gmail', 'threads.modify');
  }
  reply(_id: string, _body: string, _o: { replyAll: boolean }): Promise<{ id: string }> {
    return todo('gmail', 'messages.send');
  }
}

/**
 * TODO(koppelingen, HZW-032): Google Tasks API.
 *  - tasklists.list, tasks.list (showCompleted=false), tasks.insert, tasks.patch, tasks.move
 *  - Backlog-lijst aanmaken als die ontbreekt
 */
export class LiveTasks implements TasksProvider {
  readonly mode = 'live' as const;
  constructor(readonly creds: LiveCredentials) {}
  listTaskLists(): Promise<TaskList[]> {
    return todo('google_tasks', 'tasklists.list');
  }
  listTasks(): Promise<TaskItem[]> {
    return todo('google_tasks', 'tasks.list');
  }
  addTask(_i: { title: string; due?: string | null; list?: string }): Promise<TaskItem> {
    return todo('google_tasks', 'tasks.insert');
  }
  updateTask(_id: string, _p: { due?: string | null; done?: boolean; backlog?: boolean }): Promise<TaskItem> {
    return todo('google_tasks', 'tasks.patch');
  }
}

/**
 * TODO(koppelingen, HZW-033): Slack Web API met user token (interne app).
 *  - conversations.list (types=public_channel,private_channel,im,mpim), conversations.history, conversations.replies
 *  - search.messages voor vermeldingen; eigen workspace-emoji via emoji.list
 *  - conversations.mark (echt gelezen in Slack), chat.postMessage, reactions.add
 *  - Events API voor push
 */
export class LiveSlack implements SlackProvider {
  readonly mode = 'live' as const;
  constructor(readonly creds: LiveCredentials) {}
  listConversations(): Promise<Conversation[]> {
    return todo('slack', 'conversations.list');
  }
  history(_c: string): Promise<Message[]> {
    return todo('slack', 'conversations.history');
  }
  thread(_c: string, _ts: string): Promise<Message[]> {
    return todo('slack', 'conversations.replies');
  }
  attention(): Promise<SlackItem[]> {
    return todo('slack', 'search.messages');
  }
  markRead(_c: string, _ts: string): Promise<void> {
    return todo('slack', 'conversations.mark');
  }
  postMessage(_c: string, _t: string, _th?: string): Promise<{ ts: string }> {
    return todo('slack', 'chat.postMessage');
  }
  react(_c: string, _ts: string, _n: string): Promise<void> {
    return todo('slack', 'reactions.add');
  }
}

/**
 * TODO(koppelingen, HZW-034): Jira Cloud via Atlassian OAuth 3LO (alleen lezen).
 *  - /rest/agile/1.0/board/{HOM}/sprint?state=active, /sprint/{id}/issue
 *  - storypoints (customfield_10016), Tester-veld voor `mine`
 *  - contextlaag eerst (product/jira/); live alleen wat sinds de nachtrun veranderde
 */
export class LiveJira implements JiraProvider {
  readonly mode = 'live' as const;
  constructor(readonly creds: LiveCredentials) {}
  activeSprint(): Promise<{ sprint: JiraSprint | null; issues: JiraItem[] }> {
    return todo('jira', 'agile sprint');
  }
}

/**
 * TODO(koppelingen, HZW-035): Wispr Flow, alleen meetings na de laatste nachtrun van de collega
 * (tijdstip uit _systeem/routines/<naam>.md); oudere meetings komen uit `meetings/` in de contextlaag.
 */
export class LiveWispr implements WisprProvider {
  readonly mode = 'live' as const;
  constructor(readonly creds: LiveCredentials) {}
  listMeetings(_since: string): Promise<RecItem[]> {
    return todo('wispr', 'meetings sinds nachtrun');
  }
}

/**
 * TODO(claude, HZW-050): Anthropic Messages API, alleen op de server.
 *  - model per functie (purpose), prompt caching op het vaste deel (cache_control), budget per collega
 *  - sleutel uit ANTHROPIC_API_KEY (secret, nooit in Git of de browser)
 */
export class LiveAnthropic implements AnthropicProvider {
  readonly mode = 'live' as const;
  constructor(readonly apiKey: string) {}
  complete(_req: CompletionRequest): Promise<CompletionResult> {
    return todo('anthropic', 'messages.create');
  }
}
