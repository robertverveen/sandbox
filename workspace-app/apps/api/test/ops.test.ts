/**
 * HZW-007: een kunstmatige fout in een echte route komt aan in de foutregistratie (nagebootste GlitchTip op
 * 127.0.0.1), zonder persoonsgegevens; de access-log bevat geen IP, user-agent of e-mail.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProviders } from '@hz/providers';
import { installOps } from '@hz/ops';
import { createApp, SESSION_COOKIE } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryStore } from '../src/store';

class BrokenStore extends MemoryStore {
  override async weekdoelen(): Promise<never> {
    throw new Error('Kunstmatige fout (HZW-007) voor robert@homezero.nl');
  }
}

let server: Server;
let port = 0;
const received: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push(`${req.url}\n${b}`);
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const a = server.address();
  port = typeof a === 'object' && a ? a.port : 0;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe('foutregistratie vanuit de API', () => {
  it('500 in een route: generieke melding naar de browser, volledige (geschoonde) fout naar de registratie', async () => {
    const logs: string[] = [];
    const ops = installOps({
      service: 'api',
      env: { HZ_ERROR_DSN: `http://sleutel@127.0.0.1:${port}/1`, HZ_LOG_FORMAT: 'json', HZ_RELEASE: 'sha-test' },
      write: (l) => logs.push(l),
      handleProcessErrors: false,
    });
    try {
      const env = { NODE_ENV: 'test' };
      const bundle = createProviders(env);
      const { app } = createApp({ config: loadConfig(env), bundle, store: new BrokenStore(bundle.dataset) });
      const fetchLogged = ops.wrapFetch(app.fetch);
      const login = await fetchLogged(new Request('http://x/api/auth/dev-login', { method: 'POST', body: '{}' }));
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      expect(cookie.startsWith(SESSION_COOKIE + '=')).toBe(true);

      const res = await fetchLogged(
        new Request('http://x/api/weekdoelen', { headers: { cookie, 'user-agent': 'Mozilla/5.0 Testbrowser' } }),
      );
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain('Kunstmatige fout');
      await ops.reporter.flush();
    } finally {
      ops.uninstall();
    }

    expect(received).toHaveLength(1);
    const [url, ...rest] = received[0]!.split('\n');
    expect(url).toBe('/api/1/envelope/');
    const event = JSON.parse(rest[2]!);
    expect(event.exception.values[0].value).toBe('Kunstmatige fout (HZW-007) voor [e-mail]');
    expect(event.release).toBe('sha-test');
    expect(received[0]).not.toContain('robert@homezero.nl');

    const access = logs.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request');
    expect(access.map((l) => [l.method, l.path, l.status])).toEqual([
      ['POST', '/api/auth/dev-login', 200],
      ['GET', '/api/weekdoelen', 500],
    ]);
    expect(logs.join('\n')).not.toMatch(/Mozilla|robert@homezero\.nl|hz_session=/);
  });
});
