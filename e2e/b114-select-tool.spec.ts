// B114（所有者の裁定 2026-10-31）: 「選択」の道具は地物だけを選ぶ。頂点は「頂点」の道具で掴む。
//
// 実測の形: 実データの全体図 1 px/度で、小さな国の内側は全部が頂点から 8px 以内に入る。直す前は
// 押すと頂点が選ばれ候補一覧が出て、国は選ばれず、続けて［動かす］を構えても対象が無かった。
// 正本は開かない（コピーを開く。§5.48）。

import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import { PROPERTY_STRINGS } from '../src/ui/property/messages';
import {
  armVertexTool,
  commitOneFace,
  jumpToYear,
  launchApp,
  launchAppWithProject,
  leafReport,
  leaveViewMode,
  liveCamera,
  loadSyntheticProject,
  projectStats,
  returnToViewMode,
  selectedVertexIds,
  vertexHandlePositions,
  worldToClient,
} from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** アルラーク国の内側の点（`docs/実装済み.md` の B114 の実測）。 */
const INSIDE_ALRUK = { lon: 96.6, lat: 57.37 };

async function zoomOutToFloor(page: Page): Promise<void> {
  const box = (await page.getByTestId('map-input-layer').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let before = -1;
  for (let i = 0; i < 40; i += 1) {
    const now = (await liveCamera(page)).zoom;
    if (now === before) return;
    before = now;
    await page.mouse.wheel(0, 240);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  }
}

test.describe('B114: 「選択」の道具は地物だけを選ぶ（実データ）', () => {
  test.skip(!existsSync(canonicalPath), `実データが無い (${canonicalPath})`);

  test('全体図で小さな国の内側を押すと国が選ばれ、一覧は出ず、帯と右パネルが同じ国を言い、［動かす］に対象がある', async () => {
    test.setTimeout(180_000);
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-b114-'));
    const copy = join(dir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);
    const { app, page } = await launchAppWithProject(copy);
    try {
      await jumpToYear(page, 3000);
      await leaveViewMode(page);
      await zoomOutToFloor(page);
      const zoom = (await liveCamera(page)).zoom;
      expect(zoom, '実測の形は 1 px/度の全体図').toBeLessThanOrEqual(1.01);

      const report = (await leafReport(page, { names: ['アルラーク国'] })).entries[0]!;
      const at = await worldToClient(page, INSIDE_ALRUK);
      await page.mouse.click(at.x, at.y);

      await expect(page.getByTestId('app-active-feature')).toHaveText(report.id);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      await expect(page.getByTestId('option-bar-target')).toContainText('アルラーク国');
      await page.getByTestId('sidebar-tab-properties').click();
      const nameField = page
        .getByTestId('sidebar-panel-properties')
        .getByTestId('basic-info')
        .getByLabel(PROPERTY_STRINGS.nameLabel);
      await expect(nameField).toHaveValue('アルラーク国');

      await page.getByTestId('tool-edit.move').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(report.id);
      await expect(page.getByTestId('option-bar-target')).toContainText('アルラーク国');
    } finally {
      await app.close();
    }
  });
});

test.describe('B114: 「選択」の動き', () => {
  test('印を描かず、頂点の上を押しても頂点に当たらず、辺に頂点も足されない', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(face.cx, face.cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(0);

      const before = await projectStats(page);
      // 隅（頂点の上）と、上の辺の中点（頂点の足し口があった所）を順に押す。
      const [ax, ay] = face.corners[0]!;
      const [bx, by] = face.corners[1]!;
      await page.mouse.click(ax, ay);
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await page.mouse.click((ax + bx) / 2, (ay + by) / 2);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      expect(await projectStats(page)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test('何もないところからのドラッグは地図を動かし、頂点を囲まない。動かさず離せば選択が外れる', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(face.cx, face.cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);

      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      // 地図の左上の隅は四角から十分遠い何もないところ（四角全体を囲む向きへ引く）。
      const from = { x: box.x + 20, y: box.y + 20 };
      const camBefore = await liveCamera(page);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 300, from.y + 300, { steps: 6 });
      await page.mouse.up();
      const camAfter = await liveCamera(page);
      expect(camAfter.centerLon).not.toBeCloseTo(camBefore.centerLon, 3);
      expect(camAfter.centerLat).not.toBeCloseTo(camBefore.centerLat, 3);
      expect(await selectedVertexIds(page)).toEqual([]);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);

      await page.mouse.click(from.x, from.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
    } finally {
      await app.close();
    }
  });

  test('「頂点」の道具では何もないところからのドラッグで今までどおり頂点を囲める', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      await armVertexTool(page);
      const camBefore = await liveCamera(page);
      const xs = face.corners.map(([x]) => x);
      const ys = face.corners.map(([, y]) => y);
      const pad = 40;
      await page.mouse.move(Math.min(...xs) - pad, Math.min(...ys) - pad);
      await page.mouse.down();
      await page.mouse.move(Math.max(...xs) + pad, Math.max(...ys) + pad, { steps: 6 });
      await page.mouse.up();
      expect(await selectedVertexIds(page)).toHaveLength(face.corners.length);
      expect((await liveCamera(page)).centerLon).toBe(camBefore.centerLon);
    } finally {
      await app.close();
    }
  });

  test('頂点を選んで「選択」へ持ち替えると頂点の選択は消え、Delete も右クリックも頂点を相手にしない', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      await armVertexTool(page);
      const [cornerX, cornerY] = face.corners[0]!;
      await page.mouse.click(cornerX, cornerY);
      expect(await selectedVertexIds(page)).toHaveLength(1);

      await page.getByTestId('tool-edit.select').click();
      expect(await selectedVertexIds(page)).toEqual([]);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');

      // 頂点が残っていれば Delete は頂点を消す。いまは地物の削除の確認へ進み、やめれば何も変わらない。
      const before = await projectStats(page);
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('delete-impact')).toHaveCount(0);
      expect(await projectStats(page)).toEqual(before);

      // 隅を右クリックしても、当たるのは頂点でなく面。頂点の項目は出ない。
      await page.mouse.click(cornerX, cornerY, { button: 'right' });
      await expect(page.getByTestId('context-menu')).toBeVisible();
      await expect(
        page.getByTestId('context-menu').locator('[data-item-kind="deleteVertex"]'),
      ).toHaveCount(0);
      await expect(page.getByTestId('context-menu').locator('[data-item-kind="delete"]')).toBeVisible();
      expect(await selectedVertexIds(page)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('頂点を選んだまま鍵を閉じて開けても、測量へ入っても、見えない頂点が残らない', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const [cornerX, cornerY] = face.corners[0]!;
      await armVertexTool(page);
      await page.mouse.click(cornerX, cornerY);
      expect(await selectedVertexIds(page)).toHaveLength(1);
      await returnToViewMode(page);
      expect(await selectedVertexIds(page)).toEqual([]);
      await leaveViewMode(page);
      expect(await selectedVertexIds(page)).toEqual([]);

      await armVertexTool(page);
      await page.mouse.click(cornerX, cornerY);
      expect(await selectedVertexIds(page)).toHaveLength(1);
      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      expect(await selectedVertexIds(page)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('読み込んだ小さな地物でも、一覧から選んだあと地図で押すと候補一覧は出ない', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 1);
      await leaveViewMode(page);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('合成地物0000');
      await page.getByTestId('feature-list-item-syn-0000').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      // 選んだ地物へ視点が合っているので、地図の真ん中が小さな四角の内側。
      expect(await vertexHandlePositions(page)).toEqual([]);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
    } finally {
      await app.close();
    }
  });
});
