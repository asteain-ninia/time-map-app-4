// 増分 2 を **実データ（デーレ界 775 地物）のコピー** で押す。
//
// 合成した 1 地物では出ない条件が 2 つある。
//   ① **まとめ役の子**（実データで 86 件 = 3 つのまとめ役の子ぜんぶ）は自分の歴史を持たず、
//      編集は親の系列に書かれる。素性欄はこれまで錨の欄ごと消えていた（設計書 §C.6 /
//      裁定 §N-15）。合成データでこの形を作るのは骨が折れるうえ、**本物と同じ形である
//      保証がない**。
//   ② 実装計画 増分 2 の完了の定義がそのまま「1200 年でアアウェン州の名前を直す」と
//      書いている。名指しの地物で押す。
//
// ⚠️ 正準ファイルはアプリで直接開かない（開発ガイド §5.48）。アプリは開いたファイルを
// 保存先として昇格するので、一時ディレクトリのコピーを開く。最後に正準ファイルが 1 バイトも
// 動いていないことを確かめる。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import { enterEditMode, jumpToYear, launchAppWithProject, projectStats } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** まとめ役「デーレ共和国」の子。設計書 §A.3 / §C.6 が名指ししている地物。 */
const CHILD_NAME = 'アアウェン州';
const OWNER_NAME = 'デーレ共和国';

/** 一覧を名前で絞り込み、最初の行を選ぶ。 */
async function selectFeatureByName(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('list-mode-current').click();
  await page.getByLabel('地物一覧を名前で絞り込み').fill(name);
  const row = page.locator('[data-testid^="feature-list-item-"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
  await page.getByTestId('sidebar-tab-properties').click();
}

async function anchorRowCount(page: Page): Promise<number> {
  return page.locator('[data-testid^="anchor-row-"]').count();
}

test.describe('増分 2 — 実データのコピーで押す', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('1200 年でアアウェン州の名前を直すと錨が 1 本 → 2 本になり、0 年へ戻すと元の名前', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc2-real-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      const before = await projectStats(page);

      await enterEditMode(page);
      await selectFeatureByName(page, CHILD_NAME);

      // ① **自分の歴史を持たない子**なので、錨の欄は親の系列を借りて出る（§N-15）。
      await expect(page.getByTestId('inherited-anchor-notice')).toContainText(OWNER_NAME);
      const rowsAtStart = await anchorRowCount(page);
      expect(rowsAtStart).toBeGreaterThan(0);

      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await expect(nameInput).toHaveValue(CHILD_NAME);

      // ② 1200 年へ移ると、保存ボタンが「作って保存」に変わる（押す前に読める）。
      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('save-button')).toHaveText('1200年に錨を作って保存');
      // 新しい錨で増える保存量の概算が出る（設計書 §A.3 の「費用」）。
      await expect(page.getByTestId('edit-time-badge-note')).toContainText('ファイルが');

      await nameInput.fill('北アアウェン州');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('錨の新設');

      // 錨が **1 本増えた**（親の系列に 1200 年の錨が立った）。
      const after = await projectStats(page);
      expect(after.anchorCount).toBe(before.anchorCount + 1);
      // 子の画面にも、その子に関わる錨として 1 行増えている。
      await expect.poll(async () => anchorRowCount(page), { timeout: 15_000 }).toBe(
        rowsAtStart + 1,
      );

      // ③ **0 年へ戻すと元の名前**（0 年の錨は黙って書き換わっていない）。
      await jumpToYear(page, 0);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(nameInput).toHaveValue(CHILD_NAME);

      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(nameInput).toHaveValue('北アアウェン州');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    // 正準ファイルが 1 バイトも動いていないこと（コピーを開いた証。開発ガイド §5.48）。
    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
  });

  test('まとめ役の子の錨表には、**その子に関わる錨だけ**が出る（他人の変化を混ぜない）', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc2-sibling-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await enterEditMode(page);

      // 兄弟（同じ親の別の子）を 1200 年で改名する。親の系列に 1200 年の錨が立つ。
      await selectFeatureByName(page, '南ケナ州');
      await expect(page.getByTestId('inherited-anchor-notice')).toContainText(OWNER_NAME);
      const siblingRows = await anchorRowCount(page);

      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-properties').click();
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await nameInput.fill('南ケナ公国');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('statusbar-result')).toContainText('錨の新設');
      await expect.poll(async () => anchorRowCount(page), { timeout: 15_000 }).toBe(
        siblingRows + 1,
      );

      // **アアウェン州の画面には、その 1200 年の錨は出ない**（兄弟の改名は他人の変化）。
      await selectFeatureByName(page, CHILD_NAME);
      await expect(page.getByTestId('inherited-anchor-notice')).toContainText(OWNER_NAME);
      const ownRows = await page
        .locator('[data-testid^="anchor-row-"]')
        .allTextContents();
      expect(ownRows.some((t) => t.includes('1200年'))).toBe(false);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
