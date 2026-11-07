/**
 * Schrijfkant van de contextlaag, het deel dat geen Git nodig heeft: van een RepoWrite (wat de collega in de app
 * deed) naar precies de regel of het bestand dat in de repo komt, volgens `_systeem/schema.md` en de kop van
 * `wachten-op.md`. De wachtrij (repo_queue) bewaart het resultaat; de schrijfjob van het context-stuk doet
 * `git pull --rebase`, voegt toe, draait `contextcheck.py --push` en pusht (exit 1/2 = niet pushen).
 *
 * Alleen toevoegen: elke RepoWrite wordt `append` of `new-file`, nooit een bestaande regel herschrijven.
 */
import type { RepoQueueEntry, RepoWrite } from '@hz/shared';
import { addWorkdaysYmd } from '@hz/shared/logic';
import { cpLen, formatActionLine } from './parse';

export interface PlannedWrite {
  repo: RepoQueueEntry['repo'];
  path: string;
  op: Extract<RepoQueueEntry['op'], 'append' | 'new-file'>;
  /** Regel, of bij `new-file` de hele bestandsinhoud. */
  line: string;
  slug: string | null;
  /** Kop waaronder de regel komt (alleen wachten-op.md). */
  section?: string;
}

export interface PlanContext {
  /** Vandaag, JJJJ-MM-DD (Europe/Amsterdam). */
  today: string;
  /** Slugs uit `partners/_register.md` (en projecten); alleen daarheen mag geschreven worden. */
  slugs: ReadonlySet<string>;
  /** Volgnummer voor `[id:: <slug>-JJJJMMDD-n]`: het eerstvolgende vrije n voor die slug en dag. */
  nextId: (slug: string, yyyymmdd: string) => number;
}

export class RepoWriteError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_slug' | 'invalid',
  ) {
    super(message);
  }
}

const field = (k: string, v: string | undefined) => (v ? ` [${k}:: ${v}]` : '');

function checkLine(line: string, tekst: string) {
  if (cpLen(tekst) > 300) throw new RepoWriteError('Eén feit per regel, max. 300 tekens (schema)', 'invalid');
  if (/[\n\r]/.test(line)) throw new RepoWriteError('Regel mag geen regeleinde bevatten', 'invalid');
  return line;
}

/** `- [ ] <wat> [wie:: Naam] [sinds:: JJJJ-MM-DD] [reminder:: JJJJ-MM-DD] [bron:: link] [klant:: slug]` */
export function formatWachtenOpLine(w: {
  tekst: string;
  wie: string;
  sinds: string;
  reminder: string;
  bron?: string;
  klant?: string;
}): string {
  return checkLine(
    `- [ ] ${w.tekst}${field('wie', w.wie)}${field('sinds', w.sinds)}${field('reminder', w.reminder)}${field('bron', w.bron)}${field('klant', w.klant)}`,
    w.tekst,
  );
}

/** `- [ ] <wat> [klant:: slug] [met:: contactpersoon]` */
export function formatBesprekenLine(b: { tekst: string; klant: string; met?: string }): string {
  return checkLine(`- [ ] ${b.tekst}${field('klant', b.klant)}${field('met', b.met)}`, b.tekst);
}

/** Kleine letters, koppeltekens, geen accenten (schema: Namen). */
export function kebab(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function meetingPath(m: { slug: string; datum: string; onderwerp: string; opgenomenDoor: string }): string {
  return `partners/${m.slug}/meetings/${m.datum}-${kebab(m.onderwerp)}-${kebab(m.opgenomenDoor.split(/\s+/)[0] ?? '')}.md`;
}

export function meetingFile(m: Extract<RepoWrite, { kind: 'meeting' }>): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '-');
  return [
    '---',
    `meeting_id: ${m.meetingId}`,
    `datum: ${m.datum}`,
    `partners: [${m.partners.join(', ')}]`,
    `label: ${m.label}`,
    `opgenomen_door: ${m.opgenomenDoor}`,
    `sprekers_betrouwbaar: ${m.sprekersBetrouwbaar ? 'ja' : 'nee'}`,
    `bron: ${m.bron}`,
    '---',
    '## Samenvatting',
    list(m.samenvatting),
    '## Besluiten',
    list(m.besluiten),
    '## Acties',
    list(m.acties),
    '## Eigen notities',
    '',
  ].join('\n');
}

/** Van RepoWrite naar regel en pad. Gooit RepoWriteError bij een slug die niet in het register staat. */
export function planRepoWrite(w: RepoWrite, ctx: PlanContext): PlannedWrite {
  const known = (slug: string | undefined) => {
    if (slug && !ctx.slugs.has(slug))
      throw new RepoWriteError(
        `Onbekende organisatie "${slug}": alleen slugs uit partners/_register.md (anders _nog-te-plaatsen, door een mens)`,
        'unknown_slug',
      );
  };
  switch (w.kind) {
    case 'wachten-op': {
      known(w.klant);
      const sinds = w.sinds ?? ctx.today;
      return {
        repo: 'persoonlijk',
        path: 'wachten-op.md',
        op: 'append',
        section: '## Open',
        slug: w.klant ?? null,
        line: formatWachtenOpLine({
          tekst: w.tekst,
          wie: w.wie,
          sinds,
          reminder: w.reminder ?? addWorkdaysYmd(sinds, 3),
          bron: w.bron,
          klant: w.klant,
        }),
      };
    }
    case 'bespreken':
      known(w.klant);
      return {
        repo: 'persoonlijk',
        path: 'wachten-op.md',
        op: 'append',
        section: '## Bespreken bij eerstvolgend contactmoment',
        slug: w.klant,
        line: formatBesprekenLine(w),
      };
    case 'partneractie': {
      known(w.slug);
      const sinds = w.sinds ?? ctx.today;
      const datum = w.datum ?? (w.ligt === 'bij-hen' ? addWorkdaysYmd(sinds, 7) : addWorkdaysYmd(ctx.today, 5));
      const day = ctx.today.replaceAll('-', '');
      const line = formatActionLine({
        tekst: w.tekst,
        eigenaar: w.eigenaar,
        datum,
        voorstel: w.voorstel,
        ligt: w.ligt,
        sinds,
        bron: w.bron,
        id: `${w.slug}-${day}-${ctx.nextId(w.slug, day)}`,
      });
      return { repo: 'context', path: `partners/${w.slug}/acties.md`, op: 'append', slug: w.slug, line };
    }
    case 'meeting': {
      known(w.slug);
      w.partners.forEach(known);
      if (!w.partners.includes(w.slug))
        throw new RepoWriteError('De meeting staat bij de eerste partner uit partners', 'invalid');
      return { repo: 'context', path: meetingPath(w), op: 'new-file', slug: w.slug, line: meetingFile(w) };
    }
  }
}
