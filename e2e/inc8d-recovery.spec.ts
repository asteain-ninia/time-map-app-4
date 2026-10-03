// 増分 8D「復旧と設定」— V14（壊れたときに戻す）と V12 の④（自動保存を設定する）を実アプリで固定する。
//
// - V14 (a) 世代から戻す: ファイル →「以前の保存から開く」→ 一覧（日時・大きさ・地物数）→
//   行を押す → 未保存の確認 → 開く。**開いた直後の Ctrl+S は「名前を付けて保存」に落ち、
//   世代そのものも元のファイルも 1 バイトも書き換わらない**（設計書 §E.1 の V14 の規則 ①②）。
// - V14 (b) 壊れたファイルを修復する: 修復ダイアログが出て、直し方が 1 つしか無い行は
//   ラジオを出さずに「こう直します」と書くだけ。読んで［修復して読み込む］を押すだけで開ける。
// - V12 の④: 設定 →「保存とバックアップ」→ 間隔・世代数 →［適用］。世代数が主プロセスに
//   **本当に効いている**ことを、保存を 3 回して世代が 2 つしか残らないことで確かめる。
//   値は再起動しても残る（userData の app-prefs.json。ワーカーごとに隔離されている）。
//
// 実データは使わない（新規プロジェクトに面を描いて保存したものを、一時ディレクトリで使う）。
// 名前を付けて保存の行き先は E2E 専用の脱出口 `E2E_SAVE_AS_PATH` で渡す（OS のダイアログは
// Playwright から操作できない）。行き先は起動ごとに 1 つなので、戻したあとの保存を
// 「別の名前の新しいファイルができた」で見分けるために、2 回目は別の行き先で起動し直す。

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { test, expect, type Page } from '@playwright/test';

import { commitOneFace, enterEditMode, launchApp, loadProject } from './helpers';

/** `dir` にある `baseName` の世代のファイル名（古い順）。 */
function backupsIn(dir: string, baseName: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${baseName}.bak.`))
    .sort();
}

/** 新規プロジェクトに面を 1 つ描いて Ctrl+S（＝名前を付けて保存へ落ちる）し、保存を待つ。 */
async function drawAndSaveAs(page: Page): Promise<void> {
  await commitOneFace(page);
  await enterEditMode(page);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
}

/** 同じ保存先へもう一度 Ctrl+S する（確認は初回の名前を付けて保存で済んでいる）。 */
async function saveAgain(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // 状態行の文が同じなので、書けたことは「最終保存」の時刻ではなく結果の再描画で待つ。
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('overwrite-dialog')).toHaveCount(0);
    await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
    // 同じミリ秒の保存でも連番で別の世代になるが、待ちを挟んで順序を確かにする。
    await page.waitForTimeout(50);
  }
}

/**
 * 未保存の変更を作る（プロジェクト名を変える）。面を描き足す形にすると、開いたファイルの
 * 面と重なって重なり解決の板が出ることがあるので、設定の名前で確実に汚す。
 */
async function makeDirtyByRenaming(page: Page, name: string): Promise<void> {
  await enterEditMode(page);
  await openSettings(page);
  await page.getByLabel('プロジェクト名').fill(name);
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
  await expect(page.getByTestId('app-identity-dirty')).toHaveCount(1);
}

/** ツール メニューから設定を開く。 */
async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('menu-tools').click();
  await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
}

/** ファイル メニューから「以前の保存から開く」を押す（設計書 V14 の手順 (a) の 1 手目）。 */
async function openBackupFromMenu(page: Page): Promise<void> {
  await page.getByTestId('menu-file').click();
  const item = page.getByTestId('menu-items-file').locator('[data-command="file.openBackup"]');
  await expect(item).toBeEnabled();
  await item.click();
}

test.describe('増分 8D: 復旧と設定（V14・V12 の④）', () => {
  test('V14 (a): 世代から戻すと保存先は未確定になり、直後の Ctrl+S は名前を付けて保存へ落ちる（世代も元のファイルも書き換わらない）', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-8d-restore-'));
    const original = join(workDir, 'original.gimoza');
    const restoredTarget = join(workDir, 'restored.gimoza');
    try {
      // --- 1 回目の起動: 保存を 2 回して世代を 2 つ作る -------------------------------
      {
        const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: original } });
        try {
          await drawAndSaveAs(page);
          await saveAgain(page, 1);
        } finally {
          await app.close();
        }
      }
      const generations = backupsIn(workDir, 'original.gimoza');
      expect(generations).toHaveLength(2);
      const backupBytes = new Map(generations.map((n) => [n, readFileSync(join(workDir, n))]));
      const originalBytes = readFileSync(original);

      // --- 2 回目の起動: 元のファイルを開き、編集して、世代から戻す ------------------------
      const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: restoredTarget } });
      try {
        expect(await loadProject(page, original)).toBe('loaded');
        await expect(page.getByTestId('app-identity-file')).toHaveText('original.gimoza');
        // 未保存の変更を作る（未保存の確認を通る経路にする）。
        await makeDirtyByRenaming(page, '戻す前の編集');

        // ①メニュー → ②一覧を読む（日時・大きさ・地物数）
        await openBackupFromMenu(page);
        const rows = page.getByTestId('backup-row');
        await expect(rows).toHaveCount(2);
        await expect(page.getByTestId('backup-intro')).toContainText('original.gimoza');
        await expect(page.getByTestId('backup-row-saved-at').first()).toHaveText(
          /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
        );
        await expect(page.getByTestId('backup-row-size').first()).toHaveText(/(KB|MB|バイト)$/);
        await expect(page.getByTestId('backup-row-features').first()).toHaveText('1 件');

        // ③行を押す → ④未保存の確認（「開く」と同じ器）→ 保存せずに続行
        await rows.first().click();
        await expect(page.getByTestId('backup-dialog')).toHaveCount(0);
        await expect(page.getByTestId('unsaved-dialog')).toBeVisible();
        await page.getByTestId('unsaved-discard').click();

        // 開けた: アプリバーは「元の名前（…の世代から復旧・保存先は未確定）」
        const identity = page.getByTestId('app-identity-file');
        await expect(identity).toHaveAttribute('data-restored', 'true');
        await expect(identity).toContainText('original.gimoza（');
        await expect(identity).toContainText('の世代から復旧・保存先は未確定）');
        await expect(page.getByTestId('app-identity-dirty')).toHaveCount(0);
        expect(await page.title()).toContain('の世代から復旧・保存先は未確定');
        // 自動保存は動かない（保存先が無い）。
        await expect(page.getByTestId('statusbar-last-saved')).toHaveAttribute(
          'data-auto-save-armed',
          'false',
        );

        // **核心**: 開いた直後の Ctrl+S は「名前を付けて保存」。上書きの確認は出ず、
        // 新しい行き先（restored.gimoza）ができ、世代も元のファイルも変わらない。
        await page.keyboard.press('Control+s');
        await expect(page.getByTestId('overwrite-dialog')).toHaveCount(0);
        await expect(page.getByTestId('statusbar-result')).toContainText(
          '保存しました（restored.gimoza）',
        );
        await expect(identity).toHaveText('restored.gimoza');
        expect(readdirSync(workDir)).toContain('restored.gimoza');
        for (const [name, bytes] of backupBytes) {
          expect(readFileSync(join(workDir, name)).equals(bytes), name).toBe(true);
        }
        expect(readFileSync(original).equals(originalBytes)).toBe(true);
        // 元のファイルの世代は増えていない（書いたのは restored.gimoza の側）。
        expect(backupsIn(workDir, 'original.gimoza')).toEqual(generations);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('V14 (b): 壊れたファイルを開くと修復ダイアログが出て、直し方が 1 つの行は選ばずに［修復して読み込む］だけで開ける', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-8d-repair-'));
    const good = join(workDir, 'good.gimoza');
    const broken = join(workDir, 'broken.gimoza');
    try {
      const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: good } });
      try {
        await drawAndSaveAs(page);

        // 同じ地物の歴史を 2 本にした壊れたファイルを作る（形式は正しいが中身が矛盾する）。
        const entries = unzipSync(readFileSync(good));
        const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as {
          histories: unknown[];
        };
        manifest.histories.push(manifest.histories[0]);
        entries['manifest.json'] = strToU8(JSON.stringify(manifest));
        writeFileSync(broken, zipSync(entries));

        // 読み込みは修復ダイアログの答えを待つので、待たずに走らせておく（失敗しても
        // 未処理の拒否で本当の原因が隠れないよう、結果を値として受ける）。
        const pending = loadProject(page, broken).then(
          (outcome) => outcome,
          (error: unknown) => `error: ${String(error)}`,
        );
        const dialog = page.getByTestId('repair-dialog');
        await expect(dialog).toBeVisible();
        // 何が壊れていて何をするかが 1 行ずつ読める。直し方が 1 つの行（同じ地物の歴史の
        // 重複 → 先頭だけ残す）にラジオは無い。
        await expect(page.getByTestId('repair-fix-0')).toContainText('こう直します');
        await expect(page.getByTestId('repair-row-0').getByRole('radio')).toHaveCount(0);
        // 直し方が 2 つ以上ある行（重複のせいで連鎖して出る行）は、最初の方法が選ばれた
        // 状態で始まる ―― 選び直さなくても押せる。
        const groups = dialog.locator('fieldset.repair-row__options');
        await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(await groups.count());
        // 内部の ID・項目名は出ない。
        await expect(dialog).not.toContainText(/childIds|parentId|f-\d+-\d+/);
        // 読んで［修復して読み込む］（最初から押せる）。
        await expect(page.getByTestId('repair-apply')).toBeEnabled();
        await page.getByTestId('repair-apply').click();
        expect(await pending).toBe('loaded');
        await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
        await expect(page.getByTestId('app-identity-file')).toHaveText('broken.gimoza');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('V12 の④: 設定 →「保存とバックアップ」で間隔と世代数を変えると、世代数が保存に効き、再起動しても残る', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-8d-settings-'));
    const target = join(workDir, 'gens.gimoza');
    try {
      {
        const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
        try {
          // 設定 →「保存とバックアップ」→ 間隔 10 → 世代数 2 →［適用］
          await openSettings(page);
          await page.getByTestId('settings-tab-backup').click();
          const interval = page.getByTestId('settings-backup-interval');
          await expect(interval).toHaveValue('5'); // 既定は FR-108 の 5 分
          await expect(page.getByTestId('settings-backup-generations')).toHaveValue('10');
          // 保存先がまだ無いので、世代は無いと言う（V14 の入口）。
          await expect(page.getByTestId('settings-backup-generation-count')).toContainText(
            '戻せる世代はまだありません',
          );
          await interval.fill('10');
          await page.getByTestId('settings-backup-generations').fill('2');
          await page.getByTestId('settings-backup-apply').click();
          await expect(page.getByTestId('settings-backup-applied')).toBeVisible();
          await page.getByTestId('settings-cancel').click();

          // 保存を 3 回 → 世代は 2 つだけ残る（主プロセスに効いている）。
          await drawAndSaveAs(page);
          await saveAgain(page, 2);
          expect(backupsIn(workDir, 'gens.gimoza')).toHaveLength(2);
        } finally {
          await app.close();
        }
      }
      // 再起動しても残る（アプリ側の設定ファイル）。
      {
        const { app, page } = await launchApp();
        try {
          await openSettings(page);
          await page.getByTestId('settings-tab-backup').click();
          await expect(page.getByTestId('settings-backup-interval')).toHaveValue('10');
          await expect(page.getByTestId('settings-backup-generations')).toHaveValue('2');
          // 次の検査へ持ち越さないよう既定へ戻す（同じワーカーの userData を共有している）。
          await page.getByTestId('settings-backup-interval').fill('5');
          await page.getByTestId('settings-backup-generations').fill('10');
          await page.getByTestId('settings-backup-apply').click();
          await expect(page.getByTestId('settings-backup-applied')).toBeVisible();
        } finally {
          await app.close();
        }
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
