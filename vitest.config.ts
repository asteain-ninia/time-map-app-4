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
    // Determinism of the test GATE (build-health). The full suite mixes node and
    // jsdom files and runs the React (`@vitejs/plugin-react`) transform on the
    // `.test.tsx` set. Under a shared worker, jsdom global state and the React
    // transform's per-module registry can leak across files in the same process,
    // surfacing as a phantom cross-file error (e.g. a stale `useEffect is not
    // defined` originating from a file that no longer imports it) and making the
    // green/red signal non-reproducible — unusable as an acceptance gate. We pin a
    // fully isolated `forks` pool so EVERY test file gets a fresh child process
    // with a clean module graph and clean globals; one file can never contaminate
    // another. This makes vitest 2.x's current defaults explicit (guarding against
    // a future default change) and is the build-health complement to the results-
    // cache being disabled below (single, reproducible source of truth for "what
    // passed", 開発ガイド §4).
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
      },
    },
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
      // U20 shell pure-logic tests: mode/tool mapping, edit-permission gate,
      // command registry, shortcut keymap/resolve/dispatch, drag reducer,
      // z-order, resize throttle, menu↔keymap agreement, window-size contract.
      // These import only pure `.ts` (never React/.tsx), so they run in node.
      'src/ui/shell/**/*.test.ts',
      // U37 survey mode pure-logic tests: render-batch builder + distance/string
      // formatting. These import only pure `.ts` (domain survey + render primitive
      // types), so they run in node without a DOM.
      'src/ui/survey/**/*.test.ts',
      // U35 conflict-resolution pure-logic tests: the resolution-draft model
      // (全件指定済み判定・時間表示・drafts→Resolution 写像) and the minimap
      // preview build (U19 描画コマンド列の再利用). These import only pure `.ts`
      // (domain consistency/geometry + render feature-layer), so they run in node.
      'src/ui/conflict/**/*.test.ts',
      // U32 property-panel pure-logic tests: selection-display judgment (FR-83),
      // object-link classification (FR-98), 時間バー time↔pixel mapping + label
      // occupancy (FR-60), open-detail-panels model (FR-99), edit-intent no-op
      // guard (FR-97). These import only pure `.ts` (domain + time-display), so
      // they run in node without a DOM. Markdown sanitize + React component
      // operation tests are `.test.tsx` (jsdom; covered by the .tsx glob below).
      'src/ui/property/**/*.test.ts',
      // U40 map-interaction pure-logic tests: the (mode × button × hit) dispatch
      // decision + drag threshold, the pan camera-center math (over U17's
      // VTransform), and the PointerDispatcher sequence/teardown/wheel wiring with
      // faked ports. These import only pure `.ts` (domain selection + render
      // transform), so they run in node without a DOM.
      'src/ui/map/**/*.test.ts',
      // U23 add-host pure-logic test: the host frame composition (composeFrame)
      // that places COMMITTED features into the draw batch under the tool overlay
      // (P0-A). Imports only pure `.ts` (render feature-layer + primitive types),
      // so it runs in node without a DOM. The add-tool React operation tests are
      // `.test.tsx` (jsdom; covered by the .tsx glob below).
      'src/ui/add/**/*.test.ts',
      // U15 shell IO + typed-IPC pure-logic tests: .tmap ZIP build/read,
      // atomic write (temp→fsync→rename) with an injected fs port, generation
      // backup naming/selection, auto-save scheduler with a fake clock, the
      // load Zod-boundary adapter, the save pipeline, and the両側 IPC contract
      // (receiver handlers + preload exposure). These import only pure `.ts`
      // (no Electron runtime), so they run in node without a DOM.
      'src/shell/**/*.test.ts',
      // U41 discovery pure-logic tests: filter axes / display-state resolution /
      // search over the visible母集合 / sanitize入口 / validation / error→message
      // conversion / diagnostic log / global error handlers. These import only
      // pure `.ts` (domain ids + zod), so they run in node without a DOM. The
      // ErrorBoundary component test is `.test.tsx` (jsdom; .tsx glob below).
      'src/ui/discovery/**/*.test.ts',
      // U38 settings pure-logic tests: validation (range/boundary), defaults
      // factory, draft→commit diff (no-op guard). These import only pure `.ts`
      // (U16 settings types + U18 grid predicate), so they run in node without a
      // DOM. The dialog component/hook operation test is `.test.tsx` (jsdom; .tsx
      // glob below).
      'src/ui/settings/**/*.test.ts',
      // U39 file-ops pure-logic tests: zoom-limit validation + ZoomRange supply
      // (FR-10), the unsaved-changes guard branch logic (FR-107), the save-context
      // / new-project initialisation (教訓 5.36 / FR-03), the load-flow classifier
      // (FR-104/106), and the load-time auto-repair flow over U14 (FR-106). These
      // import only pure `.ts` (domain persistence/basemap + U16 settings), so they
      // run in node without a DOM.
      'src/ui/file-ops/**/*.test.ts',
      // React component operation tests (jsdom; see environmentMatchGlobs):
      // U21 EventMarkers add/edit/delete/jump (FR-66) AND U20 shell layout /
      // mode toggle / view-only disabling / drag / tooltip / overlay layering.
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
