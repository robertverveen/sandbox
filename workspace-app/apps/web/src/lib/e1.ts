/**
 * Data-laag van stuk E1 (inloggen, onboarding, koppelingen, sessies, team) op het contract.
 * Querykeys zijn dezelfde namen als in de `invalidate`-events van de server.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingPatch, ProviderName } from '@hz/shared';
import { api } from './api';

export const useAuthConfig = () =>
  useQuery({ queryKey: ['authConfig'], queryFn: () => api('authConfig'), staleTime: Infinity });

export const useOnboarding = (enabled = true) =>
  useQuery({ queryKey: ['onboarding'], queryFn: () => api('onboarding'), enabled });

export function useUpdateOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OnboardingPatch) => api('updateOnboarding', { body }),
    onSuccess: (data) => qc.setQueryData(['onboarding'], data),
  });
}

export const useConnectionDetails = () =>
  useQuery({ queryKey: ['connections'], queryFn: () => api('connectionDetails') });

export function useConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, returnTo }: { provider: ProviderName; returnTo: string }) =>
      api('connect', { params: { provider }, body: { returnTo } }),
    onSuccess: (r) => {
      // Met een OAuth-flow: naar de bron voor toestemming (top-level, zodat de sessiecookie meegaat).
      if (r.redirect) window.location.assign(r.redirect);
      else void qc.invalidateQueries({ queryKey: ['connections'] });
    },
  });
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderName) => api('disconnect', { params: { provider } }),
    onSuccess: () => {
      for (const k of [
        'connections',
        'dagstart',
        'agenda',
        'preferences',
        'tracker',
        'tasks',
        'conversations',
        'items',
      ])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export function useWipeData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderName) => api('wipeConnectionData', { params: { provider } }),
    onSuccess: () => {
      for (const k of ['dagstart', 'agenda', 'preferences']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export function useOwnGoogleClient() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['connections'] });
  return {
    save: useMutation({
      mutationFn: (body: { clientId: string; clientSecret: string }) => api('ownGoogleClient', { body }),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: () => api('deleteOwnGoogleClient'), onSuccess: done }),
  };
}

export const usePersRepo = (enabled = true) =>
  useQuery({ queryKey: ['persRepo'], queryFn: () => api('persRepo'), enabled });

export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => api('sessions') });

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api('revokeSession', { params: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export const useMembers = (enabled: boolean) =>
  useQuery({ queryKey: ['members'], queryFn: () => api('members'), enabled });

export function useAdmin() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['members'] });
  return {
    block: useMutation({
      mutationFn: ({ id, blocked }: { id: string; blocked: boolean }) =>
        api('blockMember', { params: { id }, body: { blocked } }),
      onSuccess: done,
    }),
    add: useMutation({
      mutationFn: (body: { email: string; role: 'admin' | 'member' }) => api('addAllowlist', { body }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (email: string) => api('removeAllowlist', { params: { email } }),
      onSuccess: done,
    }),
  };
}

/** Uitloggen: hier of overal. Daarna naar het inlogscherm (zonder automatische dev-login). */
export async function logout(everywhere = false) {
  try {
    if (everywhere) await api('logoutAll');
    else await api('logout');
  } finally {
    window.location.assign('/login?uit=1');
  }
}
