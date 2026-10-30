// B97 — 輪郭の道具（穴・飛び地の追加・削除）の確定も、他の描く道具と同じく重なりの検出を通す。
//
// 見ること（教訓 §5.95 の確かめ方）:
//   - 重なる飛び地・重なりを生む穴の削除は、確定せずに重なり解決の板で止まる
//   - 適用の直後に「捨てますか」の板が出ない。別の道具を押せる。状態行の結果が残る
//   - Ctrl+Z 1 回で、輪郭の編集と解決の差し引きがまるごと戻る
//   - 板をやめたら下書きは捨てて構え直す（追加・分ける・穴あけと同じ）
//   - 重なりが増えない操作（普通の穴・空の所の飛び地・穴や飛び地の削除）では止めない
//   - 実データのコピーでも、普通の穴あけは止まらない
//
// 実データの置き場は `e2e/knife-v10-real.spec.ts` と同じ。ファイルが無ければその検査だけ飛ばす。
// 正本は開かない。一時ディレクトリへ複写して開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  launchAppWithProject,
  leafReport,
  projectStats,
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

/** 面を 1 つ描いて、その id を返す。 */
async function face(page: Page, corners: readonly ScreenPoint[], name: string): Promise<string> {
  await armAddAreaTool(page);
  return drawFace(page, corners, { name });
}

/** 輪郭の道具を構え、(tx, ty) の面を対象にする。 */
async function armRingOn(page: Page, tx: number, ty: number): Promise<void> {
  await enterEditMode(page);
  await page.getByTestId('tool-edit.ring').click();
  await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
  await page.mouse.click(tx, ty);
  await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute('data-flow', 'drafting');
}

/** 対象を選んだ輪郭の道具で、頂点を打って確定する。 */
async function drawRingAndConfirm(page: Page, corners: readonly ScreenPoint[]): Promise<void> {
  for (const [x, y] of corners) await page.mouse.click(x, y);
  await expect(page.getByTestId('ring-edit-vertex-count')).toHaveText(String(corners.length));
  await page.getByTestId('ring-edit-confirm').click();
}

/** 消す側へ切り替えて (tx, ty) の面を選び、(rx, ry) の輪郭を消す確認に［はい］と答える。 */
async function deleteRingAt(
  page: Page,
  tx: number,
  ty: number,
  rx: number,
  ry: number,
): Promise<void> {
  await enterEditMode(page);
  await page.getByTestId('tool-edit.ring').click();
  await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
  await page.getByTestId('ring-edit-submode').click();
  await page.mouse.click(tx, ty);
  await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute('data-flow', 'deleting');
  await page.mouse.click(rx, ry);
  await page.getByTestId('ring-delete-impact-confirm').click();
  await expect(page.getByTestId('ring-delete-impact')).toHaveCount(0);
}

/** 初回のガイドが出ていれば閉じる。 */
async function closeGuideIfShown(page: Page): Promise<void> {
  const guide = page.getByTestId('conflict-guide');
  if (await guide.isVisible()) await page.getByTestId('conflict-guide-close').click();
  await expect(guide).toHaveCount(0);
}

/** 「捨てますか」の板が（遅れて出る分も含めて）出ていないこと。 */
async function expectNoDiscardBoard(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await expect(page.getByTestId('ring-edit-draft-discard-confirm')).toHaveCount(0);
  await expect(page.getByTestId('ring-edit-draft-discard-confirm-backdrop')).toHaveCount(0);
}

/**
 * 1200 年に、左の横長「アルラーク国」と右の縦長「バアカ」を離して描く。
 * 重なる飛び地は、バアカと十字に交わる横長（頂点はどれもアルラーク国とバアカの外）。
 */
async function twoFaces(page: Page): Promise<{
  cx: number;
  cy: number;
  arlakId: string;
  baakaId: string;
  crossing: readonly ScreenPoint[];
}> {
  await jumpToYear(page, 1200);
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const arlakId = await face(page, rect(cx - 220, cy, 80, 40), 'アルラーク国');
  const baakaId = await face(page, rect(cx + 100, cy, 30, 130), 'バアカ');
  return { cx, cy, arlakId, baakaId, crossing: rect(cx + 100, cy, 110, 25) };
}

test.describe('B97 — 輪郭の確定は重なりの検出を通る', () => {
  test('重なる飛び地は板で止まり、適用で解消し、結果が残り、Ctrl+Z 1 回で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy, arlakId, baakaId, crossing } = await twoFaces(page);
      const before = await drawnShapes(page);
      const statsBefore = await projectStats(page);

      await armRingOn(page, cx - 220, cy);
      await drawRingAndConfirm(page, crossing);

      // 確定せずに、重なり解決の板で止まる。
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute(
        'data-flow',
        'conflict-paused',
      );
      await expect(page.getByTestId('statusbar-result')).not.toContainText('穴・飛び地の追加');
      expect(await drawnShapes(page)).toEqual(before);
      await closeGuideIfShown(page);

      // 止まっている間、道具の打鍵は頂点を減らさない（鍵盤は板のもの）。
      await page.keyboard.press('Control+z');
      await expect(dialog).toBeVisible();

      const row = page.getByTestId('conflict-rows').locator('li').first();
      await expect(row.getByTestId('conflict-row-features')).toContainText('アルラーク国');
      await expect(row.getByTestId('conflict-row-features')).toContainText('バアカ');

      // 飛び地（アルラーク国）を残す → バアカが 2 つに分かれる。
      await row.getByRole('radio', { name: /アルラーク国/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);

      // §5.95: 適用の直後に「捨てますか」が出ない。「頂点を捨てました」で上書きされない。
      await expectNoDiscardBoard(page);
      const result = page.getByTestId('statusbar-result');
      await expect(result).toContainText(
        /(アルラーク国とバアカ|バアカとアルラーク国)の重なりを解消しました（1200年）/,
      );

      // 形: 片が増え、バアカの全部の片が飛び地の帯の外。
      const after = await drawnShapes(page);
      expect(after[arlakId]!.length).toBe(2);
      expect(after[baakaId]!.length).toBe(2);

      // 別の道具を押せる。無関係の操作をしても結果が残る。
      await page.getByTestId('tool-edit.select').click();
      await expect(page.getByTestId('tool-edit.select')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.click(cx + 330, cy + 170);
      await page.keyboard.press('Escape');
      await expect(result).toContainText('の重なりを解消しました（1200年）');

      // Ctrl+Z 1 回で、輪郭の編集と解決の差し引きがまるごと戻る。
      await page.keyboard.press('Control+z');
      await expect(result).toContainText('元に戻しました');
      await expect.poll(async () => drawnShapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(statsBefore);
    } finally {
      await app.close();
    }
  });

  test('飛び地を削られる側に選ぶと、飛び地が重なりの分だけ欠ける', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy, arlakId, baakaId, crossing } = await twoFaces(page);
      const before = await drawnShapes(page);

      await armRingOn(page, cx - 220, cy);
      await drawRingAndConfirm(page, crossing);
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      await closeGuideIfShown(page);

      const row = page.getByTestId('conflict-rows').locator('li').first();
      await row.getByRole('radio', { name: /バアカ/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expectNoDiscardBoard(page);

      const after = await drawnShapes(page);
      // バアカはそのまま。アルラーク国は元の面と、飛び地の左右の 2 片で計 3 片。
      expect(after[baakaId]).toEqual(before[baakaId]);
      expect(after[arlakId]!.length).toBe(3);
    } finally {
      await app.close();
    }
  });

  test('板をやめると何も記録せず、下書きを捨てて構え直す（「捨てました」とは言わない）', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy, crossing } = await twoFaces(page);
      const before = await drawnShapes(page);
      const statsBefore = await projectStats(page);

      await armRingOn(page, cx - 220, cy);
      await drawRingAndConfirm(page, crossing);
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      await closeGuideIfShown(page);

      await page.getByTestId('conflict-cancel').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expectNoDiscardBoard(page);

      const result = page.getByTestId('statusbar-result');
      await expect(result).toContainText('重なりの解決をやめました');
      await expect(result).not.toContainText('捨てました');

      await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
      await expect(page.getByTestId('ring-edit-vertex-count')).toHaveText('0');
      expect(await drawnShapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(statsBefore);
    } finally {
      await app.close();
    }
  });

  test('中に面がある穴を消すと、穴が塞がって重なるので板で止まり、面を残すと穴が戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const outerId = await face(page, rect(cx, cy, 170, 130), '湾');
      // 穴を開ける。
      await armRingOn(page, cx + 150, cy + 110);
      await drawRingAndConfirm(page, rect(cx, cy, 80, 60));
      await expect(page.getByTestId('statusbar-result')).toContainText('穴・飛び地の追加を行いました');
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await page.getByTestId('tool-edit.select').click();
      // 穴の空洞に島を描く（頂点はどれも湾の内側ではない）。
      const islandId = await face(page, rect(cx, cy, 30, 25), '島');
      const before = await drawnShapes(page);
      const statsBefore = await projectStats(page);

      // 穴を消す（押す所は島の外・穴の中）。
      await deleteRingAt(page, cx + 150, cy + 110, cx + 60, cy + 45);

      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      expect(await drawnShapes(page)).toEqual(before);
      await closeGuideIfShown(page);

      // 島を残す → 湾は島の分だけ欠ける（穴の大きさは島の大きさになる）。
      const row = page.getByTestId('conflict-rows').locator('li').first();
      await row.getByRole('radio', { name: /島/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);
      await expectNoDiscardBoard(page);
      await expect(page.getByTestId('statusbar-result')).toContainText('の重なりを解消しました');
      const after = await drawnShapes(page);
      expect(after[islandId]).toEqual(before[islandId]);
      expect(after[outerId]!.flat().length).toBe(2);

      await page.keyboard.press('Control+z');
      await expect.poll(async () => drawnShapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(statsBefore);
    } finally {
      await app.close();
    }
  });

  test('隣の中にすっぽり入る飛び地: 隣を残すと飛び地が消え、飛び地を残すと隣に穴が開く', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy, arlakId, baakaId } = await twoFaces(page);
      const before = await drawnShapes(page);
      const inside = rect(cx + 100, cy, 15, 15);

      // 隣（バアカ）を残す。
      await armRingOn(page, cx - 220, cy);
      await drawRingAndConfirm(page, inside);
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      await closeGuideIfShown(page);
      const row = page.getByTestId('conflict-rows').locator('li').first();
      await row.getByRole('radio', { name: /バアカ/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);
      await expectNoDiscardBoard(page);
      await expect(page.getByTestId('statusbar-result')).toContainText('の重なりを解消しました（1200年）');
      // 飛び地は全部差し引かれて消える。バアカも元の面の 1 片も変わらない。
      expect((await drawnShapes(page))[baakaId]).toEqual(before[baakaId]);
      expect((await drawnShapes(page))[arlakId]!.length).toBe(1);
      await page.keyboard.press('Control+z');
      await expect.poll(async () => drawnShapes(page)).toEqual(before);

      // 飛び地（アルラーク国）を残す。
      await page.getByTestId('tool-edit.select').click();
      await armRingOn(page, cx - 220, cy);
      await drawRingAndConfirm(page, inside);
      await expect(dialog).toBeVisible();
      await row.getByRole('radio', { name: /アルラーク国/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);
      await expectNoDiscardBoard(page);
      const after = await drawnShapes(page);
      expect(after[arlakId]!.length).toBe(2);
      expect(after[baakaId]!.flat().length).toBe(2);
    } finally {
      await app.close();
    }
  });

  test('穴の中の面を丸ごと覆うほうを選ぶと断られ、板は残り、選び直せる', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const outerId = await face(page, rect(cx, cy, 170, 130), '湾');
      await armRingOn(page, cx + 150, cy + 110);
      await drawRingAndConfirm(page, rect(cx, cy, 80, 60));
      await expect(page.getByTestId('statusbar-result')).toContainText('穴・飛び地の追加を行いました');
      await page.getByTestId('tool-edit.select').click();
      const islandId = await face(page, rect(cx, cy, 30, 25), '島');
      const before = await drawnShapes(page);

      await deleteRingAt(page, cx + 150, cy + 110, cx + 60, cy + 45);
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      await closeGuideIfShown(page);
      const row = page.getByTestId('conflict-rows').locator('li').first();
      // 湾を残すと島が丸ごと無くなる。差し引きは空の形を作らないので断られ、記録されない。
      await row.getByRole('radio', { name: /湾/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toContainText('確定できません');
      expect(await drawnShapes(page)).toEqual(before);

      // 板のまま選び直せる。
      await page.getByTestId('conflict-retry').click();
      await page.getByTestId('conflict-rows').locator('li').first().getByRole('radio', { name: /島/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);
      await expectNoDiscardBoard(page);
      const after = await drawnShapes(page);
      expect(after[islandId]).toEqual(before[islandId]);
      expect(after[outerId]!.flat().length).toBe(2);
    } finally {
      await app.close();
    }
  });

  test('重なりが増えない操作では止めない（普通の穴・空の所の飛び地・空の穴と飛び地の削除）', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy, arlakId, baakaId } = await twoFaces(page);
      const dialog = page.getByTestId('conflict-dialog');
      const result = page.getByTestId('statusbar-result');

      // 穴を開ける。
      await armRingOn(page, cx - 280, cy);
      await drawRingAndConfirm(page, rect(cx - 220, cy, 25, 15));
      await expect(result).toContainText('穴・飛び地の追加を行いました');
      await expect(dialog).toHaveCount(0);
      await page.getByTestId('tool-edit.select').click();

      // バアカに接しない所に飛び地を足す。
      await armRingOn(page, cx - 280, cy);
      await drawRingAndConfirm(page, rect(cx - 100, cy - 130, 30, 20));
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(async () => (await drawnShapes(page))[arlakId]!.length)
        .toBe(2);
      await page.getByTestId('tool-edit.select').click();
      const baakaBefore = (await drawnShapes(page))[baakaId];

      // 飛び地を消す。
      await deleteRingAt(page, cx - 280, cy, cx - 100, cy - 130);
      await expect(result).toContainText('穴・飛び地の削除を行いました');
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(async () => (await drawnShapes(page))[arlakId]!.length)
        .toBe(1);
      await page.getByTestId('tool-edit.select').click();

      // 穴を消す（中には何も無い）。
      await deleteRingAt(page, cx - 280, cy, cx - 220, cy);
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(async () => (await drawnShapes(page))[arlakId]!.flat().length)
        .toBe(1);
      expect((await drawnShapes(page))[baakaId]).toEqual(baakaBefore);
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

test.describe('B97 — 実データのコピーで', () => {
  test.skip(!existsSync(canonicalPath), `実データ ${REAL_DATA_FILE} が無い`);

  test('隣がたくさんあっても普通の穴あけは板を出さず、確定は人の待ち時間にならない', async () => {
    test.setTimeout(180_000);
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-ring-conflict-'));
    const copy = join(dir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);
    const { app, page } = await launchAppWithProject(copy);
    try {
      await jumpToYear(page, 3000);
      const toScreen = await worldToScreen(page);
      // アルラーク国（内側の点は `knife-v10-real.spec.ts` の探針の値。境界から離れている）。
      const [ix, iy] = toScreen(96.6, 57.37);

      await enterEditMode(page);
      await page.getByTestId('tool-edit.ring').click();
      await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
      await page.mouse.click(ix, iy);
      await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute('data-flow', 'drafting');
      const before = (await leafReport(page, { names: ['アルラーク国'] })).entries[0]!;

      for (const [x, y] of rect(ix, iy, 4, 3)) await page.mouse.click(x, y);
      const started = Date.now();
      await page.getByTestId('ring-edit-confirm').click();
      await expect(page.getByTestId('statusbar-result')).toContainText('穴・飛び地の追加を行いました');
      const elapsed = Date.now() - started;
      console.log(`[B97] 実データの穴あけの確定 ${String(elapsed)}ms`);
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);

      const after = (await leafReport(page, { names: ['アルラーク国'] })).entries[0]!;
      expect(after.id).toBe(before.id);
      expect(after.ringCount).toBe(before.ringCount + 1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
