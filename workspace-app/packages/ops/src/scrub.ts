/**
 * Persoonsgegevens en geheimen uit logregels en foutmeldingen halen (HZW-007).
 * Logs en de foutregistratie krijgen nooit e-mailadressen, IP-adressen, tokens of wachtwoorden.
 */

const RULES: [RegExp, string][] = [
  // Verbindings-URL's met gebruiker en wachtwoord: postgres://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[geheim]@'],
  // Bekende tokenvormen
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]+/g, '[slack-token]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[google-token]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[google-token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[github-token]'],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, '[anthropic-key]'],
  [/\bAGE-SECRET-KEY-[A-Z0-9]+/g, '[age-key]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private-key]'],
  // key=value met een gevoelige naam
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|code|state)=([^&\s"']+)/gi,
    '$1=[geheim]',
  ],
  // Persoonsgegevens
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-mail]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '[ip]'],
  [/\bNL\d{2}[A-Z]{4}\d{10}\b/g, '[iban]'],
];

/** Haal persoonsgegevens en geheimen uit een tekst. */
export function scrub(text: string): string {
  let out = text;
  for (const [re, by] of RULES) out = out.replace(re, by);
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Pad voor de access-log: zonder querystring, met id's en e-mailadressen vervangen,
 * zodat een pad nooit herleidbaar is naar een collega of een bericht.
 */
export function maskPath(path: string): string {
  const p = path.split('?')[0] ?? '';
  return p
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {
        /* ongeldige codering: ruw laten */
      }
      if (UUID.test(s)) {
        UUID.lastIndex = 0;
        return ':id';
      }
      UUID.lastIndex = 0;
      if (/@/.test(s)) return ':email';
      if (/^\d+$/.test(s)) return ':n';
      if (s.length > 40 || /[^A-Za-z0-9._-]/.test(s)) return ':key';
      return s;
    })
    .join('/');
}
