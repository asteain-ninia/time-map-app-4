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
import { SYNTHETIC_NEST_PARENT_ID } from '../src/ui/e2e/synthetic-project';
import {
  armVertexTool,
  besideSquareX,
  commitOneFace,
  commitSquareFace,
  committedVertices,
  jumpToYear,
  launchApp,
  launchAppWithProject,
  leafReport,
  leaveViewMode,
  liveCamera,
  loadSyntheticNested,
  loadSyntheticProject,
  openDepthOptions,
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
      // 隅（頂点の上）と、上の辺の中点（頂点の足し口があった所）を順に押す。辺に頂点が足されるのは
      // その面を選んでいるときなので、面を選び直してから押す。
      const [ax, ay] = face.corners[0]!;
      const [bx, by] = face.corners[1]!;
      await page.mouse.click(ax, ay);
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');

      await page.mouse.click(face.cx, face.cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
      await page.mouse.click((ax + bx) / 2, (ay + by) / 2);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      expect(await projectStats(page)).toEqual(before);
      expect((await committedVertices(page, face.faceId)).size).toBe(4);
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

/**
 * 「選択」へ持ち替えたあと、見えない頂点が残っていないことを見る。残っていると Delete が頂点を消す
 * 板を出し、Escape に頂点を外すだけの段が余分に残る（B114 の検証で見つけた形）。
 */
async function expectNoHiddenVertexOnSelectTool(page: Page, faceId: string): Promise<void> {
  await page.getByTestId('tool-edit.select').click();
  await expect(page.getByTestId('tool-edit.select')).toHaveAttribute('aria-pressed', 'true');
  expect(await selectedVertexIds(page)).toEqual([]);
  await expect(page.getByTestId('app-active-vertex')).toHaveText('');
  await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(0);
  await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

  const before = await projectStats(page);
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('delete-impact')).toBeVisible();
  await expect(page.getByTestId('vertex-delete-impact')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('delete-impact')).toHaveCount(0);
  expect(await projectStats(page)).toEqual(before);

  // Escape の 1 回で地物の選択が外れる（頂点を外すだけの段が無い）。
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('app-active-feature')).toHaveText('');
}

test.describe('B114 の検証: 選択を持ったまま道具を替える経路でも、見えない頂点が残らない', () => {
  /** 左の面の隅を「頂点」で押した状態を作る（右の面は「所属」の持ち替え先）。 */
  async function twoFacesWithGrabbedCorner(page: Page): Promise<{
    readonly faceId: string;
    readonly corner: readonly [number, number];
  }> {
    await leaveViewMode(page);
    const box = (await page.getByTestId('map-input-layer').boundingBox())!;
    const cx = box.x + box.width * 0.3;
    const cy = box.y + box.height * 0.5;
    const faceId = await commitSquareFace(page, cx, cy, 80);
    await commitSquareFace(page, besideSquareX(cx, 80, 80, 20), cy, 80);
    await armVertexTool(page);
    await page.mouse.click(cx, cy);
    await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    const corner = [cx - 80, cy - 80] as const;
    await page.mouse.click(corner[0], corner[1]);
    expect(await selectedVertexIds(page)).toHaveLength(1);
    await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
    return { faceId, corner };
  }

  test('素性欄の親のボタンから所属の板を開き、Escape で閉じて「選択」へ', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId } = await twoFacesWithGrabbedCorner(page);
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('parent-pick').click();
      await expect(page.getByTestId('tool-edit.reparent')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await expectNoHiddenVertexOnSelectTool(page, faceId);
    } finally {
      await app.close();
    }
  });

  for (const [kind, tool] of [
    ['split', 'tool-edit.knife'],
    ['changeAffiliation', 'tool-edit.reparent'],
  ] as const) {
    test(`頂点の右クリックの「${kind}」から「選択」へ`, async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, corner } = await twoFacesWithGrabbedCorner(page);
        await page.mouse.click(corner[0], corner[1], { button: 'right' });
        await page.getByTestId('context-menu').locator(`[data-item-kind="${kind}"]`).click();
        await expect(page.getByTestId(tool)).toHaveAttribute('aria-pressed', 'true');
        // 道具は頂点の選択を読まない。対象の地物は残っていて、道具の働きは変わらない。
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        await expectNoHiddenVertexOnSelectTool(page, faceId);
      } finally {
        await app.close();
      }
    });
  }

  test('頂点の右クリックの「所属をまとめて変える」から「選択」へ。印は残る', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, corner } = await twoFacesWithGrabbedCorner(page);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId(`ledger-mark-${faceId}`).check();
      expect(await selectedVertexIds(page)).toHaveLength(1);
      await page.mouse.click(corner[0], corner[1], { button: 'right' });
      await page.getByTestId('context-menu').locator('[data-item-kind="reparentMarked"]').click();
      await expect(page.getByTestId('tool-edit.reparent')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('ledger-marked-count')).toBeVisible();
      await page.getByTestId('tool-edit.select').click();
      expect(await selectedVertexIds(page)).toEqual([]);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect(page.getByTestId('ledger-marked-count')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

test.describe('B114 の検証: 押している最中の入力', () => {
  test('何もないところを押したまま Delete で板が開くと、離しても板の裏の選択は外れない', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(face.cx, face.cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);

      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      await page.mouse.move(box.x + 20, box.y + 20);
      await page.mouse.down();
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      await page.mouse.up();
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);

      // 板を閉じても選択は残り、次の押下は素直に動く。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('delete-impact')).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
      await page.mouse.click(box.x + 20, box.y + 20);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
    } finally {
      await app.close();
    }
  });

  /** 面を選んで、地図の左上の隅（面から十分遠い何もないところ）へポインタを置く。 */
  async function selectFaceAndHoverEmpty(
    page: Page,
    tool: 'edit.select' | 'none',
  ): Promise<{ readonly faceId: string; readonly from: { readonly x: number; readonly y: number } }> {
    const face = await commitOneFace(page);
    if (tool === 'edit.select') {
      await page.getByTestId('tool-edit.select').click();
    } else {
      // 鍵を開けた直後は道具なし（押されて見えるのは「選択」だが、店の値は null）。
      await returnToViewMode(page);
      await leaveViewMode(page);
    }
    await expect(page.getByTestId('app-active-tool')).toHaveText(tool === 'none' ? '' : tool);
    await page.mouse.click(face.cx, face.cy);
    await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
    const box = (await page.getByTestId('map-input-layer').boundingBox())!;
    const from = { x: box.x + 20, y: box.y + 20 };
    await page.mouse.move(from.x, from.y);
    return { faceId: face.faceId, from };
  }

  for (const [name, open, opened] of [
    ['Delete の確認の板', 'Delete', 'delete-impact'],
    ['Ctrl+P の「どこへでも移動」', 'Control+p', 'jump-palette'],
  ] as const) {
    test(`何もないところを押したまま${name}を開いて閉じ、動かさず離しても選択は外れない`, async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, from } = await selectFaceAndHoverEmpty(page, 'edit.select');
        await page.mouse.down();
        await page.keyboard.press(open);
        await expect(page.getByTestId(opened)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId(opened)).toHaveCount(0);
        await page.mouse.up();
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

        // 次の押下は素直に動く。
        await page.mouse.click(from.x, from.y);
        await expect(page.getByTestId('app-active-feature')).toHaveText('');
      } finally {
        await app.close();
      }
    });
  }

  test('何もないところを押したまま板を開いて閉じたあと動かしても、地図は動かない。次の押下は動かせる', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, from } = await selectFaceAndHoverEmpty(page, 'edit.select');
      const before = await liveCamera(page);
      await page.mouse.down();
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('delete-impact')).toHaveCount(0);
      await page.mouse.move(from.x + 150, from.y + 100, { steps: 5 });
      expect(await liveCamera(page)).toEqual(before);
      await page.mouse.up();
      expect(await liveCamera(page)).toEqual(before);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 150, from.y + 100, { steps: 5 });
      await page.mouse.up();
      expect((await liveCamera(page)).centerLon).not.toBeCloseTo(before.centerLon, 3);
    } finally {
      await app.close();
    }
  });

  for (const tool of ['none', 'edit.select'] as const) {
    test(`道具が ${tool} のとき、何もないところを押したまま U で測量へ入り、離しても動かしても元の押下は働かない`, async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, from } = await selectFaceAndHoverEmpty(page, tool);
        const before = await liveCamera(page);
        await page.mouse.down();
        await page.keyboard.press('u');
        await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
        await page.mouse.up();
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        // 測量の点も打たれない（押したのは測量へ入る前）。
        await expect(page.getByTestId('app-focus-owner')).toHaveText('map');

        await page.keyboard.press('u');
        await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'false');
        // 測量へ入ると道具は外れるので、明示の「選択」は構え直して同じ形にする。
        if (tool === 'edit.select') await page.getByTestId('tool-edit.select').click();
        await expect(page.getByTestId('app-active-tool')).toHaveText(tool === 'none' ? '' : tool);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.keyboard.press('u');
        await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
        await page.mouse.move(from.x + 150, from.y + 100, { steps: 5 });
        expect(await liveCamera(page)).toEqual(before);
        await page.mouse.up();
        expect(await liveCamera(page)).toEqual(before);
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      } finally {
        await app.close();
      }
    });
  }

  test('測量の左ドラッグで地図を動かしている途中に U で切ると、そこで移動が止まる', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, from } = await selectFaceAndHoverEmpty(page, 'none');
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.down();
      await page.mouse.move(from.x + 60, from.y + 40, { steps: 3 });
      const panned = await liveCamera(page);
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'false');
      await page.mouse.move(from.x + 200, from.y + 120, { steps: 3 });
      expect(await liveCamera(page)).toEqual(panned);
      await page.mouse.up();
      expect(await liveCamera(page)).toEqual(panned);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    } finally {
      await app.close();
    }
  });

  /** 押す → 動かす → ホイール → 動かす。ホイールの倍率が戻らないことを見る。 */
  async function wheelWhilePanning(page: Page): Promise<void> {
    const box = (await page.getByTestId('map-input-layer').boundingBox())!;
    const from = { x: box.x + 20, y: box.y + 20 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 3 });
    const beforeWheel = await liveCamera(page);
    await page.mouse.wheel(0, -240);
    await expect.poll(async () => (await liveCamera(page)).zoom).toBeGreaterThan(beforeWheel.zoom);
    const afterWheel = await liveCamera(page);
    await page.mouse.move(from.x + 80, from.y + 30, { steps: 3 });
    const moved = await liveCamera(page);
    expect(moved.zoom).toBe(afterWheel.zoom);
    // 指を右へ 40px 動かした分だけ、ホイールのあとの倍率で中心が動く。
    expect(moved.centerLon).toBeCloseTo(afterWheel.centerLon - 40 / afterWheel.zoom, 3);
    await page.mouse.up();
    expect((await liveCamera(page)).zoom).toBe(afterWheel.zoom);
  }

  test('「選択」で地図を動かしている最中のホイールが、次の移動で元の倍率へ戻らない', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await wheelWhilePanning(page);
    } finally {
      await app.close();
    }
  });

  test('読むだけで地図を動かしている最中のホイールも同じ', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await returnToViewMode(page);
      await wheelWhilePanning(page);
    } finally {
      await app.close();
    }
  });
});

test.describe('B114 の検証: 「選択」で選べるもの', () => {
  test('集約地物の下位領域（合成データ）: 深さ 0 では集約地物、深さを上げると子が選べ、頂点には当たらない', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, 6, [1000, 1200]);
      await jumpToYear(page, 1000);
      await leaveViewMode(page);
      await page.getByTestId('tool-edit.select').click();

      const childId = 'syn-nest-child-2';
      const vertices = [...(await committedVertices(page, childId)).values()];
      expect(vertices).toHaveLength(4);
      const center = {
        lon: vertices.reduce((a, p) => a + p.lon, 0) / 4,
        lat: vertices.reduce((a, p) => a + p.lat, 0) / 4,
      };

      const at = await worldToClient(page, center);
      await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText(SYNTHETIC_NEST_PARENT_ID);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      await openDepthOptions(page);
      await page.getByTestId('global-depth-slider').fill('1');
      await expect(page.getByTestId('global-depth-readout')).toContainText('1');
      await page.keyboard.press('Escape');
      const atExpanded = await worldToClient(page, center);
      await page.mouse.click(atExpanded.x, atExpanded.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText(childId);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('穴の中の飛び地: 飛び地は面として選べ、穴は何もないところとして扱う', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await leaveViewMode(page);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const half = 160;
      const faceId = await commitSquareFace(page, cx, cy, half);
      const ringOn = async (tx: number, ty: number, r: number): Promise<void> => {
        await page.getByTestId('tool-edit.ring').click();
        await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
        await page.mouse.click(tx, ty);
        await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute('data-flow', 'drafting');
        for (const [x, y] of [
          [cx - r, cy - r],
          [cx + r, cy - r],
          [cx + r, cy + r],
          [cx - r, cy + r],
        ] as const) {
          await page.mouse.click(x, y);
        }
        await page.getByTestId('ring-edit-confirm').click();
        await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
        await page.getByTestId('tool-edit.select').click();
      };
      // 面の中へ大きな穴、その穴の中へ小さな飛び地（対象は穴の外の面の部分を押して選ぶ）。
      await ringOn(cx - half + 20, cy, 100);
      await expect.poll(async () => (await committedVertices(page, faceId)).size).toBe(8);
      await ringOn(cx - half + 20, cy, 30);
      await expect.poll(async () => (await committedVertices(page, faceId)).size).toBe(12);

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      // 飛び地の真ん中。
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      // 飛び地と穴のふちのあいだは、面の外。
      await page.mouse.click(cx + 65, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      // 飛び地の内側の隅の近く（「頂点」なら頂点に当たる距離）でも、頂点は選ばれず面が選ばれる。
      await page.mouse.click(cx + 26, cy + 26);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
    } finally {
      await app.close();
    }
  });

  test('-360 の側の写しも +360 の側の写しも選べる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      const vertices = [...(await committedVertices(page, face.faceId)).values()];
      const center = {
        lon: vertices.reduce((a, p) => a + p.lon, 0) / vertices.length,
        lat: vertices.reduce((a, p) => a + p.lat, 0) / vertices.length,
      };
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;

      for (const turn of [-360, 360]) {
        // 写しが地図に入るまで、上の端（面に当たらない所）から地図を動かす（「選択」の左ドラッグ）。
        const margin = box.width * 0.25;
        for (let i = 0; i < 12; i += 1) {
          const now = await worldToClient(page, { lon: center.lon + turn, lat: center.lat });
          if (now.x > box.x + margin && now.x < box.x + box.width - margin) break;
          const dx = now.x < box.x + margin ? 200 : -200;
          const from = { x: box.x + box.width / 2, y: box.y + 8 };
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(from.x + dx, from.y, { steps: 3 });
          await page.mouse.up();
        }
        const at = await worldToClient(page, { lon: center.lon + turn, lat: center.lat });
        expect(at.x).toBeGreaterThan(box.x + margin);
        expect(at.x).toBeLessThan(box.x + box.width - margin);
        // 地図を動かしたあと、本物の位置が地図の外（写しを押している）ことも確かめる。
        const real = await worldToClient(page, center);
        expect(Math.abs(real.x - at.x)).toBeGreaterThan(100);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('app-active-feature')).toHaveText('');
        await page.mouse.click(at.x, at.y);
        await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
        await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      }
    } finally {
      await app.close();
    }
  });
});
