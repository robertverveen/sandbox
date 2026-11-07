/**
 * Testhulp: msw vangt elke fetch af. Onbekende verzoeken zijn een fout, dus een test kan nooit per ongeluk een
 * echt endpoint van Google, Slack, Atlassian, GitHub of Wispr raken. Alle antwoorden zijn synthetisch
 * (afgeleid van de demodata van het prototype).
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { RequestHandler } from 'msw';

export interface Recorded {
  method: string;
  url: URL;
  body: unknown;
  headers: Headers;
}

export function mockServer(...handlers: RequestHandler[]) {
  const server = setupServer(...handlers);
  const requests: Recorded[] = [];
  server.events.on('request:start', async ({ request }) => {
    const clone = request.clone();
    const text = await clone.text().catch(() => '');
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      if ((request.headers.get('content-type') ?? '').includes('form'))
        body = Object.fromEntries(new URLSearchParams(text));
    }
    requests.push({ method: request.method, url: new URL(request.url), body, headers: request.headers });
  });
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return { server, requests, clear: () => requests.splice(0) };
}

export const creds = (token = 'test-token') => ({
  accessToken: async () => token,
  rejectedCalls: [] as string[],
});
