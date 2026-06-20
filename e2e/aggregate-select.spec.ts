// Codex #2 回帰ロック — 集約表示中はクリックで「見えている集約地物」を選ぶ behavioural E2E.
//
// ROOT (P1 描画と hit-test の不一致): the map draws AREAS through the U34 display
// pipeline (committed-features → buildDisplayAreas), which at the default global
// depth N=0 rolls a parent face up into its 集約形状 and OMITS the child faces. The
// old hit-test ignored that — it tested the raw child leaf bodies / every child
// vertex — so a click on the aggregate body selected a HIDDEN child and a click near
// a hidden child's vertex selected an undrawn vertex (描画されていないものが選ばれる).
//
// The fix resolves the hit-test against the SAME display set the renderer draws
// (displayControl honoured): a body click selects the AGGREGATE, and hidden child
// vertices are not grabbable. This spec LOCKS that 挙動 end to end through the REAL
// built composite with REAL mouse input:
//   1. 追加モード → 面ツール で PARENT 面 (大きな四角) をコミット;
//   2. 追加モード → 面ツール で CHILD 面 (親の内側の小さな四角) を、親を選んで コミット
//      (FR-77 親面 — これで親は子を持つ=集約表示の対象);
//   3. 編集モードで CHILD 面 の本体中央を実クリック → app-active-feature が PARENT
//      (子ではなく、見えている集約地物が選ばれる);
//   4. 子の頂点位置(画面の角)付近を実クリック → app-active-vertex は空のまま
//      (非表示の子頂点は拾わない)、選択は PARENT 本体のまま。
// 集約と hit-test を同一真実源にしていない実装に戻すと、本体クリックで子が選ばれたり
// 子頂点が選ばれたりして、ここが赤くなる。

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
  // Idempotent: only arm add when it is not already the active mode (a second click
  // would TOGGLE it off and the tool palette would never appear).
  if ((await addMode.getAttribute('aria-pressed')) !== 'true') {
    await addMode.click();
  }
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
  const areaTool = page.getByTestId('tool-add.area');
  await expect(areaTool).toBeVisible();
  // The tool button TOGGLES (selected → re-click deselects). After a prior commit the
  // area tool can still be the active tool, so only click it when it is NOT pressed;
  // otherwise re-arm it (deselect then select) to start a fresh draw session.
  if ((await areaTool.getAttribute('aria-pressed')) === 'true') {
    await areaTool.click(); // deselect
  }
  await areaTool.click(); // select → starts a fresh Drawing session
  await expect(areaTool).toHaveAttribute('aria-pressed', 'true');
}

async function enterEditMode(page: Page): Promise<void> {
  await leaveView(page);
  const editMode = page.getByTestId('mode-edit');
  await expect(editMode).toBeEnabled();
  await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Draw a face's four corners into the (already-armed) area tool and confirm the shape
 * (the property form then opens). Arms the area tool fresh each call (exactly ONCE per
 * face — re-arming an in-progress draft would reset it), so the caller must NOT have
 * armed it already.
 */
async function drawFace(
  page: Page,
  corners: ReadonlyArray<readonly [number, number]>,
): Promise<void> {
  await enterAddArea(page);
  // The transient map-input layer mounts only once the draw session starts; wait for
  // it before clicking so the first corner is not dropped on a not-yet-mounted layer.
  await expect(page.getByTestId('add-input-layer')).toBeVisible();
  for (const [px, py] of corners) await page.mouse.click(px, py);
  // The vertex-count marker confirms all four corners landed (canComplete needs ≥3).
  await expect(page.getByTestId('add-vertex-count')).toHaveText(String(corners.length));
  const complete = page.getByTestId('add-complete');
  await expect(complete).toBeEnabled();
  await complete.click();
}

test.describe('Codex #2 — 集約表示中のクリックは集約地物を選び、隠れた子/頂点は拾わない', () => {
  test('子本体クリックで親(集約)が選ばれ、子の頂点は選択されない', async () => {
    const { app, page } = await launchApp();
    try {
      const addLayer = page.getByTestId('add-input-layer');
      const activeFeature = page.getByTestId('app-active-feature');

      // Arm 追加→面 once and measure the shared client box (the add + map input layers
      // are coincident, both inset:0 over the map cell), so screen corners stay valid
      // across mode switches (camera unchanged).
      await enterAddArea(page);
      await expect(addLayer).toBeVisible();
      const box = await addLayer.boundingBox();
      expect(box).not.toBeNull();
      const a = box!;
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;

      // PARENT face: a ~120px square on the LEFT half. We commit it first so it appears
      // as a selectable parent for the child. Once it has a child it is drawn as the
      // AGGREGATE of its children at N=0 (its OWN square is no longer drawn), so we
      // never click the parent's own footprint — we click the child's footprint, which
      // is what is actually drawn for the parent. The area tool is already armed, so
      // draw the corners directly (re-arming would reset the draft).
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
      const parentComplete = page.getByTestId('add-complete');
      await expect(parentComplete).toBeEnabled();
      await parentComplete.click();
      await page.getByTestId('add-save').click();
      await expect(activeFeature).toHaveText(/\S/);
      const parentId = ((await activeFeature.textContent()) ?? '').trim();
      expect(parentId.length).toBeGreaterThan(0);

      // CHILD face: a ~120px square on the RIGHT half (DISJOINT from the parent — no
      // spatial overlap, so the add flow raises no conflict), parented to the parent.
      // Its footprint is what the parent aggregate draws at N=0; its corners are the
      // (hidden) child vertices we probe later.
      const ccx = cx + 100;
      const ccy = cy;
      const childCorners: ReadonlyArray<readonly [number, number]> = [
        [ccx - 60, ccy - 60],
        [ccx + 60, ccy - 60],
        [ccx + 60, ccy + 60],
        [ccx - 60, ccy + 60],
      ];
      await drawFace(page, childCorners);
      const parentSelect = page.getByTestId('add-parent');
      await expect(parentSelect).toBeVisible();
      // Select the only real parent option (index 1; index 0 is 親なし).
      await parentSelect.selectOption({ index: 1 });
      await page.getByTestId('add-save').click();
      await expect(activeFeature).toHaveText(/\S/);

      // 編集モード. Clear any post-commit selection with an empty-space click first.
      await enterEditMode(page);
      await page.mouse.click(a.x + 6, a.y + 6); // a corner of the map cell, outside both
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');

      // 1) Click the CHILD body centre. At N=0 the child is OMITTED and the parent is
      //    drawn as the aggregate (= the child's footprint), so the hit must select the
      //    PARENT, never the hidden child.
      await page.mouse.click(ccx, ccy);
      await expect(activeFeature).toHaveText(parentId);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');

      // 2) Click just INSIDE a CHILD corner vertex (within the grab radius of it). The
      //    hidden child vertex must NOT be grabbed; the cursor sits inside the aggregate
      //    body, so the selection stays the PARENT body and no vertex is selected.
      await page.mouse.click(ccx - 58, ccy - 58);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect(activeFeature).toHaveText(parentId);
    } finally {
      await app.close();
    }
  });
});
