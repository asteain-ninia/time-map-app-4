// HB-5 / HB-10 / HB-11 / HB-12 / HB-13 — UX cluster behavioural + visual E2E.
//
// Drives the REAL built Electron composite (same launch contract as the rest of
// e2e/, via launchApp). Every assertion uses REAL input (click / keyboard) and
// reads the resulting DOM / observation hooks — no controller back-door. The two
// visual baselines lock the scrollbar fix (HB-5) and timeline readability
// (HB-11/12/13); the Ctrl+Y test fires a real key chord and asserts redo ran via
// the live undo/redo observation markers (既存 app-active-feature 方式).

import { test, expect } from '@playwright/test';

import { commitOneFace, launchApp } from './helpers';

test.describe('HB-5 — 不要なスクロールバーが出ない (live shell)', () => {
  test('the outer shell is exactly viewport-sized: no document-level scrollbar', async () => {
    const { app, page } = await launchApp();
    try {
      await page.waitForTimeout(800);
      // The shell grid is min-width/height + overflow:hidden, and every scrollable
      // region scrolls INTERNALLY. So the document element must NOT overflow its
      // own client box (a document scrollbar is the HB-5 symptom).
      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        return {
          vScroll: el.scrollHeight - el.clientHeight,
          hScroll: el.scrollWidth - el.clientWidth,
        };
      });
      // Allow a 1px rounding tolerance; anything larger is a real overflow.
      expect(overflow.vScroll).toBeLessThanOrEqual(1);
      expect(overflow.hScroll).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  test('the timeline panel never overflows the shell horizontally', async () => {
    const { app, page } = await launchApp();
    try {
      await page.waitForTimeout(800);
      const timeline = page.getByTestId('timeline');
      await expect(timeline).toBeVisible();
      // The ticks track + marker track are absolutely positioned by %; a stray
      // edge label used to push a horizontal scrollbar. overflow-x:hidden caps it.
      const h = await timeline.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(h).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  test('visual regression: the booted shell shows no spurious scrollbars', async () => {
    const { app, page } = await launchApp();
    try {
      await page.waitForTimeout(1000);
      const shell = page.getByTestId('app-shell');
      await expect(shell).toBeVisible();
      await expect(shell).toHaveScreenshot('shell-no-scrollbars.png', {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      await app.close();
    }
  });
});

test.describe('HB-10 — やり直しのデフォルトが Ctrl+Y (live keymap)', () => {
  test('the 編集 menu advertises Ctrl+Y for やり直し', async () => {
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('menu-edit').click();
      const accel = page.getByTestId('menu-accel-edit.redo');
      await expect(accel).toBeVisible();
      const label = (await accel.textContent())?.trim() ?? '';
      // The displayed accelerator is now Ctrl+Y (HB-10), not Ctrl+Shift+Z.
      expect(label).toBe('Ctrl+Y');
    } finally {
      await app.close();
    }
  });

  test('the ショートカット一覧 lists BOTH Ctrl+Y and Ctrl+Shift+Z for redo (alias kept)', async () => {
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('menu-help').click();
      const items = page.getByTestId('menu-items-help');
      await expect(items).toBeVisible();
      await items.locator('[data-command="help.shortcuts"]').click();
      const panel = page.getByTestId('shortcuts-panel');
      await expect(panel).toBeVisible();
      // Both redo accelerators appear in the help一覧 (derived from the SAME source
      // as the keymap, so this is the live binding truth). The primary row keeps the
      // bare per-command testid; the alias row is chord-suffixed.
      await expect(panel.getByTestId('shortcuts-panel-key-edit.redo')).toHaveText('Ctrl+Y');
      await expect(
        panel.getByTestId('shortcuts-panel-key-edit.redo-Ctrl+Shift+Z'),
      ).toHaveText('Ctrl+Shift+Z');
    } finally {
      await app.close();
    }
  });

  test('pressing Ctrl+Y actually redoes a committed-then-undone edit', async () => {
    const { app, page } = await launchApp();
    try {
      // 1. Commit one face through the live add flow → it is the active feature and
      //    the undo stack now has one entry (canUndo=1, canRedo=0).
      await commitOneFace(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');

      // 2. Undo with a real Ctrl+Z key chord. The commit is rolled back: nothing is
      //    selected, the redo stack is now armed (canRedo=1).
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-undo')).toHaveText('0');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      // 3. Redo with a real Ctrl+Y key chord (HB-10). The edit is RE-APPLIED: the
      //    redo stack drains and the undo stack re-arms — the definitive proof that
      //    Ctrl+Y dispatched redo (the stack moved the redo direction). (Selection
      //    re-resolution on undo/redo is a separate concern; here we lock that the
      //    Ctrl+Y chord runs redo.)
      await page.keyboard.press('Control+y');
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');
    } finally {
      await app.close();
    }
  });

  test('Ctrl+Shift+Z still redoes (alias preserved)', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      await expect(page.getByTestId('app-can-undo')).toHaveText('0');
      // The legacy alias still drives redo: redo stack drains, undo re-arms.
      await page.keyboard.press('Control+Shift+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
    } finally {
      await app.close();
    }
  });
});

test.describe('HB-11 / HB-12 / HB-13 — タイムライン可読性 (labels + visual)', () => {
  test('HB-11: the year-tick track shows a 単位:年 caption and labelled ticks', async () => {
    const { app, page } = await launchApp();
    try {
      const ticks = page.getByTestId('timeline-ticks');
      await expect(ticks).toBeVisible();
      // The unit caption makes the bare number row read as "years".
      await expect(ticks.locator('.timeline__ticks-unit')).toHaveText(/年/);
      // At least one tick label is rendered.
      await expect(ticks.locator('.timeline__tick-label').first()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('HB-12: the 時刻ブックマーク section explains what it is', async () => {
    const { app, page } = await launchApp();
    try {
      const markers = page.getByTestId('timeline-markers');
      await expect(markers).toBeVisible();
      await expect(markers.locator('.timeline-markers__title')).toHaveText('時刻ブックマーク');
      // The hint explains it is a named time bookmark (not feature creation).
      await expect(page.getByTestId('timeline-markers-hint')).toHaveText(/ブックマーク|時刻/);
      // The add button is clearly labelled (消さない — the control survives, renamed).
      await expect(
        page.getByRole('button', { name: 'この時刻をブックマーク' }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('HB-13: the step / playback controls carry visible labels and adequate size', async () => {
    const { app, page } = await launchApp();
    try {
      // Visible text labels (not icon-only) on the step + playback buttons.
      const forward = page.getByRole('button', { name: '1年次へ進む' });
      await expect(forward).toBeVisible();
      await expect(forward).toContainText('次へ');
      await expect(page.getByRole('button', { name: '1年前へ戻る' })).toContainText('前へ');
      const play = page.getByRole('button', { name: '再生' });
      await expect(play).toBeVisible();
      await expect(play).toContainText('再生');
      // Minimum hit size (HB-13: too-small buttons). The CSS floor is 32×64.
      const size = await forward.boundingBox();
      expect(size).not.toBeNull();
      expect(size!.height).toBeGreaterThanOrEqual(30);
      expect(size!.width).toBeGreaterThanOrEqual(60);
    } finally {
      await app.close();
    }
  });

  test('visual regression: the timeline panel is readable (ticks/labels/controls)', async () => {
    const { app, page } = await launchApp();
    try {
      await page.waitForTimeout(1000);
      const timeline = page.getByTestId('timeline');
      await expect(timeline).toBeVisible();
      await expect(timeline).toHaveScreenshot('timeline-readable.png', {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      await app.close();
    }
  });
});
