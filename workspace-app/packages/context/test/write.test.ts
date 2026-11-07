/**
 * Schrijfkant (wachtrij naar de repo): van RepoWrite naar de regel volgens _systeem/schema.md en wachten-op.md.
 * Elke opgemaakte regel moet door de eigen parser terug te lezen zijn (rondreis).
 */
import { describe, expect, it } from 'vitest';
import { RepoWrite } from '@hz/shared';
import { addWorkdaysYmd } from '@hz/shared/logic';
import { actionLine, frontmatter, planRepoWrite, RepoWriteError, sections } from '../src';

const ctx = { today: '2026-10-30', slugs: new Set(['feenstra', 'tonzon']), nextId: () => 2 };

describe('planRepoWrite', () => {
  it('wachten op (Inhalen w): wachten-op.md onder Open, reminder = sinds + 3 werkdagen', () => {
    const w = RepoWrite.parse({
      kind: 'wachten-op',
      tekst: 'Akkoord offerte',
      wie: 'Menno',
      klant: 'feenstra',
      bron: 'https://x/1',
    });
    const p = planRepoWrite(w, ctx);
    expect(p).toMatchObject({ repo: 'persoonlijk', path: 'wachten-op.md', op: 'append', section: '## Open' });
    expect(p.line).toBe(
      '- [ ] Akkoord offerte [wie:: Menno] [sinds:: 2026-10-30] [reminder:: 2026-11-04] [bron:: https://x/1] [klant:: feenstra]',
    );
    expect(actionLine(p.line)).toMatchObject({
      state: 'open',
      tekst: 'Akkoord offerte',
      wie: 'Menno',
      klant: 'feenstra',
    });
  });

  it('bespreken (Inhalen b): onder de bespreken-kop met klant en met', () => {
    const p = planRepoWrite(
      RepoWrite.parse({ kind: 'bespreken', tekst: 'Flows nalopen', klant: 'tonzon', met: 'Vincent' }),
      ctx,
    );
    expect(p.section).toBe('## Bespreken bij eerstvolgend contactmoment');
    expect(p.line).toBe('- [ ] Flows nalopen [klant:: tonzon] [met:: Vincent]');
  });

  it('partneractie: actieregel in de volgorde van het schema, (voorstel), id per slug en dag', () => {
    const p = planRepoWrite(
      RepoWrite.parse({
        kind: 'partneractie',
        slug: 'feenstra',
        tekst: 'Prijzen sturen',
        eigenaar: 'Robert',
        ligt: 'bij-hen',
        bron: 'https://x/2',
      }),
      ctx,
    );
    expect(p).toMatchObject({ repo: 'context', path: 'partners/feenstra/acties.md', op: 'append' });
    expect(p.line).toBe(
      '- [ ] Prijzen sturen [eigenaar:: Robert] [datum:: 2026-11-10] (voorstel) [ligt:: bij-hen] [sinds:: 2026-10-30] [bron:: https://x/2] [id:: feenstra-20261030-2]',
    );
    const back = actionLine(p.line)!;
    expect(back).toMatchObject({ voorstel: true, datum: '2026-11-10', id: 'feenstra-20261030-2', ligt: 'bij-hen' });
  });

  it('meeting: nieuw bestand met frontmatter en vaste koppen; pad volgens het schema', () => {
    const p = planRepoWrite(
      RepoWrite.parse({
        kind: 'meeting',
        slug: 'feenstra',
        meetingId: 'evt123',
        datum: '2026-10-29',
        onderwerp: 'Kwartaaloverleg Q4 (warmtepomp)',
        partners: ['feenstra'],
        label: 'bestaande-klant',
        opgenomenDoor: 'Robert Verveen',
        bron: 'https://notes.example/1',
        samenvatting: ['Funnel loopt goed'],
      }),
      ctx,
    );
    expect(p.path).toBe('partners/feenstra/meetings/2026-10-29-kwartaaloverleg-q4-warmtepomp-robert.md');
    expect(p.op).toBe('new-file');
    const { fm, body } = frontmatter(p.line);
    expect(fm).toMatchObject({ meeting_id: 'evt123', label: 'bestaande-klant', sprekers_betrouwbaar: 'nee' });
    expect(Object.keys(sections(body))).toEqual(['Samenvatting', 'Besluiten', 'Acties', 'Eigen notities']);
  });

  it('weigert een slug die niet in het register staat (geen eigen map aanmaken)', () => {
    expect(() => planRepoWrite(RepoWrite.parse({ kind: 'bespreken', tekst: 'x', klant: 'onbekend' }), ctx)).toThrow(
      RepoWriteError,
    );
  });

  it('schema-grenzen: max. 300 tekens, geen [ ] of regeleinde in de tekst', () => {
    expect(RepoWrite.safeParse({ kind: 'bespreken', tekst: 'a'.repeat(301), klant: 'feenstra' }).success).toBe(false);
    expect(RepoWrite.safeParse({ kind: 'bespreken', tekst: 'x [id:: kaping]', klant: 'feenstra' }).success).toBe(false);
    expect(RepoWrite.safeParse({ kind: 'wachten-op', tekst: 'x\n- [x] nep', wie: 'A' }).success).toBe(false);
  });

  it('werkdagen slaan het weekend over', () => {
    expect(addWorkdaysYmd('2026-10-30', 1)).toBe('2026-11-02');
    expect(addWorkdaysYmd('2026-10-30', 7)).toBe('2026-11-10');
  });
});
