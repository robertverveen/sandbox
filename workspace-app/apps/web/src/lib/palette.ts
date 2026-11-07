/**
 * Logica van het ⌘K-palet zonder React (los te testen), naar palEntries() in het prototype:
 * komma-verfijning (eerste deel organisatie of onderwerp, daarna onderwerpen en tijdlijn/gantt),
 * organisaties uit het register, gesprekken (kanalen, DM's, mailthreads), items per bron en de contextlaag.
 */
import type { Actie, Conversation, ContextSnapshot, Item, Partner } from '@hz/shared';

export const ORDER: Item['type'][] = ['commit', 'task', 'context', 'meeting', 'rec', 'mail', 'slack', 'jira'];

const MODES: Record<string, 'timeline' | 'gantt'> = { tijdlijn: 'timeline', timeline: 'timeline', gantt: 'gantt' };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function matchPartners(partners: Partner[], q: string): Partner[] {
  const n = norm(q);
  if (n.length < 2) return [];
  const score = (p: Partner) => {
    const names = [p.slug, p.naam, ...p.aliassen].map(norm);
    if (names.some((x) => x === n)) return 0;
    if (names.some((x) => x.startsWith(n))) return 1;
    if (names.some((x) => x.includes(n))) return 2;
    return 9;
  };
  return partners
    .map((p) => [score(p), p] as const)
    .filter(([s]) => s < 9)
    .sort((a, b) => a[0] - b[0] || a[1].naam.localeCompare(b[1].naam, 'nl'))
    .map(([, p]) => p);
}

export interface ParsedQuery {
  raw: string;
  /** Herkende organisaties (slugs). */
  entities: string[];
  keywords: string[];
  mode: 'list' | 'timeline' | 'gantt';
}

/** Een deel is een organisatie als het exact is, of het begin van precies één organisatie (min. 3 tekens). */
export function parseQuery(q: string, partners: Partner[]): ParsedQuery {
  const P: ParsedQuery = { raw: q, entities: [], keywords: [], mode: 'list' };
  for (const seg of q.split(',')) {
    const s = seg.trim().replace(/^@/, '');
    if (!s) continue;
    const low = s.toLowerCase();
    if (MODES[low]) {
      P.mode = MODES[low];
      continue;
    }
    const n = norm(s);
    const names = (p: Partner) => [p.slug, p.naam, ...p.aliassen].map(norm);
    const exact = partners.find((p) => names(p).includes(n));
    const prefix = n.length >= 3 ? partners.filter((p) => names(p).some((x) => x.startsWith(n))) : [];
    const org = exact ?? (prefix.length === 1 ? prefix[0] : undefined);
    if (org) {
      if (!P.entities.includes(org.slug)) P.entities.push(org.slug);
    } else P.keywords.push(low);
  }
  return P;
}

export interface CtxHit {
  kind: 'brief' | 'actie';
  slug: string;
  title: string;
  sub: string;
  date?: string;
}

export type Entry =
  | { kind: 'conv'; c: Conversation }
  | { kind: 'live'; q: string; title: string; mode: ParsedQuery['mode'] }
  | { kind: 'entity'; p: Partner; counts: string }
  | { kind: 'item'; it: Item }
  | { kind: 'ctx'; h: CtxHit }
  | { kind: 'cmd'; id: string };

const haystack = (it: Item) =>
  [
    it.title,
    'body' in it ? (it.body ?? '') : '',
    'channel' in it ? it.channel : '',
    'fromName' in it ? (it.fromName ?? '') : '',
    ...(it.type === 'meeting' || it.type === 'rec' ? (it.attendeeNames ?? []) : []),
  ]
    .join(' ')
    .toLowerCase();

/** Gesprekken: kanaal, DM of mailthread op naam (zoals convHits in het prototype), plus die van de organisatie. */
export function matchConversations(
  convs: Conversation[],
  q: string,
  entities: string[],
): Array<[number, Conversation]> {
  const cq = q.split(',')[0]!.trim().replace(/^[@#]/, '').toLowerCase();
  if (cq.length < 2 || q.includes(',')) return [];
  const n = (x: string) => x.toLowerCase().replace(/^#/, '');
  const bare = (x: string) => n(x).replace(/^[\d-]+/, '');
  return convs
    .map((c): [number, Conversation] => {
      const name = n(c.name);
      const sc =
        bare(c.name).startsWith(cq) || name.startsWith(cq)
          ? 0
          : name.split(/[\s,-]+/).some((w) => w.startsWith(cq))
            ? 1
            : entities.some((e) => c.entities.includes(e))
              ? 1
              : (name + ' ' + (c.kind === 'mail' ? (c.preview ?? '').toLowerCase() : '')).includes(cq)
                ? 2
                : 9;
      return [sc, c];
    })
    .filter(([s]) => s < 9)
    .sort((a, b) => a[0] - b[0] || (b[1].time ?? '').localeCompare(a[1].time ?? ''))
    .slice(0, 4);
}

/** Contextlaag: brief.md van de organisatie en open acties die passen (geen admin.md, nooit). */
export function contextHits(ctx: ContextSnapshot | undefined, P: ParsedQuery): CtxHit[] {
  if (!ctx || (!P.entities.length && !P.keywords.length)) return [];
  const out: CtxHit[] = [];
  const kwOk = (t: string) => P.keywords.every((k) => t.toLowerCase().includes(k));
  for (const slug of P.entities) {
    const p = ctx.partners[slug];
    if (p && !P.keywords.length)
      out.push({
        kind: 'brief',
        slug,
        title: `${p.soort === 'project' ? 'projecten' : 'partners'}/${slug}/brief.md`,
        sub: [p.fase, p.accountmanager && `accountmanager ${p.accountmanager}`, `${p.open_acties} open acties`]
          .filter(Boolean)
          .join(' · '),
        date: p.bijgewerkt?.slice(0, 10) || undefined,
      });
  }
  const docs = P.entities.length ? P.entities.map((s) => ctx.acties[s]).filter(Boolean) : Object.values(ctx.acties);
  const acts: Array<{ slug: string; naam: string; a: Actie }> = [];
  for (const d of docs)
    for (const a of d!.acties)
      if (a.state === 'open' && (P.keywords.length ? kwOk(a.tekst) : true))
        acts.push({ slug: d!.slug, naam: d!.naam, a });
  acts.sort((x, y) => (x.a.datum ?? '9').localeCompare(y.a.datum ?? '9'));
  for (const { slug, naam, a } of acts.slice(0, P.entities.length ? 3 : 5))
    out.push({
      kind: 'actie',
      slug,
      title: a.tekst,
      sub: [naam, a.eigenaar, a.ligt].filter(Boolean).join(' · '),
      date: a.datum,
    });
  return out;
}

export interface PaletteData {
  items: Item[];
  partners: Partner[];
  conversations: Conversation[];
  context?: ContextSnapshot;
  srcPlural: Record<Item['type'], string>;
}

/** Bouw de resultaten voor een zoekopdracht (niet voor `>`-commando's of een leeg veld). */
export function searchEntries(q: string, data: PaletteData) {
  const t = q.trim();
  const P = parseQuery(t, data.partners);
  const out: Entry[] = [];
  const convHits = matchConversations(data.conversations, t, P.entities);
  const strong = convHits.length > 0 && convHits[0]![0] === 0;
  const title = [...P.entities.map((s) => data.partners.find((p) => p.slug === s)?.naam ?? s), ...P.keywords].join(
    ' · ',
  );
  if (strong) convHits.forEach(([, c]) => out.push({ kind: 'conv', c }));
  if (P.entities.length || P.keywords.length) out.push({ kind: 'live', q: t, title: title || t, mode: P.mode });
  if (!strong) convHits.forEach(([, c]) => out.push({ kind: 'conv', c }));

  const last = t.split(',').pop()!.trim();
  const sugg = last.length >= 2 ? matchPartners(data.partners, last).map((p) => p.slug) : [];
  const orgs = [...new Set([...P.entities, ...sugg])].slice(0, 2);
  for (const slug of orgs) {
    const p = data.partners.find((x) => x.slug === slug)!;
    const mine = data.items.filter((i) => i.entities.includes(slug));
    const ctxN = contextHits(data.context, { ...P, entities: [slug], keywords: [] }).length;
    const counts = ORDER.map((ty) => [ty, ty === 'context' ? ctxN : mine.filter((i) => i.type === ty).length] as const)
      .filter(([, n]) => n)
      .map(([ty, n]) => `${n} ${data.srcPlural[ty].toLowerCase()}`)
      .join(' · ');
    out.push({ kind: 'entity', p, counts });
  }

  const hits = data.items.filter((it) => {
    if (P.entities.length && !P.entities.some((e) => it.entities.includes(e))) return false;
    const h = haystack(it);
    return P.keywords.every((k) => h.includes(k)) && (P.entities.length > 0 || P.keywords.length > 0);
  });
  const ctx = contextHits(data.context, P);
  const counts: Partial<Record<Item['type'], number>> = { context: ctx.length };
  for (const ty of ORDER) {
    if (ty === 'context') {
      ctx.forEach((h) => out.push({ kind: 'ctx', h }));
      continue;
    }
    const g = hits.filter((h) => h.type === ty);
    counts[ty] = g.length;
    g.slice(0, 5).forEach((it) => out.push({ kind: 'item', it }));
  }
  return { entries: out, parsed: P, counts };
}
