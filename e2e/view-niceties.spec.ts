// 単発低コスト改善 2件 の behavioural E2E（実機 composite 経由）:
//
//   (1) 表示 →「全体表示」(COMMAND_ID.ViewFitAll / Ctrl+Home): 任意の視点から、全地物が
//       収まる視点へ一発で戻る。錨一覧のフィット計算 (cameraForBounds, padding 0.2,
//       zoomMin/Max クランプ) を全地物 bbox に適用しているので、
//         - 一発目のフィットで視点が地物中心・拡大側へ寄り、
//         - そこから激しく pan/zoom してもう一度撃つと SAME 視点へ戻る（復帰性）。
//       メニュー行とアクセラレータは同じ COMMAND_ID を通るので、両導線を実測する。
//       地物ゼロの新規プロジェクトでは既定視点 (FR-11 world fit) へ戻ることも実測する。
//
//   (2) ステータスバーのカーソル座標: 地図上でマウスを動かすと経緯度がライブ表示され、
//       地図外へ出ると消えて既定文言に戻る（表示条件）。
//
// どちらも「ロジックはあるが UI から呼ばれない」(教訓 5.7) を弾くための結線テスト:
// 実際のキーボード / メニュークリック / マウス移動だけを使い、内部 API は叩かない。

import { test, expect, type Page } from '@playwright/test';

import { launchApp, commitOneFace } from './helpers';

interface CameraHooks {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

/** The live camera mirrored onto the map input layer (data-pan-x/y, data-zoom). */
async function readCamera(page: Page): Promise<CameraHooks> {
  const layer = page.getByTestId('map-input-layer');
  await expect(layer).toHaveAttribute('data-zoom', /.+/);
  return {
    panX: Number(await layer.getAttribute('data-pan-x')),
    panY: Number(await layer.getAttribute('data-pan-y')),
    zoom: Number(await layer.getAttribute('data-zoom')),
  };
}

/** The centre of the map input layer's on-screen box. */
async function mapCentre(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const layer = page.getByTestId('map-input-layer');
  await expect(layer).toBeVisible();
  const box = await layer.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
}

/**
 * Leave 追加モード for 編集モード, which DISARMS the add tool. This matters for the
 * accelerator leg: the global shortcut dispatcher deliberately STANDS DOWN while an
 * add / knife draft owns the keyboard (`shortcutsSuspended`, bughunt3 H1/H2), and the
 * add tool stays armed after a commit — so a user reaching for the overview chord does
 * it from a non-drafting mode, and so does this spec.
 */
async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  await expect(editMode).toBeEnabled();
  await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

/** Move the camera FAR from wherever it is: several zoom-in notches plus a drag pan. */
async function derangeCamera(page: Page): Promise<void> {
  const c = await mapCentre(page);
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -240);
  // Also move the CENTRE, not just the magnification: the cursor-anchored wheel zoom
  // (FR-08) shifts the camera centre when the cursor is OFF-centre, so this deranges
  // both axes without needing a mode-specific drag-pan button.
  await page.mouse.move(c.x - c.w / 3, c.y + c.h / 3);
  for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -240);
}

test.describe('全体表示 (Ctrl+Home / 表示メニュー)', () => {
  test('任意の視点から全地物が収まる視点へ一発で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      // --- 地物ゼロ: 既定視点へ戻る ----------------------------------------------
      // A fresh project has NO features, so the whole-project extent is empty and the
      // command must fall back to the FR-11 既定視点 (world fit) — NOT freeze, and not
      // leave the deranged view. Driven from the boot 表示専用 mode (nothing armed).
      const boot = await readCamera(page);
      await derangeCamera(page);
      expect((await readCamera(page)).zoom).toBeGreaterThan(boot.zoom * 1.5);
      await page.keyboard.press('Control+Home');
      await expect
        .poll(async () => (await readCamera(page)).zoom)
        .toBeCloseTo(boot.zoom, 6);
      const restored = await readCamera(page);
      expect(restored.panX).toBeCloseTo(boot.panX, 6);
      expect(restored.panY).toBeCloseTo(boot.panY, 6);

      // One real committed 面 (~240px square centred in the map under the boot camera).
      await commitOneFace(page);
      expect(await readCamera(page)).toEqual(boot);

      // --- 導線 A: 表示メニューの行 ---------------------------------------------
      await page.getByTestId('menu-view').click();
      await page.locator('button[data-command="view.fitAll"]').click();
      await expect
        .poll(async () => (await readCamera(page)).zoom)
        .toBeGreaterThan(boot.zoom);
      const fitted = await readCamera(page);

      // The fit framed THE FEATURE: the camera centre sits on the face (which the add
      // helper drew centred under the boot camera), and it zoomed IN because a ~240px
      // face fills far less than the whole world at the boot fit-world zoom.
      expect(Math.abs(fitted.panX - boot.panX)).toBeLessThan(5);
      expect(Math.abs(fitted.panY - boot.panY)).toBeLessThan(5);
      expect(fitted.zoom).toBeGreaterThan(boot.zoom);

      // --- 導線 B: アクセラレータ (Ctrl+Home) -----------------------------------
      // Derange the view, then fire the command again: it RETURNS to the same 全体表示.
      await enterEditMode(page);
      await derangeCamera(page);
      const deranged = await readCamera(page);
      expect(deranged.zoom).toBeGreaterThan(fitted.zoom * 1.5);

      await page.keyboard.press('Control+Home');
      await expect
        .poll(async () => (await readCamera(page)).zoom)
        .toBeLessThan(deranged.zoom);
      const again = await readCamera(page);
      expect(again.zoom).toBeCloseTo(fitted.zoom, 3);
      expect(again.panX).toBeCloseTo(fitted.panX, 3);
      expect(again.panY).toBeCloseTo(fitted.panY, 3);

      // 両導線は同じ COMMAND_ID / 同じフィット計算を通る — 小数まで一致する
      // (メニュー行とアクセラレータが別実装に分岐していない, 教訓 5.33).
      expect(again.zoom).toBeCloseTo(fitted.zoom, 6);
      expect(again.panX).toBeCloseTo(fitted.panX, 6);
      expect(again.panY).toBeCloseTo(fitted.panY, 6);
    } finally {
      await app.close();
    }
  });
});

test.describe('ステータスバーのカーソル座標', () => {
  test('地図上では経緯度がライブ表示され、地図外では消える', async () => {
    const { app, page } = await launchApp();
    try {
      const statusbar = page.getByTestId('statusbar');
      await expect(statusbar).toBeVisible();
      // 起動直後はカーソル位置が未知なので既定文言のまま.
      await expect(page.getByTestId('statusbar-cursor-coords')).toHaveCount(0);

      const c = await mapCentre(page);
      await page.mouse.move(c.x, c.y);
      const readout = page.getByTestId('statusbar-cursor-coords');
      await expect(readout).toBeVisible();
      // 測量モードと同じ十進表記 (緯度→経度、半球語つき).
      await expect(readout).toHaveText(/(北緯|南緯)\s[\d.]+°\s(東経|西経)\s[\d.]+°/);
      const atCentre = (await readout.textContent()) ?? '';

      // 動かせば値が変わる (ライブ表示であってスナップショットではない).
      await page.mouse.move(c.x + c.w / 4, c.y - c.h / 4);
      await expect
        .poll(async () => (await readout.textContent()) ?? '')
        .not.toBe(atCentre);

      // 地図外 (ツールバー上) へ抜けると非表示に戻る.
      const toolbar = await page.getByTestId('app-shell').boundingBox();
      expect(toolbar).not.toBeNull();
      await page.mouse.move(toolbar!.x + 4, toolbar!.y + 4);
      await expect(page.getByTestId('statusbar-cursor-coords')).toHaveCount(0);
      await expect(statusbar).toHaveText(/準備完了/);
    } finally {
      await app.close();
    }
  });

  // Review fix: the readout piggy-backs on the map INPUT layer's pointermove, but a tool
  // bridge (追加 / 切断 / 併合 / 測量) is a sibling overlay ABOVE that layer — so while a
  // bridge is up the moves never reach the input layer AND entering the bridge fires the
  // input layer's pointerleave. The readout therefore died in exactly the modes that need
  // it most (測量 = FR-16 座標読み, 作図). The bridges already forward pointermove to the
  // shared camera-input port, so the readout must ride that same forward.
  test('ツール入力ブリッジ（測量モード）の上でも座標が出る', async () => {
    const { app, page } = await launchApp();
    try {
      const toggle = page.getByTestId('survey-toggle');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      const bridge = page.getByTestId('survey-input-layer');
      await expect(bridge).toBeVisible();

      const c = await mapCentre(page);
      await page.mouse.move(c.x, c.y);
      const readout = page.getByTestId('statusbar-cursor-coords');
      await expect(readout).toBeVisible();
      await expect(readout).toHaveText(/(北緯|南緯)\s[\d.]+°\s(東経|西経)\s[\d.]+°/);
      const atCentre = (await readout.textContent()) ?? '';

      // ...and it keeps tracking while the bridge owns the input surface.
      await page.mouse.move(c.x + c.w / 4, c.y - c.h / 4);
      await expect
        .poll(async () => (await readout.textContent()) ?? '')
        .not.toBe(atCentre);
    } finally {
      await app.close();
    }
  });
});
