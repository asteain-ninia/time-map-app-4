import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

// Layer dependency direction is fixed inward toward `domain`.
//   domain  -> (no internal layer)
//   render  -> domain
//   ui      -> domain, render
//   shell   -> domain
// Violations are caught by import/no-restricted-paths below.
const layerBoundaries = {
  rules: {
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          // domain must not import any other internal layer.
          { target: './src/domain', from: './src/render' },
          { target: './src/domain', from: './src/ui' },
          { target: './src/domain', from: './src/shell' },
          // render may only reach into domain.
          { target: './src/render', from: './src/ui' },
          { target: './src/render', from: './src/shell' },
          // shell (Electron main/preload) must not import ui or render.
          { target: './src/shell', from: './src/ui' },
          { target: './src/shell', from: './src/render' },
        ],
      },
    ],
  },
};

// R8 / U14 受け入れ基準8: external input (IPC / file read / external-map input)
// MUST become a domain manifest only through the Zod parse BOUNDARY
// (`parseManifest` in src/domain/persistence/boundary.ts). The deserializer
// (`deserialize`) trusts its argument is an already-validated `Manifest`, so
// calling it on raw `unknown` would smuggle unvalidated input into the domain.
// We forbid every consumer OUTSIDE the persistence module from importing the
// deserializer (or reaching into ./persistence/serialize directly); they must
// route through the boundary's `parseManifest`. The persistence module's own
// files are exempt (they implement the boundary + round-trip). This makes the
// "must pass through Zod" rule structurally enforced, not a convention.
const persistenceBoundary = {
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/domain/persistence/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@/domain/persistence/serialize',
            importNames: ['deserialize'],
            message:
              'External input must pass through parseManifest (the Zod boundary), not deserialize directly (R8 / FR-104).',
          },
          {
            // Belt-and-braces: even though the barrel no longer re-exports
            // `deserialize`, forbid importing that name through the barrel so a
            // future re-export cannot silently reopen the boundary hole (R8).
            name: '@/domain/persistence',
            importNames: ['deserialize'],
            message:
              'deserialize is persistence-internal; external input must pass through parseManifest (the Zod boundary) (R8 / 受け入れ基準8).',
          },
        ],
        patterns: [
          {
            group: ['**/persistence/serialize', '**/persistence/serialize.*'],
            importNames: ['deserialize'],
            message:
              'Import parseManifest from persistence (the Zod boundary); deserialize must not be called on unvalidated input (R8).',
          },
          {
            // Close the barrel loophole: a deserialize import via the barrel
            // (e.g. `@/domain/persistence`, `…/persistence`, `…/persistence/index`)
            // is rejected even if it is re-exported there (受け入れ基準8 / R8).
            group: [
              '**/persistence',
              '**/persistence/index',
              '**/persistence/index.*',
            ],
            importNames: ['deserialize'],
            message:
              'deserialize must not be imported via the persistence barrel; route external input through parseManifest (the Zod boundary) (R8 / 受け入れ基準8).',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    // derle-import: 実データ再構築の一回性ツール+データ置き場(別セッション産・アプリコード外)。
    ignores: ['out/**', 'dist/**', 'build/**', 'node_modules/**', 'derle-import/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.node.json', './tsconfig.web.json', './tsconfig.e2e.json'],
        },
        node: true,
      },
    },
    ...layerBoundaries,
  },
  persistenceBoundary,
  {
    files: ['*.config.{js,ts}', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Node-only maintenance scripts (e.g. the headless launch smoke test).
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // U43 E2E harness (Playwright for Electron). Runs in Node (the test runner)
    // and evaluates snippets in the renderer (browser), so both global sets apply.
    // These files are NOT part of the app layers, so the layer-boundary import
    // rules above (scoped to src/**) do not constrain them.
    files: ['e2e/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
