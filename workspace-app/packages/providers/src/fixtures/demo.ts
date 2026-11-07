/**
 * Demo-dataset: synthetisch, afgeleid van DEMO_ITEMS, DEMO_CONV, DEMO_JIRA, DEMO_BRIEFING en DEMO_CTX
 * in het prototype (v17). Klok: vrijdag 30 oktober 2026, 08:40 (NOW_DEMO).
 * Namen en organisaties zijn voorbeelden; er staat geen echte partnerdata, mail of contact in.
 */
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
  Weekdoel,
} from '@hz/shared';
import { amsterdamToInstant } from '@hz/shared/logic';

export const DEMO_NOW = '2026-10-30T08:40:00';
export const SLACK_ME = 'U04L22BRJQ7';
export const SELF_EMAIL = 'robert@homezero.nl';

/** Slack-ts uit een Amsterdamse wandkloktijd. */
export const tsOf = (local: string) => `${Math.floor(+amsterdamToInstant(local) / 1000)}.000100`;

export const DEMO_CALENDARS = [
  { id: 'robert@homezero.nl', summary: 'robert@homezero.nl', primary: true },
  { id: 'demo-familie@group.calendar.google.com', summary: 'Familie' },
  { id: 'sport@import.calendar.google.com', summary: 'Sport' },
  { id: 'eten@import.calendar.google.com', summary: 'Eten / afspraak' },
  { id: 'collega@homezero.nl', summary: 'collega@homezero.nl' },
];

const meet = (m: Omit<MeetingItem, 'type' | 'attendeeNames' | 'entities'> & Partial<MeetingItem>): MeetingItem => ({
  type: 'meeting',
  entities: [],
  attendeeNames: [],
  calId: SELF_EMAIL,
  ...m,
});

export const DEMO_MEETINGS: MeetingItem[] = [
  meet({
    id: 'm1',
    title: 'Feenstra · maandelijkse check-in',
    start: '2026-10-30T10:00',
    end: '2026-10-30T11:00',
    entities: ['feenstra'],
    attendeeNames: ['Marie-José', 'Robert Verveen', 'Lisanne'],
    where: 'Google Meet',
    external: true,
  }),
  meet({
    id: 'm2',
    title: 'Sprint review Pico',
    start: '2026-10-30T13:00',
    end: '2026-10-30T13:45',
    attendeeNames: ['Robert Verveen', 'Emiel', 'Lisanne'],
    where: 'Kantoor',
  }),
  meet({
    id: 'm3',
    title: 'TonZon x HomeZero',
    start: '2026-10-30T15:00',
    end: '2026-10-30T16:00',
    entities: ['tonzon'],
    attendeeNames: ['Peter', 'Robert Verveen', 'Mike'],
    where: 'Google Meet',
    external: true,
  }),
  meet({
    id: 'm8',
    title: 'Sunergy',
    start: '2026-11-02T14:15',
    end: '2026-11-02T15:00',
    entities: ['sunergy'],
    attendeeNames: ['Bjorn', 'Robert Verveen'],
    where: 'Google Meet',
    external: true,
    needsAction: true,
    organizerName: 'Bjorn',
  }),
  meet({
    id: 'lou1',
    calId: 'sport@import.calendar.google.com',
    title: 'Sport',
    start: '2026-10-30T18:00',
    end: '2026-10-30T19:00',
  }),
  meet({
    id: 'lou2',
    calId: 'eten@import.calendar.google.com',
    title: 'Eten met vrienden',
    start: '2026-10-29T19:00',
    end: '2026-10-29T21:00',
  }),
  meet({
    id: 'fam1',
    calId: 'demo-familie@group.calendar.google.com',
    title: 'Verjaardag oma',
    start: '2026-10-31',
    end: '2026-11-01',
    allDay: true,
  }),
];

export const DEMO_RECS: RecItem[] = [
  {
    id: 'r1',
    rawId: 'r1',
    type: 'rec',
    title: 'Feenstra · werksessie ZSB-flow',
    start: '2026-10-29T09:00',
    end: '2026-10-29T10:00',
    entities: ['feenstra'],
    attendeeNames: ['Marie-José', 'Robert'],
    url: null,
    transcript: true,
  },
];

export const DEMO_MAILS: MailItem[] = [
  {
    id: 'e5',
    type: 'mail',
    threadId: 'demo-zsb',
    title: 'Vraag over de ZSB-flow',
    fromName: 'Marie-José',
    from: 'mj@feenstra.nl',
    time: '2026-10-30T07:24',
    entities: ['feenstra'],
    unread: true,
    direct: true,
    body: 'Kunnen we het aantal personen én de warmwatervraag combineren?',
  },
  {
    id: 'e4',
    type: 'mail',
    threadId: 'demo-iso',
    title: 'Notulen workshop isolatie',
    fromName: 'Mike',
    from: 'mike@homezero.nl',
    time: '2026-10-29T17:05',
    entities: [],
    unread: true,
    direct: false,
    body: 'Ter info de notulen en acties.',
  },
];

export const DEMO_SLACK: SlackItem[] = [
  {
    id: 's1',
    type: 'slack',
    channel: '#feenstra-hz',
    channelId: 'CDEMOFEEN',
    ts: tsOf('2026-10-29T09:12'),
    fromName: 'Marie-José',
    fromId: 'UMJ',
    time: '2026-10-29T09:12',
    entities: ['feenstra'],
    title: 'De leads van gisteravond staan niet in de planning, kan iemand kijken?',
    mention: true,
  },
  {
    id: 's10',
    type: 'slack',
    channel: 'DM Mike',
    channelId: 'DDEMOMIKE',
    ts: tsOf('2026-10-29T11:37'),
    dm: true,
    fromName: 'Mike',
    fromId: 'UMIKE',
    time: '2026-10-29T11:37',
    entities: ['tonzon'],
    title: 'Kan jij Peter van TonZon nog een keer bellen?',
  },
  {
    id: 's11',
    type: 'slack',
    channel: '#02-intern',
    channelId: 'CDEMOINT',
    ts: tsOf('2026-10-30T08:10'),
    fromName: 'Rens',
    fromId: 'URENS',
    time: '2026-10-30T08:10',
    entities: [],
    title: '@Robert Anna heeft nog 2 besluiten nodig voor de partnerovereenkomst 3.0. Kunnen we maandag sparren?',
    mention: true,
  },
];

export const DEMO_TASKLISTS = [
  { id: 'demo', title: 'My Tasks' },
  { id: 'backlog', title: 'Backlog' },
];

export const DEMO_TASKS: TaskItem[] = [
  {
    id: 't1',
    type: 'task',
    rawId: 't1',
    tasklist: 'demo',
    tasklistTitle: 'My Tasks',
    title: '🛠 Prep: TonZon x HomeZero (30 min)',
    due: '2026-10-30',
    entities: ['tonzon'],
    notes: '[briefing] Vragen voor het isolatie-rekenmodel klaarzetten',
    status: 'needsAction',
  },
  {
    id: 't2',
    type: 'task',
    rawId: 't2',
    tasklist: 'demo',
    tasklistTitle: 'My Tasks',
    title: 'Solar Concept reageren',
    due: '2026-10-28',
    entities: [],
    status: 'needsAction',
  },
  {
    id: 't3',
    type: 'task',
    rawId: 't3',
    tasklist: 'demo',
    tasklistTitle: 'My Tasks',
    title: 'Release notes sprint 64 versturen',
    due: '2026-10-30',
    entities: [],
    status: 'needsAction',
  },
  {
    id: 't4',
    type: 'task',
    rawId: 't4',
    tasklist: 'demo',
    tasklistTitle: 'My Tasks',
    title: '🎯 Isolatieflow TonZon live op acceptatie',
    due: '2026-10-30',
    entities: ['tonzon'],
    notes: '[weekprep] Doel: isolatieflow klaar voor test',
    weekgoal: true,
    status: 'needsAction',
  },
];

/**
 * Tracker-items uit de artifact-opslag van het prototype (import HZW-021). Wachten op en bespreken
 * uit het oude canvas staan sinds 5 nov in wachten-op.md en worden daarom niet meer getoond.
 */
export const DEMO_LEGACY_COMMITS: CommitItem[] = [
  {
    id: 'cm:dc3',
    docId: 'dc3',
    type: 'commit',
    title: 'Rekenvoorbeeld thuisbatterij naar Feenstra sturen',
    stroom: 'mijn',
    status: 'open',
    aan: 'Marie-José',
    deadline: '2026-10-29',
    plan: null,
    reminder: null,
    entities: ['feenstra'],
    time: '2026-10-27T09:00',
    body: 'Marie-José · Meeting · Feenstra check-in',
  },
  {
    id: 'cm:dc4',
    docId: 'dc4',
    type: 'commit',
    title: 'Isolatierekenmodel helemaal nalopen',
    stroom: 'voornemen',
    status: 'open',
    aan: '',
    deadline: null,
    plan: null,
    reminder: null,
    entities: [],
    time: '2026-10-26T09:00',
    body: 'Eigen invoer',
  },
];

export const DEMO_WEEKDOELEN: Weekdoel[] = [
  {
    id: 'dg1',
    wat: 'Isolatieflow TonZon live op acceptatie',
    soort: 'weekdoel',
    week: '2026-W44',
    deadline: '2026-10-30',
    status: 'open',
    health: 'groen',
    lastCheck: '2026-10-29',
    checks: [
      { d: '2026-10-28', h: 'groen' },
      { d: '2026-10-29', h: 'groen' },
    ],
    bron: { label: 'Weekdoelen 2026-W44' },
    created: '2026-10-26',
  },
  {
    id: 'dg0',
    wat: 'Release notes sprint 63 naar alle partners',
    soort: 'weekdoel',
    week: '2026-W43',
    deadline: '2026-10-23',
    status: 'open',
    health: 'oranje',
    lastCheck: '2026-10-22',
    checks: [{ d: '2026-10-22', h: 'oranje', note: 'Wacht op input Lisanne' }],
  },
  {
    id: 'dg00',
    wat: 'Feenstra ZSB-flow op acceptatie',
    soort: 'weekdoel',
    week: '2026-W43',
    deadline: '2026-10-23',
    status: 'klaar',
    outcome: 'gehaald',
    health: 'af',
    checks: [],
    closedAt: '2026-10-23',
  },
  {
    id: 'dg01',
    wat: 'Concurrentieradar opzetten',
    soort: 'weekdoel',
    week: '2026-W43',
    deadline: '2026-10-23',
    status: 'losgelaten',
    outcome: 'losgelaten',
    checks: [],
    closedAt: '2026-10-26',
  },
  {
    id: 'dg2',
    wat: 'Qvantum: voorstel communicatietriggers installateursopvolging klaar',
    soort: 'weekdoel',
    week: '2026-W44',
    deadline: '2026-10-30',
    status: 'open',
    health: 'oranje',
    lastCheck: '2026-10-29',
    checks: [{ d: '2026-10-29', h: 'oranje', note: 'Wacht op input Lisanne' }],
    bron: { label: 'Weekdoelen 2026-W44' },
    created: '2026-10-26',
  },
  {
    id: 'dr1',
    wat: 'Rekenmodellen in Pico (thuisbatterij, warmtepomp, isolatie)',
    soort: 'roadmap',
    deadline: '2026-12-15',
    status: 'open',
    health: 'groen',
    lastCheck: '2026-10-20',
    checks: [{ d: '2026-10-20', h: 'groen' }],
    bron: { label: 'Roadmap Q4' },
    created: '2026-09-01',
  },
];

export const DEMO_SPRINT: JiraSprint = {
  id: 1,
  name: 'Sprint 73',
  state: 'active',
  startDate: '2026-10-22T21:54:00Z',
  endDate: '2026-11-05T10:58:00Z',
  goal: 'Sprintdoel: voorbeelddata, zichtbaar zonder live koppeling',
};
const JIRA_ROWS: Array<[string, string, string, JiraItem['cat'], string, number]> = [
  ['DEMO-11', 'Rule Engine V1.5 opzetten', 'In Progress', 'indeterminate', 'Emiel', 2],
  ['DEMO-12', 'Rekenmodel thuisbatterij in Pico', 'Ready to Accept', 'indeterminate', 'Hunter', 3],
  ['DEMO-15', 'Verzendvensters voor mails', 'Ready to Accept', 'indeterminate', 'Emma', 2],
  ['DEMO-16', 'Afspraakscherm herontwerp', 'Ready to Accept', 'indeterminate', 'Hunter', 5],
  ['DEMO-18', 'Inkomende mails koppelen', 'Peer Review', 'indeterminate', 'Emma', 3],
  ['DEMO-19', 'Stadswarmte vraag', 'Done', 'done', 'Emiel', 2],
  ['DEMO-20', 'AI-adviseur tool', 'To Do', 'new', '', 5],
  ['DEMO-21', 'Module-updates', 'Done', 'done', 'Hunter', 3],
];
const MINE = new Set(['DEMO-12', 'DEMO-15']);
export const DEMO_JIRA: JiraItem[] = JIRA_ROWS.map(([key, title, status, cat, assignee, sp]) => ({
  id: 'jr:' + key,
  type: 'jira',
  key,
  title,
  status,
  cat,
  assignee,
  sp,
  sprint: DEMO_SPRINT,
  url: `https://homezero.atlassian.net/browse/${key}`,
  mine: MINE.has(key),
  entities: [],
}));

export const DEMO_BRIEFING: Briefing = {
  id: 'demo-2026-10-30',
  date: '2026-10-30',
  title: '☀️ Briefing vr 30 okt — 3 acties, 3 meetings',
  createdAt: '2026-10-30T07:14:00+01:00',
  session: null,
  sections: [
    {
      title: '🔴 Vandaag doen',
      items: [
        { text: 'Mike vraagt: Peter van TonZon nog een keer bellen (voor 15:00)' },
        { text: 'Rens: 2 besluiten partnerovereenkomst 3.0 (Clarity, ScanID) voor maandag' },
      ],
    },
    {
      title: '📅 Meetings vandaag',
      items: [
        { text: '10:00 Feenstra Monthly · vorige keer: ZSB-flow, leadinstroom tijdelijk uit' },
        { text: '15:00 TonZon x HomeZero · prep ✅ staat op vandaag' },
      ],
    },
    { title: '⏳ Wacht op anderen', items: [{ text: 'Marie-José (Feenstra): keuze ZSB-flow · sinds 26 okt, nudge?' }] },
    { title: '🎯 Weekdoelen', items: [{ text: '🟢 Isolatieflow TonZon live op acceptatie' }] },
  ],
};

export const DEMO_CONTEXT_ITEMS = [
  {
    id: 'c1',
    type: 'context' as const,
    title: 'partners/feenstra/brief.md',
    path: 'partners/feenstra/brief.md',
    time: '2026-10-08T12:10',
    entities: ['feenstra'],
    body: '# Feenstra\n\nFase: live. Contact: Marie-José.',
  },
];

/* ---------- Gesprekken ---------- */
export const DEMO_CHANS: Array<{
  id: string;
  kind: 'ch' | 'dm' | 'group';
  name: string;
  purpose?: string;
  entities?: string[];
}> = [
  { id: 'CDEMOFEEN', kind: 'ch', name: 'feenstra-hz', purpose: 'Partnerkanaal Feenstra', entities: ['feenstra'] },
  { id: 'CDEMOINT', kind: 'ch', name: '02-intern', purpose: 'Intern overleg' },
  { id: 'DDEMOMIKE', kind: 'dm', name: 'Mike' },
  { id: 'GDEMOMR', kind: 'group', name: 'Mike, Rens' },
  { id: 'CDEMOKL', kind: 'ch', name: '04-klanten', purpose: 'Interne updates na klantsessies' },
  { id: 'CDEMOKANT', kind: 'ch', name: '00-kantine', purpose: 'Voor iedereen' },
  { id: 'CDEMOTON', kind: 'ch', name: 'tonzon-hz', purpose: 'Partnerkanaal TonZon', entities: ['tonzon'] },
];

const DM = (fromName: string, fromId: string, at: string, text: string, extra: Partial<Message> = {}): Message => ({
  ts: tsOf(at),
  time: at,
  fromName,
  fromId,
  me: fromId === SLACK_ME,
  bot: false,
  text,
  replies: 0,
  files: [],
  reactions: [],
  ...extra,
});

export const DEMO_HISTORY: Record<string, Message[]> = {
  CDEMOFEEN: [
    DM(
      'Lisanne',
      'UL',
      '2026-10-28T15:02',
      'De nieuwe ZSB-vragen staan op acceptatie. @Marie-José wil jij ze morgen doorlopen?',
    ),
    DM('Marie-José', 'UMJ', '2026-10-28T16:40', 'Top, doe ik morgenochtend :+1:'),
    DM(
      'Marie-José',
      'UMJ',
      '2026-10-29T09:12',
      'De leads van gisteravond staan niet in de planning, kan iemand kijken?',
      { replies: 2, latest: '2026-10-29T09:31' },
    ),
    DM(
      'Robert Verveen',
      SLACK_ME,
      '2026-10-29T10:05',
      'Dank voor het melden. Emiel heeft het gefixt, ze staan er nu in. Kun je even checken of het klopt?',
    ),
    DM('Marie-José', 'UMJ', '2026-10-29T10:20', 'Ja klopt, dank! Zie jullie vrijdag bij de check-in.', {
      reactions: [{ name: 'heart', count: 1 }],
    }),
  ],
  CDEMOINT: [
    DM(
      'Weekly updates',
      'B07',
      '2026-10-30T10:00',
      'Het is vrijdag! Tijd voor een update over onze *Weekdoelen*:\n1. Zijn ze behaald?\n2. Waarom wel/niet?\n3. Heb je nog een hulpvraag?',
      { bot: true, replies: 3 },
    ),
    DM(
      'Rens',
      'URENS',
      '2026-10-30T08:10',
      `<@${SLACK_ME}> Anna heeft nog 2 besluiten nodig voor de partnerovereenkomst 3.0. Kunnen we maandag sparren?`,
    ),
    DM('Mike', 'UMIKE', '2026-10-30T08:22', 'Ik schuif ook aan, heb er nog wat input op vanuit sales.'),
  ],
  DDEMOMIKE: [
    DM('Mike', 'UMIKE', '2026-10-28T17:12', 'Hoe ging de demo bij TonZon?'),
    DM(
      'Robert Verveen',
      SLACK_ME,
      '2026-10-28T17:30',
      'Goed! Ze willen de isolatieflow volgende week op acceptatie zien.',
    ),
    DM(
      'Mike',
      'UMIKE',
      '2026-10-29T11:37',
      'Kan jij Peter van TonZon nog een keer bellen? Hij twijfelt over het rekenmodel.',
    ),
  ],
  GDEMOMR: [
    DM('Rens', 'URENS', '2026-10-27T12:00', 'Lunch donderdag bij het kantoor?'),
    DM('Mike', 'UMIKE', '2026-10-27T12:04', 'Ik ben erbij'),
  ],
  CDEMOKL: [
    DM(
      'Robert Verveen',
      SLACK_ME,
      '2026-10-29T10:30',
      '*Feenstra · werksessie ZSB-flow*\n• Personen + warmwatervraag combineren in één vraag\n• Lisanne past de flow aan, Marie-José test vrijdag',
    ),
  ],
  CDEMOKANT: [DM('Jade', 'UJADE', '2026-10-30T12:15', 'Er staat taart in de keuken :tada:')],
  CDEMOTON: [DM('Peter', 'UPETER', '2026-10-27T14:00', 'Kunnen we het rekenmodel nog een keer samen doorlopen?')],
};

export const DEMO_THREADS: Record<string, Message[]> = {
  ['CDEMOFEEN|' + tsOf('2026-10-29T09:12')]: [
    DM(
      'Marie-José',
      'UMJ',
      '2026-10-29T09:12',
      'De leads van gisteravond staan niet in de planning, kan iemand kijken?',
    ),
    DM(
      'Emiel',
      'UEMIEL',
      '2026-10-29T09:25',
      'Ik kijk ernaar. Lijkt een sync die bleef hangen na de deploy van gisteravond.',
    ),
    DM('Emiel', 'UEMIEL', '2026-10-29T09:31', 'Opgelost, alle 6 leads staan er weer in.', {
      reactions: [{ name: 'raised_hands', count: 2 }],
    }),
  ],
  ['CDEMOINT|' + tsOf('2026-10-30T10:00')]: [
    DM('Weekly updates', 'B07', '2026-10-30T10:00', 'Het is vrijdag! Tijd voor een update over onze *Weekdoelen*.', {
      bot: true,
    }),
    DM('Rens', 'URENS', '2026-10-30T10:40', "LOI's: 4 van 6 binnen. Hulpvraag: wie belt Dico?"),
    DM('Mike', 'UMIKE', '2026-10-30T11:02', 'Doelen behaald, behalve de campagne. Die schuift naar volgende week.'),
    DM(
      'Robert Verveen',
      SLACK_ME,
      '2026-10-30T11:15',
      'Isolatieflow TonZon staat op acceptatie. Release notes sprint 64 gaan vanmiddag de deur uit.',
    ),
  ],
};

export const DEMO_MAILTHREADS: Record<string, { subject: string; url: string | null; msgs: MailMessage[] }> = {
  'demo-zsb': {
    subject: 'Vraag over de ZSB-flow',
    url: null,
    msgs: [
      {
        fromName: 'Robert Verveen',
        from: 'robert@homezero.nl',
        to: ['mj@feenstra.nl'],
        cc: ['lisanne@homezero.nl'],
        time: '2026-10-29T10:45',
        body: 'Hoi Marie-José,\n\nDank voor de fijne sessie van vanochtend. Zoals besproken zetten we de nieuwe vragen deze week op acceptatie. Laat je weten of je nog iets mist?\n\nGroet,\nRobert',
        quoted: '',
        files: [],
      },
      {
        fromName: 'Marie-José',
        from: 'mj@feenstra.nl',
        to: ['robert@homezero.nl'],
        cc: ['lisanne@homezero.nl'],
        time: '2026-10-30T07:24',
        body: 'Hoi Robert,\n\nKunnen we het aantal personen én de warmwatervraag combineren? Dan hoeven klanten één stap minder te doen. Ik heb een schets toegevoegd.\n\nGroet,\nMarie-José',
        quoted:
          'Op 29 okt 2026 om 10:45 schreef Robert Verveen <robert@homezero.nl>:\n> Hoi Marie-José,\n> Dank voor de fijne sessie van vanochtend.',
        files: ['schets-zsb-flow.pdf'],
        unread: true,
      },
    ],
  },
  'demo-iso': {
    subject: 'Notulen workshop isolatie',
    url: null,
    msgs: [
      {
        fromName: 'Mike',
        from: 'mike@homezero.nl',
        to: ['team@isolatie.example'],
        cc: ['robert@homezero.nl', 'rens@homezero.nl'],
        time: '2026-10-29T17:05',
        body: 'Hoi allemaal,\n\nTer info de notulen en acties van de workshop.\n\n1. Rekenmodel isolatie: Robert stuurt de aangepaste versie\n2. Leadflow: live op acceptatie volgende week\n3. Volgende sessie: 12 november\n\nGroet,\nMike',
        quoted: '',
        files: ['notulen-workshop.pdf'],
        unread: true,
      },
    ],
  },
  'demo-tz': {
    subject: 'Planning acceptatie isolatieflow',
    url: null,
    msgs: [
      {
        fromName: 'Peter',
        from: 'peter@tonzon.nl',
        to: ['robert@homezero.nl'],
        cc: [],
        time: '2026-10-27T09:10',
        body: 'Hoi Robert,\n\nWanneer kunnen we de isolatieflow op acceptatie verwachten?\n\nPeter',
        quoted: '',
        files: [],
      },
      {
        fromName: 'Robert Verveen',
        from: 'robert@homezero.nl',
        to: ['peter@tonzon.nl'],
        cc: [],
        time: '2026-10-27T11:30',
        body: 'Hoi Peter,\n\nWe mikken op vrijdag 30 oktober. Ik laat het je weten zodra hij klaarstaat.\n\nRobert',
        quoted:
          'Op 27 okt 2026 om 09:10 schreef Peter <peter@tonzon.nl>:\n> Wanneer kunnen we de isolatieflow op acceptatie verwachten?',
        files: [],
      },
    ],
  },
};

export const DEMO_MAIL_CONVS: Conversation[] = [
  {
    key: 'ml:demo-zsb',
    kind: 'mail',
    name: 'Marie-José',
    preview: 'Vraag over de ZSB-flow',
    unread: true,
    time: '2026-10-30T07:24',
    entities: ['feenstra'],
  },
  {
    key: 'ml:demo-iso',
    kind: 'mail',
    name: 'Mike',
    preview: 'Notulen workshop isolatie',
    unread: true,
    time: '2026-10-29T17:05',
    entities: [],
  },
  {
    key: 'ml:demo-tz',
    kind: 'mail',
    name: 'Peter',
    preview: 'Planning acceptatie isolatieflow',
    unread: false,
    time: '2026-10-27T11:30',
    entities: ['tonzon'],
  },
];

/* ---------- Contextlaag (DEMO_CTX) ---------- */
export const DEMO_CTX: ContextSnapshot = {
  status: {
    status: '2026-10-30 | groen | lek 0 | fouten 0 | let op 12 | over datum 4 | bestanden 120',
    nachtdienst: '2026-10-30 01:16 | groen | gezien 2 | verwerkt 2',
    commit_context: 'demo123',
    commit_prive: 'demo456',
    geexporteerd: '2026-10-30T07:20:00+01:00',
    partners: 3,
  },
  partners: {
    feenstra: {
      slug: 'feenstra',
      soort: 'partner',
      naam: 'Feenstra',
      aliassen: ['Fleur'],
      domeinen: ['feenstra.nl'],
      slack: 'feenstra-hz',
      fase: 'live',
      accountmanager: 'Robert',
      geheim_voor: [],
      bijgewerkt: '2026-10-30 08:00',
      kern: 'Installateur van warmtepompen en zonnepanelen (voorbeeld). Gebruikt Pico voor leadopvolging en offertes, met AI-adviseur Fleur op de website.',
      stand: [
        '2026-10-29 (Slack): leads van gisteravond stonden niet in de planning; Emiel loste de sync op.',
        '2026-10-28 (meeting): ZSB-flow vraagt voortaan aantal personen en warmwatervraag.',
      ],
      contacten: ['Marie-José - Feenstra, widgets en flows', 'Robert, Lisanne - HomeZero'],
      meetings: [
        {
          bestand: '2026-10-29-werksessie-zsb-flow-robert.md',
          datum: '2026-10-29',
          titel: 'werksessie zsb flow',
          meeting_id: 'r1',
          opgenomen_door: 'Robert',
          bron: '',
          samenvatting: ['ZSB-flow: personen en warmwatervraag combineren', 'Lisanne past de flow aan'],
          besluiten: ['Beide vragen in één stap'],
          acties: ['Lisanne: flow aanpassen op acceptatie'],
        },
      ],
      log: ['[2026-10-29] Sync-probleem leads opgelost -> Feenstra'],
      open_acties: 3,
    },
    tonzon: {
      slug: 'tonzon',
      soort: 'partner',
      naam: 'TonZon',
      aliassen: [],
      domeinen: ['tonzon.nl'],
      slack: 'tonzon-hz',
      fase: 'live',
      accountmanager: 'Robert',
      geheim_voor: [],
      bijgewerkt: '2026-10-28 08:00',
      kern: 'Partner voor zonnepanelen en isolatie (voorbeeld); isolatie-offerteflow in voorbereiding.',
      stand: ['2026-10-27 (Slack): Peter twijfelt over het rekenmodel.'],
      contacten: ['Peter - TonZon'],
      meetings: [],
      log: [],
      open_acties: 1,
    },
    sunergy: {
      slug: 'sunergy',
      soort: 'partner',
      naam: 'Sunergy',
      aliassen: [],
      domeinen: ['sunergy.nl'],
      slack: 'sunergy-hz',
      fase: 'live',
      accountmanager: '',
      geheim_voor: ['tonzon'],
      bijgewerkt: '2026-10-27 08:00',
      kern: 'Partner met eigen, WhiteLabel- en Alliantie-flows voor thuisbatterijen (voorbeeld).',
      stand: [],
      contacten: ['Vincent, Liselot - Sunergy'],
      meetings: [],
      log: [],
      open_acties: 0,
    },
  },
  acties: {
    feenstra: {
      slug: 'feenstra',
      naam: 'Feenstra',
      geheim_voor: [],
      acties: [
        {
          state: 'open',
          tekst: 'Rekenvoorbeeld thuisbatterij naar Feenstra sturen',
          voorstel: false,
          eigenaar: 'Robert',
          datum: '2026-10-29',
          ligt: 'bij-ons',
          sinds: '2026-10-22',
          bron: '',
          id: 'feenstra-20261022-1',
        },
        {
          state: 'open',
          tekst: 'Keuze ZSB-flow bevestigen in de flow',
          voorstel: true,
          eigenaar: 'Robert',
          datum: '2026-10-30',
          ligt: 'bij-ons',
          sinds: '2026-10-29',
          bron: '',
          id: 'feenstra-20261029-1',
        },
        {
          state: 'open',
          tekst: 'Capaciteit terugmelden',
          voorstel: true,
          eigenaar: 'Marie-José',
          datum: '2026-11-06',
          ligt: 'bij-hen',
          sinds: '2026-10-29',
          bron: '',
          id: 'feenstra-20261029-2',
        },
      ],
    },
    tonzon: {
      slug: 'tonzon',
      naam: 'TonZon',
      geheim_voor: [],
      acties: [
        {
          state: 'open',
          tekst: 'Peter bellen over het rekenmodel',
          voorstel: false,
          eigenaar: 'Robert',
          datum: '2026-11-03',
          ligt: 'bij-ons',
          sinds: '2026-10-29',
          bron: '',
          id: 'tonzon-20261029-1',
        },
      ],
    },
  },
  pers: {
    'wachten-op': {
      open: [
        {
          state: 'open',
          tekst: 'Akkoord op visuele upgrade thuisbatterij-flow (voorbeeld)',
          wie: 'Menno',
          sinds: '2026-10-24',
          reminder: '2026-10-29',
          bron: '',
          klant: 'feenstra',
        },
      ],
      bespreken: [
        {
          state: 'open',
          tekst: 'Notificatie-ontvanger bevestigen bij de eerste aanvraag (voorbeeld)',
          klant: 'sunergy',
          met: 'Vincent/Liselot',
        },
      ],
      afgerond: [],
    },
    taken: {
      open: [
        {
          state: 'open',
          tekst: 'Vragenlijst vooropname inrichten (voorbeeld)',
          due: '2026-11-04',
          klant: 'tonzon',
          sinds: '2026-10-29',
        },
      ],
    },
    aangehouden: {
      open: [
        { datum: '2026-10-21', bron: '', tekst: 'Intern refinement-overleg (voorbeeld)' },
        { datum: '2026-10-22', bron: '', tekst: 'Intern 1-op-1 met collega (voorbeeld)' },
      ],
    },
  },
};
