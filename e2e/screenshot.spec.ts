// Capture a real screenshot of the booted app (D23 evidence gate).
// Launches the built Electron app offscreen via Playwright and writes a PNG of
// the mounted AppShell so a human (and the orchestrator) can visually confirm the
// real app renders — the headless stand-in for "launch the app and look at it".

import { mkdirSync } from 'node:fs';

import { test } from '@playwright/test';

import { launchApp } from './helpers';

test('capture booted AppShell screenshot', async () => {
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
