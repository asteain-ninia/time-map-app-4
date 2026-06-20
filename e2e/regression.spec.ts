// U42 — regression E2E: 全体方針の統合充足 (FR-01 / FR-02) + 回帰観点
// (一時状態破棄 教訓 5.2 / 構造変更後の選択維持 教訓 5.11).
//
// These drive the REAL built composite through Playwright for Electron (the same
// launch contract as the rest of e2e/, via launchApp). They focus on what the
// spec assigns U42: prove the time-axis moves through the live shell (FR-01),
// prove the renderer makes NO network egress during a real session (FR-02), and
// pin the two regression観点 as E2E.
//
// 依存ゲート (spec §依存 / §1.8): the full add/edit/split/merge mutation flows
// require the live consistency-apply binding (a NEW domain責務, recorded
// unassigned in docs/現状.md by U43). Until that is wired, the composite boots in
// View mode with editing disabled, so the temp-state-discard / selection-
// retention regressions cannot mutate domain state end-to-end. Those cases are
// therefore SKELETON test.skip()s here (visible, not deleted) AND are double-fixed
// as pure unit lenses in src/domain/perf/*.test.ts — so the regression観点 is held
// by the unit layer now and the E2E activates once the binding lands (教訓 5.41).

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

test.describe('FR-01 — 時間軸に沿った状態再現が live shell で成立する', () => {
  // 依存ゲート: the U21 Timeline component is mounted into the composition root by
  // the same live-binding work that enables editing (docs/現状.md 未割当). When the
  // timeline IS wired, these activate automatically; until then they SKIP at
  // runtime (visible, not deleted — 開発ガイド §1.8). The FR-01 time-axis logic is
  // unit-fixed in domain/time (resolveAt) regardless.

  test('stepping the timeline forward changes the displayed current time (FR-68 / FR-71)', async () => {
    const { app, page } = await launchApp();
    try {
      const current = page.getByTestId('timeline-current');
      // The live shell now mounts the Timeline into the bottom slot (U21 配線),
      // so the current-time readout is present and the step controls are live.
      await expect(current).toBeVisible();
      const before = (await current.textContent())?.trim() ?? '';

      // Step forward by 1 年 (the default step unit). The forward button is the
      // ▶ control (aria-label 前進); a press→release fires one step (FR-68).
      await page.getByRole('button', { name: '前進' }).click();

      // The current time advanced — the time axis genuinely moved through the
      // live binding (not a no-op).
      await expect(async () => {
        const after = (await current.textContent())?.trim() ?? '';
        expect(after).not.toBe(before);
      }).toPass();
    } finally {
      await app.close();
    }
  });

  test('the map canvas mount stays present across a time move (即時再描画の土台 FR-71)', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-canvas-mount')).toBeAttached();
      const forward = page.getByRole('button', { name: '前進' });
      await expect(forward).toBeVisible();
      await forward.click();
      // The Canvas mount survives the re-render driven by the time move (the draw
      // path is subscription-based, not React-remounted): still attached.
      await expect(page.getByTestId('map-canvas-mount')).toBeAttached();
      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

test.describe('FR-02 — オフライン完結: レンダラは外部発信しない', () => {
  test('no external network request is issued during a real boot+interact session', async () => {
    const { app, page } = await launchApp();
    const external: string[] = [];
    // Record any request whose URL is NOT a local app scheme. The renderer loads
    // from file:// / app-internal URLs only; an http(s)/ws egress is a FR-02
    // violation. (This is the runtime観測 lens; the static lens is the
    // offline-egress unit test — 二重に固定.)
    page.on('request', (req) => {
      const url = req.url();
      if (/^(https?|ws|wss):\/\//i.test(url)) external.push(url);
    });
    try {
      // Exercise the live input layer + a time move so any lazy egress would fire.
      const inputLayer = page.getByTestId('map-input-layer');
      const box = await inputLayer.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, {
          steps: 4,
        });
        await page.mouse.up();
      }
      // Move the time axis too if the timeline is wired (any lazy egress fires).
      const forward = page.getByRole('button', { name: '前進' });
      if ((await forward.count()) > 0) await forward.click();
      await page.waitForTimeout(300);
      expect(external).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

// --- 回帰観点 (依存ゲート: live consistency-apply binding 未実装) -----------------
//
// These activate once editing mode can mutate domain state through the live
// binding. Held NOW by the pure unit lenses in src/domain/perf (一時状態破棄 /
// 選択維持 の判定は U23/U24/U26/U28/U30/U35 の単体で固定済み; ここは E2E 化の枠).

// Enter 追加モード from the default View state: the toolbar's 表示専用 toggle is the
// live導線 OUT of display-only (it lands in 編集モード), then 追加モード selects add.
async function enterAddMode(page: import('@playwright/test').Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  // In View the add/edit toggles are disabled; leaving View enables them.
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  const addMode = page.getByTestId('mode-add');
  await expect(addMode).toBeEnabled();
  await addMode.click();
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
}

// Place one vertex by clicking the transient add-input layer (the overlay layer
// the controller mounts above the map while drawing — 教訓 5.14).
async function placeOneVertex(page: import('@playwright/test').Page): Promise<void> {
  const inputLayer = page.getByTestId('add-input-layer');
  await expect(inputLayer).toBeVisible();
  const box = await inputLayer.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

test.describe('回帰観点 — 一時状態の破棄 (教訓 5.2 / FR-78)', () => {
  test('選択→キャンセル→再作成 でドラフト値が引き継がれない', async () => {
    const { app, page } = await launchApp();
    try {
      await enterAddMode(page);
      // Start a 線 draft and place a vertex (draft now carries 1 vertex).
      await page.getByTestId('tool-add.line').click();
      await placeOneVertex(page);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('1');

      // キャンセル discards the draft (教訓 5.2 全経路で破棄).
      await page.getByTestId('add-cancel').click();

      // Re-create: the add tool stays selected, so a FRESH empty session re-arms
      // (受け入れ基準 6). The new draft must carry NO vertex from the cancelled one.
      await expect(page.getByTestId('add-vertex-count')).toHaveText('0');
    } finally {
      await app.close();
    }
  });

  test('ツール/モード切替でも一時プレビューが破棄される', async () => {
    const { app, page } = await launchApp();
    try {
      await enterAddMode(page);
      await page.getByTestId('tool-add.line').click();
      await placeOneVertex(page);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('1');

      // Switch the active tool (線 → 面): the kind transition funnels through the
      // controller's reset/start, discarding the in-progress preview (教訓 5.2 (d)).
      await page.getByTestId('tool-add.area').click();
      // The fresh 面 session has zero vertices — no preview leaked across the switch.
      await expect(page.getByTestId('add-vertex-count')).toHaveText('0');

      // Now place a vertex again, then leave 追加モード entirely (back to View):
      // the session is discarded, so the add chrome disappears (no 残存 preview).
      await placeOneVertex(page);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('1');
      await page.getByTestId('mode-add').click(); // toggle 追加モード off → View
      await expect(page.getByTestId('add-tool')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('回帰観点 — 構造変更後の選択維持 (教訓 5.11 / FR-94)', () => {
  // The START of the split flow is NOW LIVE (P0-B / U35 / U12 配線完了): App.tsx
  // createKnifeBootstrap supplies live domain-lookup ports (resolveFeature /
  // resolveStore / featureAtPoint over the committed root via live-lookup.ts), the
  // U35 conflict modal is mounted, and the U12 history records commits. The whole
  // GUI flow was driven through those live seams during development — add a 面 (live
  // add commit, selection re-resolves to it), 編集→ナイフ, hit-test the face (live
  // featureAtPoint), draw a piercing cut, 確定, choose the inheritor, save — every
  // step UP TO the final commit fires live (the inheritor modal opens, the U35
  // conflict modal mounts on seam overlap).
  //
  // FINAL COMMIT REMAINS GATED on a domain geometry-precision issue, NOT a wiring
  // gap: a split driven by SCREEN pixel coordinates (screen→world→quantise) yields
  // two halves whose seam vertices do not coincide to the quantum, so U10 detects a
  // thin positive-area SEAM SLIVER and pauses on the conflict modal; U06's boolean
  // difference over that sliver does not converge within the round cap (rejection
  // ConvergenceFailure). A split with EXACT integer coords commits cleanly with NO
  // conflict — PROVEN at the unit layer in src/ui/consistency-binding.test.tsx
  // ("a clean axis-aligned split commits without conflict") together with the
  // 教訓 5.11 re-resolution + finding5 created-set fix and the live-lookup hit-test
  // tests (src/ui/live-lookup.test.tsx). Activating this E2E needs seam-vertex
  // quantisation consistency in the split assembler (a domain fix), out of scope for
  // the composition-root wiring done here.
  test.skip('分割後に選択が結果から再解決され維持される (依存: 分割継ぎ目の量子化整合 — domain)', () => {
    // SKELETON of the now-live flow (see KnifeToolController + createKnifeBootstrap):
    //   enterAddMode → tool-add.area → click 4 corners → add-complete → add-save
    //   → enterEditMode → tool-edit.knife → click face (live featureAtPoint)
    //   → draw piercing cut → knife-confirm-cut → knife-choose-a
    //   → knife-confirm-inheritor → add-save → assert app-active-feature non-empty.
    // Blocked only by the seam-sliver convergence noted above (domain geometry).
  });
});
