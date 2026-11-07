/**
 * Import uit het prototype (HZW-021), voor één collega:
 *
 *   DATABASE_URL=postgres://hz_app_login:…@host/db \
 *     pnpm --filter @hz/db import:prototype -- --export /pad/buiten/de/repo/export.json --email robert@homezero.nl \
 *       [--naam Robert] [--proef] [--zonder-context] [--json]
 *
 * De export maakt een mens (README, "Import uit het prototype"); hij staat nooit in Git. Draait als hz_app met RLS:
 * het script kan alleen rijen van deze collega schrijven (en de gedeelde contextindex met purpose 'index').
 * Exitcode 0 = aantallen kloppen; 1 = aantallen kloppen niet; 2 = fout in de invoer.
 */
import { createDb, DEFAULT_DATABASE_URL } from './client';
import { formatReport, importPrototype } from './import';

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (!a.startsWith('--')) throw new Error(`onbekend argument: ${a}`);
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[k] = next;
      i++;
    } else out[k] = true;
  }
  return out;
}

const USAGE =
  'gebruik: import:prototype -- --export <bestand of map> --email <collega@homezero.nl> [--naam <naam>] [--proef] [--zonder-context] [--json]';

let a: Record<string, string | boolean>;
try {
  a = args(process.argv.slice(2));
} catch (e) {
  console.error(`${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (typeof a.export !== 'string' || typeof a.email !== 'string') {
  console.error(USAGE);
  process.exit(2);
}

const { db, close } = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, 2);
try {
  const r = await importPrototype(db, {
    email: a.email,
    name: typeof a.naam === 'string' ? a.naam : '',
    exportPath: a.export,
    dryRun: a.proef === true || a['dry-run'] === true,
    context: a['zonder-context'] !== true,
  });
  console.log(a.json ? JSON.stringify(r, null, 2) : formatReport(r));
  process.exitCode = r.klopt ? 0 : 1;
} catch (e) {
  console.error(`import mislukt: ${(e as Error).message}`);
  process.exitCode = 2;
} finally {
  await close();
}
