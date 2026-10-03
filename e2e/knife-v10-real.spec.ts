// 増分 8B — V10「3000 年にアルラーク国を分割する」を実データで固定する（①南北 ②東西）。
// 手直しで ③（穴のある湾の腕を 1 本だけ切る＝B69）を足した。
//
// 直したもの（ドメイン）: まっすぐな分断線が凹んだ国を何度も横切ると「分断線が自己交差して
// います」と誤って断られていた（N-08）。実データのアルラーク国では、面を横切る水平線の
// 55%・垂直線の 50% が断られ、境界を 4 回以上横切る線は 1 本も通らなかった。いまは通り、
// 切った回数に応じて 3 片以上に分かれる。
//
// この spec が見ること:
//   ① 南北に分ける（水平の 2 点線。緯度 61°: 境界を 6 回横切る帯の真ん中）→ ちょうど 4 片
//   ② 東西に分ける（垂直の 2 点線。経度 70°: 境界を 4 回横切る帯の真ん中）→ ちょうど 3 片
//   のどちらも、断りが出ずに継承先の板へ進み、片が「番号（方角・面積）」で呼ばれ、選んだ片が
//   元の名前を引き継ぐ 1 文が出て、次の一手に「この名前と種別は n 片すべてに付きます」が出て、
//   保存すると地物が（片の数 − 1）件増える。保存の間は進行表示（「分割しています…」）が出る
//   （実装計画 8B の中身 3）。確定にかかった時間はログに出す（進捗の実測に使う）。
//   手直しで、結果を **表示と独立に** ドメインの値で見るようにした（GPT 審査の重 2）:
//   元の地物の id・名前・色・種別・錨列、新しい片の数と名前、全片の面積の合計と重なり、
//   Ctrl+Z 1 回で元に戻ること。読み口は `__E2E_HARNESS__.getLeafReport`（helpers の leafReport）。
//   ③ 穴のある湾（トランツィ湾）の西の腕だけを横切る線 → 2 片で、東の腕は切られない。
//
// 実データの置き場: 環境変数 DERLE_TMAP_DIR（無ければリポジトリ直下の derle-import/）。
// ファイルが無ければ飛ばす。⚠️ 正準ファイルは開かない ―― 一時ディレクトリへ複写して、
// 投入口（`__E2E_HARNESS__.loadProject`。`launchAppWithProject` が呼ぶ）で開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import {
  enterEditMode,
  jumpToYear,
  launchAppWithProject,
  leafReport,
  listedFeatureCount,
} from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 切る対象（3000 年）の外接矩形と、内側に必ず入る点（探針で求めた値）。 */
interface Target {
  readonly name: string;
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
  readonly inside: { readonly lon: number; readonly lat: number };
}

const ALRUK: Target = {
  name: 'アルラーク国',
  minLon: 65.41,
  maxLon: 125.8,
  minLat: 36.09,
  maxLat: 74.96,
  inside: { lon: 96.6, lat: 57.37 },
};

/**
 * トランツィ湾（3000 年。島を穴に持つ湾＝外周 1 つと穴 4 つ）。増分 8B の手直し（B69）で
 * 「腕を 1 本だけ横切る短い線が、引いていない別の腕まで切る」を実データで固定するのに使う。
 * 内側の点は境界から 2.0° 離れている（探針 `bay.probe.test.ts`）。
 */
const TRANZI: Target = {
  name: 'トランツィ湾',
  minLon: -123.67,
  maxLon: -103.88,
  minLat: 30.1,
  maxLat: 42.23,
  inside: { lon: -112.786, lat: 32.73 },
};

interface Affine {
  readonly ax: number;
  readonly bx: number;
  readonly ay: number;
  readonly by: number;
}

/** 生きている描画の逆変換（`__E2E__.screenToWorld`）を 2 点で測って、世界→画面の式を作る。 */
async function measureAffine(page: Page): Promise<Affine> {
  const box = (await page.getByTestId('map-area').boundingBox())!;
  const x0 = box.x + box.width * 0.25;
  const x1 = box.x + box.width * 0.75;
  const y0 = box.y + box.height * 0.25;
  const y1 = box.y + box.height * 0.75;
  const [p0, p1] = await page.evaluate(
    ([a, b, c, d]) => {
      const w = window as unknown as {
        __E2E__: {
          screenToWorld: (x: number, y: number) => { lon: number; lat: number } | null;
        };
      };
      return [w.__E2E__.screenToWorld(a, c), w.__E2E__.screenToWorld(b, d)];
    },
    [x0, x1, y0, y1] as const,
  );
  if (p0 === null || p1 === null) throw new Error('screenToWorld が使えない');
  const ax = (p1.lon - p0.lon) / (x1 - x0);
  const ay = (p1.lat - p0.lat) / (y1 - y0);
  return { ax, bx: p0.lon - ax * x0, ay, by: p0.lat - ay * y0 };
}

function toScreen(m: Affine, lon: number, lat: number): { x: number; y: number } {
  return { x: (lon - m.bx) / m.ax, y: (lat - m.by) / m.ay };
}

/**
 * 対象が地図セルに大きく収まるまでホイールで寄せる。寄せすぎて外接矩形（＋分断線の端の
 * 余白 2°）が地図セルからはみ出したら、1 段戻して止める（1 段の倍率は画面の大きさで違う）。
 */
async function zoomTo(page: Page, target: Target): Promise<Affine> {
  const box = (await page.getByTestId('map-area').boundingBox())!;
  for (let i = 0; i < 12; i += 1) {
    const m = await measureAffine(page);
    const a = toScreen(m, target.minLon - 2, target.maxLat + 2);
    const b = toScreen(m, target.maxLon + 2, target.minLat - 2);
    const fits =
      a.x > box.x + 4 &&
      b.x < box.x + box.width - 4 &&
      a.y > box.y + 4 &&
      b.y < box.y + box.height - 4;
    if (!fits && i > 0) {
      const c0 = toScreen(m, (target.minLon + target.maxLon) / 2, (target.minLat + target.maxLat) / 2);
      await page.mouse.move(c0.x, c0.y);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(150);
      return measureAffine(page);
    }
    const width = b.x - a.x;
    const height = b.y - a.y;
    // 外接矩形（＋余白）が地図セルの 6 割を超えたら十分。
    if (width > box.width * 0.6 || height > box.height * 0.6) return m;
    const c = toScreen(m, (target.minLon + target.maxLon) / 2, (target.minLat + target.maxLat) / 2);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);
  }
  return measureAffine(page);
}

function expectInsideMap(
  box: { x: number; y: number; width: number; height: number },
  p: { x: number; y: number },
  label: string,
): void {
  expect(p.x, `${label} が地図セルの左右に収まる`).toBeGreaterThan(box.x + 4);
  expect(p.x, `${label} が地図セルの左右に収まる`).toBeLessThan(box.x + box.width - 4);
  expect(p.y, `${label} が地図セルの上下に収まる`).toBeGreaterThan(box.y + 4);
  expect(p.y, `${label} が地図セルの上下に収まる`).toBeLessThan(box.y + box.height - 4);
}

/**
 * 進行表示が 1 度でも出たかを記録する見張りを仕掛ける（1 コマだけ出て消える場合も拾う）。
 */
async function watchSaveBusy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __knifeBusySeen?: boolean };
    w.__knifeBusySeen = false;
    const obs = new MutationObserver(() => {
      if (document.querySelector('[data-testid="add-save-busy"]') !== null) {
        w.__knifeBusySeen = true;
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

/** 対象を掴んで 2 点の分断線を引き、［分断線を確定］で継承先の板まで進める。 */
async function drawCut(
  page: Page,
  target: Target,
  line: readonly [{ lon: number; lat: number }, { lon: number; lat: number }],
): Promise<number> {
  const m = await zoomTo(page, target);
  const box = (await page.getByTestId('map-area').boundingBox())!;
  const inside = toScreen(m, target.inside.lon, target.inside.lat);
  const a = toScreen(m, line[0].lon, line[0].lat);
  const b = toScreen(m, line[1].lon, line[1].lat);
  expectInsideMap(box, inside, '対象の内側の点');
  expectInsideMap(box, a, '分断線の始点');
  expectInsideMap(box, b, '分断線の終点');

  await enterEditMode(page);
  const knifeTool = page.getByTestId('tool-edit.knife');
  await knifeTool.click();
  await expect(knifeTool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('knife-input-layer')).toBeVisible();

  // 対象を掴む。
  await page.mouse.click(inside.x, inside.y);
  await expect(page.getByTestId('option-bar-target')).toContainText(target.name);
  // N-10: 0 点のうちは確定を押せない。
  await expect(page.getByTestId('knife-confirm-cut')).toBeDisabled();

  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await expect(page.getByTestId('knife-cut-count')).toHaveText('2');
  await expect(page.getByTestId('knife-confirm-cut')).toBeEnabled();

  const t0 = Date.now();
  await page.getByTestId('knife-confirm-cut').click();
  // 断られていない（以前は「分断線が自己交差しています」が出た）。
  await expect(page.getByTestId('knife-inheritor-dialog')).toBeVisible({ timeout: 15_000 });
  const tCut = Date.now() - t0;
  await expect(page.getByTestId('knife-rejected')).toHaveCount(0);
  return tCut;
}

/** 素性欄に名前を入れて［保存］し、進行表示が出たかと保存にかかった時間を返す。 */
async function saveNewPieces(
  page: Page,
  name: string,
): Promise<{ readonly tSave: number; readonly busySeen: boolean }> {
  await expect(page.getByTestId('add-property-form')).toBeVisible();
  await page.getByTestId('add-name').fill(name);
  await watchSaveBusy(page);
  const t1 = Date.now();
  await page.getByTestId('add-save').click();
  await expect(page.getByTestId('add-property-form')).toHaveCount(0, { timeout: 30_000 });
  const tSave = Date.now() - t1;
  const busySeen = await page.evaluate(
    () => (window as unknown as { __knifeBusySeen?: boolean }).__knifeBusySeen === true,
  );
  return { tSave, busySeen };
}

/**
 * アルラーク国を 2 点の線で切って保存し、結果を **表示と独立に** 確かめる（GPT 審査の重 2）。
 *
 * - 片の数は **この固定入力での正解の数**（南北 4・東西 3）を要求する（「3 以上」では、片が
 *   1 つ欠けた結果でも通ってしまう）。
 * - 元の地物は同じ id・名前・色・種別のまま残り、錨列の開始年は前のものをすべて保つ。
 * - 新しい片は「片の数 − 1」件で、素性欄の名前を持つ。
 * - 全片の面積の合計が元の面積に一致し、どの 2 片も重ならない（U06 の共通部分で測る）。
 * - Ctrl+Z 1 回で元の 1 地物に戻る（面積・錨列も元どおり、新しい片は消える）。
 */
async function splitAlruk(
  page: Page,
  line: readonly [{ lon: number; lat: number }, { lon: number; lat: number }],
  label: string,
  expectedPieces: number,
): Promise<void> {
  await jumpToYear(page, 3000);
  await page.getByTestId('sidebar-tab-list').click();
  const countBefore = await listedFeatureCount(page);

  const before = await leafReport(page, { names: [ALRUK.name] });
  expect(before.entries, `${ALRUK.name} がちょうど 1 件`).toHaveLength(1);
  const original = before.entries[0]!;
  const originalArea = original.areaKm2!;

  const tCut = await drawCut(page, ALRUK, line);
  // 片の数はこの入力の正解の数ちょうど。
  await expect(page.locator('[data-testid^="knife-choose-"]')).toHaveCount(expectedPieces);
  const pieceCount = expectedPieces;
  // N-09: 「面 1」ではなく番号（方角・面積）で呼ぶ。選んだ片が元の名前を引き継ぐ 1 文。
  const first = (await page.getByTestId('knife-choose-0').textContent()) ?? '';
  expect(first).toMatch(/^1（(北|北東|東|南東|南|南西|西|北西|中央)・.+ km²）$/);
  await page.getByTestId('knife-choose-0').click();
  await expect(page.getByTestId('knife-inherit-sentence')).toContainText(
    `「${ALRUK.name}」として残り`,
  );
  // アルラーク国は穴も飛び地も無いので、2 つにまとまる注記も、延ばした先で切れた注記も出ない。
  await expect(page.getByTestId('knife-two-pieces-note')).toHaveCount(0);
  await expect(page.getByTestId('knife-beyond-line-note')).toHaveCount(0);

  await page.getByTestId('knife-confirm-inheritor').click();
  // 名前が何片に付くかを、次の一手の先頭で言う（新しい片が 2 つ以上のとき）。
  await expect(page.getByTestId('option-bar-next-step')).toContainText(
    `この名前と種別は ${String(pieceCount - 1)} 片すべてに付きます`,
  );
  const newName = `${label}の新しい片`;
  const { tSave, busySeen } = await saveNewPieces(page, newName);
  console.log(
    `KNIFE-V10 ${label}: pieces=${String(pieceCount)} confirmCut=${String(tCut)}ms save=${String(tSave)}ms busySeen=${String(busySeen)}`,
  );
  // 中身 3: 保存の間に進行表示が出ていた（1 コマ描いてから走るので、必ず 1 度は出る）。
  expect(busySeen).toBe(true);

  // 地物が（片の数 − 1）件増えた（一覧の表示）。
  await expect
    .poll(async () => listedFeatureCount(page), { timeout: 15_000 })
    .toBe(countBefore + pieceCount - 1);

  // ドメインの値で確かめる（表示と独立）。
  const after = await leafReport(page, { ids: [original.id], names: [newName] });
  const kept = after.entries.filter((e) => e.id === original.id);
  const minted = after.entries.filter((e) => e.id !== original.id);
  expect(kept, '元の地物が同じ id で残る').toHaveLength(1);
  expect(kept[0]!.name).toBe(ALRUK.name);
  expect(kept[0]!.color).toEqual(original.color);
  expect(kept[0]!.kindLabel).toBe(original.kindLabel);
  for (const year of original.anchorStartYears ?? []) {
    expect(kept[0]!.anchorStartYears, `錨列の ${String(year)} 年を保つ`).toContain(year);
  }
  expect(minted, '新しい片は（片の数 − 1）件').toHaveLength(pieceCount - 1);
  for (const e of minted) expect(e.name).toBe(newName);
  expect(Math.abs(after.totalAreaKm2 - originalArea) / originalArea).toBeLessThan(1e-6);
  expect(after.maxPairOverlapKm2).toBeLessThan(originalArea * 1e-9);

  // V10 の「取り消し」: Ctrl+Z 1 回で元の 1 地物に戻る（設計適合 1-6）。
  await expect(page.getByTestId('app-focus-owner')).toHaveText('map');
  await page.keyboard.press('Control+z');
  await expect
    .poll(
      async () =>
        (await leafReport(page, { ids: [original.id], names: [newName] })).entries.length,
      { timeout: 15_000 },
    )
    .toBe(1);
  const undone = await leafReport(page, { ids: [original.id] });
  expect(Math.abs(undone.entries[0]!.areaKm2! - originalArea) / originalArea).toBeLessThan(1e-9);
  expect(undone.entries[0]!.anchorStartYears).toEqual(original.anchorStartYears);
}

/** 実データを一時ディレクトリへ複写して開き、終わったら閉じて消す（正準ファイルは開かない）。 */
async function withRealDataCopy(
  prefix: string,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  const workingCopy = join(workDir, REAL_DATA_FILE);
  copyFileSync(canonicalPath, workingCopy);
  const { app, page } = await launchAppWithProject(workingCopy);
  try {
    await body(page);
  } finally {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

test.describe('増分 8B — V10 実データのアルラーク国を分割する', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('① 南北に分ける: 水平の 2 点線が断られず、4 片に分かれて保存でき、取り消せる', async () => {
    test.setTimeout(240_000);
    await withRealDataCopy('tmap-e2e-v10-ns-', (page) =>
      splitAlruk(
        page,
        [
          { lon: ALRUK.minLon - 1.5, lat: 61.0 },
          { lon: ALRUK.maxLon + 1.5, lat: 61.0 },
        ],
        '南北',
        4,
      ),
    );
  });

  test('② 東西に分ける: 垂直の 2 点線が断られず、3 片に分かれて保存でき、取り消せる', async () => {
    test.setTimeout(240_000);
    await withRealDataCopy('tmap-e2e-v10-ew-', (page) =>
      splitAlruk(
        page,
        [
          { lon: 70.0, lat: ALRUK.maxLat + 1.5 },
          { lon: 70.0, lat: ALRUK.minLat - 1.5 },
        ],
        '東西',
        3,
      ),
    );
  });

  // 増分 8B の手直し（B69 / GPT 重 3・反証 2-1）: 穴のある湾で、腕を 1 本だけ横切る短い線が
  // 引いていない別の腕まで切らない。直す前は、線を遠い枠まで延ばした切り抜き形で切っていたので、
  // 同じ緯度にある東の腕まで上下 2 つに割れていた（探針 `bay.probe.test.ts` で直す前と比べた）。
  test('③ 穴のある湾の腕を 1 本だけ横切る線は、引いた所だけを切る（B69）', async () => {
    test.setTimeout(240_000);
    await withRealDataCopy('tmap-e2e-v10-bay-', async (page) => {
      await jumpToYear(page, 3000);
      const v = 30.7076;
      // 切る腕の上下と、同じ緯度にある東の腕（引いていない所）の上下。
      const probes = [
        { lon: -113.25, lat: v + 0.1 },
        { lon: -113.25, lat: v - 0.1 },
        { lon: -110.7, lat: v + 0.1 },
        { lon: -110.7, lat: v - 0.1 },
      ];
      const before = await leafReport(page, { names: [TRANZI.name], probes });
      expect(before.entries, `${TRANZI.name} がちょうど 1 件`).toHaveLength(1);
      const bay = before.entries[0]!;
      expect(bay.ringCount, '島を穴に持つ').toBeGreaterThan(1);
      // 4 点とも切る前は湾の内側（点の選び方が正しいことの確かめ）。
      expect(before.probeOwners).toEqual([bay.id, bay.id, bay.id, bay.id]);

      // 西の腕だけを横切る線（終点 -111.79 は 2 つの腕の間＝面の外）。
      await drawCut(page, TRANZI, [
        { lon: -115.5, lat: v },
        { lon: -111.79, lat: v },
      ]);
      // 引いた所だけを切るので 2 片。延ばした先で切った注記も、2 つにまとまる注記も出ない。
      await expect(page.locator('[data-testid^="knife-choose-"]')).toHaveCount(2);
      await expect(page.getByTestId('knife-beyond-line-note')).toHaveCount(0);
      await expect(page.getByTestId('knife-two-pieces-note')).toHaveCount(0);
      // 既定の継承先（いちばん大きい片）のまま確定する。
      await page.getByTestId('knife-confirm-inheritor').click();
      await expect(page.getByTestId('add-property-form')).toBeVisible();
      await expect(page.getByTestId('option-bar-next-step')).not.toContainText('片すべてに付きます');
      const newName = '湾の切れ端';
      await saveNewPieces(page, newName);

      const after = await leafReport(page, { ids: [bay.id], names: [newName], probes });
      expect(after.entries).toHaveLength(2);
      const piece = after.entries.find((e) => e.id !== bay.id)!;
      expect(piece.name).toBe(newName);
      // 切った腕は上下が別の地物になり、東の腕は上下とも元の湾のまま（切られていない）。
      expect(after.probeOwners[0]).toBe(bay.id);
      expect(after.probeOwners[1]).toBe(piece.id);
      expect(after.probeOwners[2]).toBe(bay.id);
      expect(after.probeOwners[3]).toBe(bay.id);
      expect(Math.abs(after.totalAreaKm2 - bay.areaKm2!) / bay.areaKm2!).toBeLessThan(1e-6);
      expect(after.maxPairOverlapKm2).toBeLessThan(bay.areaKm2! * 1e-9);
      const kept = after.entries.find((e) => e.id === bay.id)!;
      expect(kept.name).toBe(TRANZI.name);
      expect(kept.color).toEqual(bay.color);
    });
  });
});
