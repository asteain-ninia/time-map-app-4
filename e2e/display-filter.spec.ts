// FR-113 表示制御フィルタ — 全結線 behavioural E2E (教訓 5.7 の回帰ロック).
//
// THE POINT: the U41 domain/resolution layer was fully implemented + unit-tested but
// UNWIRED (draw / hit / search / store / UI / menu). This spec proves the WHOLE flow in
// the REAL built Electron app:
//   1. 面オフ (sidebar チェックボックス) → the area leaves the DRAWN set (count 減); オンで復活.
//   2. 右クリック「この地物を非表示」→ the feature is culled AND no longer selectable (a
//      click falls through to empty); 「個別非表示 n 件を全て再表示」で復活.
//   3. 不透明度スライダ → the filter opacity is applied (the control reflects the value).
//   4. FR-42 深度 N=1 で子へ展開 → FR-113 深度フィルタ M=1 で子が隠れる (順次合成 — ユーザー裁定).
//
// The drawn-count hook (window.__E2E__.getDrawnFeatureCount) resolves through the SAME
// buildCommittedFeatures the map draws, now with the live s.filter, so a filter change
// that did not reach the pipeline would leave the count unchanged and turn this red.

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

async function leaveView(page: Page): Promise<void> {
  // The mode-view button toggles View↔Edit (setViewOnly), so clicking it from View lands
  // in Edit mode. Only click it when actually in View (idempotent).
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
  if ((await addMode.getAttribute('aria-pressed')) !== 'true') await addMode.click();
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
  // Re-arm robustly: the area tool may ALREADY be armed from a prior commit; clicking it
  // then would DISARM it. Reset-then-arm so the add-input-layer is reliably present.
  const areaTool = page.getByTestId('tool-add.area');
  await expect(areaTool).toBeVisible();
  if ((await areaTool.getAttribute('aria-pressed')) === 'true') await areaTool.click();
  await areaTool.click();
  await expect(areaTool).toHaveAttribute('aria-pressed', 'true');
}

async function enterEditMode(page: Page): Promise<void> {
  // Idempotent + no double-toggle: already-Edit → done; View → the view toggle lands in
  // Edit; Add → the edit button switches. (mode-edit is disabled while in View, so we must
  // route through the view toggle from there.)
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  const viewToggle = page.getByTestId('mode-view');
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  } else {
    await editMode.click();
  }
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

/** Commit one ~240px square face; returns its id + centre. */
async function commitSquareFace(page: Page): Promise<{ faceId: string; cx: number; cy: number }> {
  await enterAddArea(page);
  const addLayer = page.getByTestId('add-input-layer');
  await expect(addLayer).toBeVisible();
  const box = (await addLayer.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const corners: ReadonlyArray<readonly [number, number]> = [
    [cx - 120, cy - 120],
    [cx + 120, cy - 120],
    [cx + 120, cy + 120],
    [cx - 120, cy + 120],
  ];
  for (const [px, py] of corners) await page.mouse.click(px, py);
  await page.getByTestId('add-complete').click();
  await page.getByTestId('add-save').click();
  const active = page.getByTestId('app-active-feature');
  await expect(active).toHaveText(/\S/);
  const faceId = ((await active.textContent()) ?? '').trim();
  return { faceId, cx, cy };
}

/** Commit one square face centred at (cx,cy) with half-extent `half` (4 real clicks). */
async function commitFaceAt(page: Page, cx: number, cy: number, half: number): Promise<void> {
  await enterAddArea(page);
  const addLayer = page.getByTestId('add-input-layer');
  await expect(addLayer).toBeVisible();
  for (const [dx, dy] of [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ] as const) {
    await page.mouse.click(cx + dx, cy + dy);
  }
  await page.getByTestId('add-complete').click();
  await page.getByTestId('add-save').click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
}

async function readDrawnCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as { __E2E__?: { getDrawnFeatureCount: () => number } }).__E2E__;
    if (e2e === undefined) throw new Error('__E2E__ not ready');
    return e2e.getDrawnFeatureCount();
  });
}

/** The live vertex-handle count of the ACTIVE feature (Codex F2 — 0 when hidden/deselected). */
async function readVertexHandleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions?: () => readonly unknown[] };
    }).__E2E__;
    return e2e?.getVertexHandlePositions ? e2e.getVertexHandlePositions().length : -1;
  });
}

async function waitForE2E(page: Page): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => typeof (window as unknown as { __E2E__?: unknown }).__E2E__))
    .toBe('object');
}

/** Reveal the 一覧 tab (where the 表示制御フィルタ panel lives). */
async function revealFilterPanel(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await expect(page.getByTestId('display-filter')).toBeVisible();
}

test.describe('FR-113 — 表示制御フィルタの全結線', () => {
  test('面オフ→描画数減→オン復活 / 右クリック非表示→選択不可→全て再表示 / 不透明度', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);

      const { faceId, cx, cy } = await commitSquareFace(page);
      await revealFilterPanel(page);

      const withArea = await readDrawnCount(page);
      expect(withArea).toBeGreaterThan(0);

      // --- 1. 面オフ: the area leaves the drawn set; re-checking restores it. ---
      const areaToggle = page.getByTestId('display-filter-kind-area');
      await expect(areaToggle).toBeChecked();
      await areaToggle.uncheck();
      await expect.poll(async () => readDrawnCount(page)).toBeLessThan(withArea);
      await areaToggle.check();
      await expect.poll(async () => readDrawnCount(page)).toBe(withArea);

      // --- 2. 不透明度スライダ: operate it; the control reflects the new value (draw stays). ---
      const opacity = page.getByTestId('display-filter-opacity');
      await opacity.evaluate((el) => {
        (el as HTMLInputElement).value = '0.3';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(opacity).toHaveValue('0.3');
      // Opacity does not cull, so the drawn feature is still present.
      await expect.poll(async () => readDrawnCount(page)).toBe(withArea);

      // --- 3. 右クリック「この地物を非表示」: cull + un-selectable, then 全て再表示 で復活. ---
      await enterEditMode(page);
      await page.mouse.click(cx, cy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      const hideItem = menu.locator('[data-item-kind="hideFeature"]');
      await expect(hideItem).toBeVisible();
      await expect(hideItem).toHaveText('この地物を非表示');
      // The right-click PROMOTED the feature into the selection (教訓 5.11).
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await hideItem.click();
      await expect(menu).toHaveCount(0);

      // Codex F2: hiding the ACTIVE feature deselects it IMMEDIATELY (the store heal) — not
      // "after the next click" — AND its edit handles vanish (0), even before any further click.
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect.poll(async () => readVertexHandleCount(page)).toBe(0);

      // The feature is now culled from the drawn set.
      await expect.poll(async () => readDrawnCount(page)).toBeLessThan(withArea);
      // ...and a click on where it was selects NOTHING (hidden = click-through).
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      // Codex F3: the hidden feature's 一覧 row is gone (list母集合 == draw / search 母集合).
      await revealFilterPanel(page);
      await expect(page.getByTestId(`feature-list-item-${faceId}`)).toHaveCount(0);

      // 「個別非表示 1 件を全て再表示」→ the area is drawn (and selectable) again.
      const showAll = page.getByTestId('display-filter-show-all');
      await expect(showAll).toBeEnabled();
      await expect(showAll).toContainText('1 件');
      await showAll.click();
      await expect.poll(async () => readDrawnCount(page)).toBe(withArea);
      // F3: the row is back too.
      await expect(page.getByTestId(`feature-list-item-${faceId}`)).toHaveCount(1);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    } finally {
      await app.close();
    }
  });

  test('FR-42 N=1 展開 → FR-113 深度フィルタ M=1 で子が隠れる (順次合成)', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);

      const addLayer = page.getByTestId('add-input-layer');
      const active = page.getByTestId('app-active-feature');

      // PARENT face (left half) — committed first as a selectable parent.
      await enterAddArea(page);
      await expect(addLayer).toBeVisible();
      const box = (await addLayer.boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const px = cx - 180;
      for (const [dx, dy] of [[-60, -60], [60, -60], [60, 60], [-60, 60]] as const) {
        await page.mouse.click(px + dx, cy + dy);
      }
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(active).toHaveText(/\S/);

      // CHILD face (right half), parented → the parent becomes a 集約 (FR-36/37).
      const ccx = cx + 100;
      await enterAddArea(page);
      await expect(addLayer).toBeVisible();
      for (const [dx, dy] of [[-60, -60], [60, -60], [60, 60], [-60, 60]] as const) {
        await page.mouse.click(ccx + dx, cy + dy);
      }
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-parent').selectOption({ index: 1 });
      await page.getByTestId('add-save').click();
      await expect(active).toHaveText(/\S/);

      // FR-42 N=1: expand the 集約 into its children (直轄領 + child) — MORE drawn.
      const n0 = await readDrawnCount(page);
      await page.getByRole('button', { name: '階層深度を上げる' }).click();
      await expect(page.getByTestId('global-depth-readout')).toContainText('階層深度: 1');
      const n1 = await readDrawnCount(page);
      expect(n1).toBeGreaterThan(n0);

      // FR-113 depth filter (順次合成): the expanded 子 leaves sit at depth 1, the 集約 at
      // depth 0. Turning the axis ON seeds M=0, so depth-1 children are hidden — the
      // 定義済みの空白 (N=1 で展開した子が M で隠れる). Fewer features drawn than at N=1.
      await revealFilterPanel(page);
      await page.getByTestId('display-filter-depth-toggle').check();
      const depthInput = page.getByTestId('display-filter-depth');
      await expect(depthInput).toHaveValue('0');
      await expect.poll(async () => readDrawnCount(page)).toBeLessThan(n1);
    } finally {
      await app.close();
    }
  });

  test('Codex F1: an FR-113-hidden leaf is NOT a merge target (raw-leaf tool-acquisition gate)', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);

      // Two non-overlapping top-level faces, left & right of centre.
      const mapInput = page.getByTestId('map-input-layer');
      const m0 = (await mapInput.boundingBox())!;
      const cx = m0.x + m0.width / 2;
      const cy = m0.y + m0.height / 2;
      await commitFaceAt(page, cx - 150, cy, 70);
      await commitFaceAt(page, cx + 150, cy, 70);

      // Hide the LEFT face via 右クリック「この地物を非表示」.
      await enterEditMode(page);
      await page.mouse.click(cx - 150, cy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      await menu.locator('[data-item-kind="hideFeature"]').click();
      await expect(menu).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText(''); // F2 heal

      // Arm 結合(merge). Clicking the HIDDEN left face adds NO target (F1: leafAtPoint result
      // rejected by the FR-113 gate); the VISIBLE right face does — count 0 → 0 → 1.
      const mergeTool = page.getByTestId('tool-edit.merge');
      await expect(mergeTool).toBeEnabled();
      await mergeTool.click();
      await expect(mergeTool).toHaveAttribute('aria-pressed', 'true');
      const targetCount = page.getByTestId('merge-target-count');
      await page.mouse.click(cx - 150, cy); // hidden → rejected
      await expect(targetCount).toHaveText('0');
      await page.mouse.click(cx + 150, cy); // visible → 1 target
      await expect(targetCount).toHaveText('1');
    } finally {
      await app.close();
    }
  });
});
