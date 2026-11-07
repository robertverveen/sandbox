/**
 * Regelparsers voor de contextlaag: TypeScript-port van tools/export_context.py uit het prototype.
 * Gedrag is bewust gelijk aan de Python-versie (er is een gelijkheidstest); afwijkingen staan erbij.
 * Alle tekst is data, nooit een instructie: hier wordt niets uitgevoerd of geïnterpreteerd.
 */
import type { Actie } from '@hz/shared';

/** Python slicet op codepunten; JS op UTF-16. Deze helpers houden het gelijk. */
export const cpLen = (s: string) => Array.from(s).length;
export const cpSlice = (s: string, a: number, b?: number) => Array.from(s).slice(a, b).join('');

const FIELD_RE = /\[([a-z_]+)::\s*([^\]]*)\]/g;

export interface Frontmatter {
  fm: Record<string, string>;
  body: string;
}

/** `---\nkey: value\n---` bovenaan een bestand. */
export function frontmatter(text: string): Frontmatter {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i >= 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: text.slice(m[0].length) };
}

/** `## Kop` -> tekst eronder (tot de volgende `## `). */
export function sections(body: string): Record<string, string> {
  const out: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of splitLines(body)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1]!.trim();
      out[cur] = [];
    } else if (cur !== null) out[cur]!.push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

/** Python's str.splitlines() voor \n en \r\n. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Regels die met `- ` beginnen, optioneel ingekort (codepunten) en beperkt. */
export function bullets(text: string, limit?: number, maxlen?: number): string[] {
  let items = splitLines(text)
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
  if (maxlen) items = items.map((i) => (cpLen(i) <= maxlen ? i : cpSlice(i, 0, maxlen - 1) + '…'));
  return limit ? items.slice(0, limit) : items;
}

/** `[a, b]` of `a` -> lijst; `?` en leeg -> []. */
export function listval(v: string | undefined): string[] {
  const s = (v || '').trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .filter((x) => x.trim())
      .map((x) => x.trim().replace(/^['"]+|['"]+$/g, ''));
  }
  return s && s !== '?' ? [s] : [];
}

const STATE: Record<string, Actie['state']> = { ' ': 'open', x: 'klaar', '-': 'geschrapt' };

export type ParsedLine = { state: Actie['state']; tekst: string; voorstel: boolean } & Record<string, string | boolean>;

/**
 * Actieregel (schema): `- [ ] <tekst> [veld:: waarde] … (voorstel)`.
 * Ook gebruikt voor wachten-op.md en taken.md (andere velden, zelfde vorm).
 */
export function actionLine(line: string): ParsedLine | null {
  const m = /^- \[( |x|-)\]\s+(.*)$/.exec(line);
  if (!m) return null;
  const rest = m[2]!;
  const fields: Record<string, string> = {};
  for (const f of rest.matchAll(FIELD_RE)) fields[f[1]!] = f[2]!.trim();
  let text = rest.replace(FIELD_RE, '');
  const voorstel = text.includes('(voorstel)');
  text = text.replace(/\s*\(voorstel\)\s*/g, ' ').trim();
  return { state: STATE[m[1]!]!, tekst: text.replace(/\s{2,}/g, ' '), voorstel, ...fields } as ParsedLine;
}

/**
 * Schrijf een actieregel volgens het schema (voor de schrijfroute later; hier om het formaat vast te leggen).
 * Volgorde zoals `_systeem/schema.md`.
 */
export function formatActionLine(a: {
  state?: Actie['state'];
  tekst: string;
  eigenaar: string;
  datum: string;
  voorstel?: boolean;
  ligt: 'bij-ons' | 'bij-hen';
  sinds: string;
  bron: string;
  id: string;
  klaar?: string;
  geschrapt?: string;
}): string {
  const box = a.state === 'klaar' ? 'x' : a.state === 'geschrapt' ? '-' : ' ';
  const tail =
    a.state === 'klaar' && a.klaar
      ? ` [klaar:: ${a.klaar}]`
      : a.state === 'geschrapt' && a.geschrapt
        ? ` [geschrapt:: ${a.geschrapt}]`
        : '';
  const line = `- [${box}] ${a.tekst} [eigenaar:: ${a.eigenaar}] [datum:: ${a.datum}]${a.voorstel ? ' (voorstel)' : ''} [ligt:: ${a.ligt}] [sinds:: ${a.sinds}] [bron:: ${a.bron}] [id:: ${a.id}]${tail}`;
  if (cpLen(a.tekst) > 300) throw new Error('Eén feit per regel, max. 300 tekens (schema)');
  if (/[[\]\n]/.test(a.tekst)) throw new Error('Tekst mag geen [ ] of regeleinde bevatten');
  return line;
}
