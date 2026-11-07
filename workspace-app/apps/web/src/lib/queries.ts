/**
 * Data-laag (TanStack Query) op de API. Querykeys zijn dezelfde namen die de server in
 * `invalidate`-events stuurt (/api/events), zodat live updates zonder polling binnenkomen.
 */
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ServerEvent, type ItemState } from '@hz/shared';
import { pd } from '@hz/shared/logic';
import { api, AuthRequiredError } from './api';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (n, e) => !(e instanceof AuthRequiredError) && n < 2,
      },
    },
  });
}

export const useSession = () => useQuery({ queryKey: ['session'], queryFn: () => api('session') });

export const useDagstart = () =>
  useQuery({
    queryKey: ['dagstart'],
    queryFn: () => api('dagstart'),
    refetchInterval: 60_000,
  });

/** De klok van de app: de wandklok die de server meegeeft (vast in fixture-modus). */
export function useNow(): Date | null {
  const d = useDagstart();
  return d.data ? pd(d.data.now) : null;
}

export function useSetItemState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, patch }: { key: string; patch: Omit<ItemState, 'key'> }) =>
      api('itemState', { params: { key }, body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dagstart'] }),
  });
}

/** Server-sent events: `invalidate` -> queries opnieuw ophalen. Herverbindt vanzelf (EventSource). */
export function useServerEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events', { withCredentials: true });
    const onInvalidate = (ev: MessageEvent<string>) => {
      const parsed = ServerEvent.safeParse(JSON.parse(ev.data));
      if (parsed.success && parsed.data.type === 'invalidate') {
        for (const key of parsed.data.keys) void qc.invalidateQueries({ queryKey: [key] });
      }
    };
    es.addEventListener('invalidate', onInvalidate as EventListener);
    return () => {
      es.removeEventListener('invalidate', onInvalidate as EventListener);
      es.close();
    };
  }, [enabled, qc]);
}

export const useConversations = (enabled = true) =>
  useQuery({ queryKey: ['conversations'], queryFn: () => api('conversations'), enabled, staleTime: 60_000 });

export const usePins = () => useQuery({ queryKey: ['pins'], queryFn: () => api('pins') });

export function useAddPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: 'search' | 'view'; label: string; q?: string; view?: string }) =>
      api('addPin', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pins'] }),
  });
}
