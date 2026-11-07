// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.local/**',
      'playwright-report/**',
      'test-results/**',
      'packages/db/drizzle/**',
      'packages/context/test/reference/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Workflowscript van de lead: draait in de workflow-harnas, die deze namen als globals meegeeft.
    files: ['tools/lead/golf-workflow.js'],
    languageOptions: {
      globals: { args: 'readonly', agent: 'readonly', log: 'readonly', phase: 'readonly', pipeline: 'readonly' },
    },
  },
);
