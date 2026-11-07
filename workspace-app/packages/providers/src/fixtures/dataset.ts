import type {
  Briefing,
  CommitItem,
  ContextSnapshot,
  Conversation,
  JiraItem,
  JiraSprint,
  MailItem,
  MailMessage,
  MeetingItem,
  Message,
  RecItem,
  SlackItem,
  TaskItem,
  TaskList,
  Weekdoel,
} from '@hz/shared';
import { pd } from '@hz/shared/logic';
import * as D from './demo';
import { harnessData } from './harness';

export type FixtureSetName = 'demo' | 'harness';

/** Alles wat de fixture-providers en de seed van de app-opslag nodig hebben. */
export interface FixtureDataset {
  name: FixtureSetName;
  now: Date;
  calendars: Array<{ id: string; summary: string; primary?: boolean }>;
  meetings: MeetingItem[];
  recs: RecItem[];
  mails: MailItem[];
  mailThreads: Record<string, { subject: string; url: string | null; msgs: MailMessage[] }>;
  mailConvs: Conversation[];
  slack: SlackItem[];
  chans: typeof D.DEMO_CHANS;
  history: Record<string, Message[]>;
  threads: Record<string, Message[]>;
  tasklists: TaskList[];
  tasks: TaskItem[];
  jira: { sprint: JiraSprint | null; issues: JiraItem[] };
  context: ContextSnapshot;
  legacyCommits: CommitItem[];
  weekdoelen: Weekdoel[];
  briefing: Briefing | null;
  contextItems: typeof D.DEMO_CONTEXT_ITEMS;
}

const clone = <T>(x: T): T => structuredClone(x);

/** Laad een dataset. `demo` heeft een vaste klok; `harness` rekent vanaf `now`. */
export function loadFixtureSet(name: FixtureSetName, now?: Date): FixtureDataset {
  if (name === 'harness') {
    const n = now ?? new Date();
    const h = harnessData(n);
    return {
      name,
      now: n,
      calendars: h.calendars,
      meetings: h.meetings,
      recs: [],
      mails: h.mails,
      mailThreads: {
        t1: {
          subject: 'Meterkastcheck',
          url: null,
          msgs: [
            {
              fromName: 'Sanne de Wit',
              from: 'sanne@voorbeeldpartner.nl',
              to: ['robert@homezero.nl'],
              cc: [],
              time: h.mails[0]!.time,
              body: 'Hoi Robert,\n\nKun je even kijken naar de opleverlijst?\n\nSanne',
              quoted: '',
              files: [],
              unread: true,
            },
          ],
        },
      },
      mailConvs: [
        {
          key: 'ml:t1',
          kind: 'mail',
          name: 'Sanne de Wit',
          preview: 'Meterkastcheck',
          unread: true,
          time: h.mails[0]!.time,
          entities: [],
        },
      ],
      slack: h.slack,
      chans: [{ id: 'CFE', kind: 'ch', name: 'feenstra-hz' }],
      history: {
        CFE: [
          {
            ts: h.slack[0]!.ts!,
            time: h.slack[0]!.time,
            fromName: 'Sanne de Wit',
            fromId: 'UMB',
            me: false,
            bot: false,
            text: `<@${D.SLACK_ME}> kun je even kijken naar de opleverlijst?`,
            replies: 0,
            files: [],
            reactions: [],
          },
        ],
      },
      threads: {},
      tasklists: h.tasklists,
      tasks: h.tasks,
      jira: { sprint: null, issues: [] },
      context: { status: null, partners: {}, acties: {}, pers: null },
      legacyCommits: h.commits,
      weekdoelen: h.weekdoelen,
      briefing: null,
      contextItems: [],
    };
  }
  return {
    name: 'demo',
    now: now ?? pd(D.DEMO_NOW),
    calendars: clone(D.DEMO_CALENDARS),
    meetings: clone(D.DEMO_MEETINGS),
    recs: clone(D.DEMO_RECS),
    mails: clone(D.DEMO_MAILS),
    mailThreads: clone(D.DEMO_MAILTHREADS),
    mailConvs: clone(D.DEMO_MAIL_CONVS),
    slack: clone(D.DEMO_SLACK),
    chans: clone(D.DEMO_CHANS),
    history: clone(D.DEMO_HISTORY),
    threads: clone(D.DEMO_THREADS),
    tasklists: clone(D.DEMO_TASKLISTS),
    tasks: clone(D.DEMO_TASKS),
    jira: { sprint: clone(D.DEMO_SPRINT), issues: clone(D.DEMO_JIRA) },
    context: clone(D.DEMO_CTX),
    legacyCommits: clone(D.DEMO_LEGACY_COMMITS),
    weekdoelen: clone(D.DEMO_WEEKDOELEN),
    briefing: clone(D.DEMO_BRIEFING),
    contextItems: clone(D.DEMO_CONTEXT_ITEMS),
  };
}
