/**
 * Import uit het prototype (HZW-021), voor één collega:
 *
 *   DATABASE_URL=postgres://hz_worker_login:…@host/db HZ_AUTH_DATABASE_URL=postgres://hz_auth_login:…@host/db \
 *   HZ_INDEX_DATABASE_URL=postgres://hz_indexer_login:…@host/db \
 *     pnpm --filter @hz/db import:prototype -- --export /pad/buiten/de/repo/export.json --email robert@homezero.nl \
 *       [--naam Robert] [--proef] [--zonder-context] [--opruimen-forceren] [--json]
 *
 * De export maakt een mens (README, "Import uit het prototype"); hij staat nooit in Git. Draait als hz_app met RLS,
 * namens deze ene collega (app.user_id): daarvoor moet de login van DATABASE_URL lid zijn van hz_worker (de
 * worker-login, lokaal de migratierol; de api-login kan het sinds 0011 niet). De collega opzoeken of aanmaken gaat als
 * hz_auth via HZ_AUTH_DATABASE_URL (sql/auth-login.sql; standaard DATABASE_URL). Met --proef wordt hij alleen opgezocht,
 * nooit aangemaakt. De gedeelde contextindex schrijft het als hz_indexer:
 * met HZ_INDEX_DATABASE_URL (sql/indexer-login.sql), of met DATABASE_URL als die login lid is van hz_indexer (lokaal
 * de migratierol). Kan dat niet (de app-login), dan slaat het de contextindex over en zegt dat in het verslag.
 * Opnieuw draaien mag, ook met een nieuwere export: wat de collega in de app wijzigde of verwijderde blijft staan.
 * Partners, meetings en acties die niet meer in de export staan, haalt het uit de contextindex (zou meer dan de
 * helft verdwijnen, dan niet: controleer de export en draai met --opruimen-forceren).
 * Exitcode 0 = aantallen kloppen; 1 = aantallen kloppen niet; 2 = fout in de invoer.
 */
import { canIndex, createAuthDb, createDb, createIndexerDb, DEFAULT_DATABASE_URL, type Db } from './client';
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
  'gebruik: import:prototype -- --export <bestand of map> --email <collega@homezero.nl> [--naam <naam>] [--proef] [--zonder-context] [--opruimen-forceren] [--json]';

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

const { db, close } = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, 2, { allowRoles: ['hz_worker'] });
const auth = process.env.HZ_AUTH_DATABASE_URL ? createAuthDb(process.env.HZ_AUTH_DATABASE_URL, 1) : null;
const indexer = process.env.HZ_INDEX_DATABASE_URL ? createIndexerDb(process.env.HZ_INDEX_DATABASE_URL, 1) : null;
try {
  let context = a['zonder-context'] !== true;
  let contextOvergeslagen: string | undefined;
  const indexDb: Db = indexer?.db ?? db;
  if (context && !(await canIndex(indexDb))) {
    context = false;
    contextOvergeslagen =
      'contextindex overgeslagen: deze login mag niet in de index schrijven (geen lid van hz_indexer). Zet ' +
      'HZ_INDEX_DATABASE_URL (sql/indexer-login.sql); de indexjob van de contextlaag vult de index ook zelf.';
  }
  const r = await importPrototype(db, {
    email: a.email,
    name: typeof a.naam === 'string' ? a.naam : '',
    exportPath: a.export,
    dryRun: a.proef === true || a['dry-run'] === true,
    context,
    indexDb,
    authDb: auth?.db,
    contextOvergeslagen,
    opruimenForceren: a['opruimen-forceren'] === true,
  });
  console.log(a.json ? JSON.stringify(r, null, 2) : formatReport(r));
  process.exitCode = r.klopt ? 0 : 1;
} catch (e) {
  console.error(`import mislukt: ${(e as Error).message}`);
  process.exitCode = 2;
} finally {
  await close();
  await indexer?.close();
  await auth?.close();
}
