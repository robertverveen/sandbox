import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase } from '@hz/db';
import { createProviders } from '@hz/providers';
import { QUEUES, telActies } from '../src/jobs';
import { startWorker } from '../src/worker';

const url =
  process.env.HZ_TEST_DATABASE_URL_WORKER ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_fundament_test_worker';

describe('voorbeeldjob: tel open partneracties', () => {
  it('telt per eigenaar en over datum (op DEMO_CTX)', async () => {
    const r = await telActies(createProviders({}).providers.context, { tot: '2026-10-30' });
    expect(r).toEqual({ open: 4, overDatum: 1, perEigenaar: { Robert: 3, 'Femke': 1 } });
  });
});

describe('pg-boss in Postgres', () => {
  let w: Awaited<ReturnType<typeof startWorker>>;
  const logs: string[] = [];
  beforeAll(async () => {
    await ensureDatabase(url, { recreate: true });
    w = await startWorker({
      connectionString: url,
      schema: 'pgboss_test',
      bundle: createProviders({}),
      log: (m) => logs.push(m),
    });
  }, 30_000);
  afterAll(async () => {
    await w?.stop();
  });

  it('een verstuurde job wordt opgepakt en voltooid met output', async () => {
    const id = await w.send({ tot: '2026-10-30' });
    expect(id).toBeTruthy();
    let job = null;
    for (let i = 0; i < 60; i++) {
      job = await w.boss.getJobById(QUEUES.telActies, id!);
      if (job?.state === 'completed') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(job?.state).toBe('completed');
    expect(job?.output).toMatchObject({ open: 4, overDatum: 1 });
    expect(logs.some((l) => l.includes('4 open'))).toBe(true);
  }, 30_000);
});
