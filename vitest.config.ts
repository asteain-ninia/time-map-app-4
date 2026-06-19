import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Domain + pure-logic tests run in plain Node (no Electron, no jsdom, no React).
// React component operation tests (`*.test.tsx`) run under jsdom so rendering,
// input, toggles and button clicks can be exercised (受け入れ基準8 / 開発ガイド
// 1.9: React コンポーネントの操作テストを実装と同時に作成). The environment is
// chosen per-file via `environmentMatchGlobs` below: `.test.tsx` → jsdom; every
// other test file stays in node.
export default defineConfig({
  // `@vitejs/plugin-react` provides the JSX/TSX transform for the .test.tsx files.
  plugins: [react()],
  test: {
    environment: 'node',
    // Per-file environment: component tests need a DOM; domain/logic tests do not.
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    // Domain tests + the framework-free UI/session state store tests (U16) + the
    // render-layer VTransform / contract tests (U17). The store is built on
    // `zustand/vanilla` and needs no DOM; the render tests cover the PURE
    // transform math and the renderer contract against a fake 2D context / mock
    // renderer, so they too run in the same Node environment without jsdom
    // (技術方針 2.5; VTransform is renderer-independent, 技術方針 2.4 / NFR 5.8).
    include: [
      'src/domain/**/*.test.ts',
      'src/ui/state/**/*.test.ts',
      'src/render/**/*.test.ts',
      // U21 timeline pure-logic tests: BC display, range<->slider mapping, step
      // arithmetic, speed->days conversion, marker model. These import only pure
      // `.ts` (never React/.tsx), so they run in node without a DOM.
      'src/ui/timeline/**/*.test.ts',
      // U21 React component operation tests (jsdom; see environmentMatchGlobs):
      // the EventMarkers add/edit/delete/jump UI path (FR-66, 受け入れ基準3).
      'src/ui/**/*.test.tsx',
    ],
    // Pin the fast-check seed once for the whole suite so property tests are
    // reproducible (no flaky green/red across runs); see src/test-setup.ts.
    // `jest-dom` adds DOM matchers (toBeInTheDocument 等) for the .test.tsx files.
    setupFiles: ['src/test-setup.ts', 'src/test-setup-dom.ts'],
    // Disable the on-disk results/sequencing cache (default:
    // `node_modules/.vite/vitest/results.json`). That cache persists the prior
    // run's per-file results to order slow files first; but when test files are
    // added/renamed/removed by *concurrent* work (this repo is built unit-by-
    // unit in parallel), a stale cached path can be replayed and surface as a
    // phantom "failed to load <deleted>.test.ts" entry in a later run, while the
    // actual file no longer exists on disk or is referenced anywhere. That makes
    // `npm run test` flaky and its green/red signal untrustworthy as an
    // acceptance gate. The file set is always re-globbed from `include`, so the
    // suite is fully determined by the source tree; persisting run history adds
    // no correctness value and only a flakiness surface. Recomputing from a
    // clean module graph each run is the single source of truth for "what is
    // tested" (開発ガイド §4: 単一の真実源). Determinism of *outcomes* is still
    // pinned by FAST_CHECK_SEED above; this only drops the timing cache.
    cache: false,
  },
});
