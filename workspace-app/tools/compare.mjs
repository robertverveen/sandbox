#!/usr/bin/env node
/**
 * Zet de lat (.local/bar) en onze app (.local/ours) naast elkaar in .local/compare/index.html.
 *   node tools/compare.mjs            # met labels
 *   node tools/compare.mjs --blind    # links/rechts per paar willekeurig, sleutel in .local/compare/key.json
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const blind = process.argv.includes('--blind');
const out = join(root, '.local/compare');
mkdirSync(out, { recursive: true });
const pairs = [];
for (const mode of ['demo', 'context']) {
  const bd = join(root, '.local/bar', mode);
  const od = join(root, '.local/ours', mode);
  if (!existsSync(bd) || !existsSync(od)) continue;
  for (const f of readdirSync(bd)
    .filter((x) => x.endsWith('.png'))
    .sort()) {
    if (existsSync(join(od, f))) pairs.push({ mode, f, bar: `../bar/${mode}/${f}`, ours: `../ours/${mode}/${f}` });
  }
}
const key = {};
const rows = pairs
  .map((p, i) => {
    const swap = blind && Math.random() < 0.5;
    const [l, r] = swap ? [p.ours, p.bar] : [p.bar, p.ours];
    key[`${i + 1}`] = { file: `${p.mode}/${p.f}`, left: swap ? 'ours' : 'bar', right: swap ? 'bar' : 'ours' };
    const label = (side) => (blind ? side : side === 'A' ? 'lat (prototype)' : 'onze app');
    return `<section><h2>${i + 1}. ${p.mode} · ${p.f.replace('.png', '')}</h2><div class="pair"><figure><figcaption>${label('A')}</figcaption><img src="${l}" loading="lazy"></figure><figure><figcaption>${label('B')}</figcaption><img src="${r}" loading="lazy"></figure></div></section>`;
  })
  .join('\n');
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Lat vs onze app</title><style>body{font:14px system-ui;margin:16px;background:#f4f4f2}h2{font-size:14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}img{width:100%;border:1px solid #ccc;background:#fff}figcaption{font-weight:600;margin:4px 0}</style><h1>Lat vs onze app${blind ? ' (blind)' : ''}</h1>${rows || '<p>Nog geen paren: draai eerst pnpm bar en pnpm shot.</p>'}`,
);
if (blind) writeFileSync(join(out, 'key.json'), JSON.stringify(key, null, 1));
console.log(`${pairs.length} paren in .local/compare/index.html${blind ? ' (sleutel in key.json)' : ''}`);
