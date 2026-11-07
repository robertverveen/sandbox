/**
 * HZW-007: foutregistratie, logs zonder persoonsgegevens en hartslag.
 * De foutregistratie wordt nagebootst met een lokale HTTP-server die het envelope-protocol van GlitchTip/Sentry
 * ontvangt; er gaat niets naar buiten.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ErrorEvent,
  createReporter,
  formatLine,
  heartbeatFresh,
  installOps,
  maskPath,
  parseDsn,
  scrub,
  startHeartbeat,
  withAccessLog,
} from '../src/index';

interface Received {
  url: string;
  auth: string;
  lines: unknown[];
  raw: string;
}

function fakeGlitchTip() {
  const got: Received[] = [];
  let server: Server;
  const read = (req: IncomingMessage) =>
    new Promise<string>((ok) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => ok(b));
    });
  return {
    got,
    async start() {
      server = createServer(async (req, res) => {
        const raw = await read(req);
        got.push({
          url: req.url ?? '',
          auth: String(req.headers['x-sentry-auth'] ?? ''),
          raw,
          lines: raw
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l)),
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"x"}');
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
      const a = server.address();
      return typeof a === 'object' && a ? a.port : 0;
    },
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

describe('scrub: geen persoonsgegevens of geheimen', () => {
  it.each([
    ['mail van robert@homezero.nl mislukt', 'mail van [e-mail] mislukt'],
    [
      'verbinding postgres://hz_app_login:Sup3rGeheim@db:5432/hz faalt',
      'verbinding postgres://[geheim]@db:5432/hz faalt',
    ],
    ['Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [token]'],
    ['slack xoxp-1234-5678-abcdef', 'slack [slack-token]'],
    ['google ya29.a0AfH6SMBx-y_z', 'google [google-token]'],
    ['gh ghp_abcdefghijklmnopqrstuvwxyz012345', 'gh [github-token]'],
    ['claude sk-ant-api03-abc_DEF', 'claude [anthropic-key]'],
    ['callback ?code=4/0AY0e-g7&state=xyz', 'callback ?code=[geheim]&state=[geheim]'],
    ['van 192.168.1.20 en 2001:db8:85a3:0:0:8a2e:370:7334', 'van [ip] en [ip]'],
    ['sleutel AGE-SECRET-KEY-1QQQQQQQQ', 'sleutel [age-key]'],
    ['rekening NL91ABNA0417164300', 'rekening [iban]'],
  ])('%s', (input, out) => {
    expect(scrub(input)).toBe(out);
  });

  it('maskPath haalt id, e-mail, nummers en query weg', () => {
    expect(maskPath('/api/itemstate/slack%3AC123%3A1730.22?x=robert@homezero.nl')).toBe('/api/itemstate/:key');
    expect(maskPath('/api/repo/queue/7f9c2b1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f')).toBe('/api/repo/queue/:id');
    expect(maskPath('/api/users/robert@homezero.nl/42')).toBe('/api/users/:email/:n');
    expect(maskPath('/api/health')).toBe('/api/health');
  });
});

describe('gestructureerde logs', () => {
  it('JSON-regel met tijd, niveau, dienst en geschoonde boodschap', () => {
    const line = JSON.parse(
      formatLine('api', 'error', ['inloggen mislukt voor', 'lisanne@homezero.nl', new Error('x')]),
    );
    expect(line).toMatchObject({ level: 'error', svc: 'api', msg: 'inloggen mislukt voor [e-mail] Error: x' });
    expect(Date.parse(line.ts)).not.toBeNaN();
  });

  it('access-log: methode, gemaskeerd pad, status, duur; geen IP, user-agent of query', async () => {
    const lines: string[] = [];
    const h = withAccessLog(
      'api',
      async () => new Response('ok', { status: 201 }),
      (l) => lines.push(l),
    );
    await h(
      new Request('http://x/api/itemstate/robert@homezero.nl?token=abc', {
        headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '10.1.2.3', cookie: 'hz_session=geheim' },
      }),
    );
    expect(lines).toHaveLength(1);
    const l = JSON.parse(lines[0]!);
    expect(l).toMatchObject({ msg: 'request', method: 'GET', path: '/api/itemstate/:email', status: 201 });
    expect(typeof l.ms).toBe('number');
    expect(lines[0]).not.toMatch(/Mozilla|10\.1\.2\.3|geheim|token|homezero\.nl/);
  });
});

describe('foutregistratie (GlitchTip/Sentry-protocol)', () => {
  const gt = fakeGlitchTip();
  let port = 0;
  beforeEach(async () => {
    gt.got.length = 0;
    port = await gt.start();
  });
  afterEach(() => gt.stop());

  it('parseDsn weigert onzin en leest sleutel en project', () => {
    expect(() => parseDsn('https://fouten.example.nl/1')).toThrow();
    expect(parseDsn('https://abc123@fouten.example.nl/7')).toMatchObject({
      origin: 'https://fouten.example.nl',
      publicKey: 'abc123',
      projectId: '7',
    });
  });

  it('kunstmatige fout komt aan, met stacktrace en zonder persoonsgegevens', async () => {
    const r = createReporter({
      dsn: `http://pubkey@127.0.0.1:${port}/3`,
      service: 'api',
      environment: 'test',
      release: 'sha-abc1234',
    });
    const ok = await r.capture(new Error('Kunstmatige fout voor robert@homezero.nl met token=geheim123'));
    expect(ok).toBe(true);
    expect(gt.got).toHaveLength(1);
    const env = gt.got[0]!;
    expect(env.url).toBe('/api/3/envelope/');
    expect(env.auth).toContain('sentry_key=pubkey');
    const [head, item, ev] = env.lines as [Record<string, unknown>, Record<string, unknown>, ErrorEvent];
    expect(head.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item).toEqual({ type: 'event' });
    expect(ev).toMatchObject({ level: 'error', environment: 'test', release: 'sha-abc1234', tags: { service: 'api' } });
    expect(ev.exception.values[0]!.type).toBe('Error');
    expect(ev.exception.values[0]!.value).toBe('Kunstmatige fout voor [e-mail] met token=[geheim]');
    expect(ev.exception.values[0]!.stacktrace.frames.length).toBeGreaterThan(0);
    expect(env.raw).not.toMatch(/homezero\.nl|geheim123/);
  });

  it('zonder DSN: uit, en een onbereikbare registratie laat de app niet vallen', async () => {
    const off = createReporter({ service: 'api' });
    expect(off.enabled).toBe(false);
    expect(await off.capture(new Error('x'))).toBe(false);
    const dead = createReporter({ dsn: 'http://k@127.0.0.1:1/1', service: 'api', timeoutMs: 500 });
    expect(await dead.capture(new Error('x'))).toBe(false);
  });

  it('installOps: console.error(Error) gaat naar de registratie en wordt een JSON-logregel', async () => {
    const lines: string[] = [];
    const ops = installOps({
      service: 'worker',
      env: { HZ_ERROR_DSN: `http://k@127.0.0.1:${port}/9`, HZ_LOG_FORMAT: 'json', HZ_ENVIRONMENT: 'production' },
      write: (l) => lines.push(l),
      handleProcessErrors: false,
    });
    try {
      console.error(new Error('job faalde voor lisanne@homezero.nl'));
      console.log('gestart');
      await ops.reporter.flush();
    } finally {
      ops.uninstall();
    }
    expect(gt.got).toHaveLength(1);
    expect(JSON.stringify(gt.got[0]!.lines)).toContain('job faalde voor [e-mail]');
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ level: 'error', svc: 'worker', msg: 'Error: job faalde voor [e-mail]' }),
      expect.objectContaining({ level: 'info', msg: 'gestart' }),
    ]);
  });
});

describe('hartslag van de worker', () => {
  it('schrijft het bestand, en een oud bestand is niet vers', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'hz-e0-hb-')), 'alive');
    expect(heartbeatFresh(f)).toBe(false);
    const stop = startHeartbeat(f, 10_000);
    expect(heartbeatFresh(f)).toBe(true);
    stop();
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(f, old, old);
    expect(heartbeatFresh(f, 90_000)).toBe(false);
  });
});
