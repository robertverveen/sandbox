#!/usr/bin/env tsx
/**
 * Gebruik: pnpm --filter @hz/context export <homezero-context> <persoonlijk|-> <uitmap> [--owner Robert]
 * Leest alleen; schrijft JSON naar <uitmap>. Zet de uitmap nooit in Git (echte partnerdata).
 */
import { exportContext } from './export';
import { writeExport } from './files';

const args = process.argv.slice(2);
const oi = args.indexOf('--owner');
const owner = (oi >= 0 ? args[oi + 1] : undefined) ?? 'Robert';
const pos = oi >= 0 ? args.filter((_, i) => i !== oi && i !== oi + 1) : args;
if (pos.length !== 3) {
  console.error('Gebruik: export <homezero-context> <persoonlijk|-> <uitmap> [--owner Naam]');
  process.exit(2);
}
const [ctx, prive, out] = pos as [string, string, string];
const docs = exportContext(ctx, prive === '-' ? null : prive, { owner });
writeExport(out, docs);
console.log(JSON.stringify(docs.context_status.laatste));
