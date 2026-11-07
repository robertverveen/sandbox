/**
 * HZW-031: Gmail API v1 (live, optioneel per collega).
 *
 * - Threads in de inbox, volledige thread (datums uit de Date-header, niet uit internalDate), gelezen en
 *   ongelezen zetten (threads.modify UNREAD, terug te draaien).
 * - Antwoorden: de app verstuurt NOOIT zelf. reply() zet een concept klaar in Gmail (drafts.create, in de thread,
 *   met de handtekening van het primaire afzenderadres); de collega verstuurt het zelf.
 * - Mailtekst wordt live opgehaald en niet opgeslagen (P2); de sync bewaart alleen de historyId.
 * - Push: users.watch naar Pub/Sub; daarna history.list per collega (pollChanges).
 */
import type { Conversation, MailItem, MailMessage } from '@hz/shared';
import { toLocal } from '@hz/shared/logic';
import type { GmailProvider } from '../types';
import { GoneError, HttpClient, ProviderHttpError, type LiveCredentials } from './http';
import { nameFromEmail } from './google-calendar';
import { MemorySyncStore, type SyncStore } from './store';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';

export interface GHeader {
  name: string;
  value: string;
}
export interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: GHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
}
export interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}
export interface GThread {
  id: string;
  historyId?: string;
  messages?: GMessage[];
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const toB64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export const header = (m: GMessage | GPart | undefined, name: string) => {
  const hs = (m && 'payload' in m ? m.payload?.headers : (m as GPart | undefined)?.headers) ?? [];
  return hs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
};

/** "Naam <a@b.nl>, c@d.nl" -> adressen (kleine letters). */
export function addresses(v: string): string[] {
  return v
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase())
    .filter((s) => s.includes('@'));
}

/** Datum uit de Date-header (RFC 2822) naar wandklok; valt terug op internalDate. */
export function messageTime(m: GMessage): string {
  const d = Date.parse(header(m, 'Date').replace(/\s*\([^)]*\)\s*$/, ''));
  if (Number.isFinite(d)) return toLocal(new Date(d));
  return toLocal(new Date(Number(m.internalDate ?? 0)));
}

function walk(p: GPart | undefined, fn: (p: GPart) => void) {
  if (!p) return;
  fn(p);
  for (const c of p.parts ?? []) walk(c, fn);
}

const htmlToText = (h: string) =>
  h
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Tekst van een bericht: text/plain, anders html als tekst. Plus bijlagen (bestandsnamen). */
export function messageBody(m: GMessage): { text: string; files: string[] } {
  let plain = '';
  let html = '';
  const files: string[] = [];
  walk(m.payload, (p) => {
    if (p.filename) files.push(p.filename);
    else if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = b64url(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64url(p.body.data);
  });
  return { text: (plain || htmlToText(html) || m.snippet || '').replace(/\r\n/g, '\n'), files };
}

/** Geciteerde tekst afsplitsen ("Op … schreef …:", "On … wrote:", regels met >). */
export function splitQuoted(text: string): { body: string; quoted: string } {
  const re =
    /^(Op .{5,200}(schreef|het volgende geschreven)|On .{5,200}wrote:|-{2,}\s*(Oorspronkelijk|Original) bericht|From: .+$)/im;
  const m = re.exec(text);
  let idx = m ? m.index : -1;
  const q = /^>.*$/m.exec(text);
  if (q && (idx < 0 || q.index < idx)) idx = q.index;
  if (idx <= 0) return { body: text.trim(), quoted: '' };
  return { body: text.slice(0, idx).trim(), quoted: text.slice(idx).trim() };
}

export class LiveGmail implements GmailProvider {
  readonly mode = 'live' as const;
  readonly http: HttpClient;
  readonly store: SyncStore;
  private limit: number;
  constructor(
    readonly creds: LiveCredentials,
    opts: { store?: SyncStore; base?: string; fetchImpl?: typeof fetch; limit?: number } = {},
  ) {
    this.http = new HttpClient('gmail', opts.base ?? GMAIL_BASE, creds, opts.fetchImpl);
    this.store = opts.store ?? new MemorySyncStore();
    this.limit = opts.limit ?? 25;
  }

  async selfEmail(): Promise<string> {
    const c = await this.store.get<string>('gmail:self');
    if (c) return c;
    const p = await this.http.json<{ emailAddress: string; historyId?: string }>('/users/me/profile');
    await this.store.set('gmail:self', p.emailAddress.toLowerCase());
    return p.emailAddress.toLowerCase();
  }

  private async recentThreads(): Promise<GThread[]> {
    const r = await this.http.json<{ threads?: Array<{ id: string }> }>('/users/me/threads', {
      query: { labelIds: 'INBOX', maxResults: this.limit, q: 'newer_than:30d' },
    });
    return Promise.all(
      (r.threads ?? []).map((t) =>
        this.http.json<GThread>(`/users/me/threads/${encodeURIComponent(t.id)}`, {
          query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] },
        }),
      ),
    );
  }

  async listThreads(): Promise<MailItem[]> {
    const self = await this.selfEmail();
    const threads = await this.recentThreads();
    return threads
      .filter((t) => t.messages?.length)
      .map((t) => {
        const msgs = t.messages!;
        const last = msgs.at(-1)!;
        const lastIn = [...msgs].reverse().find((m) => !addresses(header(m, 'From')).includes(self)) ?? last;
        const from = header(lastIn, 'From');
        const fromAddr = addresses(from)[0] ?? '';
        return {
          id: 'ml:' + t.id,
          type: 'mail' as const,
          threadId: t.id,
          title: header(msgs[0], 'Subject') || '(geen onderwerp)',
          fromName: nameFromEmail(from) || fromAddr,
          from: fromAddr,
          time: messageTime(last),
          unread: msgs.some((m) => m.labelIds?.includes('UNREAD')),
          direct: addresses(header(lastIn, 'To')).includes(self),
          body: last.snippet ?? '',
          count: msgs.length,
          entities: [],
          url: `https://mail.google.com/mail/u/0/#all/${t.id}`,
        };
      })
      .sort((a, b) => b.time.localeCompare(a.time));
  }

  async listConversations(): Promise<Conversation[]> {
    return (await this.listThreads()).map((m) => ({
      key: 'ml:' + m.threadId,
      kind: 'mail' as const,
      name: m.title,
      unread: !!m.unread,
      time: m.time,
      preview: `${m.fromName}: ${m.body ?? ''}`.slice(0, 200),
      entities: [],
    }));
  }

  async getThread(threadId: string) {
    let t: GThread;
    try {
      t = await this.http.json<GThread>(`/users/me/threads/${encodeURIComponent(threadId)}`, {
        query: { format: 'full' },
      });
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 404) return null;
      throw e;
    }
    const msgs: MailMessage[] = (t.messages ?? []).map((m) => {
      const { text, files } = messageBody(m);
      const { body, quoted } = splitQuoted(text);
      const from = header(m, 'From');
      return {
        fromName: nameFromEmail(from) || addresses(from)[0] || '',
        from: addresses(from)[0] ?? '',
        to: addresses(header(m, 'To')),
        cc: addresses(header(m, 'Cc')),
        time: messageTime(m),
        body,
        quoted,
        files,
        unread: !!m.labelIds?.includes('UNREAD'),
      };
    });
    return {
      subject: header(t.messages?.[0], 'Subject') || '(geen onderwerp)',
      url: `https://mail.google.com/mail/u/0/#all/${threadId}`,
      msgs,
    };
  }

  async markRead(threadId: string, read: boolean): Promise<void> {
    await this.http.json(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, {
      method: 'POST',
      body: read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] },
    });
  }

  /** Handtekening van het primaire afzenderadres (als platte tekst), kort gecachet. */
  async signature(): Promise<string> {
    const c = await this.store.get<{ at: number; sig: string }>('gmail:signature');
    if (c && Date.now() - c.at < 3600_000) return c.sig;
    const r = await this.http.json<{ sendAs?: Array<{ isPrimary?: boolean; signature?: string }> }>(
      '/users/me/settings/sendAs',
    );
    const sig = htmlToText(r.sendAs?.find((s) => s.isPrimary)?.signature ?? '');
    await this.store.set('gmail:signature', { at: Date.now(), sig });
    return sig;
  }

  /**
   * Antwoord als CONCEPT in Gmail (drafts.create in de thread). Er wordt niets verstuurd; de collega
   * opent het concept in Gmail en drukt zelf op Verzenden. Geeft het concept-id terug.
   */
  async reply(threadId: string, body: string, opts: { replyAll: boolean }): Promise<{ id: string }> {
    const self = await this.selfEmail();
    const t = await this.http.json<GThread>(`/users/me/threads/${encodeURIComponent(threadId)}`, {
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'] },
    });
    const msgs = t.messages ?? [];
    const last = [...msgs].reverse().find((m) => !addresses(header(m, 'From')).includes(self)) ?? msgs.at(-1);
    if (!last) throw new Error('lege thread');
    const fromAddr = addresses(header(last, 'From'));
    const to = fromAddr.length ? fromAddr : addresses(header(last, 'To')).filter((a) => a !== self);
    const cc = opts.replyAll
      ? [...addresses(header(last, 'To')), ...addresses(header(last, 'Cc'))].filter(
          (a) => a !== self && !to.includes(a),
        )
      : [];
    const subj = header(msgs[0], 'Subject');
    const subject = /^re:/i.test(subj) ? subj : `Re: ${subj}`;
    const msgId = header(last, 'Message-ID');
    const refs = [header(last, 'References'), msgId].filter(Boolean).join(' ');
    const sig = await this.signature().catch(() => '');
    const text = sig ? `${body.trim()}\n\n--\n${sig}` : body.trim();
    const encSubject = /[^\x20-\x7e]/.test(subject)
      ? `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`
      : subject;
    const raw = [
      `To: ${to.join(', ')}`,
      ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
      `Subject: ${encSubject}`,
      ...(msgId ? [`In-Reply-To: ${msgId}`, `References: ${refs}`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      text.replace(/\r?\n/g, '\r\n'),
    ].join('\r\n');
    const d = await this.http.json<{ id: string }>('/users/me/drafts', {
      method: 'POST',
      body: { message: { threadId, raw: toB64url(raw) } },
    });
    return { id: d.id };
  }

  /** Pub/Sub-push aanzetten (verloopt na 7 dagen; de worker vernieuwt dagelijks). */
  async watch(topicName: string) {
    return this.http.json<{ historyId: string; expiration: string }>('/users/me/watch', {
      method: 'POST',
      body: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' },
    });
  }

  /**
   * Voor de sync-motor: wijzigingen sinds de vorige historyId (history.list). 404 = historyId te oud ->
   * opnieuw beginnen bij de huidige. Bewaart alleen de historyId, geen inhoud.
   */
  async pollChanges(startHistoryId?: string): Promise<{ changed: number; historyId: string; first: boolean }> {
    const since = startHistoryId ?? (await this.store.get<string>('gmail:historyId'));
    if (!since) {
      const p = await this.http.json<{ historyId: string }>('/users/me/profile');
      await this.store.set('gmail:historyId', p.historyId);
      return { changed: 0, historyId: p.historyId, first: true };
    }
    let changed = 0;
    let pageToken: string | undefined;
    let historyId = since;
    try {
      do {
        const r = await this.http.json<{ history?: unknown[]; historyId?: string; nextPageToken?: string }>(
          '/users/me/history',
          { query: { startHistoryId: since, labelId: 'INBOX', pageToken } },
        );
        changed += r.history?.length ?? 0;
        if (r.historyId) historyId = r.historyId;
        pageToken = r.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (e instanceof GoneError || (e instanceof ProviderHttpError && e.status === 404)) {
        const p = await this.http.json<{ historyId: string }>('/users/me/profile');
        await this.store.set('gmail:historyId', p.historyId);
        return { changed: 1, historyId: p.historyId, first: false };
      }
      throw e;
    }
    await this.store.set('gmail:historyId', historyId);
    return { changed, historyId, first: false };
  }
}
