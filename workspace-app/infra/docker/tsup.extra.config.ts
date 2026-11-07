// Extra bundels voor de images (infra/docker/build-app.sh), naast dist/index.js van de app zelf:
// - migrate.js: migraties als de migratierol (packages/db), vindt de SQL in ../drizzle;
// - ops-cli.js: test-error (foutregistratie testen) en heartbeat-ok (healthcheck).
const root = new URL('../..', import.meta.url).pathname;

// Gewoon object (geen import van tsup): dit bestand ligt buiten de pakketten die tsup als afhankelijkheid hebben.
export default {
  entry: {
    migrate: `${root}packages/db/src/migrate-cli.ts`,
    'ops-cli': `${root}packages/ops/src/cli.ts`,
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: false,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@hz\//],
};
