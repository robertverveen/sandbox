/**
 * HZW-033: het Slack-app-manifest in de repo (infra/slack/manifest.yml, HUMAN_INPUT stap C6) vraagt precies de
 * user-scopes en events die de code gebruikt, wijst naar de webhook van de API en bevat geen geheimen.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLACK_TODO_SCOPES, SLACK_USER_EVENTS, SLACK_USER_SCOPES } from '../../src';

const text = readFileSync(fileURLToPath(new URL('../../../../infra/slack/manifest.yml', import.meta.url)), 'utf8');
const lines = text.split('\n');

/** Actieve lijstitems (geen commentaar) direct onder een sleutel, op het inspringniveau van dat blok. */
function listUnder(key: string): string[] {
  const i = lines.findIndex((l) => l.trim() === `${key}:`);
  expect(i, `sleutel ${key} ontbreekt`).toBeGreaterThanOrEqual(0);
  const indent = lines[i]!.search(/\S/);
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (l.search(/\S/) <= indent && !l.trim().startsWith('- ')) break;
    const m = /^\s*-\s+(\S+)\s*$/.exec(l);
    if (m) out.push(m[1]!);
    else break;
  }
  return out;
}

describe('Slack-app-manifest (infra/slack/manifest.yml)', () => {
  it('user-scopes zijn precies die van de code; to-do-scopes staan uit tot het besluit over HZW-037', () => {
    expect(listUnder('user').sort()).toEqual([...SLACK_USER_SCOPES].sort());
    for (const s of SLACK_TODO_SCOPES) expect(text).toMatch(new RegExp(`#\\s*-\\s*${s}`));
    // Geen bot-scopes of bot-gebruiker: alleen een user token.
    expect(text).not.toMatch(/^\s*bot:/m);
    expect(text).not.toMatch(/bot_user:/);
  });

  it('events (nieuwe berichten) en de request-URL van de API; geen *_marked (bestaat niet in de Events API)', () => {
    expect(listUnder('user_events')).toEqual([...SLACK_USER_EVENTS]);
    expect(text).not.toMatch(/^\s*-\s*\w+_marked/m);
    expect(text).toMatch(/request_url: https:\/\/<domein>\/api\/hooks\/slack\s*$/m);
    expect(listUnder('redirect_urls')).toEqual(['https://<domein>/api/connections/slack/callback']);
    expect(text).toMatch(/socket_mode_enabled: false/);
  });

  it('bevat geen tokens of geheimen', () => {
    expect(text).not.toMatch(/xox[abposr]-[0-9A-Za-z-]{6,}|xapp-[0-9A-Za-z-]{6,}|\b[0-9a-f]{32}\b/i);
  });
});
