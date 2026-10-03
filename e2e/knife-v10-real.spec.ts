// 増分 8B — V10「3000 年にアルラーク国を分割する」を実データで固定する（①南北 ②東西）。
//
// 直したもの（ドメイン）: まっすぐな分断線が凹んだ国を何度も横切ると「分断線が自己交差して
// います」と誤って断られていた（N-08）。実データのアルラーク国では、面を横切る水平線の
// 55%・垂直線の 50% が断られ、境界を 4 回以上横切る線は 1 本も通らなかった。いまは通り、
// 切った回数に応じて 3 片以上に分かれる。
//
// この spec が見ること:
//   ① 南北に分ける（水平の 2 点線。緯度 61°: 境界を 6 回横切る帯の真ん中）
//   ② 東西に分ける（垂直の 2 点線。経度 70°: 境界を 4 回横切る帯の真ん中）
//   のどちらも、断りが出ずに継承先の板へ進み、片が 3 つ以上並び、片が「番号（方角・面積）」で
//   呼ばれ、選んだ片が元の名前を引き継ぐ 1 文が出て、保存すると地物が（片の数 − 1）件増える。
//   保存の間は進行表示（「分割しています…」）が出ることも見る（実装計画 8B の中身 3）。
//   確定にかかった時間はログに出す（進捗の実測に使う）。
//
// 実データの置き場: 環境変数 DERLE_TMAP_DIR（無ければリポジトリ直下の derle-import/）。
// ファイルが無ければ飛ばす。⚠️ 正準ファイルは開かない ―― 一時ディレクトリへ複写して開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import { enterEditMode, jumpToYear, launchAppWithProject, listedFeatureCount } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** アルラーク国（3000 年）の外接矩形と、内側に必ず入る点（探針で求めた値）。 */
const ALRUK = {
  name: 'アルラーク国',
  minLon: 65.41,
  maxLon: 125.8,
  minLat: 36.09,
  maxLat: 74.96,
  inside: { lon: 96.6, lat: 57.37 },
} as const;

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

/** アルラーク国が地図セルに大きく収まるまでホイールで寄せる。 */
async function zoomToAlruk(page: Page): Promise<Affine> {
  const box = (await page.getByTestId('map-area').boundingBox())!;
  for (let i = 0; i < 8; i += 1) {
    const m = await measureAffine(page);
    const a = toScreen(m, ALRUK.minLon - 1, ALRUK.maxLat + 1);
    const b = toScreen(m, ALRUK.maxLon + 1, ALRUK.minLat - 1);
    const width = b.x - a.x;
    const height = b.y - a.y;
    // 外接矩形（＋余白）が地図セルの 6 割を超えたら十分。
    if (width > box.width * 0.6 || height > box.height * 0.6) return m;
    const c = toScreen(m, (ALRUK.minLon + ALRUK.maxLon) / 2, (ALRUK.minLat + ALRUK.maxLat) / 2);
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

async function splitAlruk(
  page: Page,
  line: readonly [{ lon: number; lat: number }, { lon: number; lat: number }],
  label: string,
): Promise<void> {
  await jumpToYear(page, 3000);
  await page.getByTestId('sidebar-tab-list').click();
  const countBefore = await listedFeatureCount(page);

  const m = await zoomToAlruk(page);
  const box = (await page.getByTestId('map-area').boundingBox())!;
  const inside = toScreen(m, ALRUK.inside.lon, ALRUK.inside.lat);
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
  await expect(page.getByTestId('option-bar-target')).toContainText(ALRUK.name);
  // N-10: 0 点のうちは確定を押せない。
  await expect(page.getByTestId('knife-confirm-cut')).toBeDisabled();

  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await expect(page.getByTestId('knife-cut-count')).toHaveText('2');
  await expect(page.getByTestId('knife-confirm-cut')).toBeEnabled();

  const t0 = Date.now();
  await page.getByTestId('knife-confirm-cut').click();
  // 断られていない（以前は「分断線が自己交差しています」が出た）。
  const modal = page.getByTestId('knife-inheritor-dialog');
  await expect(modal).toBeVisible({ timeout: 15_000 });
  const tCut = Date.now() - t0;
  await expect(page.getByTestId('knife-rejected')).toHaveCount(0);

  // 片が 3 つ以上（境界を 4 回以上横切るまっすぐな線＝以前は必ず断られた線）。
  await expect(page.getByTestId('knife-choose-2')).toBeVisible();
  const pieceCount = await page.locator('[data-testid^="knife-choose-"]').count();
  expect(pieceCount).toBeGreaterThanOrEqual(3);
  // N-09: 「面 1」ではなく番号（方角・面積）で呼ぶ。選んだ片が元の名前を引き継ぐ 1 文。
  const first = (await page.getByTestId('knife-choose-0').textContent()) ?? '';
  expect(first).toMatch(/^1（(北|北東|東|南東|南|南西|西|北西|中央)・.+ km²）$/);
  await page.getByTestId('knife-choose-0').click();
  await expect(page.getByTestId('knife-inherit-sentence')).toContainText(
    `「${ALRUK.name}」として残り`,
  );
  // アルラーク国は穴も飛び地も無いので、2 つにまとまる注記は出ない。
  await expect(page.getByTestId('knife-two-pieces-note')).toHaveCount(0);

  await page.getByTestId('knife-confirm-inheritor').click();
  await expect(page.getByTestId('add-property-form')).toBeVisible();
  await page.getByTestId('add-name').fill(`${label}の新しい片`);

  await watchSaveBusy(page);
  const t1 = Date.now();
  await page.getByTestId('add-save').click();
  await expect(page.getByTestId('add-property-form')).toHaveCount(0, {
    timeout: 30_000,
  });
  const tSave = Date.now() - t1;
  const busySeen = await page.evaluate(
    () => (window as unknown as { __knifeBusySeen?: boolean }).__knifeBusySeen === true,
  );
  console.log(
    `KNIFE-V10 ${label}: pieces=${String(pieceCount)} confirmCut=${String(tCut)}ms save=${String(tSave)}ms busySeen=${String(busySeen)}`,
  );
  // 中身 3: 保存の間に進行表示が出ていた（1 コマ描いてから走るので、必ず 1 度は出る）。
  expect(busySeen).toBe(true);

  // 地物が（片の数 − 1）件増えた。
  await expect
    .poll(async () => listedFeatureCount(page), { timeout: 15_000 })
    .toBe(countBefore + pieceCount - 1);
}

test.describe('増分 8B — V10 実データのアルラーク国を分割する', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('① 南北に分ける: 水平の 2 点線が断られず、3 片以上に分かれて保存できる', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-v10-ns-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await splitAlruk(
        page,
        [
          { lon: ALRUK.minLon - 1.5, lat: 61.0 },
          { lon: ALRUK.maxLon + 1.5, lat: 61.0 },
        ],
        '南北',
      );
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('② 東西に分ける: 垂直の 2 点線が断られず、3 片以上に分かれて保存できる', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-v10-ew-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await splitAlruk(
        page,
        [
          { lon: 70.0, lat: ALRUK.maxLat + 1.5 },
          { lon: 70.0, lat: ALRUK.minLat - 1.5 },
        ],
        '東西',
      );
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
