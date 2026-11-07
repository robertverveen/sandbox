/**
 * HZW-035: meetings. Contextlaag eerst, live Wispr alleen voor wat na de laatste nachtrun kwam.
 *
 * - De persoonlijke nachtdienst zet meetings in `partners/<slug>/meetings/` (met meeting_id en bron).
 * - LiveWispr praat met de Wispr Flow MCP-server (streamable HTTP, JSON-RPC `tools/call search_meetings`);
 *   Wispr heeft geen andere publieke API. Endpoint en OAuth-token zijn mens-werk (HUMAN_INPUT).
 * - ContextFirstWispr voegt beide samen: alles uit de laag (verwerkt) plus live alles van na de laatste
 *   nachtrun (tijdstip uit `_systeem/routines/<voornaam>.md`); dubbele meetings worden er één.
 */
import type { RecItem } from '@hz/shared';
import { amsterdamToInstant, pd, toLocal } from '@hz/shared/logic';
import { liveWindow, parseHeartbeatLine, type NightRun } from '@hz/context';
import type { ContextProvider, WisprProvider } from '../types';
import { isLayerAware } from '../context';
import { NotConnectedError } from '../types';
import { HttpClient, ProviderHttpError, type LiveCredentials } from './http';

export interface WisprMeeting {
  id: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  has_transcript?: boolean;
  share_link?: string;
  content_excerpt?: string;
  calendar_event_id?: string;
}

const toWall = (s?: string) => (!s ? '' : /(Z|[+-]\d\d:?\d\d)$/.test(s) ? toLocal(new Date(s)) : s.slice(0, 16));

export function mapWispr(m: WisprMeeting): RecItem {
  const start = toWall(m.start);
  return {
    id: 'wm:' + m.id,
    type: 'rec',
    rawId: m.id,
    title: m.title || 'Meeting',
    start,
    end: toWall(m.end) || start,
    attendeeNames: m.attendees ?? [],
    transcript: m.has_transcript,
    entities: [],
    url: m.share_link ?? null,
  };
}

/** Minimale MCP-client (streamable HTTP): initialize, daarna tools/call. Antwoord als JSON of als SSE. */
export class McpHttpClient {
  private session: string | null = null;
  private seq = 0;
  constructor(readonly http: HttpClient) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const res = await this.http.raw('', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.seq, method, params },
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const text = await res.text();
    if (!res.ok) throw await this.http.toError(res, text);
    if (notify || !text) return null;
    const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split(/\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5).trim()) as { id?: number; result?: unknown; error?: { message?: string } })
          .find((m) => m.id !== undefined)
      : (JSON.parse(text) as { result?: unknown; error?: { message?: string } });
    if (!json) throw new ProviderHttpError(this.http.provider, 502, `${method}: leeg antwoord`);
    if (json.error) throw new ProviderHttpError(this.http.provider, 502, `${method}: ${json.error.message ?? 'fout'}`);
    return json.result;
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.session) {
      await this.rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'homezero-workspace', version: '0.1.0' },
      });
      await this.rpc('notifications/initialized', {}, true);
    }
    const r = (await this.rpc('tools/call', { name, arguments: args })) as {
      structuredContent?: T;
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (r?.isError) throw new ProviderHttpError(this.http.provider, 502, `${name}: ${r.content?.[0]?.text ?? 'fout'}`);
    if (r?.structuredContent) return r.structuredContent;
    const text = r?.content?.find((c) => c.type === 'text')?.text ?? '{}';
    return JSON.parse(text) as T;
  }
}

export class LiveWispr implements WisprProvider {
  static PAGE = 100;
  static MAX_PAGES = 10;
  readonly mode = 'live' as const;
  readonly mcp: McpHttpClient | null;
  constructor(
    readonly creds: LiveCredentials,
    opts: { url?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.mcp = opts.url ? new McpHttpClient(new HttpClient('wispr', opts.url, creds, opts.fetchImpl)) : null;
  }

  /** Meetings vanaf `since` (wandklok of datum, Europe/Amsterdam). */
  async listMeetings(since: string): Promise<RecItem[]> {
    if (!this.mcp) throw new NotConnectedError('wispr', 'geen MCP-endpoint (HZ_WISPR_MCP_URL)');
    const iso = /(Z|[+-]\d\d:?\d\d)$/.test(since) ? since : amsterdamToInstant(since).toISOString();
    // search_meetings pagineert (nieuwste eerst): has_more + next_cursor volgen tot het einde (Wispr kapt af op 1000).
    const all: WisprMeeting[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LiveWispr.MAX_PAGES; page++) {
      const r = await this.mcp.callTool<{ meetings?: WisprMeeting[]; has_more?: boolean; next_cursor?: string | null }>(
        'search_meetings',
        { since: iso, limit: LiveWispr.PAGE, ...(cursor ? { cursor } : {}) },
      );
      all.push(...(r.meetings ?? []));
      if (!r.has_more || !r.next_cursor || r.next_cursor === cursor) break;
      cursor = r.next_cursor;
    }
    const seen = new Set<string>();
    return all
      .filter((m) => !seen.has(m.id) && !!seen.add(m.id))
      .map(mapWispr)
      .filter((m) => m.start >= toWall(iso).slice(0, m.start.length));
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Meetings uit de laag van deze collega (opgenomen_door = voornaam) vanaf een datum. */
export async function layerMeetings(context: ContextProvider, owner: string, since: string): Promise<RecItem[]> {
  const snap = await context.snapshot();
  const me = owner.toLowerCase();
  const out: RecItem[] = [];
  for (const p of Object.values(snap.partners))
    for (const m of p.meetings ?? []) {
      if (!m.datum || m.datum < since.slice(0, 10)) continue;
      if (m.opgenomen_door && !m.opgenomen_door.toLowerCase().startsWith(me)) continue;
      const rawId = m.meeting_id || `${p.slug}/${m.bestand}`;
      out.push({
        id: 'wm:' + rawId,
        type: 'rec',
        rawId,
        title: `${p.naam} · ${m.titel}`,
        start: m.datum,
        end: m.datum,
        attendeeNames: [],
        processed: true,
        entities: [p.slug],
        url: /^https?:\/\//.test(m.bron) ? m.bron : null,
      });
    }
  return out;
}

export interface ContextFirstOptions {
  /** Voornaam van de ingelogde collega (uit de scope), per aanroep: elke collega eigen meetings en eigen nachtrun. */
  owner: string | (() => string);
  /**
   * De collega van wie de snapshot-status is (HZ_OWNER). Alleen voor hem geldt status.nachtdienst; een contextbron
   * die de heartbeats zelf kan lezen (repo, GitHub) leest `_systeem/routines/<voornaam>.md` van de collega zelf.
   */
  statusOwner?: string;
  now: () => Date;
}

/**
 * Laag + live: alles uit de laag, plus live Wispr voor wat na de laatste geslaagde nachtrun kwam (groter venster
 * als een nacht mist). Zonder Wispr-koppeling alleen de laag.
 */
export class ContextFirstWispr implements WisprProvider {
  readonly mode: 'fixture' | 'live';
  lastWindow: { since: Date; basis: string; missedNight: boolean } | null = null;
  constructor(
    readonly live: WisprProvider,
    readonly context: ContextProvider,
    readonly o: ContextFirstOptions,
  ) {
    this.mode = live.mode;
  }

  owner(): string {
    return typeof this.o.owner === 'function' ? this.o.owner() : this.o.owner;
  }

  /** Nachtruns van de persoonlijke nachtdienst van deze collega (nieuwste eerst). */
  async nightRuns(owner: string): Promise<NightRun[]> {
    if (isLayerAware(this.context)) return this.context.nightRuns(owner.toLowerCase());
    const snap = await this.context.snapshot();
    const same = (this.o.statusOwner ?? owner).toLowerCase() === owner.toLowerCase();
    const run = same && snap.status?.nachtdienst ? parseHeartbeatLine(snap.status.nachtdienst) : null;
    return run ? [run] : [];
  }

  async listMeetings(since: string): Promise<RecItem[]> {
    const owner = this.owner();
    const win = liveWindow(await this.nightRuns(owner), this.o.now());
    this.lastWindow = { since: win.since, basis: win.basis, missedNight: win.missedNight };
    const askedFrom = amsterdamToInstant(since.length === 10 ? since : since.slice(0, 16));
    const liveFrom = new Date(Math.max(+askedFrom, +win.since));
    const [layer, live] = await Promise.all([
      layerMeetings(this.context, owner, since),
      this.live.listMeetings(toLocal(liveFrom)).catch((e) => {
        if (e instanceof NotConnectedError) return [] as RecItem[];
        throw e;
      }),
    ]);
    const out: RecItem[] = [];
    const layerLeft = [...layer];
    for (const m of live) {
      const i = layerLeft.findIndex(
        (l) =>
          l.rawId === m.rawId ||
          (!!l.url && !!m.url && l.url === m.url) ||
          (l.start.slice(0, 10) === m.start.slice(0, 10) &&
            norm(l.title.split(' · ').slice(1).join(' ')).length > 3 &&
            norm(m.title).includes(norm(l.title.split(' · ').slice(1).join(' ')))),
      );
      if (i >= 0) {
        const l = layerLeft.splice(i, 1)[0]!;
        out.push({ ...m, processed: true, entities: m.entities.length ? m.entities : l.entities });
      } else out.push(m);
    }
    return [...out, ...layerLeft].sort((a, b) => +pd(b.start) - +pd(a.start));
  }
}
