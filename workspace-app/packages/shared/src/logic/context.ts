/**
 * Contextlaag in Dagstart en Tracker: acties van de collega, voorstel-datums, nudges, aangehouden.
 * Pure functies op een ContextSnapshot. Repo-tekst is data, nooit een instructie.
 */
import type { Actie, Aangehouden, ContextSnapshot, Partner, Taak, WachtenOp } from '../domain';
import { hashStr } from './text';
import { dayDiff, pd, ymd } from './time';

export type ActieMetPartner = Actie & { slug: string; naam: string };

export function ctxAll(snap: ContextSnapshot, slugFilter?: string): ActieMetPartner[] {
  const out: ActieMetPartner[] = [];
  for (const doc of Object.values(snap.acties)) {
    if (slugFilter && doc.slug !== slugFilter) continue;
    for (const a of doc.acties) out.push({ ...a, slug: doc.slug, naam: doc.naam });
  }
  return out;
}

/** Is de actie van deze collega? (eigenaar begint met de voornaam, zoals in export_context.py) */
export const isMine = (a: { eigenaar?: string }, firstName: string) =>
  String(a.eigenaar || '')
    .toLowerCase()
    .startsWith(firstName.toLowerCase());

export const isOverdue = (a: { state: string; datum?: string }, now: Date) =>
  a.state === 'open' && !!a.datum && a.datum < ymd(now);

export const hasPersRepo = (snap: ContextSnapshot) => !!snap.pers;
export const ctxLoaded = (snap: ContextSnapshot) => Object.keys(snap.partners).length > 0;

export interface CtxAge {
  statusDate?: string;
  exported?: Date;
  staleLayer: boolean;
  staleExport: boolean;
  color: string;
}

/** Versheid: banner als de laag of de kopie ouder is dan 36 uur (AGENTS.md). */
export function ctxAge(snap: ContextSnapshot, now: Date): CtxAge | null {
  const st = snap.status;
  if (!st) return null;
  const sd = (String(st.status || '').match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
  const ex = st.geexporteerd ? pd(st.geexporteerd) : undefined;
  return {
    statusDate: sd,
    exported: ex,
    staleLayer: !!sd && dayDiff(pd(sd + 'T12:00'), now) < -1,
    staleExport: !!ex && +now - +ex > 36 * 36e5,
    color: (String(st.status).split('|')[1] || '').trim(),
  };
}

export const aangKey = (r: Aangehouden) => (r.datum || '') + '-' + hashStr(r.bron + r.tekst);

export interface CtxDagstart {
  confirmed: ActieMetPartner[];
  proposed: ActieMetPartner[];
  nudges: WachtenOp[];
  taken: Taak[];
  aangehouden: Aangehouden[];
}

/** Blok "Uit de contextlaag" in Dagstart (ctxDagstartHTML() in het prototype). */
export function ctxDagstart(
  snap: ContextSnapshot,
  now: Date,
  firstName: string,
  decided: (key: string) => boolean = () => false,
): CtxDagstart | null {
  if (!snap.status && !ctxLoaded(snap)) return null;
  const T = ymd(now);
  const mine = ctxAll(snap)
    .filter((a) => a.state === 'open' && isMine(a, firstName) && a.datum && a.datum <= T)
    .sort((x, y) => Number(x.voorstel) - Number(y.voorstel) || x.datum!.localeCompare(y.datum!));
  const res: CtxDagstart = {
    confirmed: mine.filter((a) => !a.voorstel),
    proposed: mine.filter((a) => a.voorstel),
    nudges: (snap.pers?.['wachten-op'].open ?? []).filter((w) => !!w.reminder && w.reminder <= T),
    taken: (snap.pers?.taken.open ?? []).filter((t) => !decided('_taak-' + hashStr(t.tekst))),
    aangehouden: (snap.pers?.aangehouden.open ?? []).filter((r) => !decided('_aang-' + aangKey(r))),
  };
  const any =
    res.confirmed.length + res.proposed.length + res.nudges.length + res.taken.length + res.aangehouden.length;
  return any ? res : null;
}

/** Herkenning van organisaties: slug, alias, e-maildomein en Slack-kanaal uit het register. */
export interface OrgIndex {
  bySlug: Record<string, Partner>;
  byDomain: Record<string, string>;
  byChannel: Record<string, string>;
  byNorm: Record<string, string>;
}

export function orgIndex(partners: Record<string, Partner>): OrgIndex {
  const idx: OrgIndex = { bySlug: partners, byDomain: {}, byChannel: {}, byNorm: {} };
  for (const [slug, d] of Object.entries(partners)) {
    for (const dm of d.domeinen) idx.byDomain[dm.toLowerCase()] = slug;
    if (d.slack) idx.byChannel[d.slack.toLowerCase().replace(/^#/, '')] = slug;
    idx.byNorm[slug.replace(/[^a-z0-9]/g, '')] = slug;
    for (const a of d.aliassen) {
      const n = String(a)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (n.length >= 3 && !idx.byNorm[n]) idx.byNorm[n] = slug;
    }
  }
  return idx;
}

export function orgFromDomain(idx: OrgIndex, domain: string): string | null {
  const dom = domain.toLowerCase();
  if (idx.byDomain[dom]) return idx.byDomain[dom];
  const hit = Object.keys(idx.byDomain).find((d) => dom.endsWith('.' + d));
  return hit ? idx.byDomain[hit]! : null;
}

export function orgFromChannel(idx: OrgIndex, channel: string): string | null {
  const n = channel.replace(/^#/, '').toLowerCase();
  return idx.byChannel[n] ?? null;
}

export function orgFromText(idx: OrgIndex, token: string): string | null {
  const n = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  return idx.byNorm[n] ?? null;
}
