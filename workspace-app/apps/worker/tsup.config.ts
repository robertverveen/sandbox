import { defineConfig } from 'tsup';

// Workspace-pakketten (@hz/*) worden meegebundeld; npm-pakketten blijven extern.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@hz\//],
});
