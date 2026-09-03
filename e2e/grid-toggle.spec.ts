// FR-13 グリッド（グラティキュール）ON/OFF 切替 behavioural E2E.
//
// Drives the REAL built composite (Electron + the live renderer) and observes the
// ACTUAL RENDER via the window.__E2E__ frame hook (per-frame primitive counts). In an
// EMPTY new project the ONLY `label`-kind primitives are the graticule's lat/lon labels
// (no features ⇒ no feature labels; the base map is a `basemap` primitive), so the label
// count is an exact mirror of whether the grid is drawn. It locks:
//   - 既定 ON: the graticule draws (label > 0) and the topBar toggle is aria-pressed;
//   - OFF: clicking the toggle removes EVERY grid primitive (label → 0, aria-pressed
//     false) — the FR-13 ON/OFF切替 reaching the pixels (明示的空, 教訓 5.18);
//   - ON again: the grid comes back (label > 0).
//
// The toggle → redraw path is the regression this locks: gridVisible feeds the host's
// live getter AND the redraw-on-settings subscription, so a toggle re-composites at once
// (教訓 5.35). Save/load persistence of gridVisible is locked at the UNIT level
// (round-trip.test.ts + ui-settings-bridge.test.ts); the e2e suite deliberately avoids
// native file dialogs (playwright.config.ts).

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** The last-drawn-frame label-primitive count off the live __E2E__ render hook. */
async function labelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (
      window as unknown as {
        __E2E__?: { getPrimitiveCounts: () => { label: number } };
      }
    ).__E2E__;
    return e2e === undefined ? -1 : e2e.getPrimitiveCounts().label;
  });
}

/** Wait for the renderer's __E2E__ observation hook to exist (map mounted). */
async function waitForE2EHook(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => typeof (window as unknown as { __E2E__?: unknown }).__E2E__),
    )
    .toBe('object');
}

test.describe('FR-13 — グリッド ON/OFF 切替 結線', () => {
  test('既定ONで描画 / トグルOFFでグリッド消滅 / 再ONで復活', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);

      const toggle = page.getByTestId('grid-toggle');
      await expect(toggle).toBeVisible();
      // **起動直後の「読むだけ」でも押せる**（K-6 の裁定「読むだけ＝選べる・読める」）。
      // このトグルはセッション限りの見え方だけを書き、保存ファイルには入らない。
      await expect(toggle).toBeEnabled();

      // 既定: the grid is visible — graticule labels are drawn, the toggle is pressed.
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => labelCount(page)).toBeGreaterThan(0);

      // OFF: every grid primitive disappears (empty project ⇒ label count → 0).
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => labelCount(page)).toBe(0);

      // ON again: the graticule returns (the toggle round-trips).
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => labelCount(page)).toBeGreaterThan(0);

      // **未保存の印が立たない**（保存ファイルに何も書いていない証）。
      await expect(page.getByTestId('app-identity-dirty')).toHaveCount(0);
      expect(await page.title()).not.toContain('●');
    } finally {
      await app.close();
    }
  });
});

test.describe('FR-13 / K-6 — 読むだけでもグリッドは切り替えられ、保存ファイルは動かない', () => {
  test('「読むだけ」のまま押せて、未保存にならず、帯の寸法も動かない（K-3）', async () => {
    // 一度は「実体がプロジェクト設定の書き換えだから読むだけでは押させない」としたが、
    // **起動直後は常に読むだけ**なので、開いて眺めるだけの人が一度もグリッドを消せなく
    // なった。直し方は関門をゆるめることではなく置き場を分けることで、このトグルは
    // セッション限りの上書きだけを書く（保存ファイルにも未保存の印にも触らない）。
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      // 起動直後は「読むだけ」である（この前提が崩れたらこの検査の意味も変わる）。
      await expect(page.getByTestId('mode-view')).toHaveAttribute('aria-pressed', 'true');

      const mapBefore = (await page.getByTestId('map-area').boundingBox())!;
      const toggle = page.getByTestId('grid-toggle');
      await expect(toggle).toBeEnabled();

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => labelCount(page)).toBe(0);

      // 保存ファイルに何も書いていない = 未保存の印が立たない。
      await expect(page.getByTestId('app-identity-dirty')).toHaveCount(0);
      expect(await page.title()).not.toContain('●');
      // 読むだけのまま（トグルはモードを変えない）。
      await expect(page.getByTestId('mode-view')).toHaveAttribute('aria-pressed', 'true');

      // K-3: 帯の中身が変わっても地図セルの矩形は動かない。
      expect(await page.getByTestId('map-area').boundingBox()).toEqual(mapBefore);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => labelCount(page)).toBeGreaterThan(0);
      expect(await page.getByTestId('map-area').boundingBox()).toEqual(mapBefore);
    } finally {
      await app.close();
    }
  });
});
