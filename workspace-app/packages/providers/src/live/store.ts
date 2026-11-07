/**
 * Sync-opslag per collega: cursors (Google syncToken, Gmail historyId, Slack last_read) en een kleine cache
 * van metadata (afspraken, kanaallijst). Geen mailtekst of Slack-geschiedenis (P2).
 *
 * Een SyncStore is "collega-bewust": hij gebruikt de collega uit de scope (withUserScope) of een vaste collega.
 * In de worker en API zit hier de Postgres-implementatie achter (tabel sync_state, onder RLS); in tests het geheugen.
 */
import { currentUserId } from './tokens';

export interface SyncStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemorySyncStore implements SyncStore {
  readonly data = new Map<string, string>();
  constructor(private userId?: () => string | undefined) {}
  private k(key: string) {
    const u = (this.userId ?? currentUserId)() ?? '_';
    return `${u}|${key}`;
  }
  async get<T>(key: string): Promise<T | null> {
    const v = this.data.get(this.k(key));
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set<T>(key: string, value: T) {
    this.data.set(this.k(key), JSON.stringify(value));
  }
  async del(key: string) {
    this.data.delete(this.k(key));
  }
}
