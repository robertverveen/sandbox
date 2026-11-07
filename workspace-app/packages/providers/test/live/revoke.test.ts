/** Ontkoppelen trekt het token in bij Google en Slack (nep-endpoints in msw). */
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { GOOGLE_REVOKE_URL, SLACK_REVOKE_URL, revokeToken } from '../../src';
import { mockServer } from './msw';

const { requests } = mockServer(
  http.post(GOOGLE_REVOKE_URL, async ({ request }) =>
    new URLSearchParams(await request.text()).get('token') === '1//refresh'
      ? new HttpResponse(null, { status: 200 })
      : HttpResponse.json({ error: 'invalid_token' }, { status: 400 }),
  ),
  http.post(SLACK_REVOKE_URL, () => HttpResponse.json({ ok: true, revoked: true })),
);

describe('token intrekken bij ontkoppelen', () => {
  it('Google: de refresh token (één intrekking voor Agenda, Taken en Gmail)', async () => {
    expect(await revokeToken('gmail', JSON.stringify({ access_token: 'ya29.x', refresh_token: '1//refresh' }))).toBe(
      'revoked',
    );
    expect(await revokeToken('calendar', JSON.stringify({ access_token: 'ya29.onbekend' }))).toBe('failed');
  });
  it('Slack: auth.revoke met het user token', async () => {
    expect(await revokeToken('slack', 'xoxp-test')).toBe('revoked');
    expect(requests.find((r) => r.url.href === SLACK_REVOKE_URL)!.headers.get('authorization')).toBe(
      'Bearer xoxp-test',
    );
  });
  it('Jira en GitHub: geen intrekking met alleen het token (token wordt wel gewist)', async () => {
    expect(await revokeToken('jira', '{"access_token":"a"}')).toBe('not_supported');
    expect(await revokeToken('github', 'ghu_x')).toBe('not_supported');
  });
});
