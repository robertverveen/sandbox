/**
 * Push naar de sync-motor (HZW-036, stuk E3): webhooks van Slack, Google Agenda en Gmail (Pub/Sub), en
 * NOTIFY hz_events van de worker -> SSE `invalidate` naar de browser van die collega.
 *
 * - Elke webhook wordt eerst gecontroleerd (Slack: handtekening + tijdstempel; Google: HMAC-token), dan
 *   ontdubbeld (sync_events) en zet alleen een run klaar. Inhoud van berichten wordt niet bewaard (P2).
 * - Alles wat binnenkomt is data, nooit een instructie.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import pg from 'pg';
import {
  EVENTS_CHANNEL,
  hookToken,
  recordSyncEvent,
  requestSync,
  userByAccount,
  userByChannel,
  usersBySlackChannel,
  usersWithJob,
  type Db,
} from '@hz/db';
import type { EventBus } from './events';

export interface SyncHookOptions {
  db: Db | null;
  /** Signing secret van de Slack-app (HZ_SLACK_SIGNING_SECRET). */
  slackSigningSecret?: string;
  /** Geheim voor Agenda- en Gmail-hooktokens (HZ_HOOK_SECRET). */
  hookSecret?: string;
  now?: () => number;
  /**
   * App-level token van de Slack-app (xapp-…, scope authorizations:read; HZ_SLACK_APP_TOKEN). Slack zet in een event
   * maar één collega in `authorizations`; apps.event.authorizations.list geeft alle collega's die het event zien.
   */
  slackAppToken?: string;
  /** Alleen voor tests: fetch vervangen. */
  fetchImpl?: typeof fetch;
  /** Ontkoppelen: token intrekken bij de bron en uit de database wissen. */
  revoke?: (userId: string, provider: string) => Promise<{ wiped?: string[] } | void>;
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Slack-handtekening v0 (HMAC-SHA256 over `v0:<ts>:<body>`), max. 5 minuten oud. */
export function verifySlackSignature(
  secret: string,
  ts: string | undefined,
  body: string,
  sig: string | undefined,
  nowMs = Date.now(),
) {
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const mine = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return safeEq(mine, sig);
}

type Env = { Variables: Record<string, unknown> };

export const SLACK_AUTHORIZATIONS_URL = 'https://slack.com/api/apps.event.authorizations.list';

/**
 * Alle Slack-gebruikers die dit event zien (apps.event.authorizations.list, gepagineerd). Het app-level token gaat in
 * de Authorization-header (verplicht volgens de Slack-documentatie). Fout of geen token: lege lijst (terugval).
 */
export async function slackEventAuthorizations(
  appToken: string,
  eventContext: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<string[]> {
  const out: string[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const res = await fetchImpl(SLACK_AUTHORIZATIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        event_context: eventContext,
        limit: '100',
        ...(cursor ? { cursor } : {}),
      }).toString(),
    });
    const j = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      authorizations?: Array<{ user_id?: string; is_bot?: boolean | string }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!j.ok) break;
    for (const a of j.authorizations ?? [])
      if (a.user_id && a.is_bot !== true && a.is_bot !== 'true') out.push(a.user_id);
    cursor = j.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return out;
}

export function registerSyncHooks<E extends Env>(app: Hono<E>, o: SyncHookOptions) {
  const now = o.now ?? Date.now;
  const off = (what: string) => ({
    error: 'unavailable',
    message: `${what} staat uit (geen database of geheim ingesteld)`,
  });

  app.post('/api/hooks/slack', async (c) => {
    if (!o.db || !o.slackSigningSecret) return c.json(off('Slack Events'), 503);
    const raw = await c.req.text();
    if (
      !verifySlackSignature(
        o.slackSigningSecret,
        c.req.header('x-slack-request-timestamp'),
        raw,
        c.req.header('x-slack-signature'),
        now(),
      )
    )
      return c.json({ error: 'forbidden', message: 'Ongeldige handtekening' }, 401);
    let body: {
      type?: string;
      challenge?: string;
      event_id?: string;
      event_context?: string;
      authorizations?: Array<{ user_id?: string }>;
      event?: {
        type?: string;
        channel?: string;
        ts?: string;
        user?: string;
        subtype?: string;
        event_ts?: string;
        item?: { channel?: string; ts?: string };
      };
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid', message: 'Geen JSON' }, 400);
    }
    if (body.type === 'url_verification') return c.json({ challenge: body.challenge ?? '' });
    if (body.type !== 'event_callback' || !body.event_id || !body.event) return c.json({ ok: true });
    const ev = body.event;
    const channel = ev.channel ?? ev.item?.channel;
    // Wie ziet dit event? Slack zet maar één installatie in `authorizations` (ook als het kanaal gedeeld is met
    // meer collega's). Daarom: (1) alle installaties via apps.event.authorizations.list (app-level token),
    // (2) collega's van wie de laatste sync dit kanaal kent (kanaal-id's als metadata in sync_jobs.push),
    // (3) kent niemand het kanaal (nieuw gesprek): alle collega's met een Slack-sync; hun run is een goedkope poll.
    const accounts = new Set(
      [...(body.authorizations ?? []).map((a) => a.user_id), ev.user].filter(Boolean) as string[],
    );
    if (o.slackAppToken && body.event_context)
      for (const u of await slackEventAuthorizations(o.slackAppToken, body.event_context, o.fetchImpl).catch(
        () => [] as string[],
      ))
        accounts.add(u);
    const targets = new Set<string>();
    for (const acc of accounts) {
      const userId = await userByAccount(o.db, 'slack', acc);
      if (userId) targets.add(userId);
    }
    if (channel) {
      const members = await usersBySlackChannel(o.db, channel);
      for (const u of members) targets.add(u);
      if (!members.length) for (const j of await usersWithJob(o.db, 'slack')) targets.add(j.userId);
    }
    for (const userId of targets) {
      // Alleen metadata, geen berichttekst.
      const payload = {
        type: ev.type,
        channel,
        ts: ev.ts ?? ev.item?.ts ?? ev.event_ts,
        user: ev.user,
        subtype: ev.subtype,
      };
      // Ontdubbelen per (event, collega): onafhankelijk van de volgorde of het aantal doelen, zodat een Slack-retry
      // met andere leden of in een andere volgorde niets dubbel verwerkt.
      const fresh = await recordSyncEvent(o.db, 'slack', `${body.event_id}:${userId}`, userId, payload);
      if (fresh) await requestSync(o.db, userId, 'slack');
    }
    return c.json({ ok: true });
  });

  app.post('/api/hooks/google/calendar', async (c) => {
    if (!o.db || !o.hookSecret) return c.json(off('Agenda-push'), 503);
    const id = c.req.header('x-goog-channel-id') ?? '';
    const token = c.req.header('x-goog-channel-token') ?? '';
    if (!id || !safeEq(token, hookToken(o.hookSecret, `calendar:${id}`)))
      return c.json({ error: 'forbidden', message: 'Onbekend kanaal' }, 401);
    const state = c.req.header('x-goog-resource-state');
    if (state === 'sync') return c.body(null, 200);
    const userId = await userByChannel(o.db, 'calendar', id);
    if (!userId) return c.body(null, 200);
    const n = c.req.header('x-goog-message-number') ?? String(now());
    if (await recordSyncEvent(o.db, 'calendar', `${id}:${n}`, userId, { state }))
      await requestSync(o.db, userId, 'calendar');
    return c.body(null, 200);
  });

  app.post('/api/hooks/google/gmail', async (c) => {
    if (!o.db || !o.hookSecret) return c.json(off('Gmail-push'), 503);
    if (!safeEq(c.req.query('token') ?? '', hookToken(o.hookSecret, 'gmail')))
      return c.json({ error: 'forbidden', message: 'Ongeldig token' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { message?: { data?: string; messageId?: string } };
    let data: { emailAddress?: string; historyId?: string | number } = {};
    try {
      data = JSON.parse(Buffer.from(body.message?.data ?? '', 'base64').toString('utf8'));
    } catch {
      return c.body(null, 204);
    }
    if (!data.emailAddress || !body.message?.messageId) return c.body(null, 204);
    const userId = await userByAccount(o.db, 'gmail', data.emailAddress);
    if (
      userId &&
      (await recordSyncEvent(o.db, 'gmail', body.message.messageId, userId, {
        historyId: String(data.historyId ?? ''),
      }))
    )
      await requestSync(o.db, userId, 'gmail');
    // Pub/Sub: 2xx = bevestigd (ook bij onbekende collega, anders blijft Google herhalen).
    return c.body(null, 204);
  });
}

/** NOTIFY hz_events (worker) -> SSE `invalidate` voor die collega. */
export async function listenSyncEvents(connectionString: string, bus: EventBus) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  client.on('notification', (n) => {
    if (n.channel !== EVENTS_CHANNEL || !n.payload) return;
    try {
      const { userId, keys } = JSON.parse(n.payload) as { userId: string; keys: string[] };
      if (typeof userId === 'string' && Array.isArray(keys)) bus.invalidate(userId, ...keys.map(String));
    } catch {
      /* ongeldige melding negeren */
    }
  });
  client.on('error', (e) => console.error(`[api] luisteren naar sync: ${e.message}`));
  await client.query(`LISTEN ${EVENTS_CHANNEL}`);
  return { close: () => client.end() };
}
