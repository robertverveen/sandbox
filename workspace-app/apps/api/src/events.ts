/** In-proces eventbus voor server-sent events (per gebruiker). Later gevoed door de worker via LISTEN/NOTIFY. */
import type { ServerEvent } from '@hz/shared';

type Listener = (e: ServerEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, fn: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set();
    set.add(fn);
    this.listeners.set(userId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(userId);
    };
  }

  publish(userId: string, e: ServerEvent) {
    for (const fn of this.listeners.get(userId) ?? []) fn(e);
  }

  invalidate(userId: string, ...keys: string[]) {
    this.publish(userId, { type: 'invalidate', keys });
  }

  count(userId?: string) {
    return userId
      ? (this.listeners.get(userId)?.size ?? 0)
      : [...this.listeners.values()].reduce((s, x) => s + x.size, 0);
  }
}
