// bughunt3 回帰ロック — behavioural + screenshot E2E: the GLOBAL keyboard-shortcut
// dispatcher must STAND DOWN when something else owns the keyboard.
//
// THE POINT (H1 / H2): the shell's window-level keydown listener (Ctrl+Z=EditUndo,
// Delete=EditDelete, Ctrl+Y=EditRedo) used to fire UNCONDITIONALLY — so it (H1) undid
// a domain op THROUGH an open modal and (H2) double-fired alongside an Add/Knife tool's
// own Ctrl+Z while drawing. The fix threads a single `suspended = modalOpen ||
// toolDrawing` flag into useShortcuts. This spec proves the WHOLE flow end-to-end in
// the REAL built Electron app — driving real键盘 input and observing live behaviour:
//
//   H2 — In 追加モード with history non-empty (one committed face), place 2 vertices,
//        press Ctrl+Z → ONLY the last vertex is removed (count 2 → 1) AND the previously
//        committed face REMAINS (the global EditUndo never fired). Screenshot.
//   H1 — Open the 設定 dialog (ツール menu), press Ctrl+Z → the committed face is STILL
//        present (no undo THROUGH the modal). Screenshot.
//
// The add導線 / feature-list helpers mirror knife-nway.spec.ts (single真実源 of the
// E2E pattern). The committed-feature survival is read off the same sidebar
// feature-list the regression suite uses.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = resolve(projectRoot, 'screenshots');
mkdirSync(shotDir, { recursive: true });

/** Land in 追加モード idempotently from any starting mode. */
async function enterAddMode(page: Page): Promise<void> {
  const addMode = page.getByTestId('mode-add');
  if ((await addMode.getAttribute('aria-pressed')) === 'true') return;
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  if ((await addMode.getAttribute('aria-pressed')) !== 'true') {
    await expect(addMode).toBeEnabled();
    await addMode.click();
  }
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
}

/** Return to View so the sidebar feature-list reflects the committed forest. */
async function goView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) !== 'true') {
    await v.click().catch(() => undefined);
  }
}

async function showFeaturesTab(page: Page): Promise<void> {
  const tab = page.getByTestId('sidebar-tab-features');
  if (await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => undefined);
  }
}

async function featureListCount(page: Page): Promise<number> {
  await showFeaturesTab(page);
  if ((await page.getByTestId('feature-list-empty').count()) > 0) return 0;
  return page.locator('[data-testid^="feature-list-item-"]').count();
}

/** Commit ONE face through the live add導線, returning its on-screen box. */
async function commitOneFace(page: Page): Promise<{ cx: number; cy: number }> {
  await enterAddMode(page);
  await page.getByTestId('tool-add.area').click();
  const addLayer = page.getByTestId('add-input-layer');
  await expect(addLayer).toBeVisible();
  const b = (await addLayer.boundingBox())!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  for (const [dx, dy] of [
    [-120, -120],
    [120, -120],
    [120, 120],
    [-120, 120],
  ] as const) {
    await page.mouse.click(cx + dx, cy + dy);
  }
  await page.getByTestId('add-complete').click();
  await page.getByTestId('add-save').click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
  return { cx, cy };
}

test.describe('bughunt3 — グローバルショートカットはモーダル表示中・ツール描画中に suspend される', () => {
  test('H2: 追加描画中の Ctrl+Z は頂点のみ取消し、確定済み地物は残る（二重undo解消）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- 1. Commit ONE face so the undo history is non-empty. ---
      await commitOneFace(page);
      await goView(page);
      const countBefore = await featureListCount(page);
      expect(countBefore).toBe(1);

      // --- 2. Re-enter 追加モード, place 2 vertices of a NEW (uncommitted) face. ---
      await enterAddMode(page);
      await page.getByTestId('tool-add.area').click();
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const b = (await addLayer.boundingBox())!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await page.mouse.click(cx - 60, cy - 60);
      await page.mouse.click(cx + 60, cy - 60);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('2');

      // --- 3. Ctrl+Z while drawing: ONLY the last vertex is removed (2 → 1). The
      // global EditUndo is suspended, so the previously committed face is NOT rolled
      // back. (Before the fix this single Ctrl+Z removed a vertex AND undid the commit.)
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('add-vertex-count')).toHaveText('1');
      await page.screenshot({ path: resolve(shotDir, 'bughunt3-h2-add-undo.png') });

      // --- 4. The committed face survived: cancel the draft, return to View, count is
      // still 1 (the commit was never undone through the tool's Ctrl+Z). ---
      await page.getByTestId('add-cancel').click();
      await goView(page);
      await expect.poll(async () => featureListCount(page), { timeout: 15_000 }).toBe(countBefore);
    } finally {
      await app.close();
    }
  });

  test('H1: 設定モーダル表示中の Ctrl+Z は確定済み地物を undo しない（モーダル貫通解消）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- 1. Commit ONE face so an undo WOULD have something to roll back. ---
      await commitOneFace(page);
      await goView(page);
      const countBefore = await featureListCount(page);
      expect(countBefore).toBe(1);

      // --- 2. Open the 設定 dialog through the ツール menu (the live導線). ---
      await page.getByTestId('menu-tools').click();
      const settingsItem = page
        .getByTestId('menu-items-tools')
        .locator('[data-command="tools.settings"]');
      await expect(settingsItem).toBeEnabled();
      await settingsItem.click();
      await expect(page.getByTestId('settings-dialog')).toBeVisible();

      // --- 3. Ctrl+Z while the modal is open MUST NOT reach the global EditUndo: the
      // committed face must NOT be undone THROUGH the dialog. ---
      await page.keyboard.press('Control+z');
      await page.screenshot({ path: resolve(shotDir, 'bughunt3-h1-modal-undo.png') });

      // The dialog absorbs / ignores the key; the committed feature still exists.
      await page.getByTestId('settings-cancel').click();
      await expect(page.getByTestId('settings-dialog')).not.toBeVisible();
      await goView(page);
      await expect.poll(async () => featureListCount(page), { timeout: 15_000 }).toBe(countBefore);
    } finally {
      await app.close();
    }
  });
});
