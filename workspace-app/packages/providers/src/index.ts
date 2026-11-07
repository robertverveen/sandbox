/**
 * createProviders(env): kiest per bron fixture of live.
 *
 * Omgevingsvariabelen (zie .env.example):
 *  HZ_FIXTURE_SET       demo (standaard, prototype-demodata, vaste klok) | harness (lat met echte context)
 *  HZ_NOW               vaste wandklok `JJJJ-MM-DDTHH:MM` of `now`; standaard demo: 2026-10-30T08:40, harness: nu
 *  HZ_CONTEXT_EXPORT    map met een export van de contextlaag (alleen runtime, nooit committen)
 *  HZ_CONTEXT_REPO      map van HomeZero-context op schijf (alleen lezen), met HZ_PERSOONLIJK_REPO
 *  HZ_LIVE_<BRON>=1     zet de live-implementatie aan (CALENDAR, GMAIL, TASKS, SLACK, JIRA, WISPR, ANTHROPIC)
 */
import type { ContextSnapshot } from '@hz/shared';
import { ContextSnapshot as SnapshotSchema } from '@hz/shared';
import { pd, wall } from '@hz/shared/logic';
import { ExportContext, FixtureContext, RepoContext } from './context';
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
  LiveAnthropic,
  LiveCalendar,
  LiveGmail,
  LiveJira,
  LiveSlack,
  LiveTasks,
  LiveWispr,
  type LiveCredentials,
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

export function createProviders(env: ProviderEnv = {}, creds: LiveCredentials = noCreds): ProviderBundle {
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

  let context: Providers['context'];
  if (env.HZ_CONTEXT_EXPORT) context = new ExportContext(env.HZ_CONTEXT_EXPORT);
  else if (env.HZ_CONTEXT_REPO)
    context = new RepoContext(env.HZ_CONTEXT_REPO, env.HZ_PERSOONLIJK_REPO || null, env.HZ_OWNER || 'Robert');
  else context = new FixtureContext(SnapshotSchema.parse(dataset.context) as ContextSnapshot);

  const providers: Providers = {
    calendar: pick<Providers['calendar']>(
      'CALENDAR',
      () => new FixtureCalendar(dataset, log),
      () => new LiveCalendar(creds),
    ),
    gmail: pick<Providers['gmail']>(
      'GMAIL',
      () => new FixtureGmail(dataset, log),
      () => new LiveGmail(creds),
    ),
    tasks: pick<Providers['tasks']>(
      'TASKS',
      () => new FixtureTasks(dataset, log),
      () => new LiveTasks(creds),
    ),
    slack: pick<Providers['slack']>(
      'SLACK',
      () => new FixtureSlack(dataset, log),
      () => new LiveSlack(creds),
    ),
    jira: pick<Providers['jira']>(
      'JIRA',
      () => new FixtureJira(dataset),
      () => new LiveJira(creds),
    ),
    wispr: pick<Providers['wispr']>(
      'WISPR',
      () => new FixtureWispr(dataset),
      () => new LiveWispr(creds),
    ),
    context,
    anthropic: pick<Providers['anthropic']>(
      'ANTHROPIC',
      () => new FakeAnthropic(),
      () => new LiveAnthropic(env.ANTHROPIC_API_KEY ?? ''),
    ),
  };
  return {
    providers,
    dataset,
    now: clock,
    log,
    info: { fixtureSet: set, contextSource: context.source, live: liveOn },
  };
}
