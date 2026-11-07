#!/usr/bin/env node
/**
 * Maakt de Content-Security-Policy voor de web-container (HZW-006/007-beveiliging):
 * strikt 'self', plus de sha256-hash van elk inline <script> in de gebouwde index.html (het thema-script dat een
 * flits van licht naar donker voorkomt). Zo is 'unsafe-inline' voor scripts niet nodig.
 *
 *   node web-csp.mjs <dist/index.html> <uit/csp.caddy>
 *
 * form-action staat de OAuth-schermen toe waar de koppelingen (stuk E1/E3) naartoe sturen.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export function inlineScriptHashes(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!m[1].trim()) continue;
    out.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return out;
}

export function buildCsp(html) {
  const hashes = inlineScriptHashes(html);
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
    // React zet style-attributen (kleuren van agenda's); die vallen onder style-src-attr.
    "style-src 'self' 'unsafe-inline'",
    // Avatars en Slack-emoji komen van externe https-adressen.
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self' https://accounts.google.com https://slack.com https://auth.atlassian.com https://github.com",
  ].join('; ');
}

export function cspSnippet(html) {
  return `# Gegenereerd door web-csp.mjs bij het bouwen van het image. Niet met de hand wijzigen.\nheader Content-Security-Policy "${buildCsp(html)}"\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error('gebruik: node web-csp.mjs <dist/index.html> <csp.caddy>');
    process.exit(2);
  }
  writeFileSync(dest, cspSnippet(readFileSync(src, 'utf8')));
  console.log(`CSP geschreven naar ${dest}`);
}
