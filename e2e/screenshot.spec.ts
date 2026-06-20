// Capture real screenshots of the booted app (D23 evidence gate).
//
// Launches the built Electron app OFFSCREEN via Playwright (no GUI, 非対話) and
// writes two PNGs a human (and the orchestrator) can visually inspect:
//   - screenshots/app-shell.png   — the booted shell (起動直後の空状態)
//   - screenshots/with-feature.png — the shell AFTER one real feature is committed
//     through the LIVE add flow, so the map canvas actually has a feature drawn on
//     it (proof that committed geometry reaches the renderer, not just the store).
// This is the headless stand-in for "launch the app and look at it" (D7 / D23).

import { mkdirSync } from 'node:fs';

import { test, expect } from '@playwright/test';

import { commitOneFace, launchApp } from './helpers';

test('capture booted AppShell screenshot (empty state)', async () => {
  const { app, page } = await launchApp();
  try {
    mkdirSync('screenshots', { recursive: true });
    // Let post-mount effects (layout, canvas first paint) settle.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshots/app-shell.png' });
  } finally {
    await app.close();
  }
});

test('capture AppShell screenshot WITH a committed feature drawn on the map', async () => {
  const { app, page } = await launchApp();
  try {
    mkdirSync('screenshots', { recursive: true });
    // Commit one real 面 through the live add flow (selection re-resolves to it).
    await commitOneFace(page);
    // The canvas mount is still attached (draw path is subscription-based, not a
    // React remount) — the committed feature is on the rendered map.
    await expect(page.getByTestId('map-canvas-mount')).toBeAttached();
    // Let the post-commit redraw settle so the feature is painted before capture.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshots/with-feature.png' });
  } finally {
    await app.close();
  }
});
