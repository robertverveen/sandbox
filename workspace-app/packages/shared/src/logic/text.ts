/** Teksthulpen uit het prototype. */
export const short = (s: unknown, n = 90) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};

export const initialsOf = (name: string) =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

const hash = (s: string) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
};

/** Stabiele, niet-cryptografische hash zoals hashStr() in het prototype (sleutel voor keuzes). */
export const hashStr = (s: string) => (hash(s) >>> 0).toString(36);

const AV_TONES: ReadonlyArray<readonly [string, string]> = [
  ['#0022c4', '#fff'],
  ['#f9b20b', '#292f38'],
  ['#b8c6ff', '#0b1a6e'],
  ['#292f38', '#fff'],
  ['#5b74ff', '#fff'],
  ['#fde3a1', '#5c3d00'],
  ['#0b1a6e', '#fff'],
  ['#e7ecff', '#0022c4'],
];
export const avTone = (s: string): readonly [string, string] => AV_TONES[Math.abs(hash(s)) % AV_TONES.length]!;

const HUES = ['#1D6A4C', '#7B3A82', '#2F5FD0', '#0E7490', '#A86B12', '#C2410C', '#4B6B2A', '#8A3B5B', '#5B4BC4'];
export const hashColor = (s: string) => HUES[Math.abs(hash(s)) % HUES.length]!;

export const normOrg = (s: string) =>
  String(s || '')
    .toLowerCase()
    .replace(/\.(nl|com|io|energy|be|de|eu)$/, '')
    .replace(/[^a-z0-9]/g, '');

/** Strip een leidende emoji-reeks (zoals "☀️ Briefing"). */
export const stripLeadingEmoji = (s: string) => s.replace(/^(\p{Extended_Pictographic}️?\s*)+/u, '');
