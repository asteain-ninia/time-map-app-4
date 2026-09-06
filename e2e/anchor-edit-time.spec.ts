// 増分 2 — 「1500 年から国名が変わった」を記録できる（設計書 §D.3 / 裁定 §N-2 の (A)）。
//
// **これは実アプリでしか守れない受け入れ条件である。** 増分 1 の手直しで学んだとおり、
// 部品の単体テストは「部品へ正しい値が渡らない」壊れ方では緑のままになる（開発ガイド
// §5.49 / §5.46）。編集時刻の一本化は「素性欄が現在時刻を読む」「保存の行き先を決める」
// 「ドメインが錨を増やす」の 3 層をまたぐので、実物で押す。
//
// ここで固定するのは実装計画 増分 2 の「完了の定義」のうち次の 6 つ。
//   ① 見ていない年の錨が黙って書き換わらない。1200 年で直すと錨が 1 本 → 2 本になり、
//      0 年へ戻すと元の名前が出る。
//   ② 保存ボタンの文字が **押す前に** 行き先どおりに変わる（上書き／新設／年に丸める）。
//   ③ 保存ボタンが初期表示に見えている（素性欄の下端に固定）。
//   ④ スライダーで時刻を動かしても現在時刻に月日が付かず、**保存した .gimoza の錨の
//      開始時刻が全部「年だけ」**である。
//   ⑤ Ctrl+K が、値を変えていなくても錨を 1 本増やす。取り消しは 1 手。
//   ⑥ 打ちかけの名前は、時間を動かしただけでは黙って消えない（N-04）。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { test, expect, type Page } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';

import { commitOneFace, enterEditMode, jumpToYear, launchApp } from './helpers';

/**
 * 鍵盤ショートカットを送る前にフォーカスを入力欄から外す（開発ガイド §5.54）。
 * **地図は押さない** — 地図クリックはその場所の地物を選び直すので、違う地物に効いた
 * まま検査が緑になりうる。状態行の表示は押しても何も起きない。
 */
async function blurForShortcut(page: Page): Promise<void> {
  await page.getByTestId('statusbar-result').click();
}

/** 素性欄タブを開く（サイドバーは排他タブ）。 */
async function showProperties(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tab-properties').click();
}

/** 面を 1 つ作り、編集モードで選び直して素性欄を開いた状態にする。 */
async function faceSelectedInEditMode(page: Page): Promise<{ faceId: string; cx: number; cy: number }> {
  const { faceId, cx, cy } = await commitOneFace(page);
  await enterEditMode(page);
  await page.mouse.click(cx, cy);
  await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
  await showProperties(page);
  return { faceId, cx, cy };
}

/** 素性欄に出ている錨の行数（＝その地物に関わる錨の本数）。 */
async function anchorRowCount(page: Page): Promise<number> {
  return page.locator('[data-testid^="anchor-row-"]').count();
}

test.describe('増分 2 — 編集時刻は「いま見ている年」に効く', () => {
  test('1200 年で名前を直すと錨が 1 本 → 2 本になり、0 年へ戻すと元の名前が出る', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);

      // 0 年に錨が 1 本だけある状態から始める（追加は既定の 0 年で確定する）。
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await nameInput.fill('もとの国');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);
      expect(await anchorRowCount(page)).toBe(1);

      // 1200 年へ移る。**保存ボタンの文字が「作って保存」に変わる**（押す前に読める）。
      await jumpToYear(page, 1200);
      await showProperties(page);
      await expect(page.getByTestId('save-button')).toHaveText('1200年に錨を作って保存');

      await nameInput.fill('あたらしい国');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);

      // 錨が 1 本増えた。状態行にも「新設」と出る。
      await expect
        .poll(async () => anchorRowCount(page), { timeout: 10_000 })
        .toBe(2);
      await expect(page.getByTestId('statusbar-result')).toContainText('その年に錨を作る記録');

      // **0 年へ戻すと元の名前が出る**（＝0 年の錨は書き換わっていない）。
      await jumpToYear(page, 0);
      await showProperties(page);
      await expect(nameInput).toHaveValue('もとの国');

      // 1200 年へ戻すと新しい名前。同じ地物が年で違う姿を持っている。
      await jumpToYear(page, 1200);
      await showProperties(page);
      await expect(nameInput).toHaveValue('あたらしい国');
    } finally {
      await app.close();
    }
  });

  test('同じ年でもう一度保存すると、その年の錨を上書きする（錨は増えない）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');

      await jumpToYear(page, 1200);
      await showProperties(page);
      await nameInput.fill('一回目');
      await page.getByTestId('save-button').click();
      await expect.poll(async () => anchorRowCount(page), { timeout: 10_000 }).toBe(2);

      // 1200 年の錨ができたので、**同じ年の保存は「上書き」**になる。
      await expect(page.getByTestId('save-button')).toHaveText('1200年の錨を上書き保存');
      await nameInput.fill('二回目');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('statusbar-result')).toContainText('その年の錨の書き換え');
      expect(await anchorRowCount(page)).toBe(2);
      await expect(nameInput).toHaveValue('二回目');
    } finally {
      await app.close();
    }
  });

  test('保存ボタンは初期表示に見えている（素性欄の下端に固定）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);

      // **jsdom では測れない**（レイアウトが無く矩形が常に 0）ので実アプリで測る
      // （開発ガイド §5.49）。素性欄の枠と保存ボタンの矩形を突き合わせる。
      const panel = page.getByTestId('sidebar-panel-properties');
      const save = page.getByTestId('save-button');
      await expect(save).toBeVisible();

      const panelBox = await panel.boundingBox();
      const saveBox = await save.boundingBox();
      expect(panelBox).not.toBeNull();
      expect(saveBox).not.toBeNull();
      // 上端より下・下端より上＝枠の中に収まって見えている（BH1-03 は offsetTop 755.8 に
      // 対し表示高 362px で、まさにこれが成り立っていなかった）。
      expect(saveBox!.y).toBeGreaterThanOrEqual(panelBox!.y - 1);
      expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);

      // 中身を下までスクロールしても保存ボタンは同じ場所にいる（sticky）。
      const before = saveBox!.y;
      await panel.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const after = (await save.boundingBox())!.y;
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  test('スライダーで時刻を動かしても月日が付かず、保存した .gimoza の錨は全部「年だけ」', async () => {
    test.setTimeout(120_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-year-only-'));
    const target = join(workDir, 'year-only.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await faceSelectedInEditMode(page);

      // **スライダーを 1 回触るだけで「5080年12月31日」になっていた**（設計書 §O の B-4）。
      const slider = page.getByLabel('時間軸スライダー');
      await slider.fill('0.5');
      await expect(page.getByTestId('timeline-current')).toHaveText(/^\d+年$/);
      await slider.fill('0.137');
      await expect(page.getByTestId('timeline-current')).toHaveText(/^\d+年$/);

      // その年で保存する（錨が 1 本増える）。
      await showProperties(page);
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      // A6: 値を変えるまで押せない。名前を直してから可否を見る。
      await nameInput.fill('スライダーで移った年');
      await expect(page.getByTestId('save-button')).toBeEnabled();
      await page.getByTestId('save-button').click();
      await expect.poll(async () => anchorRowCount(page), { timeout: 10_000 }).toBe(2);

      // 保存先が未確定なので Ctrl+S は「名前を付けて保存」へ落ちる（上書き確認は出ない）。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expect(existsSync(target)).toBe(true);

      // **書かれたファイルを直接読む。** 画面だけを見ても、月日が焼き付いたかは分からない。
      const entries = unzipSync(new Uint8Array(readFileSync(target)));
      const manifestBytes = entries['manifest.json'];
      expect(manifestBytes).toBeDefined();
      const manifest = JSON.parse(strFromU8(manifestBytes!)) as {
        histories?: readonly { entries?: readonly { start?: { granularity?: string } }[] }[];
      };
      const starts = (manifest.histories ?? []).flatMap((h) =>
        (h.entries ?? []).map((e) => e.start?.granularity),
      );
      expect(starts.length).toBeGreaterThan(0);
      expect(new Set(starts)).toEqual(new Set(['year']));
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('Ctrl+K は値を変えていなくても錨を 1 本増やし、取り消しは 1 手', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);
      expect(await anchorRowCount(page)).toBe(1);

      await jumpToYear(page, 1500);
      await showProperties(page);

      // **保存ボタンは押せない**（値が同じなので何も起きない、教訓 5.24）。旧版は押せる
      // のに黙って何もしなかった（A6 / GPT#6）。いまは押せなくして、代わりの一手を出す。
      await expect(page.getByTestId('save-button')).toBeDisabled();
      await expect(page.getByTestId('save-no-change-note')).toContainText('値が変わっていません');
      await expect(page.getByTestId('save-no-change-note')).toContainText('1500年に錨を作る');
      expect(await anchorRowCount(page)).toBe(1);

      // 素性欄の入口が出ている（現在時刻に錨が無いときだけ）。
      await expect(page.getByTestId('create-anchor-here')).toHaveText('1500年に錨を作る');

      // Ctrl+K は専用のコマンドなので、値が同じでも錨が 1 本増える。
      // 名前欄にフォーカスが残っていると打鍵が入力欄へ食われるので、**押しても何も
      // 起きない場所**（状態行）へフォーカスを移す（開発ガイド §5.54）。
      // 送る前と後で選択が同じであることも見る（同）。
      const activeBefore = await page.getByTestId('app-active-feature').textContent();
      await blurForShortcut(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(activeBefore ?? '');
      await page.keyboard.press('Control+k');
      await expect.poll(async () => anchorRowCount(page), { timeout: 10_000 }).toBe(2);
      await expect(page.getByTestId('statusbar-result')).toContainText('この年に錨を作る記録');

      // 錨ができたので入口は消える（同じ年に 2 本は作れない）。
      await showProperties(page);
      await expect(page.getByTestId('create-anchor-here')).toHaveCount(0);

      // **取り消しは 1 手**。
      await blurForShortcut(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('statusbar-result')).toContainText('元に戻しました');
      await showProperties(page);
      await expect.poll(async () => anchorRowCount(page), { timeout: 10_000 }).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('月日の付いた年では保存できず、［年に丸める］で押せるようになる', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);

      // 直接ジャンプで月日まで指定する（レール由来ではないので月日が残る経路）。
      await page.getByLabel('直接ジャンプ 年', { exact: true }).fill('1200');
      // **月日は「月日 ▾」の中にある**（増分 6。時刻レールは 112px 固定なので、
      // 月日の 4 部品は行に並べず畳んである）。
      await page.getByTestId('rail-ymd-button').click();
      await expect(page.getByTestId('rail-ymd-panel')).toBeVisible();
      // 月を「未指定」から「指定」へ切り替えてから入れる（月日を勝手に補わない形なので
      // 、入力欄は既定では使えない）。
      await page.getByLabel('直接ジャンプ 月 未指定', { exact: true }).click();
      await page.getByLabel('直接ジャンプ 月', { exact: true }).fill('6');
      await page.getByRole('button', { name: 'ジャンプ', exact: true }).click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1200年6月');

      await showProperties(page);
      await expect(page.getByTestId('save-button')).toBeDisabled();
      await expect(page.getByTestId('save-disabled-reason')).toContainText('1200年6月');
      await page.getByTestId('round-to-year-button').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1200年');
      await expect(page.getByTestId('save-disabled-reason')).toHaveCount(0);
      // 丸めただけではまだ値が変わっていないので押せない（A6）。何か直せば押せる。
      await expect(page.getByTestId('save-button')).toBeDisabled();
      await page.getByTestId('basic-info').getByLabel('名前').fill('丸めたあとの名前');
      await expect(page.getByTestId('save-button')).toBeEnabled();
    } finally {
      await app.close();
    }
  });

  test('名前を打ちかけて時間を動かすと確認が出て、打ちかけは消えない（N-04）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await nameInput.fill('打ちかけの名前');

      await jumpToYear(page, 1200);
      await showProperties(page);

      await expect(page.getByTestId('draft-discard-confirm')).toBeVisible();
      await expect(nameInput).toHaveValue('打ちかけの名前');

      // 「元の場所へ戻る」で打っていた年へ戻り、続きが打てる。
      await page.getByTestId('draft-discard-keep').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('0年');
      await expect(page.getByTestId('draft-discard-confirm')).toHaveCount(0);
      await expect(nameInput).toHaveValue('打ちかけの名前');
    } finally {
      await app.close();
    }
  });

  test('Ctrl+K を既に錨がある年で押すと、黙って終わらずに理由が出る（A5 / バグ狩り #2）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);
      // 追加は 0 年で確定するので、0 年には既に錨がある。
      const activeBefore = await page.getByTestId('app-active-feature').textContent();
      await blurForShortcut(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(activeBefore ?? '');
      await page.keyboard.press('Control+k');
      // 旧版は鍵盤経路だけ黙って終わっていた（右クリックと素性欄は理由を出していた）。
      await expect(page.getByTestId('statusbar-result')).toContainText('すでに錨があります');
      await showProperties(page);
      expect(await anchorRowCount(page)).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('保存は後ろの錨にも同じ値を入れる範囲を、押す前に文字で見せる（A1）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await faceSelectedInEditMode(page);
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');

      // 2000 年と 3000 年に「同じ姿のまま」の錨を作る（Ctrl+K の代わりに素性欄の入口）。
      for (const year of [2000, 3000]) {
        await jumpToYear(page, year);
        await showProperties(page);
        await page.getByTestId('create-anchor-here').click();
        await expect(page.getByTestId('statusbar-result')).toContainText('この年に錨を作る記録');
      }
      await expect.poll(async () => anchorRowCount(page), { timeout: 10_000 }).toBe(3);

      // 1000 年で改名する。**押す前に**「2000年・3000年 にも同じ値を入れる」と読める。
      await jumpToYear(page, 1000);
      await showProperties(page);
      await nameInput.fill('あたらしい国');
      const label = page.getByTestId('save-button');
      await expect(label).toContainText('1000年に錨を作って保存');
      await expect(label).toContainText('2000年');
      await expect(label).toContainText('3000年');
      // この先ずっと同じ姿になるので、「いつまで続くか」の行は出ない（出すのは
      // 具体的な年で言えるときだけ）。
      await expect(page.getByTestId('save-effect-range')).toHaveCount(0);

      await label.click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);

      // 2000 年・3000 年でも新しい名前（後ろの錨で巻き戻らない、反証 F1）。
      for (const year of [2000, 3000]) {
        await jumpToYear(page, year);
        await showProperties(page);
        await expect(nameInput).toHaveValue('あたらしい国');
      }
      // 0 年は元のまま（前へは effect しない）。
      await jumpToYear(page, 0);
      await showProperties(page);
      await expect(nameInput).not.toHaveValue('あたらしい国');
    } finally {
      await app.close();
    }
  });
});
