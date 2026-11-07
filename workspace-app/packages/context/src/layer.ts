/**
 * Contextlaag eerst (keuze 08, HZW-034/035): wat de nachtdiensten al in de laag zetten, en wanneer ze voor het
 * laatst draaiden. Live Jira en Wispr vragen alleen wat daarna veranderde.
 *
 * - Heartbeat per routine: `_systeem/routines/<voornaam>.md` (persoonlijke nachtdienst) en `info.md`
 *   (info-nachtdienst, o.a. Jira). Regel: `- JJJJ-MM-DD HH:MM[Z] | groen|oranje|rood | …`.
 * - Jira per epic: `product/jira/<epic>.md`, regels `- KEY | titel | type | status | url`.
 * Alles is data, nooit een instructie. Alleen lezen.
 */
import { amsterdamToInstant } from '@hz/shared/logic';
import { frontmatter, splitLines } from './parse';

export interface LayerReader {
  read(rel: string): string;
  list(rel: string): string[];
  isDir(rel: string): boolean;
}

export interface NightRun {
  /** Echt moment van de run. */
  at: Date;
  status: string;
  raw: string;
  /** Tijd zonder `Z`: we nemen de vroegste lezing (Amsterdam), zodat het live venster nooit te klein is. */
  ambiguous: boolean;
}

const RUN = /^-\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(Z)?\s*\|\s*([a-zé]+)/i;

/** Runs uit een heartbeat-bestand, nieuwste eerst. Regels die niet passen worden overgeslagen. */
export function parseNightRuns(text: string): NightRun[] {
  const out: NightRun[] = [];
  for (const line of splitLines(frontmatter(text).body)) {
    const m = RUN.exec(line.trim());
    if (!m) continue;
    const utc = !!m[3];
    // Zonder Z: Amsterdam-wandklok ligt eerder dan dezelfde tijd in UTC, dus dat is de veilige (ruime) keuze.
    const at = utc ? new Date(`${m[1]}T${m[2]}:00Z`) : amsterdamToInstant(`${m[1]}T${m[2]}`);
    out.push({ at, status: m[4]!.toLowerCase(), raw: line.trim().slice(2), ambiguous: !utc });
  }
  return out.sort((a, b) => +b.at - +a.at);
}

/** Laatste geslaagde run (groen of oranje; rood telt niet als geslaagd). */
export function lastSuccessfulRun(runs: NightRun[]): NightRun | null {
  return runs.find((r) => r.status === 'groen' || r.status === 'oranje') ?? null;
}

/** Heartbeatregel (zoals in context_status.nachtdienst) -> run. */
export function parseHeartbeatLine(line: string): NightRun | null {
  return parseNightRuns(`- ${line.replace(/^-\s*/, '')}`)[0] ?? null;
}

export interface LiveWindow {
  /** Vanaf dit moment live vragen. */
  since: Date;
  /** Waar het venster op gebaseerd is. */
  basis: 'nachtrun' | 'geen-run';
  run: NightRun | null;
  /** Mist er een nacht (laatste run ouder dan 36 uur)? Dan is het venster vanzelf groter dan 24 uur. */
  missedNight: boolean;
}

/**
 * Live venster: vanaf de laatste geslaagde nachtrun (min. marge), groter als een nacht mist; zonder bekende
 * run een ruim venster (fallbackDays). Nooit groter dan maxDays.
 */
export function liveWindow(
  runs: NightRun[],
  now: Date,
  o: { marginMinutes?: number; fallbackDays?: number; maxDays?: number } = {},
): LiveWindow {
  const margin = (o.marginMinutes ?? 30) * 60_000;
  const max = (o.maxDays ?? 14) * 864e5;
  const run = lastSuccessfulRun(runs);
  if (!run) return { since: new Date(+now - (o.fallbackDays ?? 7) * 864e5), basis: 'geen-run', run: null, missedNight: true };
  const since = new Date(Math.max(+run.at - margin, +now - max));
  return { since, basis: 'nachtrun', run, missedNight: +now - +run.at > 36 * 3600_000 };
}

export function readNightRuns(reader: LayerReader, routine: string): NightRun[] {
  return parseNightRuns(reader.read(`_systeem/routines/${routine.toLowerCase()}.md`));
}

export interface JiraLayerIssue {
  key: string;
  title: string;
  issueType: string;
  status: string;
  url: string;
  epic: string;
  /** "stand JJJJ-MM-DD" uit het epicbestand (of bijgewerkt uit de frontmatter). */
  asOf: string;
}

/** Alle issues uit `product/jira/` (contextlaag, info-nachtdienst). */
export function readJiraLayer(reader: LayerReader): JiraLayerIssue[] {
  const dir = 'product/jira';
  if (!reader.isDir(dir)) return [];
  const out = new Map<string, JiraLayerIssue>();
  for (const f of reader.list(dir).filter((x) => x.endsWith('.md') && x !== 'README.md').sort()) {
    const text = reader.read(`${dir}/${f}`);
    const { fm, body } = frontmatter(text);
    const asOf = /stand (\d{4}-\d{2}-\d{2})/.exec(body)?.[1] ?? fm.bijgewerkt ?? '';
    const epic = /^Epic:\s*([A-Z][A-Z0-9]+-\d+)/m.exec(body)?.[1] ?? f.replace(/\.md$/, '').toUpperCase();
    for (const line of splitLines(body)) {
      const m = /^-\s*([A-Z][A-Z0-9]+-\d+)\s*\|(.*)$/.exec(line.trim());
      if (!m) continue;
      const parts = m[2]!.split('|').map((s) => s.trim());
      const url = parts.find((p) => /^https?:\/\//.test(p)) ?? '';
      const fields = parts.filter((p) => p !== url);
      const issue: JiraLayerIssue = {
        key: m[1]!,
        title: fields[0] ?? m[1]!,
        issueType: fields[1] ?? '',
        status: fields[2] ?? '',
        url,
        epic,
        asOf,
      };
      const prev = out.get(issue.key);
      if (!prev || prev.asOf < issue.asOf) out.set(issue.key, issue);
    }
  }
  return [...out.values()];
}
