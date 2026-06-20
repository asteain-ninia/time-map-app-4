// U43 — E2E smoke: the composition root boots end-to-end (受け入れ基準 1 / 2 起動).
//
// Drives the REAL built Electron app through Playwright and asserts that the
// composition root (src/ui/App.tsx) actually MOUNTED inside the real shell: the
// AppShell layout (menubar / toolbar / map area / input layer) is present and the
// preload typed-IPC bridge (window.timeMapApi) is live — i.e. the file I/O path
// (save/load) is reachable from the renderer. This is the headless replacement for
// "human launches the app and sees the window" (D7 / D23 非対話厳守).

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

test.describe('起動 — composition root boots end-to-end (FR-111)', () => {
  test('the built app launches and the AppShell layout mounts', async () => {
    const { app, page } = await launchApp();
    try {
      // The full FR-111 chrome is mounted by the live composite (AppShell).
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(page.getByTestId('menubar')).toBeVisible();
      await expect(page.getByTestId('toolbar')).toBeVisible();
      await expect(page.getByTestId('map-area')).toBeVisible();
      // The map INPUT layer exists (pointer events land here, 教訓 5.14).
      await expect(page.getByTestId('map-input-layer')).toBeAttached();
    } finally {
      await app.close();
    }
  });

  test('the typed IPC bridge (window.timeMapApi) is exposed under sandbox (FR-02)', async () => {
    const { app, page } = await launchApp();
    try {
      // The preload exposed the typed file-I/O surface; the renderer can reach
      // save/load ONLY through it (no raw fs). Its presence proves the IPC path
      // the file-ops controller relies on is wired in the live composite.
      const apiShape = await page.evaluate(() => {
        const w = globalThis as unknown as {
          timeMapApi?: Record<string, unknown>;
        };
        const api = w.timeMapApi;
        if (api === undefined) return null;
        return {
          save: typeof api['save'],
          saveAs: typeof api['saveAs'],
          load: typeof api['load'],
          loadDropped: typeof api['loadDropped'],
          configureAutoSave: typeof api['configureAutoSave'],
        };
      });
      expect(apiShape).toEqual({
        save: 'function',
        saveAs: 'function',
        load: 'function',
        loadDropped: 'function',
        configureAutoSave: 'function',
      });
    } finally {
      await app.close();
    }
  });

  test('no renderer console errors during launch (security/load path clean)', async () => {
    const { app, page } = await launchApp();
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    try {
      // Give the app a beat to settle any post-mount effects, then assert clean.
      await page.waitForTimeout(500);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
