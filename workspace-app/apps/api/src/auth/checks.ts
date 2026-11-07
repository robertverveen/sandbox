/**
 * Pure regels voor inloggen en sessies (HZW-010, HZW-011), los te testen.
 */
import type { LoginRefusal } from '@hz/shared';

export const SESSION_DAYS = 30;
export const SESSION_MS = SESSION_DAYS * 864e5;
/** Verlengen (glijdend venster): hooguit één keer per dag een nieuwe vervaldatum en cookie. */
export const RENEW_AFTER_MS = 864e5;
/** Laatste activiteit hooguit eens per vijf minuten bijwerken. */
export const TOUCH_AFTER_MS = 5 * 60_000;

export interface GoogleClaims {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
  name?: unknown;
}

/**
 * Claims uit het ID-token van Google (gevalideerd door de bibliotheek: issuer, audience, nonce, verloop).
 * De server beslist zelf: e-mail in het domein, hd gelijk aan het domein, email_verified waar.
 * Alle drie verplicht; een hd-parameter in de autorisatie-URL is alleen een hint voor Google.
 */
export function checkGoogleClaims(c: GoogleClaims, domain: string): LoginRefusal | null {
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  const at = email.lastIndexOf('@');
  if (at < 1 || email.slice(at + 1) !== domain.toLowerCase()) return 'domein';
  if (typeof c.hd !== 'string' || c.hd.toLowerCase() !== domain.toLowerCase()) return 'domein';
  if (!(c.email_verified === true || c.email_verified === 'true')) return 'ongeverifieerd';
  if (typeof c.sub !== 'string' || !c.sub) return 'fout';
  return null;
}

/** Browser en besturingssysteem zonder versienummers: "chrome|macos". Een browserupdate houdt je ingelogd. */
export function uaFamily(ua: string): string {
  const s = ua || '';
  const browser = /Edg\//.test(s)
    ? 'edge'
    : /OPR\//.test(s)
      ? 'opera'
      : /Firefox\//.test(s)
        ? 'firefox'
        : /Chrome\/|CriOS\//.test(s)
          ? 'chrome'
          : /Safari\//.test(s)
            ? 'safari'
            : '';
  const os = /iPhone|iPad|iPod/.test(s)
    ? 'ios'
    : /Android/.test(s)
      ? 'android'
      : /Mac OS X|Macintosh/.test(s)
        ? 'macos'
        : /Windows/.test(s)
          ? 'windows'
          : /Linux|X11/.test(s)
            ? 'linux'
            : '';
  if (browser || os) return `${browser || 'anders'}|${os || 'anders'}`;
  return s
    .replace(/[\d._]+/g, '')
    .trim()
    .toLowerCase();
}

const B: Record<string, string> = {
  edge: 'Edge',
  opera: 'Opera',
  firefox: 'Firefox',
  chrome: 'Chrome',
  safari: 'Safari',
  anders: 'Browser',
};
const O: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  anders: 'onbekend systeem',
};

/** "Chrome op macOS" voor de lijst met apparaten. */
export function deviceLabel(ua: string): string {
  const f = uaFamily(ua);
  const [b, o] = f.split('|');
  if (!o) return ua ? 'Onbekend apparaat' : 'Onbekend apparaat';
  return `${B[b!] ?? 'Browser'} op ${O[o] ?? 'onbekend systeem'}`;
}

/** Zelfde apparaat? Lege opgeslagen user-agent (oude sessies) telt als onbekend en wordt niet afgewezen. */
export const sameDevice = (stored: string, current: string) => !stored || uaFamily(stored) === uaFamily(current);

export type SessionVerdict =
  | { ok: true; renewTo: Date | null; touch: boolean }
  | { ok: false; reason: 'onbekend' | 'ingetrokken' | 'verlopen' | 'geblokkeerd' | 'ander-apparaat' };

export function judgeSession(
  s: { revokedAt: Date | null; expiresAt: Date; lastSeenAt: Date; userAgent: string; blocked: boolean } | null,
  ua: string,
  now: Date,
): SessionVerdict {
  if (!s) return { ok: false, reason: 'onbekend' };
  if (s.revokedAt) return { ok: false, reason: 'ingetrokken' };
  if (s.expiresAt <= now) return { ok: false, reason: 'verlopen' };
  if (s.blocked) return { ok: false, reason: 'geblokkeerd' };
  if (!sameDevice(s.userAgent, ua)) return { ok: false, reason: 'ander-apparaat' };
  const renew = +s.expiresAt - +now < SESSION_MS - RENEW_AFTER_MS;
  return {
    ok: true,
    renewTo: renew ? new Date(+now + SESSION_MS) : null,
    touch: renew || +now - +s.lastSeenAt > TOUCH_AFTER_MS,
  };
}

/** Alleen relatieve paden binnen de app als terugkeeradres (geen open redirect). */
export function safeReturnTo(v: unknown, fallback = '/'): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return fallback;
  return v.slice(0, 300);
}
