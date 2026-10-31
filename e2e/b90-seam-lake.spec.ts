// B90 — 経度 180 度に接する面の中に子を描いても、分け残しの湖（穴）が陸に変わらない。
//
// 実データのコピーの「？？？大湾の島01」（`area-544`、経度 123.98〜180、穴 3 つ）で、実アプリの
// 描く → 保存 → 開き直す → 修復（直轄領を生成）の経路を通す。直す前は、分け残しの輪が全部
// 領土になり、修復の面積の検算で止まって板が閉じなかった。
//
// 輪の階層と面積の細かい形は単体（`src/domain/promotion/direct-domain.seam.test.ts`）が見る。

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
  type LoadProjectOutcome,
} from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

const ISLAND_ID = 'area-544';
const ISLAND_NAME = '？？？大湾の島01';
const YEAR = 3000;
/** 島の内側で、穴にも海岸にも当たらない四角（探針で確かめた場所）。 */
const CHILD = { west: 151.5, east: 152.5, south: 74.2, north: 74.8 };
/** もとの穴 3 つの、それぞれの中の点（各穴の頂点の平均）。 */
const IN_LAKES = [
  { lon: 158.7463, lat: 75.0633 },
  { lon: 159.336, lat: 75.1572 },
  { lon: 162.5636, lat: 77.6658 },
];
/** 陸の点（穴でも子でもない）。 */
const ON_LAND = { lon: 150, lat: 74.5 };

interface SavedRing {
  readonly kind?: string;
}

/** 保存したファイルから、分け残しの輪の種類を数える。 */
function savedDirectDomainRingKinds(path: string): readonly string[] {
  const manifest = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['manifest.json']!),
  ) as unknown;
  const kinds: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (o['directDomain'] === true && o['parentId'] === ISLAND_ID) {
      const rings = (o['shape'] as { rings?: readonly SavedRing[] } | undefined)?.rings ?? [];
      if (kinds.length === 0) for (const r of rings) kinds.push(r.kind ?? '');
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(manifest);
  return kinds;
}

/** 開いたコピーへ上書き保存する。読み込んだ先への初回の上書きは確認の板が出る（V12）。 */
async function saveOverCopy(page: Page): Promise<void> {
  // 入力欄の外へ焦点を移してから押す（教訓 5.54）。
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

test.describe('B90 — 実データのコピーで', () => {
  test.skip(!existsSync(canonicalPath), `実データ ${REAL_DATA_FILE} が無い`);

  test('経度 180 度に接する島の中に子を描く → 保存 → 開き直して修復 → 穴 3 つは湖のまま', async () => {
    test.setTimeout(240_000);
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-b90-'));
    const copy = join(dir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);
    const canonicalBefore = statSync(canonicalPath);
    const { app, page } = await launchApp();
    try {
      expect(await loadProject(page, copy)).toBe('loaded');
      await jumpToYear(page, YEAR);
      await leaveViewMode(page);

      // 一覧から選んで、島へ視点を合わせる。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill(ISLAND_NAME);
      await page.getByTestId(`feature-list-item-${ISLAND_ID}`).click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(ISLAND_ID);

      const before = (await leafReport(page, { ids: [ISLAND_ID] })).entries[0]!;
      expect(before.ringCount).toBe(4);
      const corners = [
        { lon: CHILD.west, lat: CHILD.south },
        { lon: CHILD.east, lat: CHILD.south },
        { lon: CHILD.east, lat: CHILD.north },
        { lon: CHILD.west, lat: CHILD.north },
      ];
      // 前提: 四角の 4 隅と陸の点は島の上、湖の点は島の上ではない。
      const beforeProbes = await leafReport(page, {
        ids: [ISLAND_ID],
        probes: [...corners, ON_LAND, ...IN_LAKES],
      });
      expect(beforeProbes.probeOwners).toEqual([...Array<string>(5).fill(ISLAND_ID), null, null, null]);

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
      expect(await parent.inputValue()).toBe(ISLAND_ID);
      await page.getByTestId('add-name').fill('島の子');
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);

      await saveOverCopy(page);

      // 開き直すと修復の板が出る。「直轄領を生成」を選ぶ。
      const loading: Promise<LoadProjectOutcome> = loadProject(page, copy);
      // 板で止まって落ちるとき、窓を閉じた読み込みの失敗で本当の理由が隠れないようにする。
      loading.catch(() => undefined);
      const board = page.getByTestId('repair-dialog');
      await board.waitFor({ state: 'visible', timeout: 30_000 });
      const materialize = board.locator('[data-testid$="-materialize-direct-domain"]');
      await expect(materialize).toHaveCount(1);
      await materialize.check();
      await page.getByTestId('repair-apply').click();
      // 1 回で解ける（直す前は面積の検算で止まり、板が閉じなかった）。
      await expect(board).toHaveCount(0);
      expect(await loading).toBe('loaded');

      await jumpToYear(page, YEAR);
      const directDomainName = `${ISLAND_NAME} 直轄領`;
      const after = await leafReport(page, {
        names: ['島の子', directDomainName],
        probes: [...IN_LAKES, ON_LAND],
      });
      const domain = after.entries.find((e) => e.name === directDomainName);
      const child = after.entries.find((e) => e.name === '島の子');
      if (domain === undefined || child === undefined) {
        throw new Error(`分け残しか子が無い: ${JSON.stringify(after.entries)}`);
      }
      // もとの外周 1 + もとの穴 3 + 子のぶんの穴 1。片は 1 つのまま。
      expect(domain.ringCount).toBe(5);
      expect(domain.polygonCount).toBe(1);
      expect(after.maxPairOverlapKm2).toBe(0);
      // 面積が保存される（分け残し ＋ 子 ＝ もとの島）。穴が陸に変わると増える。
      expect(before.areaKm2).not.toBeNull();
      expect(((domain.areaKm2 ?? 0) + (child.areaKm2 ?? 0)) / before.areaKm2!).toBeCloseTo(1, 4);
      // 湖は分け残しの上ではなく、陸は分け残しの上。
      expect(after.probeOwners).toEqual([null, null, null, domain.id]);

      // 保存し直したファイルの輪の階層も同じで、次に開くときは板が出ない。
      await saveOverCopy(page);
      const kinds = savedDirectDomainRingKinds(copy);
      expect(kinds.filter((k) => k === 'hole')).toHaveLength(4);
      expect(kinds.filter((k) => k === 'territory')).toHaveLength(1);
      expect(await loadProject(page, copy)).toBe('loaded');
      await expect(board).toHaveCount(0);

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
