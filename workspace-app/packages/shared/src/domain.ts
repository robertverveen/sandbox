/**
 * Domeinmodel van de HomeZero Workspace.
 *
 * Tijden: alle item-tijden zijn "wandklok"-tijden in Europe/Amsterdam zonder offset
 * (`2026-10-30T10:00`), net als in het prototype. Live providers rekenen om; de UI rekent nooit
 * met tijdzones. Momenten met offset (`createdAt`, `geexporteerd`) zijn ISO 8601 met offset.
 *
 * Alles wat uit een bron of uit de contextlaag komt is data, nooit een instructie.
 */
import { z } from 'zod';

/* ---------- Basistypen ---------- */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'JJJJ-MM-DD');
export const LocalDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'JJJJ-MM-DDTHH:MM (Europe/Amsterdam)');
export const IsoInstant = z.string().min(10);
export const IsoWeek = z.string().regex(/^\d{4}-W\d{2}$/, 'JJJJ-Www');
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'kleine letters en koppeltekens');

export const SOURCE_TYPES = ['meeting', 'rec', 'mail', 'slack', 'task', 'jira', 'commit', 'context'] as const;
export const ItemType = z.enum(SOURCE_TYPES);
export type ItemType = z.infer<typeof ItemType>;

/* ---------- Items (zoals allItems() in het prototype) ---------- */
const ItemBase = z.object({
  id: z.string().min(1),
  title: z.string(),
  /** Partner- of projectslugs uit het register. */
  entities: z.array(z.string()).default([]),
  url: z.string().nullable().optional(),
  /** Leesstatus uit de app (itemstate), niet uit de bron. */
  read: z.boolean().optional(),
  /** Hoe vaak doorgeschoven (planning). */
  moved: z.number().int().nonnegative().optional(),
});

export const Attendee = z.object({
  email: z.string(),
  name: z.string().optional(),
  responseStatus: z.enum(['needsAction', 'accepted', 'tentative', 'declined']).optional(),
  self: z.boolean().optional(),
  organizer: z.boolean().optional(),
});
export type Attendee = z.infer<typeof Attendee>;

export const MeetingItem = ItemBase.extend({
  type: z.literal('meeting'),
  start: LocalDateTime,
  end: LocalDateTime,
  allDay: z.boolean().optional(),
  calId: z.string().optional(),
  calName: z.string().optional(),
  attendeeNames: z.array(z.string()).default([]),
  attendees: z.array(Attendee).optional(),
  where: z.string().optional(),
  meet: z.string().optional(),
  external: z.boolean().optional(),
  needsAction: z.boolean().optional(),
  organizerName: z.string().optional(),
  ooo: z.boolean().optional(),
  /** Alleen in Agenda tonen (privé-agenda's, Lou, collega's). */
  agendaOnly: z.boolean().optional(),
  evColor: z.string().optional(),
  prepTask: z.string().nullable().optional(),
  skipPrep: z.boolean().optional(),
});
export type MeetingItem = z.infer<typeof MeetingItem>;

export const RecItem = ItemBase.extend({
  type: z.literal('rec'),
  rawId: z.string(),
  start: LocalDateTime,
  end: LocalDateTime,
  attendeeNames: z.array(z.string()).default([]),
  transcript: z.boolean().optional(),
  processed: z.boolean().optional(),
  recapDone: z.boolean().optional(),
  recapSession: z.string().optional(),
});
export type RecItem = z.infer<typeof RecItem>;

export const MailItem = ItemBase.extend({
  type: z.literal('mail'),
  threadId: z.string().optional(),
  fromName: z.string(),
  from: z.string().optional(),
  time: LocalDateTime,
  unread: z.boolean().optional(),
  /** Aan mij gericht (niet alleen cc). */
  direct: z.boolean().optional(),
  body: z.string().optional(),
  count: z.number().int().optional(),
});
export type MailItem = z.infer<typeof MailItem>;

export const SlackItem = ItemBase.extend({
  type: z.literal('slack'),
  channel: z.string(),
  channelId: z.string().optional(),
  ts: z.string().optional(),
  fromName: z.string(),
  fromId: z.string().optional(),
  time: LocalDateTime,
  mention: z.boolean().optional(),
  dm: z.boolean().optional(),
  fromMe: z.boolean().optional(),
  answered: z.boolean().optional(),
  answeredBy: z.string().optional(),
  bot: z.boolean().optional(),
  /** Door jou gemarkeerd als to-do (📣). */
  mega: z.boolean().optional(),
  body: z.string().optional(),
});
export type SlackItem = z.infer<typeof SlackItem>;

export const TaskItem = ItemBase.extend({
  type: z.literal('task'),
  rawId: z.string(),
  tasklist: z.string(),
  tasklistTitle: z.string().optional(),
  due: IsoDate.nullable().optional(),
  notes: z.string().optional(),
  status: z.enum(['needsAction', 'completed']).default('needsAction'),
  backlog: z.boolean().optional(),
  weekgoal: z.boolean().optional(),
  prep: z.boolean().optional(),
  overdue: z.boolean().optional(),
});
export type TaskItem = z.infer<typeof TaskItem>;

export const JiraSprint = z.object({
  id: z.number().int().optional(),
  name: z.string(),
  state: z.string().optional(),
  startDate: IsoInstant,
  endDate: IsoInstant,
  goal: z.string().optional(),
});
export type JiraSprint = z.infer<typeof JiraSprint>;

export const JiraItem = ItemBase.extend({
  type: z.literal('jira'),
  key: z.string(),
  status: z.string(),
  cat: z.enum(['new', 'indeterminate', 'done']),
  assignee: z.string(),
  sp: z.number().nonnegative(),
  sprint: JiraSprint.nullable(),
  /** Robert is Tester op deze story. */
  mine: z.boolean(),
  /** Herkomst (keuze 08): uit de contextlaag (product/jira/, met stand-datum) of live uit Jira. */
  source: z.enum(['laag', 'live']).optional(),
  /** Stand-datum (laag) of laatste wijziging (live). */
  asOf: z.string().optional(),
});
export type JiraItem = z.infer<typeof JiraItem>;

export const Stroom = z.enum(['mijn', 'aan_mij', 'voornemen', 'bespreken', 'weekdoel', 'roadmap']);
export type Stroom = z.infer<typeof Stroom>;
export const CommitStatus = z.enum(['open', 'waarschijnlijk_klaar', 'klaar', 'te_laat', 'overgedragen', 'losgelaten']);
export type CommitStatus = z.infer<typeof CommitStatus>;
export const Health = z.enum(['groen', 'oranje', 'rood', 'af']);
export type Health = z.infer<typeof Health>;

/** Tracker-item (weekdoel, roadmap, wachtrij-item) zoals commitItems() in het prototype. */
export const CommitItem = ItemBase.extend({
  type: z.literal('commit'),
  docId: z.string(),
  stroom: Stroom,
  status: CommitStatus,
  aan: z.string().optional(),
  deadline: IsoDate.nullable().optional(),
  plan: IsoDate.nullable().optional(),
  /** plan of deadline, voor sorteren (zoals in het prototype). */
  due: IsoDate.nullable().optional(),
  reminder: IsoDate.nullable().optional(),
  backlog: z.boolean().optional(),
  week: IsoWeek.optional(),
  health: Health.optional(),
  time: LocalDateTime.nullable().optional(),
  body: z.string().optional(),
  linkedTask: z.string().optional(),
});
export type CommitItem = z.infer<typeof CommitItem>;

export const ContextItem = ItemBase.extend({
  type: z.literal('context'),
  path: z.string().optional(),
  time: LocalDateTime.optional(),
  body: z.string().optional(),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const Item = z.discriminatedUnion('type', [
  MeetingItem,
  RecItem,
  MailItem,
  SlackItem,
  TaskItem,
  JiraItem,
  CommitItem,
  ContextItem,
]);
export type Item = z.infer<typeof Item>;

/* ---------- Gesprekken ---------- */
export const ConversationKind = z.enum(['ch', 'dm', 'group', 'mail']);
export const Conversation = z.object({
  /** `sl:<kanaal-id>` of `ml:<thread-id>`. */
  key: z.string().regex(/^(sl|ml):.+/),
  kind: ConversationKind,
  name: z.string(),
  purpose: z.string().optional(),
  unread: z.boolean().default(false),
  time: LocalDateTime.optional(),
  preview: z.string().optional(),
  entities: z.array(z.string()).default([]),
});
export type Conversation = z.infer<typeof Conversation>;

export const Reaction = z.object({
  name: z.string(),
  count: z.number().int().positive(),
  mine: z.boolean().optional(),
});
export const Message = z.object({
  ts: z.string(),
  time: LocalDateTime,
  fromName: z.string(),
  fromId: z.string(),
  me: z.boolean(),
  bot: z.boolean(),
  text: z.string(),
  replies: z.number().int().nonnegative().default(0),
  latest: z.string().optional(),
  files: z.array(z.string()).default([]),
  reactions: z.array(Reaction).default([]),
});
export type Message = z.infer<typeof Message>;

export const MailMessage = z.object({
  fromName: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).default([]),
  time: LocalDateTime,
  body: z.string(),
  quoted: z.string().default(''),
  files: z.array(z.string()).default([]),
  unread: z.boolean().optional(),
});
export type MailMessage = z.infer<typeof MailMessage>;

export const Thread = z.object({ key: z.string(), rootTs: z.string(), messages: z.array(Message) });
export type Thread = z.infer<typeof Thread>;

export const ConversationDetail = z.object({
  conversation: Conversation,
  messages: z.array(Message).default([]),
  mail: z
    .object({ subject: z.string(), url: z.string().nullable(), msgs: z.array(MailMessage) })
    .nullable()
    .default(null),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

/* ---------- Contextlaag ---------- */
export const Fase = z.enum(['prospect', 'implementatie', 'live', 'sluimerend', 'gestopt', '']);

/** Regel uit `partners/_register.md`. */
export const RegisterRow = z.object({
  slug: z.string(),
  naam: z.string(),
  aliassen: z.array(z.string()),
  domeinen: z.array(z.string()),
  slack: z.string(),
  portal: z.string(),
  fase: z.string(),
  accountmanager: z.string(),
});
export type RegisterRow = z.infer<typeof RegisterRow>;

export const MeetingSummary = z.object({
  bestand: z.string(),
  datum: z.string(),
  titel: z.string(),
  meeting_id: z.string(),
  opgenomen_door: z.string().default(''),
  bron: z.string().default(''),
  samenvatting: z.array(z.string()).default([]),
  besluiten: z.array(z.string()).default([]),
  acties: z.array(z.string()).default([]),
});
export type MeetingSummary = z.infer<typeof MeetingSummary>;

/** Partner of project (context_partners): register + brief.md + laatste meetings. Nooit admin.md. */
export const Partner = z.object({
  slug: z.string(),
  soort: z.enum(['partner', 'project']),
  naam: z.string(),
  aliassen: z.array(z.string()).default([]),
  domeinen: z.array(z.string()).default([]),
  slack: z.string().default(''),
  fase: z.string().default(''),
  accountmanager: z.string().default(''),
  /** Partner-slugs die deze inhoud nooit mogen zien (harde filter). */
  geheim_voor: z.array(z.string()).default([]),
  bijgewerkt: z.string().default(''),
  kern: z.string().default(''),
  stand: z.array(z.string()).default([]),
  contacten: z.array(z.string()).default([]),
  meetings: z.array(MeetingSummary).default([]),
  log: z.array(z.string()).default([]),
  open_acties: z.number().int().nonnegative().default(0),
});
export type Partner = z.infer<typeof Partner>;

export const ActieState = z.enum(['open', 'klaar', 'geschrapt']);
export type ActieState = z.infer<typeof ActieState>;

/**
 * Actieregel uit `acties.md` (zie `_systeem/schema.md`):
 * `- [ ] <resultaat> [eigenaar:: Naam] [datum:: JJJJ-MM-DD] (voorstel) [ligt:: bij-ons|bij-hen] [sinds:: JJJJ-MM-DD] [bron:: link] [id:: <slug>-JJJJMMDD-n]`
 */
export const Actie = z.object({
  state: ActieState,
  tekst: z.string(),
  voorstel: z.boolean().default(false),
  eigenaar: z.string().optional(),
  datum: z.string().optional(),
  ligt: z.string().optional(),
  sinds: z.string().optional(),
  bron: z.string().optional(),
  id: z.string().optional(),
  klaar: z.string().optional(),
  geschrapt: z.string().optional(),
  strijd: z.string().optional(),
});
export type Actie = z.infer<typeof Actie>;

export const PartnerActies = z.object({
  slug: z.string(),
  naam: z.string(),
  geheim_voor: z.array(z.string()).default([]),
  acties: z.array(Actie),
});
export type PartnerActies = z.infer<typeof PartnerActies>;

/** Regel uit `wachten-op.md` (Persoonlijk-repo): `[wie::] [sinds::] [reminder::] [bron::] [klant::]`. */
export const WachtenOp = z.object({
  state: ActieState,
  tekst: z.string(),
  voorstel: z.boolean().optional(),
  wie: z.string().optional(),
  sinds: z.string().optional(),
  reminder: z.string().optional(),
  bron: z.string().optional(),
  klant: z.string().optional(),
  klaar: z.string().optional(),
});
export type WachtenOp = z.infer<typeof WachtenOp>;

/** Regel onder "Bespreken bij eerstvolgend contactmoment": `[klant::] [met::]`. */
export const Bespreken = z.object({
  state: ActieState,
  tekst: z.string(),
  voorstel: z.boolean().optional(),
  klant: z.string().optional(),
  met: z.string().optional(),
  klaar: z.string().optional(),
});
export type Bespreken = z.infer<typeof Bespreken>;

/** Regel uit `taken.md`: `- [ ] taak [due::] [klant::] [sinds::]`. */
export const Taak = z.object({
  state: ActieState,
  tekst: z.string(),
  voorstel: z.boolean().optional(),
  due: z.string().optional(),
  klant: z.string().optional(),
  sinds: z.string().optional(),
});
export type Taak = z.infer<typeof Taak>;

/** Regel uit `aangehouden.md`: `- datum | bron | wat | vraag`. */
export const Aangehouden = z.object({ datum: z.string(), bron: z.string(), tekst: z.string() });
export type Aangehouden = z.infer<typeof Aangehouden>;

export const Persoonlijk = z.object({
  'wachten-op': z.object({
    open: z.array(WachtenOp).default([]),
    bespreken: z.array(Bespreken).default([]),
    afgerond: z.array(WachtenOp).default([]),
  }),
  taken: z.object({ open: z.array(Taak).default([]) }),
  aangehouden: z.object({ open: z.array(Aangehouden).default([]) }),
});
export type Persoonlijk = z.infer<typeof Persoonlijk>;

export const ContextStatus = z.object({
  status: z.string().default(''),
  nachtdienst: z.string().default(''),
  nacht_prive: z.string().optional(),
  commit_context: z.string().default(''),
  commit_prive: z.string().optional(),
  geexporteerd: z.string().default(''),
  partners: z.number().int().nonnegative().default(0),
  acties: z.number().int().nonnegative().optional(),
});
export type ContextStatus = z.infer<typeof ContextStatus>;

/** De hele contextlaag zoals de app hem leest (index of export). */
export const ContextSnapshot = z.object({
  status: ContextStatus.nullable(),
  partners: z.record(z.string(), Partner),
  acties: z.record(z.string(), PartnerActies),
  /** null = de collega heeft (nog) geen Persoonlijk-repo. */
  pers: Persoonlijk.nullable(),
});
export type ContextSnapshot = z.infer<typeof ContextSnapshot>;

/* ---------- App-eigen data ---------- */
export const BriefingSection = z.object({
  title: z.string(),
  items: z.array(z.object({ text: z.string(), url: z.string().optional() })),
});
export const Briefing = z.object({
  id: z.string().optional(),
  date: IsoDate,
  title: z.string(),
  createdAt: IsoInstant,
  session: z.string().nullable().optional(),
  sections: z.array(BriefingSection),
});
export type Briefing = z.infer<typeof Briefing>;

export const WeekdoelCheck = z.object({ d: IsoDate, h: Health, note: z.string().optional() });
export const Weekdoel = z.object({
  id: z.string(),
  wat: z.string(),
  /** weekdoel of roadmap-doel */
  soort: z.enum(['weekdoel', 'roadmap']).default('weekdoel'),
  week: IsoWeek.optional(),
  deadline: IsoDate.nullable().optional(),
  status: CommitStatus.default('open'),
  health: Health.optional(),
  outcome: z.enum(['gehaald', 'meegenomen', 'doorgeschoven', 'losgelaten']).optional(),
  lastCheck: IsoDate.optional(),
  checks: z.array(WeekdoelCheck).default([]),
  closedAt: IsoDate.optional(),
  bron: z.object({ label: z.string(), url: z.string().optional() }).optional(),
  created: IsoDate.optional(),
});
export type Weekdoel = z.infer<typeof Weekdoel>;

export const ProviderName = z.enum(['google_tasks', 'calendar', 'gmail', 'slack', 'jira', 'github', 'wispr']);
export type ProviderName = z.infer<typeof ProviderName>;

export const Connection = z.object({
  provider: ProviderName,
  status: z.enum(['connected', 'disconnected', 'error', 'needs_reauth']),
  scopes: z.array(z.string()).default([]),
  account: z.string().optional(),
  connectedAt: IsoInstant.optional(),
  lastSyncAt: IsoInstant.optional(),
  error: z.string().optional(),
  /** Fixture- of live-implementatie achter de provider. */
  mode: z.enum(['fixture', 'live']),
});
export type Connection = z.infer<typeof Connection>;

export const User = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.enum(['admin', 'member']),
  blocked: z.boolean().default(false),
});
export type User = z.infer<typeof User>;

export const CalendarInfo = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean().optional(),
  color: z.string().optional(),
  /** werk, collega, privé, gedeeld */
  group: z.string().optional(),
  /** "overal" of "alleen in Agenda". */
  scope: z.enum(['overal', 'agenda']).default('overal'),
  on: z.boolean().default(true),
});
export type CalendarInfo = z.infer<typeof CalendarInfo>;

export const ItemState = z.object({
  key: z.string(),
  read: z.boolean().optional(),
  processed: z.boolean().optional(),
  skipPrep: z.boolean().optional(),
  plan: IsoDate.nullable().optional(),
  backlog: z.boolean().optional(),
  moved: z.number().int().nonnegative().optional(),
  answeredBy: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type ItemState = z.infer<typeof ItemState>;

export const TaskList = z.object({ id: z.string(), title: z.string() });
export type TaskList = z.infer<typeof TaskList>;

/* ---------- Schrijven naar de contextlaag (wachtrij per repo) ---------- */

/**
 * Wat een collega vanuit de app naar een repo schrijft. De API maakt er een regel van volgens
 * `_systeem/schema.md` (partneractie, meeting) of de kop van `wachten-op.md` (wachten op, bespreken)
 * en zet die in de wachtrij; de schrijfjob van het context-stuk pusht met contextcheck.
 */
const RegelTekst = z
  .string()
  .trim()
  .min(1)
  .max(300, 'Eén feit per regel, max. 300 tekens')
  .refine((s) => !/[[\]\n\r]/.test(s), 'Geen [ ] of regeleinde in de tekst');
const VeldWaarde = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[[\]\n\r]/.test(s), 'Geen [ ] of regeleinde');

export const RepoWriteKind = z.enum(['wachten-op', 'bespreken', 'partneractie', 'meeting']);
export type RepoWriteKind = z.infer<typeof RepoWriteKind>;

export const RepoWrite = z.discriminatedUnion('kind', [
  /** Inhalen `w`: naar `wachten-op.md` onder "## Open" (Persoonlijk-repo). */
  z.object({
    kind: z.literal('wachten-op'),
    tekst: RegelTekst,
    wie: VeldWaarde,
    sinds: IsoDate.optional(),
    /** Standaard sinds + 3 werkdagen. */
    reminder: IsoDate.optional(),
    bron: VeldWaarde.optional(),
    klant: Slug.optional(),
    /** Item waar het uit komt (wordt dan als verwerkt gemarkeerd). */
    itemKey: z.string().optional(),
  }),
  /** Inhalen `b`: naar `wachten-op.md` onder "## Bespreken bij eerstvolgend contactmoment". */
  z.object({
    kind: z.literal('bespreken'),
    tekst: RegelTekst,
    klant: Slug,
    met: VeldWaarde.optional(),
    itemKey: z.string().optional(),
  }),
  /** Partneractie in `partners/<slug>/acties.md` (HomeZero Context), actieregel uit het schema. */
  z.object({
    kind: z.literal('partneractie'),
    slug: Slug,
    tekst: RegelTekst,
    eigenaar: VeldWaarde,
    /** bij-ons: wanneer af; bij-hen: wanneer nudgen (standaard sinds + 7 werkdagen). */
    datum: IsoDate.optional(),
    /** `(voorstel)` zolang de eigenaar de datum niet bevestigde. */
    voorstel: z.boolean().default(true),
    ligt: z.enum(['bij-ons', 'bij-hen']),
    sinds: IsoDate.optional(),
    bron: VeldWaarde,
    itemKey: z.string().optional(),
  }),
  /** Meeting als nieuw bestand `partners/<slug>/meetings/JJJJ-MM-DD-onderwerp-opnemer.md`. */
  z.object({
    kind: z.literal('meeting'),
    slug: Slug,
    meetingId: VeldWaarde,
    datum: IsoDate,
    onderwerp: z.string().trim().min(1).max(80),
    partners: z.array(Slug).min(1),
    label: z.enum(['bestaande-klant', 'leverancier', 'prospect', 'intern']),
    opgenomenDoor: VeldWaarde,
    sprekersBetrouwbaar: z.boolean().default(false),
    bron: VeldWaarde,
    samenvatting: z.array(RegelTekst).max(15).default([]),
    besluiten: z.array(RegelTekst).max(15).default([]),
    acties: z.array(RegelTekst).max(15).default([]),
    itemKey: z.string().optional(),
  }),
]);
export type RepoWrite = z.infer<typeof RepoWrite>;
export type RepoWriteInput = z.input<typeof RepoWrite>;

export const RepoQueueStatus = z.enum(['queued', 'pushed', 'blocked', 'failed']);
export type RepoQueueStatus = z.infer<typeof RepoQueueStatus>;

export const RepoQueueEntry = z.object({
  id: z.string(),
  kind: RepoWriteKind,
  repo: z.enum(['context', 'persoonlijk']),
  path: z.string(),
  op: z.enum(['append', 'check', 'uncheck', 'strike', 'new-file']),
  /** De regel (of bij een meeting de hele bestandsinhoud) zoals hij in de repo komt. */
  line: z.string(),
  slug: z.string().nullable(),
  status: RepoQueueStatus,
  commitSha: z.string().nullable().optional(),
  /** Exitcode van `contextcheck.py --push` (1 of 2 = niet gepusht). */
  checkExit: z.number().int().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: IsoInstant,
  processedAt: IsoInstant.nullable().optional(),
});
export type RepoQueueEntry = z.infer<typeof RepoQueueEntry>;

/* ---------- Vastgezette zoekopdrachten en views, voorkeuren ---------- */

export const Pin = z.object({
  id: z.string(),
  kind: z.enum(['search', 'view']),
  label: z.string().min(1).max(80),
  /** Zoekopdracht met komma-verfijning (kind=search). */
  q: z.string().nullable().optional(),
  /** Route van een view, bv. `/tracker?tab=wachten` (kind=view). */
  view: z.string().nullable().optional(),
  position: z.number().int().default(0),
  createdAt: IsoInstant,
});
export type Pin = z.infer<typeof Pin>;

export const NewPin = z
  .object({
    kind: z.enum(['search', 'view']),
    label: z.string().trim().min(1).max(80),
    q: z.string().trim().min(1).max(300).optional(),
    view: z
      .string()
      .regex(/^\/[a-z0-9/_?=&%,.-]*$/i, 'Een route binnen de app, bv. /tracker?tab=wachten')
      .optional(),
  })
  .refine((p) => (p.kind === 'search' ? !!p.q : !!p.view), 'Zoekopdracht vraagt q, view vraagt view');
export type NewPin = z.infer<typeof NewPin>;

export const CalendarPref = z.object({
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  /** "overal" (ook Dagstart en Planning) of "alleen in Agenda". */
  scope: z.enum(['overal', 'agenda']).optional(),
  hidden: z.boolean().optional(),
});
export type CalendarPref = z.infer<typeof CalendarPref>;

export const Preferences = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  calendars: z.record(z.string(), CalendarPref).default({}),
});
export type Preferences = z.infer<typeof Preferences>;

/* ---------- Agenda: vrije tijden en afspraak maken (HZW-030) ---------- */

export const BusyBlock = z.object({ start: LocalDateTime, end: LocalDateTime });
export type BusyBlock = z.infer<typeof BusyBlock>;

export const FreeBusy = z.object({
  /** Per collega de bezette blokken (Google freeBusy; geen titels). */
  people: z.array(
    z.object({
      email: z.string(),
      name: z.string().optional(),
      busy: z.array(BusyBlock),
      error: z.string().optional(),
    }),
  ),
  /** Tijden waarop iedereen kan, binnen werktijd (09:00–17:30, ma–vr), in Europe/Amsterdam. */
  free: z.array(BusyBlock),
  duration: z.number().int().positive(),
});
export type FreeBusy = z.infer<typeof FreeBusy>;

export const NewEvent = z
  .object({
    title: z.string().trim().min(1).max(200),
    start: LocalDateTime,
    end: LocalDateTime,
    attendees: z.array(z.string().email()).max(50).default([]),
    description: z.string().max(8000).optional(),
    location: z.string().max(300).optional(),
    calendarId: z.string().optional(),
    /** Google Meet-link erbij. */
    meet: z.boolean().default(false),
  })
  .refine((e) => e.end > e.start, 'Einde moet na begin liggen');
export type NewEvent = z.infer<typeof NewEvent>;
export type NewEventInput = z.input<typeof NewEvent>;
