/** Start de nep-autorisatieserver: `pnpm --filter @hz/fake-oauth start` (poort HZ_FAKE_OAUTH_PORT, standaard 8764). */
import { createHash } from 'node:crypto';
import { DEFAULT_ACCOUNTS, startFakeOAuth, type FakeAccount } from './index';

const port = Number(process.env.HZ_FAKE_OAUTH_PORT ?? 8764);
const repos = (process.env.HZ_FAKE_GITHUB_REPOS ?? 'homezerotech/persoonlijk-robert')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Extra synthetische accounts, bv. "collega1@homezero.nl:Collega 1,collega2@homezero.nl:Collega 2".
const extra: FakeAccount[] = (process.env.HZ_FAKE_EXTRA_ACCOUNTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [email, name] = s.split(':');
    const sub =
      '2' +
      BigInt('0x' + createHash('sha256').update(email!).digest('hex').slice(0, 15))
        .toString()
        .padStart(20, '0');
    return {
      id: email!.split('@')[0]!,
      sub,
      email: email!,
      name: name ?? email!,
      email_verified: true,
      hd: email!.split('@')[1],
    };
  });
const f = await startFakeOAuth({ port, githubRepos: repos, accounts: [...DEFAULT_ACCOUNTS, ...extra] });
console.log(`[fake-oauth] ${f.url} · issuer ${f.issuer}`);
const stop = async () => {
  await f.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
