/**
 * Contextlaag via GitHub (live, lezen): een nep-GitHub serveert de synthetische testrepo uit @hz/context.
 * Nooit admin.md ophalen; tweede keer alleen gewijzigde bestanden; Jira-laag en heartbeats leesbaar.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_API as GH,
  GitHubContext,
  UserScopedGitHubContext,
  allowedPath,
  currentUserId,
  withUserScope,
} from '../../src';
import { creds, mockServer } from './msw';

const FIX = join(import.meta.dirname, '../../../context/test/fixtures');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const repoFiles = (root: string) =>
  Object.fromEntries(walk(root).map((abs) => [relative(root, abs).split('\\').join('/'), readFileSync(abs, 'utf8')]));

const repos: Record<string, Record<string, string>> = {
  'HomeZeroTech/HomeZero-context': repoFiles(join(FIX, 'ctx')),
  'robert/context-prive': repoFiles(join(FIX, 'prive')),
};
const sha = (s: string) => createHash('sha1').update(s).digest('hex');
const blobs = new Map<string, string>();

const { requests, clear } = mockServer(
  http.get(`${GH}/repos/:o/:r/commits/:ref`, ({ params }) => {
    const repo = `${params.o}/${params.r}`;
    const files = repos[repo]!;
    return HttpResponse.json({ sha: sha(JSON.stringify(files)), commit: { tree: { sha: sha(`tree:${repo}`) } } });
  }),
  http.get(`${GH}/repos/:o/:r/git/trees/:tree`, ({ params, request }) => {
    expect(new URL(request.url).searchParams.get('recursive')).toBe('1');
    const files = repos[`${params.o}/${params.r}`]!;
    const tree = Object.entries(files).map(([path, text]) => {
      const s = sha(path + text);
      blobs.set(s, text);
      return { path, type: 'blob', sha: s };
    });
    return HttpResponse.json({ tree: [{ path: 'partners', type: 'tree', sha: 'x' }, ...tree], truncated: false });
  }),
  http.get(`${GH}/repos/:o/:r/git/blobs/:sha`, ({ params }) =>
    HttpResponse.json({ content: Buffer.from(blobs.get(String(params.sha))!).toString('base64'), encoding: 'base64' }),
  ),
);

const make = () =>
  new GitHubContext(creds('ghu_test'), { persoonlijk: 'robert/context-prive', owner: 'Robert', ttlMs: 0 });

describe('contextlaag via GitHub (lezen)', () => {
  it('snapshot uit de repo’s, met commit; admin.md wordt nooit opgehaald', async () => {
    const g = make();
    const snap = await g.snapshot();
    expect(Object.keys(snap.partners).sort()).toEqual(expect.arrayContaining(['warmtehuis', 'zonnig']));
    expect(snap.pers).not.toBeNull();
    expect(snap.status?.commit_context).toMatch(/^[0-9a-f]{7}$/);
    const blobPaths = requests
      .filter((r) => r.url.pathname.includes('/git/blobs/'))
      .map((r) => r.url.pathname.split('/').pop()!);
    const adminSha = sha(
      'partners/zonnig/admin.md' + repos['HomeZeroTech/HomeZero-context']!['partners/zonnig/admin.md'],
    );
    expect(blobPaths).not.toContain(adminSha);
    expect(JSON.stringify(snap)).not.toMatch(/MRR|IBAN/i);
    g.dispose();
  });

  it('tweede keer: alleen gewijzigde bestanden opnieuw ophalen', async () => {
    const g = make();
    await g.snapshot();
    clear();
    repos['HomeZeroTech/HomeZero-context']!['partners/zonnig/acties.md'] +=
      '\n- [ ] Nieuwe synthetische actie [eigenaar:: Robert] [datum:: 2026-11-10]\n';
    await g.snapshot();
    expect(requests.filter((r) => r.url.pathname.includes('/git/blobs/'))).toHaveLength(1);
    expect(g.lastFetched).toBe(1);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    g.dispose();
  });

  it('Jira-laag en heartbeats uit de spiegel', async () => {
    const g = make();
    expect((await g.jiraLayer()).map((i) => i.key)).toEqual(['HOM-901', 'HOM-902']);
    expect((await g.nightRuns('info'))[0]!.status).toBe('rood');
    g.dispose();
  });

  it('per collega een eigen spiegel (eigen token en Persoonlijk-repo)', async () => {
    const made: string[] = [];
    const s2 = new UserScopedGitHubContext((u) => {
      made.push(u);
      return new GitHubContext(creds(), { persoonlijk: u === 'a' ? 'robert/context-prive' : null, ttlMs: 60_000 });
    }, currentUserId);
    const a = await withUserScope('a', () => s2.snapshot());
    const b = await withUserScope('b', () => s2.snapshot());
    expect(a.pers).not.toBeNull();
    expect(b.pers).toBeNull();
    expect(made).toEqual(['a', 'b']);
  });

  it('alleen paden die de app leest', () => {
    expect(allowedPath('partners/zonnig/brief.md', 'context')).toBe(true);
    expect(allowedPath('partners/zonnig/admin.md', 'context')).toBe(false);
    expect(allowedPath('partners/zonnig/ADMIN.md', 'context')).toBe(false);
    expect(allowedPath('organisatie/besluiten/x.md', 'context')).toBe(false);
    expect(allowedPath('wachten-op.md', 'persoonlijk')).toBe(true);
    expect(allowedPath('ik.md', 'persoonlijk')).toBe(false);
  });
});
