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

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'build/**', 'node_modules/**'],
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
          project: ['./tsconfig.node.json', './tsconfig.web.json'],
        },
        node: true,
      },
    },
    ...layerBoundaries,
  },
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
);
