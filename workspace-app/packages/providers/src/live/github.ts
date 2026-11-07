/**
 * Contextlaag via GitHub (live): HomeZeroTech/HomeZero-context en de Persoonlijk-repo van de collega lezen
 * met het token van de koppeling (GitHub App user-to-server of fine-grained token, keuze 09 / B1).
 *
 * - Eén git-trees-call per repo; alleen gewijzigde bestanden (andere blob-sha) worden opnieuw opgehaald.
 * - Alleen de paden die de app leest; `admin.md` wordt nooit opgehaald (AGENTS.md).
 * - De bestanden staan alleen runtime in een eigen tijdelijke map (0700) en worden met @hz/context geparsed,
 *   precies zoals een lokale repo. Nooit in Git, nooit schrijven naar de echte repo's.
 * - Een push-webhook (HZW-060) roept invalidate() aan; anders geldt een korte TTL.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ContextSnapshot } from '@hz/shared';
import { ContextSnapshot as SnapshotSchema } from '@hz/shared';
import {
  exportContext,
  readJiraLayer,
  readNightRuns,
  RepoReader,
  toSnapshot,
  FORBIDDEN_FILES,
  type JiraLayerIssue,
  type NightRun,
} from '@hz/context';
import type { ContextProvider } from '../types';
import { HttpClient, type LiveCredentials } from './http';

export const GITHUB_API = 'https://api.github.com';

const CONTEXT_PATHS = [
  /^partners\/[^/]+\/(brief|acties|log)\.md$/,
  /^partners\/[^/]+\/meetings\/[^/]+\.md$/,
  /^partners\/_register\.md$/,
  /^projecten\/[^/]+\/(brief|acties|log)\.md$/,
  /^projecten\/[^/]+\/meetings\/[^/]+\.md$/,
  /^product\/jira\/[^/]+\.md$/,
  /^_systeem\/(status|over-datum)\.md$/,
  /^_systeem\/routines\/[^/]+\.md$/,
];
const PERS_PATHS = [/^(wachten-op|taken|aangehouden)\.md$/, /^nacht\/log\.md$/];

export const allowedPath = (path: string, kind: 'context' | 'persoonlijk') => {
  const base = path.split('/').pop()!.toLowerCase();
  if (FORBIDDEN_FILES.has(base) || path.split('/').includes('..')) return false;
  return (kind === 'context' ? CONTEXT_PATHS : PERS_PATHS).some((re) => re.test(path));
};

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export interface GitHubContextOptions {
  /** owner/repo van de contextlaag. */
  repo?: string;
  branch?: string;
  /** owner/repo van de Persoonlijk-repo van de collega (of null). */
  persoonlijk?: string | null;
  persoonlijkBranch?: string;
  owner?: string;
  ttlMs?: number;
  base?: string;
  fetchImpl?: typeof fetch;
}

class RepoMirror {
  readonly dir: string;
  private blobs = new Map<string, string>();
  head = '';
  constructor(
    readonly http: HttpClient,
    readonly repo: string,
    readonly branch: string,
    readonly kind: 'context' | 'persoonlijk',
    root: string,
  ) {
    this.dir = join(root, kind);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Spiegel bijwerken; geeft het aantal opnieuw opgehaalde bestanden. */
  async sync(): Promise<number> {
    const commit = await this.http.json<{ sha: string; commit: { tree: { sha: string } } }>(
      `/repos/${this.repo}/commits/${encodeURIComponent(this.branch)}`,
    );
    this.head = commit.sha.slice(0, 7);
    const tree = await this.http.json<{ tree: TreeEntry[]; truncated?: boolean }>(
      `/repos/${this.repo}/git/trees/${commit.commit.tree.sha}`,
      { query: { recursive: 1 } },
    );
    const wanted = tree.tree.filter((e) => e.type === 'blob' && allowedPath(e.path, this.kind));
    const want = new Set(wanted.map((e) => e.path));
    for (const p of [...this.blobs.keys()])
      if (!want.has(p)) {
        rmSync(join(this.dir, p), { force: true });
        this.blobs.delete(p);
      }
    const todo = wanted.filter((e) => this.blobs.get(e.path) !== e.sha);
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let e = queue.shift(); e; e = queue.shift()) {
          const b = await this.http.json<{ content: string; encoding: string }>(
            `/repos/${this.repo}/git/blobs/${e.sha}`,
          );
          const text = b.encoding === 'base64' ? Buffer.from(b.content, 'base64').toString('utf8') : b.content;
          const abs = join(this.dir, e.path);
          mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
          writeFileSync(abs, text, { mode: 0o600 });
          this.blobs.set(e.path, e.sha);
        }
      }),
    );
    return todo.length;
  }
}

export class GitHubContext implements ContextProvider {
  readonly mode = 'live' as const;
  readonly source = 'repo' as const;
  readonly http: HttpClient;
  private root: string;
  private ctx: RepoMirror;
  private pers: RepoMirror | null;
  private cache: { at: number; snap: ContextSnapshot } | null = null;
  private o: Required<Pick<GitHubContextOptions, 'owner' | 'ttlMs'>>;
  lastFetched = 0;

  constructor(
    readonly creds: LiveCredentials,
    opts: GitHubContextOptions = {},
  ) {
    this.http = new HttpClient('github', opts.base ?? GITHUB_API, creds, opts.fetchImpl);
    this.root = mkdtempSync(join(tmpdir(), 'hz-github-'));
    this.ctx = new RepoMirror(
      this.http,
      opts.repo ?? 'HomeZeroTech/HomeZero-context',
      opts.branch ?? 'main',
      'context',
      this.root,
    );
    this.pers = opts.persoonlijk
      ? new RepoMirror(this.http, opts.persoonlijk, opts.persoonlijkBranch ?? 'main', 'persoonlijk', this.root)
      : null;
    this.o = { owner: opts.owner ?? 'Robert', ttlMs: opts.ttlMs ?? 5 * 60_000 };
  }

  invalidate() {
    this.cache = null;
  }

  async refresh(): Promise<ContextSnapshot> {
    const fetched = await Promise.all([this.ctx.sync(), this.pers?.sync() ?? 0]);
    this.lastFetched = fetched[0] + fetched[1];
    const docs = exportContext(this.ctx.dir, this.pers?.dir ?? null, { owner: this.o.owner });
    docs.context_status.laatste.commit_context = this.ctx.head;
    if (this.pers) docs.context_status.laatste.commit_prive = this.pers.head;
    const snap = SnapshotSchema.parse(toSnapshot(docs as never)) as ContextSnapshot;
    this.cache = { at: Date.now(), snap };
    return snap;
  }

  async snapshot(): Promise<ContextSnapshot> {
    if (this.cache && Date.now() - this.cache.at < this.o.ttlMs) return this.cache.snap;
    return this.refresh();
  }

  /** Lezer op de spiegel (na snapshot()), voor de Jira-laag en de heartbeats. */
  reader(): RepoReader {
    return new RepoReader(this.ctx.dir);
  }

  async jiraLayer(): Promise<JiraLayerIssue[]> {
    await this.snapshot();
    return readJiraLayer(this.reader());
  }

  async nightRuns(routine: string): Promise<NightRun[]> {
    await this.snapshot();
    return readNightRuns(this.reader(), routine);
  }

  dispose() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * Per collega een eigen spiegel (eigen Persoonlijk-repo en eigen token), gekozen uit de scope (withUserScope).
 * De contextlaag zelf is gedeeld, maar elke collega leest hem met zijn eigen koppeling.
 */
export class UserScopedGitHubContext implements ContextProvider {
  readonly mode = 'live' as const;
  readonly source = 'repo' as const;
  private per = new Map<string, GitHubContext>();
  constructor(
    readonly make: (userId: string) => GitHubContext,
    readonly userId: () => string | undefined,
  ) {}
  private current(): GitHubContext {
    const u = this.userId() ?? '_';
    let c = this.per.get(u);
    if (!c) {
      c = this.make(u);
      this.per.set(u, c);
    }
    return c;
  }
  snapshot() {
    return this.current().snapshot();
  }
  jiraLayer() {
    return this.current().jiraLayer();
  }
  nightRuns(routine: string) {
    return this.current().nightRuns(routine);
  }
  invalidate() {
    for (const c of this.per.values()) c.invalidate();
  }
}
