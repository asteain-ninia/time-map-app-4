// B102 — 吸着の半径は設定の px と地図上の上限の度数の小さいほうで、吸着している間の下書きは
// 吸着先に乗る。半径は窓の大きさと倍率で変わるので、jsdom では測れない（§5.49）。
//
// 見ること:
//   - 動作保証の下限・普段・上限の 3 つの窓の全体図と、拡大した表示で、半径のすぐ内側では吸着して
//     共有になり、すぐ外側では吸着せず手元に置かれる。
//   - 離す前の頂点の印が、確定後の頂点の座標と同じ。
//   - 実データの全体図で、アルラーク国の頂点を内へ 6px 引いたときも、飛ぶ先が離す前に見える。
//
// 実データの置き場は `e2e/knife-v10-real.spec.ts` と同じ。正本は開かず、一時ディレクトリへ複写して開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';

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
  vertexHandlePositions,
  worldToClient,
  type ScreenPoint,
} from './helpers';
import { RING_BREAK_PHRASE_TEXT } from '../src/ui/strings';

interface World {
  readonly lon: number;
  readonly lat: number;
}

/** 設定の既定の吸着距離と、地図上の上限の度数（`src/domain/editing/snap.ts`）。わざと写す。 */
const SNAP_PX = 50;
const CAP_DEGREES = 7.3;

const expectedRadius = (zoom: number): number => Math.min(SNAP_PX, CAP_DEGREES * zoom);

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);
}

/** 描画を 2 コマ進める（下書きの印は描いたコマから読む）。 */
async function twoFrames(page: Page): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  }
}

async function fitAll(page: Page): Promise<void> {
  await page.getByTestId('map-fit-all').click();
  await twoFrames(page);
}

async function screenToWorld(page: Page, x: number, y: number): Promise<World> {
  return page.evaluate(
    ([a, b]) => {
      const w = window as unknown as {
        __E2E__: { screenToWorld: (x: number, y: number) => World | null };
      };
      return w.__E2E__.screenToWorld(a!, b!)!;
    },
    [x, y] as const,
  );
}

interface Pair {
  /** 掴む面。 */
  readonly aId: string;
  /** 吸着先の面。 */
  readonly dId: string;
  /** 掴む頂点の世界の座標。 */
  readonly grab: World;
  /** 吸着先の頂点の世界の座標。 */
  readonly target: World;
  /** 掴む面の内側の世界の座標。 */
  readonly inside: World;
}

function nearestTo(vertices: ReadonlyMap<string, World>, at: World): World {
  return [...vertices.values()].sort(
    (p, q) => Math.hypot(p.lon - at.lon, p.lat - at.lat) - Math.hypot(q.lon - at.lon, q.lat - at.lat),
  )[0]!;
}

/**
 * 世界全体の視点（地物が無いときの全体表示）で A と D を描く。地物を置いたあとの全体表示は
 * 地物の範囲（継ぎ目をまたぐ最短の弧）に寄るので、世界全体が入る倍率は実データの検査で測る。
 */
async function setUpOverview(page: Page): Promise<Pair> {
  await jumpToYear(page, 1200);
  await fitAll(page); // 地物が無いので世界全体の視点になる。
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const square = (x: number, y: number): ScreenPoint[] => [
    [x - 30, y - 30],
    [x + 30, y - 30],
    [x + 30, y + 30],
    [x - 30, y + 30],
  ];
  const aCorners = square(cx - 80, cy);
  const dCorners = square(cx + 80, cy);
  const aId = await drawFace(page, aCorners, { name: 'A' });
  await armAddAreaTool(page);
  const dId = await drawFace(page, dCorners, { name: 'D' });
  const [ax, ay] = aCorners[1]!;
  const [dx, dy] = dCorners[0]!;
  return {
    aId,
    dId,
    grab: nearestTo(await committedVertices(page, aId), await screenToWorld(page, ax, ay)),
    target: nearestTo(await committedVertices(page, dId), await screenToWorld(page, dx, dy)),
    inside: await screenToWorld(page, cx - 80, cy),
  };
}

async function selectVertexTool(page: Page, id: string, inside: World): Promise<void> {
  await enterEditMode(page);
  await page.getByTestId('tool-edit.select').click();
  await page.keyboard.press('Escape');
  const c = await worldToClient(page, inside);
  await page.mouse.click(c.x, c.y);
  await expect(page.getByTestId('app-active-feature')).toHaveText(id);
  await page.getByTestId('tool-edit.vertex').click();
  await expect(page.getByTestId('tool-edit.vertex')).toHaveAttribute('aria-pressed', 'true');
}

/** (sx, sy) を押して (tx, ty) まで引き、離さずに止める。 */
async function dragAndHold(page: Page, sx: number, sy: number, tx: number, ty: number): Promise<void> {
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8);
  }
  await twoFrames(page);
}

const near = (a: World, b: World, eps = 1e-6): boolean =>
  Math.abs(a.lon - b.lon) <= eps && Math.abs(a.lat - b.lat) <= eps;

/** 掴む頂点を、吸着先の頂点から画面で gapPx 手前まで引いて離す。離す前の印と手元の座標を返す。 */
async function dragToGap(
  page: Page,
  pair: Pair,
  gapPx: number,
): Promise<{ readonly heldHandles: readonly World[]; readonly cursor: World }> {
  const from = await worldToClient(page, pair.grab);
  const to = await worldToClient(page, pair.target);
  const tx = to.x - gapPx;
  const ty = to.y;
  await dragAndHold(page, from.x, from.y, tx, ty);
  const heldHandles = await vertexHandlePositions(page);
  const cursor = await screenToWorld(page, tx, ty);
  await page.mouse.up();
  return { heldHandles, cursor };
}

/** 半径のすぐ内側で吸着して共有になり、すぐ外側では吸着しないことを、いまの倍率で確かめる。 */
async function expectRadiusBoundary(page: Page, pair: Pair): Promise<number> {
  const zoom = (await liveCamera(page)).zoom;
  const radius = expectedRadius(zoom);
  await selectVertexTool(page, pair.aId, pair.inside);
  await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
  const targetIds = new Set((await committedVertices(page, pair.dId)).keys());
  const original = await committedVertices(page, pair.aId);
  const sharedIds = async (): Promise<string[]> =>
    [...(await committedVertices(page, pair.aId)).keys()].filter((id) => targetIds.has(id));

  // すぐ内側: 離す前から吸着先に乗り、離すと吸着先の頂点を共有する。
  const inside = await dragToGap(page, pair, radius - 2);
  expect(
    inside.heldHandles.some((h) => near(h, pair.target)),
    `倍率 ${String(zoom)}・半径 ${String(radius)}px: 離す前の印が吸着先に乗る`,
  ).toBe(true);
  await expect.poll(sharedIds).toHaveLength(1);
  const landed = (await committedVertices(page, pair.aId)).get((await sharedIds())[0]!)!;
  expect(near(landed, pair.target), '確定は離す前に見えていた吸着先と同じ').toBe(true);
  await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => committedVertices(page, pair.aId)).toEqual(original);

  // すぐ外側: 手元に置かれ、共有にならない。
  const outside = await dragToGap(page, pair, radius + 3);
  expect(
    outside.heldHandles.some((h) => near(h, outside.cursor, 1 / zoom)),
    `倍率 ${String(zoom)}・半径 ${String(radius)}px: 外側では離す前の印は手元のまま`,
  ).toBe(true);
  await expect
    .poll(async () =>
      [...(await committedVertices(page, pair.aId)).values()].some((v) => near(v, outside.cursor, 1 / zoom)),
    )
    .toBe(true);
  expect(await sharedIds()).toHaveLength(0);
  await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => committedVertices(page, pair.aId)).toEqual(original);
  return radius;
}

for (const [width, height] of [
  [800, 600],
  [1280, 800],
  [3840, 2160],
] as const) {
  test(`${String(width)}×${String(height)} の全体図で、半径の内側は吸着し、外側は吸着しない`, async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await resizeWindow(app, page, width, height);
      const pair = await setUpOverview(page);
      const radius = await expectRadiusBoundary(page, pair);
      const zoom = (await liveCamera(page)).zoom;
      console.log(
        `[B102] ${String(width)}×${String(height)} 全体図: ${zoom.toFixed(3)} px/度、半径 ${radius.toFixed(1)}px`,
      );
      // 保証の上限の窓では 50px のまま、それより小さい窓では狭まる。
      if (width === 3840) expect(radius).toBe(SNAP_PX);
      else expect(radius).toBeLessThan(SNAP_PX);
    } finally {
      await app.close();
    }
  });
}

test('拡大した表示では小さな窓でも設定の 50px のまま効く', async () => {
  test.setTimeout(180_000);
  const { app, page } = await launchApp();
  try {
    const pair = await setUpOverview(page);
    const mid = await worldToClient(page, pair.grab);
    await page.mouse.move(mid.x + 40, mid.y);
    for (let i = 0; i < 40 && (await liveCamera(page)).zoom < 8; i += 1) {
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(50);
    }
    const zoom = (await liveCamera(page)).zoom;
    expect(zoom).toBeGreaterThanOrEqual(8);
    // 寄った結果、使う点が全部地図の中にあることを前提にする。
    const box = (await page.getByTestId('map-input-layer').boundingBox())!;
    for (const w of [pair.grab, pair.target, pair.inside]) {
      const c = await worldToClient(page, w);
      expect(c.x).toBeGreaterThan(box.x);
      expect(c.x).toBeLessThan(box.x + box.width);
      expect(c.y).toBeGreaterThan(box.y);
      expect(c.y).toBeLessThan(box.y + box.height);
    }
    expect(await expectRadiusBoundary(page, pair)).toBe(SNAP_PX);
    console.log(`[B102] 1280×800 拡大: ${zoom.toFixed(3)} px/度、半径 ${String(SNAP_PX)}px`);
  } finally {
    await app.close();
  }
});

test.describe('B102 — 実データのコピーで', () => {
  test.skip(!existsSync(canonicalPath), `実データ ${REAL_DATA_FILE} が無い`);

  // 全体表示の倍率の実測（世界全体が入る実データ）は上限の度数の根拠なので、ここで固定する。
  // 1280×800 の起動直後の 2.53 px/度では、引いた先から 7.8px（3.08 度）に島の頂点があるので、
  // 上限の内側で吸着して飛び、重なりの板が出る（現状.md の B102 の残り）。ここで固定するのは、
  // どの窓でも飛ぶ距離が上限の内側に収まることと、離す前に見えていた場所へ確定することである。
  for (const [width, height, fit, zoomAtView] of [
    [1280, 800, false, 2.533],
    [3840, 2160, true, 6.889],
  ] as const) {
    test(`${String(width)}×${String(height)} でアルラーク国の頂点を内へ 6px 引くと、飛ぶ先が下書きに見え、上限の内側に収まる`, async () => {
      test.setTimeout(180_000);
      const dir = mkdtempSync(join(tmpdir(), 'gimoza-b102-'));
      const copy = join(dir, REAL_DATA_FILE);
      copyFileSync(canonicalPath, copy);
      const { app, page } = await launchAppWithProject(copy);
      try {
        await resizeWindow(app, page, width, height);
        await jumpToYear(page, 3000);
        if (fit) await fitAll(page);
        const viewZoom = (await liveCamera(page)).zoom;
        expect(viewZoom).toBeCloseTo(zoomAtView, 2);
        if (width === 3840) expect(expectedRadius(viewZoom), '保証の上限の窓の全体表示').toBe(SNAP_PX);
        const report = (await leafReport(page, { names: ['アルラーク国'] })).entries[0]!;
        const inner: World = { lon: 96.6, lat: 57.37 };
        await selectVertexTool(page, report.id, inner);
        await expect.poll(async () => (await vertexHandlePositions(page)).length).toBeGreaterThan(3);
        const handles = await vertexHandlePositions(page);
        const grabbed = nearestTo(new Map(handles.map((h, i) => [String(i), h])), inner);
        const from = await worldToClient(page, grabbed);
        const toward = await worldToClient(page, inner);
        const d = Math.hypot(toward.x - from.x, toward.y - from.y);
        const tx = from.x + ((toward.x - from.x) / d) * 6;
        const ty = from.y + ((toward.y - from.y) / d) * 6;
        const before = new Set(handles.map((h) => `${String(h.lon)},${String(h.lat)}`));
        await dragAndHold(page, from.x, from.y, tx, ty);
        const heldNew = (await vertexHandlePositions(page)).filter(
          (h) => !before.has(`${String(h.lon)},${String(h.lat)}`),
        );
        expect(heldNew, '離す前に動いた頂点は 1 つ').toHaveLength(1);
        const held = heldNew[0]!;
        const moved = Math.hypot(held.lon - grabbed.lon, held.lat - grabbed.lat);
        const zoom = (await liveCamera(page)).zoom;
        console.log(
          `[B102] 実データ ${String(width)}×${String(height)}: ${zoom.toFixed(3)} px/度、下書きは ${moved.toFixed(3)} 度動いた`,
        );
        expect(moved).toBeLessThanOrEqual(CAP_DEGREES + 6 / zoom);
        await page.mouse.up();
        // 確定に進んだら、離す前に見えていた場所と同じ。板で止まるか、輪郭が交わるので断ったら形は元のまま。
        const dialog = page.getByTestId('conflict-dialog');
        const refused = page.getByTestId('statusbar-result').filter({ hasText: RING_BREAK_PHRASE_TEXT.selfCross });
        await expect
          .poll(
            async () => {
              if ((await dialog.count()) > 0) return 'paused';
              if ((await refused.count()) > 0) return 'refused';
              const now = await committedVertices(page, report.id);
              return [...now.values()].some((v) => near(v, held)) ? 'landed' : 'waiting';
            },
            { timeout: 60_000 },
          )
          .not.toBe('waiting');
        console.log(
          `[B102] 実データ ${String(width)}×${String(height)}: 板 ${String(await dialog.count())} 枚`,
        );
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
