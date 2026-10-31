// B105・B108 — 地図の幅いっぱいの面で、子を分けても形が崩れない。
//
// 実データのコピーの「ヴィオニア大陸付近の領域01」（`area-188`、経度 -180〜179.99、緯度 -90〜-59）で、
// 実アプリの 面の中に描く → 描いた子を同じ親へ所属変更する → 保存 → 開き直す の経路を通す。
//
// 直す前は、中核の処理が作る案の分け残しの面積が 3,985 → 約 387（平方度）に崩れていた。崩れた面は
// 子や隣の面と重なって見えるので、実アプリでは所属変更の確定が重なりの板で止まり、確定に届かなかった。
// だから選択の道具を押す前に、重なりの板が 0 枚であることを見る（板が出ていると押せずに待つだけになる）。
//
// 継ぎ目にかかる子と重なりの解決は B108 と B105 の続き（現状.md の履歴）。形の細かい検査は単体
// （`src/domain/promotion/direct-domain.long-edge.test.ts`、`direct-domain.seam-child.test.ts`、
// `src/ui/consistency-binding.wide-trim.test.tsx`）が見る。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

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
const YEAR = 3000;
/** 面の内側で、海岸に当たらない四角（探針で確かめた場所）。 */
const CHILD = { west: -0.5, east: 0.5, south: -87.3, north: -86.7 };
/** 陸の点（穴でも子でもない。南の辺の近く、子から遠い）。 */
const ON_LAND = { lon: 100, lat: -88 };
const IN_CHILD = { lon: 0, lat: -87 };
/** 継ぎ目にかかる四角。親の東の端は 179.99 なので、179.99〜180 の細い隙間には親が無い。 */
const SEAM_CHILD = { west: 179.5, east: 180.5, south: -87.3, north: -86.7 };
const SEAM_EAST = { lon: 179.8, lat: -87 };
const SEAM_WEST = { lon: -179.8, lat: -87 };
const directDomainName = `${WIDE_NAME} 直轄領`;

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

interface Box {
  readonly west: number;
  readonly east: number;
  readonly south: number;
  readonly north: number;
}

/** コピーを開き、幅いっぱいの面を選んで元の測定を返す。 */
async function openWide(page: Page, copy: string): Promise<{ areaKm2: number; ringCount: number }> {
  expect(await loadProject(page, copy)).toBe('loaded');
  await jumpToYear(page, YEAR);
  await leaveViewMode(page);
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(WIDE_NAME);
  await page.getByTestId(`feature-list-item-${WIDE_ID}`).click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(WIDE_ID);
  const before = (await leafReport(page, { ids: [WIDE_ID] })).entries[0]!;
  return { areaKm2: before.areaKm2!, ringCount: before.ringCount };
}

/** 四角を描いて素性の入力まで進める。 */
async function drawBox(page: Page, box: Box): Promise<void> {
  const corners = [
    { lon: box.west, lat: box.south },
    { lon: box.east, lat: box.south },
    { lon: box.east, lat: box.north },
    { lon: box.west, lat: box.north },
  ];
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
  // 面の中に描くと上位領域の既定はこの面。
  expect(await parent.inputValue()).toBe(WIDE_ID);
  await page.getByTestId('add-name').fill(CHILD_NAME);
}

/** 描いた子に一覧で印を付け、同じ親を選んで所属変更する。確定が子を持つ面の分け残しを作る。 */
async function reparentChildToWide(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(CHILD_NAME);
  // 一覧には親も一緒に出るので、親でない行の印を付ける。
  const childMark = page.locator(
    `[data-testid^="ledger-mark-"]:not([data-testid="ledger-mark-${WIDE_ID}"])`,
  );
  await expect(childMark).toHaveCount(1);
  await childMark.check();
  await page.getByTestId('tool-edit.reparent').click();
  await page.getByTestId('reparent-confirm').click();
  // 773 件の一覧は窓の中だけ描くので、絞ってから押す。
  await page.getByTestId('reparent-parent-existing-pick-filter').fill(WIDE_NAME);
  await page.getByTestId(`reparent-parent-existing-pick-item-${WIDE_ID}`).click();
  await page.getByTestId('reparent-options-confirm').click();
  await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
}

/**
 * 重なりの板が出ていないこと。次の道具を押す前に見る。板が出たまま押すと、板に塞がれて時間切れに
 * なり、理由の分からない失敗になる。
 */
async function expectNoConflictBoard(page: Page, why: string): Promise<void> {
  await page.waitForTimeout(500);
  expect(await page.getByTestId('conflict-dialog').count(), why).toBe(0);
}

test.describe('B105・B108 — 実データのコピーで', () => {
  test.skip(!existsSync(canonicalPath), `実データ ${REAL_DATA_FILE} が無い`);

  let dir: string;
  let copy: string;
  let canonicalBefore: Stats;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gimoza-b105-'));
    copy = join(dir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);
    canonicalBefore = statSync(canonicalPath);
  });
  test.afterEach(() => {
    // 正本には触っていない（開発ガイド §5.48）。
    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
    rmSync(dir, { recursive: true, force: true });
  });

  test('面の中に描く → 同じ親へ所属変更 → 保存 → 開き直す で面積が保たれ、修復の板が出ない', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    try {
      const before = await openWide(page, copy);

      // 前提: 四角の 4 隅と陸の点はこの面の上。
      const beforeProbes = await leafReport(page, {
        ids: [WIDE_ID],
        probes: [
          { lon: CHILD.west, lat: CHILD.south },
          { lon: CHILD.east, lat: CHILD.south },
          { lon: CHILD.east, lat: CHILD.north },
          { lon: CHILD.west, lat: CHILD.north },
          ON_LAND,
        ],
      });
      expect(beforeProbes.probeOwners).toEqual(Array<string>(5).fill(WIDE_ID));

      await drawBox(page, CHILD);
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);

      await reparentChildToWide(page);
      await expectNoConflictBoard(
        page,
        '重なりの板が出た。分け残しが崩れて、子や隣の面と重なって見えている（B105）',
      );
      await page.getByTestId('tool-edit.select').click();

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
        expect(((domain.areaKm2 ?? 0) + (child.areaKm2 ?? 0)) / before.areaKm2).toBeCloseTo(1, 4);
        expect(domain.polygonCount).toBe(1);
        expect(domain.ringCount).toBe(before.ringCount + 1);
        expect(after.maxPairOverlapKm2).toBe(0);
        expect(after.probeOwners).toEqual([child.id, domain.id]);
      };
      await assertKept();

      await saveOverCopy(page);

      // 開き直しても修復の板は出ない。
      expect(await loadProject(page, copy)).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
      await jumpToYear(page, YEAR);
      await assertKept();
    } finally {
      await app.close();
    }
  });

  test('継ぎ目にかかる子を所属変更すると、両側とも引かれて重なりの板が出ない', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    try {
      await openWide(page, copy);
      await drawBox(page, SEAM_CHILD);
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);

      // 観測の確かめ: 分ける前の子は親の中にあるので、重なりは継ぎ目の両側を足して子の面積と同じ。
      // これが半分に出るなら、下の `maxPairOverlapKm2 === 0` は反対側の引き残しを見られない。
      const drawn = await leafReport(page, { ids: [WIDE_ID], names: [CHILD_NAME] });
      const drawnChild = drawn.entries.find((e) => e.name === CHILD_NAME);
      if (drawnChild === undefined) throw new Error(`子が無い: ${JSON.stringify(drawn.entries)}`);
      // 親の東の端は 179.99 なので、179.99〜180 の細い隙間のぶん（子の 1 %）だけ子より小さい。
      expect(drawn.maxPairOverlapKm2 / (drawnChild.areaKm2 ?? 1)).toBeCloseTo(0.99, 2);

      await reparentChildToWide(page);
      await expectNoConflictBoard(
        page,
        '重なりの板が出た。継ぎ目の反対側の半分が分け残しから引かれていない（B108）',
      );
      await page.getByTestId('tool-edit.select').click();

      const assertKept = async (): Promise<void> => {
        const after = await leafReport(page, {
          names: [CHILD_NAME, directDomainName],
          probes: [SEAM_EAST, SEAM_WEST, ON_LAND],
        });
        const domain = after.entries.find((e) => e.name === directDomainName);
        const child = after.entries.find((e) => e.name === CHILD_NAME);
        if (domain === undefined || child === undefined) {
          throw new Error(`分け残しか子が無い: ${JSON.stringify(after.entries)}`);
        }
        expect(after.maxPairOverlapKm2).toBe(0);
        expect(after.probeOwners).toEqual([child.id, child.id, domain.id]);
      };
      await assertKept();

      await saveOverCopy(page);
      expect(await loadProject(page, copy)).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
      await jumpToYear(page, YEAR);
      await assertKept();
    } finally {
      await app.close();
    }
  });

  test('継ぎ目にかかる子を描いて開き直すと、修復が 1 回で解ける', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    try {
      await openWide(page, copy);
      await drawBox(page, SEAM_CHILD);
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      await saveOverCopy(page);

      // 子を持つ末端が修復の行になる。
      const loading = loadProject(page, copy);
      // 板で止まって落ちるとき、窓を閉じた読み込みの失敗で本当の理由が隠れないようにする。
      loading.catch(() => undefined);
      const board = page.getByTestId('repair-dialog');
      await board.waitFor({ state: 'visible', timeout: 30_000 });
      const materialize = board.locator('[data-testid$="-materialize-direct-domain"]');
      await expect(materialize).toHaveCount(1);
      await materialize.check();
      await page.getByTestId('repair-apply').click();
      await expect(board, '修復の板が閉じない。継ぎ目の半分が引かれず重なりの行が残っている（B108）').toHaveCount(0, {
        timeout: 30_000,
      });
      expect(await loading).toBe('loaded');

      await jumpToYear(page, YEAR);
      const after = await leafReport(page, {
        names: [CHILD_NAME, directDomainName],
        probes: [SEAM_EAST, SEAM_WEST, ON_LAND],
      });
      expect(after.maxPairOverlapKm2).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('上位領域なしで描いて「子を優先」で適用すると、幅いっぱいの面が崩れず確定する', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    try {
      const before = await openWide(page, copy);
      await drawBox(page, CHILD);
      await page.getByTestId('add-parent').selectOption('');
      await page.getByTestId('add-save').click();

      const conflict = page.getByTestId('conflict-dialog');
      await conflict.waitFor({ state: 'visible', timeout: 30_000 });
      // 行は描いた面と幅いっぱいの面の 1 組だけ。描いた面を残す側に選ぶ。
      const policies = await page
        .locator(`[data-testid^="policy-"]:not([data-testid="policy-choice-option"])`)
        .evaluateAll((es) => es.map((e) => e.getAttribute('data-testid')!));
      const keepNew = policies.find((id) => !id.endsWith(`-${WIDE_ID}`));
      if (keepNew === undefined) throw new Error(`描いた面の選択肢が無い: ${policies.join(', ')}`);
      await page.getByTestId(keepNew).check();
      await page.getByTestId('conflict-apply').click();
      await expect(conflict, '板が閉じない。削った面が崩れて偽の重なりが出ている（B105 と同じ崩れ）').toHaveCount(0, {
        timeout: 30_000,
      });

      const assertKept = async (): Promise<void> => {
        const after = await leafReport(page, {
          ids: [WIDE_ID],
          names: [CHILD_NAME],
          probes: [IN_CHILD, ON_LAND],
        });
        const wide = after.entries.find((e) => e.id === WIDE_ID);
        const child = after.entries.find((e) => e.name === CHILD_NAME);
        if (wide === undefined || child === undefined) {
          throw new Error(`面が無い: ${JSON.stringify(after.entries)}`);
        }
        // 削ったぶんだけ減る。
        expect(((wide.areaKm2 ?? 0) + (child.areaKm2 ?? 0)) / before.areaKm2).toBeCloseTo(1, 4);
        expect(wide.ringCount).toBe(before.ringCount + 1);
        expect(after.maxPairOverlapKm2).toBe(0);
        expect(after.probeOwners).toEqual([child.id, WIDE_ID]);
      };
      await assertKept();

      await saveOverCopy(page);
      expect(await loadProject(page, copy)).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
      await jumpToYear(page, YEAR);
      await assertKept();
    } finally {
      await app.close();
    }
  });
});
