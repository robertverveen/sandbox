import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ContextSnapshot } from '@hz/shared';
import {
  actionLine,
  bullets,
  exportContext,
  formatActionLine,
  frontmatter,
  ForbiddenReadError,
  listval,
  parseAangehouden,
  parseRegister,
  readExport,
  RepoReader,
  sections,
  toSnapshot,
  writeExport,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const CTX = join(here, 'fixtures/ctx');
const PRIVE = join(here, 'fixtures/prive');

describe('regelparsers', () => {
  it('leest een actieregel volgens het schema', () => {
    const a = actionLine(
      '- [ ] Keuze flow bevestigen [eigenaar:: Robert] [datum:: 2026-11-12] (voorstel) [ligt:: bij-ons] [sinds:: 2026-11-03] [bron:: x] [id:: zonnig-20261103-1]',
    );
    expect(a).toEqual({
      state: 'open',
      tekst: 'Keuze flow bevestigen',
      voorstel: true,
      eigenaar: 'Robert',
      datum: '2026-11-12',
      ligt: 'bij-ons',
      sinds: '2026-11-03',
      bron: 'x',
      id: 'zonnig-20261103-1',
    });
  });

  it('herkent afgerond, geschrapt en geen actie', () => {
    expect(actionLine('- [x] Klaar [klaar:: 2026-11-01]')).toMatchObject({ state: 'klaar', klaar: '2026-11-01' });
    expect(actionLine('- [-] Weg [geschrapt:: 2026-11-01]')).toMatchObject({ state: 'geschrapt' });
    expect(actionLine('- gewone bullet')).toBeNull();
    expect(actionLine('  - [ ] ingesprongen')).toBeNull();
  });

  it('schrijft een actieregel terug die weer hetzelfde leest', () => {
    const line = formatActionLine({
      tekst: 'Rekenvoorbeeld sturen',
      eigenaar: 'Robert',
      datum: '2026-11-12',
      voorstel: true,
      ligt: 'bij-ons',
      sinds: '2026-11-05',
      bron: 'https://example.invalid/x',
      id: 'zonnig-20261105-1',
    });
    expect(line).toBe(
      '- [ ] Rekenvoorbeeld sturen [eigenaar:: Robert] [datum:: 2026-11-12] (voorstel) [ligt:: bij-ons] [sinds:: 2026-11-05] [bron:: https://example.invalid/x] [id:: zonnig-20261105-1]',
    );
    expect(actionLine(line)).toMatchObject({ tekst: 'Rekenvoorbeeld sturen', voorstel: true, datum: '2026-11-12' });
    expect(() =>
      formatActionLine({
        tekst: 'x'.repeat(301),
        eigenaar: 'R',
        datum: 'd',
        ligt: 'bij-ons',
        sinds: 's',
        bron: 'b',
        id: 'i',
      }),
    ).toThrow();
    expect(() =>
      formatActionLine({
        tekst: 'met [haak]',
        eigenaar: 'R',
        datum: 'd',
        ligt: 'bij-ons',
        sinds: 's',
        bron: 'b',
        id: 'i',
      }),
    ).toThrow();
  });

  it('frontmatter, secties, bullets en listval', () => {
    const { fm, body } = frontmatter(
      '---\npartner: x\ngeheim_voor: [a, "b"]\n---\n## Kern\nhallo\n## Stand\n- een\n- twee\n### sub\n',
    );
    expect(fm.partner).toBe('x');
    expect(listval(fm.geheim_voor)).toEqual(['a', 'b']);
    expect(listval('?')).toEqual([]);
    expect(listval('')).toEqual([]);
    const sec = sections(body);
    expect(sec.Kern).toBe('hallo');
    expect(bullets(sec.Stand!)).toEqual(['een', 'twee']);
    expect(bullets('- aaaa\n- bb', 1, 3)).toEqual(['aa…']);
  });

  it('register: slug, aliassen, domeinen, kanaal; ? wordt leeg', () => {
    const rows = parseRegister(readFileSync(join(CTX, 'partners/_register.md'), 'utf8'));
    expect(rows.map((r) => r.slug)).toEqual(['zonnig', 'warmtehuis', 'stilstroom', 'zonder-map']);
    expect(rows[0]).toMatchObject({
      naam: 'Zonnig Installatie',
      aliassen: ['Zonnig', 'ZI'],
      domeinen: ['zonnig.example', 'mail.zonnig.example'],
      slack: 'zonnig-hz',
      fase: 'live',
      accountmanager: 'Robert',
    });
    expect(rows[1]).toMatchObject({ aliassen: [], portal: '' });
    expect(rows[2]).toMatchObject({ domeinen: [], slack: '', fase: '', accountmanager: '' });
  });

  it('aangehouden: alleen onbeantwoorde regels', () => {
    const rows = parseAangehouden(readFileSync(join(PRIVE, 'aangehouden.md'), 'utf8'));
    expect(rows.map((r) => r.tekst)).toEqual(['Intern refinement-overleg', 'Nog open punt']);
  });
});

describe('admin.md is nooit leesbaar', () => {
  it('weigert admin.md en paden buiten de repo', () => {
    const repo = new RepoReader(CTX);
    expect(() => repo.read('partners/zonnig/admin.md')).toThrow(ForbiddenReadError);
    expect(() => repo.read('partners/zonnig/ADMIN.md')).toThrow(ForbiddenReadError);
    expect(() => repo.read('../prive/taken.md')).toThrow(ForbiddenReadError);
    expect(repo.list('partners/zonnig')).not.toContain('admin.md');
  });

  it('de export opent admin.md nooit en de inhoud komt nergens in terecht', () => {
    const docs = exportContext(CTX, PRIVE, { today: '2026-11-05' });
    expect(JSON.stringify(docs)).not.toContain('GEHEIM-ADMIN-MARKER');
    expect(JSON.stringify(docs)).not.toContain('MRR');
  });
});

describe('exportContext op de synthetische testrepo', () => {
  const docs = exportContext(CTX, PRIVE, { today: '2026-11-05', exportedAt: new Date('2026-11-05T09:00:00Z') });

  it('partners uit het register plus projecten zonder registerregel', () => {
    expect(Object.keys(docs.context_partners)).toEqual([
      'zonnig',
      'warmtehuis',
      'stilstroom',
      'zonder-map',
      'proefwijk',
    ]);
    const z = docs.context_partners.zonnig!;
    expect(z.geheim_voor).toEqual(['warmtehuis']);
    expect(z.kern).toContain('Synthetische installateur');
    expect(z.stand).toHaveLength(3);
    expect(z.contacten).toEqual(['Anna Testpersoon - planner - Slack', 'Bram Voorbeeld - directeur - mail']);
    expect(z.meetings.map((m) => m.bestand)).toEqual([
      '2026-11-03-werksessie-robert.md',
      '2026-10-20-kickoff-robert.md',
    ]);
    expect(z.meetings[0]!.titel).toBe('werksessie robert');
    expect(z.meetings[0]!.samenvatting[1]!.endsWith('…')).toBe(true);
    expect(z.open_acties).toBe(3);
    expect(docs.context_partners.warmtehuis!.accountmanager).toBe('Lisanne');
    expect(docs.context_partners.proefwijk).toMatchObject({
      soort: 'project',
      naam: 'Proefwijk',
      accountmanager: 'Mike',
    });
  });

  it('acties: open plus eigen recent afgerond (14 dagen), nooit geschrapt', () => {
    const z = docs.context_acties.zonnig!;
    expect(z.acties.map((a) => a.id)).toEqual([
      'zonnig-20261028-1',
      'zonnig-20261103-1',
      'zonnig-20261103-2',
      'zonnig-20261020-1',
    ]);
    expect(z.geheim_voor).toEqual(['warmtehuis']);
    expect(docs.context_acties.stilstroom).toBeUndefined();
    expect(docs.context_status.laatste.acties).toBe(6);
  });

  it('persoonlijk: wachten-op, bespreken, afgerond, taken, aangehouden', () => {
    const p = docs.context_persoonlijk;
    expect(p['wachten-op']!.open.map((w) => w.wie)).toEqual(['Anna Testpersoon', 'Cees Proef']);
    expect(p['wachten-op']!.bespreken).toEqual([
      { state: 'open', tekst: 'Notificatie-ontvanger bevestigen', voorstel: false, klant: 'zonnig', met: 'Anna' },
    ]);
    expect(p['wachten-op']!.afgerond.map((w) => w.tekst)).toEqual(['Logo ontvangen']);
    expect(p.taken!.open.map((t) => t.tekst)).toEqual(['Installateursaccount aanmaken', 'Storingsflow uitwerken']);
    expect(p.aangehouden!.open).toHaveLength(2);
  });

  it('status: laatste nachtregel, heartbeat en nachtlog', () => {
    const s = docs.context_status.laatste;
    expect(s.status).toBe('2026-11-04 | groen | lek 0 | fouten 0 | let op 3 | over datum 2 | bestanden 20');
    expect(s.nachtdienst).toBe('2026-11-04 00:16 | groen | gezien 2 | verwerkt 2');
    expect(s.nacht_prive).toBe('2026-11-04 | gezien 0 | verwerkt 0');
    expect(s.geexporteerd).toBe('2026-11-05T09:00:00+00:00');
    expect(s.partners).toBe(5);
  });

  it('snapshot past op het gedeelde zod-schema; zonder Persoonlijk-repo is pers null', () => {
    const snap = ContextSnapshot.parse(toSnapshot(docs));
    expect(snap.pers?.taken.open).toHaveLength(2);
    const without = ContextSnapshot.parse(toSnapshot(exportContext(CTX, null, { today: '2026-11-05' })));
    expect(without.pers).toBeNull();
  });

  it('schrijft en leest een export-map terug', () => {
    const out = mkdtempSync(join(tmpdir(), 'hz-export-'));
    const manifest = writeExport(out, docs);
    expect(manifest.context_partners).toContain('zonnig');
    expect(readdirSync(join(out, 'context_status'))).toEqual(['laatste.json']);
    const snap = readExport(out);
    expect(Object.keys(snap.partners)).toHaveLength(5);
    expect(snap.acties.zonnig!.acties).toHaveLength(4);
  });
});

describe('gelijk aan export_context.py', () => {
  const hasPython = (() => {
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPython)('zelfde documenten als de Python-referentie (op dezelfde dag)', () => {
    const out = mkdtempSync(join(tmpdir(), 'hz-py-'));
    execFileSync('python3', ['-I', join(here, 'reference/export_context.py'), CTX, PRIVE, out], { stdio: 'ignore' });
    const py = readExport(out);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ts = readExport(
      (() => {
        const o = mkdtempSync(join(tmpdir(), 'hz-ts-'));
        writeExport(o, exportContext(CTX, PRIVE, { today }));
        return o;
      })(),
    );
    const norm = (s: ContextSnapshot) => {
      const c = structuredClone(s);
      if (c.status) {
        c.status.geexporteerd = '';
      }
      // Bewuste afwijking: "?" telt in TypeScript niet als alias.
      for (const p of Object.values(c.partners)) p.aliassen = p.aliassen.filter((a) => a !== '?');
      return c;
    };
    expect(norm(ts)).toEqual(norm(py));
  });
});
