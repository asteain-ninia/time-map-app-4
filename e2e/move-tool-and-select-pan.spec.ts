// 所有者の裁定（2026-11-01）:
//   1. ［動かす］の道具は地物だけを動かす。頂点の印を描かず、頂点・辺に当たらない。
//   2. 「選択」で面の内側からのドラッグは地図の移動にする（読むだけと同じ）。動かさず離せば選ぶ。
//
// 実データは全体図 1 px/度のアルラーク国（小さな国の内側は全部が頂点から 8px 以内）。直す前の［動かす］は
// 押すと候補一覧が出て、国を動かせなかった。正本は開かない（コピーを開く。§5.48）。

import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import { SYNTHETIC_NEST_PARENT_ID } from '../src/ui/e2e/synthetic-project';
import { APP_STRINGS } from '../src/ui/shell/strings';
import { RING_BREAK_PHRASE_TEXT } from '../src/ui/strings';
import {
  addInputLayerBox,
  armVertexTool,
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
  placeVertices,
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

/** 押して何度かに分けて引き、離す。 */
async function drag(
  page: Page,
  from: { readonly x: number; readonly y: number },
  dx: number,
  dy: number,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
}

async function armMoveTool(page: Page): Promise<void> {
  await page.getByTestId('tool-edit.move').click();
  await expect(page.getByTestId('tool-edit.move')).toHaveAttribute('aria-pressed', 'true');
}

/** 地物の全部の頂点が同じだけ動いたことを見て、動いた量を返す（1 頂点でも取り残されれば落ちる）。 */
function expectRigidMove(
  before: ReadonlyMap<string, { readonly lon: number; readonly lat: number }>,
  after: ReadonlyMap<string, { readonly lon: number; readonly lat: number }>,
): { readonly dLon: number; readonly dLat: number } {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  const [first] = [...before.keys()];
  const dLon = after.get(first!)!.lon - before.get(first!)!.lon;
  const dLat = after.get(first!)!.lat - before.get(first!)!.lat;
  for (const [id, p] of before) {
    expect(after.get(id)!.lon - p.lon).toBeCloseTo(dLon, 6);
    expect(after.get(id)!.lat - p.lat).toBeCloseTo(dLat, 6);
  }
  expect(Math.abs(dLon) + Math.abs(dLat)).toBeGreaterThan(0);
  return { dLon, dLat };
}

test.describe('裁定 2026-11-01: ［動かす］は地物だけを動かす', () => {
  test('頂点の印を描かない（対照: 「頂点」では 4 個出る）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await armVertexTool(page);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      await armMoveTool(page);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('隅のすぐ内側から引くと、頂点 1 つではなく面全体が動く。Ctrl+Z 1 回で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const before = await committedVertices(page, face.faceId);
      const cam = await liveCamera(page);
      await armMoveTool(page);
      const [cornerX, cornerY] = face.corners[0]!;
      // 左上の隅（`squareCorners` の先頭）の 3px 内側。頂点の掴める距離の中。
      await drag(page, { x: cornerX + 3, y: cornerY + 3 }, 30, 20);
      await expect
        .poll(async () => (await committedVertices(page, face.faceId)).size === before.size)
        .toBe(true);
      await expect.poll(async () => committedVertices(page, face.faceId)).not.toEqual(before);
      expectRigidMove(before, await committedVertices(page, face.faceId));
      expect(await selectedVertexIds(page)).toEqual([]);
      expect((await liveCamera(page)).centerLon, '地図は動かない').toBe(cam.centerLon);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);

      await page.keyboard.press('Control+z');
      await expect.poll(async () => committedVertices(page, face.faceId)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test('辺の中点のすぐ内側を押しても頂点が足されない。引くと面全体が動く', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const before = await committedVertices(page, face.faceId);
      await armMoveTool(page);
      const [ax, ay] = face.corners[0]!;
      const [bx, by] = face.corners[1]!;
      // 辺の中点から面の中心へ 3px 寄せた点。辺の足し口の掴める距離の中。
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const len = Math.hypot(face.cx - mx, face.cy - my);
      const inner = {
        x: mx + ((face.cx - mx) / len) * 3,
        y: my + ((face.cy - my) / len) * 3,
      };
      await page.mouse.click(inner.x, inner.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
      expect(await committedVertices(page, face.faceId)).toEqual(before);

      await drag(page, inner, 30, 20);
      await expect.poll(async () => committedVertices(page, face.faceId)).not.toEqual(before);
      expectRigidMove(before, await committedVertices(page, face.faceId));
    } finally {
      await app.close();
    }
  });

  test('何もないところからのドラッグは地図を動かし、囲まない。動かさず離せば選択が外れる', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const before = await committedVertices(page, face.faceId);
      await armMoveTool(page);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const from = { x: box.x + 20, y: box.y + 20 };
      const cam = await liveCamera(page);
      // 四角全体を囲む向きへ引く（囲めるなら 4 頂点が選ばれる）。
      await drag(page, from, 300, 300);
      const moved = await liveCamera(page);
      expect(moved.centerLon).not.toBeCloseTo(cam.centerLon, 3);
      expect(moved.centerLat).not.toBeCloseTo(cam.centerLat, 3);
      expect(await selectedVertexIds(page)).toEqual([]);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
      expect(await committedVertices(page, face.faceId)).toEqual(before);

      await page.mouse.click(from.x, from.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
    } finally {
      await app.close();
    }
  });

  test('選択されていない面の上は、押せばその面を選び、引いても動かない（2 手を保つ）', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const before = await committedVertices(page, face.faceId);
      await armMoveTool(page);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      const cam = await liveCamera(page);

      await drag(page, { x: face.cx, y: face.cy }, 40, 30);
      expect(await committedVertices(page, face.faceId)).toEqual(before);
      expect(await liveCamera(page)).toEqual(cam);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      await page.mouse.click(face.cx, face.cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
      await drag(page, { x: face.cx, y: face.cy }, 40, 30);
      await expect.poll(async () => committedVertices(page, face.faceId)).not.toEqual(before);
      expectRigidMove(before, await committedVertices(page, face.faceId));
    } finally {
      await app.close();
    }
  });

  test('右クリックのメニューに頂点の項目を出さない（対照: 「頂点」では出る）', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const [cornerX, cornerY] = face.corners[0]!;
      const menu = page.getByTestId('context-menu');
      const deleteVertex = menu.locator('[data-item-kind="deleteVertex"]');

      await armVertexTool(page);
      await page.mouse.click(cornerX, cornerY, { button: 'right' });
      await expect(deleteVertex).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      await armMoveTool(page);
      await page.mouse.click(cornerX + 3, cornerY + 3, { button: 'right' });
      await expect(menu).toBeVisible();
      await expect(menu.locator('[data-item-kind="delete"]')).toBeVisible();
      await expect(deleteVertex).toHaveCount(0);
      expect(await selectedVertexIds(page)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('頂点を選んで［動かす］へ持ち替えると頂点の選択は消え、Delete は地物の確認を出す', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const [cornerX, cornerY] = face.corners[0]!;
      await armVertexTool(page);
      await page.mouse.click(cornerX, cornerY);
      expect(await selectedVertexIds(page)).toHaveLength(1);

      await armMoveTool(page);
      expect(await selectedVertexIds(page)).toEqual([]);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      await expect(page.getByTestId('vertex-delete-impact')).toHaveCount(0);
      await page.keyboard.press('Escape');
    } finally {
      await app.close();
    }
  });

  test('引いている間は下書きが出て確定はまだ動かず、印は出ない。Escape で元の位置へ戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const face = await commitOneFace(page);
      const before = await committedVertices(page, face.faceId);
      await armMoveTool(page);
      const counts = (): Promise<{ readonly line: number; readonly hasLivePreview: boolean }> =>
        page.evaluate(() =>
          (
            window as unknown as {
              __E2E__: { getPrimitiveCounts: () => { line: number; hasLivePreview: boolean } };
            }
          ).__E2E__.getPrimitiveCounts(),
        );
      const linesBefore = (await counts()).line;
      await page.mouse.move(face.cx, face.cy);
      await page.mouse.down();
      await page.mouse.move(face.cx + 40, face.cy + 30, { steps: 4 });
      await expect.poll(async () => (await counts()).hasLivePreview).toBe(true);
      // 輪郭が実際に描かれている（印の層を止めると消える。教訓 §5.112）。
      await expect.poll(async () => (await counts()).line).toBeGreaterThan(linesBefore);
      expect(await vertexHandlePositions(page)).toEqual([]);
      expect(await committedVertices(page, face.faceId)).toEqual(before);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      expect(await committedVertices(page, face.faceId)).toEqual(before);
      await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
    } finally {
      await app.close();
    }
  });

  test('線も点も、頂点の近くから引いて全体が動く', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await leaveViewMode(page);
      await page.getByTestId('tool-add.line').click();
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const lineFrom = { x: cx - 150, y: cy - 100 };
      await placeVertices(page, [
        [lineFrom.x, lineFrom.y],
        [cx + 150, cy - 100],
      ]);
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      const lineId = ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
      expect(lineId).not.toBe('');

      await page.getByTestId('tool-add.point').click();
      const pointAt = { x: cx, y: cy + 100 };
      await placeVertices(page, [[pointAt.x, pointAt.y]]);
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      const pointId = ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
      expect(pointId).not.toBe('');
      expect(pointId).not.toBe(lineId);

      await armMoveTool(page);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(0);

      // 点は選ばれたまま。点の上から引く。
      const pointBefore = await committedVertices(page, pointId);
      await drag(page, pointAt, 30, 20);
      await expect.poll(async () => committedVertices(page, pointId)).not.toEqual(pointBefore);
      expectRigidMove(pointBefore, await committedVertices(page, pointId));

      // 線は端の頂点の上を押して選び、そのまま端から引く。
      const lineBefore = await committedVertices(page, lineId);
      await page.mouse.click(lineFrom.x, lineFrom.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText(lineId);
      await drag(page, lineFrom, 30, 20);
      await expect.poll(async () => committedVertices(page, lineId)).not.toEqual(lineBefore);
      expectRigidMove(lineBefore, await committedVertices(page, lineId));
    } finally {
      await app.close();
    }
  });
});

test.describe('［動かす］と集約地物', () => {
  test('集約地物を引くと下位領域が動き、板は出ず、地図は動かず、選択は集約地物のまま', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, 6, [1000, 1200]);
      await jumpToYear(page, 1000);
      await leaveViewMode(page);
      const childId = 'syn-nest-child-2';
      const vertices = await committedVertices(page, childId);
      const list = [...vertices.values()];
      const center = {
        lon: list.reduce((a, p) => a + p.lon, 0) / list.length,
        lat: list.reduce((a, p) => a + p.lat, 0) / list.length,
      };
      const at = await worldToClient(page, center);
      await armMoveTool(page);
      await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText(SYNTHETIC_NEST_PARENT_ID);
      const stats = await projectStats(page);
      const cam = await liveCamera(page);
      const canUndo = await page.getByTestId('app-can-undo').textContent();

      await drag(page, at, 30, 20);
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      expectRigidMove(vertices, await committedVertices(page, childId));
      await expect(page.getByTestId('app-can-undo')).not.toHaveText(canUndo ?? '');
      // 押した年に錨があるので、地物も錨も増えない。
      expect(await projectStats(page)).toEqual(stats);
      expect(await liveCamera(page)).toEqual(cam);
      await expect(page.getByTestId('app-active-feature')).toHaveText(SYNTHETIC_NEST_PARENT_ID);
      await expect(page.getByTestId('statusbar-result')).toContainText(
        APP_STRINGS.moveAggregateDone(6, 0),
      );
    } finally {
      await app.close();
    }
  });
});

test.describe('隠したあと選んだままの地物', () => {
  test('選んでいるあいだは見えたまま描かれ（決定 B55）、選択を外すと消える', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { faceId, cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      const clip = { x: cx - 30, y: cy - 30, width: 25, height: 25 };
      const seen = async (): Promise<Buffer> => {
        await page.mouse.move(cx, cy - 400);
        await page.waitForTimeout(300);
        return page.screenshot({ clip });
      };
      const selected = await seen();

      await page.mouse.click(cx, cy, { button: 'right' });
      await page.getByTestId('context-menu').locator('[data-item-kind="hideFeature"]').click();
      await expect(page.getByTestId('context-menu')).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      expect((await seen()).equals(selected), '隠しても選んでいるあいだは同じ姿で描く').toBe(true);

      // 描かれているものを動かす。動いた先に形が見える。
      const before = await committedVertices(page, faceId);
      await armMoveTool(page);
      await drag(page, { x: cx, y: cy }, 30, 0);
      expect(await committedVertices(page, faceId)).not.toEqual(before);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      expect((await seen()).equals(selected), '動かしたあとも描かれている').toBe(true);

      // 選択を外すと、隠したとおり消える。
      await page.getByTestId('tool-edit.select').click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      expect((await seen()).equals(selected), '選択を外すと描かない').toBe(false);
    } finally {
      await app.close();
    }
  });
});

test.describe('裁定 2026-11-01: ［動かす］（実データの全体図）', () => {
  test.skip(!existsSync(canonicalPath), `実データが無い (${canonicalPath})`);

  test('小さな国の内側を押すと国が選ばれ、一覧は出ず、引くと国全体が動く形で確定の検査へ進む', async () => {
    test.setTimeout(180_000);
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-move-tool-'));
    const copy = join(dir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);
    const { app, page } = await launchAppWithProject(copy);
    try {
      await jumpToYear(page, 3000);
      await leaveViewMode(page);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 40; i += 1) {
        const now = (await liveCamera(page)).zoom;
        await page.mouse.wheel(0, 240);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
        if ((await liveCamera(page)).zoom === now) break;
      }
      expect((await liveCamera(page)).zoom, '実測の形は 1 px/度の全体図').toBeLessThanOrEqual(1.01);

      await armMoveTool(page);
      const report = (await leafReport(page, { names: ['アルラーク国'] })).entries[0]!;
      const at = await worldToClient(page, INSIDE_ALRUK);
      await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText(report.id);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      expect(await vertexHandlePositions(page)).toEqual([]);

      const before = await committedVertices(page, report.id);
      const cam = await liveCamera(page);
      // 隣と接している国なので、10px（10 度）ずらすと共有頂点を引かれた隣の輪郭が交わって断る
      // （確定の検査を通った証拠。FR-32）。
      await drag(page, at, 10, 0);
      await expect(page.getByTestId('statusbar-result')).toContainText(RING_BREAK_PHRASE_TEXT.selfCross);
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      expect(await committedVertices(page, report.id)).toEqual(before);
      expect(await liveCamera(page)).toEqual(cam);
    } finally {
      await app.close();
    }
  });
});

test.describe('裁定 2026-11-01: 「選択」の面の内側からのドラッグは地図の移動', () => {
  /** 面を確定し、道具を `tool` にして面を選んだ状態にする（`none` は鍵を開けた直後の道具なし）。 */
  async function selectedFace(page: Page, tool: 'edit.select' | 'none') {
    const face = await commitOneFace(page);
    if (tool === 'edit.select') {
      await page.getByTestId('tool-edit.select').click();
    } else {
      await returnToViewMode(page);
      await leaveViewMode(page);
    }
    await expect(page.getByTestId('app-active-tool')).toHaveText(tool === 'none' ? '' : tool);
    await page.mouse.click(face.cx, face.cy);
    await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
    return face;
  }

  for (const tool of ['edit.select', 'none'] as const) {
    test(`道具が ${tool}: 選択中の面の内側から引くと地図が動き、形も選択も変わらない`, async () => {
      const { app, page } = await launchApp();
      try {
        const face = await selectedFace(page, tool);
        const before = await committedVertices(page, face.faceId);
        const cam = await liveCamera(page);
        await drag(page, { x: face.cx, y: face.cy }, 60, 40);
        const moved = await liveCamera(page);
        expect(moved.centerLon).not.toBeCloseTo(cam.centerLon, 3);
        expect(moved.centerLat).not.toBeCloseTo(cam.centerLat, 3);
        expect(await committedVertices(page, face.faceId)).toEqual(before);
        await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
        expect(await selectedVertexIds(page)).toEqual([]);
      } finally {
        await app.close();
      }
    });

    test(`道具が ${tool}: 選んでいない面の内側から引くと地図だけが動き、動かさず離せばその面を選ぶ`, async () => {
      const { app, page } = await launchApp();
      try {
        const face = await selectedFace(page, tool);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('app-active-feature')).toHaveText('');
        const cam = await liveCamera(page);
        await drag(page, { x: face.cx, y: face.cy }, 60, 0);
        expect((await liveCamera(page)).centerLon).not.toBeCloseTo(cam.centerLon, 3);
        await expect(page.getByTestId('app-active-feature')).toHaveText('');

        const at = await liveCamera(page);
        const centerNow = { x: face.cx + 60, y: face.cy };
        await page.mouse.click(centerNow.x, centerNow.y);
        await expect(page.getByTestId('app-active-feature')).toHaveText(face.faceId);
        expect(await liveCamera(page)).toEqual(at);
      } finally {
        await app.close();
      }
    });
  }

  /** 左の面（選ぶ）と右の面（押し続ける）を作り、左を選んだ状態にする。 */
  async function twoFaces(page: Page) {
    await leaveViewMode(page);
    const box = (await page.getByTestId('map-input-layer').boundingBox())!;
    const lx = box.x + box.width * 0.3;
    const rx = box.x + box.width * 0.7;
    const cy = box.y + box.height * 0.5;
    const left = await commitSquareFace(page, lx, cy, 50);
    const right = await commitSquareFace(page, rx, cy, 50);
    await page.getByTestId('tool-edit.select').click();
    await page.mouse.click(lx, cy);
    await expect(page.getByTestId('app-active-feature')).toHaveText(left);
    return { left, right, rx, cy };
  }

  for (const [name, open, opened] of [
    ['Delete の確認の板', 'Delete', 'delete-impact'],
    ['Ctrl+P の「どこへでも移動」', 'Control+p', 'jump-palette'],
  ] as const) {
    test(`面の内側を押したまま${name}を開いて閉じると、その押下は働かない。次の押下は動く`, async () => {
      const { app, page } = await launchApp();
      try {
        const { left, rx, cy } = await twoFaces(page);
        const cam = await liveCamera(page);
        await page.mouse.move(rx, cy);
        await page.mouse.down();
        await page.keyboard.press(open);
        await expect(page.getByTestId(opened)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId(opened)).toHaveCount(0);
        await page.mouse.move(rx + 80, cy + 30, { steps: 4 });
        expect(await liveCamera(page)).toEqual(cam);
        await page.mouse.up();
        expect(await liveCamera(page)).toEqual(cam);
        await expect(page.getByTestId('app-active-feature')).toHaveText(left);

        await drag(page, { x: rx, y: cy }, 80, 30);
        expect((await liveCamera(page)).centerLon).not.toBeCloseTo(cam.centerLon, 3);
      } finally {
        await app.close();
      }
    });
  }

  test('面の内側を押したまま Shift+F で面の道具へ替えると、その押下は働かない', async () => {
    const { app, page } = await launchApp();
    try {
      const { left, rx, cy } = await twoFaces(page);
      const cam = await liveCamera(page);
      await page.mouse.move(rx, cy);
      await page.mouse.down();
      await page.keyboard.press('Shift+F');
      await expect(page.getByTestId('tool-add.area')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.move(rx + 80, cy + 30, { steps: 4 });
      expect(await liveCamera(page)).toEqual(cam);
      await page.mouse.up();
      expect(await liveCamera(page)).toEqual(cam);
      await expect(page.getByTestId('app-active-feature')).toHaveText(left);
    } finally {
      await app.close();
    }
  });

  test('面の内側を押したまま U で測量へ入ると、その押下は働かない', async () => {
    const { app, page } = await launchApp();
    try {
      const { left, rx, cy } = await twoFaces(page);
      const cam = await liveCamera(page);
      await page.mouse.move(rx, cy);
      await page.mouse.down();
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.move(rx + 80, cy + 30, { steps: 4 });
      expect(await liveCamera(page)).toEqual(cam);
      await page.mouse.up();
      expect(await liveCamera(page)).toEqual(cam);
      await expect(page.getByTestId('app-active-feature')).toHaveText(left);
    } finally {
      await app.close();
    }
  });
});
