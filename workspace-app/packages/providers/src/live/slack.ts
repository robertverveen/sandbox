/**
 * HZW-033: Slack Web API met de user token van de interne app (live).
 *
 * - Kanalen, DM's en groepen waar de collega in zit (users.conversations), geschiedenis, threads, zoeken.
 * - Echte gelezen-status: per gesprek last_read uit conversations.info; gelezen en ongelezen zetten met
 *   conversations.mark, zodat het ook op Slack-mobiel klopt. De Events API kent geen *_marked-events (alleen RTM):
 *   gelezen op een ander apparaat komt binnen via pollReadState() in de worker (elke 3 minuten conversations.info
 *   voor de gesprekken die bij ons ongelezen staan, buiten de cache om).
 * - Rate limits (conversations.info en .history zijn tier 3, ~50/min per methode per app per workspace): elke
 *   ophaalronde heeft een budget en een kleine parallelliteit; een RateLimitError wordt nooit stil ingeslikt (een
 *   gesprek zonder stand zou dan als gelezen tonen), maar doorgegeven zodat de worker terugvalt.
 * - Versturen en reageren alleen na een klik van een mens (assertHumanAction); de worker en Claude doen dat
 *   nooit. Eigen workspace-emoji via emoji.list.
 * - Slack geeft HTTP 200 met {ok:false}; 429 met Retry-After is de rate limit.
 */
import type { Conversation, Message, SlackItem } from '@hz/shared';
import { addDays, toLocal, ymd } from '@hz/shared/logic';
import type { SlackProvider } from '../types';
import {
  AuthError,
  HttpClient,
  ProviderHttpError,
  RateLimitError,
  parseRetryAfter,
  type LiveCredentials,
} from './http';
import { MemorySyncStore, type SyncStore } from './store';
import { assertHumanAction } from './tokens';

export const SLACK_BASE = 'https://slack.com/api';
/** User-scopes van de interne Slack-app (infra/slack/manifest.yml; een test houdt die twee gelijk). */
export const SLACK_USER_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'channels:write',
  'groups:write',
  'im:write',
  'mpim:write',
  'chat:write',
  'reactions:read',
  'reactions:write',
  'search:read',
  'users:read',
  'emoji:read',
] as const;
/** Alleen voor Slack-to-do's (HZW-037, HZ_SLACK_TODOS=1). */
export const SLACK_TODO_SCOPES = ['reminders:read', 'reminders:write', 'lists:read'] as const;
/** User-events voor de Events API (nieuwe berichten; *_marked bestaat daar niet). */
export const SLACK_USER_EVENTS = ['message.channels', 'message.groups', 'message.im', 'message.mpim'] as const;
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

export interface SConv {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  user?: string;
  purpose?: { value?: string };
  topic?: { value?: string };
  last_read?: string;
  latest?: SMessage | null;
}
export interface SMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  thread_ts?: string;
  files?: Array<{ name?: string; title?: string }>;
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
}
export interface SUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string; email?: string };
}
interface ConvState {
  last_read?: string;
  latest_ts?: string;
  latest_user?: string;
  latest_text?: string;
  /** Laatste volledige verversing (conversations.info + history). */
  at: number;
  /** Laatste keer dat last_read uit Slack kwam (conversations.info of eigen mark). */
  readAt?: number;
  /** Een event meldde een nieuwer bericht dan de laatste volledige verversing (tekst nog niet opgehaald). */
  dirty?: boolean;
}

/** Ongelezen volgens de bekende stand: nieuwste bericht van een ander na de leescursor. */
const isUnread = (st: ConvState | null | undefined, me: string) =>
  !!(st?.latest_ts && st.latest_user !== me && (!st.last_read || parseFloat(st.latest_ts) > parseFloat(st.last_read)));

export const tsToLocal = (ts: string) => toLocal(new Date(Math.round(parseFloat(ts) * 1000)));
const userName = (u?: SUser) => u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name || '';

export function cleanText(s: string, users: Record<string, SUser> = {}) {
  return String(s || '')
    .replace(/<@([A-Z0-9]+)(\|[^>]+)?>/g, (_m, id: string) => '@' + (userName(users[id]) || id))
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export class LiveSlack implements SlackProvider {
  readonly mode = 'live' as const;
  readonly http: HttpClient;
  readonly store: SyncStore;
  private stateTtlMs: number;
  private maxStateFetch: number;
  private pollBudget: number;
  private concurrency: number;
  private now: () => Date;
  constructor(
    readonly creds: LiveCredentials,
    opts: {
      store?: SyncStore;
      base?: string;
      fetchImpl?: typeof fetch;
      stateTtlMs?: number;
      /** Max. gesprekken waarvan één API-verzoek de stand ophaalt (elk 2 tier-3-calls). */
      maxStateFetch?: number;
      /** Max. Slack-calls per worker-run in pollReadState(). */
      pollBudget?: number;
      /** Gelijktijdige Slack-calls bij het ophalen van standen. */
      concurrency?: number;
      now?: () => Date;
    } = {},
  ) {
    this.http = new HttpClient('slack', opts.base ?? SLACK_BASE, creds, opts.fetchImpl);
    this.store = opts.store ?? new MemorySyncStore();
    this.stateTtlMs = opts.stateTtlMs ?? 5 * 60_000;
    // Koude start: 20 gesprekken = 20x info + 20x history, onder de ~50/min van tier 3. De worker vult de rest aan.
    this.maxStateFetch = opts.maxStateFetch ?? 20;
    this.pollBudget = opts.pollBudget ?? 40;
    this.concurrency = Math.max(1, opts.concurrency ?? 3);
    this.now = opts.now ?? (() => new Date());
  }

  /** Slack-methode aanroepen; {ok:false} en 429 worden getypeerde fouten. */
  async call<T = Record<string, unknown>>(
    method: string,
    args: Record<string, unknown> = {},
    write = false,
  ): Promise<T> {
    const res = write
      ? await this.http.raw(`/${method}`, { method: 'POST', body: args, form: true })
      : await this.http.raw(`/${method}`, { query: args as Record<string, string> });
    if (res.status === 429) throw new RateLimitError('slack', parseRetryAfter(res.headers.get('retry-after')));
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
    if (!res.ok) throw await this.http.toError(res, data);
    if (!data.ok) {
      if (data.error === 'ratelimited')
        throw new RateLimitError('slack', parseRetryAfter(res.headers.get('retry-after')));
      if (AUTH_ERRORS.has(String(data.error))) {
        await this.creds.rejected?.('slack');
        throw new AuthError('slack', `Slack: ${data.error}`);
      }
      throw new ProviderHttpError('slack', 200, `${method}: ${data.error}`, data);
    }
    return data;
  }

  async self(): Promise<{ user_id: string; team_id: string; url?: string }> {
    const c = await this.store.get<{ user_id: string; team_id: string; url?: string }>('slack:self');
    if (c) return c;
    const r = await this.call<{ user_id: string; team_id: string; url?: string }>('auth.test');
    const v = { user_id: r.user_id, team_id: r.team_id, url: r.url };
    await this.store.set('slack:self', v);
    return v;
  }

  async users(): Promise<Record<string, SUser>> {
    const c = await this.store.get<{ at: number; users: Record<string, SUser> }>('slack:users');
    if (c && Date.now() - c.at < 24 * 3600_000) return c.users;
    const users: Record<string, SUser> = {};
    let cursor: string | undefined;
    do {
      const r = await this.call<{ members?: SUser[]; response_metadata?: { next_cursor?: string } }>('users.list', {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const u of r.members ?? [])
        users[u.id] = {
          id: u.id,
          name: u.name,
          real_name: u.real_name,
          is_bot: u.is_bot,
          profile: { display_name: u.profile?.display_name, real_name: u.profile?.real_name },
        };
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    await this.store.set('slack:users', { at: Date.now(), users });
    return users;
  }

  async rawConversations(): Promise<SConv[]> {
    const out: SConv[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call<{ channels?: SConv[]; response_metadata?: { next_cursor?: string } }>(
        'users.conversations',
        {
          types: 'public_channel,private_channel,mpim,im',
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
      );
      out.push(...(r.channels ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    await this.store.set('slack:convs', { at: Date.now(), list: out });
    return out;
  }

  private async convsCached(): Promise<SConv[]> {
    const c = await this.store.get<{ at: number; list: SConv[] }>('slack:convs');
    if (c && Date.now() - c.at < 15 * 60_000) return c.list;
    return this.rawConversations();
  }

  /** last_read en laatste bericht van één gesprek (conversations.info + history limit 1). */
  async refreshState(channelId: string): Promise<ConvState> {
    const [info, hist] = await Promise.all([
      this.call<{ channel: SConv }>('conversations.info', { channel: channelId }),
      this.call<{ messages?: SMessage[] }>('conversations.history', { channel: channelId, limit: 1 }),
    ]);
    const last = hist.messages?.[0];
    const now = Date.now();
    const st: ConvState = {
      last_read: info.channel.last_read,
      latest_ts: last?.ts,
      latest_user: last?.user ?? last?.username,
      latest_text: last?.text,
      at: now,
      readAt: now,
    };
    await this.store.set(`slack:state:${channelId}`, st);
    return st;
  }

  /** Alleen de leescursor opnieuw uit Slack (conversations.info), buiten de cache om; laatste bericht blijft. */
  async refreshLastRead(channelId: string): Promise<ConvState> {
    const info = await this.call<{ channel: SConv }>('conversations.info', { channel: channelId });
    const key = `slack:state:${channelId}`;
    const st = (await this.store.get<ConvState>(key)) ?? { at: 0 };
    const next: ConvState = { ...st, last_read: info.channel.last_read, readAt: Date.now() };
    await this.store.set(key, next);
    return next;
  }

  /**
   * Standen van een reeks gesprekken: uit de cache, en voor ontbrekende of verouderde standen opgehaald binnen een
   * budget (ontbrekend eerst, daarna de oudste), met beperkte parallelliteit. Rate limit: niets meer ophalen; heeft een
   * gesprek dan helemaal geen stand, of is `strict` gezet, dan gaat de RateLimitError door (nooit "gelezen" gokken).
   * Andere fouten per gesprek (bijv. channel_not_found): de oude stand blijven gebruiken.
   */
  private async states(
    ids: string[],
    opts: { fetch: boolean; budget?: number; strict?: boolean },
  ): Promise<Map<string, ConvState | null>> {
    const out = new Map<string, ConvState | null>();
    for (const id of ids) out.set(id, await this.store.get<ConvState>(`slack:state:${id}`));
    if (!opts.fetch) return out;
    const now = Date.now();
    const todo = ids
      .filter((id) => {
        const c = out.get(id);
        return !c || now - c.at >= this.stateTtlMs;
      })
      .sort((a, b) => (out.get(a)?.at ?? -1) - (out.get(b)?.at ?? -1))
      .slice(0, opts.budget ?? this.maxStateFetch);
    let limited: RateLimitError | null = null;
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, todo.length) }, async () => {
        for (let id = todo.shift(); id && !limited; id = todo.shift()) {
          try {
            out.set(id, await this.refreshState(id));
          } catch (e) {
            if (e instanceof RateLimitError) limited = e;
            else if (e instanceof AuthError) throw e;
          }
        }
      }),
    );
    if (limited && (opts.strict || ids.some((id) => !out.get(id)))) throw limited;
    return out;
  }

  /**
   * Worker-poll (elke 3 minuten): de enige manier om "gelezen op een ander apparaat" te zien, want de Events API
   * stuurt geen *_marked-events. Binnen `budget` Slack-calls, in deze volgorde:
   * 1. gesprekken die bij ons ongelezen staan: conversations.info (alleen last_read), altijd buiten de cache om
   *    (volledig als een event een nieuw bericht meldde waarvan we de tekst nog niet hebben, of als de stand
   *    verouderd is);
   * 2. gesprekken zonder stand: volledig (info + history);
   * 3. verouderde standen, oudste eerst: volledig. Zonder Slack Events (`events: false`) is dat elke stateTtl
   *    (nieuwe berichten komen alleen zo binnen); met Events elke 30 minuten (vangnet voor gemiste events en voor
   *    "ongelezen gezet" op een ander apparaat).
   * Een rate limit gaat door naar de worker (terugval volgens Retry-After); wat al binnen was, blijft bewaard.
   */
  async pollReadState(
    opts: { events?: boolean; channels?: string[]; budget?: number } = {},
  ): Promise<{ read: number; full: number }> {
    const me = (await this.self()).user_id;
    let convs = await this.convsCached();
    // Een event uit een gesprek dat we nog niet kennen (nieuwe DM, net toegevoegd aan een kanaal): lijst verversen.
    if (opts.channels?.some((ch) => !convs.some((c) => c.id === ch))) convs = await this.rawConversations();
    const ids = convs.map((c) => c.id);
    const cached = new Map<string, ConvState | null>();
    for (const id of ids) cached.set(id, await this.store.get<ConvState>(`slack:state:${id}`));
    const now = Date.now();
    const staleMs = opts.events ? 30 * 60_000 : this.stateTtlMs;
    const readOf = (id: string) => cached.get(id)?.readAt ?? cached.get(id)?.at ?? 0;
    const unread = ids.filter((id) => isUnread(cached.get(id), me)).sort((a, b) => readOf(a) - readOf(b));
    const missing = ids.filter((id) => !cached.get(id));
    const stale = ids
      .filter((id) => {
        const c = cached.get(id);
        return c && !unread.includes(id) && now - c.at >= staleMs;
      })
      .sort((a, b) => cached.get(a)!.at - cached.get(b)!.at);
    const plan: Array<{ id: string; cost: number; run: () => Promise<unknown> }> = [];
    let budget = opts.budget ?? this.pollBudget;
    const add = (id: string, full: boolean) => {
      const cost = full ? 2 : 1;
      if (cost > budget) return;
      budget -= cost;
      plan.push({ id, cost, run: () => (full ? this.refreshState(id) : this.refreshLastRead(id)) });
    };
    for (const id of unread) add(id, !!cached.get(id)?.dirty || now - cached.get(id)!.at >= staleMs);
    for (const id of missing) add(id, true);
    for (const id of stale) add(id, true);
    let limited: RateLimitError | null = null;
    const done = { read: 0, full: 0 };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, plan.length) }, async () => {
        for (let p = plan.shift(); p && !limited; p = plan.shift()) {
          try {
            await p.run();
            if (p.cost === 1) done.read++;
            else done.full++;
          } catch (e) {
            if (e instanceof RateLimitError) limited = e;
            else if (e instanceof AuthError) throw e;
          }
        }
      }),
    );
    if (limited) throw limited;
    return done;
  }

  private convName(c: SConv, users: Record<string, SUser>) {
    if (c.is_im) return userName(users[c.user ?? '']) || c.user || 'DM';
    if (c.is_mpim) return (c.purpose?.value || c.name || 'Groep').replace(/^Group messaging with:\s*/i, '');
    return '#' + (c.name ?? c.id);
  }

  /**
   * Gesprekken met echte ongelezen-status. `fetch: false` (worker, na pollReadState): alleen de bewaarde standen,
   * geen Slack-calls per gesprek. Standaard haalt een verzoek ontbrekende of verouderde standen op binnen
   * maxStateFetch.
   */
  async listConversations(opts: { fetch?: boolean } = {}): Promise<Conversation[]> {
    const [convs, users, me] = await Promise.all([this.convsCached(), this.users(), this.self()]);
    const out: Conversation[] = [];
    const states = await this.states(
      convs.map((c) => c.id),
      { fetch: opts.fetch !== false },
    );
    for (const c of convs) {
      const st = states.get(c.id);
      const unread = isUnread(st, me.user_id);
      const who = st?.latest_user === me.user_id ? 'jij' : userName(users[st?.latest_user ?? '']) || '';
      out.push({
        key: 'sl:' + c.id,
        kind: c.is_im ? 'dm' : c.is_mpim ? 'group' : 'ch',
        name: this.convName(c, users),
        purpose: c.purpose?.value || undefined,
        unread,
        time: st?.latest_ts ? tsToLocal(st.latest_ts) : undefined,
        preview: st?.latest_text
          ? `${who ? who + ': ' : ''}${cleanText(st.latest_text, users).replace(/\s+/g, ' ')}`.slice(0, 200)
          : c.purpose?.value || undefined,
        entities: [],
      });
    }
    return out.sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
  }

  private toMessage(m: SMessage, users: Record<string, SUser>, me: string): Message {
    return {
      ts: m.ts,
      time: tsToLocal(m.ts),
      fromName: userName(users[m.user ?? '']) || m.username || (m.bot_id ? 'Bot' : (m.user ?? '')),
      fromId: m.user ?? m.bot_id ?? '',
      me: m.user === me,
      bot: !!m.bot_id || m.subtype === 'bot_message',
      text: m.text ?? '',
      replies: m.reply_count ?? 0,
      ...(m.latest_reply ? { latest: m.latest_reply } : {}),
      files: (m.files ?? []).map((f) => f.name || f.title || 'bestand'),
      reactions: (m.reactions ?? []).map((r) => ({ name: r.name, count: r.count, mine: !!r.users?.includes(me) })),
    };
  }

  async history(channelId: string): Promise<Message[]> {
    const [r, users, me] = await Promise.all([
      this.call<{ messages?: SMessage[] }>('conversations.history', { channel: channelId, limit: 100 }),
      this.users(),
      this.self(),
    ]);
    return (r.messages ?? [])
      .filter((m) => !['channel_join', 'channel_leave'].includes(m.subtype ?? ''))
      .map((m) => this.toMessage(m, users, me.user_id))
      .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  }

  async thread(channelId: string, ts: string): Promise<Message[]> {
    const [r, users, me] = await Promise.all([
      this.call<{ messages?: SMessage[] }>('conversations.replies', { channel: channelId, ts, limit: 200 }),
      this.users(),
      this.self(),
    ]);
    return (r.messages ?? []).map((m) => this.toMessage(m, users, me.user_id));
  }

  /** Zoeken (search.messages, user token met search:read). */
  async search(query: string, count = 50) {
    const r = await this.call<{
      messages?: {
        matches?: Array<{
          ts: string;
          text?: string;
          user?: string;
          username?: string;
          permalink?: string;
          channel?: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean };
        }>;
      };
    }>('search.messages', { query, count, sort: 'timestamp' });
    return r.messages?.matches ?? [];
  }

  /** DM's aan mij, vermeldingen en eigen 📣-markeringen (zoals de prototype-watches), met echte gelezen-status. */
  async attention(): Promise<SlackItem[]> {
    const [me, users] = await Promise.all([this.self(), this.users()]);
    const since = ymd(addDays(this.now(), -7));
    const [dm, mention, mega] = await Promise.all([
      this.search(`to:me after:${since}`),
      this.search(`<@${me.user_id}> after:${since}`),
      this.search('hasmy::mega:', 30),
    ]);
    const seen = new Map<string, SlackItem>();
    const add = (list: typeof dm, flag: 'dm' | 'mention' | 'mega') => {
      for (const m of list) {
        if (!m.channel?.id) continue;
        const id = `sl:${m.channel.id}:${m.ts}`;
        const prev = seen.get(id);
        if (prev) {
          prev[flag] = true;
          continue;
        }
        const isDm = !!m.channel.is_im || !!m.channel.is_mpim;
        const fromName = userName(users[m.user ?? '']) || m.username || m.user || '';
        seen.set(id, {
          id,
          type: 'slack',
          channel: isDm ? `DM ${fromName}` : '#' + (m.channel.name ?? m.channel.id),
          channelId: m.channel.id,
          ts: m.ts,
          fromName,
          fromId: m.user ?? '',
          time: tsToLocal(m.ts),
          fromMe: m.user === me.user_id,
          [flag]: true,
          ...(isDm ? { dm: true } : {}),
          title: cleanText(m.text ?? '', users)
            .replace(/\s+/g, ' ')
            .slice(0, 300),
          body: cleanText(m.text ?? '', users),
          entities: [],
          url: m.permalink ?? null,
        } as SlackItem);
      }
    };
    add(dm, 'dm');
    add(mention, 'mention');
    add(mega, 'mega');
    const items = [...seen.values()];
    // Echte gelezen-status uit Slack: ts <= last_read van dat gesprek. Rate limit zonder bekende stand: doorgeven.
    const states = await this.states([...new Set(items.map((i) => i.channelId!))], { fetch: true });
    for (const it of items) {
      const st = states.get(it.channelId!);
      if (st?.last_read) it.read = parseFloat(it.ts!) <= parseFloat(st.last_read);
    }
    return items.sort((a, b) => b.time.localeCompare(a.time));
  }

  /**
   * Leescursor in Slack zetten (conversations.mark): alles tot en met ts is gelezen, alles erna ongelezen, ook op
   * Slack-mobiel. Voor ongelezen zetten geeft de API de ts van het bericht vóór het eerste ongelezen bericht mee.
   */
  async markRead(channelId: string, ts: string): Promise<void> {
    await this.call('conversations.mark', { channel: channelId, ts }, true);
    // De leescursor staat in Slack nu precies op ts, ook als die terug ging (ongelezen zetten). Dus altijd ts
    // overnemen; `at` blijft staan (het laatste bericht is niet opnieuw opgehaald).
    const key = `slack:state:${channelId}`;
    const st = (await this.store.get<ConvState>(key)) ?? { at: 0 };
    await this.store.set(key, { ...st, last_read: ts, readAt: Date.now() });
  }

  /** Versturen: alleen na een klik van een mens (de app en Claude maken alleen concepten). */
  async postMessage(channelId: string, text: string, threadTs?: string): Promise<{ ts: string }> {
    assertHumanAction('slack', 'een bericht versturen');
    const r = await this.call<{ ts: string }>(
      'chat.postMessage',
      { channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) },
      true,
    );
    return { ts: r.ts };
  }

  async react(channelId: string, ts: string, name: string): Promise<void> {
    assertHumanAction('slack', 'een reactie plaatsen');
    try {
      await this.call('reactions.add', { channel: channelId, timestamp: ts, name: name.replace(/:/g, '') }, true);
    } catch (e) {
      if (e instanceof ProviderHttpError && /already_reacted/.test(e.message)) return;
      throw e;
    }
  }

  /** Eigen workspace-emoji (naam -> plaatje of alias:…). */
  async customEmoji(): Promise<Record<string, string>> {
    const c = await this.store.get<{ at: number; emoji: Record<string, string> }>('slack:emoji');
    if (c && Date.now() - c.at < 24 * 3600_000) return c.emoji;
    const r = await this.call<{ emoji?: Record<string, string> }>('emoji.list');
    await this.store.set('slack:emoji', { at: Date.now(), emoji: r.emoji ?? {} });
    return r.emoji ?? {};
  }

  /**
   * Events API (de sync-motor geeft events door, na handtekeningcontrole en ontdubbelen): nieuw bericht -> laatste
   * bericht bijwerken. *_marked (channel_marked, im_marked, ...) bestaat alleen in RTM, niet in de Events API; het
   * wordt hier toch verwerkt als het ooit binnenkomt, maar gelezen-elders hangt af van pollReadState().
   * Geeft terug of er iets veranderde.
   */
  async applyEvent(ev: {
    type: string;
    channel?: string;
    ts?: string;
    user?: string;
    text?: string;
    subtype?: string;
  }): Promise<boolean> {
    if (!ev.channel) return false;
    const key = `slack:state:${ev.channel}`;
    const st = (await this.store.get<ConvState>(key)) ?? { at: 0 };
    if (/_marked$/.test(ev.type) && ev.ts) {
      st.last_read = ev.ts;
      await this.store.set(key, st);
      return true;
    }
    if (ev.type === 'message' && ev.ts && !ev.subtype) {
      if (!st.latest_ts || parseFloat(ev.ts) > parseFloat(st.latest_ts)) {
        st.latest_ts = ev.ts;
        st.latest_user = ev.user;
        st.latest_text = ev.text;
        // De webhook bewaart geen berichttekst: de volgende poll haalt het bericht zelf op.
        if (ev.text === undefined) st.dirty = true;
      }
      await this.store.set(key, st);
      return true;
    }
    return false;
  }
}
