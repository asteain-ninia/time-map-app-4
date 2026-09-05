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

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  commitSquareFace,
  drawFace,
  enterEditMode,
  launchApp,
  squareCorners,
} from './helpers';

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

/**
 * The color each DRAWN feature is ACTUALLY PAINTED with (renderer `activeColor`: the
 * selection colour when highlighted, else the opacity-baked fill). Because it reports the
 * PAINTED colour — not `style.fill` — a comparison against a baseline captured in the SAME
 * selection state can see BOTH「他が淡くなる」AND a regression that repaints an emphasized
 * feature in the selection colour.
 */
async function readDrawnFills(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getDrawnFeatureFills: () => Record<string, string> };
    }).__E2E__;
    if (e2e === undefined) throw new Error('__E2E__ not ready');
    return e2e.getDrawnFeatureFills();
  });
}

async function waitForE2E(page: Page): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => typeof (window as unknown as { __E2E__?: unknown }).__E2E__))
    .toBe('object');
}

/**
 * 表示制御を開く（増分 4 / C7）。**一覧の下から オプションバーの「表示 ▾」へ移した。**
 * 旧: 一覧タブを押すと下のほうに固定パネルが在った（`offsetTop` 28,546px ＝ 63 画面ぶん
 * 下で、実装済みなのに誰も辿り着けなかった）。いまは 1 クリックで開く。
 */
async function revealFilterPanel(page: Page): Promise<void> {
  const button = page.getByTestId('option-display-button');
  if ((await page.getByTestId('option-display-panel').getAttribute('hidden')) !== null) {
    await button.click();
  }
  await expect(page.getByTestId('display-filter')).toBeVisible();
}

test.describe('FR-113 — 表示制御フィルタの全結線', () => {
  test('面オフ→描画数減→オン復活 / 右クリック非表示→選択不可→全て再表示 / 不透明度', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);

      const { faceId, cx, cy } = await commitOneFace(page);
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

      // **一覧の行は残る**（増分 4 の手直し B1 / 決定 (2)）。旧版はここで行が消える
      // ことを不変条件にしていたが、一覧は「探す」ための場所なので、消えると
      // **隠したこと自体を取り消せなくなる**（設計書 §C.5「設定も解除もこの 1 か所」）。
      // 描画と当たり判定の母集合は変わっていない（上の 2 つがそれを見ている）。
      await revealFilterPanel(page);
      await expect(page.getByTestId(`feature-list-item-${faceId}`)).toHaveCount(1);
      await expect(page.getByTestId(`ledger-row-${faceId}`)).toHaveAttribute(
        'data-hidden',
        'true',
      );

      // 「個別非表示 1 件を全て再表示」→ the area is drawn (and selectable) again.
      const showAll = page.getByTestId('display-filter-show-all');
      await expect(showAll).toBeEnabled();
      await expect(showAll).toContainText('1 件');
      await showAll.click();
      await expect.poll(async () => readDrawnCount(page)).toBe(withArea);
      // 行の印も戻る（🚫 → 👁）。
      await expect(page.getByTestId(`ledger-row-${faceId}`)).toHaveAttribute(
        'data-hidden',
        'false',
      );
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    } finally {
      await app.close();
    }
  });

  // K-2（増分 4 の手直し F4）: **開いた状態と閉じた状態の両方**を格子で走査する。
  // 閉じたパネルが画面左上に居座ってクリックを奪う事故（教訓 5.56）は閉じた状態でしか
  // 捕まらないが、**開いた状態で地図のどこが覆われているか**は開いた状態でしか分からない。
  test('K-2: 表示 ▾ は開いていても閉じていても、地図の当たりを黙って奪わない', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      const scan = async (): Promise<string[]> => {
        const b = (await page.getByTestId('map-input-layer').boundingBox())!;
        const out: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          for (let j = 0; j < 5; j += 1) {
            const x = b.x + (b.width * (i + 0.5)) / 5;
            const y = b.y + (b.height * (j + 0.5)) / 5;
            out.push(
              await page.evaluate(
                ({ px, py }) => {
                  const el = document.elementFromPoint(px, py);
                  if (el === null) return 'null';
                  // その点が「表示 ▾ のパネルの中」かどうかも見分けたい。
                  const panel = document.querySelector('[data-testid="option-display-panel"]');
                  if (panel !== null && panel.contains(el)) return 'display-panel';
                  return el.getAttribute('data-testid') ?? el.className.toString();
                },
                { px: x, py: y },
              ),
            );
          }
        }
        return out;
      };

      // ①開く前: 25 点すべてが地図の入力層に届く。
      expect(new Set(await scan())).toEqual(new Set(['map-input-layer']));

      // ②開いた状態: 覆っているのは **パネルそのもの**だけ（見えない層が奪っていない）。
      await page.getByTestId('option-display-button').click();
      await expect(page.getByTestId('display-filter')).toBeVisible();
      const opened = await scan();
      for (const hit of opened) {
        expect(['map-input-layer', 'display-panel']).toContain(hit);
      }

      // ③閉じたあと: また 25 点すべてが地図に届く（[hidden] の打ち消しが効いている）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('option-display-panel')).toBeHidden();
      expect(new Set(await scan())).toEqual(new Set(['map-input-layer']));
    } finally {
      await app.close();
    }
  });

  // 増分 4 の手直し G6 / K-5: 状態が移ったら閉じる。開いたまま残ると、そこに並んでいる
  // 種別の一覧と件数が古いまま置き去りになる。
  test('表示 ▾ は年・鍵・道具が変わったら閉じる（K-5）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('option-display-button').click();
      await expect(page.getByTestId('display-filter')).toBeVisible();
      await enterEditMode(page);
      await expect(page.getByTestId('option-display-panel')).toBeHidden();
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

      // PARENT face (left half) — committed first as a selectable parent.
      await armAddAreaTool(page);
      const box = await addInputLayerBox(page);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const px = cx - 180;
      await drawFace(page, squareCorners(px, cy, 60));

      // CHILD face (right half), parented → the parent becomes a 集約 (FR-36/37).
      const ccx = cx + 100;
      await commitSquareFace(page, ccx, cy, 60, { parentIndex: 1 });

      // **選択を外してから測る**（増分 4）。選んでいる地物と親までの道筋は表示条件に
      // 関わらず必ず描かれるので（設計書 §D.6）、確定直後の子を選んだまま測ると N=0 でも
      // 子が 1 つ余分に描かれ、FR-42 の畳み込みそのものを測れない。
      await page.getByTestId('statusbar').click();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      // FR-42 N=1: expand the 集約 into its children (直轄領 + child) — MORE drawn.
      const n0 = await readDrawnCount(page);
      await page.getByRole('button', { name: '深さを上げる' }).click();
      await expect(page.getByTestId('global-depth-readout')).toContainText('深さ: 1');
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

  test('FR-113 Phase 2: 右クリック強調 → 他が淡くなる / 種別強調 / 重なりは無効化 / 強調をすべて解除', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);

      // Two non-overlapping top-level faces (left & right of centre) so「強調した方だけが
      // 濃く、他方が淡く」 is observable in the REAL draw batch.
      const mapInput = page.getByTestId('map-input-layer');
      const m0 = (await mapInput.boundingBox())!;
      const cx = m0.x + m0.width / 2;
      const cy = m0.y + m0.height / 2;
      const leftId = await commitSquareFace(page, cx - 150, cy, 70);
      const rightId = await commitSquareFace(page, cx + 150, cy, 70);
      expect(leftId).not.toBe('');
      expect(rightId).not.toBe(leftId);

      const plain = await readDrawnFills(page);
      expect(Object.keys(plain)).toEqual(expect.arrayContaining([leftId, rightId]));

      // --- 1. 右クリック「この地物を強調」→ the OTHER face dims, the target's paint is unchanged. ---
      await enterEditMode(page);
      await page.mouse.click(cx - 150, cy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      const emphasize = menu.locator('[data-item-kind="emphasizeFeature"]');
      await expect(emphasize).toBeVisible();
      await expect(emphasize).toHaveText('この地物を強調');
      // 種別/深度の強調は掛かっていない → 押せば見た目が変わるので ENABLED.
      await expect(emphasize).toBeEnabled();
      // 非強調時は「強調を解除」は出ない (排他).
      await expect(menu.locator('[data-item-kind="unemphasizeFeature"]')).toHaveCount(0);
      // 右クリックは対象を選択へ昇格させる (教訓 5.11) ので、選択色の影響を切り分けるため
      // 「この選択状態での」基準色をここで採る。以降の比較は強調の効果だけを見る.
      const beforeEmphasis = await readDrawnFills(page);
      await emphasize.click();
      await expect(menu).toHaveCount(0);

      await expect
        .poll(async () => (await readDrawnFills(page))[rightId])
        .not.toBe(beforeEmphasis[rightId]); // 他の地物が淡くなった (dim others)
      // 強調対象の実塗色は不変 = 強調は選択色を流用しない (FR-82 の選択表示と混同しない).
      expect((await readDrawnFills(page))[leftId]).toBe(beforeEmphasis[leftId]);
      // 強調は可視性を変えない — 描画数は不変.
      expect(Object.keys(await readDrawnFills(page)).length).toBe(Object.keys(plain).length);

      // --- 2. 再度の右クリックでは「強調を解除」に入れ替わる (compose の動的出し分け). ---
      await page.mouse.click(cx - 150, cy, { button: 'right' });
      await expect(menu).toBeVisible();
      const unemphasize = menu.locator('[data-item-kind="unemphasizeFeature"]');
      await expect(unemphasize).toBeVisible();
      await expect(unemphasize).toHaveText('強調を解除');
      await expect(unemphasize).toBeEnabled();
      await expect(menu.locator('[data-item-kind="emphasizeFeature"]')).toHaveCount(0);
      await unemphasize.click();
      await expect(menu).toHaveCount(0);
      await expect
        .poll(async () => (await readDrawnFills(page))[rightId])
        .toBe(beforeEmphasis[rightId]);

      // --- 3. パネルの種別強調 (面) → 面が強調され、脱出口が活性化する. ---
      await revealFilterPanel(page);
      const clearEmphasis = page.getByTestId('display-filter-clear-emphasis');
      await expect(clearEmphasis).toBeDisabled(); // 強調が無いので押せない
      const emphasizeArea = page.getByTestId('display-filter-emphasize-area');
      await expect(emphasizeArea).not.toBeChecked();
      // この選択状態での基準色 (左面が選択中) — 種別強調の前後で比較する.
      const beforeKindEmphasis = await readDrawnFills(page);
      await emphasizeArea.check();
      await expect(clearEmphasis).toBeEnabled();
      // 可視軸は無傷 (強調と可視は別軸) — 面の表示チェックは入ったまま、描画数も不変.
      await expect(page.getByTestId('display-filter-kind-area')).toBeChecked();
      expect(Object.keys(await readDrawnFills(page)).length).toBe(Object.keys(plain).length);
      // 面を種別強調しても「全ての面が選択色になる」ことは起きない: 両面とも強調対象なので
      // 淡くなるものが無く、実塗色は基準のまま (未選択の右面が選択色に化けたら赤).
      await expect
        .poll(async () => (await readDrawnFills(page))[rightId])
        .toBe(beforeKindEmphasis[rightId]);
      expect((await readDrawnFills(page))[leftId]).toBe(beforeKindEmphasis[leftId]);

      // --- 3b. 種別強調と重なる個別強調は「出す≠起きる」→ 項目は出るが無効 + 理由付き. ---
      await page.mouse.click(cx - 150, cy, { button: 'right' });
      await expect(menu).toBeVisible();
      const overlapped = menu.locator('[data-item-kind="emphasizeFeature"]');
      await expect(overlapped).toBeVisible();
      await expect(overlapped).toBeDisabled();
      await expect(overlapped).toHaveAttribute('title', /強調をすべて解除/);
      // 個別非表示 は別概念なので有効なまま (無効化が波及していない).
      await expect(menu.locator('[data-item-kind="hideFeature"]')).toBeEnabled();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // --- 4. 「強調をすべて解除」→ 元の見え方へ戻り、トグルも解除される. ---
      // 増分 4: 表示制御は **ポップオーバー** になったので、外を押すと閉じる（K-2 の
      // 作法。背面を覆う板を置かない代わりに、外側の pointerdown で閉じる）。3b で
      // 地図を右クリックしたぶん閉じているので、開き直してから押す。
      await revealFilterPanel(page);
      await clearEmphasis.click();
      await expect(emphasizeArea).not.toBeChecked();
      await expect(clearEmphasis).toBeDisabled();
      await expect
        .poll(async () => (await readDrawnFills(page))[rightId])
        .toBe(beforeKindEmphasis[rightId]);
      await expect
        .poll(async () => (await readDrawnFills(page))[leftId])
        .toBe(beforeKindEmphasis[leftId]);
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
      await commitSquareFace(page, cx - 150, cy, 70);
      await commitSquareFace(page, cx + 150, cy, 70);

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
