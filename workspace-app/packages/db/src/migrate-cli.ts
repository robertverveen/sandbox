import { DEFAULT_DATABASE_URL } from './client';
import { ensureDatabase, runMigrations } from './migrate';

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
await ensureDatabase(url);
await runMigrations(url);
console.log(`migraties klaar op ${new URL(url).pathname.slice(1)}`);
