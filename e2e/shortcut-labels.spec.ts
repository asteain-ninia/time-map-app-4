// HB-2 — behavioural regression E2E: menu accelerator labels resolve to the OS
// idiom, NOT the neutral placeholder "Mod".
//
// The human bug was a Windows user seeing "Mod+S" in the ファイル menu because the
// label formatter showed the lookup chord (chordOf → "mod+s") raw instead of
// resolving `ctrlOrMeta` to the platform key. This spec drives the REAL built
// Electron app (same launch contract as the rest of e2e/) and, by clicking the
// menu open and reading the rendered accelerator, asserts that on this host the
// label contains "Ctrl" and never "Mod" — the regression lock for HB-2.
//
// It uses REAL input (a click to open the menu) and asserts the resulting DOM
// state, matching the 挙動E2E discipline (no controller back-door; the label is
// what a user actually sees).

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

test.describe('HB-2 — ショートカット表記がプラットフォーム解決される', () => {
  test('ファイル menu の保存アクセラレータが Windows で "Ctrl" を含み "Mod" を含まない', async () => {
    const { app, page } = await launchApp();
    try {
      // Derive the EXPECTED modifier from an INDEPENDENT source — the Electron main
      // process's process.platform — NOT from the renderer's own data-platform
      // marker. Otherwise the test would be self-referential: a detectPlatform()
      // bug that mis-classifies the OS would mis-render the label AND skew the
      // expectation, and the regression would slip through (Codex HB-2 観点).
      const osPlatform = await app.evaluate(() => process.platform);
      const expectedMod = osPlatform === 'darwin' ? '⌘' : 'Ctrl';

      // The renderer's resolved platform marker must AGREE with the real OS — this
      // catches a detectPlatform() misclassification directly.
      const marker = await page.getByTestId('menubar').getAttribute('data-platform');
      expect(marker).toBe(osPlatform === 'darwin' ? 'mac' : 'other');

      // Open the ファイル menu with a real click (the only way a user reveals the
      // accelerator labels).
      await page.getByTestId('menu-file').click();

      // 保存 (file.save) carries the Ctrl+S accelerator. Read what the user sees.
      const accel = page.getByTestId('menu-accel-file.save');
      await expect(accel).toBeVisible();
      const label = (await accel.textContent())?.trim() ?? '';

      // The placeholder "Mod" must NEVER reach the user (the HB-2 symptom).
      expect(label.toLowerCase()).not.toContain('mod');
      // It resolves to the OS-idiomatic modifier and still names the key.
      expect(label).toContain(expectedMod);
      expect(label.toUpperCase()).toContain('S');
    } finally {
      await app.close();
    }
  });

  test('全ファイル/編集メニューのアクセラレータに "Mod" が一切現れない', async () => {
    const { app, page } = await launchApp();
    try {
      for (const menuKey of ['file', 'edit'] as const) {
        await page.getByTestId(`menu-${menuKey}`).click();
        const items = page.getByTestId(`menu-items-${menuKey}`);
        await expect(items).toBeVisible();
        const accels = items.locator('.menubar__item-accel');
        const count = await accels.count();
        for (let i = 0; i < count; i++) {
          const text = ((await accels.nth(i).textContent()) ?? '').toLowerCase();
          expect(text).not.toContain('mod');
        }
        // Close the menu before opening the next (click the title again).
        await page.getByTestId(`menu-${menuKey}`).click();
      }
    } finally {
      await app.close();
    }
  });
});
