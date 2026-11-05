// U42 — regression E2E: 全体方針の統合充足 (FR-01 / FR-02) + 回帰観点
// (一時状態破棄 教訓 5.2 / 構造変更後の選択維持 教訓 5.11).
//
// These drive the REAL built composite through Playwright for Electron (the same
// launch contract as the rest of e2e/, via launchApp). They focus on what the
// spec assigns U42: prove the time-axis moves through the live shell (FR-01),
// prove the renderer makes NO network egress during a real session (FR-02), and
// pin the two regression観点 as E2E.
//
// 依存ゲート (spec §依存 / §1.8) は解消済み: the live consistency-apply binding is
// wired, so the full add/edit/split/merge mutation flows run through the built
// composite and both regression観点 below run end-to-end through the real UI. The
// temp-state-discard cases only draft and discard (nothing is committed); the
// selection-retention case commits a new area and then splits it, which mutates
// domain state. No test.skip() skeleton remains in this file. The same regression
// 観点 are ALSO pinned at the unit layer (files listed at the 回帰観点 section
// below), so they hold independently of the E2E run (教訓 5.41).

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  enterAddMode,
  launchApp,
  placeVertices,
} from './helpers';

test.describe('FR-01 — 時間軸に沿った状態再現が live shell で成立する', () => {
  // The U21 Timeline component is mounted into the composition root by the same
  // live-binding work that enabled editing, so these run for real (nothing SKIPs at
  // runtime). The FR-01 time-axis logic is unit-fixed in the domain
  // (anchor-series resolveAt) regardless.

  test('stepping the timeline forward changes the displayed current time (FR-68 / FR-71)', async () => {
    const { app, page } = await launchApp();
    try {
      const current = page.getByTestId('timeline-current');
      // The live shell now mounts the Timeline into the bottom slot (U21 配線),
      // so the current-time readout is present and the step controls are live.
      await expect(current).toBeVisible();
      const before = (await current.textContent())?.trim() ?? '';

      // Step forward by 1 年 (the default step unit). The forward button is the
      // ▶ control (aria-label「1年次へ進む」, HB-13 visible label); a press→release
      // fires one step (FR-68).
      await page.getByRole('button', { name: '1年次へ進む' }).click();

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

  test('stepping forward then back returns to the SAME displayed current time (BUGHUNT:time-roundtrip)', async () => {
    // Regression: the initial currentTime renders at year granularity ("0年").
    // Stepping 1年次へ進む then 1年前へ戻る returns to the same instant; the
    // DISPLAY must also be identical — it used to come back as "0年1月1日" because
    // a step promoted the TimePoint granularity year -> yearMonthDay permanently.
    const { app, page } = await launchApp();
    try {
      const current = page.getByTestId('timeline-current');
      await expect(current).toBeVisible();
      const t0 = (await current.textContent())?.trim() ?? '';
      expect(t0).not.toBe('');

      const forward = page.getByRole('button', { name: '1年次へ進む' });
      await forward.click();
      // The forward step genuinely moved the time (sanity: not a no-op).
      await expect(async () => {
        const t1 = (await current.textContent())?.trim() ?? '';
        expect(t1).not.toBe(t0);
      }).toPass();

      await page.getByRole('button', { name: '1年前へ戻る' }).click();
      // op∘逆op = 恒等 at the display level: back to the exact original string.
      await expect(async () => {
        const t2 = (await current.textContent())?.trim() ?? '';
        expect(t2).toBe(t0);
      }).toPass();
    } finally {
      await app.close();
    }
  });

  test('the map canvas mount stays present across a time move (即時再描画の土台 FR-71)', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-canvas-mount')).toBeAttached();
      const forward = page.getByRole('button', { name: '1年次へ進む' });
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
      const forward = page.getByRole('button', { name: '1年次へ進む' });
      if ((await forward.count()) > 0) await forward.click();
      await page.waitForTimeout(300);
      expect(external).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

// --- 回帰観点 (live consistency-apply binding 配線済み) ---------------------------
//
// These run end-to-end through the real UI with editing enabled (only the
// selection-retention case commits to domain state: an add, then a split). The
// same判定 are ALSO held at the unit layer:
//   - 一時状態の破棄 (教訓 5.2): src/domain/add/session.test.ts (startSession /
//     resetSession), src/ui/add/useAddTool.test.tsx「transient discard」,
//     src/ui/add/AddToolController.test.tsx「U23 integration: 全経路で破棄」; the
//     knife side in src/domain/knife/session.test.ts「一時状態の全経路破棄」.
//   - 構造変更後の選択維持 (教訓 5.11): src/domain/selection/reresolve.test.ts
//     「structure-change re-resolution」, src/ui/state/store.test.ts「re-resolves
//     selection from a command result」, src/ui/consistency-binding.test.tsx
//     「createLiveKnifeBinding — a clean axis-aligned split commits without conflict」
//     and「makeCommand finding5 — split created set includes the new feature」.

// Place one vertex by clicking the transient add-input layer (the overlay layer
// the controller mounts above the map while drawing — 教訓 5.14).
async function placeOneVertex(page: Page): Promise<void> {
  const b = await addInputLayerBox(page);
  await placeVertices(page, [[b.x + b.width / 2, b.y + b.height / 2]]);
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

      // Now place a vertex again, then 鍵を閉める（読むだけへ戻す）: the session is
      // discarded, so the add chrome disappears (no 残存 preview).
      // **増分 5b**: 「追加モードのボタンをもう一度押して View へ戻る」経路は無くなった。
      // 鍵を閉じるのが「編集をやめる」唯一の入口である。
      await placeOneVertex(page);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('1');
      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('app-mode')).toHaveText('view');
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
  // NOW ACTIVE: the seam-vertex quantization fix (domain/knife split-geometry
  // snapCutLine) lands the cut line on U06's integer grid BEFORE the clip is
  // built, so a SCREEN-derived (screen→world, non-integer) cut yields two halves
  // whose seam vertices coincide to the quantum — no positive-area seam sliver,
  // U06's difference converges, and the split commits without a conflict pause.
  // Regression-pinned at the unit layer in
  // src/domain/knife/split-geometry.seam.test.ts (screen-derived cuts: seam
  // coincidence + area preservation + empty overlap). This E2E drives the FULL
  // built composite through that path with REAL pixel coordinates.
  test('分割後に選択が結果から再解決され維持される (分割継ぎ目の量子化整合)', async () => {
    const { app, page } = await launchApp();
    try {
      // 1. Add a 面 (face): 4 corners of a square well inside the viewport, then
      //    complete + save. The corners come from SCREEN pixels (screen→world), so
      //    the committed face carries non-integer world coordinates — exactly the
      //    input class that used to produce a seam sliver on split.
      await armAddAreaTool(page);
      const a = await addInputLayerBox(page);
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height * 0.45;
      // UI 再設計 増分 1: シェルに行が増えて地図セルが縦に縮んだ（オプションバー 40px ＋
      // 状態行 22→28px ＋ アプリバーの折り返し）。**固定 px の四隅は、地図の上下に浮く
      // ツールの帯（上: ナイフのガイド / 下: 確定ボタンの列）に当たって落ちる**ので、
      // 箱の高さから決める。奇数の端数は残す（画面 px → 世界座標が非整数になることが
      // このテストの入力条件）。
      const half = Math.min(110, Math.round(a.height * 0.17));
      const pierce = half + 30;
      const corners: ReadonlyArray<readonly [number, number]> = [
        [cx - half - 3, cy - half + 3],
        [cx + half + 1, cy - half - 1],
        [cx + half - 1, cy + half + 1],
        [cx - half + 3, cy + half - 3],
      ];
      // drawFace が 完了 → 保存 → 選択が新しい面へ再解決される (教訓 5.11) まで通す。
      await drawFace(page, corners);
      const active = page.getByTestId('app-active-feature');

      // 2. Enter 編集モード → ナイフ. Select the face by clicking its centre (live
      //    featureAtPoint), then draw a piercing cut from OUTSIDE the face (above)
      //    to OUTSIDE (below) through its middle — a SCREEN-pixel vertical cut.
      // **増分 5b**: 「編集モードに入ってからナイフを選ぶ」の 2 手が 1 手になった。
      await page.getByTestId('tool-edit.knife').click();

      const knifeLayer = page.getByTestId('knife-input-layer');
      await expect(knifeLayer).toBeVisible();
      // Select the target face (click its centre — inside the drawn square).
      await page.mouse.click(cx, cy);
      // Draw the cut: two points, both OUTSIDE the face, the segment piercing it.
      // Slightly skewed x so the world coordinates are non-integer (screen-derived).
      await page.mouse.click(cx + 2, cy - pierce);
      await page.mouse.click(cx - 3, cy + pierce);
      await expect(page.getByTestId('knife-cut-count')).toHaveText('2');

      // 3. 確定 the cut → choose piece 0 as inheritor → confirm → save the非継承側.
      //    The chooser is n-way (commit 01ed1d6): a 2-point cut yields 2 pieces, so
      //    the buttons are knife-choose-0 / knife-choose-1 (index-based, not A/B).
      //    These float ABOVE the map with pointer-events re-enabled (knife.css), so
      //    a REAL user click reaches them — we click them as a user would (教訓 5.7
      //    完了トリガー; no overlay bypass).
      await page.getByTestId('knife-confirm-cut').click();
      await expect(page.getByTestId('knife-choose-0')).toBeVisible();
      await page.getByTestId('knife-choose-0').click();
      await page.getByTestId('knife-confirm-inheritor').click();
      // 非継承側プロパティ入力 (re-used U23 form) — save commits the split.
      await expect(page.getByTestId('add-save')).toBeVisible();
      await page.getByTestId('add-save').click();

      // 4. The split committed WITHOUT pausing on a seam-sliver conflict, and the
      //    selection re-resolved from the result (教訓 5.11 / FR-94): the active
      //    feature marker is non-empty and the knife session went back to 対象選択.
      await expect(page.getByTestId('knife-conflict-paused')).toHaveCount(0);
      await expect(async () => {
        expect(((await active.textContent()) ?? '').trim()).not.toBe('');
      }).toPass();
      // **確定しても道具は降りない**（増分 5 の手直し B2 / 設計書 §D.2）。旧版はここで
      // `knife-tool` が DOM から消えることを見ていた ―― 5 道具のうちナイフだけが確定後に
      // 道具を降りていたためで、続けて分けたい人は毎回選び直すことになっていた。いまは
      // **道具を構えたまま次の対象待ちへ戻る**ので、見るのは「分断線のセッションが
      // 畳まれて対象選択へ戻ったか」である。
      await expect(page.getByTestId('knife-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
    } finally {
      await app.close();
    }
  });
});
