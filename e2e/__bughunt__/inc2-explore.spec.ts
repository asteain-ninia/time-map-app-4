// 増分 2 の探索的バグ狩り（実装計画 §0.3 / §2 末尾）。
//
// **異常を見つけたら記録して続け、最後に落とす**（増分 2 の手直し G4 / GPT#13）。
// 旧版は `[異常]` を標準出力へ流すだけで最後に検査していなかったので、回帰が起きても
// 全緑になりえた（手で出力を読まない限り気づけない）。観察（[観察]）はそのまま残し、
// **[異常] が 1 行でもあれば赤くする**。既知で保留する事象があるときは、下の
// KNOWN_ANOMALIES に理由つきで載せ、突き合わせる（黙って無視しない）。
//
// ここは「壊れて
// いないことを証明する」場所ではなく、**実データで新しい経路を掃いて観察を集める**
// 場所である。集めた観察は完了報告（docs/ui-redesign/進捗/増分2.md）へ写す。
//
// 掃く対象（増分 2 で新しく触れるようになった経路）:
//   ① 一覧・素性欄・錨表・存続期間の言うことが食い違わないか
//   ② Ctrl+Z で正しく戻るか
//   ③ 保存して開き直しても残るか
//   ④ まとめ役の子を触ったとき、親の錨がどう増えるか
//
// ファイルがどれだけ増えるか（⑤）は `scripts/measure-anchor-growth.ts` が
// ドメイン層で正確に測るので、ここでは扱わない（画面から測ると ZIP 圧縮と
// 自動保存が混ざって読めない）。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import {
  enterEditMode,
  jumpToYear,
  launchApp,
  launchAppWithProject,
  loadProject,
  projectStats,
} from '../helpers';

/**
 * **保留して構わない既知の [異常]**（前方一致で突き合わせる）。空なら「異常はゼロで
 * なければならない」。ここへ載せるときは、現状.md の項目番号を必ず添える。
 */
const KNOWN_ANOMALIES: readonly string[] = [];

/** [異常] の行だけを取り出し、既知の一覧に無いものを返す。 */
function unexpectedAnomalies(observations: readonly string[]): readonly string[] {
  return observations
    .filter((o) => o.startsWith('[異常]'))
    .filter((o) => !KNOWN_ANOMALIES.some((known) => o.startsWith(known)));
}

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 掃く年（実データの錨はすべて 0 年なので、全部が「新しく作る」側になる）。 */
const YEARS = [1000, 2000, 3000] as const;

/**
 * 入力欄からフォーカスを外す（大域のショートカットが入力欄に食われないように）。
 *
 * **地図をクリックしてはいけない。** 地図クリックはその場所の地物を選び直すので、
 * 「フォーカスを外すだけ」のつもりが選択まで変わる（この探索で実際に踏んだ: Ctrl+K が
 * 意図した子ではなく、地図の左上にあった別の地物に効いていた）。
 */
async function blurInputs(page: Page): Promise<void> {
  await page.getByTestId('statusbar-result').click();
}

async function selectByName(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('list-mode-current').click();
  // **平にしてから絞る**（増分 4）。木のままだと一致した子の先祖も出るので、先頭の行が
  // 親になり、子を選んだつもりで親を選んでしまう。
  await page.getByTestId('list-shape-flat').click();
  await page.getByTestId('unified-list-filter').fill(name);
  const row = page.locator('[data-testid^="feature-list-item-"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await page.getByTestId('sidebar-tab-properties').click();
}

/** 一覧に出ているその地物の行の文字（現在時刻の一覧＝地図と同じ母集合）。 */
async function listLabelOf(page: Page, name: string): Promise<string> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('list-shape-flat').click();
  await page.getByTestId('unified-list-filter').fill(name);
  const row = page.locator('[data-testid^="feature-list-item-"]').first();
  const text = (await row.textContent()) ?? '';
  await page.getByTestId('sidebar-tab-properties').click();
  return text.trim();
}

test.describe('増分 2 の探索 — 実データのコピーで年をまたいで名前を刻む', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('まとめ役の子を 3 件 × 3 年で改名し、一覧・素性欄・錨表・保存の往復が食い違わない', async () => {
    test.setTimeout(300_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc2-explore-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    const saveTarget = join(workDir, 'explored.gimoza');
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);
    const observations: string[] = [];

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      const before = await projectStats(page);
      await enterEditMode(page);

      // デーレ共和国の子（自分の歴史を持たない 86 件のうちの 3 件）。
      const targets = ['アアウェン州', '南ケナ州', '北ケナ州'];
      const renamed = new Map<string, string>();

      for (const original of targets) {
        await selectByName(page, original);
        if ((await page.getByTestId('basic-info').count()) === 0) {
          observations.push(`[観察] ${original} が一覧から選べなかった（絞り込みで 0 件）`);
          continue;
        }
        const nameInput = page.getByTestId('basic-info').getByLabel('名前');
        let latest = original;
        for (const year of YEARS) {
          await jumpToYear(page, year);
          await page.getByTestId('sidebar-tab-properties').click();

          // ① 保存ボタンの文言と、実際に起きることが食い違わないか。
          //
          // **数える相手を取り違えない**（増分 2 の手直し G4 で直した観察の誤り）。
          // まとめ役の子では、錨表の行は「親の系列のうち **この子に関わる** 錨」なので、
          // 兄弟が既に作った年へ上書きするときも **行は 1 増える**（その年がこの子にとって
          // 変化の年になるため）。ボタンの文言が約束しているのは
          // **プロジェクト全体の錨が増えるかどうか**である。
          const label = (await page.getByTestId('save-button').textContent()) ?? '';
          const rowsBefore = await page.locator('[data-testid^="anchor-row-"]').count();
          const anchorsBefore = (await projectStats(page)).anchorCount;
          latest = `${original}・${String(year)}`;
          await nameInput.fill(latest);
          await page.getByTestId('save-button').click();
          await expect(page.getByTestId('save-message')).toHaveCount(0);
          const rowsAfter = await page.locator('[data-testid^="anchor-row-"]').count();
          const anchorsAfter = (await projectStats(page)).anchorCount;

          const saidCreate = label.includes('作って保存');
          const expectedAnchors = saidCreate ? anchorsBefore + 1 : anchorsBefore;
          if (anchorsAfter !== expectedAnchors) {
            observations.push(
              `[異常] ${original} ${String(year)}年: 「${saidCreate ? '作って保存' : '上書き保存'}」と書いてあったのに錨の総数が ${String(anchorsBefore)} → ${String(anchorsAfter)}`,
            );
          }
          // その年はこの子にとって「変化の年」になるので、錨表の行は必ず 1 増える。
          if (rowsAfter !== rowsBefore + 1) {
            observations.push(
              `[異常] ${original} ${String(year)}年: 改名したのに錨表の行が ${String(rowsBefore)} → ${String(rowsAfter)}`,
            );
          }

          // ② 一覧（＝地図と同じ母集合）と素性欄が同じ名前を言うか。
          const listed = await listLabelOf(page, latest);
          if (!listed.includes(latest)) {
            observations.push(
              `[異常] ${original} ${String(year)}年: 素性欄は「${latest}」なのに一覧の行は「${listed}」`,
            );
          }
        }
        renamed.set(original, latest);
      }

      // ③ 錨がどれだけ増えたか。3 件 × 3 年でも、親の系列に立つ錨は「年の数」だけ。
      const after = await projectStats(page);
      observations.push(
        `[観察] 錨の総数 ${String(before.anchorCount)} → ${String(after.anchorCount)}（3 件 × 3 年の改名後）`,
      );

      // ④ まとめ役の子で「この年に錨を作る」を押したとき、画面のどこが変わるか。
      // 子の錨表は「その子に関わる錨だけ」なので、姿を変えない錨は行が増えないはずである
      // （裁定 §N-15）。それでも「押したのに何も起きない」に見えないかを確かめる。
      await selectByName(page, renamed.get(targets[0]!) ?? targets[0]!);
      await jumpToYear(page, 4000);
      await page.getByTestId('sidebar-tab-properties').click();
      const ctrlkRowsBefore = await page.locator('[data-testid^="anchor-row-"]').count();
      const ctrlkBadgeBefore =
        (await page.getByTestId('edit-time-badge').getAttribute('data-plan')) ?? '';
      const hadCreateButton = (await page.getByTestId('create-anchor-here').count()) > 0;
      const activeBeforeCtrlK = await page.getByTestId('app-active-feature').textContent();
      await blurInputs(page);
      // 開発ガイド §5.54: フォーカスを外す手で選択が動いていないことを見る。
      await expect(page.getByTestId('app-active-feature')).toHaveText(activeBeforeCtrlK ?? '');
      await page.keyboard.press('Control+k');
      await expect(page.getByTestId('statusbar-result')).toContainText('錨づくり');
      await page.getByTestId('sidebar-tab-properties').click();
      const ctrlkRowsAfter = await page.locator('[data-testid^="anchor-row-"]').count();
      const ctrlkBadgeAfter =
        (await page.getByTestId('edit-time-badge').getAttribute('data-plan')) ?? '';
      const stillHasCreateButton = (await page.getByTestId('create-anchor-here').count()) > 0;
      const diffTexts = await page.locator('[data-testid^="anchor-diff-"]').allTextContents();
      observations.push(`[観察] Ctrl+K 後の差分の文: ${diffTexts.join(' | ')}`);
      const notice = (await page.getByTestId('inherited-anchor-notice').count()) > 0;
      const listCount = (await page.getByTestId('anchor-list-count').textContent()) ?? '';
      const activeId = (await page.getByTestId('app-active-feature').textContent()) ?? '';
      observations.push(
        `[観察] Ctrl+K 後: 親の断り書き ${notice ? 'あり' : 'なし'} / 錨表の件数表示「${listCount}」 / 選択 id ${activeId}`,
      );
      observations.push(
        `[観察] まとめ役の子で Ctrl+K: 錨の行 ${String(ctrlkRowsBefore)} → ${String(ctrlkRowsAfter)} / ` +
          `バッジ ${ctrlkBadgeBefore} → ${ctrlkBadgeAfter} / ` +
          `作るボタン ${hadCreateButton ? 'あり' : 'なし'} → ${stillHasCreateButton ? 'あり' : 'なし'}`,
      );
      if (ctrlkBadgeBefore === ctrlkBadgeAfter && ctrlkRowsBefore === ctrlkRowsAfter) {
        observations.push(
          '[粗] まとめ役の子で Ctrl+K を押しても、素性欄のどこも変わらないように見える',
        );
      }
      // 別の年へ移って同じ子を見直すと、行の数はどうなるか（選り分けが
      // 現在時刻に依っていないかの確かめ）。
      await jumpToYear(page, 5000);
      await page.getByTestId('sidebar-tab-properties').click();
      const rowsAt5000 = await page.locator('[data-testid^="anchor-row-"]').count();
      const activeAt5000 = (await page.getByTestId('app-active-feature').textContent()) ?? '';
      const noticeAt5000 = (await page.getByTestId('inherited-anchor-notice').count()) > 0;
      observations.push(
        `[観察] 5000 年で同じ子を見ると: 錨の行 ${String(rowsAt5000)} / 選択 id ${activeAt5000} / 親の断り書き ${noticeAt5000 ? 'あり' : 'なし'}`,
      );

      await blurInputs(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('statusbar-result')).toContainText('元に戻しました');

      // ⑥ Ctrl+Z で 1 手ずつ戻るか。最後の保存を 1 回取り消して名前が戻ることを見る。
      const last = targets[targets.length - 1]!;
      await selectByName(page, renamed.get(last) ?? last);
      await blurInputs(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('statusbar-result')).toContainText('元に戻しました');
      const afterUndo = await projectStats(page);
      if (afterUndo.anchorCount !== after.anchorCount - 1) {
        observations.push(
          `[観察] 取り消し 1 手で錨が ${String(after.anchorCount)} → ${String(afterUndo.anchorCount)}（1 本だけ減るとは限らない: 上書きの取り消しは本数を変えない）`,
        );
      }
      await page.keyboard.press('Control+y');
      await expect(page.getByTestId('statusbar-result')).toContainText('やり直しました');

      // ⑥ 保存して開き直しても残るか。
      // **読み込んだファイルへの初めての上書きには確認が出る**（増分 1 の A3）。
      // 探索の手順としてはこれが正しい振る舞いなので、出ていたら押して進む。
      await page.keyboard.press('Control+s');
      const overwrite = page.getByTestId('overwrite-confirm');
      if ((await overwrite.count()) > 0) {
        await overwrite.click();
      } else {
        observations.push('[観察] 読み込んだファイルへの上書きなのに確認が出なかった');
      }
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      const savedStats = await projectStats(page);

      const reopened = await loadProject(page, workingCopy);
      if (reopened !== 'loaded') {
        observations.push(`[異常] 保存したファイルを開き直せなかった: ${reopened}`);
      } else {
        const reloaded = await projectStats(page);
        if (reloaded.anchorCount !== savedStats.anchorCount) {
          observations.push(
            `[異常] 開き直すと錨の数が変わる: ${String(savedStats.anchorCount)} → ${String(reloaded.anchorCount)}`,
          );
        }
        await jumpToYear(page, YEARS[YEARS.length - 1] ?? 0);
        const wanted = renamed.get(targets[0]!) ?? '';
        const listed = await listLabelOf(page, wanted);
        if (!listed.includes(wanted)) {
          observations.push(`[異常] 開き直すと ${wanted} が一覧に出ない（出たのは「${listed}」）`);
        }
      }
    } finally {
       
      console.log(['--- 増分 2 探索の観察 ---', ...observations].join('\n'));
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
      rmSync(saveTarget, { force: true });
    }

    // 正準ファイルが 1 バイトも動いていないこと（開発ガイド §5.48）。
    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);

    // **[異常] が 1 行でもあれば落ちる**（G4 / GPT#13）。
    expect(unexpectedAnomalies(observations)).toEqual([]);
  });

  test('合成データで年をまたいで刻んでも、錨表と存続期間と一覧が食い違わない', async () => {
    test.setTimeout(180_000);
    const observations: string[] = [];
    const { app, page } = await launchApp();
    try {
      const { commitOneFace } = await import('../helpers');
      const { faceId, cx, cy } = await commitOneFace(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await page.getByTestId('sidebar-tab-properties').click();

      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      for (const year of [500, 1500, 2500, 3500, 4500]) {
        await jumpToYear(page, year);
        await page.getByTestId('sidebar-tab-properties').click();
        await nameInput.fill(`第${String(year)}期`);
        await page.getByTestId('save-button').click();
        await expect(page.getByTestId('save-message')).toHaveCount(0);
      }

      const rows = await page.locator('[data-testid^="anchor-row-"]').count();
      if (rows !== 6) {
        observations.push(`[観察] 0 年 + 5 つの年 = 6 本のはずが、錨の行は ${String(rows)} 行`);
      }

      // 存続期間の行（本物）と錨表の先頭が食い違わないか。
      const existence = (await page.getByTestId('existence-value').textContent()) ?? '';
      if (!existence.startsWith('0年')) {
        observations.push(`[異常] 存続期間の行が「0年」から始まっていない: ${existence}`);
      }

      // 各年へ戻ると、その年に保存した名前が出るか。
      for (const year of [500, 1500, 2500, 3500, 4500]) {
        await jumpToYear(page, year);
        await page.getByTestId('sidebar-tab-properties').click();
        const shown = await nameInput.inputValue();
        if (shown !== `第${String(year)}期`) {
          observations.push(`[異常] ${String(year)}年の名前が「${shown}」（期待: 第${String(year)}期）`);
        }
      }

      // 錨と錨のあいだの年では、直前の錨の名前が続く（U09 の §5.8 の規則）。
      await jumpToYear(page, 1000);
      await page.getByTestId('sidebar-tab-properties').click();
      const between = await nameInput.inputValue();
      if (between !== '第500期') {
        observations.push(`[異常] 1000 年（500 と 1500 のあいだ）の名前が「${between}」`);
      }

      expect(faceId).not.toBe('');
    } finally {
       
      console.log(['--- 増分 2 探索（合成データ）の観察 ---', ...observations].join('\n'));
      await app.close();
    }

    expect(unexpectedAnomalies(observations)).toEqual([]);
  });
});
