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
import { exportContext, readExport, toSnapshot } from '@hz/context';
import type { ContextProvider } from './types';
import { NotConnectedError } from './types';

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
}

/**
 * TODO(context, HZW-060): HomeZeroTech/HomeZero-context en de Persoonlijk-repo via de GitHub App lezen,
 * webhook op push -> worker werkt de index (context_index) bij; lezen uit de index, bestand openen live.
 */
export class GitHubContext implements ContextProvider {
  readonly mode = 'live' as const;
  readonly source = 'repo' as const;
  async snapshot(): Promise<ContextSnapshot> {
    throw new NotConnectedError('github', 'nog niet gebouwd (GitHub App + index)');
  }
}
