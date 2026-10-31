// B113 の残り: `edit-session-snapshot.ts` を通らない経路でも、経度 ±180° の継ぎ目をまたぐ形で
// 保存される経度が [-180, 180) に入り、面積と隣との共有が保たれ、読み込み直しても同じであること。
//
// 経路: 輪郭の道具（穴と飛び地）・分ける・結合・重なりの解決の削り・共有を解く。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import {
  armAddAreaTool,
  armVertexTool,
  committedVertices,
  confirmReparentDialogIfOpen,
  drawFace,
  enterEditMode,
  launchApp,
  leafReport,
  loadProject,
  worldToClient,
  type ScreenPoint,
} from './helpers';

interface World {
  readonly lon: number;
  readonly lat: number;
}

const inRange = (lon: number): boolean => lon >= -180 && lon < 180;

async function client(page: Page, at: World): Promise<ScreenPoint> {
  const p = await worldToClient(page, at);
  return [p.x, p.y];
}

/** 経度 west〜east、緯度 south〜north の四角形を描く（west > east にはしない。連続の経度で書く）。 */
async function faceAt(
  page: Page,
  west: number,
  east: number,
  south: number,
  north: number,
  name: string,
): Promise<string> {
  const corners: ScreenPoint[] = [];
  for (const p of [
    { lon: west, lat: north },
    { lon: east, lat: north },
    { lon: east, lat: south },
    { lon: west, lat: south },
  ]) {
    corners.push(await client(page, p));
  }
  await armAddAreaTool(page);
  return drawFace(page, corners, { name });
}

/** 継ぎ目の両側が窓に入るまで、地図の中央を軸に縮小する。 */
async function bringSeamIntoView(page: Page): Promise<void> {
  const box = (await page.getByTestId('map-input-layer').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(async () => {
      const east = await worldToClient(page, { lon: 200, lat: 0 });
      const west = await worldToClient(page, { lon: -200, lat: 0 });
      if (east.x < box.x + box.width - 5 && west.x > box.x + 5) return true;
      await page.mouse.wheel(0, 100);
      return false;
    }, '継ぎ目が窓に入らない')
    .toBe(true);
}

/** 保存したファイルの中の全部の経度（形式に依らず lon を拾う）。 */
function savedLons(path: string): number[] {
  const out: number[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (k === 'lon' && typeof v === 'number') out.push(v);
      else walk(v);
    }
  };
  const entries = unzipSync(new Uint8Array(readFileSync(path)));
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('.json')) walk(JSON.parse(strFromU8(bytes)));
  }
  return out;
}

interface Snapshot {
  readonly vertices: Record<string, Record<string, World>>;
  readonly areas: Record<string, number>;
  readonly total: number;
}

async function snapshotOf(page: Page, ids: readonly string[]): Promise<Snapshot> {
  const vertices: Record<string, Record<string, World>> = {};
  for (const id of ids) vertices[id] = Object.fromEntries(await committedVertices(page, id));
  const report = await leafReport(page, { ids });
  return {
    vertices,
    areas: Object.fromEntries(report.entries.map((e) => [e.id, e.areaKm2 ?? -1])),
    total: report.totalAreaKm2,
  };
}

/** 全部の頂点の経度が範囲内で、保存したファイルも範囲内で、開き直しても頂点と面積が同じ。 */
async function expectSavedAndReloaded(
  page: Page,
  target: string,
  ids: readonly string[],
): Promise<Snapshot> {
  const before = await snapshotOf(page, ids);
  for (const [id, vs] of Object.entries(before.vertices)) {
    expect(Object.keys(vs).length, `${id} の頂点`).toBeGreaterThan(0);
    for (const v of Object.values(vs)) expect(inRange(v.lon), `${id} の経度 ${String(v.lon)}`).toBe(true);
  }
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
  const lons = savedLons(target);
  expect(lons.length).toBeGreaterThan(0);
  expect(lons.filter((lon) => !inRange(lon))).toEqual([]);

  expect(await loadProject(page, target)).toBe('loaded');
  const after = await snapshotOf(page, ids);
  expect(after.vertices).toEqual(before.vertices);
  for (const id of ids) expect(after.areas[id]).toBeCloseTo(before.areas[id]!, 3);
  const report = await leafReport(page, { ids });
  expect(report.maxPairOverlapKm2).toBeLessThan(1);
  return after;
}

/** 面積の比較の許容（km²。地球の 1 度四方の約 1/100）。 */
const AREA_EPS = 200;

const KEEP_NAME = '残す';
const TRIM_NAME = '削る';

async function allLeafIds(page: Page, names: readonly string[]): Promise<string[]> {
  return (await leafReport(page, { names })).entries.map((e) => e.id);
}

test.describe('B113 の残り — 継ぎ目をまたぐ形の保存', () => {
  let dir: string;
  let target: string;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b113-'));
    target = join(dir, 'seam.gimoza');
  });
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('追加の道具: 継ぎ目をまたぐ面を描く（以下の経路の前提）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await bringSeamIntoView(page);
      const id = await faceAt(page, 170, 190, -10, 10, '面');
      const saved = await expectSavedAndReloaded(page, target, [id]);
      // 幅 20 度 × 高さ 20 度。1 度 ≒ 111km なので 490 万 km² 前後。崩れると桁が変わる。
      expect(saved.areas[id]).toBeGreaterThan(4_000_000);
      expect(saved.areas[id]).toBeLessThan(6_000_000);
    } finally {
      await app.close();
    }
  });

  test('輪郭の道具: 継ぎ目をまたぐ穴', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await bringSeamIntoView(page);
      const id = await faceAt(page, 170, 190, -10, 10, '面');
      const area = (await snapshotOf(page, [id])).areas[id]!;

      await page.getByTestId('tool-edit.ring').click();
      const [tx, ty] = await client(page, { lon: 175, lat: 0 });
      await page.mouse.click(tx, ty);
      for (const p of [
        { lon: 176, lat: -5 },
        { lon: 184, lat: -5 },
        { lon: 184, lat: 5 },
        { lon: 176, lat: 5 },
      ]) {
        const [x, y] = await client(page, p);
        await page.mouse.click(x, y);
      }
      await page.getByTestId('ring-edit-confirm').click();
      await expect(page.getByTestId('ring-edit-vertex-count')).toHaveText('0');

      const saved = await expectSavedAndReloaded(page, target, [id]);
      expect((await leafReport(page, { ids: [id] })).entries[0]!.ringCount).toBe(2);
      // 穴は幅 8 度 × 高さ 10 度。
      const hole = area - saved.areas[id]!;
      expect(hole).toBeGreaterThan(area * 0.15);
      expect(hole).toBeLessThan(area * 0.25);
    } finally {
      await app.close();
    }
  });

  test('輪郭の道具: 継ぎ目をまたぐ飛び地', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await bringSeamIntoView(page);
      const id = await faceAt(page, 150, 165, -5, 5, '面');
      const area = (await snapshotOf(page, [id])).areas[id]!;

      await page.getByTestId('tool-edit.ring').click();
      const [tx, ty] = await client(page, { lon: 157, lat: 0 });
      await page.mouse.click(tx, ty);
      for (const p of [
        { lon: 176, lat: -5 },
        { lon: 184, lat: -5 },
        { lon: 184, lat: 5 },
        { lon: 176, lat: 5 },
      ]) {
        const [x, y] = await client(page, p);
        await page.mouse.click(x, y);
      }
      await page.getByTestId('ring-edit-confirm').click();
      await expect(page.getByTestId('ring-edit-vertex-count')).toHaveText('0');

      const saved = await expectSavedAndReloaded(page, target, [id]);
      const entry = (await leafReport(page, { ids: [id] })).entries[0]!;
      expect(entry.polygonCount).toBe(2);
      // 15 度幅の本体に 8 度幅の飛び地が足された。
      const gained = saved.areas[id]! - area;
      expect(gained).toBeGreaterThan(area * 0.45);
      expect(gained).toBeLessThan(area * 0.6);
    } finally {
      await app.close();
    }
  });

  test('分ける: 継ぎ目をまたぐ面を切ると、片の面積の和が保たれ、切り口の頂点を共有する', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await bringSeamIntoView(page);
      const id = await faceAt(page, 170, 190, -10, 10, '面');
      const area = (await snapshotOf(page, [id])).areas[id]!;
      // 東の辺を共有する隣。切り口は隣の輪へも差し込まれる（T 字を残さない）。
      const neighbour = await faceAt(page, 190, 200, -10, 10, '隣');
      const neighbourArea = (await snapshotOf(page, [neighbour])).areas[neighbour]!;

      await page.getByTestId('tool-edit.knife').click();
      const [tx, ty] = await client(page, { lon: 175, lat: 5 });
      await page.mouse.click(tx, ty);
      for (const p of [
        { lon: 160, lat: 0 },
        { lon: 200, lat: 0 },
      ]) {
        const [x, y] = await client(page, p);
        await page.mouse.click(x, y);
      }
      await page.getByTestId('knife-confirm-cut').click();
      await page.getByTestId('knife-confirm-inheritor').click();
      await page.getByTestId('add-name').fill('南');
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);

      await expect.poll(async () => (await allLeafIds(page, ['面', '南'])).length).toBe(2);
      const ids = await allLeafIds(page, ['面', '南']);
      const saved = await expectSavedAndReloaded(page, target, ids);
      const sum = ids.reduce((acc, i) => acc + saved.areas[i]!, 0);
      expect(Math.abs(sum - area)).toBeLessThan(AREA_EPS);
      const a = Object.keys(saved.vertices[ids[0]!]!);
      const b = new Set(Object.keys(saved.vertices[ids[1]!]!));
      expect(a.filter((v) => b.has(v)).length, '切り口の頂点の共有').toBeGreaterThanOrEqual(2);

      const near = await expectSavedAndReloaded(page, target, [neighbour]);
      expect(near.areas[neighbour]).toBeCloseTo(neighbourArea, 0);
      // 隣も切り口の頂点を引く: 切り口は両方の片と隣の 3 者で 1 つの頂点。
      const nearIds = new Set(Object.keys(near.vertices[neighbour]!));
      expect(a.filter((v) => b.has(v) && nearIds.has(v)), '隣の辺の切り口').toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  test('結合: 継ぎ目で接する 2 面をまとめると、面積の和になる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await bringSeamIntoView(page);
      const a = await faceAt(page, 170, 179, -5, 5, 'A');
      const b = await faceAt(page, 181, 190, -5, 5, 'B');
      const before = await snapshotOf(page, [a, b]);
      const sum = before.areas[a]! + before.areas[b]!;

      await enterEditMode(page);
      await page.getByTestId('tool-edit.merge').click();
      const targetCount = page.getByTestId('merge-target-count');
      const [ax, ay] = await client(page, { lon: 175, lat: 0 });
      await page.mouse.click(ax, ay);
      await expect(targetCount).toHaveText('1');
      const [bx, by] = await client(page, { lon: 185, lat: 0 });
      await page.mouse.click(bx, by);
      await expect(targetCount).toHaveText('2');
      await page.getByTestId('merge-confirm').click();
      await page.getByTestId('merge-options-confirm').click();
      await confirmReparentDialogIfOpen(page);
      await expect(page.getByTestId('merge-options-dialog')).toHaveCount(0);
      await expect.poll(async () => (await leafReport(page, { names: ['A', 'B'] })).entries.length).toBe(1);

      const ids = await allLeafIds(page, ['A', 'B']);
      const saved = await expectSavedAndReloaded(page, target, ids);
      expect(Math.abs(saved.areas[ids[0]!]! - sum)).toBeLessThan(AREA_EPS);
    } finally {
      await app.close();
    }
  });

  test('重なりの解決の削り: 継ぎ目をまたいで重なる面を削ると、残りの形が正しい', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await bringSeamIntoView(page);
      // 頂点は他の面の内側に置けないので、離して描いてから面の移動で重ねる。残す面の東の 2 角が
      // 削る面の中へ入るので、削った境界はその 2 角を共有する。
      const trim = await faceAt(page, 182, 196, -12, 12, TRIM_NAME);
      const trimBefore = (await snapshotOf(page, [trim])).areas[trim]!;
      const keep = await faceAt(page, 160, 174, -6, 6, KEEP_NAME);
      const keepBefore = (await snapshotOf(page, [keep])).areas[keep]!;

      await enterEditMode(page);
      await page.getByTestId('tool-edit.select').click();
      await page.keyboard.press('Escape');
      const [fx, fy] = await client(page, { lon: 167, lat: 0 });
      await page.mouse.click(fx, fy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(keep);
      await page.getByTestId('tool-edit.move').click();
      await page.mouse.move(fx, fy);
      await page.mouse.down();
      const [mx, my] = await client(page, { lon: 181, lat: 0 });
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(fx + ((mx - fx) * i) / 8, fy + ((my - fy) * i) / 8);
      }
      await page.mouse.up();
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId('conflict-guide-close').click().catch(() => undefined);
      await page
        .getByTestId('conflict-rows')
        .locator('li')
        .first()
        .getByRole('radio', { name: new RegExp(KEEP_NAME) })
        .check();
      await expect(page.getByTestId('conflict-apply')).toBeEnabled();
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0);

      const ids = [keep, trim];
      const saved = await expectSavedAndReloaded(page, target, ids);
      expect(saved.areas[keep]).toBeCloseTo(keepBefore, 0);
      // 残す面は東へ約 14 度動いて 174〜188。削る面（幅 14 度 × 高さ 24 度）から幅 6 度 × 高さ 12 度が欠ける。
      const lost = (trimBefore - saved.areas[trim]!) / trimBefore;
      expect(lost).toBeGreaterThan((72 / 336) * 0.7);
      expect(lost).toBeLessThan((72 / 336) * 1.3);
      const trimmedId = trim;
      const a = new Set(Object.keys(saved.vertices[keep]!));
      const shared = Object.keys(saved.vertices[trimmedId]!).filter((v) => a.has(v));
      expect(shared.length, '削った境界の頂点の共有').toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });

  test('共有を解く: 継ぎ目の向こうで共有する頂点を解くと、座標はそのままで id だけ別になる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await bringSeamIntoView(page);
      const a = await faceAt(page, 170, 184, -5, 5, 'A');
      // B の西の 2 角を A の東の 2 角（184°）へ吸着させる。
      const corners: ScreenPoint[] = [];
      for (const p of [
        { lon: 184, lat: 5 },
        { lon: 194, lat: 5 },
        { lon: 194, lat: -5 },
        { lon: 184, lat: -5 },
      ]) {
        corners.push(await client(page, p));
      }
      await armAddAreaTool(page);
      const b = await drawFace(page, corners, { name: 'B' });
      const before = await snapshotOf(page, [a, b]);
      const aIds = new Set(Object.keys(before.vertices[a]!));
      const sharedBefore = Object.keys(before.vertices[b]!).filter((v) => aIds.has(v));
      expect(sharedBefore.length, '吸着で共有になっている').toBe(2);
      const sharedPos = before.vertices[a]![sharedBefore[0]!]!;
      expect(inRange(sharedPos.lon)).toBe(true);

      await enterEditMode(page);
      await page.getByTestId('tool-edit.select').click();
      await page.keyboard.press('Escape');
      const [fx, fy] = await client(page, { lon: 175, lat: 0 });
      await page.mouse.click(fx, fy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(a);
      await armVertexTool(page);
      // 共有の頂点は 184° の見えている位置で掴む（保存は -176°）。
      const [vx, vy] = await client(page, { lon: 184, lat: sharedPos.lat });
      await page.mouse.click(vx, vy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      await menu.locator('[data-item-kind="unshare"]').click();
      await expect(menu).toHaveCount(0);

      const saved = await expectSavedAndReloaded(page, target, [a, b]);
      const aAfter = saved.vertices[a]!;
      const bAfter = new Set(Object.keys(saved.vertices[b]!));
      const sharedAfter = Object.keys(aAfter).filter((v) => bAfter.has(v));
      expect(sharedAfter).toHaveLength(1);
      // 座標の集合は変わらない（id が変わっただけ）。面積も同じ。
      const pts = (vs: Record<string, World>): string[] =>
        Object.values(vs)
          .map((v) => `${v.lon.toFixed(5)},${v.lat.toFixed(5)}`)
          .sort();
      expect(pts(aAfter)).toEqual(pts(before.vertices[a]!));
      expect(saved.areas[a]).toBeCloseTo(before.areas[a]!, 3);
      expect(saved.areas[b]).toBeCloseTo(before.areas[b]!, 3);
    } finally {
      await app.close();
    }
  });
});
