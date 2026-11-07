/**
 * Tijdhulpen op "wandklok"-datums (Europe/Amsterdam), een-op-een uit het prototype.
 * Een Date hier is een lokale Date waarvan getHours() e.d. de Amsterdamse tijd geven.
 */
export const TZ = 'Europe/Amsterdam';
export const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'] as const;
export const MONTHS = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
] as const;

const tzFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Moment -> wandklok in Amsterdam. */
export function wall(d: Date): Date {
  const p: Record<string, string> = {};
  for (const x of tzFormat.formatToParts(d)) p[x.type] = x.value;
  return new Date(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
}

/** Parse een datum: `JJJJ-MM-DD`, wandklok `JJJJ-MM-DDTHH:MM` of ISO met offset (wordt wandklok). */
export function pd(s: string | Date): Date {
  if (s instanceof Date) return s;
  const str = String(s);
  if (str.length === 10) return new Date(str + 'T00:00');
  if (/(Z|[+-]\d\d:?\d\d)$/.test(str)) return wall(new Date(str));
  return new Date(str);
}

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (dt: Date) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
export const hm = (dt: Date) => `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
export const localISO = (dt: Date) => `${ymd(dt)}T${hm(dt)}:00`;
export const addDays = (dt: Date, n: number) => {
  const x = new Date(dt);
  x.setDate(x.getDate() + n);
  return x;
};
export const startOfDay = (dt: Date) => pd(ymd(dt));
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const dayDiff = (dt: Date, now: Date) => Math.round((+startOfDay(dt) - +startOfDay(now)) / 864e5);

export function dayLabel(dt: Date, now: Date): string {
  const diff = dayDiff(dt, now);
  if (diff === 0) return 'Vandaag';
  if (diff === -1) return 'Gisteren';
  if (diff === 1) return 'Morgen';
  if (diff > 1 && diff < 7) return cap(DAYS[dt.getDay()]!);
  return `${DAYS[dt.getDay()]!.slice(0, 2)} ${dt.getDate()} ${MONTHS[dt.getMonth()]!.slice(0, 3)}`;
}
export const longDay = (dt: Date) => `${DAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
export const fmtDate = (s: string | Date) => {
  const t = pd(s);
  return `${t.getDate()} ${MONTHS[t.getMonth()]!.slice(0, 3)}`;
};

export const isWork = (dt: Date) => dt.getDay() > 0 && dt.getDay() < 6;
export const nextWork = (dt: Date) => {
  let x = addDays(dt, 1);
  while (!isWork(x)) x = addDays(x, 1);
  return x;
};
/** Vandaag, of de eerstvolgende werkdag als het weekend is. */
export const baseDay = (now: Date) => {
  const t = startOfDay(now);
  return isWork(t) ? t : nextWork(t);
};
export function addWorkdays(dt: Date, n: number) {
  let x = startOfDay(dt);
  for (let i = 0; i < n; i++) x = nextWork(x);
  return x;
}
/** Maandag van de week (+offset weken). */
export function weekStart(offset: number, from: Date) {
  const t = startOfDay(from);
  const dow = (t.getDay() + 6) % 7;
  return addDays(t, -dow + offset * 7);
}
export const isoWeek = (dt: Date) => {
  const t = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate() + 3 - ((dt.getDay() + 6) % 7)));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return `${t.getUTCFullYear()}-W${String(1 + Math.round(((+t - +y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
};

/** Korte tijd: vandaag "09:12", "gisteren", deze week "ma", anders "3 okt". */
export function relShort(iso: string, now: Date): string {
  const t = pd(iso);
  const d = dayDiff(t, now);
  if (d === 0) return hm(t);
  if (d === -1) return 'gisteren';
  if (d > -7) return DAYS[t.getDay()]!.slice(0, 2);
  return `${t.getDate()} ${MONTHS[t.getMonth()]!.slice(0, 3)}`;
}

/** Wandklok in Amsterdam (`JJJJ-MM-DDTHH:MM`) -> echt moment. Werkt rond zomer- en wintertijd. */
export function amsterdamToInstant(local: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(local);
  if (!m) throw new Error(`geen wandkloktijd: ${local}`);
  const target = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = wall(new Date(guess));
    const asUtc = Date.UTC(w.getFullYear(), w.getMonth(), w.getDate(), w.getHours(), w.getMinutes(), w.getSeconds());
    const diff = target - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** Echt moment -> wandklok-string `JJJJ-MM-DDTHH:MM`. */
export const toLocal = (d: Date) => {
  const w = wall(d);
  return `${ymd(w)}T${hm(w)}`;
};
