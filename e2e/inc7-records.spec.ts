// 増分 7 の手直し A —「記録の置き場」を実アプリで押す（司令塔の決定 (1)(2)(3)）。
//
// **これが守るもの**: 地物の記録は自分の系列（歴史）に置く。唯一の例外は「自分の系列を
// 持たないまとめ役の子」で、その記録は親の錨の中にある。**まとめ役の子でなくなる瞬間**
// （別の親へ移す／最上位へ昇格／まとめ役を全部の年から消す／まとめ役をその年で終わらせる）
// に、その記録を親の錨から選り分けて自分の系列を起こす。
//
// これを怠ると実データで何が起きたか（検証 5 本の一致した指摘）:
//   ・デーレ共和国を消して保存し、開き直すと **60 州が丸ごと失われる**（バグ狩り #1）
//   ・正統ノル王国を終わらせると **14 州が道連れに消える**（バグ狩り #2）
//   ・別の親へ移した州まで、元の親を消すと巻き添えで消える（バグ狩り #3）
//
// **合成データで押す**（`loadSyntheticNested`）。実データそのものは本体の検査に置けない
// （2MB のファイルを毎回読ませない／別の計算機に無い）が、形は同じ ―― まとめ役 1 件が
// 系列を持ち、その錨の中に子が居候する。年を 2 つ並べてあるので「全部の年の記録を写す」も
// 数えられる。
//
// 数え方: 「系列（歴史）の数」と「地物の数」は別物である（`getProjectStats` の注記）。
// 子が自分の系列を持つようになったかは **系列の数**が増えることで読む。

import { expect, test, type Page } from '@playwright/test';

import {
  enterEditMode,
  jumpToYear,
  launchApp,
  listedFeatureCount,
  loadSyntheticNested,
  openPropertySection,
  projectStats,
} from './helpers';

const PARENT_ID = 'syn-nest-parent';
const PARENT_NAME = '合成の連邦';
const OUTSIDER_ID = 'syn-nest-outsider';
const OUTSIDER_NAME = '合成の外の国';
const CHILD_COUNT = 6;

function childId(index: number): string {
  return `syn-nest-child-${String(index)}`;
}

function childName(index: number): string {
  return `合成州 ${String(index + 1).padStart(2, '0')}`;
}

/**
 * 一覧で 1 行を **出す**。木の表示ではまとめ役の子は畳まれていて DOM に居ないので、
 * 名前で絞り込んで先祖を自動で開かせる（増分 4 の「一致した子の先祖を自動で開く」）。
 */
async function revealRow(page: Page, name: string, featureId: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(name);
  await expect(page.getByTestId(`feature-list-item-${featureId}`)).toBeVisible();
}

/** 一覧タブを開いて 1 行選ぶ（素性欄がその地物に切り替わる）。 */
async function selectInLedger(page: Page, name: string, featureId: string): Promise<void> {
  await revealRow(page, name, featureId);
  await page.getByTestId(`feature-list-item-${featureId}`).click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(featureId);
}

/** 一覧の行に「対象にする」印を入れる。 */
async function markInLedger(page: Page, name: string, featureId: string): Promise<void> {
  await revealRow(page, name, featureId);
  await page.getByTestId(`ledger-mark-${featureId}`).check();
}

/** 素性欄の「取り返しのつかないこと」を開いて、全部の年から消す。 */
async function deleteAllYears(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tab-properties').click();
  await openPropertySection(page, 'danger-zone');
  await page.getByTestId('delete-feature').getByRole('button').click();
  const dialog = page.getByTestId('delete-impact');
  await expect(dialog).toBeVisible();
  await page.getByTestId('delete-impact-confirm').click();
  await expect(dialog).toHaveCount(0);
}

/** 所属変更の道具を構える。 */
async function armReparent(page: Page): Promise<void> {
  await enterEditMode(page);
  const tool = page.getByTestId('tool-edit.reparent');
  if ((await tool.getAttribute('aria-pressed')) === 'true') await tool.click();
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

test.describe('増分 7 の手直し A — 記録の置き場（決定 (1)(2)）', () => {
  test('まとめ役を全部の年から消しても、子は 1 件も失われず自分の歴史を持つ', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, CHILD_COUNT);
      await enterEditMode(page);
      // 合成データの錨は 1000 年から始まる。アプリは 0 年で開くので、**居る年へ動かす**
      // ―― 動かさないと一覧は 0 件で、どの行も DOM に現れない。
      await jumpToYear(page, 1200);

      const before = await projectStats(page);
      // 読み込んだ直後は「まとめ役 + 外の国」の 2 系列しか無い（子は居候）。
      expect(before.historyCount).toBe(2);
      expect(before.featureCount).toBe(CHILD_COUNT + 2);

      await selectInLedger(page, PARENT_NAME, PARENT_ID);
      await deleteAllYears(page);

      // 子は 1 件も消えていない（まとめ役だけが消える）。
      const after = await projectStats(page);
      expect(after.featureCount).toBe(CHILD_COUNT + 1);
      // **子が自分の歴史を持った**（居候のままなら親と一緒に消えていた）。
      expect(after.historyCount).toBe(CHILD_COUNT + 1);

      // 一覧にも 6 件そのまま出る。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('合成州');
      expect(await listedFeatureCount(page)).toBe(CHILD_COUNT);

      // 子は消えた親を指したままにならず、最上位になっている（裁定「子は最上位へ昇格」）。
      // 以前は子の錨に親が居ないので掃除が届かず、消えた親を指したまま残っていた。
      await selectInLedger(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-value')).toHaveText('上位領域なし');
      await page.getByTestId('sidebar-tab-list').click();

      // 取り消すと元に戻る（系列の起こしも同じ 1 段に含まれる）。
      await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
      await expect
        .poll(async () => (await projectStats(page)).historyCount, { timeout: 5000 })
        .toBe(2);
    } finally {
      await app.close();
    }
  });

  test('まとめ役をその年で終わらせても子は道連れにならず、次の年に最上位で居る', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, CHILD_COUNT, [1000, 1200]);
      await enterEditMode(page);
      await jumpToYear(page, 1500);

      await selectInLedger(page, PARENT_NAME, PARENT_ID);
      await page.getByTestId('sidebar-tab-properties').click();
      const endHere = page.getByTestId('end-here');
      await expect(endHere).toBeEnabled();
      await endHere.click();
      // **押す前に影響の板が出る**（決定 (2)）。子が居るまとめ役なので、下位領域が
      // この年から最上位になることを見せてから確定する。
      await expect(page.getByTestId('end-here-impact-promoted')).toContainText(
        `${String(CHILD_COUNT)} 件`,
      );
      await page.getByTestId('end-here-impact-confirm').click();
      await expect(page.getByTestId('end-here-impact')).toHaveCount(0);

      // 1600 年へ動かしても子は 6 件そのまま居る（親だけが終わっている）。
      await jumpToYear(page, 1600);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('合成州');
      expect(await listedFeatureCount(page)).toBe(CHILD_COUNT);
      await page.getByTestId('unified-list-filter').fill(PARENT_NAME);
      expect(await listedFeatureCount(page)).toBe(0);

      // 子は最上位になっている（親欄が「最上位」）。
      await selectInLedger(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-value')).toHaveText('上位領域なし');
    } finally {
      await app.close();
    }
  });

  test('外へ出した子は、元のまとめ役を消しても無傷でいる', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, CHILD_COUNT);
      await enterEditMode(page);
      await jumpToYear(page, 1200);

      // 2 件に印を付けて、外の国へまとめて移す。
      await markInLedger(page, childName(0), childId(0));
      await markInLedger(page, childName(1), childId(1));
      await armReparent(page);
      await page.getByTestId('reparent-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
      await page.getByTestId(`reparent-parent-existing-pick-item-${OUTSIDER_ID}`).click();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);

      // 元のまとめ役を全部の年から消す。
      await selectInLedger(page, PARENT_NAME, PARENT_ID);
      await deleteAllYears(page);

      // 移した 2 件も、残っていた 4 件も、1 件も失われていない。
      // 数は 6 州 ＋ 外の国 ＋ **分け残し（直轄領）1 件**である ―― 形を持つ末端が子を
      // 得ると、FR-37 でその元形状が新しい末端へ移る（板の予告にもそう出ている）。
      const after = await projectStats(page);
      expect(after.featureCount).toBe(CHILD_COUNT + 2);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('合成州');
      expect(await listedFeatureCount(page)).toBe(CHILD_COUNT);

      // 移した子は一覧に居て、素性欄が開ける（記録は失われていない）。
      // **上位領域は行き先のまとめ役のまま**である（所有者の裁定 2026-09-07「直す」）。
      // 以前は U31 の掃除が錨 1 枚ずつを見ていたので、子が自分の系列を持つ行き先の
      // まとめ役は「下位領域を全部失った」と読まれて連鎖剪定され、ここが「上位領域なし」に
      // なっていた。いまは時刻ごとに全系列を束ねてから掃除する。
      await selectInLedger(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-row')).toBeVisible();
      await expect(page.getByTestId('parent-value')).toHaveText(OUTSIDER_NAME);
      // 行き先のまとめ役そのものも一覧に居る。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill(OUTSIDER_NAME);
      await expect(page.getByTestId(`feature-list-item-${OUTSIDER_ID}`)).toBeVisible();

      // 取り消すと、消す前の姿（元のまとめ役が居る）へ戻る。全体差し替えの命令なので
      // 構築時の根がそのまま戻る。
      await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
      await expect
        .poll(async () => (await projectStats(page)).featureCount, { timeout: 5000 })
        .toBe(CHILD_COUNT + 3);
      await page.getByTestId('unified-list-filter').fill(PARENT_NAME);
      await expect(page.getByTestId(`feature-list-item-${PARENT_ID}`)).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('連邦化 → 解体 → 再連邦化 を取り消して やり直すと同じ姿へ戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, 3);
      await enterEditMode(page);
      await jumpToYear(page, 1200);

      const federate = async (name: string): Promise<void> => {
        await markInLedger(page, childName(0), childId(0));
        await markInLedger(page, childName(1), childId(1));
        await armReparent(page);
        await page.getByTestId('reparent-confirm').click();
        await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
        await page.getByTestId('reparent-parent-create').check();
        await page.getByTestId('reparent-parent-create-name').fill(name);
        await page.getByTestId('reparent-options-confirm').click();
        await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
      };

      await federate('第一連邦');
      const afterFirst = await projectStats(page);

      // 解体（最上位へ）。
      await markInLedger(page, childName(0), childId(0));
      await markInLedger(page, childName(1), childId(1));
      await armReparent(page);
      await page.getByTestId('reparent-confirm-none').click();
      await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);

      await federate('第二連邦');
      const afterThird = await projectStats(page);

      // Ctrl+Z ×3 / Ctrl+Y ×3。打鍵の持ち主が地図側になるよう、先に「選択」の道具へ戻す。
      await page.getByTestId('tool-edit.select').click();
      await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Control+z');
      await expect
        .poll(async () => (await projectStats(page)).historyCount, { timeout: 5000 })
        .toBe(2);
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Control+y');
      await expect
        .poll(async () => (await projectStats(page)).historyCount, { timeout: 5000 })
        .toBe(afterThird.historyCount);
      const replayed = await projectStats(page);
      expect(replayed.featureCount).toBe(afterThird.featureCount);
      expect(replayed.anchorCount).toBe(afterThird.anchorCount);
      // やり直したあとに居るのは **2 つ目の連邦**である（1 つ目ではない）。
      await page.getByTestId('unified-list-filter').fill('第二連邦');
      expect(await listedFeatureCount(page)).toBe(1);
      await page.getByTestId('unified-list-filter').fill('第一連邦');
      expect(await listedFeatureCount(page)).toBe(0);
      expect(afterFirst.historyCount).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
