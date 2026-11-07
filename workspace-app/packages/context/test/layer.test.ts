/**
 * HZW-034/035: contextlaag eerst. Heartbeats van de nachtdiensten en Jira per epic uit de (synthetische) laag.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { liveWindow, parseHeartbeatLine, parseNightRuns, readJiraLayer, readNightRuns, RepoReader } from '../src';

const CTX = join(import.meta.dirname, 'fixtures/ctx');

describe('heartbeats en het live venster', () => {
  it('leest runs (nieuwste eerst); Z = UTC, zonder Z de vroegste lezing (Amsterdam)', () => {
    const runs = parseNightRuns(
      `---\ntitel: x\n---\n- 2026-11-06 00:17 | groen | a\n- 2026-11-07 00:16Z | groen | b\nvrije tekst\n- 2026-11-05 00:16 | rood | c`,
    );
    expect(runs.map((r) => r.at.toISOString())).toEqual([
      '2026-11-07T00:16:00.000Z',
      '2026-11-05T23:17:00.000Z',
      '2026-11-04T23:16:00.000Z',
    ]);
    expect(runs[1]!.ambiguous).toBe(true);
    expect(runs[2]!.status).toBe('rood');
  });

  it('live venster vanaf de laatste geslaagde run (rood telt niet), met marge', () => {
    const runs = readNightRuns(new RepoReader(CTX), 'info');
    const w = liveWindow(runs, new Date('2026-11-05T09:00:00Z'));
    expect(w.basis).toBe('nachtrun');
    expect(w.run!.status).toBe('oranje');
    expect(w.since.toISOString()).toBe('2026-11-04T01:02:00.000Z');
    expect(w.missedNight).toBe(false);
  });

  it('mist er een nacht, dan wordt het venster vanzelf groter dan 24 uur', () => {
    const w = liveWindow([parseHeartbeatLine('2026-11-04 00:16Z | groen | x')!], new Date('2026-11-07T08:00:00Z'));
    expect(+new Date('2026-11-07T08:00:00Z') - +w.since).toBeGreaterThan(72 * 3600_000);
    expect(w.missedNight).toBe(true);
  });

  it('zonder bekende run een ruim venster (7 dagen)', () => {
    const w = liveWindow([], new Date('2026-11-07T08:00:00Z'));
    expect(w).toMatchObject({ basis: 'geen-run', run: null });
    expect(w.since.toISOString()).toBe('2026-10-31T08:00:00.000Z');
  });
});

describe('Jira in de laag (product/jira/)', () => {
  it('issues per epic met stand-datum; andere regels genegeerd', () => {
    const issues = readJiraLayer(new RepoReader(CTX));
    expect(issues).toEqual([
      {
        key: 'HOM-901',
        title: 'Leads in de planning tonen',
        issueType: 'Story',
        status: 'In Progress',
        url: 'https://demo.atlassian.net/browse/HOM-901',
        epic: 'HOM-900',
        asOf: '2026-11-04',
      },
      {
        key: 'HOM-902',
        title: 'Takenoverzicht op mobiel',
        issueType: 'Story',
        status: 'To Do',
        url: 'https://demo.atlassian.net/browse/HOM-902',
        epic: 'HOM-900',
        asOf: '2026-11-04',
      },
    ]);
  });
});
