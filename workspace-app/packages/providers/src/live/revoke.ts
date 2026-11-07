/**
 * Ontkoppelen trekt het token in bij de bron (keuze 06, HZW-014): Google (één endpoint voor Agenda, Taken en
 * Gmail) en Slack (auth.revoke). Atlassian 3LO en GitHub hebben geen eenvoudige intrekking met alleen het token;
 * daar wist de app het token en verloopt het vanzelf (Atlassian: max. 90 dagen refresh) of trekt de collega de
 * app in bij GitHub. Fouten bij intrekken blokkeren het ontkoppelen nooit: het token gaat hoe dan ook weg.
 */
import { OAUTH_FAMILY, parseStoredToken } from './tokens';

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const SLACK_REVOKE_URL = 'https://slack.com/api/auth.revoke';

export async function revokeToken(
  provider: string,
  stored: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<'revoked' | 'not_supported' | 'failed'> {
  const t = parseStoredToken(stored);
  const fam = OAUTH_FAMILY[provider] ?? provider;
  try {
    if (fam === 'google') {
      // De refresh token intrekken trekt ook de bijbehorende access tokens in.
      const res = await fetchImpl(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }).toString(),
      });
      return res.ok ? 'revoked' : 'failed';
    }
    if (fam === 'slack') {
      const res = await fetchImpl(SLACK_REVOKE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.access_token}` },
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; revoked?: boolean };
      return j.ok && j.revoked !== false ? 'revoked' : 'failed';
    }
    return 'not_supported';
  } catch {
    return 'failed';
  }
}
