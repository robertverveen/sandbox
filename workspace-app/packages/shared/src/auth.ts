/**
 * Inloggen, sessies, teamleden, onboarding en koppelingen (stuk E1: HZW-010 t/m HZW-014).
 * Schema's voor het contract en de catalogus van bronnen die web en API delen: per bron wat de app ermee doet,
 * welke rechten hij vraagt en wat intrekken betekent. Eén bron van waarheid voor het koppelingenscherm.
 */
import { z } from 'zod';
import { CalendarPref, ProviderName, User } from './domain';

/* ---------- Inloggen ---------- */

export const AuthConfig = z.object({
  /** Google OIDC is ingericht (client-ID en geheim aanwezig). */
  google: z.boolean(),
  /** Dev-login-stub beschikbaar (alleen development en test, nooit productie). */
  devLogin: z.boolean(),
  /** Toegestaan domein (hd-claim en e-mail), bv. homezero.nl. */
  domain: z.string(),
});
export type AuthConfig = z.infer<typeof AuthConfig>;

/** Redenen waarom inloggen geweigerd wordt; de weigerpagina toont per reden een uitleg. */
export const LoginRefusal = z.enum(['domein', 'ongeverifieerd', 'niet-uitgenodigd', 'geblokkeerd', 'fout']);
export type LoginRefusal = z.infer<typeof LoginRefusal>;

export const REFUSAL_TEXT: Record<LoginRefusal, { title: string; body: string }> = {
  domein: {
    title: 'Dit account hoort niet bij HomeZero',
    body: 'Je logt in met je werkaccount (@homezero.nl). Privé-accounts zoals @gmail.com kunnen niet inloggen.',
  },
  ongeverifieerd: {
    title: 'Dit e-mailadres is niet geverifieerd',
    body: 'Google meldt dat dit adres niet bevestigd is. Log in met je bevestigde @homezero.nl-account.',
  },
  'niet-uitgenodigd': {
    title: 'Je staat nog niet op de teamlijst',
    body: 'Je account is van HomeZero, maar nog niet toegevoegd aan de workspace. Vraag een beheerder je toe te voegen.',
  },
  geblokkeerd: {
    title: 'Je toegang is geblokkeerd',
    body: 'Een beheerder heeft je toegang tot de workspace uitgezet. Neem contact op als dat niet klopt.',
  },
  fout: {
    title: 'Inloggen lukte niet',
    body: 'Er ging iets mis bij Google of bij ons. Probeer het opnieuw.',
  },
};

/* ---------- Sessies ---------- */

export const SessionRow = z.object({
  id: z.string(),
  /** Leesbare samenvatting van de browser, bv. "Chrome op macOS". */
  device: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});
export type SessionRow = z.infer<typeof SessionRow>;

/* ---------- Teamleden (beheer) ---------- */

export const Member = User.extend({
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  activeSessions: z.number().int().nonnegative(),
});
export type Member = z.infer<typeof Member>;

export const AllowlistEntry = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']),
  addedAt: z.string(),
});
export type AllowlistEntry = z.infer<typeof AllowlistEntry>;

/* ---------- Onboarding ---------- */

export const ONBOARDING_STEPS = [
  'welkom',
  'google',
  'slack',
  'jira',
  'github',
  'agenda',
  'weekritme',
  'toetsenbord',
] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const STEP_LABEL: Record<OnboardingStep, string> = {
  welkom: 'Welkom',
  google: 'Google',
  slack: 'Slack',
  jira: 'Jira',
  github: 'GitHub',
  agenda: 'Agenda-lagen',
  weekritme: 'Weekritme',
  toetsenbord: 'Toetsenbord',
};

export const Weekritme = z.object({
  /** Dag van de plansessie (ma t/m vr). */
  plansessieDag: z.enum(['ma', 'di', 'wo', 'do', 'vr']).default('ma'),
  plansessieTijd: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('08:30'),
  /** Weekprep op zondagavond (routine in Claude) aan of uit. */
  weekprep: z.boolean().default(true),
  /** Dagafsluiting om deze tijd, of uit. */
  dagafsluiting: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .default('17:00'),
  /** Hoeveel weekdoelen je per week wilt (3 t/m 5). */
  weekdoelen: z.number().int().min(1).max(7).default(3),
});
export type Weekritme = z.infer<typeof Weekritme>;

export const OnboardingState = z.object({
  /** none = nooit gestart (dev-login), new = eerste login, busy = bezig, later = weggelegd, done = klaar. */
  status: z.enum(['none', 'new', 'busy', 'later', 'done']),
  step: OnboardingStep,
  steps: z.partialRecord(OnboardingStep, z.enum(['done', 'skipped'])).default({}),
  weekritme: Weekritme.nullable(),
  /** Naam van de eigen Persoonlijk-repo (owner/naam), of null. */
  persRepo: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

export const OnboardingPatch = z.object({
  status: z.enum(['busy', 'later', 'done']).optional(),
  step: OnboardingStep.optional(),
  mark: z.object({ step: OnboardingStep, as: z.enum(['done', 'skipped']) }).optional(),
  weekritme: Weekritme.optional(),
  persRepo: z
    .string()
    .regex(/^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/, 'Gebruik eigenaar/naam')
    .nullable()
    .optional(),
});
export type OnboardingPatch = z.infer<typeof OnboardingPatch>;

/* ---------- Koppelingen ---------- */

export const ProviderFamily = z.enum(['google', 'slack', 'atlassian', 'github', 'wispr']);
export type ProviderFamily = z.infer<typeof ProviderFamily>;

export interface ProviderCatalogEntry {
  provider: ProviderName;
  label: string;
  family: ProviderFamily;
  /** Korte zin onder de naam. */
  tagline: string;
  /** Wat de app met deze toestemming doet (in gewone taal), getoond bij "Rechten bekijken". */
  does: string[];
  /** Wat de app nooit doet. */
  never: string[];
  /** Technische scopes zoals de bron ze vraagt. */
  scopes: string[];
  recommended?: boolean;
  optional?: boolean;
  /** Bron zonder eigen koppelknop (komt uit de contextlaag). */
  viaContext?: boolean;
  /** Wat intrekken bij de bron precies doet. */
  revoke: string;
}

const GOOGLE_PER_APP =
  ' Google trekt per app in, niet per bron: de laatste Google-bron die je ontkoppelt, haalt de app uit je Google-account.';

export const PROVIDER_CATALOG: Record<ProviderName, ProviderCatalogEntry> = {
  google_tasks: {
    provider: 'google_tasks',
    label: 'Google Taken',
    family: 'google',
    tagline: 'De tracker draait erop: je taken staan in Google en in de workspace.',
    does: [
      'Je takenlijsten en taken lezen',
      'Een taak aanmaken, plannen of afvinken als jij daarop klikt (of 1–5 in Inhalen)',
    ],
    never: ['Taken van collega’s lezen', 'Iets delen buiten je eigen account'],
    scopes: ['https://www.googleapis.com/auth/tasks'],
    recommended: true,
    revoke: 'Het token wordt gewist, met je planning van taken.' + GOOGLE_PER_APP,
  },
  calendar: {
    provider: 'calendar',
    label: 'Agenda',
    family: 'google',
    tagline: 'Alle agenda’s in je werkaccount, ook gedeelde privé-agenda’s.',
    does: [
      'Je agenda’s en afspraken lezen, ook gedeelde privé-agenda’s (met alle details gedeeld)',
      'Reageren op uitnodigingen en een afspraak maken als jij daarop klikt',
      'Vrije tijden van collega’s opvragen (alleen bezet/vrij)',
    ],
    never: ['Privé-afspraken in teksten naar partners of in de contextlaag zetten', 'Zelf uitnodigingen versturen'],
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ],
    revoke: 'Het token wordt gewist, met je agendakleuren en -lagen.' + GOOGLE_PER_APP,
  },
  gmail: {
    provider: 'gmail',
    label: 'Gmail',
    family: 'google',
    tagline: 'Optioneel. Zonder mailbox werkt alles, behalve mail in Inhalen en zoeken.',
    does: [
      'Je inbox lezen voor Inhalen en zoeken (mailtekst live, niet bewaard)',
      'Gelezen zetten en een antwoord klaarzetten; versturen doe jij',
    ],
    never: ['Mailtekst opslaan', 'Zelf mail versturen'],
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    optional: true,
    revoke: 'Het token wordt gewist, met leesstatus en planning van mail.' + GOOGLE_PER_APP,
  },
  slack: {
    provider: 'slack',
    label: 'Slack',
    family: 'slack',
    tagline: 'Interne HomeZero-app met je eigen user token: echt gelezen zetten, reageren, zoeken.',
    does: [
      'Kanalen, DM’s en threads lezen waar jij in zit',
      'Gelezen zetten in Slack, reageren met emoji en antwoorden als jij daarop klikt',
      'Zoeken, emoji van de workspace, Lists en herinneringen lezen',
    ],
    never: ['Iets posten zonder jouw klik', 'Berichten in Slack Connect- of partnerkanalen zetten namens Claude'],
    scopes: [
      'channels:history',
      'channels:read',
      'channels:write',
      'groups:history',
      'groups:read',
      'groups:write',
      'im:history',
      'im:read',
      'im:write',
      'mpim:history',
      'mpim:read',
      'mpim:write',
      'chat:write',
      'reactions:read',
      'reactions:write',
      'users:read',
      'users:read.email',
      'search:read',
      'emoji:read',
      'lists:read',
      'lists:write',
      'reminders:read',
      'team:read',
      'files:read',
    ],
    revoke: 'Het user token wordt in Slack ingetrokken (auth.revoke) en gewist, met de leesstatus van Slack.',
  },
  jira: {
    provider: 'jira',
    label: 'Jira',
    family: 'atlassian',
    tagline: 'Alleen lezen, alleen wat sinds de nachtrun veranderde. De rest komt uit de contextlaag.',
    does: ['Issues en de actieve sprint lezen (HOM, HAI)', 'Zien waar jij Tester bent'],
    never: ['Iets wijzigen in Jira'],
    scopes: ['read:jira-work', 'read:jira-user', 'offline_access'],
    revoke:
      'Het token wordt gewist. Atlassian heeft geen intrek-API: haal de app ook weg via id.atlassian.com → Connected apps.',
  },
  github: {
    provider: 'github',
    label: 'GitHub',
    family: 'github',
    tagline: 'De contextlaag lezen en je eigen Persoonlijk-repo (taken.md, wachten-op.md).',
    does: [
      'HomeZero-context lezen (alleen lezen)',
      'In je eigen Persoonlijk-repo lezen en, vanaf fase 3, regels toevoegen volgens het schema',
    ],
    never: ['In HomeZero-context schrijven zonder de contextcheck', 'Regels van anderen herschrijven'],
    scopes: ['contents:read (HomeZero-context)', 'contents:write (eigen Persoonlijk-repo)', 'metadata:read'],
    revoke:
      'De toestemming wordt bij GitHub ingetrokken (grant verwijderd) en het token gewist; je taken en wachten op uit de Persoonlijk-repo verdwijnen uit de app.',
  },
  wispr: {
    provider: 'wispr',
    label: 'Wispr Flow',
    family: 'wispr',
    tagline: 'Meetings komen uit de contextlaag (persoonlijke nachtdienst); live koppeling volgt.',
    does: ['Meetings van vandaag tonen die nog niet in de contextlaag staan (later)'],
    never: ['Volledige transcripten opslaan'],
    scopes: [],
    viaContext: true,
    revoke: 'Er is geen token om in te trekken.',
  },
};

/** Volgorde op het scherm (zoals de rij connectors in Claude). */
export const PROVIDER_ORDER: ProviderName[] = ['google_tasks', 'calendar', 'gmail', 'slack', 'jira', 'github', 'wispr'];

export const ConnectionDetail = z.object({
  provider: ProviderName,
  status: z.enum(['connected', 'disconnected', 'error', 'needs_reauth']),
  scopes: z.array(z.string()),
  account: z.string().nullable(),
  connectedAt: z.string().nullable(),
  mode: z.enum(['fixture', 'live']),
  /** Er is een OAuth-flow ingericht (echt of de nep-autorisatieserver); zonder flow koppelt fixture-modus direct. */
  oauth: z.boolean(),
  /** Google Taken: er staat een eigen Google-project (client-ID) klaar. */
  ownClient: z.boolean().optional(),
  /** Laatste fout of melding van de bron. */
  error: z.string().nullable(),
});
export type ConnectionDetail = z.infer<typeof ConnectionDetail>;

export const DisconnectResult = z.object({
  ok: z.literal(true),
  /** Het token is bij de bron ingetrokken (false bij Atlassian: geen intrek-API, of bij fixtures). */
  revokedAtProvider: z.boolean().optional(),
  /** Aantal gewiste rijen eigen data (leesstatus, planning, agenda-instellingen). */
  wiped: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  /**
   * Google trekt toestemming per app (client) in, niet per bron. Zijn er nog andere Google-bronnen op dezelfde
   * client gekoppeld, dan wordt alleen dit token gewist en blijven die werken; hier staan ze.
   */
  keptFor: z.array(ProviderName).optional(),
  /** Bronnen die door het intrekken bij de bron ook hun toegang kwijt zijn en nu "Opnieuw verbinden" vragen. */
  needsReauth: z.array(ProviderName).optional(),
});

/**
 * Voorvoegsels van itemstate-sleutels voor regels uit de Persoonlijk-repo: `tm:` taken.md, `wo:` wachten-op.md
 * (Open en Bespreken), `pers:` overig. GitHub ontkoppelen wist ze (stuk E1); de Tracker gebruikt ze.
 */
export const PERS_KEY_PREFIXES = ['tm:', 'wo:', 'pers:'] as const;

export const OwnGoogleClient = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, 'Een Google client-ID eindigt op .apps.googleusercontent.com'),
  clientSecret: z.string().trim().min(10).max(200),
});

export const PersRepoStatus = z.object({
  repo: z.string().nullable(),
  /** exists = gevonden, missing = niet gevonden, unknown = GitHub niet gekoppeld of niet te controleren. */
  status: z.enum(['exists', 'missing', 'unknown']),
  /** Kant-en-klare opdracht voor Claude om de repo op te zetten. */
  prompt: z.string(),
});
export type PersRepoStatus = z.infer<typeof PersRepoStatus>;

export const CalendarLayerPatch = z.record(z.string(), CalendarPref);
