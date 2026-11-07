/**
 * API-client op het contract uit @hz/shared: één functie `api(name, input)`, getypt per route.
 * Antwoorden worden met het zod-schema gecontroleerd, zodat contractafwijkingen direct opvallen.
 * Bij 401 logt de client in ontwikkeling automatisch in als testgebruiker (dev-login-stub);
 * werkt dat niet, dan gooit hij AuthRequiredError en toont de app het inlogscherm.
 */
import { pathFor, routes, type RouteDef, type RouteName, type Routes } from '@hz/shared';
import type { z } from 'zod';

export class AuthRequiredError extends Error {
  constructor() {
    super('Inloggen nodig');
    this.name = 'AuthRequiredError';
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type In<N extends RouteName> = {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: Routes[N] extends { body: infer B extends z.ZodType } ? z.input<B> : never;
};
export type Out<N extends RouteName> = z.infer<Routes[N]['response']>;

let loginInFlight: Promise<boolean> | null = null;

async function devLogin(): Promise<boolean> {
  loginInFlight ??= fetch(routes.devLogin.path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (loginInFlight = null), 0);
    });
  return loginInFlight;
}

export async function api<N extends RouteName>(name: N, input: In<N> = {}, retry = true): Promise<Out<N>> {
  const def = routes[name] as RouteDef;
  let url = pathFor(def.path, input.params ?? {});
  const q = Object.entries(input.query ?? {}).filter(([, v]) => v !== undefined && v !== '');
  if (q.length) url += '?' + new URLSearchParams(q as Array<[string, string]>).toString();
  const res = await fetch(url, {
    method: def.method,
    credentials: 'same-origin',
    headers: input.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  if (res.status === 401 && def.auth !== false) {
    if (retry && (await devLogin())) return api(name, input, false);
    throw new AuthRequiredError();
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'http', e.message ?? `Fout ${res.status}`);
  }
  return def.response.parse(data) as Out<N>;
}
