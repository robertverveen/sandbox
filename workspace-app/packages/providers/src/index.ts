/**
 * createProviders(env): kiest per bron fixture of live.
 *
 * Omgevingsvariabelen (zie .env.example):
 *  HZ_FIXTURE_SET       demo (standaard, prototype-demodata, vaste klok) | harness (lat met echte context)
 *  HZ_NOW               vaste wandklok `JJJJ-MM-DDTHH:MM` of `now`; standaard demo: 2026-10-30T08:40, harness: nu
 *  HZ_CONTEXT_EXPORT    map met een export van de contextlaag (alleen runtime, nooit committen)
 *  HZ_CONTEXT_REPO      map van HomeZero-context op schijf (alleen lezen), met HZ_PERSOONLIJK_REPO
 *  HZ_LIVE_<BRON>=1     zet de live-implementatie aan (CALENDAR, GMAIL, TASKS, SLACK, JIRA, WISPR, GITHUB, ANTHROPIC)
 *  HZ_JIRA_SITE         Jira-site (standaard homezero.atlassian.net), HZ_JIRA_PROJECT (standaard HOM)
 *  HZ_WISPR_MCP_URL     endpoint van de Wispr Flow MCP-server (streamable HTTP)
 *  HZ_GITHUB_CONTEXT_REPO / HZ_GITHUB_PERSOONLIJK_REPO   owner/repo (live contextlaag via GitHub)
 *  HZ_SLACK_TODOS=1     spike HZW-037: Slack-herinneringen en Lists als takenbron (achter een vlag)
 */
import type { ContextSnapshot } from '@hz/shared';
import { ContextSnapshot as SnapshotSchema } from '@hz/shared';
import { pd, wall } from '@hz/shared/logic';
import { lastSuccessfulRun } from '@hz/context';
import { ExportContext, FixtureContext, RepoContext, isLayerAware } from './context';
import { loadFixtureSet, type FixtureDataset, type FixtureSetName } from './fixtures/dataset';
import {
  FakeAnthropic,
  FixtureCalendar,
  FixtureGmail,
  FixtureJira,
  FixtureSlack,
  FixtureTasks,
  FixtureWispr,
  type FixtureLog,
} from './fixture';
import {
  ContextFirstWispr,
  GitHubContext,
  LiveAnthropic,
  LiveCalendar,
  LiveGmail,
  LiveJira,
  LiveSlack,
  LiveTasks,
  LiveWispr,
  MemorySyncStore,
  CombinedTasks,
  SlackTodos,
  UserScopedGitHubContext,
  currentUserId,
  type LiveCredentials,
  type SyncStore,
} from './live';
import type { Providers } from './types';

export * from './types';
export * from './fixture';
export * from './live';
export * from './context';
export { loadFixtureSet, type FixtureDataset, type FixtureSetName } from './fixtures/dataset';
export * as demo from './fixtures/demo';

export interface ProviderEnv {
  HZ_FIXTURE_SET?: string;
  HZ_NOW?: string;
  HZ_CONTEXT_EXPORT?: string;
  HZ_CONTEXT_REPO?: string;
  HZ_PERSOONLIJK_REPO?: string;
  HZ_OWNER?: string;
  ANTHROPIC_API_KEY?: string;
  [k: string]: string | undefined;
}

export interface ProviderBundle {
  providers: Providers;
  dataset: FixtureDataset;
  /** Wandklok van de app (vast in demo, anders echt). */
  now(): Date;
  log: FixtureLog;
  info: { fixtureSet: FixtureSetName; contextSource: 'fixture' | 'export' | 'repo'; live: string[] };
}

const noCreds: LiveCredentials = {
  accessToken: async (p) => {
    throw new Error(`geen token voor ${p}: koppel de bron eerst (stuk koppelingen)`);
  },
};

export interface LiveOptions {
  /** Sync-opslag per collega (Postgres in api/worker, geheugen in tests). */
  store?: SyncStore;
  /** Alleen voor tests: fetch vervangen (msw vangt anders de globale fetch af). */
  fetchImpl?: typeof fetch;
  /** Persoonlijk-repo (owner/repo) per collega; standaard HZ_GITHUB_PERSOONLIJK_REPO. */
  persoonlijkRepoFor?: (userId: string) => string | null;
}

export function createProviders(
  env: ProviderEnv = {},
  creds: LiveCredentials = noCreds,
  liveOpts: LiveOptions = {},
): ProviderBundle {
  const set: FixtureSetName = env.HZ_FIXTURE_SET === 'harness' ? 'harness' : 'demo';
  const fixed = env.HZ_NOW && env.HZ_NOW !== 'now' ? pd(env.HZ_NOW) : null;
  const realNow = () => wall(new Date());
  const now = fixed ? () => new Date(fixed) : set === 'demo' && env.HZ_NOW !== 'now' ? null : realNow;
  const dataset = loadFixtureSet(set, now ? now() : undefined);
  const clock = now ?? (() => new Date(dataset.now));
  const log: FixtureLog = { calls: [] };
  const live = (k: string) => env[`HZ_LIVE_${k}`] === '1';
  const liveOn: string[] = [];
  const pick = <T>(k: string, fx: () => T, lv: () => T): T => {
    if (live(k)) {
      liveOn.push(k.toLowerCase());
      return lv();
    }
    return fx();
  };

  const store = liveOpts.store ?? new MemorySyncStore();
  const fetchImpl = liveOpts.fetchImpl;
  const owner = env.HZ_OWNER || 'Robert';
  const wallNow = () => new Date();

  let context: Providers['context'];
  if (live('GITHUB')) {
    liveOn.push('github');
    context = new UserScopedGitHubContext(
      (userId) =>
        new GitHubContext(creds, {
          repo: env.HZ_GITHUB_CONTEXT_REPO || 'HomeZeroTech/HomeZero-context',
          persoonlijk: liveOpts.persoonlijkRepoFor?.(userId) ?? env.HZ_GITHUB_PERSOONLIJK_REPO ?? null,
          owner,
          fetchImpl,
        }),
      currentUserId,
    );
  } else if (env.HZ_CONTEXT_EXPORT) context = new ExportContext(env.HZ_CONTEXT_EXPORT);
  else if (env.HZ_CONTEXT_REPO)
    context = new RepoContext(env.HZ_CONTEXT_REPO, env.HZ_PERSOONLIJK_REPO || null, env.HZ_OWNER || 'Robert');
  else context = new FixtureContext(SnapshotSchema.parse(dataset.context) as ContextSnapshot);

  const providers: Providers = {
    calendar: pick<Providers['calendar']>(
      'CALENDAR',
      () => new FixtureCalendar(dataset, log),
      () => new LiveCalendar(creds, { store, fetchImpl }),
    ),
    gmail: pick<Providers['gmail']>(
      'GMAIL',
      () => new FixtureGmail(dataset, log),
      () => new LiveGmail(creds, { store, fetchImpl }),
    ),
    tasks: pick<Providers['tasks']>(
      'TASKS',
      () => new FixtureTasks(dataset, log),
      () => new LiveTasks(creds, { store, fetchImpl }),
    ),
    slack: pick<Providers['slack']>(
      'SLACK',
      () => new FixtureSlack(dataset, log),
      () => new LiveSlack(creds, { store, fetchImpl }),
    ),
    jira: pick<Providers['jira']>(
      'JIRA',
      () => new FixtureJira(dataset),
      () =>
        new LiveJira(creds, {
          store,
          fetchImpl,
          site: env.HZ_JIRA_SITE || 'homezero.atlassian.net',
          project: env.HZ_JIRA_PROJECT || 'HOM',
          // Contextlaag eerst: Jira staat 's nachts in product/jira/ (info-nachtdienst).
          lastNightRun: async () =>
            isLayerAware(context) ? (lastSuccessfulRun(await context.nightRuns('info'))?.at ?? null) : null,
          layerKeys: async () =>
            isLayerAware(context)
              ? new Map((await context.jiraLayer()).map((i) => [i.key, i.asOf] as [string, string]))
              : new Map<string, string>(),
        }),
    ),
    wispr: pick<Providers['wispr']>(
      'WISPR',
      () => new FixtureWispr(dataset),
      () =>
        new ContextFirstWispr(new LiveWispr(creds, { url: env.HZ_WISPR_MCP_URL, fetchImpl }), context, {
          owner,
          now: wallNow,
        }),
    ),
    context,
    anthropic: pick<Providers['anthropic']>(
      'ANTHROPIC',
      () => new FakeAnthropic(),
      () => new LiveAnthropic(env.ANTHROPIC_API_KEY ?? ''),
    ),
  };
  // Spike HZW-037: Slack-to-do's (herinneringen en gekoppelde Lists) naast Google Taken, achter een vlag.
  if (env.HZ_SLACK_TODOS === '1' && providers.slack instanceof LiveSlack) {
    const lists = (env.HZ_SLACK_TODO_LISTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [id, ...t] = s.split(':');
        return { id: id!, title: t.join(':') || 'Slack-lijst' };
      });
    providers.tasks = new CombinedTasks(providers.tasks, new SlackTodos(providers.slack, lists));
    liveOn.push('slack_todos');
  }
  return {
    providers,
    dataset,
    now: clock,
    log,
    info: { fixtureSet: set, contextSource: context.source, live: liveOn },
  };
}
