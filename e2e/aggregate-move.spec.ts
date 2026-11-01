// ［動かす］で集約地物を引くと、下の州をまとめて動かす。共有頂点は不動（所有者の裁定 2026-11-01）。
//
// 合成データは `buildSyntheticAggregateMoveProject`: 州どうしが頂点を共有し、州 C は隣の国と、州 A は
// 線情報と頂点を共有する。州 C だけ自分の系列を持つので、記録の置き場の両方の形を通る。

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SYNTHETIC_MOVE_IDS as IDS } from '../src/ui/e2e/synthetic-project';
import { APP_STRINGS } from '../src/ui/shell/strings';
import { RING_BREAK_PHRASE_TEXT } from '../src/ui/strings';
import {
  committedVertices,
  jumpToYear,
  launchApp,
  leaveViewMode,
  loadProject,
  loadSyntheticAggregateMove,
  openDepthOptions,
  projectStats,
  worldToClient,
  type WorldPos,
} from './helpers';

const STATUS = 'statusbar-result';

/** 全部の地物の頂点を読む（いま見ている年）。 */
const ALL_FEATURES = [
  IDS.stateA,
  IDS.stateB,
  IDS.stateC,
  IDS.stateD,
  IDS.neighbour,
  IDS.road,
  IDS.sealedState,
  IDS.sealedRoad,
] as const;

type Shapes = Record<string, Record<string, WorldPos>>;

async function shapes(page: Page): Promise<Shapes> {
  const out: Shapes = {};
  for (const id of ALL_FEATURES) out[id] = Object.fromEntries(await committedVertices(page, id));
  return out;
}

/** 州 B の帯の中央（地方・連邦のどの深さでも、この点の下に面がある）。 */
const INSIDE_B: WorldPos = { lon: -10, lat: 10 };
const INSIDE_SEALED: WorldPos = { lon: 47, lat: 37 };

/** 世界の量で `dLon`・`dLat` だけ引くのに要る画面の量。 */
async function pullBy(
  page: Page,
  from: WorldPos,
  dLon: number,
  dLat: number,
): Promise<{ readonly at: { x: number; y: number }; readonly to: { x: number; y: number } }> {
  return {
    at: await worldToClient(page, from),
    to: await worldToClient(page, { lon: from.lon + dLon, lat: from.lat + dLat }),
  };
}

async function drag(page: Page, from: WorldPos, dLon: number, dLat: number): Promise<void> {
  const { at, to } = await pullBy(page, from, dLon, dLat);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

/** ［動かす］を構え、その点の面を選ぶ。 */
async function armAndSelect(page: Page, point: WorldPos, expected: string): Promise<void> {
  const tool = page.getByTestId('tool-edit.move');
  if ((await tool.getAttribute('aria-pressed')) !== 'true') await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  const at = await worldToClient(page, point);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('app-active-feature')).toHaveText(expected);
}

async function ready(page: Page, year: number): Promise<void> {
  await loadSyntheticAggregateMove(page);
  await jumpToYear(page, year);
  await leaveViewMode(page);
}

/** 頂点ごとに動いた量を読み、動いた頂点の id（並べ替え済み）と量を返す。 */
function movedIds(before: Shapes, after: Shapes): readonly string[] {
  const out = new Set<string>();
  for (const [feature, vertices] of Object.entries(before)) {
    for (const [id, p] of Object.entries(vertices)) {
      const q = after[feature]?.[id];
      if (q === undefined || q.lon !== p.lon || q.lat !== p.lat) out.add(id);
    }
  }
  return [...out].sort();
}

function vertexIdsOf(shape: Shapes, features: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const f of features) for (const id of Object.keys(shape[f] ?? {})) ids.add(id);
  return [...ids].sort();
}

/** 引いた量。頂点 1 つ `probe` の動きから読み、全部の頂点が同じ量で動いたことを見る。 */
function expectMovedBySameVector(
  before: Shapes,
  after: Shapes,
  ids: readonly string[],
): { readonly dLon: number; readonly dLat: number } {
  const lookup = (shape: Shapes, id: string): WorldPos => {
    for (const vertices of Object.values(shape)) if (vertices[id] !== undefined) return vertices[id]!;
    throw new Error(`頂点が無い: ${id}`);
  };
  const first = ids[0]!;
  const dLon = lookup(after, first).lon - lookup(before, first).lon;
  const dLat = lookup(after, first).lat - lookup(before, first).lat;
  expect(Math.hypot(dLon, dLat)).toBeGreaterThan(0.5);
  for (const id of ids) {
    expect(lookup(after, id).lon - lookup(before, id).lon).toBeCloseTo(dLon, 5);
    expect(lookup(after, id).lat - lookup(before, id).lat).toBeCloseTo(dLat, 5);
  }
  return { dLon, dLat };
}

test.describe('［動かす］で集約地物を引く', () => {
  test('両州が動き、内側の境界がついてきて、隣との共有頂点と隣の形は動かず、取り消し 1 回で全部戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const before = await shapes(page);
      const stats = await projectStats(page);

      await drag(page, INSIDE_B, 6, -4);
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      // 動かした州 3 件、動かさなかった頂点 3 個（隣の国と 2 個、街道と 1 個）。
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(3, 3));
      await expect(page.getByTestId('app-active-feature')).toHaveText(IDS.federation);

      const after = await shapes(page);
      const fixedIds = ['mv-b3', 'mv-t3', 'mv-b0'];
      // 動いたのはちょうど、州の頂点から不動の 3 個を引いたもの。穴と飛び地も入る。
      const expectedMoved = vertexIdsOf(before, [IDS.stateA, IDS.stateB, IDS.stateC]).filter(
        (id) => !fixedIds.includes(id),
      );
      expect(movedIds(before, after)).toEqual(expectedMoved);
      expect(expectedMoved).toContain('mv-hole-a0');
      expect(expectedMoved).toContain('mv-island-b0');
      expectMovedBySameVector(before, after, expectedMoved);
      // 内側の境界: 州 A と州 B が引く同じ頂点が、両方で同じ座標にある。
      expect(after[IDS.stateA]!['mv-b1']).toEqual(after[IDS.stateB]!['mv-b1']);
      expect(after[IDS.stateB]!['mv-t2']).toEqual(after[IDS.stateC]!['mv-t2']);
      // 隣の国・線情報・関係のない地物は 1 つも変わらない。
      expect(after[IDS.neighbour]).toEqual(before[IDS.neighbour]);
      expect(after[IDS.road]).toEqual(before[IDS.road]);
      expect(after[IDS.sealedState]).toEqual(before[IDS.sealedState]);
      // 押した年に錨があるので、地物も錨も増えない。
      expect(await projectStats(page)).toEqual(stats);

      await page.getByTestId(STATUS).click();
      await page.keyboard.press('Control+z');
      await expect.poll(() => shapes(page)).toEqual(before);
      await expect(page.getByTestId('app-active-feature')).toHaveText(IDS.federation);
      await page.keyboard.press('Control+y');
      await expect.poll(() => shapes(page)).toEqual(after);
    } finally {
      await app.close();
    }
  });

  test('錨の間の年に引くと記録は押した年に入り、前の年は動かず、後の年へ引き継ぎ、保存して開き直しても残り修復を聞かれない', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-aggregate-move-'));
    const target = join(workDir, 'aggregate-move.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await ready(page, 1200);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const before = await shapes(page);
      const stats = await projectStats(page);

      await drag(page, INSIDE_B, 6, -4);
      const after = await shapes(page);
      expect(movedIds(before, after).length).toBeGreaterThan(0);
      // 連邦の系列と、自分の系列を持つ州 C に 1 本ずつ。隣の国と線情報には増えない。
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount + 2);
      // 1500 年の錨へ引き継いだことも言う（連邦の錨 1 本と州 C の錨 1 本）。
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(3, 3));
      await expect(page.getByTestId(STATUS)).toContainText(
        APP_STRINGS.vertexCarriedForward(1200, 1500, 2),
      );

      await jumpToYear(page, 1000);
      expect(await shapes(page)).toEqual(before);
      await jumpToYear(page, 1500);
      const at1500 = await shapes(page);
      expect(at1500[IDS.stateC]).toEqual(after[IDS.stateC]);
      expect(at1500[IDS.stateA]).toEqual(after[IDS.stateA]);

      await page.keyboard.press('Control+s');
      await expect(page.getByTestId(STATUS)).toContainText('保存しました');
      expect(existsSync(target)).toBe(true);

      const loading = loadProject(page, target);
      expect(await loading).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
      await jumpToYear(page, 1200);
      expect(await shapes(page)).toEqual(after);
      await jumpToYear(page, 1000);
      expect(await shapes(page)).toEqual(before);
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount + 2);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('他の年にしか居ない下位領域: 1500 年に引けば動き、1000 年に引いても 1500 年の形は動かない', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1500);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const before = await shapes(page);
      await drag(page, INSIDE_B, 6, -4);
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(4, 3));
      const after = await shapes(page);
      expectMovedBySameVector(before, after, Object.keys(before[IDS.stateD]!));

      await page.getByTestId(STATUS).click();
      await page.keyboard.press('Control+z');
      await expect.poll(() => shapes(page)).toEqual(before);
      await jumpToYear(page, 1000);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      await drag(page, INSIDE_B, 6, -4);
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(3, 3));
      await jumpToYear(page, 1500);
      // 州 D は 1000 年には居ないので、その頂点は動かない。
      expect((await shapes(page))[IDS.stateD]).toEqual(before[IDS.stateD]);
    } finally {
      await app.close();
    }
  });

  test('途中の集約地物を引くと、その下だけが動き、横の州と共有する頂点は動かない', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await openDepthOptions(page);
      const slider = page.getByTestId('global-depth-slider');
      await slider.focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('global-depth-readout')).toContainText('1');
      await page.getByTestId('option-depth-button').click();
      await armAndSelect(page, INSIDE_B, IDS.region);
      const before = await shapes(page);

      await drag(page, INSIDE_B, 8, 6);
      // 州 A・州 B の 2 件。州 C と共有する東の辺 2 個と、線情報の 1 個は動かない。
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(2, 3));
      await expect(page.getByTestId('app-active-feature')).toHaveText(IDS.region);
      const after = await shapes(page);
      expect(after[IDS.stateC]).toEqual(before[IDS.stateC]);
      expect(after[IDS.stateB]!['mv-b2']).toEqual(before[IDS.stateB]!['mv-b2']);
      expect(after[IDS.stateB]!['mv-t2']).toEqual(before[IDS.stateB]!['mv-t2']);
      expect(after[IDS.stateA]!['mv-b0']).toEqual(before[IDS.stateA]!['mv-b0']);
      expectMovedBySameVector(before, after, ['mv-b1', 'mv-t1', 'mv-t0', 'mv-hole-a0', 'mv-island-b0']);
    } finally {
      await app.close();
    }
  });

  test('州の上に描いた点情報を押して引いても、集約地物は掴まない', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const before = await shapes(page);
      await drag(page, { lon: -23, lat: 15 }, 6, -4);
      expect(await shapes(page)).toEqual(before);
      await expect(page.getByTestId(STATUS)).not.toContainText(
        APP_STRINGS.moveAggregateDone(3, 3),
      );
    } finally {
      await app.close();
    }
  });

  test('隠している下位領域も動く', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('州C');
      await page.getByTestId(`ledger-eye-${IDS.stateC}`).click();
      await expect(page.getByTestId(`ledger-eye-${IDS.stateC}`)).toHaveText('🚫');
      await page.getByTestId('unified-list-filter').fill('');
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const before = await shapes(page);
      await drag(page, INSIDE_B, 6, -4);
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(3, 3));
      const after = await shapes(page);
      expect(after[IDS.stateC]!['mv-b2']).not.toEqual(before[IDS.stateC]!['mv-b2']);
    } finally {
      await app.close();
    }
  });

  test('外の末端地物に重なる引きは板で止まり、やめれば何も残らず、適用すれば 1 回の取り消しで全部戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const before = await shapes(page);
      const stats = await projectStats(page);
      const canUndo = await page.getByTestId('app-can-undo').textContent();

      // 州 C の西の辺が東の辺を越えて、隣の国へ入る。州 B は州 C と隣の国へ、州 C は隣の国へ重なる。
      await drag(page, INSIDE_B, 26, 6);
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      if (await page.getByTestId('conflict-guide').isVisible()) {
        await page.getByTestId('conflict-guide-close').click();
      }
      await page.getByTestId('conflict-cancel').click();
      await expect(dialog).toHaveCount(0);
      expect(await shapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(stats);
      await expect(page.getByTestId('app-can-undo')).toHaveText(canUndo ?? '');

      await drag(page, INSIDE_B, 26, 6);
      await expect(dialog).toBeVisible();
      // 全部覆われる片を作らない順で残す: 州 C → 隣の国 → 州 B。
      const rows = page.getByTestId('conflict-rows').locator('li');
      for (let i = 0; i < (await rows.count()); i += 1) {
        const row = rows.nth(i);
        const names = (await row.getByTestId('conflict-row-features').textContent()) ?? '';
        const keep = names.includes('州C') ? /州C/ : /隣の国/;
        await row.getByRole('radio', { name: keep }).check();
      }
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);
      // 実際の結果の数と、直接の確定と同じ引き継ぎの文を言う（州 B は板で削られたので動かした数に入らない）。
      await expect(page.getByTestId(STATUS)).toContainText(
        `${APP_STRINGS.moveAggregateDone(2, 3)}${APP_STRINGS.moveAggregateTrimmed(1)}`,
      );
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.vertexCarriedForward(1000, 1500, 2));
      expect(await shapes(page)).not.toEqual(before);
      await page.getByTestId(STATUS).click();
      await page.keyboard.press('Control+z');
      await expect.poll(() => shapes(page)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test('不動の頂点の向こうへ引いて州の輪郭が交わる形は確定せず、理由を言い、何も残らない', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const before = await shapes(page);
      const stats = await projectStats(page);
      const canUndo = await page.getByTestId('app-can-undo').textContent();

      // 州 A の左下 mv-b0 は街道と共有して動かない。それを挟んで残りが向こう側へ越える。
      await drag(page, INSIDE_B, -30, -10);
      await expect(page.getByTestId(STATUS)).toContainText(RING_BREAK_PHRASE_TEXT.selfCross);
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      expect(await shapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(stats);
      await expect(page.getByTestId('app-can-undo')).toHaveText(canUndo ?? '');
    } finally {
      await app.close();
    }
  });

  test('頂点が全部不動の集約地物は、記録せず理由を言う', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await armAndSelect(page, INSIDE_SEALED, IDS.sealed);
      const before = await shapes(page);
      const stats = await projectStats(page);
      const canUndo = await page.getByTestId('app-can-undo').textContent();
      await drag(page, INSIDE_SEALED, 5, 5);
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateAllFixed);
      expect(await shapes(page)).toEqual(before);
      expect(await projectStats(page)).toEqual(stats);
      await expect(page.getByTestId('app-can-undo')).toHaveText(canUndo ?? '');
    } finally {
      await app.close();
    }
  });

  test('引いている間は下位領域の輪郭が描かれ、動かない頂点に印が出る', async () => {
    const { app, page } = await launchApp();
    try {
      await ready(page, 1000);
      await armAndSelect(page, INSIDE_B, IDS.federation);
      const counts = (): Promise<{ line: number; point: number }> =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __E2E__: { getPrimitiveCounts: () => { line: number; point: number } };
              }
            ).__E2E__.getPrimitiveCounts(),
        );
      await page.mouse.move(0, 0);
      await page.waitForTimeout(100);
      const idle = await counts();
      const { at, to } = await pullBy(page, INSIDE_B, 6, -4);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 4 });
      // 州 A の外周と穴、州 B の外周と飛び地、州 C の外周。
      await expect.poll(async () => (await counts()).line).toBeGreaterThanOrEqual(idle.line + 5);
      // 不動の 3 個。
      await expect.poll(async () => (await counts()).point).toBeGreaterThanOrEqual(idle.point + 3);
      await page.mouse.up();
      await expect.poll(async () => (await counts()).line).toBeLessThan(idle.line + 5);
    } finally {
      await app.close();
    }
  });
});
