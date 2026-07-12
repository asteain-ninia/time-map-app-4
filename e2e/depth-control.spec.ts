// FR-42 表示階層レベル (グローバル階層深度スライダー) の behavioural E2E.
//
// 実機報告「表示する階層のレベルを変更する UI なくないですか?」の回帰ロック。ドメイン
// と store (setGlobalDepth / displayControl / resolveDisplayFor) は実装済みで、欠けて
// いたのは 上部バー の深度 UI だけ (教訓 5.7). This spec builds a real 集約 (parent +
// disjoint child, FR-36/FR-37 で 親→集約 + 直轄領 自動生成), then operates the LIVE 深度
// コントロール through the REAL built composite and asserts the number of DISTINCT
// features DRAWN changes:
//   - N=0 (既定): the top-level 集約 is rolled up → its children are omitted (fewer);
//   - N=1: the 集約 expands into its children (直轄領 + child) → more features drawn.
// The count is read off the window.__E2E__.getDrawnFeatureCount() hook, which resolves
// through the SAME buildCommittedFeatures the map draws (displayControl honoured), so a
// depth change that does not reach the display pipeline would leave the count unchanged
// and turn this red.

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

async function leaveView(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
}

async function enterAddArea(page: Page): Promise<void> {
  await leaveView(page);
  const addMode = page.getByTestId('mode-add');
  await expect(addMode).toBeEnabled();
  if ((await addMode.getAttribute('aria-pressed')) !== 'true') {
    await addMode.click();
  }
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
  const areaTool = page.getByTestId('tool-add.area');
  await expect(areaTool).toBeVisible();
  if ((await areaTool.getAttribute('aria-pressed')) === 'true') {
    await areaTool.click();
  }
  await areaTool.click();
  await expect(areaTool).toHaveAttribute('aria-pressed', 'true');
}

/** The distinct-feature count drawn through the live U34 display pipeline (depth honoured). */
async function readDrawnCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getDrawnFeatureCount: () => number };
    }).__E2E__;
    if (e2e === undefined) throw new Error('__E2E__ not ready');
    return e2e.getDrawnFeatureCount();
  });
}

/** Raise the global depth from 0 to 1 by operating the 上部バー depth control. */
async function raiseDepthToOne(page: Page): Promise<void> {
  // The slider is the very UI the user reported missing — assert it exists with the
  // data-derived bounds (min 0 .. max = live forest max depth) so its absence would fail
  // here. Then raise N 0→1 DETERMINISTICALLY via the control's ＋ (the SAME
  // store.setGlobalDepth the slider drives), avoiding an offscreen-keyboard race on the
  // native range input.
  const slider = page.getByTestId('global-depth-slider');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('min', '0');
  await expect(page.getByTestId('global-depth-readout')).toContainText('階層深度: 0');
  await page.getByRole('button', { name: '階層深度を上げる' }).click();
  await expect(page.getByTestId('global-depth-readout')).toContainText('階層深度: 1');
}

test.describe('FR-42 — 階層深度スライダーで描画地物数が変化する', () => {
  test('N=0 で集約が丸められ、深度を上げると子へ展開される', async () => {
    const { app, page } = await launchApp();
    try {
      // Wait for the live render hook to be published (onMapMount).
      await expect
        .poll(async () =>
          page.evaluate(
            () => typeof (window as unknown as { __E2E__?: unknown }).__E2E__,
          ),
        )
        .toBe('object');

      const addLayer = page.getByTestId('add-input-layer');
      const activeFeature = page.getByTestId('app-active-feature');

      await enterAddArea(page);
      await expect(addLayer).toBeVisible();
      const box = await addLayer.boundingBox();
      expect(box).not.toBeNull();
      const a = box!;
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;

      // PARENT face — a square on the LEFT half; committed first as a selectable parent.
      const px0 = cx - 180;
      const py0 = cy;
      const parentCorners: ReadonlyArray<readonly [number, number]> = [
        [px0 - 60, py0 - 60],
        [px0 + 60, py0 - 60],
        [px0 + 60, py0 + 60],
        [px0 - 60, py0 + 60],
      ];
      for (const [px, py] of parentCorners) await page.mouse.click(px, py);
      await expect(page.getByTestId('add-vertex-count')).toHaveText(
        String(parentCorners.length),
      );
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(activeFeature).toHaveText(/\S/);

      // CHILD face — a DISJOINT square on the RIGHT half, parented to the parent. This
      // promotes the parent to a 集約 (FR-36) and auto-generates a 直轄領 for the parent's
      // original footprint (FR-37, disjoint difference). The 集約 now has 2 children.
      const ccx = cx + 100;
      const ccy = cy;
      const childCorners: ReadonlyArray<readonly [number, number]> = [
        [ccx - 60, ccy - 60],
        [ccx + 60, ccy - 60],
        [ccx + 60, ccy + 60],
        [ccx - 60, ccy + 60],
      ];
      await enterAddArea(page);
      await expect(addLayer).toBeVisible();
      for (const [px, py] of childCorners) await page.mouse.click(px, py);
      await expect(page.getByTestId('add-vertex-count')).toHaveText(
        String(childCorners.length),
      );
      await page.getByTestId('add-complete').click();
      const parentSelect = page.getByTestId('add-parent');
      await expect(parentSelect).toBeVisible();
      await parentSelect.selectOption({ index: 1 }); // the only real parent (index 0 = 親なし)
      await page.getByTestId('add-save').click();
      await expect(activeFeature).toHaveText(/\S/);

      // N=0 (default): the top-level 集約 is rolled up; its children are omitted.
      const beforeCount = await readDrawnCount(page);

      // Operate the depth control: N 0 → 1.
      await raiseDepthToOne(page);

      // N=1: the 集約 expands into its children (直轄領 + child) → strictly more features.
      const afterCount = await readDrawnCount(page);
      expect(afterCount).toBeGreaterThan(beforeCount);
    } finally {
      await app.close();
    }
  });
});
