/**
 * Tokens per collega: verversen met de refresh token (op de server), opslaan, gelijktijdige verversingen delen,
 * geweigerd verversen -> opnieuw koppelen. Nep-tokenendpoint in msw.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  MemoryTokenStore,
  NotConnectedError,
  createUserCredentials,
  oauthClientsFromEnv,
  parseStoredToken,
  withUserScope,
} from '../../src';
import { mockServer } from './msw';

const TOKEN_URL = 'https://oauth.test.invalid/token';
let refreshes = 0;
const { server, requests } = mockServer(
  http.post(TOKEN_URL, async ({ request }) => {
    refreshes++;
    const b = Object.fromEntries(new URLSearchParams(await request.text()));
    if (b.refresh_token !== '1//goed') return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    return HttpResponse.json({
      access_token: `ya29.nieuw${refreshes}`,
      expires_in: 3599,
      scope: 'tasks calendar',
      token_type: 'Bearer',
    });
  }),
);

const clients = oauthClientsFromEnv({
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'geheim',
  GOOGLE_TOKEN_URL: TOKEN_URL,
});
const NOW = 1_800_000_000_000;

describe('tokens per collega', () => {
  it('kaal token en JSON-token', () => {
    expect(parseStoredToken('xoxp-1')).toEqual({ access_token: 'xoxp-1' });
    expect(parseStoredToken('{"access_token":"a","refresh_token":"r"}')).toMatchObject({ refresh_token: 'r' });
  });

  it('verlopen token wordt ververst en versleuteld opgeslagen (via de store); gelijktijdig één call', async () => {
    refreshes = 0;
    const store = new MemoryTokenStore().set('u1', 'google_tasks', {
      access_token: 'oud',
      refresh_token: '1//goed',
      expires_at: NOW - 1000,
    });
    const c = createUserCredentials({ store, clients, now: () => NOW });
    const [a, b] = await withUserScope('u1', () =>
      Promise.all([c.accessToken('google_tasks'), c.accessToken('google_tasks')]),
    );
    expect(a).toBe('ya29.nieuw1');
    expect(b).toBe('ya29.nieuw1');
    expect(refreshes).toBe(1);
    const saved = parseStoredToken((await store.load('u1', 'google_tasks'))!);
    expect(saved).toMatchObject({ access_token: 'ya29.nieuw1', refresh_token: '1//goed', expires_at: NOW + 3599_000 });
    expect(requests.at(-1)!.body).toMatchObject({ grant_type: 'refresh_token', client_id: 'cid' });
  });

  it('geldig token: geen refresh', async () => {
    refreshes = 0;
    const store = new MemoryTokenStore().set('u1', 'calendar', {
      access_token: 'vers',
      refresh_token: '1//goed',
      expires_at: NOW + 3600_000,
    });
    expect(await createUserCredentials({ store, clients, userId: 'u1', now: () => NOW }).accessToken('calendar')).toBe(
      'vers',
    );
    expect(refreshes).toBe(0);
  });

  it('Google-bronnen mogen één gedeelde koppeling "google" gebruiken', async () => {
    const store = new MemoryTokenStore().set('u1', 'google', { access_token: 'gedeeld' });
    expect(await createUserCredentials({ store, userId: 'u1' }).accessToken('gmail')).toBe('gedeeld');
  });

  it('401 op een Google-bron zonder eigen rij keurt de gedeelde koppeling "google" af (die rij bestaat echt)', async () => {
    const store = new MemoryTokenStore().set('u1', 'google', { access_token: 'gedeeld' }).set('u1', 'slack', 'xoxp-1');
    const c = createUserCredentials({ store, userId: 'u1' });
    await c.rejected!('calendar');
    await c.rejected!('slack');
    const own = new MemoryTokenStore().set('u1', 'gmail', { access_token: 'eigen' }).set('u1', 'google', 'x');
    await createUserCredentials({ store: own, userId: 'u1' }).rejected!('gmail');
    expect(store.reauth.map((r) => r.provider)).toEqual(['google', 'slack']);
    expect(own.reauth.map((r) => r.provider)).toEqual(['gmail']);
  });

  it('geweigerd verversen: koppeling op opnieuw koppelen, AuthError', async () => {
    const store = new MemoryTokenStore().set('u1', 'calendar', {
      access_token: 'oud',
      refresh_token: '1//ingetrokken',
      expires_at: NOW - 1,
    });
    const c = createUserCredentials({ store, clients, userId: 'u1', now: () => NOW });
    await expect(c.accessToken('calendar')).rejects.toBeInstanceOf(AuthError);
    expect(store.reauth).toEqual([{ userId: 'u1', provider: 'calendar', reason: 'invalid_grant' }]);
  });

  it('niet gekoppeld of geen collega: NotConnectedError; collega A krijgt nooit het token van B', async () => {
    const store = new MemoryTokenStore().set('b', 'slack', 'xoxp-van-b');
    const c = createUserCredentials({ store });
    await expect(c.accessToken('slack')).rejects.toBeInstanceOf(NotConnectedError);
    await expect(withUserScope('a', () => c.accessToken('slack'))).rejects.toBeInstanceOf(NotConnectedError);
    expect(await withUserScope('b', () => c.accessToken('slack'))).toBe('xoxp-van-b');
    void server;
  });
});
