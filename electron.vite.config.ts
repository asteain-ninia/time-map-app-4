import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// The application version shown in ヘルプ → バージョン情報 (HB-9). Read from
// package.json at build time so the version label has ONE source of truth and can
// never drift from the published package (§4 単一の真実源). Injected into the
// renderer bundle as the `__APP_VERSION__` global via Vite `define`.
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { readonly version: string };

// Three explicit targets for Electron: main / preload / renderer.
// Kept intentionally thin so the build is readable in one pass.
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'src/shell/main/index.ts'),
      },
      rollupOptions: {
        output: {
          // The root package is `"type": "module"`, so a bare `.js` entry would
          // be parsed as ESM. Electron's main loader cannot ESM-link the
          // built-in `electron` module, so we emit CommonJS with an explicit
          // `.cjs` extension to mark it unambiguously as CommonJS.
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'src/shell/preload/index.ts'),
      },
      rollupOptions: {
        output: {
          // Sandboxed preload must be CommonJS. Under `"type": "module"` a bare
          // `.js` file is treated as ESM, so use an explicit `.cjs` extension;
          // the main process references it as `../preload/index.cjs`.
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/ui'),
    // Inject the package version as a compile-time constant the バージョン情報 view
    // reads (HB-9). `JSON.stringify` so it is replaced as a string literal.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/ui/index.html'),
      },
    },
    plugins: [react()],
  },
});
