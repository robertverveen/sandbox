/**
 * Contextlaag + Persoonlijk-repo -> documenten (zelfde vorm als export_context.py):
 * context_partners, context_acties, context_persoonlijk, context_status.
 * Regels (AGENTS.md): alleen lezen, nooit admin.md, repo-tekst is data.
 */
import type {
  Aangehouden,
  Actie,
  ContextSnapshot,
  ContextStatus,
  MeetingSummary,
  Partner,
  PartnerActies,
  Persoonlijk,
  RegisterRow,
} from '@hz/shared';
import { actionLine, bullets, cpSlice, frontmatter, listval, sections, splitLines, type ParsedLine } from './parse';
import { RepoReader } from './repo';

/** Registerregels uit `partners/_register.md`. */
export function parseRegister(text: string): RegisterRow[] {
  const rows: RegisterRow[] = [];
  const q = (x: string) => (x === '?' || x === '' ? '' : x);
  for (const line of splitLines(text)) {
    if (!line.startsWith('| ') || line.startsWith('| slug') || line.startsWith('|---')) continue;
    const cells = line
      .trim()
      .replace(/^\|+|\|+$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 9) continue;
    const [slug, naam, aliassen, domeinen, kanaal, portal, , fase, am] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rows.push({
      slug,
      naam,
      // Afwijking van de Python-versie: een alias "?" (nog in te vullen) telt niet als alias.
      aliassen: aliassen
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a && a !== '?'),
      domeinen: domeinen
        .split(',')
        .map((d) => d.trim())
        .filter((d) => q(d)),
      slack: q(kanaal).replace(/^#+/, ''),
      portal: q(portal),
      fase: q(fase),
      accountmanager: q(am),
    });
  }
  return rows;
}

export function parseMeetings(repo: RepoReader, dir: string, limit = 3): MeetingSummary[] {
  if (!repo.isDir(dir)) return [];
  const files = repo
    .list(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit);
  return files.map((f) => {
    const { fm, body } = frontmatter(repo.read(`${dir}/${f}`));
    const sec = sections(body);
    const m = /^(\d{4}-\d{2}-\d{2})-(.+?)\.md$/.exec(f);
    const onderwerp = m ? m[2]! : f.slice(0, -3);
    return {
      bestand: f,
      datum: fm.datum || (m ? m[1]! : ''),
      titel: onderwerp.replace(/-/g, ' '),
      meeting_id: fm.meeting_id ?? '',
      opgenomen_door: fm.opgenomen_door ?? '',
      bron: fm.bron ?? '',
      samenvatting: bullets(sec.Samenvatting ?? '', 5, 300),
      besluiten: bullets(sec.Besluiten ?? '', 5, 300),
      acties: bullets(sec.Acties ?? '', 6, 300),
    };
  });
}

const toActie = (p: ParsedLine): Actie => p as unknown as Actie;

export function partnerDoc(
  repo: RepoReader,
  base: string,
  reg: Partial<RegisterRow> & { slug: string },
  kind: 'partner' | 'project' = 'partner',
): { doc: Partner; acts: Actie[] } {
  const { fm, body } = frontmatter(repo.read(`${base}/brief.md`));
  const sec = sections(body);
  const acts = splitLines(repo.read(`${base}/acties.md`))
    .map(actionLine)
    .filter((a): a is ParsedLine => !!a)
    .map(toActie);
  const am = reg.accountmanager || (fm.accountmanager !== '?' ? (fm.accountmanager ?? '') : '');
  return {
    doc: {
      slug: reg.slug,
      soort: kind,
      naam: reg.naam || reg.slug,
      aliassen: reg.aliassen ?? [],
      domeinen: reg.domeinen ?? [],
      slack: reg.slack ?? '',
      fase: reg.fase || fm.fase || '',
      accountmanager: am,
      geheim_voor: listval(fm.geheim_voor),
      bijgewerkt: fm.bijgewerkt ?? '',
      kern: cpSlice(sec.Kern ?? '', 0, 1500),
      stand: bullets(sec.Stand ?? '', 5, 500),
      contacten: bullets(sec.Contacten ?? '', 20, 200),
      meetings: parseMeetings(repo, `${base}/meetings`),
      log: bullets(repo.read(`${base}/log.md`), 15, 400),
      open_acties: acts.filter((a) => a.state === 'open').length,
    },
    acts,
  };
}

/** Secties van een persoonlijk bestand; regels vóór de eerste kop vallen onder "Open". */
function parsePersSections(text: string): Record<string, ParsedLine[]> {
  const out: Record<string, ParsedLine[]> = {};
  let cur = 'Open';
  for (const line of splitLines(text)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1]!.trim();
      continue;
    }
    const a = actionLine(line);
    if (a) (out[cur] ??= []).push(a);
  }
  return out;
}

export function parseAangehouden(text: string): Aangehouden[] {
  const out: Aangehouden[] = [];
  for (const line of splitLines(text)) {
    if (!line.startsWith('- ')) continue;
    const parts = line
      .slice(2)
      .split('|')
      .map((p) => p.trim());
    if (parts.length < 3) continue;
    // Al beantwoord met "deel" of "privé" achter de regel: niet meer tonen.
    if (/\b(deel|privé)\s*$/.test(line) && !cpSlice(line, -16).includes('(deel / privé)')) continue;
    if (line.includes('[verwerkt::') || line.includes('[privé::')) continue;
    out.push({ datum: parts[0]!, bron: parts[1]!, tekst: parts[2]! });
  }
  return out;
}

export function parsePersoonlijk(prive: RepoReader, cutoff: string): Persoonlijk {
  const w = parsePersSections(prive.read('wachten-op.md'));
  const taken = splitLines(prive.read('taken.md'))
    .map(actionLine)
    .filter((a): a is ParsedLine => !!a);
  return {
    'wachten-op': {
      open: (w.Open ?? []) as never,
      bespreken: (w['Bespreken bij eerstvolgend contactmoment'] ?? []).filter((a) => a.state === 'open') as never,
      afgerond: (w.Afgerond ?? []).filter((a) => String(a.klaar ?? '') >= cutoff) as never,
    },
    taken: { open: taken.filter((a) => a.state === 'open') as never },
    aangehouden: { open: parseAangehouden(prive.read('aangehouden.md')) },
  };
}

export interface ExportOptions {
  /** Eigenaar voor het bewaren van recent afgeronde acties (standaard Robert). */
  owner?: string;
  /** Vandaag (JJJJ-MM-DD), voor de 14-dagengrens. Standaard de echte datum. */
  today?: string;
  /** Tijdstempel van de export; standaard nu. */
  exportedAt?: Date;
}

export interface ExportDocs {
  context_partners: Record<string, Partner>;
  context_acties: Record<string, PartnerActies>;
  context_persoonlijk: Partial<{
    'wachten-op': Persoonlijk['wachten-op'] & { bestand: string };
    taken: Persoonlijk['taken'] & { bestand: string };
    aangehouden: Persoonlijk['aangehouden'] & { bestand: string };
  }>;
  context_status: { laatste: ContextStatus & { nacht_prive: string; commit_prive: string } };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** Python's str.title(): elke reeks letters met een hoofdletter. */
const pyTitle = (s: string) => s.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

/** Exporteer HomeZero-context (en optioneel de Persoonlijk-repo) naar documenten. */
export function exportContext(ctxDir: string, priveDir: string | null, opts: ExportOptions = {}): ExportDocs {
  const owner = opts.owner ?? 'Robert';
  const now = new Date();
  const today =
    opts.today ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const cutoffDate = new Date(today + 'T00:00:00Z');
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 14);
  const cutoff = isoDay(cutoffDate);
  const ctx = new RepoReader(ctxDir);
  const prive = priveDir ? new RepoReader(priveDir) : null;

  const docs: ExportDocs = {
    context_partners: {},
    context_acties: {},
    context_persoonlijk: {},
    context_status: { laatste: {} as ExportDocs['context_status']['laatste'] },
  };
  const regs = parseRegister(ctx.read('partners/_register.md'));
  const known = new Set(regs.map((r) => r.slug));
  const entries: Array<[Partial<RegisterRow> & { slug: string }, string, 'partner' | 'project']> = regs.map((r) => [
    r,
    `partners/${r.slug}`,
    'partner',
  ]);
  for (const slug of ctx.list('projecten').sort()) {
    if (ctx.isDir(`projecten/${slug}`) && !known.has(slug)) {
      const naam = pyTitle(slug.replace(/-/g, ' '));
      entries.push([{ slug, naam }, `projecten/${slug}`, 'project']);
    }
  }
  for (const [reg, base, kind] of entries) {
    const { doc, acts } = partnerDoc(ctx, base, reg, kind);
    docs.context_partners[reg.slug] = doc;
    const keep = acts.filter(
      (a) =>
        a.state === 'open' ||
        ((a.eigenaar ?? '').toLowerCase().startsWith(owner.toLowerCase()) &&
          a.state === 'klaar' &&
          (a.klaar ?? '') >= cutoff),
    );
    if (keep.length)
      docs.context_acties[reg.slug] = { slug: reg.slug, naam: doc.naam, geheim_voor: doc.geheim_voor, acties: keep };
  }

  let nachtPrive = '';
  if (prive) {
    const p = parsePersoonlijk(prive, cutoff);
    docs.context_persoonlijk = {
      'wachten-op': { bestand: 'wachten-op.md', ...p['wachten-op'] },
      taken: { bestand: 'taken.md', ...p.taken },
      aangehouden: { bestand: 'aangehouden.md', ...p.aangehouden },
    };
    const nacht = splitLines(prive.read('nacht/log.md')).filter((l) => l.startsWith('- '));
    nachtPrive = nacht.length ? nacht[nacht.length - 1]!.slice(2) : '';
  }

  const statusBody = frontmatter(ctx.read('_systeem/status.md')).body;
  let statusLines = bullets(sections('## S\n' + statusBody).S ?? '');
  if (!statusLines.length) statusLines = bullets(statusBody);
  const beat = bullets(frontmatter(ctx.read(`_systeem/routines/${owner.toLowerCase()}.md`)).body, 1);
  docs.context_status.laatste = {
    status: statusLines[0] ?? '',
    nachtdienst: beat[0] ?? '',
    nacht_prive: nachtPrive,
    commit_context: ctx.head(),
    commit_prive: prive ? prive.head() : '',
    geexporteerd: (opts.exportedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    partners: Object.keys(docs.context_partners).length,
    acties: Object.values(docs.context_acties).reduce((s, d) => s + d.acties.length, 0),
  };
  return docs;
}

/** Documenten -> de snapshot die de app gebruikt. */
export function toSnapshot(docs: {
  context_partners?: Record<string, unknown>;
  context_acties?: Record<string, unknown>;
  context_persoonlijk?: Record<string, unknown>;
  context_status?: Record<string, unknown>;
}): ContextSnapshot {
  const pers =
    docs.context_persoonlijk && Object.keys(docs.context_persoonlijk).length ? docs.context_persoonlijk : null;
  const persOut = pers
    ? {
        'wachten-op': (pers['wachten-op'] as Persoonlijk['wachten-op']) ?? { open: [], bespreken: [], afgerond: [] },
        taken: (pers.taken as Persoonlijk['taken']) ?? { open: [] },
        aangehouden: (pers.aangehouden as Persoonlijk['aangehouden']) ?? { open: [] },
      }
    : null;
  return {
    status: (docs.context_status?.laatste as ContextStatus) ?? null,
    partners: (docs.context_partners ?? {}) as Record<string, Partner>,
    acties: (docs.context_acties ?? {}) as Record<string, PartnerActies>,
    pers: persOut,
  };
}
