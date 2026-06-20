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
      // Skeleton-skip if the live shell has not mounted the timeline yet.
      if ((await current.count()) === 0) {
        test.skip(true, 'Timeline 未配線 (依存: live composition-root binding)');
        return;
      }
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
      if ((await forward.count()) === 0) {
        test.skip(true, 'Timeline 未配線 (依存: live composition-root binding)');
        return;
      }
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

test.describe('回帰観点 — 一時状態の破棄 (教訓 5.2 / FR-78)', () => {
  test.skip('選択→キャンセル→再作成 でドラフト値が引き継がれない (依存: live edit binding)', () => {
    // SKELETON: enter 追加 mode → start a shape → キャンセル → start again, then
    // assert the add-form / preview carries NO value from the cancelled draft
    // (add-name empty, add-vertex-count reset). Requires editing mode enabled by
    // the live consistency-apply binding (docs/現状.md 未割当).
  });

  test.skip('ツール/モード切替でも一時プレビューが破棄される (依存: live edit binding)', () => {
    // SKELETON: start a draft, switch tool/mode, assert preview cleared.
  });
});

test.describe('回帰観点 — 構造変更後の選択維持 (教訓 5.11 / FR-94)', () => {
  test.skip('分割後に選択が結果から再解決され維持される (依存: live knife binding)', () => {
    // SKELETON: select a leaf → ナイフで2分割 → 継承先選択 → assert the selection
    // is re-resolved from the command result (the inheritor stays selected), not
    // a blanket clear. Requires the live split→consistency binding.
  });
});
