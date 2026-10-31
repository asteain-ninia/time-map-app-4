// B105 — 地図の幅いっぱいの面の中の子を所属変更しても、分け残しの面積が保たれる。
//
// 実データのコピーの「ヴィオニア大陸付近の領域01」（`area-188`、経度 -180〜179.99、緯度 -90〜-59）
// で、実アプリの 面の中に描く → 別の島を所属変更で入れる → 保存 → 開き直す の経路を通す。直す前は、集合演算が南の辺の
// 途中の点を消して経度 359.99 度の 1 本の辺になり、分け残しの面積が 3,985 → 約 387（平方度）に
// なって確定していた。
//
// 形の細かい検査は単体（`src/domain/promotion/direct-domain.long-edge.test.ts`）が見る。

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import {
  armAddAreaTool,
  jumpToYear,
  launchApp,
  leafReport,
  leaveViewMode,
  liveCamera,
  loadProject,
  placeVertices,
  worldToClient,
} from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

const WIDE_ID = 'area-188';
const WIDE_NAME = 'ヴィオニア大陸付近の領域01';
const CHILD_NAME = '幅いっぱいの面の子';
/** 所属変更で入れる、面の外の島。 */
const OTHER_ID = 'area-465';
const OTHER_NAME = 'セクエンロ狭海の島07';
const YEAR = 3000;
/** 面の内側で、海岸に当たらない四角（探針で確かめた場所）。 */
const CHILD = { west: -0.5, east: 0.5, south: -87.3, north: -86.7 };
/** 陸の点（穴でも子でもない。南の辺の近く、子から遠い）。 */
const ON_LAND = { lon: 100, lat: -88 };
const IN_CHILD = { lon: 0, lat: -87 };

/** 開いたコピーへ上書き保存する。読み込んだ先への初回の上書きは確認の板が出る（V12）。 */
async function saveOverCopy(page: Page): Promise<void> {
  await page.getByTestId('statusbar').click();
  await page.keyboard.press('Control+s');
  const overwrite = page.getByTestId('overwrite-dialog');
  const asked = await overwrite
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (asked) await page.getByTestId('overwrite-confirm').click();
  await expect(page.getByTestId('statusbar-result')).toContainText('保存しました', {
    timeout: 60_000,
  });
}

/** 保存したファイルの中で、`parentId` の分け残しの頂点の経度を、輪の順のまま引く。 */
function savedDirectDomainMaxLonStep(path: string, parentId: string): number {
  const manifest = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['manifest.json']!),
  ) as unknown;
  const lonOf = new Map<string, number>();
  const shapes: { rings?: readonly { vertexIds?: readonly string[] }[] }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const coordinate = o['coordinate'] as { lon?: number } | undefined;
    if (typeof o['id'] === 'string' && typeof coordinate?.lon === 'number') {
      lonOf.set(o['id'], coordinate.lon);
    }
    if (o['directDomain'] === true && o['parentId'] === parentId) {
      shapes.push(o['shape'] as { rings?: readonly { vertexIds?: readonly string[] }[] });
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(manifest);
  expect(shapes.length).toBeGreaterThan(0);
  let maxStep = 0;
  for (const ring of shapes[0]!.rings ?? []) {
    const ids = ring.vertexIds ?? [];
    ids.forEach((id, i) => {
      const a = lonOf.get(id);
      const b = lonOf.get(ids[(i + 1) % ids.length]!);
      if (a === undefined || b === undefined) throw new Error(`頂点が引けない: ${id}`);
      // 保存の読み直しと同じく、継ぎ目を最短で渡った差を見る。
      const d = Math.abs(a - b);
      maxStep = Math.max(maxStep, Math.min(d, 360 - d));
    });
  }
  return maxStep;
}

test.describe('B105 — 実データのコピーで', () => {
  test.skip(!existsSync(canonicalPath), `実データ ${REAL_DATA_FILE} が無い`);

  test('幅いっぱいの面の中に描く → 所属変更 → 保存 → 開き直す で面積が保たれ、修復の板が出ない', async () => {
    test.setTimeout(300_000);
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-b105-'));
    const copy = join(dir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);
    const canonicalBefore = statSync(canonicalPath);
    const { app, page } = await launchApp();
    try {
      expect(await loadProject(page, copy)).toBe('loaded');
      await jumpToYear(page, YEAR);
      await leaveViewMode(page);

      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill(WIDE_NAME);
      await page.getByTestId(`feature-list-item-${WIDE_ID}`).click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(WIDE_ID);

      const before = (await leafReport(page, { ids: [WIDE_ID] })).entries[0]!;
      expect(before.areaKm2).not.toBeNull();

      const corners = [
        { lon: CHILD.west, lat: CHILD.south },
        { lon: CHILD.east, lat: CHILD.south },
        { lon: CHILD.east, lat: CHILD.north },
        { lon: CHILD.west, lat: CHILD.north },
      ];
      // 前提: 四角の 4 隅と陸の点はこの面の上。
      const beforeProbes = await leafReport(page, {
        ids: [WIDE_ID],
        probes: [...corners, ON_LAND],
      });
      expect(beforeProbes.probeOwners).toEqual(Array<string>(5).fill(WIDE_ID));

      await armAddAreaTool(page);
      // 四角が画面で 40px 幅くらいになるまで寄せる（遠いと 4 隅が吸着で 1 点に潰れる）。
      for (let i = 0; i < 30 && (await liveCamera(page)).zoom < 40; i += 1) {
        const at = await worldToClient(page, corners[0]!);
        await page.mouse.move(at.x, at.y);
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(50);
      }
      expect((await liveCamera(page)).zoom).toBeGreaterThanOrEqual(40);
      const points = await Promise.all(corners.map((p) => worldToClient(page, p)));
      await placeVertices(
        page,
        points.map((q) => [q.x, q.y] as const),
      );
      await page.getByTestId('add-complete').click();
      const parent = page.getByTestId('add-parent');
      await expect(parent).toBeVisible();
      // 面の中に描くと上位領域の既定はこの面（上位領域なしにすると重なりの板で止まる）。
      expect(await parent.inputValue()).toBe(WIDE_ID);
      await page.getByTestId('add-name').fill(CHILD_NAME);
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);

      // 別の島をこの面へ所属変更する。所属変更の確定が、子を持つこの面の分け残しを作る。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill(OTHER_NAME);
      await page.getByTestId(`ledger-mark-${OTHER_ID}`).check();
      await page.getByTestId('tool-edit.reparent').click();
      await page.getByTestId('reparent-confirm').click();
      // 773 件の一覧は窓の中だけ描くので、絞ってから押す。
      await page.getByTestId('reparent-parent-existing-pick-filter').fill(WIDE_NAME);
      await page.getByTestId(`reparent-parent-existing-pick-item-${WIDE_ID}`).click();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
      await page.getByTestId('tool-edit.select').click();

      const directDomainName = `${WIDE_NAME} 直轄領`;
      const assertKept = async (): Promise<void> => {
        const after = await leafReport(page, {
          names: [CHILD_NAME, directDomainName],
          probes: [IN_CHILD, ON_LAND],
        });
        const domain = after.entries.find((e) => e.name === directDomainName);
        const child = after.entries.find((e) => e.name === CHILD_NAME);
        if (domain === undefined || child === undefined) {
          throw new Error(`分け残しか子が無い: ${JSON.stringify(after.entries)}`);
        }
        // 面積が保存される（分け残し ＋ 面の中の子 ＝ もとの面）。直す前は 1 割以下になっていた。
        expect(((domain.areaKm2 ?? 0) + (child.areaKm2 ?? 0)) / before.areaKm2!).toBeCloseTo(1, 4);
        expect(domain.polygonCount).toBe(1);
        expect(domain.ringCount).toBe(before.ringCount + 1);
        expect(after.maxPairOverlapKm2).toBe(0);
        expect(after.probeOwners).toEqual([child.id, domain.id]);
      };
      await assertKept();

      await saveOverCopy(page);
      // 保存された辺は、どれも経度 180 度を渡らない（技術方針 §6.8）。
      expect(savedDirectDomainMaxLonStep(copy, WIDE_ID)).toBeLessThan(180);

      // 開き直しても修復の板は出ない。
      expect(await loadProject(page, copy)).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
      await jumpToYear(page, YEAR);
      await assertKept();

      // 正本には触っていない（開発ガイド §5.48）。
      const canonicalAfter = statSync(canonicalPath);
      expect(canonicalAfter.size).toBe(canonicalBefore.size);
      expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
