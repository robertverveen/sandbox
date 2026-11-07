/** Start de nep-autorisatieserver: `pnpm --filter @hz/fake-oauth start` (poort HZ_FAKE_OAUTH_PORT, standaard 8764). */
import { startFakeOAuth } from './index';

const port = Number(process.env.HZ_FAKE_OAUTH_PORT ?? 8764);
const repos = (process.env.HZ_FAKE_GITHUB_REPOS ?? 'homezerotech/persoonlijk-robert')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const f = await startFakeOAuth({ port, githubRepos: repos });
console.log(`[fake-oauth] ${f.url} · issuer ${f.issuer}`);
const stop = async () => {
  await f.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
