// 増分 4 の受け入れ条件のうち、**実データでしか測れない**もの（実装計画 §4）。
//
//   - 「???州」10 件が **画面上で区別できる**（全部デーレ共和国の子なので、〈親名〉でも
//     階層のみちでも区別できず、通し番号と座標まで出さないと足りない）
//   - **台帳で深さ 1 の州を選ぶと、深さ 0 のままでも地図にその州が描かれ、状態行に文が出る**
//     （設計書 §D.6 / C10。旧: カメラは飛ぶのに地図には何も描かれなかった）
//   - 一覧が **階層ツリー** になっている（775 行のフラットではない ＝ C4 / R9）
//
// ⚠️ 正準ファイルはアプリで直接開かない（教訓 5.48）。必ず一時ディレクトリのコピーを開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import { launchAppWithProject, listedFeatureCount } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 実データで表示名が完全に重複する「???州」の件数（現状分析 §7.1）。 */
const QUESTION_STATE_COUNT = 10;

/** いま描かれている地物の id → 実塗色（`window.__E2E__` の観測）。 */
async function readDrawnFills(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const e2e = (
      window as unknown as { __E2E__?: { getDrawnFeatureFills: () => Record<string, string> } }
    ).__E2E__;
    if (e2e === undefined) throw new Error('__E2E__ not ready');
    return e2e.getDrawnFeatureFills();
  });
}

/**
 * 仮想スクロールなので、見分けの文字列は **スクロールしながら集める**。
 * 一度に DOM へ載るのは窓に入るぶんだけである（それが仮想スクロールの意味）。
 */
async function collectQualifiers(page: Page): Promise<Set<string>> {
  const seen = new Set<string>();
  const scroller = page.getByTestId('ledger-scroller');
  const total = await scroller.evaluate((el) => el.scrollHeight);
  const step = await scroller.evaluate((el) => Math.max(el.clientHeight - 28, 28));
  for (let top = 0; top <= total; top += step) {
    await scroller.evaluate((el, y) => {
      el.scrollTop = y;
    }, top);
    await page.waitForTimeout(60);
    const texts = await page.locator('[data-testid^="ledger-qualifier-"]').allTextContents();
    for (const t of texts) seen.add(t.trim());
  }
  return seen;
}

test.describe('増分 4 — 実データ（デーレ界）', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('「???州」10 件が画面上で区別できる（通し番号と座標まで出る）', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc4-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      // 平（絞り込み結果を平らに見る）にして「???」で絞る。
      await page.getByTestId('list-shape-flat').click();
      // 「???」だけだと 150 件当たる（「???島」など別の仮名も含むため）。
      await page.getByTestId('unified-list-filter').fill('???州');
      await expect(page.getByTestId('unified-list-count')).toHaveText(
        `${String(QUESTION_STATE_COUNT)} / 775件`,
      );
      expect(await listedFeatureCount(page)).toBe(QUESTION_STATE_COUNT);

      // **10 件それぞれが違う見分けを持つ。** 〈親名〉だけなら 10 行とも
      // 「〈デーレ共和国〉」になり、区別できない（設計書 §O の GPT V4）。
      const qualifiers = await collectQualifiers(page);
      expect(qualifiers.size).toBe(QUESTION_STATE_COUNT);
      // 段が 3 段目（通し番号と座標）まで上がっている証: 方位の文字が入っている。
      for (const q of qualifiers) {
        expect(q).toMatch(/[北南]\d/);
      }
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('一覧が階層ツリーになっている（775 行のフラットではない）', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc4-tree-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      // 件数は 775 のまま（母集団は変わらない）。
      await expect(page.getByTestId('unified-list-count')).toHaveText('775件');
      // **DOM に載るのは窓に入るぶんだけ**（仮想スクロール）。
      const domRows = await page.locator('[data-testid^="ledger-row-"]').count();
      expect(domRows).toBeGreaterThan(0);
      expect(domRows).toBeLessThanOrEqual(20);
      // **畳んである親が居る**（＝木になっている。フラットなら展開の三角は 1 つも無い）。
      // 仮想スクロールなので窓に入るぶんしか DOM に無い ―― まとめ役を絞り込んで出す。
      await page.getByTestId('unified-list-filter').fill('デーレ共和国');
      await expect
        .poll(async () => page.locator('[data-testid^="ledger-expand-"]').count())
        .toBeGreaterThan(0);
      // 三角を押すと **絞り込みに当たらない子** が現れる（＝畳み込みが効いている）。
      // 行の DOM 数では見ない ―― 仮想スクロールなので窓の行数で頭打ちになる（教訓 5.59）。
      const names = async (): Promise<string[]> =>
        page
          .locator('[data-testid^="feature-list-item-"]')
          .allTextContents()
          .then((xs) => xs.map((x) => x.trim()));
      expect((await names()).every((n) => n.includes('デーレ共和国'))).toBe(true);
      await page.locator('[data-testid^="ledger-expand-"]').first().click();
      await expect
        .poll(async () => (await names()).some((n) => !n.includes('デーレ共和国')))
        .toBe(true);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('深さ 1 の州を台帳で選ぶと、深さ 0 のままでも地図に描かれ、状態行に文が出る', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc4-depth-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      // 深さは既定（0）のまま触らない。
      await page.getByTestId('unified-list-filter').fill('アアウェン');
      await expect(page.locator('[data-testid^="feature-list-item-"]').first()).toBeVisible();

      // 深さ 0 の表示で **描かれていない**行を 1 つ選ぶ（＝親へ畳まれている深さ 1 の州）。
      // 絞り込みの先頭はまとめ役のことがあるので、描画の集合と突き合わせて選ぶ。
      const before = await readDrawnFills(page);
      const drawn = new Set(Object.keys(before));
      const ids = await page
        .locator('[data-testid^="feature-list-item-"]')
        .evaluateAll((els) =>
          els.map((el) => (el.getAttribute('data-testid') ?? '').replace('feature-list-item-', '')),
        );
      const featureId = ids.find((id) => id !== '' && !drawn.has(id));
      expect(featureId, '深さ 0 で描かれていない行が 1 つは要る').toBeDefined();
      if (featureId === undefined) return;
      const row = page.getByTestId(`feature-list-item-${featureId}`);

      await row.click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(featureId);

      // 選んだあと: **深さ 0 のままでも描かれている**（設計書 §D.6 の規則 1）。
      await expect
        .poll(async () => Object.keys(await readDrawnFills(page)).includes(featureId))
        .toBe(true);

      // **状態行に文が出る**（黙って特別扱いしない ＝ 規則 2）。
      await expect(page.getByTestId('statusbar-result')).toContainText('深さ');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
