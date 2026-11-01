// 状態行 5 枠・アプリバーの素性・ウィンドウタイトル・上書き保存の確認（設計書 §C.8 / §H.6）。
//
// V12 の合格条件 ①ファイル名が常に見える ②未保存の印がある ③最終保存時刻が見える を、
// **実アプリで**固定する（④自動保存の設定は増分 8D なので、ここでは扱わない）。
//
// 後半は実データのコピーを開いて、上書き保存の確認まで通す。⚠️ 正準ファイルは絶対に
// アプリで開かない（開発ガイド §5.48）。必ず一時ディレクトリのコピーを開き、テストの
// 最後に正準ファイルのサイズと更新時刻が動いていないことを確かめる。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { PROPERTY_STRINGS } from '../src/ui/property/messages';
import { COMMAND_LABEL_TEXT } from '../src/ui/shell/command-result-strings';

import { commitOneFace, enterEditMode, launchApp, launchAppWithProject } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

test.describe('状態行の 5 枠と、アプリバーの素性（設計書 §C.8 / §H.6）', () => {
  test('起動直後: 5 枠が全部あり、未保存の新規であることが読める', async () => {
    const { app, page } = await launchApp();
    try {
      // --- 状態行の 5 枠 -----------------------------------------------------
      // 座標: カーソルが地図の外なので「—」。枠は残る（中身だけ差し替える）。
      await expect(page.getByTestId('statusbar-cursor-coords')).toHaveText('—');
      // 縮尺: 「1:◯◯」の形（分母は赤道長とズームから導く）。
      await expect(page.getByTestId('statusbar-scale')).toHaveText(/^1:[\d,]+$/);
      // 直前の結果: まだ何もしていない。
      await expect(page.getByTestId('statusbar-result')).toHaveText('（まだ何もしていません）');
      // 元に戻す: 起動直後は履歴が空なので「不可」。
      await expect(page.getByTestId('statusbar-undo')).toHaveText('元に戻す: 不可');
      // 最終保存: このセッションではまだ保存していない。保存先も未確定なので、
      // 自動保存が待機中であることも同じ枠に静かに出る（A4-a）。
      await expect(page.getByTestId('statusbar-last-saved')).toHaveText(
        '未保存（自動保存は待機中）',
      );

      // 状態行そのものは 28px 固定（端末の表示倍率で端数が出るので丸めて比べる）。
      const statusBox = (await page.getByTestId('statusbar').boundingBox())!;
      expect(Math.round(statusBox.height)).toBe(28);

      // --- アプリバーの素性 --------------------------------------------------
      // 保存先が決まっていない新規なので「（未保存の新規）」。世界名は空なので出ない。
      await expect(page.getByTestId('app-identity-file')).toHaveText('（未保存の新規）');
      await expect(page.getByTestId('app-identity-world')).toHaveCount(0);
      await expect(page.getByTestId('app-identity-dirty')).toHaveCount(0);

      // --- ウィンドウタイトル ------------------------------------------------
      expect(await page.title()).toBe('gimoza — （未保存の新規）');
    } finally {
      await app.close();
    }
  });

  test('地物を 1 つ作ると、未保存の印が付き、何が戻せるかが読める', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);

      // 未保存の印（アプリバーとタイトルの両方）。
      await expect(page.getByTestId('app-identity-dirty')).toHaveCount(1);
      expect(await page.title()).toContain('●');

      // 戻せることと、**何が戻るのか**が常に見えている（設計書 §C.8。実運用に踏み切れない不安への
      // 直接の答え。B10）。内部の英語は出さない。
      const undo = page.getByTestId('statusbar-undo');
      await expect(undo).toHaveText(/^元に戻せます: [^a-z]+（Ctrl\+Z）$/);

      // 履歴が空になるまで取り消すと「不可」へ戻る。面を 1 つ描いて保存する手順は
      // 「面の確定」と「素性の保存」で 2 手ぶん積むので、1 回では空にならない。
      //
      // 先に編集モードへ移るのは、**追加ツールを構えたままだと大域の Ctrl+Z が止まる**
      // から（作図中はツール自身の Ctrl+Z が頂点の取り消しを持つので、AppShell が
      // 大域のディスパッチャを suspend する = bughunt3 H2）。ここで移らないと押しても
      // 何も起きず、テストは「取り消せない」ではなく「キーが届かない」で赤くなる。
      await enterEditMode(page);
      await expect(async () => {
        await page.keyboard.press('Control+z');
        await expect(page.getByTestId('app-can-undo')).toHaveText('0', { timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await expect(undo).toHaveText('元に戻す: 不可');
    } finally {
      await app.close();
    }
  });

  test('元に戻す枠は対象の名前と操作名を言い、取り消すと次に戻る操作へ変わる（B10）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await enterEditMode(page);
      const undo = page.getByTestId('statusbar-undo');
      const beforeRename = await undo.textContent();

      const nameInput = page.getByTestId('basic-info').getByLabel(PROPERTY_STRINGS.nameLabel);
      await nameInput.fill('南ケナ州');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);
      const expected = `元に戻せます: 南ケナ州の${COMMAND_LABEL_TEXT.editOverwrite}（Ctrl+Z）`;
      await expect(undo).toHaveText(expected);
      // 枠は 160px のまま。入りきらない文は枠を押し広げず、全文は指し示すと読める。
      await expect(undo).toHaveAttribute('title', expected);
      const frame = await page.locator('.statusbar__frame--undo').boundingBox();
      expect(frame!.width).toBeCloseTo(160, 0);
      const clipped = await undo.locator('span').evaluate((e) => ({
        overflow: getComputedStyle(e).textOverflow,
        cut: e.scrollWidth > e.clientWidth,
      }));
      expect(clipped).toEqual({ overflow: 'ellipsis', cut: true });

      // 取り消すと、枠は **次に戻る操作** を言う（直前の結果の枠は戻した操作を言う）。
      await page.getByTestId('map-input-layer').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        `元に戻しました: 南ケナ州の${COMMAND_LABEL_TEXT.editOverwrite}`,
      );
      await expect(undo).toHaveText(beforeRename!);
    } finally {
      await app.close();
    }
  });

  test('名前を付けて保存すると、ファイル名・タイトル・最終保存時刻が揃って変わる（V12 ③・実データ不要）', async () => {
    // **V12 ③「最終保存時刻が見える」は実データを開く spec でしか通っていなかった**（F2）。
    // 実データが無い環境では丸ごと skip され、保存の成功経路が一度も走らない。ここでは
    // 新規プロジェクトに 1 面だけ描いて、名前を付けて保存の経路で同じことを確かめる。
    // 行き先は E2E 専用の脱出口（E2E_SAVE_AS_PATH）で渡す — Playwright は OS のネイティブ
    // ダイアログを操作できないため。
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-saveas-'));
    const target = join(workDir, 'e2e-save-as.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await commitOneFace(page);
      // **追加ツールを構えたままだと大域のショートカットが止まる**（作図中はツール自身が
      // キーボードを持つ = bughunt3 H2）。Ctrl+S が届くように編集モードへ移る。
      await enterEditMode(page);
      await expect(page.getByTestId('statusbar-last-saved')).toContainText('未保存');
      // 保存先が未確定のうちは自動保存も動けない（A4-a の静かな断り書き）。
      await expect(page.getByTestId('statusbar-last-saved')).toHaveAttribute(
        'data-auto-save-armed',
        'false',
      );

      // 保存先が未確定なので Ctrl+S は「名前を付けて保存」へ落ちる（上書き確認は出ない）。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('overwrite-dialog')).toHaveCount(0);

      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      await expect(page.getByTestId('statusbar-last-saved')).toHaveText(
        /^最終保存 \d\d:\d\d$/,
      );
      await expect(page.getByTestId('app-identity-file')).toHaveText('e2e-save-as.gimoza');
      await expect(page.getByTestId('app-identity-dirty')).toHaveCount(0);
      expect(await page.title()).toBe('gimoza — e2e-save-as.gimoza');
      // 利用者自身がネイティブダイアログで選んだ先なので「確認済み」= 自動保存が動ける（A7）。
      await expect(page.getByTestId('statusbar-last-saved')).toHaveAttribute(
        'data-auto-save-armed',
        'true',
      );
      expect(existsSync(target)).toBe(true);

      // 2 回目の Ctrl+S も聞かない（同じ先へ書く）。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('overwrite-dialog')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

test.describe('実データのコピーを開いてから上書き保存する（V12 の ①②③）', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('世界名とファイル名が出て、初回の上書きは確認され、保存すると最終保存時刻が出る', async () => {
    test.setTimeout(180_000);

    // ⚠️ 正準ファイルには触らない（開発ガイド §5.48）。
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-save-identity-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);
    const copyBefore = statSync(workingCopy);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      // --- ① ファイル名が常に見える / 世界名も ------------------------------
      await expect(page.getByTestId('app-identity-world')).toHaveText('デーレ界');
      await expect(page.getByTestId('app-identity-file')).toHaveText(REAL_DATA_FILE);
      expect(await page.title()).toBe(`gimoza — デーレ界 — ${REAL_DATA_FILE}`);

      // 読み込み直後は clean なので未保存の印は無い。
      await expect(page.getByTestId('app-identity-dirty')).toHaveCount(0);
      // ③ このセッションではまだ保存していない。読み込んだ先への上書きはまだ確認して
      // いないので、自動保存も待機中である（A4-a: 確認前の宛先には 1 バイトも書かない）。
      await expect(page.getByTestId('statusbar-last-saved')).toHaveText(
        '未保存（自動保存は待機中）',
      );

      // --- 初回の上書きは確認される（Ctrl+S が黙って上書きしない）------------
      await page.keyboard.press('Control+s');
      const dialog = page.getByTestId('overwrite-dialog');
      await expect(dialog).toBeVisible();
      // 行き先の名前とフルパスが読める（同名ファイルの取り違えはパスでしか見分けられない）。
      await expect(page.getByTestId('overwrite-body')).toContainText(REAL_DATA_FILE);
      await expect(page.getByTestId('overwrite-path')).toContainText(workingCopy);

      // やめるとファイルは 1 バイトも動かない。
      await page.getByTestId('overwrite-cancel').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText(
        'ファイルは変わっていません',
      );
      expect(statSync(workingCopy).mtimeMs).toBe(copyBefore.mtimeMs);

      // --- 確認して保存すると、結果と最終保存時刻が出る ----------------------
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('overwrite-dialog')).toBeVisible();
      await page.getByTestId('overwrite-confirm').click();

      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      await expect(page.getByTestId('statusbar-last-saved')).toHaveText(/^最終保存 \d\d:\d\d$/);

      // 2 回目からは聞かない（確認は初回だけ）。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('overwrite-dialog')).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    // 正準ファイルが 1 バイトも動いていないこと（コピーを開いた証）。
    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
  });
});
