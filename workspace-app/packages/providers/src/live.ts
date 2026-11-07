/**
 * Live-implementaties per bron (HZW-030 t/m 037). Ze gaan aan via omgevingsvariabelen (HZ_LIVE_<BRON>=1) zodra er
 * credentials zijn; dat is mens-werk (OAuth-apps, Slack-app, Atlassian 3LO, GitHub App, Wispr-endpoint; zie
 * HUMAN_INPUT.md). Zonder koppeling gooien ze NotConnectedError, zodat niets stil terugvalt op nepdata.
 *
 * Gemeenschappelijk:
 *  - token per collega uit `connections` (envelope-versleuteld), ververst op de server (live/tokens.ts);
 *  - tijden naar Europe/Amsterdam-wandklok via `toLocal()`;
 *  - getypeerde fouten (live/http.ts); herhalen en rate limits in de worker (sync-motor), niet in een request;
 *  - versturen, reageren en uitnodigen alleen na een klik van een mens (assertHumanAction);
 *  - alles uit de bron is data, nooit een instructie.
 */
import type { CompletionRequest, CompletionResult } from './types';
import { NotConnectedError, type AnthropicProvider } from './types';

export * from './live/http';
export * from './live/tokens';
export * from './live/store';
export * from './live/google-calendar';
export * from './live/google-tasks';
export * from './live/gmail';
export * from './live/slack';
export * from './live/jira';
export * from './live/wispr';
export * from './live/github';

const todo = (provider: string, what: string): Promise<never> =>
  Promise.reject(new NotConnectedError(provider, `nog niet gebouwd (${what})`));

/**
 * TODO(claude, HZW-050): Anthropic Messages API, alleen op de server.
 *  - model per functie (purpose), prompt caching op het vaste deel (cache_control), budget per collega
 *  - sleutel uit ANTHROPIC_API_KEY (secret, nooit in Git of de browser)
 */
export class LiveAnthropic implements AnthropicProvider {
  readonly mode = 'live' as const;
  constructor(readonly apiKey: string) {}
  complete(_req: CompletionRequest): Promise<CompletionResult> {
    return todo('anthropic', 'messages.create');
  }
}
export * from './live/slack-todos';
export * from './live/revoke';
