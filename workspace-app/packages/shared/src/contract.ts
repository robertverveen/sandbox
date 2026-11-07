/**
 * API-contract: alle routes die de schermen nodig hebben, met zod-schema's voor params, query,
 * body en antwoord. De API valideert hiertegen (tests lopen alle GET-routes langs) en de web-app
 * leidt er zijn types van af. Eén bron, geen dubbele definities.
 */
import { z } from 'zod';
import {
  Briefing,
  CalendarInfo,
  CalendarPref,
  FreeBusy,
  NewEvent,
  NewPin,
  Pin,
  Preferences,
  RepoQueueEntry,
  RepoQueueStatus,
  RepoWrite,
  Connection,
  ContextSnapshot,
  ContextStatus,
  Conversation,
  ConversationDetail,
  IsoDate,
  IsoWeek,
  Item,
  ItemState,
  JiraItem,
  JiraSprint,
  MeetingItem,
  Partner,
  PartnerActies,
  ProviderName,
  TaskItem,
  TaskList,
  Thread,
  User,
  Weekdoel,
} from './domain';
import {
  AllowlistEntry,
  AuthConfig,
  ConnectionDetail,
  DisconnectResult,
  Member,
  OnboardingPatch,
  OnboardingState,
  OwnGoogleClient,
  PersRepoStatus,
  SessionRow,
} from './auth';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteDef<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  path: string;
  /** Leesbare uitleg; ook voor de MCP-server later. */
  doc: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** false = bereikbaar zonder sessie (health, inloggen). */
  auth?: boolean;
  /** Stuk dat de route verder afmaakt; leeg = af in het fundament. */
  owner?: string;
}

/** Behoudt het letterlijke type van elke route (welke velden er wel en niet zijn). */
const def = <const D extends RouteDef>(d: D) => d;

export const Ok = z.object({ ok: z.literal(true) });
export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const Mode = z.enum(['fixture', 'live']);

export const SessionInfo = z.object({
  user: User,
  /** Klok van de server (wandklok Amsterdam). In fixture-modus vast, zodat schermen reproduceerbaar zijn. */
  now: z.string(),
  mode: Mode,
  /** Welke dataset de fixtures leveren (demo = prototype-demodata, harness = lat met echte context). */
  fixtureSet: z.string().optional(),
  contextSource: z.enum(['fixture', 'export', 'repo']),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/**
 * Stand per bron in een antwoord dat meerdere bronnen samenvoegt (stuk E3). Een bron die voor deze collega niet
 * gekoppeld is (of opnieuw gekoppeld moet worden) komt leeg terug in plaats van de hele route te laten vallen.
 */
export const SourceStatus = z.object({
  provider: ProviderName,
  status: z.enum(['ok', 'niet gekoppeld', 'opnieuw koppelen', 'fout']),
  message: z.string().optional(),
});
export type SourceStatus = z.infer<typeof SourceStatus>;
const withSources = <T extends z.ZodRawShape>(o: z.ZodObject<T>) =>
  o.extend({ sources: z.array(SourceStatus).optional() });

export const SprintInfo = z.object({ sprint: JiraSprint.nullable(), issues: z.array(JiraItem) });
export type SprintInfo = z.infer<typeof SprintInfo>;

export const DagstartResponse = z.object({
  now: z.string(),
  items: z.array(Item),
  briefing: Briefing.nullable(),
  sprint: SprintInfo,
  weekdoelen: z.array(Weekdoel),
  context: ContextSnapshot,
  /** Aantal gesprekken om in te halen (Inhalen). */
  catchCount: z.number().int().nonnegative(),
  /** Bronnen met een probleem (koppeling verlopen e.d.). */
  sourceErrors: z.array(z.object({ provider: ProviderName, message: z.string() })),
  /** Keuzes in de app (sleutels als `_taak-…`, `_aang-…`, `_nudge-repo`) met hun waarde. */
  decided: z.record(z.string(), z.unknown()).default({}),
});
export type DagstartResponse = z.infer<typeof DagstartResponse>;

export const TrackerResponse = z.object({
  hasPersRepo: z.boolean(),
  taken: z.array(TaskItem),
  takenMd: ContextSnapshot.shape.pers,
  partneracties: z.array(PartnerActies),
  weekdoelen: z.array(Weekdoel),
});
export type TrackerResponse = z.infer<typeof TrackerResponse>;

export const PartnerDetail = z.object({
  partner: Partner,
  acties: PartnerActies.nullable(),
  items: z.array(Item),
});
export type PartnerDetail = z.infer<typeof PartnerDetail>;

export const SearchResponse = z.object({
  q: z.string(),
  entities: z.array(z.string()),
  keywords: z.array(z.string()),
  mode: z.enum(['list', 'timeline', 'gantt']),
  items: z.array(Item),
  conversations: z.array(Conversation),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const AskResponse = z.object({
  answer: z.string(),
  sources: z.array(z.object({ label: z.string(), url: z.string().optional(), date: z.string().optional() })),
  model: z.string(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
});

const KeyParam = z.object({ key: z.string().min(1) });
const IdParam = z.object({ id: z.string().min(1) });
const SlugParam = z.object({ slug: z.string().min(1) });
const ProviderParam = z.object({ provider: ProviderName });
const RangeQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional() });

/** Sync-stand van één bron (HZW-036). */
export const SyncJob = z.object({
  provider: z.string(),
  status: z.enum(['idle', 'running', 'backoff', 'error', 'needs_reauth', 'disconnected']),
  failures: z.number().int().nonnegative(),
  nextRunAt: z.string(),
  lastOkAt: z.string().nullable(),
  lastChanged: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  push: z.boolean(),
});
export type SyncJob = z.infer<typeof SyncJob>;

export const routes = {
  health: def({
    method: 'GET',
    path: '/api/health',
    doc: 'Health-check voor proxy en CI.',
    response: z.object({ ok: z.literal(true), version: z.string(), mode: Mode, db: z.enum(['ok', 'off', 'error']) }),
    auth: false,
  }),
  session: def({
    method: 'GET',
    path: '/api/session',
    doc: 'Wie is ingelogd, de serverklok en de modus.',
    response: SessionInfo,
  }),
  devLogin: def({
    method: 'POST',
    path: '/api/auth/dev-login',
    doc: 'Alleen in ontwikkeling: inloggen als vaste testgebruiker tot het auth-stuk er is.',
    body: z.object({ email: z.string().email().optional() }),
    response: SessionInfo,
    auth: false,
    owner: 'auth',
  }),
  logout: def({
    method: 'POST',
    path: '/api/auth/logout',
    doc: 'Uitloggen (sessie intrekken).',
    response: Ok,
    owner: 'auth',
  }),
  items: def({
    method: 'GET',
    path: '/api/items',
    doc: 'Alle items (agenda, mail, Slack, taken, opnames, Jira, tracker) zoals allItems() in het prototype.',
    query: RangeQuery,
    response: z.object({ now: z.string(), items: z.array(Item) }),
  }),
  dagstart: def({
    method: 'GET',
    path: '/api/dagstart',
    doc: 'Alles voor Dagstart in één antwoord.',
    response: DagstartResponse,
  }),
  itemState: def({
    method: 'PUT',
    path: '/api/itemstate/:key',
    doc: 'Leesstatus, planning en verwerkt-vlag van één item (alleen in de app).',
    params: KeyParam,
    body: ItemState.omit({ key: true }),
    response: ItemState,
    owner: 'planning',
  }),
  agenda: def({
    method: 'GET',
    path: '/api/agenda',
    doc: "Alle agenda's en afspraken in een periode (Europe/Amsterdam).",
    query: RangeQuery,
    response: z.object({ calendars: z.array(CalendarInfo), events: z.array(MeetingItem) }),
    owner: 'agenda',
  }),
  freeBusy: def({
    method: 'GET',
    path: '/api/agenda/freebusy',
    doc: "Vrije tijden met collega's: bezette blokken per persoon en de tijden waarop iedereen kan (werktijd, ma–vr).",
    query: z.object({
      /** Komma-gescheiden e-mailadressen; jezelf telt altijd mee. */
      people: z.string().min(3),
      from: IsoDate,
      to: IsoDate,
      duration: z.coerce.number().int().min(15).max(480).default(30),
    }),
    response: FreeBusy,
    owner: 'agenda',
  }),
  createEvent: def({
    method: 'POST',
    path: '/api/agenda/events',
    doc: 'Afspraak maken (na een klik van een mens; Google stuurt de uitnodigingen, de app niet).',
    body: NewEvent,
    response: MeetingItem,
    owner: 'agenda',
  }),
  rsvp: def({
    method: 'POST',
    path: '/api/agenda/events/:id/rsvp',
    doc: 'Reageren op een uitnodiging.',
    params: IdParam,
    body: z.object({ response: z.enum(['accepted', 'tentative', 'declined']) }),
    response: Ok,
    owner: 'agenda',
  }),
  tasks: def({
    method: 'GET',
    path: '/api/tasks',
    doc: 'Google Taken: lijsten en open taken.',
    response: withSources(z.object({ lists: z.array(TaskList), tasks: z.array(TaskItem) })),
    owner: 'planning',
  }),
  addTask: def({
    method: 'POST',
    path: '/api/tasks',
    doc: 'Taak toevoegen (snel toevoegen bij Vandaag en Morgen).',
    body: z.object({
      title: z.string().min(1).max(500),
      due: IsoDate.nullable().optional(),
      list: z.string().optional(),
    }),
    response: TaskItem,
    owner: 'planning',
  }),
  updateTask: def({
    method: 'PATCH',
    path: '/api/tasks/:id',
    doc: 'Taak verplaatsen of afvinken.',
    params: IdParam,
    body: z.object({
      due: IsoDate.nullable().optional(),
      done: z.boolean().optional(),
      backlog: z.boolean().optional(),
    }),
    response: TaskItem,
    owner: 'planning',
  }),
  sprint: def({
    method: 'GET',
    path: '/api/sprint',
    doc: 'Lopende sprint van HOM met storypoints en Tester-veld.',
    response: withSources(SprintInfo),
    owner: 'planning',
  }),
  tracker: def({
    method: 'GET',
    path: '/api/tracker',
    doc: 'Tracker: taken, wachten op, bespreken, partneracties (eigenaar), weekdoelen.',
    response: withSources(TrackerResponse),
    owner: 'tracker',
  }),
  weekdoelen: def({
    method: 'GET',
    path: '/api/weekdoelen',
    doc: 'Weekdoelen (en roadmapdoelen) van de ingelogde collega.',
    query: z.object({ week: IsoWeek.optional() }),
    response: z.object({ weekdoelen: z.array(Weekdoel) }),
    owner: 'tracker',
  }),
  addWeekdoel: def({
    method: 'POST',
    path: '/api/weekdoelen',
    doc: 'Weekdoel toevoegen.',
    body: z.object({ wat: z.string().min(1).max(300), week: IsoWeek, deadline: IsoDate.nullable().optional() }),
    response: Weekdoel,
    owner: 'tracker',
  }),
  updateWeekdoel: def({
    method: 'PATCH',
    path: '/api/weekdoelen/:id',
    doc: 'Weekdoel bijwerken (gezondheid, notitie, afsluiten).',
    params: IdParam,
    body: Weekdoel.pick({ health: true, status: true, outcome: true })
      .partial()
      .extend({ note: z.string().optional() }),
    response: Weekdoel,
    owner: 'tracker',
  }),
  conversations: def({
    method: 'GET',
    path: '/api/conversations',
    doc: "Kanalen, DM's en mailthreads.",
    response: withSources(z.object({ conversations: z.array(Conversation) })),
    owner: 'gesprekken',
  }),
  conversation: def({
    method: 'GET',
    path: '/api/conversations/:key',
    doc: 'Volledige geschiedenis van één gesprek.',
    params: KeyParam,
    response: ConversationDetail,
    owner: 'gesprekken',
  }),
  thread: def({
    method: 'GET',
    path: '/api/conversations/:key/threads/:ts',
    doc: 'Slack-thread.',
    params: z.object({ key: z.string(), ts: z.string() }),
    response: Thread,
    owner: 'gesprekken',
  }),
  markRead: def({
    method: 'POST',
    path: '/api/conversations/:key/read',
    doc:
      'Gelezen zetten, ook echt in Slack/Gmail (terug te draaien met read=false). Slack: ts = het gelezen bericht; ' +
      'de leescursor gaat tot dat bericht (nieuwere blijven ongelezen), read=false zet hem op het bericht ervoor. ' +
      'Zonder ts: het hele gesprek is gelezen (gesprek geopend).',
    params: KeyParam,
    body: z.object({
      read: z.boolean().default(true),
      ts: z
        .string()
        .regex(/^\d+\.\d+$/)
        .optional(),
    }),
    response: Ok,
    owner: 'gesprekken',
  }),
  sendMessage: def({
    method: 'POST',
    path: '/api/conversations/:key/messages',
    doc: 'Bericht versturen. Alleen na een klik van een mens; Claude maakt hooguit een concept.',
    params: KeyParam,
    body: z.object({
      text: z.string().min(1).max(40000),
      replyAll: z.boolean().optional(),
      threadTs: z.string().optional(),
    }),
    response: z.object({ ok: z.literal(true), ts: z.string() }),
    owner: 'gesprekken',
  }),
  react: def({
    method: 'POST',
    path: '/api/conversations/:key/reactions',
    doc: 'Emoji-reactie op een Slack-bericht.',
    params: KeyParam,
    body: z.object({ ts: z.string(), name: z.string() }),
    response: Ok,
    owner: 'gesprekken',
  }),
  partners: def({
    method: 'GET',
    path: '/api/partners',
    doc: 'Organisaties uit het register (met aliassen, domeinen, kanaal).',
    response: z.object({ partners: z.array(Partner) }),
    owner: 'context',
  }),
  partner: def({
    method: 'GET',
    path: '/api/partners/:slug',
    doc: 'Partnerpagina: Kern, Stand, contacten, acties, meetings en items.',
    params: SlugParam,
    response: PartnerDetail,
    owner: 'context',
  }),
  contextStatus: def({
    method: 'GET',
    path: '/api/context/status',
    doc: 'Versheid van de contextlaag (_systeem/status.md).',
    response: z.object({ status: ContextStatus.nullable(), stale: z.boolean() }),
    owner: 'context',
  }),
  briefing: def({
    method: 'GET',
    path: '/api/briefing/latest',
    doc: 'Laatste ochtendbriefing (geschreven door de routine via de MCP-server).',
    response: z.object({ briefing: Briefing.nullable() }),
  }),
  search: def({
    method: 'GET',
    path: '/api/search',
    doc: "Zoeken met komma-verfijning, organisaties uit het register, kanalen en DM's.",
    query: z.object({ q: z.string().default('') }),
    response: withSources(SearchResponse),
    owner: 'zoeken',
  }),
  repoQueue: def({
    method: 'POST',
    path: '/api/repo/queue',
    doc:
      'Wegschrijven naar de contextlaag via de wachtrij: Inhalen w (wachten-op.md, Open), b (wachten-op.md, Bespreken), ' +
      'partneractie (partners/<slug>/acties.md) of meeting (partners/<slug>/meetings/…). De API maakt de regel volgens ' +
      '_systeem/schema.md en zet hem in de rij (status queued); de schrijfjob pusht met contextcheck.',
    body: RepoWrite,
    response: RepoQueueEntry,
    owner: 'context',
  }),
  repoQueueList: def({
    method: 'GET',
    path: '/api/repo/queue',
    doc: 'Eigen regels in de wachtrij met status (queued, pushed, blocked, failed).',
    query: z.object({ status: RepoQueueStatus.optional() }),
    response: z.object({ entries: z.array(RepoQueueEntry) }),
    owner: 'context',
  }),
  repoQueueEntry: def({
    method: 'GET',
    path: '/api/repo/queue/:id',
    doc: 'Status van één regel in de wachtrij (voor de melding "staat in de laag").',
    params: IdParam,
    response: RepoQueueEntry,
    owner: 'context',
  }),
  pins: def({
    method: 'GET',
    path: '/api/pins',
    doc: 'Vastgezette zoekopdrachten en views (palet, zijbalk).',
    response: z.object({ pins: z.array(Pin) }),
    owner: 'zoeken',
  }),
  addPin: def({
    method: 'POST',
    path: '/api/pins',
    doc: 'Zoekopdracht of view vastzetten.',
    body: NewPin,
    response: Pin,
    owner: 'zoeken',
  }),
  deletePin: def({
    method: 'DELETE',
    path: '/api/pins/:id',
    doc: 'Losmaken.',
    params: IdParam,
    response: Ok,
    owner: 'zoeken',
  }),
  preferences: def({
    method: 'GET',
    path: '/api/preferences',
    doc: "Voorkeuren: thema en per agenda kleur en 'overal' of 'alleen in Agenda'.",
    response: Preferences,
  }),
  updatePreferences: def({
    method: 'PATCH',
    path: '/api/preferences',
    doc: 'Voorkeuren bijwerken; agenda-instellingen worden per agenda samengevoegd.',
    body: z.object({
      theme: Preferences.shape.theme.unwrap().optional(),
      calendars: z.record(z.string(), CalendarPref).optional(),
    }),
    response: Preferences,
  }),
  connections: def({
    method: 'GET',
    path: '/api/connections',
    doc: 'Koppelingen per bron met status.',
    response: z.object({ connections: z.array(Connection) }),
    owner: 'koppelingen',
  }),
  connect: def({
    method: 'POST',
    path: '/api/connections/:provider/connect',
    doc: 'Koppeling starten (geeft de OAuth-URL terug).',
    params: ProviderParam,
    /** Stuk E1: waar de collega na de autorisatie terugkomt (wizard of instellingen); alleen een pad in de app. */
    body: z.object({ returnTo: z.string().max(300).optional() }),
    response: z.object({ redirect: z.string().nullable(), connection: Connection }),
    owner: 'koppelingen',
  }),
  disconnect: def({
    method: 'DELETE',
    path: '/api/connections/:provider',
    doc: 'Ontkoppelen: token intrekken en eigen data van die bron wissen.',
    params: ProviderParam,
    response: DisconnectResult,
    owner: 'koppelingen',
  }),
  /* ---------- Stuk E1: inloggen, sessies, teamleden, onboarding, koppelingen (HZW-010 t/m 014) ---------- */
  authConfig: def({
    method: 'GET',
    path: '/api/auth/config',
    doc: 'Welke inlogmanieren er zijn (Google, dev-login) en het toegestane domein. Openbaar.',
    response: AuthConfig,
    auth: false,
  }),
  sessions: def({
    method: 'GET',
    path: '/api/auth/sessions',
    doc: 'Eigen actieve sessies (apparaten), de huidige gemarkeerd.',
    response: z.object({ sessions: z.array(SessionRow) }),
  }),
  revokeSession: def({
    method: 'DELETE',
    path: '/api/auth/sessions/:id',
    doc: 'Eén eigen sessie (apparaat) uitloggen.',
    params: IdParam,
    response: Ok,
  }),
  logoutAll: def({
    method: 'POST',
    path: '/api/auth/logout-all',
    doc: 'Uitloggen op alle apparaten: alle eigen sessies intrekken.',
    response: z.object({ ok: z.literal(true), revoked: z.number().int().nonnegative() }),
  }),
  members: def({
    method: 'GET',
    path: '/api/admin/members',
    doc: 'Alleen beheerders: teamleden met rol, status en laatste activiteit, plus de uitnodigingslijst.',
    response: z.object({ members: z.array(Member), allowlist: z.array(AllowlistEntry) }),
  }),
  blockMember: def({
    method: 'POST',
    path: '/api/admin/members/:id/block',
    doc: 'Alleen beheerders: iemand blokkeren (alle sessies ingetrokken) of weer toelaten.',
    params: IdParam,
    body: z.object({ blocked: z.boolean() }),
    response: Member,
  }),
  addAllowlist: def({
    method: 'POST',
    path: '/api/admin/allowlist',
    doc: 'Alleen beheerders: een @homezero.nl-adres op de uitnodigingslijst zetten.',
    body: z.object({ email: z.string().email(), role: z.enum(['admin', 'member']).default('member') }),
    response: AllowlistEntry,
  }),
  removeAllowlist: def({
    method: 'DELETE',
    path: '/api/admin/allowlist/:email',
    doc: 'Alleen beheerders: een adres van de uitnodigingslijst halen.',
    params: z.object({ email: z.string().email() }),
    response: Ok,
  }),
  onboarding: def({
    method: 'GET',
    path: '/api/onboarding',
    doc: 'Stand van de onboarding-wizard (stap, overgeslagen, weekritme, Persoonlijk-repo).',
    response: OnboardingState,
  }),
  updateOnboarding: def({
    method: 'PATCH',
    path: '/api/onboarding',
    doc: 'Onboarding bijwerken: stap, stap afgerond of overgeslagen, later afmaken, weekritme.',
    body: OnboardingPatch,
    response: OnboardingState,
  }),
  connectionDetails: def({
    method: 'GET',
    path: '/api/connections/details',
    doc: 'Koppelingen met rechten, account, of er een OAuth-flow is en de laatste melding.',
    response: z.object({ connections: z.array(ConnectionDetail), redirectUri: z.string() }),
  }),
  connectCallback: def({
    method: 'GET',
    path: '/api/connections/:provider/callback',
    doc: 'Terugkeer van de OAuth-autorisatie: code inwisselen, token versleuteld opslaan, terug naar de app.',
    params: ProviderParam,
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
    response: z.string(),
  }),
  wipeConnectionData: def({
    method: 'DELETE',
    path: '/api/connections/:provider/data',
    doc: 'Eigen gegevens van een bron wissen (leesstatus, planning, agenda-instellingen) zonder te ontkoppelen.',
    params: ProviderParam,
    response: z.object({ ok: z.literal(true), wiped: z.number().int().nonnegative() }),
  }),
  ownGoogleClient: def({
    method: 'PUT',
    path: '/api/connections/google_tasks/client',
    doc: 'Google Taken via een eigen Google Cloud-project: client-ID en geheim versleuteld bewaren.',
    body: OwnGoogleClient,
    response: Ok,
  }),
  deleteOwnGoogleClient: def({
    method: 'DELETE',
    path: '/api/connections/google_tasks/client',
    doc: 'Eigen Google-project weer weghalen (terug naar het HomeZero-project).',
    response: Ok,
  }),
  persRepo: def({
    method: 'GET',
    path: '/api/github/persoonlijk',
    doc: 'Bestaat je Persoonlijk-repo? Met een kant-en-klare opdracht voor Claude als hij er niet is.',
    response: PersRepoStatus,
  }),
  ask: def({
    method: 'POST',
    path: '/api/claude/ask',
    doc: 'Vraag Claude (server-side, met budget en bronnen).',
    body: z.object({ q: z.string().min(1).max(4000) }),
    response: AskResponse,
    owner: 'claude',
  }),
  /* ---------- Koppelingen en sync (stuk E3, HZW-030 t/m 037) ---------- */
  syncStatus: def({
    method: 'GET',
    path: '/api/sync/status',
    doc: 'Sync-stand per gekoppelde bron: laatste geslaagde run, volgende run, fouten (geen inhoud).',
    response: z.object({ jobs: z.array(SyncJob) }),
    owner: 'koppelingen',
  }),
  syncNow: def({
    method: 'POST',
    path: '/api/sync/:provider',
    doc: 'Bron nu synchroniseren (knop "Nu bijwerken"); de worker pakt het binnen seconden op.',
    params: z.object({ provider: ProviderName }),
    response: z.object({ ok: z.literal(true), queued: z.boolean() }),
    owner: 'koppelingen',
  }),
  slackEmoji: def({
    method: 'GET',
    path: '/api/slack/emoji',
    doc: 'Eigen workspace-emoji (naam -> plaatje of alias:naam).',
    response: z.object({ emoji: z.record(z.string(), z.string()) }),
    owner: 'koppelingen',
  }),
  hookSlack: def({
    method: 'POST',
    path: '/api/hooks/slack',
    doc: 'Slack Events API (handtekening met signing secret, url_verification, dubbele events genegeerd).',
    response: z.unknown(),
    auth: false,
    owner: 'koppelingen',
  }),
  hookCalendar: def({
    method: 'POST',
    path: '/api/hooks/google/calendar',
    doc: 'Google Agenda push-kanaal (events.watch); controleert X-Goog-Channel-Token.',
    response: z.unknown(),
    auth: false,
    owner: 'koppelingen',
  }),
  hookGmail: def({
    method: 'POST',
    path: '/api/hooks/google/gmail',
    doc: 'Gmail-push via Pub/Sub (users.watch); controleert het hook-token.',
    response: z.unknown(),
    auth: false,
    owner: 'koppelingen',
  }),
  events: def({
    method: 'GET',
    path: '/api/events',
    doc: 'Server-sent events: `invalidate` met querykeys, `ping` elke 25 s.',
    response: z.string(),
  }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
export type ResponseOf<N extends RouteName> = z.infer<Routes[N]['response']>;
export type BodyOf<N extends RouteName> = Routes[N] extends { body: infer B extends z.ZodType } ? z.input<B> : never;
export type QueryOf<N extends RouteName> = Routes[N] extends { query: infer Q extends z.ZodType } ? z.input<Q> : never;

/** Vul `:param` in een pad. */
export function pathFor(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`param ${k} ontbreekt voor ${path}`);
    return encodeURIComponent(v);
  });
}

/** Server-sent event zoals /api/events die stuurt. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), now: z.string() }),
  z.object({ type: z.literal('ping'), at: z.string() }),
  z.object({ type: z.literal('invalidate'), keys: z.array(z.string()) }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
