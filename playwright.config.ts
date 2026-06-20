// U43 — E2E harness configuration (Playwright for Electron, 技術方針 2.14 / 受け入れ基準 2).
//
// The E2E suite drives the REAL composition root (src/ui/App.tsx) running inside
// the REAL Electron shell (src/shell/main). Each spec launches the *built* app
// (out/main/index.cjs, via the package `main` field) through Playwright's
// `_electron` API — so it exercises the same whenReady -> createWindow -> preload
// (under sandbox) -> renderer load path the production app uses, then asserts the
// shell mounted and drives the input layer / file menu.
//
// NON-INTERACTIVE DISCIPLINE (開発ガイド §5.41 / D7 / D23):
//   - No chromium/webkit browser projects are configured — Electron is launched
//     directly inside the tests, so `playwright install` is NOT required and no
//     browser binaries are downloaded (we install with
//     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
//   - The window renders OFFSCREEN in E2E mode (main reads E2E_TEST=1, same as the
//     SMOKE_TEST offscreen path) so the suite runs headless with no display and
//     no human inspection.
//   - The specs never trigger a NATIVE OS dialog (save/open file pickers would
//     block a headless run); they assert reachability of the file commands and the
//     typed IPC bridge instead, leaving dialog-driven round-trips to U42 + manual
//     verification (D23).
//   - Hard per-test timeout keeps a stuck launch from hanging the runner.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // A launch + a few assertions should be quick; cap it so a broken launch fails
  // fast rather than hanging the unattended runner.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Electron app launches are stateful (one app instance per worker); run serially
  // to keep the harness simple and deterministic on a headless CI box.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  // The batch's FIRST Electron cold launch is the only non-deterministic step (V8
  // warm-up + renderer bundle parse on a loaded headless box). One retry absorbs a
  // lone cold-start outlier so launch LATENCY — not test LOGIC — never reddens the
  // gate. Single re-runs are reliably green; the retry only covers the cold spike,
  // and the explicit 45s app-shell wait in e2e/helpers.ts gives the cold launch a
  // budget sized to the 60s per-test cap (paired fix).
  retries: 1,
  reporter: [['list']],
  use: {
    // Capture a trace on failure so a CI failure is diagnosable without a GUI.
    trace: 'retain-on-failure',
  },
});
