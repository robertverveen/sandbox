/**
 * HZW-001/HZW-020: de CI die RLS moet bewijzen moet ook echt draaien, en met een testrol die geen superuser is.
 * GitHub leest alleen <git-root>/.github/workflows; de git-root is de map boven workspace-app.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = resolve(app, '..');
const wf = join(root, '.github/workflows/workspace-app.yml');

describe('CI-workflow', () => {
  it('staat in de .github van de git-root, niet in workspace-app (daar leest GitHub niet)', () => {
    expect(existsSync(join(root, '.git')), 'git-root verwacht boven workspace-app').toBe(true);
    expect(existsSync(wf)).toBe(true);
    expect(existsSync(join(app, '.github/workflows'))).toBe(false);
  });

  const text = existsSync(wf) ? readFileSync(wf, 'utf8') : '';

  it('draait in workspace-app met de pnpm-versie uit package.json', () => {
    expect(text).toMatch(/defaults:\s*\n\s*run:\s*\n\s*working-directory: workspace-app/);
    expect(text).toMatch(/package_json_file: workspace-app\/package\.json/);
    expect(text).toMatch(/cache-dependency-path: workspace-app\/pnpm-lock\.yaml/);
  });

  it('Postgres-service met superuser postgres; hz_dev zonder SUPERUSER; runtime-rol via bootstrap-roles.sql', () => {
    expect(text).toMatch(/POSTGRES_USER: postgres\b/);
    expect(text).not.toMatch(/POSTGRES_USER: hz_dev/);
    const create = /CREATE ROLE hz_dev ([^"]*)"/.exec(text)?.[1] ?? '';
    expect(create).toMatch(/\bLOGIN\b/);
    expect(create).toMatch(/\bCREATEDB\b/);
    expect(create).toMatch(/\bNOSUPERUSER\b/);
    expect(create).not.toMatch(/(^|\s)SUPERUSER\b|(^|\s)BYPASSRLS\b/);
    expect(text).toMatch(/-v migrator=hz_dev -f packages\/db\/sql\/bootstrap-roles\.sql/);
  });

  it('maakt de logins die de tests als productie gebruiken: app, indexer, worker en pg-boss (stuk E2)', () => {
    expect(text).toMatch(/-v login=hz_app_login -v password=hz_app_login -f packages\/db\/sql\/app-login\.sql/);
    expect(text).toMatch(
      /-v login=hz_worker_login -v password=hz_worker_login -f packages\/db\/sql\/worker-login\.sql/,
    );
    expect(text).toMatch(
      /-v login=hz_indexer_login -v password=hz_indexer_login -f packages\/db\/sql\/indexer-login\.sql/,
    );
    expect(text).toMatch(
      /-v login=hz_boss -v password=hz_boss_test -v schema=pgboss -f packages\/db\/sql\/boss-login\.sql/,
    );
  });

  it('draait lint, typecheck, test, build en e2e', () => {
    for (const step of ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build', 'pnpm test:e2e'])
      expect(text).toContain(`- run: ${step}`);
  });
});
