/**
 * Stuk E1: tweede API (Google-inloggen tegen de nep-uitgever, OAuth per bron tegen de nep-autorisatieserver) en
 * tweede web-server, naast de standaard e2e-servers (dev-login, voor de andere stukken). Poorten volgen uit
 * HZ_E2E_API_PORT en HZ_E2E_WEB_PORT: API+2, nep-server API+4, web+2.
 */
const API = Number(process.env.HZ_E2E_API_PORT ?? 8780);
const WEB = Number(process.env.HZ_E2E_WEB_PORT ?? 8781);

export const E1_API = API + 2;
export const E1_FAKE = API + 4;
export const E1_WEB = WEB + 2;
export const E1_BASE = `http://127.0.0.1:${E1_WEB}`;
export const E1_FAKE_URL = `http://127.0.0.1:${E1_FAKE}`;

/** Synthetische collega's op de uitnodigingslijst (alleen voor de wizard-tests: elke test een nieuw account). */
export const E1_COLLEGAS = ['collega1', 'collega2', 'collega3', 'collega4'];

export const E1_API_ENV: Record<string, string> = {
  HZ_API_PORT: String(E1_API),
  HZ_FIXTURE_SET: 'demo',
  HZ_STORE: 'memory',
  NODE_ENV: 'development',
  HZ_CONTEXT_EXPORT: '',
  HZ_WEB_ORIGIN: E1_BASE,
  HZ_GOOGLE_CLIENT_ID: 'workspace-e2e.apps.googleusercontent.com',
  HZ_GOOGLE_CLIENT_SECRET: 'e2e-geheim-google',
  HZ_GOOGLE_ISSUER: `${E1_FAKE_URL}/google`,
  HZ_OAUTH_ENDPOINTS: E1_FAKE_URL,
  HZ_SLACK_CLIENT_ID: 'slack-e2e',
  HZ_SLACK_CLIENT_SECRET: 'slack-e2e-geheim',
  HZ_ATLASSIAN_CLIENT_ID: 'atlassian-e2e',
  HZ_ATLASSIAN_CLIENT_SECRET: 'atlassian-e2e-geheim',
  HZ_GITHUB_CLIENT_ID: 'github-e2e',
  HZ_GITHUB_CLIENT_SECRET: 'github-e2e-geheim',
  HZ_ALLOWLIST: ['lisanne', ...E1_COLLEGAS].map((n) => `${n}@homezero.nl`).join(','),
  HZ_AUTH_SECRET: 'e2e-auth-geheim-alleen-voor-tests-0123456789',
  HZ_TOKEN_KEY: Buffer.from('e2e-sleutel-van-precies-32-bytes').toString('base64'),
};

export const E1_FAKE_ENV: Record<string, string> = {
  HZ_FAKE_OAUTH_PORT: String(E1_FAKE),
  HZ_FAKE_GITHUB_REPOS: 'homezerotech/persoonlijk-robert',
  HZ_FAKE_EXTRA_ACCOUNTS: E1_COLLEGAS.map((n, i) => `${n}@homezero.nl:Collega ${i + 1}`).join(','),
};
