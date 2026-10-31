#!/usr/bin/env node
// Bouwt _index/graph.json en _index/digest.md. Draai bij elke commit (git hook of GitHub Action).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, digest, lint } from './vault.mjs';

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const nodes = buildIndex(root);
mkdirSync(join(root, '_index'), { recursive: true });
writeFileSync(join(root, '_index', 'graph.json'), JSON.stringify({ generated: new Date().toISOString(), count: Object.keys(nodes).length, nodes }, null, 1));
const d = `# Digest persoonlijke contextlaag\n\n${Object.keys(nodes).length} notities · gegenereerd ${new Date().toISOString().slice(0, 16)}\n\n${digest(nodes)}\n`;
writeFileSync(join(root, '_index', 'digest.md'), d);
const issues = lint(nodes);
writeFileSync(join(root, '_index', 'lint.json'), JSON.stringify(issues, null, 1));
const tokens = Object.values(nodes).reduce((s, n) => s + n.tokens, 0);
console.log(`${Object.keys(nodes).length} notities · digest ~${Math.ceil(d.length / 4)} tokens (alles samen ~${tokens}) · ${issues.length} lint-punten`);
