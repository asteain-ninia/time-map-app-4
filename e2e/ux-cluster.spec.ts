// HB-5 / HB-10 / HB-11 / HB-12 / HB-13 — UX cluster behavioural + visual E2E.
//
// Drives the REAL built Electron composite (same launch contract as the rest of
// e2e/, via launchApp). Every assertion uses REAL input (click / keyboard) and
// reads the resulting DOM / observation hooks — no controller back-door. The two
// visual baselines lock the scrollbar fix (HB-5) and timeline readability
// (HB-11/12/13); the Ctrl+Y test fires a real key chord and asserts redo ran via
// the live undo/redo observation markers (既存 app-active-feature 方式).

import { test, expect, type Page } from '@playwright/test';

import { commitOneFace, launchApp } from './helpers';

/**
 * Collapse the add drawing session that `commitOneFace` leaves armed, so the global
 * keyboard shortcuts are no longer suspended before we test Ctrl+Z / Ctrl+Y.
 *
 * WHY: after a save the AddToolController re-arms the still-selected add tool with a
 * FRESH empty session (受け入れ基準 6「保存 → 再度追加開始」, AddToolController の
 * 再アーム effect). That session sits in the Drawing phase, so the controller reports
 * `onDrawingChange(true)` and the host raises `shortcutsSuspended` (App.tsx: addDrawing
 * → shortcutsSuspended). While suspended the GLOBAL undo/redo dispatcher is off and the
 * add controller's OWN Ctrl+Z (vertex-undo) is the only handler — with zero vertices it
 * is a no-op, so Ctrl+Z never reaches EditUndo.
 *
 * FIX: switch to 編集モード. That drives the add controller's activeKind to null
 * (mode !== Add) → resetForSwitch → Idle → onDrawingChange(false), clearing the
 * suspension. **鍵は閉じない**: EditUndo/EditRedo are editing commands gated OFF in
 * view-only (permissions.canEdit === false), so the very Ctrl+Z/Ctrl+Y we are
 * exercising would be disabled there. 「選択」道具へ持ち替えれば、直せるまま（canEdit
 * true）作図の下書きだけが片付き、取り消しの履歴には触らない（履歴はモードに依らない）
 * ので、この検査の本題（Ctrl+Y / Ctrl+Shift+Z が redo を動かす）はそのまま残る。
 *
 * **増分 5b**: 旧版は「編集モードのボタンを押す」だった。モードのボタンは廃止され、
 * 内部の mode は道具から導出されるので、**「選択」を押す**のが同じ導線である。
 */
async function leaveAddSession(page: Page): Promise<void> {
  const selectTool = page.getByTestId('tool-edit.select');
  await expect(selectTool).toBeVisible();
  await expect(selectTool).toBeEnabled();
  await selectTool.click();
  await expect(page.getByTestId('app-mode')).toHaveText('edit');
  // The add chrome (rendered only while a session is past Idle) is gone → the
  // controller reported onDrawingChange(false) → shortcuts are no longer suspended.
  await expect(page.getByTestId('add-tool')).toHaveCount(0);
}

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

      // **画素の比較と並べて、機械検査も置く**（増分 5 の手直し D5）。
      //
      // 画素の比較は `maxDiffPixelRatio: 0.02` を許すので、**幅 15px の縦スクロールバーが
      // 1 本増えても差分の割合が閾値に届かず、緑のまま通りうる**。しかも基準画像そのものが
      // 「スクロールバーが出ている姿」を正しい姿として焼き付けてしまうと、以後は永久に
      // 気づけない（開発ガイド §5.63 と同じ型の落とし穴）。数で読める不変条件は数で読む。
      const bars = await page.evaluate(() => {
        const measure = (sel: string): { v: number; h: number } => {
          const el = document.querySelector(sel);
          if (el === null) throw new Error(`要素が無い: ${sel}`);
          return {
            v: el.scrollHeight - el.clientHeight,
            h: el.scrollWidth - el.clientWidth,
          };
        };
        return {
          // 窓そのもの（HB-5 の本体。上の 2 本の検査と同じ不変条件を、画像の隣にも置く）。
          document: measure('html'),
          // 左のレール（増分 5 の手直し D2。道具 12 個が縦に収まっている ―― 手直しの前は
          // ここが 91px あふれ、基準画像にも縦スクロールバーが写っていた）。
          rail: measure('.app-shell__toolbar'),
        };
      });
      expect(bars.document.v, '窓に縦スクロールバーが出ている').toBeLessThanOrEqual(1);
      expect(bars.document.h, '窓に横スクロールバーが出ている').toBeLessThanOrEqual(1);
      expect(
        bars.rail.v,
        `左のレールが縦に ${bars.rail.v}px あふれている（道具が窓の外に出ている）`,
      ).toBeLessThanOrEqual(1);
      expect(bars.rail.h, '左のレールが横にあふれている').toBeLessThanOrEqual(1);

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

      // Collapse the re-armed empty add session so the global shortcut dispatcher is
      // no longer suspended (otherwise the add controller's own no-op Ctrl+Z swallows
      // the chord). The undo stack is untouched (still canUndo=1) — this only ends the
      // drawing session, it does not undo the commit.
      await leaveAddSession(page);
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');

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
      // Collapse the re-armed empty add session so the global shortcut dispatcher is
      // not suspended when we press Ctrl+Z / Ctrl+Shift+Z (see leaveAddSession).
      await leaveAddSession(page);
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
      await expect(ticks.getByTestId('timeline-ticks-unit')).toHaveText(/年/);
      // At least one tick label is rendered.
      await expect(ticks.getByTestId('timeline-tick-label').first()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('HB-12: the time-bookmark UI is gone (FR-66 descoped per user)', async () => {
    // 時刻ブックマーク機能は撤去済み (ユーザー決定 2026-06-21)。タイムラインは
    // 表示され、栞専用 UI (track / 見出し / 「ブックマーク」ボタン) が一切残って
    // いないことを軽く回帰で固定する。
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('timeline')).toBeVisible();
      await expect(page.getByTestId('timeline-markers')).toHaveCount(0);
      await expect(page.getByTestId('timeline-markers-hint')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'この時刻をブックマーク' }),
      ).toHaveCount(0);
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
