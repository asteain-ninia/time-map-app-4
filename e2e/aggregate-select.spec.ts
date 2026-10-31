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

import { test, expect } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  armVertexTool,
  commitFace,
  drawFace,
  enterEditMode,
  launchApp,
  type ScreenPoint,
} from './helpers';

test.describe('Codex #2 — 集約表示中のクリックは集約地物を選び、隠れた子/頂点は拾わない', () => {
  test('子本体クリックで親(集約)が選ばれ、子の頂点は選択されない', async () => {
    const { app, page } = await launchApp();
    try {
      const activeFeature = page.getByTestId('app-active-feature');

      // Arm 追加→面 once and measure the shared client box (the add + map input layers
      // are coincident, both inset:0 over the map cell), so screen corners stay valid
      // across mode switches (camera unchanged).
      await armAddAreaTool(page);
      const a = await addInputLayerBox(page);
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
      const parentCorners: ReadonlyArray<ScreenPoint> = [
        [px0 - 60, py0 - 60],
        [px0 + 60, py0 - 60],
        [px0 + 60, py0 + 60],
        [px0 - 60, py0 + 60],
      ];
      const parentId = await drawFace(page, parentCorners);
      expect(parentId.length).toBeGreaterThan(0);

      // CHILD face: a ~120px square on the RIGHT half (DISJOINT from the parent — no
      // spatial overlap, so the add flow raises no conflict), parented to the parent.
      // Its footprint is what the parent aggregate draws at N=0; its corners are the
      // (hidden) child vertices we probe later.
      const ccx = cx + 100;
      const ccy = cy;
      const childCorners: ReadonlyArray<ScreenPoint> = [
        [ccx - 60, ccy - 60],
        [ccx + 60, ccy - 60],
        [ccx + 60, ccy + 60],
        [ccx - 60, ccy + 60],
      ];
      // 上位領域は唯一の実 option (index 1; index 0 は 親なし)。
      await commitFace(page, childCorners, { parentIndex: 1 });

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
      //    「選択」は頂点に当たらないので、掴める道具を構えて確かめる（B114）。
      await armVertexTool(page);
      await page.mouse.click(ccx - 58, ccy - 58);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect(activeFeature).toHaveText(parentId);

      // 3) 「選択」でも同じ場所はまとめ役の本体に当たる。
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(ccx - 58, ccy - 58);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect(activeFeature).toHaveText(parentId);
    } finally {
      await app.close();
    }
  });
});
