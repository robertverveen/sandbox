/**
 * Eén interface per bron. Elke bron heeft twee implementaties:
 *  - `fixture`: synthetische, realistische antwoorden (afgeleid van de demodata van het prototype);
 *    hiermee ontwikkelen en testen we. Nooit echte partnerdata in Git.
 *  - `live`: de echte API. In het fundament zijn dit lege implementaties met TODO's voor de
 *    koppelingsstukken; ze gaan aan via omgevingsvariabelen zodra er credentials zijn.
 * Tokens komen per collega uit de database (envelope-versleuteld) en nooit in de browser.
 */
import type {
  BusyBlock,
  CalendarInfo,
  ContextSnapshot,
  Conversation,
  ConversationDetail,
  JiraItem,
  JiraSprint,
  MailItem,
  MeetingItem,
  Message,
  NewEvent,
  RecItem,
  SlackItem,
  TaskItem,
  TaskList,
} from '@hz/shared';

export type ProviderMode = 'fixture' | 'live';

export interface ProviderBase {
  readonly mode: ProviderMode;
}

export interface DateRange {
  /** JJJJ-MM-DD (inclusief) */
  from: string;
  /** JJJJ-MM-DD (exclusief) */
  to: string;
}

/** Google Agenda: alle agenda's in het werkaccount, ook gedeelde privé-agenda's. Tijden in Europe/Amsterdam. */
export interface CalendarProvider extends ProviderBase {
  listCalendars(): Promise<Array<Pick<CalendarInfo, 'id' | 'summary' | 'primary'> & { backgroundColor?: string }>>;
  listEvents(range: DateRange): Promise<MeetingItem[]>;
  respond(eventId: string, response: 'accepted' | 'tentative' | 'declined'): Promise<void>;
  /** Bezette blokken per collega (Google freebusy.query; alleen tijden, geen titels). */
  freeBusy(emails: string[], range: DateRange): Promise<Array<{ email: string; busy: BusyBlock[]; error?: string }>>;
  /**
   * Afspraak maken in de eigen agenda. Alleen na een klik van een mens: Google stuurt de uitnodigingen
   * (sendUpdates=all), de app zelf verstuurt niets.
   */
  createEvent(e: NewEvent): Promise<MeetingItem>;
}

/** Gmail (optioneel per collega). Mailtekst wordt live opgehaald en kort gecachet, nooit opgeslagen. */
export interface GmailProvider extends ProviderBase {
  /** Recente threads in de inbox als items (ongelezen en direct gemarkeerd). */
  listThreads(): Promise<MailItem[]>;
  listConversations(): Promise<Conversation[]>;
  getThread(threadId: string): Promise<NonNullable<ConversationDetail['mail']> | null>;
  /** Gelezen/ongelezen, ook echt in Gmail; terug te draaien. */
  markRead(threadId: string, read: boolean): Promise<void>;
  /** Antwoord versturen. Alleen na een klik van een mens. */
  reply(threadId: string, body: string, opts: { replyAll: boolean }): Promise<{ id: string }>;
}

/** Google Taken: lijsten, taken, Backlog-lijst. */
export interface TasksProvider extends ProviderBase {
  listTaskLists(): Promise<TaskList[]>;
  listTasks(): Promise<TaskItem[]>;
  addTask(input: { title: string; due?: string | null; list?: string; notes?: string }): Promise<TaskItem>;
  updateTask(id: string, patch: { due?: string | null; done?: boolean; backlog?: boolean }): Promise<TaskItem>;
}

/** Slack via de interne app met user token: kanalen, DM's, geschiedenis, threads, zoeken, gelezen zetten. */
export interface SlackProvider extends ProviderBase {
  listConversations(): Promise<Conversation[]>;
  history(channelId: string): Promise<Message[]>;
  thread(channelId: string, ts: string): Promise<Message[]>;
  /** DM's, vermeldingen en eigen 📣-markeringen als items. */
  attention(): Promise<SlackItem[]>;
  /** Echt gelezen zetten in Slack (conversations.mark). */
  markRead(channelId: string, ts: string): Promise<void>;
  postMessage(channelId: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  react(channelId: string, ts: string, name: string): Promise<void>;
}

/** Jira (Atlassian 3LO, alleen lezen): lopende sprint van HOM, storypoints, Tester-veld. */
export interface JiraProvider extends ProviderBase {
  activeSprint(): Promise<{ sprint: JiraSprint | null; issues: JiraItem[] }>;
}

/** Wispr Flow: alleen meetings na de laatste nachtrun; de rest komt uit de contextlaag. */
export interface WisprProvider extends ProviderBase {
  listMeetings(since: string): Promise<RecItem[]>;
}

/** Contextlaag (HomeZero-context + Persoonlijk-repo), nooit admin.md. */
export interface ContextProvider extends ProviderBase {
  readonly source: 'fixture' | 'export' | 'repo';
  snapshot(): Promise<ContextSnapshot>;
}

export interface CompletionRequest {
  /** Functie bepaalt het model (budget per functie). */
  purpose: 'ask' | 'recap' | 'extract' | 'brief';
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
}
export interface CompletionResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
}

/** Anthropic API, alleen op de server. In tests altijd de nep-implementatie. */
export interface AnthropicProvider extends ProviderBase {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface Providers {
  calendar: CalendarProvider;
  gmail: GmailProvider;
  tasks: TasksProvider;
  slack: SlackProvider;
  jira: JiraProvider;
  wispr: WisprProvider;
  context: ContextProvider;
  anthropic: AnthropicProvider;
}

export class NotConnectedError extends Error {
  constructor(
    readonly provider: string,
    detail = 'nog niet gebouwd',
  ) {
    super(`${provider}: live-koppeling ${detail}`);
    this.name = 'NotConnectedError';
  }
}
