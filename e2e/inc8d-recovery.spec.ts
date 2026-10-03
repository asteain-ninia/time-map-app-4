// 増分 8D「復旧と設定」— V14（壊れたときに戻す）と V12 の④（自動保存を設定する）を実アプリで固定する。
//
// - V14 (a) 世代から戻す: ファイル →「以前の保存から開く」→ 一覧（日時・大きさ・地物数）→
//   行を押す → 未保存の確認 → 開く。**選んだ世代の中身が戻り**（世代ごとに違うプロジェクト名で
//   比べる）、開いた直後の Ctrl+S は「名前を付けて保存」に落ち、世代そのものも元のファイルも
//   1 バイトも書き換わらない（設計書 §E.1 の V14 の規則 ①②）。保存して開き直しても中身は残る。
// - V14 (b) 壊れたファイルを修復する: 修復ダイアログが出て、直し方が 1 つしか無い行は
//   ラジオを出さずに「こう直します」と書くだけ。読んで［修復して読み込む］を押すだけで開ける。
// - V12 の④: 設定 →「保存とバックアップ」→ 間隔・世代数 →［適用］。世代数が主プロセスに
//   **本当に効いている**ことを、保存を 3 回して世代が 2 つしか残らないことで確かめる。
//   値は再起動しても残る（userData の app-prefs.json。ワーカーごとに隔離されている）。
//
// 増分 8D の手直しで足したもの:
// - 世代が上限まで溜まった状態で **いちばん古い行** を選び、未保存の確認で「保存」を選んでも、
//   選んだ世代は消えずに開ける（重 3）。
// - **元のファイルが壊れて開けない**ときも、新しく起動したところから世代へ戻せる（重 3）。
//   開けなかったファイルの世代はそのまま一覧に出る。新規のあとは「開いているファイルが
//   ありません」と［元のファイルを選ぶ…］が出て、選ぶとその世代が並ぶ。
// - 世代のファイル（.bak）を D&D と「開く」で直接開いても、保存先にならない。
//
// 実データは使わない（新規プロジェクトに面を描いて保存したものを、一時ディレクトリで使う）。
// 名前を付けて保存の行き先は E2E 専用の脱出口 `E2E_SAVE_AS_PATH`、「開く」ダイアログの答えは
// `E2E_OPEN_PATH` で渡す（OS のダイアログは Playwright から操作できない）。行き先は起動ごとに
// 1 つなので、戻したあとの保存を「別の名前の新しいファイルができた」で見分けるために、
// 2 回目は別の行き先で起動し直す。
//
// 保存の完了は **世代のファイルが新しく 1 つできたこと** で待つ（状態行の「保存しました」は
// 前回の文が残っているので、待ちの印にならない。固定時間の待ちも使わない）。

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { test, expect, type Page } from '@playwright/test';

import { commitOneFace, enterEditMode, launchApp, loadProject } from './helpers';

/** `dir` にある `baseName` の世代のファイル名（古い順）。 */
function backupsIn(dir: string, baseName: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${baseName}.bak.`))
    .sort();
}

/**
 * Ctrl+S を押し、`target` の世代が **新しく 1 つ** できるまで待つ（＝保存が書き終わった印）。
 * 上書きの確認が出ないことも確かめる（確認は最初の名前を付けて保存で済んでいる）。
 */
async function saveAndWaitForNewBackup(page: Page, target: string): Promise<void> {
  const dir = dirname(target);
  const base = basename(target);
  const before = new Set(backupsIn(dir, base));
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('overwrite-dialog')).toHaveCount(0);
  await expect
    .poll(() => backupsIn(dir, base).some((name) => !before.has(name)), { timeout: 15_000 })
    .toBe(true);
}

/** ツール メニューから設定を開く。 */
async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('menu-tools').click();
  await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
}

/**
 * プロジェクト名を変える（＝未保存の変更を作る）。面を描き足す形にすると、開いたファイルの
 * 面と重なって重なり解決の板が出ることがあるので、設定の名前で確実に汚す。世代ごとに違う
 * 名前を付けて、どの世代が戻ったかを見分ける印にもする。
 */
async function renameProject(page: Page, name: string): Promise<void> {
  await enterEditMode(page);
  await openSettings(page);
  await page.getByLabel('プロジェクト名').fill(name);
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
  await expect(page.getByTestId('app-identity-dirty')).toHaveCount(1);
}

/** いま開いているプロジェクトの名前（設定を開いて読み、何も変えずに閉じる）。 */
async function projectName(page: Page): Promise<string> {
  await openSettings(page);
  const value = await page.getByLabel('プロジェクト名').inputValue();
  await page.getByTestId('settings-cancel').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
  return value;
}

/**
 * 新規プロジェクトに面を 1 つ描き、名前を `firstName` にして名前を付けて保存（`target` へ）し、
 * 続けて `moreNames` の名前ごとに名前を変えて上書き保存する。世代は保存の数だけでき、
 * 古い順に `firstName`, ...`moreNames` の中身を持つ。
 */
async function saveGenerations(
  page: Page,
  target: string,
  firstName: string,
  moreNames: readonly string[],
): Promise<void> {
  await commitOneFace(page);
  await renameProject(page, firstName);
  await saveAndWaitForNewBackup(page, target);
  for (const name of moreNames) {
    await renameProject(page, name);
    await saveAndWaitForNewBackup(page, target);
  }
}

/** 設定 →「保存とバックアップ」で世代数（と間隔）を書く。確認が出たら「この数にする」。 */
async function applyBackupSettings(page: Page, interval: string, generations: string): Promise<void> {
  await openSettings(page);
  await page.getByTestId('settings-tab-backup').click();
  await expect(page.getByTestId('settings-backup-interval')).toBeEnabled();
  await page.getByTestId('settings-backup-interval').fill(interval);
  await page.getByTestId('settings-backup-generations').fill(generations);
  await page.getByTestId('settings-backup-apply').click();
  const confirm = page.getByTestId('settings-backup-shrink-yes');
  if (await confirm.isVisible()) await confirm.click();
  await expect(page.getByTestId('settings-backup-applied')).toBeVisible();
  await page.getByTestId('settings-cancel').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
}

/** ファイル メニューから「以前の保存から開く」を押す（設計書 V14 の手順 (a) の 1 手目）。 */
async function openBackupFromMenu(page: Page): Promise<void> {
  await page.getByTestId('menu-file').click();
  const item = page.getByTestId('menu-items-file').locator('[data-command="file.openBackup"]');
  await expect(item).toBeEnabled();
  await item.click();
}

/** ファイル メニューのコマンドを押す。 */
async function fileMenu(page: Page, command: 'file.new' | 'file.open'): Promise<void> {
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-items-file').locator(`[data-command="${command}"]`).click();
}

/** アプリバーが「〈元の名前〉（…の世代から復旧・保存先は未確定）」になっている。 */
async function expectRestoredFrom(page: Page, sourceName: string): Promise<void> {
  const identity = page.getByTestId('app-identity-file');
  await expect(identity).toHaveAttribute('data-restored', 'true');
  await expect(identity).toContainText(`${sourceName}（`);
  await expect(identity).toContainText('の世代から復旧・保存先は未確定）');
}

test.describe('増分 8D: 復旧と設定（V14・V12 の④）', () => {
  test('V14 (a): 古い世代を選ぶとその中身が戻り、保存先は未確定。Ctrl+S は名前を付けて保存へ落ち、開き直しても中身は残る', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-8d-restore-'));
    const original = join(workDir, 'original.gimoza');
    const restoredTarget = join(workDir, 'restored.gimoza');
    try {
      // --- 1 回目の起動: 名前を変えては保存を 3 回して、中身の違う世代を 3 つ作る ----------
      {
        const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: original } });
        try {
          await saveGenerations(page, original, '世代その1', ['世代その2', '世代その3']);
        } finally {
          await app.close();
        }
      }
      const generations = backupsIn(workDir, 'original.gimoza');
      expect(generations).toHaveLength(3);
      const backupBytes = new Map(generations.map((n) => [n, readFileSync(join(workDir, n))]));
      const originalBytes = readFileSync(original);

      // --- 2 回目の起動: 元のファイルを開き、編集して、2 番目に古い世代へ戻す ----------------
      {
        const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: restoredTarget } });
        try {
          expect(await loadProject(page, original)).toBe('loaded');
          await expect(page.getByTestId('app-identity-file')).toHaveText('original.gimoza');
          expect(await projectName(page)).toBe('世代その3');
          // 未保存の変更を作る（未保存の確認を通る経路にする）。
          await renameProject(page, '戻す前の編集');

          // ①メニュー → ②一覧を読む（日時・大きさ・地物数）
          await openBackupFromMenu(page);
          const rows = page.getByTestId('backup-row');
          await expect(rows).toHaveCount(3);
          await expect(page.getByTestId('backup-intro')).toContainText('original.gimoza');
          await expect(page.getByTestId('backup-row-saved-at').first()).toHaveText(
            /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
          );
          await expect(page.getByTestId('backup-row-size').first()).toHaveText(/(KB|MB|バイト)$/);
          // 地物数は板が出たあとで埋まる。
          await expect(page.getByTestId('backup-row-features').first()).toHaveText('1 件');

          // ③ 2 番目に新しい行（＝「世代その2」を保存したときの世代）を押す → ④未保存の確認 →
          // 保存せずに続行
          await rows.nth(1).click();
          await expect(page.getByTestId('backup-dialog')).toHaveCount(0);
          await expect(page.getByTestId('unsaved-dialog')).toBeVisible();
          await page.getByTestId('unsaved-discard').click();

          // 開けた: アプリバーは「元の名前（…の世代から復旧・保存先は未確定）」
          await expectRestoredFrom(page, 'original.gimoza');
          await expect(page.getByTestId('app-identity-dirty')).toHaveCount(0);
          expect(await page.title()).toContain('の世代から復旧・保存先は未確定');
          // **核心（手直し）**: 戻ったのは選んだ世代の中身（いまのファイルの中身ではない）。
          expect(await projectName(page)).toBe('世代その2');
          // 自動保存は動かない（保存先が無い）。
          await expect(page.getByTestId('statusbar-last-saved')).toHaveAttribute(
            'data-auto-save-armed',
            'false',
          );

          // 開いた直後の Ctrl+S は「名前を付けて保存」。上書きの確認は出ず、新しい行き先
          // （restored.gimoza）ができ、世代も元のファイルも変わらない。
          await saveAndWaitForNewBackup(page, restoredTarget);
          await expect(page.getByTestId('statusbar-result')).toContainText(
            '保存しました（restored.gimoza）',
          );
          await expect(page.getByTestId('app-identity-file')).toHaveText('restored.gimoza');
          for (const [name, bytes] of backupBytes) {
            expect(readFileSync(join(workDir, name)).equals(bytes), name).toBe(true);
          }
          expect(readFileSync(original).equals(originalBytes)).toBe(true);
          // 元のファイルの世代は増えていない（書いたのは restored.gimoza の側）。
          expect(backupsIn(workDir, 'original.gimoza')).toEqual(generations);
        } finally {
          await app.close();
        }
      }

      // --- 3 回目の起動: 保存したファイルを開き直しても、戻した世代の中身のまま ---------------
      {
        const { app, page } = await launchApp();
        try {
          expect(await loadProject(page, restoredTarget)).toBe('loaded');
          expect(await projectName(page)).toBe('世代その2');
        } finally {
          await app.close();
        }
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('V14 (a) 手直し: 世代が上限まで溜まった状態で最古の行を選び、未保存の確認で「保存」しても、選んだ世代は消えずに開ける', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-8d-prune-'));
    const original = join(workDir, 'capped.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: original } });
    try {
      // 残す世代を 3 にする（ファイルを開く前なので、消える世代は無く確認も出ない）。
      await applyBackupSettings(page, '5', '3');
      await saveGenerations(page, original, '世代その1', ['世代その2', '世代その3']);
      expect(backupsIn(workDir, 'capped.gimoza')).toHaveLength(3); // 上限に着いた
      await renameProject(page, '世代その4');

      await openBackupFromMenu(page);
      const rows = page.getByTestId('backup-row');
      await expect(rows).toHaveCount(3);
      // いちばん古い行（＝「世代その1」）を押し、未保存の確認で「保存して続行」。
      await rows.nth(2).click();
      await expect(page.getByTestId('unsaved-dialog')).toBeVisible();
      await page.getByTestId('unsaved-save').click();

      // **核心**: 確認の保存は世代を 1 つ足したが、選んだ世代は間引かれずに開けた。
      await expectRestoredFrom(page, 'capped.gimoza');
      expect(await projectName(page)).toBe('世代その1');
      expect(backupsIn(workDir, 'capped.gimoza')).toHaveLength(4);
    } finally {
      // 次の検査へ持ち越さないよう既定へ戻す（同じワーカーの userData を共有している）。
      try {
        await applyBackupSettings(page, '5', '10');
      } finally {
        await app.close();
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });

  test('V14 (a) 手直し: 元のファイルが壊れて開けなくても、新しく起動したところから世代へ戻せる（新規のあとは元のファイルを選ばせる）', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-8d-corrupt-'));
    const original = join(workDir, 'world.gimoza');
    const rescued = join(workDir, 'rescued.gimoza');
    try {
      {
        const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: original } });
        try {
          await saveGenerations(page, original, '世代その1', ['世代その2']);
        } finally {
          await app.close();
        }
      }
      const generations = backupsIn(workDir, 'world.gimoza');
      expect(generations).toHaveLength(2);
      // 元のファイルの後ろ半分を切り捨てる（同期ソフトの競合・ディスクの不調などで ZIP が壊れた）。
      const whole = readFileSync(original);
      writeFileSync(original, whole.subarray(0, Math.floor(whole.length / 2)));
      const brokenBytes = readFileSync(original);

      const { app, page } = await launchApp({
        extraEnv: { E2E_SAVE_AS_PATH: rescued, E2E_OPEN_PATH: original },
      });
      // 開けなかったときの知らせ（警告ボックス）は閉じて先へ進む。
      page.on('dialog', (dialog) => {
        void dialog.dismiss();
      });
      try {
        // 壊れたファイルは開けない。
        expect(await loadProject(page, original)).toBe('not-loaded');
        // 開けなかったファイルの世代は、そのまま一覧に出る（「無い」と言わない）。
        await openBackupFromMenu(page);
        await expect(page.getByTestId('backup-intro')).toContainText('world.gimoza');
        await expect(page.getByTestId('backup-row')).toHaveCount(2);
        await page.getByTestId('backup-cancel').click();
        await expect(page.getByTestId('backup-dialog')).toHaveCount(0);

        // 新規にすると、主プロセスも前のファイルを忘れる。一覧も設定も「無い」とは言わない。
        await fileMenu(page, 'file.new');
        await openSettings(page);
        await page.getByTestId('settings-tab-backup').click();
        await expect(page.getByTestId('settings-backup-generation-count')).toContainText(
          '開いているファイルがありません',
        );
        await page.getByTestId('settings-cancel').click();
        await openBackupFromMenu(page);
        await expect(page.getByTestId('backup-no-basis')).toContainText('開いているファイルがありません');
        await expect(page.getByTestId('backup-dialog')).not.toContainText('戻せる世代はまだありません');

        // ［元のファイルを選ぶ…］→（主プロセスの「開く」ダイアログで元のファイル）→ 世代が並ぶ。
        await page.getByTestId('backup-pick-source').click();
        const rows = page.getByTestId('backup-row');
        await expect(rows).toHaveCount(2);
        await expect(page.getByTestId('backup-intro')).toContainText('world.gimoza');
        // 古いほう（＝「世代その1」）へ戻す。新規で何も変えていないので未保存の確認は出ない。
        await rows.nth(1).click();
        await expectRestoredFrom(page, 'world.gimoza');
        expect(await projectName(page)).toBe('世代その1');

        // 戻した中身を新しいファイルへ保存できる。壊れた元のファイルと世代はそのまま。
        await saveAndWaitForNewBackup(page, rescued);
        await expect(page.getByTestId('app-identity-file')).toHaveText('rescued.gimoza');
        expect(readFileSync(original).equals(brokenBytes)).toBe(true);
        expect(backupsIn(workDir, 'world.gimoza')).toEqual(generations);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('V14 手直し: 世代のファイルを D&D でも「開く」でも、直接開いたら保存先にしない（世代は上書きしない）', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-8d-bak-'));
    const original = join(workDir, 'direct.gimoza');
    const rescued = join(workDir, 'from-bak.gimoza');
    try {
      {
        const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: original } });
        try {
          await saveGenerations(page, original, '世代その1', ['世代その2']);
        } finally {
          await app.close();
        }
      }
      const [olderName] = backupsIn(workDir, 'direct.gimoza');
      const older = join(workDir, olderName!);
      const olderBytes = readFileSync(older);

      const { app, page } = await launchApp({
        extraEnv: { E2E_SAVE_AS_PATH: rescued, E2E_OPEN_PATH: older },
      });
      try {
        // D&D（E2E の投入口は D&D と同じ経路）。
        expect(await loadProject(page, older)).toBe('loaded');
        await expectRestoredFrom(page, 'direct.gimoza');
        expect(await projectName(page)).toBe('世代その1');
        // 直後の Ctrl+S は名前を付けて保存へ落ち、世代そのものは書き換わらない。
        await saveAndWaitForNewBackup(page, rescued);
        await expect(page.getByTestId('app-identity-file')).toHaveText('from-bak.gimoza');
        expect(readFileSync(older).equals(olderBytes)).toBe(true);
        // 世代の世代（入れ子の .bak）も作らない。
        expect(readdirSync(workDir).some((n) => n.startsWith(`${olderName!}.bak.`))).toBe(false);

        // ファイル →「開く」で世代を選んでも同じ（保存先にしない）。
        await fileMenu(page, 'file.open');
        await expectRestoredFrom(page, 'direct.gimoza');
        expect(existsSync(older)).toBe(true);
        expect(readFileSync(older).equals(olderBytes)).toBe(true);
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
        await commitOneFace(page);
        await enterEditMode(page);
        await saveAndWaitForNewBackup(page, good);

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
        // 手直し: 対象はどの地物の歴史かを言う（ID を名前の代わりに入れてくる種類でも、
        // 「名前の分からない」とは言わない）。
        await expect(page.getByTestId('repair-row-0')).toContainText('の歴史');
        await expect(dialog).not.toContainText('名前の分からない');
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
          // 保存先がまだ無いので、どのファイルの世代かを言えない（「無い」とは言わない）。
          await expect(page.getByTestId('settings-backup-generation-count')).toContainText(
            '開いているファイルがありません',
          );
          await interval.fill('10');
          await page.getByTestId('settings-backup-generations').fill('2');
          await page.getByTestId('settings-backup-apply').click();
          await expect(page.getByTestId('settings-backup-applied')).toBeVisible();
          await page.getByTestId('settings-cancel').click();

          // 保存を 3 回 → 世代は 2 つだけ残る（主プロセスに効いている）。
          await commitOneFace(page);
          await enterEditMode(page);
          await saveAndWaitForNewBackup(page, target);
          await renameProject(page, '2 回目');
          await saveAndWaitForNewBackup(page, target);
          await renameProject(page, '3 回目');
          await saveAndWaitForNewBackup(page, target);
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
          await page.getByTestId('settings-cancel').click();
          // 次の検査へ持ち越さないよう既定へ戻す（同じワーカーの userData を共有している）。
          await applyBackupSettings(page, '5', '10');
        } finally {
          await app.close();
        }
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
