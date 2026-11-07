/** De nep-autorisatieserver zelf: discovery, eenmalige codes, PKCE en intrekken gedragen zich als de echte. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOAuth, type FakeOAuth } from '../src';

let f: FakeOAuth;
beforeAll(async () => {
  f = await startFakeOAuth();
});
afterAll(() => f.close());

const form = (o: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
  redirect: 'manual' as const,
});

async function code(extra: Record<string, string>) {
  const r = await fetch(
    `${f.url}/google/authorize`,
    form({ client_id: 'c', redirect_uri: 'http://app/cb', state: 's', account: 'robert', ...extra }),
  );
  return new URL(r.headers.get('location')!).searchParams.get('code')!;
}

describe('nep-autorisatieserver', () => {
  it('discovery wijst naar zichzelf; de accountkiezer toont de testaccounts', async () => {
    const d = (await (await fetch(`${f.issuer}/.well-known/openid-configuration`)).json()) as Record<string, string>;
    expect(d.issuer).toBe(f.issuer);
    expect(d.token_endpoint).toBe(`${f.url}/google/token`);
    const page = await (
      await fetch(`${f.url}/google/authorize?client_id=c&redirect_uri=http://app/cb&scope=openid%20email`)
    ).text();
    expect(page).toContain('robert@homezero.nl');
    expect(page).toContain('robert.prive@example.com');
  });

  it('PKCE wordt gecontroleerd en een code werkt maar één keer', async () => {
    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const c = await code({ code_challenge: challenge, code_challenge_method: 'S256', scope: 'openid email' });
    const bad = await fetch(
      `${f.url}/google/token`,
      form({
        grant_type: 'authorization_code',
        code: c,
        client_id: 'c',
        client_secret: 's',
        redirect_uri: 'http://app/cb',
        code_verifier: 'fout',
      }),
    );
    expect(bad.status).toBe(400);
    const c2 = await code({ code_challenge: challenge, code_challenge_method: 'S256', scope: 'openid email' });
    const ok = await fetch(
      `${f.url}/google/token`,
      form({
        grant_type: 'authorization_code',
        code: c2,
        client_id: 'c',
        client_secret: 's',
        redirect_uri: 'http://app/cb',
        code_verifier: verifier,
      }),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id_token?: string }).id_token).toBeTruthy();
    const again = await fetch(
      `${f.url}/google/token`,
      form({
        grant_type: 'authorization_code',
        code: c2,
        client_id: 'c',
        client_secret: 's',
        redirect_uri: 'http://app/cb',
        code_verifier: verifier,
      }),
    );
    expect(again.status).toBe(400);
  });

  it('intrekken maakt access en refresh token van die toestemming ongeldig', async () => {
    const c = await code({ scope: 'https://www.googleapis.com/auth/tasks', access_type: 'offline' });
    const t = (await (
      await fetch(
        `${f.url}/google/token`,
        form({
          grant_type: 'authorization_code',
          code: c,
          client_id: 'c',
          client_secret: 's',
          redirect_uri: 'http://app/cb',
        }),
      )
    ).json()) as { refresh_token: string; id_token?: string };
    expect(t.id_token).toBeUndefined();
    expect((await fetch(`${f.url}/google/revoke`, form({ token: t.refresh_token }))).status).toBe(200);
    const refresh = await fetch(
      `${f.url}/google/token`,
      form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: 'c', client_secret: 's' }),
    );
    expect(refresh.status).toBe(400);
  });

  it('Google trekt per client en gebruiker in: één token intrekken raakt Taken, Agenda en Gmail samen', async () => {
    async function grant(scope: string, client = 'c', account = 'robert') {
      const r = await fetch(
        `${f.url}/google/authorize`,
        form({ client_id: client, redirect_uri: 'http://app/cb', state: 's', account, scope, access_type: 'offline' }),
      );
      const c = new URL(r.headers.get('location')!).searchParams.get('code')!;
      const tok = await fetch(
        `${f.url}/google/token`,
        form({
          grant_type: 'authorization_code',
          code: c,
          client_id: client,
          client_secret: 's',
          redirect_uri: 'http://app/cb',
        }),
      );
      return ((await tok.json()) as { refresh_token: string }).refresh_token;
    }
    const refreshOk = async (rt: string, client = 'c') =>
      (
        await fetch(
          `${f.url}/google/token`,
          form({ grant_type: 'refresh_token', refresh_token: rt, client_id: client, client_secret: 's' }),
        )
      ).status === 200;
    const taken = await grant('https://www.googleapis.com/auth/tasks');
    const gmail = await grant('https://www.googleapis.com/auth/gmail.modify');
    const eigen = await grant('https://www.googleapis.com/auth/tasks', 'eigen-project');
    const lisanne = await grant('https://www.googleapis.com/auth/tasks', 'c', 'lisanne');
    expect((await fetch(`${f.url}/google/revoke`, form({ token: gmail }))).status).toBe(200);
    // Zelfde client en gebruiker: ook Taken is weg (zoals bij Google).
    expect(await refreshOk(taken)).toBe(false);
    // Andere client (eigen Google-project) of andere gebruiker: blijft werken.
    expect(await refreshOk(eigen, 'eigen-project')).toBe(true);
    expect(await refreshOk(lisanne)).toBe(true);
  });
});
