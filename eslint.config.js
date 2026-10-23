// Lint rules for the whole workspace: typescript-eslint's strict, type-aware
// rules everywhere, React hooks rules in the webview, Prettier owns formatting.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['spikes/', 'docs/', '.claude/', '**/dist/', '**/out/', '**/.vscode-test/', 'packages/core/schema/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.ts', 'packages/*/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['packages/webview/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },
  {
    // In tests, `!` after an assertion on length or presence is the clearest idiom.
    files: ['packages/*/test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // core is pure: callers pass file contents in, so the same code runs in the extension, MCP and tests.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^(node:|fs$|path$|os$|child_process$)', message: 'core/src has no I/O; pass file contents in.' }] },
      ],
    },
  },
  prettier,
);
