// B98 — 頂点のドラッグ・面の移動の確定も、他の描く道具と同じく重なりの検出を通す。
//
// ドラッグ中の滑りの拘束（FR-28 `constrainSlide`）は **掴んだ頂点の通り道** だけを見る。
// 頂点が引きずる辺（掴んだ頂点と隣の頂点を結ぶ 2 辺）が他の面を掃いても止めないし、
// 面の移動には拘束がそもそも無い。だから次の形は拘束を抜けて、確定で止めるしかない:
//   - 面の移動で、面を隣の面の上へ重ねる
//   - 頂点を隣の面の脇を通して引き、新しい辺が隣の面を横切る
//   - 共有頂点を引いて、**掴んでいない隣の面** の辺が第三の面を横切る
//   - 穴の頂点を引いて、穴の辺が穴の中の島を横切る（穴が島を覆う）
//   - 飛び地の頂点を引いて、飛び地の辺が隣の面を横切る
//
// 見ること（教訓 §5.95 の確かめ方）:
//   - 確定せずに重なり解決の板で止まり、形は元のまま
//   - 適用で解消し、状態行の結果が残り、Ctrl+Z 1 回で戻る
//   - 板をやめると何も記録しない
//   - 重なりを作らない普通のドラッグ（実データのコピーでも）は止めない
//
// 実データの置き場は `e2e/knife-v10-real.spec.ts` と同じ。ファイルが無ければその検査だけ飛ばす。
// 正本は開かない。一時ディレクトリへ複写して開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, type Locator, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  committedVertices,
  drawFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  launchAppWithProject,
  leafReport,
  liveCamera,
  projectStats,
  vertexHandlePositions,
  type ScreenPoint,
} from './helpers';

/** 中心 (cx, cy)・半幅 hw・半高 hh の長方形の 4 隅（左上から時計回り）。 */
function rect(cx: number, cy: number, hw: number, hh: number): readonly ScreenPoint[] {
  return [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
}

/** id → 片 → 環 → [経度, 緯度]。 */
type DrawnShapes = Record<string, number[][][][]>;

async function drawnShapes(page: Page): Promise<DrawnShapes> {
  return page.evaluate(
    () =>
      (window as unknown as { __E2E__: { getDrawnFeatureShapes: () => DrawnShapes } }).__E2E__
        .getDrawnFeatureShapes(),
  );
}

/** 最後に描いたフレームの印（吸着の予告の琥珀の輪など）の数。 */
async function handleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getPrimitiveCounts: () => { handle: number } };
    }).__E2E__;
    return e2e === undefined ? -1 : e2e.getPrimitiveCounts().handle;
  });
}

/** 面を 1 つ描いて、その id を返す。 */
async function face(page: Page, corners: readonly ScreenPoint[], name: string): Promise<string> {
  await armAddAreaTool(page);
  return drawFace(page, corners, { name });
}

/** 編集モードで (x, y) の面を選び、道具 `tool` を構える。 */
async function selectWithTool(
  page: Page,
  x: number,
  y: number,
  id: string,
  tool: 'tool-edit.vertex' | 'tool-edit.move',
): Promise<void> {
  await enterEditMode(page);
  await page.getByTestId('tool-edit.select').click();
  await page.keyboard.press('Escape');
  await page.mouse.click(x, y);
  await expect(page.getByTestId('app-active-feature')).toHaveText(id);
  await page.getByTestId(tool).click();
  await expect(page.getByTestId(tool)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('app-active-feature')).toHaveText(id);
}

/** 画面の (sx, sy) から (tx, ty) へ、何度かに分けて引く（本物のドラッグ）。 */
async function drag(page: Page, sx: number, sy: number, tx: number, ty: number): Promise<void> {
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8);
  }
  await page.mouse.up();
}

/** 初回のガイドが出ていれば閉じる。 */
async function closeGuideIfShown(page: Page): Promise<void> {
  const guide = page.getByTestId('conflict-guide');
  if (await guide.isVisible()) await page.getByTestId('conflict-guide-close').click();
  await expect(guide).toHaveCount(0);
}

/** 重なりの行で、残す面を名前で選ぶ（名前は検査が描いた面のデータで、画面の文言ではない）。 */
async function keepFace(row: Locator, name: string): Promise<void> {
  await row.getByRole('radio', { name: new RegExp(name) }).check();
}

/** 板で止まった: 形は元のまま、状態行はドラッグの確定（「素性の変更」）も解消も言っていない。 */
async function expectPausedUnchanged(page: Page, before: DrawnShapes): Promise<void> {
  await expect(page.getByTestId('conflict-dialog')).toBeVisible();
  expect(await drawnShapes(page)).toEqual(before);
  const result = page.getByTestId('statusbar-result');
  await expect(result).not.toContainText('素性の変更');
  await expect(result).not.toContainText('重なりを解消');
  await closeGuideIfShown(page);
}

/** 輪郭の道具を構え、(tx, ty) の面を対象にして、頂点を打って確定する。 */
async function addRing(
  page: Page,
  tx: number,
  ty: number,
  corners: readonly ScreenPoint[],
): Promise<void> {
  await enterEditMode(page);
  await page.getByTestId('tool-edit.ring').click();
  await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
  await page.mouse.click(tx, ty);
  await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute('data-flow', 'drafting');
  for (const [x, y] of corners) await page.mouse.click(x, y);
  await expect(page.getByTestId('ring-edit-vertex-count')).toHaveText(String(corners.length));
  await page.getByTestId('ring-edit-confirm').click();
  await expect(page.getByTestId('statusbar-result')).toContainText('穴・飛び地の追加を行いました');
  await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
  await page.getByTestId('tool-edit.select').click();
}

/**
 * 1200 年に、左の横長「アルラーク国」と右の縦長「バアカ」を離して描く
 * （`inc8e-ring-conflict.spec.ts` と同じ配置）。
 */
async function twoFaces(page: Page): Promise<{
  cx: number;
  cy: number;
  arlakId: string;
  baakaId: string;
}> {
  await jumpToYear(page, 1200);
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const arlakId = await face(page, rect(cx - 220, cy, 80, 40), 'アルラーク国');
  const baakaId = await face(page, rect(cx + 100, cy, 30, 130), 'バアカ');
  return { cx, cy, arlakId, baakaId };
}

test.describe('B98 — 頂点のドラッグ・面の移動の確定は重なりの検出を通る', () => {
  test('面の移動で隣の面に重ねると板で止まり、適用で解消し、結果が残り、Ctrl+Z 1 回で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy, arlakId, baakaId } = await twoFaces(page);
      const before = await drawnShapes(page);
      const statsBefore = await projectStats(page);

      // アルラーク国をバアカの真ん中へ運ぶ（面の移動には滑りの拘束が無い）。
      await selectWithTool(page, cx - 220, cy, arlakId, 'tool-edit.move');
      await drag(page, cx - 220, cy, cx + 100, cy);
      await expectPausedUnchanged(page, before);

      const row = page.getByTestId('conflict-rows').locator('li').first();
      await expect(row.getByTestId('conflict-row-features')).toContainText('アルラーク国');
      await expect(row.getByTestId('conflict-row-features')).toContainText('バアカ');

      // 動かした面を残す → バアカが上下 2 つに分かれる。
      await keepFace(row, 'アルラーク国');
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      const result = page.getByTestId('statusbar-result');
      await expect(result).toContainText(
        /(アルラーク国とバアカ|バアカとアルラーク国)の重なりを解消しました（1200年）/,
      );
      const after = await drawnShapes(page);
      expect(after[arlakId]!.length).toBe(1);
      expect(after[baakaId]!.length).toBe(2);

      // 選択は残り、別の道具を押せる。無関係の操作をしても結果が残る。
      await expect(page.getByTestId('app-active-feature')).toHaveText(arlakId);
      await page.getByTestId('tool-edit.select').click();
      await expect(page.getByTestId('tool-edit.select')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.click(cx + 330, cy + 170);
      await page.keyboard.press('Escape');
      await expect(result).toContainText('の重なりを解消しました（1200年）');

      // Ctrl+Z 1 回で、移動と解決の差し引きがまるごと戻る。
      await page.keyboard.press('Control+z');
      await expect(result).toContainText('元に戻しました');
      await expect.poll(async () => drawnShapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(statsBefore);
    } finally {
      await app.close();
    }
  });

  test('頂点を隣の脇へ引いて新しい辺が隣を横切ると板で止まり、やめると何も記録しない', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      // 左の三角「岬」。右の頂点 V = (cx-100, cy)。
      const capeId = await face(
        page,
        [
          [cx - 250, cy - 60],
          [cx - 100, cy],
          [cx - 250, cy + 60],
        ],
        '岬',
      );
      // 小さな「島」。V の通り道（y = cy）には触れず、V を右へ引いたあとの下の辺が横切る所。
      const islandId = await face(page, rect(cx - 50, cy + 45, 20, 20), '島');
      const before = await drawnShapes(page);
      const statsBefore = await projectStats(page);

      await selectWithTool(page, cx - 200, cy, capeId, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(3);
      await drag(page, cx - 100, cy, cx + 150, cy);
      await expectPausedUnchanged(page, before);

      const row = page.getByTestId('conflict-rows').locator('li').first();
      await expect(row.getByTestId('conflict-row-features')).toContainText('岬');
      await expect(row.getByTestId('conflict-row-features')).toContainText('島');

      // やめる → 何も記録せず、形も選択もそのまま。
      await page.getByTestId('conflict-cancel').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('重なりの解決をやめました');
      expect(await drawnShapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(statsBefore);
      await expect(page.getByTestId('app-active-feature')).toHaveText(capeId);

      // もう一度同じドラッグをして、島を残す → 岬が島の分だけ欠ける。
      await drag(page, cx - 100, cy, cx + 150, cy);
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      await keepFace(page.getByTestId('conflict-rows').locator('li').first(), '島');
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      const after = await drawnShapes(page);
      expect(after[islandId]).toEqual(before[islandId]);
      expect(after[capeId]!.flat().length).toBeGreaterThanOrEqual(1);
      expect(after[capeId]).not.toEqual(before[capeId]);
    } finally {
      await app.close();
    }
  });

  test('共有頂点を引いて、掴んでいない隣の面の辺が第三の面を横切っても板で止まる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const half = 90;
      // A（左）と B（右）は右辺の 2 隅を共有する（`snap-share.spec.ts` と同じ描き方）。
      const aCx = cx - half - 10;
      const aCorners = rect(aCx, cy, half, half);
      const aId = await face(page, aCorners, 'A');
      const aTopRight = aCorners[1]!;
      const aBottomRight = aCorners[2]!;
      await armAddAreaTool(page);
      // カーソルを A の右上隅へ運び、吸着の予告（琥珀の輪＋文）が出るのを待ってから打つ。
      await page.mouse.move(aTopRight[0] + 2, aTopRight[1] + 2);
      await expect(page.getByTestId('option-bar-next-step')).toContainText('頂点に合わせます');
      await expect.poll(async () => handleCount(page), { timeout: 10_000 }).toBeGreaterThan(0);
      const bId = await drawFace(
        page,
        [
          [aTopRight[0] + 2, aTopRight[1] + 2],
          [aTopRight[0] + 2 * half, aTopRight[1]],
          [aBottomRight[0] + 2 * half, aBottomRight[1]],
          [aBottomRight[0] + 2, aBottomRight[1] - 2],
        ],
        { name: 'B' },
      );
      // 前提: A と B は本当に頂点を共有している（座標が同じだけの別の頂点ではない）。
      const aVertexIds = new Set((await committedVertices(page, aId)).keys());
      const sharedIds = [...(await committedVertices(page, bId)).keys()].filter((id) =>
        aVertexIds.has(id),
      );
      expect(sharedIds, 'B の 2 頂点が A の右辺の 2 頂点に吸着して共有になっている').toHaveLength(2);
      // 第三の面「D」。共有頂点の真上の通り道には触れず、B の上の辺が持ち上がると横切る所。
      // 引いた先 (x, y-110) から D のどの角も吸着の距離（既定 50px）より遠くに置く ――
      // 吸着すると共有頂点が D の頂点へ溶接され、別の形になる（次の検査）。
      const dId = await face(page, rect(aTopRight[0] + 90, aTopRight[1] - 60, 20, 20), 'D');
      const before = await drawnShapes(page);

      // A を選んで、共有している右上の頂点を真上へ引く。
      await selectWithTool(page, aCx, cy, aId, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      await drag(page, aTopRight[0], aTopRight[1], aTopRight[0], aTopRight[1] - 110);
      await expectPausedUnchanged(page, before);

      // 止めたのは B と D の組（A は D に触れない）。
      const row = page.getByTestId('conflict-rows').locator('li').first();
      await expect(row.getByTestId('conflict-row-features')).toContainText('B');
      await expect(row.getByTestId('conflict-row-features')).toContainText('D');
      await expect(page.getByTestId('conflict-rows').locator('li')).toHaveCount(1);

      await keepFace(row, 'D');
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      const after = await drawnShapes(page);
      expect(after[dId]).toEqual(before[dId]);
      expect(after[bId]).not.toEqual(before[bId]);
      expect(after[aId]).not.toEqual(before[aId]);
    } finally {
      await app.close();
    }
  });

  test('共有頂点を第三の面の角へ吸着させても共有は切れず、板は本当に横切る組だけを言う（B100）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const half = 90;
      const aCx = cx - half - 10;
      const aCorners = rect(aCx, cy, half, half);
      const aId = await face(page, aCorners, 'A');
      const aTopRight = aCorners[1]!;
      const aBottomRight = aCorners[2]!;
      await armAddAreaTool(page);
      await page.mouse.move(aTopRight[0] + 2, aTopRight[1] + 2);
      await expect(page.getByTestId('option-bar-next-step')).toContainText('頂点に合わせます');
      await expect.poll(async () => handleCount(page), { timeout: 10_000 }).toBeGreaterThan(0);
      const bId = await drawFace(
        page,
        [
          [aTopRight[0] + 2, aTopRight[1] + 2],
          [aTopRight[0] + 2 * half, aTopRight[1]],
          [aBottomRight[0] + 2 * half, aBottomRight[1]],
          [aBottomRight[0] + 2, aBottomRight[1] - 2],
        ],
        { name: 'B' },
      );
      const aVertexIds = new Set((await committedVertices(page, aId)).keys());
      const sharedIds = [...(await committedVertices(page, bId)).keys()].filter((id) =>
        aVertexIds.has(id),
      );
      expect(sharedIds).toHaveLength(2);
      // D の左上の角は、引いた先 (x, y-110) から約 42px（既定の吸着距離 50px の内側）。
      const dId = await face(page, rect(aTopRight[0] + 50, aTopRight[1] - 60, 20, 20), 'D');
      const dVertices = await committedVertices(page, dId);
      const before = await drawnShapes(page);

      await selectWithTool(page, aCx, cy, aId, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      await drag(page, aTopRight[0], aTopRight[1], aTopRight[0], aTopRight[1] - 110);
      await expectPausedUnchanged(page, before);

      // 溶接が及べば A と B は同じ角を引くので、この 2 面は重ならない。止めるのは B ／ D だけ。
      const rows = page.getByTestId('conflict-rows').locator('li');
      await expect(rows).toHaveCount(1);
      await expect(rows.first().getByTestId('conflict-row-features')).toContainText('B');
      await expect(rows.first().getByTestId('conflict-row-features')).toContainText('D');

      await keepFace(rows.first(), 'D');
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);

      // 動かした共有頂点の id はどの面にも残らず、A と B は D の角を共有し続ける。
      const movedIds = sharedIds.filter((id) => !dVertices.has(id));
      const aAfter = await committedVertices(page, aId);
      const bAfter = await committedVertices(page, bId);
      const stillShared = [...bAfter.keys()].filter((id) => aAfter.has(id));
      expect(stillShared, 'A と B は 2 頂点を共有したまま').toHaveLength(2);
      const onCorner = stillShared.filter((id) => dVertices.has(id));
      expect(onCorner, 'A と B が共有する片方は D の角').toHaveLength(1);
      expect(aAfter.get(onCorner[0]!)).toEqual(dVertices.get(onCorner[0]!));
      expect(bAfter.get(onCorner[0]!)).toEqual(dVertices.get(onCorner[0]!));
      expect(
        movedIds.filter((id) => aAfter.has(id) && !bAfter.has(id)),
        '片方の面だけが引く共有頂点が残らない',
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('穴の頂点を引いて穴の辺が中の島を横切ると板で止まる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const bayId = await face(page, rect(cx, cy, 170, 130), '湾');
      await addRing(page, cx + 150, cy + 110, rect(cx, cy, 80, 60));
      const islandId = await face(page, rect(cx, cy, 30, 25), '島');
      const before = await drawnShapes(page);

      // 湾を選び、穴の左上の頂点を右へ引く。通り道（y = cy-60）は島に触れないが、
      // 穴の左の辺が島を横切り、湾が島を覆う。
      await selectWithTool(page, cx + 150, cy + 110, bayId, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(8);
      await drag(page, cx - 80, cy - 60, cx + 20, cy - 60);
      await expectPausedUnchanged(page, before);

      const row = page.getByTestId('conflict-rows').locator('li').first();
      await expect(row.getByTestId('conflict-row-features')).toContainText('湾');
      await expect(row.getByTestId('conflict-row-features')).toContainText('島');
      await keepFace(row, '島');
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      const after = await drawnShapes(page);
      expect(after[islandId]).toEqual(before[islandId]);
      expect(after[bayId]).not.toEqual(before[bayId]);
    } finally {
      await app.close();
    }
  });

  test('飛び地の頂点を引いて飛び地の辺が隣を横切ると板で止まる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const arlakId = await face(page, rect(cx - 250, cy, 60, 40), 'アルラーク国');
      // 三角の飛び地。右の頂点 V = (cx, cy)。
      await addRing(page, cx - 250, cy, [
        [cx - 150, cy - 60],
        [cx, cy],
        [cx - 150, cy + 60],
      ]);
      // 小さな「島」。V の通り道（y = cy）には触れず、V を右へ引いたあとの飛び地の下の辺が横切る所。
      const islandId = await face(page, rect(cx + 50, cy + 45, 20, 20), '島');
      const before = await drawnShapes(page);
      expect(before[arlakId]!.length).toBe(2);

      await selectWithTool(page, cx - 250, cy, arlakId, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(7);
      await drag(page, cx, cy, cx + 250, cy);
      await expectPausedUnchanged(page, before);

      const row = page.getByTestId('conflict-rows').locator('li').first();
      await expect(row.getByTestId('conflict-row-features')).toContainText('アルラーク国');
      await expect(row.getByTestId('conflict-row-features')).toContainText('島');
      await keepFace(row, '島');
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      const after = await drawnShapes(page);
      expect(after[islandId]).toEqual(before[islandId]);
      expect(after[arlakId]).not.toEqual(before[arlakId]);
    } finally {
      await app.close();
    }
  });

  test('重なりを作らないドラッグは止めない（頂点を内へ・面を空の所へ）', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy, arlakId } = await twoFaces(page);
      const dialog = page.getByTestId('conflict-dialog');

      await selectWithTool(page, cx - 220, cy, arlakId, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      const before = await drawnShapes(page);
      await drag(page, cx - 300, cy - 40, cx - 280, cy - 20);
      await expect.poll(async () => drawnShapes(page)).not.toEqual(before);
      await expect(dialog).toHaveCount(0);

      const moved = await drawnShapes(page);
      await page.getByTestId('tool-edit.move').click();
      await drag(page, cx - 220, cy, cx - 220, cy + 120);
      await expect.poll(async () => drawnShapes(page)).not.toEqual(moved);
      await expect(dialog).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 生きている描画の逆変換を 2 点で測って、世界→画面の式を作る。 */
async function worldToScreen(
  page: Page,
): Promise<(lon: number, lat: number) => readonly [number, number]> {
  const box = (await page.getByTestId('map-area').boundingBox())!;
  const x0 = box.x + box.width * 0.25;
  const x1 = box.x + box.width * 0.75;
  const y0 = box.y + box.height * 0.25;
  const y1 = box.y + box.height * 0.75;
  const [p0, p1] = await page.evaluate(
    ([a, b, c, d]) => {
      const w = window as unknown as {
        __E2E__: { screenToWorld: (x: number, y: number) => { lon: number; lat: number } | null };
      };
      return [w.__E2E__.screenToWorld(a, c), w.__E2E__.screenToWorld(b, d)];
    },
    [x0, x1, y0, y1] as const,
  );
  if (p0 === null || p1 === null) throw new Error('screenToWorld が使えない');
  const ax = (p1.lon - p0.lon) / (x1 - x0);
  const ay = (p1.lat - p0.lat) / (y1 - y0);
  const bx = p0.lon - ax * x0;
  const by = p0.lat - ay * y0;
  return (lon, lat) => [(lon - bx) / ax, (lat - by) / ay];
}

test.describe('B98 — 実データのコピーで', () => {
  test.skip(!existsSync(canonicalPath), `実データ ${REAL_DATA_FILE} が無い`);

  test('頂点を内へ寄せる普通のドラッグは板を出さず、面の移動は隣との重なりで止まり、どちらも待たせない', async () => {
    test.setTimeout(180_000);
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-drag-conflict-'));
    const copy = join(dir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);
    const { app, page } = await launchAppWithProject(copy);
    try {
      await jumpToYear(page, 3000);
      const toScreen = await worldToScreen(page);
      // アルラーク国（内側の点は `knife-v10-real.spec.ts` の探針の値）。
      const [ix, iy] = toScreen(96.6, 57.37);
      const report = (await leafReport(page, { names: ['アルラーク国'] })).entries[0]!;

      await selectWithTool(page, ix, iy, report.id, 'tool-edit.vertex');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBeGreaterThan(3);
      const handles = await vertexHandlePositions(page);
      // 内側の点にいちばん近い頂点を、内側の点へ 6px 寄せる（隣から離れる向き）。
      const nearest = [...handles].sort(
        (p, q) =>
          Math.hypot(p.lon - 96.6, p.lat - 57.37) - Math.hypot(q.lon - 96.6, q.lat - 57.37),
      )[0]!;
      // 全体図では 50px（既定の吸着距離）の中にたいてい他の面の頂点があり、6px のつもりでも
      // 吸着してそこへ飛ぶ。ここで見たいのは吸着しないドラッグなので、その頂点へ寄る。
      const [zx, zy] = toScreen(nearest.lon, nearest.lat);
      await page.mouse.move(zx, zy);
      for (let i = 0; i < 40 && (await liveCamera(page)).zoom < 50; i += 1) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(50);
      }
      expect((await liveCamera(page)).zoom).toBeGreaterThanOrEqual(50);
      const zoomedToScreen = await worldToScreen(page);
      const [hx, hy] = zoomedToScreen(nearest.lon, nearest.lat);
      const [tx, ty] = zoomedToScreen(96.6, 57.37);
      const dx = tx - hx;
      const dy = ty - hy;
      const d = Math.hypot(dx, dy);
      const before = await drawnShapes(page);
      let started = Date.now();
      await drag(page, hx, hy, hx + (dx / d) * 6, hy + (dy / d) * 6);
      await expect.poll(async () => drawnShapes(page)).not.toEqual(before);
      const vertexMs = Date.now() - started;
      console.log(`[B98] 実データの頂点のドラッグの確定 ${String(vertexMs)}ms`);
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await page.keyboard.press('Control+z');
      await expect.poll(async () => drawnShapes(page)).toEqual(before);
      await page.getByTestId('map-fit-all').click();
      await expect.poll(async () => (await liveCamera(page)).zoom).toBeLessThan(50);
      const [mx, my] = (await worldToScreen(page))(96.6, 57.37);

      // 面の移動: 隣と接している国を 10px ずらすと重なるので、板で止まる。
      await page.getByTestId('tool-edit.move').click();
      started = Date.now();
      await drag(page, mx, my, mx + 10, my);
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      const moveMs = Date.now() - started;
      console.log(`[B98] 実データの面の移動が板で止まるまで ${String(moveMs)}ms`);
      expect(await drawnShapes(page)).toEqual(before);
      await closeGuideIfShown(page);
      await page.getByTestId('conflict-cancel').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      expect(await drawnShapes(page)).toEqual(before);
      // 待ち時間は記録するだけ（`knife-v10-real.spec.ts` の B97 と同じ）。混んだ全件ゲートでは
      // 単独の 2〜3 倍かかることがあり、しきい値を置くと検出ではなく混み具合で赤くなる。
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
