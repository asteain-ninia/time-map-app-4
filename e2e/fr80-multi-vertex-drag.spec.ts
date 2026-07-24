// FR-80 複数頂点同時移動 — behavioural E2E (実ポインタで矩形選択 → 選択頂点を掴んで同時移動).
//
// ROOT (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」): 頂点選択セットの構築
// (矩形 / Shift) も、release 時に選択セット全体を同一ベクトルで動かす reducer の
// `SimultaneousMoveSpec` も存在していたのに、**ライブ編集ドラッグは単一頂点しか動かせな
// かった** — `live-selection-port` は非空プレスのドラッグを U24 側に譲るため spec は到達
// 不能、そして U24 側 `targetFromHit` は常に単一頂点 VertexMove を作っていた。ユーザーから
// 見ると「3 頂点を選んで動かしたのに 1 頂点しか動かない」。
//
// この spec は REAL な mousedown → mousemove×N → mouseup を実ビルドに対して打ち、__E2E__
// が公開する **実際に描かれた頂点ハンドルのワールド座標** を観測する。単体テストでは
// 検出できない結線欠落 (App.tsx が選択真実源を注入しない / ハンドル層がセッションを見ない)
// がここで赤くなる。
//
// 固定する契約:
//   1. 矩形選択した 2 頂点のうち 1 つを掴むと、ドラッグ中プレビューで **両方** が動く。
//   2. 解放後のコミット結果でも両方が **同一ベクトル** で動いている (形がひしゃげない)。
//   3. 選択していない頂点は 1mm も動かない。
//   4. Ctrl+Z 一回で **両方まとめて** 元に戻る (FR-80「単一の編集操作として扱う」)。

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

interface HandlePos {
  lon: number;
  lat: number;
}

/** The active feature's vertex-handle WORLD positions as actually drawn this frame. */
async function vertexHandlePositions(page: Page): Promise<HandlePos[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => HandlePos[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

const EPS = 1e-9;

function samePoint(a: HandlePos, b: HandlePos, eps = EPS): boolean {
  return Math.abs(a.lon - b.lon) <= eps && Math.abs(a.lat - b.lat) <= eps;
}

/** The handles of `list` that are NOT (within eps) any of `reference`. */
function notIn(list: readonly HandlePos[], reference: readonly HandlePos[], eps = EPS): HandlePos[] {
  return list.filter((h) => !reference.some((r) => samePoint(h, r, eps)));
}

/** Sorted by longitude — a rigid translation preserves this order, so it pairs up. */
function byLon(list: readonly HandlePos[]): HandlePos[] {
  return [...list].sort((a, b) => a.lon - b.lon);
}

async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  await expect(editMode).toBeEnabled();
  await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}

async function enterAddArea(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  const addMode = page.getByTestId('mode-add');
  await expect(addMode).toBeEnabled();
  await addMode.click();
  await page.getByTestId('tool-add.area').click();
}

/** A real multi-sample pointer drag (never one synthetic jump — the bug needs frames). */
async function dragBy(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  onFrame?: () => Promise<void>,
): Promise<void> {
  const [sx, sy] = from;
  const [tx, ty] = to;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps);
    if (onFrame !== undefined) await onFrame();
  }
  await page.mouse.up();
}

test.describe('FR-80 — 矩形選択した複数頂点を掴むと選択セット全体が同時に動く', () => {
  test('矩形で 2 頂点選択 → 片方を実ドラッグ → 両方が同一ベクトルで動き、Ctrl+Z で一括復帰', async () => {
    const { app, page } = await launchApp();
    try {
      await expect
        .poll(async () =>
          page.evaluate(() => typeof (window as unknown as { __E2E__?: unknown }).__E2E__),
        )
        .toBe('object');

      // 1) 実クリック 4 回で正方形の面を作成・保存。
      await enterAddArea(page);
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const box = await addLayer.boundingBox();
      expect(box).not.toBeNull();
      const a = box!;
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;
      const corners: ReadonlyArray<readonly [number, number]> = [
        [cx - 120, cy - 120], // 左上 (screen) = 北西
        [cx + 120, cy - 120], // 右上 = 北東
        [cx + 120, cy + 120],
        [cx - 120, cy + 120],
      ];
      for (const [px, py] of corners) await page.mouse.click(px, py);
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();

      const activeFeature = page.getByTestId('app-active-feature');
      await expect(activeFeature).toHaveText(/\S/);
      const faceId = ((await activeFeature.textContent()) ?? '').trim();

      // 2) 編集モードで面を実クリック選択 → ハンドルが描かれる。
      await enterEditMode(page);
      await expect(activeFeature).toHaveText('');
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      await expect
        .poll(async () => (await vertexHandlePositions(page)).length)
        .toBeGreaterThanOrEqual(4);

      const before = await vertexHandlePositions(page);
      // 画面の上 2 隅 = 緯度が大きい 2 頂点。これを矩形で選ぶ。
      const north = [...before].sort((p, q) => q.lat - p.lat).slice(0, 2);
      const south = notIn(before, north);
      expect(north).toHaveLength(2);
      expect(south).toHaveLength(2);

      // 3) 空白からの実ドラッグ矩形で北の 2 頂点を選択 (FR-80 範囲選択)。
      //    プレスは地物の外 (空白) — そうでないとラバーバンドではなく編集ジェスチャになる。
      await dragBy(page, [cx - 170, cy - 170], [cx + 170, cy - 100]);
      // 選択矩形は面の本体に触れないので、アクティブ地物は保持されたまま。
      await expect(activeFeature).toHaveText(faceId);

      // 4) 選択された北西頂点を掴んで実ドラッグ。ドラッグ中、北の 2 頂点が **両方**
      //    コミット位置を離れていなければならない (単一頂点実装だと 1 つ残る)。
      const grab: readonly [number, number] = [cx - 120, cy - 120];
      const target: readonly [number, number] = [cx - 50, cy - 60];
      let bothMovedDuringDrag = false;
      await dragBy(page, grab, target, async () => {
        const during = await vertexHandlePositions(page);
        const stillAtCommitted = north.filter((n) => during.some((h) => samePoint(h, n)));
        if (stillAtCommitted.length === 0) bothMovedDuringDrag = true;
      });
      expect(
        bothMovedDuringDrag,
        'ドラッグ中プレビューで選択頂点が全て動いていなければならない (FR-80 ライブ同時移動)',
      ).toBe(true);

      // 5) 解放後のコミット結果: 北の 2 頂点だけが、同一ベクトルで動いている。
      const after = await vertexHandlePositions(page);
      expect(after).toHaveLength(before.length);

      // 南の 2 頂点は不動。
      for (const s of south) {
        expect(
          after.some((h) => samePoint(h, s)),
          '選択していない頂点は動いてはならない',
        ).toBe(true);
      }
      const moved = notIn(after, south);
      expect(moved, '動いたのは選択した 2 頂点だけであるべき').toHaveLength(2);

      const from = byLon(north);
      const to = byLon(moved);
      const d0 = { lon: to[0]!.lon - from[0]!.lon, lat: to[0]!.lat - from[0]!.lat };
      const d1 = { lon: to[1]!.lon - from[1]!.lon, lat: to[1]!.lat - from[1]!.lat };
      // 実際に動いたこと (ゼロ移動なら契約を満たさない)。
      expect(Math.hypot(d0.lon, d0.lat)).toBeGreaterThan(1e-6);
      // 同一ベクトル = 形がひしゃげない (掴みオフセットぶんのズレも許さない相対許容)。
      const tol = Math.hypot(d0.lon, d0.lat) * 1e-6;
      expect(Math.abs(d1.lon - d0.lon)).toBeLessThanOrEqual(tol);
      expect(Math.abs(d1.lat - d0.lat)).toBeLessThanOrEqual(tol);

      // 6) FR-80「単一の編集操作」: Ctrl+Z 一回で 2 頂点まとめて元位置へ。
      // (地物追加のコミットも履歴に残っているので undo 可能フラグは 1 のまま。ここで
      //  固定したいのは「移動が 1 単位か」なので、**1 回**の Ctrl+Z で **両方の頂点が**
      //  元位置に戻ることを直接見る。頂点ごとに別コマンドなら 1 回では片方しか戻らない。)
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
      await page.keyboard.press('Control+z');
      await expect
        .poll(async () => {
          const restored = await vertexHandlePositions(page);
          return before.every((b) => restored.some((h) => samePoint(h, b, 1e-9)));
        }, { message: 'undo 一回で選択頂点が全て元位置に戻らなければならない' })
        .toBe(true);
    } finally {
      await app.close();
    }
  });
});
