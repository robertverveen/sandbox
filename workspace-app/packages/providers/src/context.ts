/**
 * Context-providers. Volgorde van voorkeur (createProviders):
 *  1. HZ_CONTEXT_EXPORT=<map>   : een export van de repo's (JSON, zoals export_context.py maakt). Alleen runtime.
 *  2. HZ_CONTEXT_REPO=<map>     : de repo's zelf op schijf, geparsed met @hz/context (alleen lezen), met
 *     optioneel HZ_PERSOONLIJK_REPO=<map>.
 *  3. fixture                   : DEMO_CTX uit het prototype.
 * Live via GitHub (App per collega, webhooks, index in Postgres) bouwt het context-stuk (HZW-060).
 * Nooit admin.md; echte data nooit in Git.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextSnapshot } from '@hz/shared';
import { ContextSnapshot as SnapshotSchema } from '@hz/shared';
import {
  exportContext,
  readExport,
  readJiraLayer,
  readNightRuns,
  RepoReader,
  toSnapshot,
  type JiraLayerIssue,
  type NightRun,
} from '@hz/context';
import type { ContextProvider } from './types';

export class FixtureContext implements ContextProvider {
  readonly mode = 'fixture' as const;
  readonly source = 'fixture' as const;
  constructor(private snap: ContextSnapshot) {}
  async snapshot() {
    return this.snap;
  }
}

/** Leest een export-map; herlaadt als context_status/laatste.json verandert. */
export class ExportContext implements ContextProvider {
  readonly mode = 'live' as const;
  readonly source = 'export' as const;
  private cache: { mtime: number; snap: ContextSnapshot } | null = null;
  constructor(readonly dir: string) {
    if (!existsSync(dir)) throw new Error(`HZ_CONTEXT_EXPORT bestaat niet: ${dir}`);
  }
  async snapshot() {
    const marker = join(this.dir, 'context_status', 'laatste.json');
    const mtime = existsSync(marker) ? statSync(marker).mtimeMs : 0;
    if (!this.cache || this.cache.mtime !== mtime) this.cache = { mtime, snap: readExport(this.dir) };
    return this.cache.snap;
  }
}

/** Parse de repo's direct (alleen lezen), met een korte cache. */
export class RepoContext implements ContextProvider {
  readonly mode = 'live' as const;
  readonly source = 'repo' as const;
  private cache: { at: number; snap: ContextSnapshot } | null = null;
  constructor(
    readonly ctxDir: string,
    readonly priveDir: string | null,
    readonly owner = 'Robert',
    readonly ttlMs = 60_000,
  ) {}
  async snapshot() {
    if (!this.cache || Date.now() - this.cache.at > this.ttlMs) {
      const docs = exportContext(this.ctxDir, this.priveDir, { owner: this.owner });
      this.cache = { at: Date.now(), snap: SnapshotSchema.parse(toSnapshot(docs as never)) };
    }
    return this.cache.snap;
  }
  /** Jira uit de laag (product/jira/) en heartbeats van de routines (HZW-034/035). */
  async jiraLayer(): Promise<JiraLayerIssue[]> {
    return readJiraLayer(new RepoReader(this.ctxDir));
  }
  async nightRuns(routine: string): Promise<NightRun[]> {
    return readNightRuns(new RepoReader(this.ctxDir), routine);
  }
}

/**
 * Per collega een eigen kijk op de repo's op schijf (lokaal en in de harness): owner = voornaam uit de scope, zodat
 * partneracties, heartbeat en meetings van die collega zijn. De Persoonlijk-repo op schijf hoort bij één collega
 * (HZ_OWNER); anderen zien hem niet.
 */
export class OwnerScopedContext implements ContextProvider {
  readonly mode = 'live' as const;
  readonly source: ContextProvider['source'];
  private per = new Map<string, ContextProvider & Partial<LayerAware>>();
  constructor(
    readonly make: (owner: string) => ContextProvider & Partial<LayerAware>,
    readonly owner: () => string,
  ) {
    this.source = this.current().source;
  }
  private current() {
    const o = this.owner().toLowerCase();
    let c = this.per.get(o);
    if (!c) {
      c = this.make(this.owner());
      this.per.set(o, c);
    }
    return c;
  }
  snapshot() {
    return this.current().snapshot();
  }
  async jiraLayer(): Promise<JiraLayerIssue[]> {
    return this.current().jiraLayer?.() ?? [];
  }
  async nightRuns(routine: string): Promise<NightRun[]> {
    return this.current().nightRuns?.(routine) ?? [];
  }
}

/** Een contextbron die ook de ruwe laag kan lezen (Jira per epic, heartbeats). */
export interface LayerAware {
  jiraLayer(): Promise<JiraLayerIssue[]>;
  nightRuns(routine: string): Promise<NightRun[]>;
}
export const isLayerAware = (c: unknown): c is LayerAware =>
  !!c && typeof (c as LayerAware).jiraLayer === 'function' && typeof (c as LayerAware).nightRuns === 'function';
