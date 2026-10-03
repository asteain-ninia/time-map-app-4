// 増分 7 の手直し 2 回目 —— 画面の結線でしか確かめられないものを実アプリで押す。
//
//   A-1  まとめ役を終わらせても、子が後の年に移った別の親との所属は外れない。終わらせた親が
//        後の年の錨で再び現れるなら、子はそこから元の所属に戻る（殻を作らない）。取り消し・
//        やり直し・保存 → 開き直しで修復の板が出ない。
//   D1   子（自分の系列を持つ）を先に終わらせてから親を終わらせ、保存 → 開き直しで修復の板が
//        出ない（アプリが自分で書いたファイルを自分で不整合と判定しない）。
//   A-4  年をまたぐ所属の食い違いがあると、保存の前に理由を見せて聞く（止めない）。
//   B-6  印から来た対象のとき、Escape を連打すれば道具まで降りる（2 回目から黙らない）。
//   B-7  自分の年表を持たない子を所属変更して Ctrl+Z しても、選択が外れない。
//   B-8  時刻の移動で外した印の件数が、「○○年へ移動しました」と 1 つの文で読める。
//   B-9  まとめて種別を付けて確定したら印が外れる。
//   B-10 終わらせた年に、選択を保ったまま「○○年で終わっています」と読める（見出しも「もう」）。
//   D5   まとめ役の子でレールの「この年に錨を作る」を押すと、どこに記録が増えたかを言う。
//
// **画面の言葉は直書きしない**（教訓 5.64）。件数・年・名前のように意味のある部分だけを読む。

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  clickClearOfStickyBars,
  enterEditMode,
  jumpToYear,
  launchApp,
  loadProject,
  loadSyntheticNested,
  openPropertySection,
  projectStats,
  railLaneStats,
  railView,
  type LaunchedApp,
  type LoadProjectOutcome,
} from './helpers';

const PARENT_ID = 'syn-nest-parent';
const PARENT_NAME = '合成の連邦';
const OUTSIDER_ID = 'syn-nest-outsider';
const OUTSIDER_NAME = '合成の外の国';

function childId(index: number): string {
  return `syn-nest-child-${String(index)}`;
}
function childName(index: number): string {
  return `合成州 ${String(index + 1).padStart(2, '0')}`;
}

async function revealRow(page: Page, name: string, featureId: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(name);
  await expect(page.getByTestId(`feature-list-item-${featureId}`)).toBeVisible();
}

async function selectRow(page: Page, name: string, featureId: string): Promise<void> {
  await revealRow(page, name, featureId);
  await page.getByTestId(`feature-list-item-${featureId}`).click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(featureId);
}

async function markRow(page: Page, name: string, featureId: string): Promise<void> {
  await revealRow(page, name, featureId);
  await page.getByTestId(`ledger-mark-${featureId}`).check();
}

async function blurToLedger(page: Page): Promise<void> {
  await page.getByTestId('unified-list-filter').fill('');
  await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
}

async function nested(page: Page, children: number, years: readonly number[], year: number): Promise<void> {
  await loadSyntheticNested(page, children, years);
  await enterEditMode(page);
  await jumpToYear(page, year);
}

/** 印を付けた地物を、既存の上位領域 `parentId` の下へ移す（所属の道具 → 3 択の板）。 */
async function moveMarkedInto(page: Page, parentId: string): Promise<void> {
  await page.getByTestId('tool-edit.reparent').click();
  await page.getByTestId('reparent-confirm').click();
  await page.getByTestId(`reparent-parent-existing-pick-item-${parentId}`).click();
  await page.getByTestId('reparent-options-confirm').click();
  await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
  await page.getByTestId('tool-edit.select').click();
}

async function parentOf(page: Page, name: string, featureId: string): Promise<string> {
  await selectRow(page, name, featureId);
  await page.getByTestId('sidebar-tab-properties').click();
  return (await page.getByTestId('parent-value').textContent()) ?? '';
}

/** 素性欄から終わらせる（子が居れば影響の板を確定する）。 */
async function endHere(page: Page, name: string, featureId: string): Promise<void> {
  await selectRow(page, name, featureId);
  await page.getByTestId('sidebar-tab-properties').click();
  await page.getByTestId('end-here').click();
  const board = page.getByTestId('end-here-impact');
  if ((await board.count()) > 0) {
    await page.getByTestId('end-here-impact-confirm').click();
    await expect(board).toHaveCount(0);
  }
}

/**
 * 開き直す。**修復の板・未保存の確認が出たら失敗にする**（出ると読み込みが返らない）。
 * 20 秒で見切り、出ている板を理由に書く。
 */
async function reopenWithoutBoards(page: Page, path: string): Promise<LoadProjectOutcome> {
  const loading = loadProject(page, path);
  const boardShown = page
    .locator('[data-testid="repair-dialog"],[data-testid="unsaved-dialog"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => 'board' as const)
    .catch(() => 'none' as const);
  const first = await Promise.race([loading, boardShown]);
  if (first === 'board') {
    const text = await page
      .locator('[data-testid="repair-dialog"],[data-testid="unsaved-dialog"]')
      .first()
      .textContent();
    throw new Error(`開き直しで板が出た: ${text ?? ''}`);
  }
  return first === 'none' ? loading : first;
}

/** 開き直し、修復の板が出たら各行の先頭（既定）の方法を選んで適用する（板が出なければそのまま）。 */
async function reopenWithDefaultRepairs(page: Page, path: string): Promise<LoadProjectOutcome> {
  const loading = loadProject(page, path);
  const board = page.getByTestId('repair-dialog');
  const shown = await board
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (shown) {
    const rows = page.locator('[data-testid^="repair-row-"]');
    const count = await rows.count();
    for (let i = 0; i < count; i += 1) {
      await rows.nth(i).locator('[data-testid^="repair-option-"]').first().check();
    }
    await page.getByTestId('repair-apply').click();
  }
  return loading;
}

async function saveWithCtrlS(page: Page): Promise<void> {
  await blurToLedger(page);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
}

async function withSavePath(
  run: (launched: LaunchedApp, savePath: string) => Promise<void>,
): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc7-fix2-'));
  const savePath = join(workDir, 'fix2.gimoza');
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: savePath } });
    await run(launched, savePath);
  } finally {
    await launched?.app.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// A-1 / D1: 終わらせるときの所属の外し方と、保存 → 開き直し
// ---------------------------------------------------------------------------

test.describe('A-1 — まとめ役を終わらせても、子が後の年に移った別の親との所属は外れない', () => {
  test('1700 年に外の国へ移した子は、王国を 1500 年で終わらせても 1700 年の親が外の国のまま', async () => {
    await withSavePath(async ({ page }, savePath) => {
      await nested(page, 3, [1000], 1700);
      // 子 0 を 1700 年に外の国の下へ移す（親の系列にも 1700 年の記録が増える）。
      await markRow(page, childName(0), childId(0));
      await moveMarkedInto(page, OUTSIDER_ID);
      expect(await parentOf(page, childName(0), childId(0))).toBe(OUTSIDER_NAME);

      // 1500 年に親を終わらせる。親の 1700 年の錨（所属変更が作った帳簿の記録）は途切れずに
      // 続いているので一緒に終わる、と板が言う（手直し 3 回目。親は 1700 年に再び現れない）。
      await jumpToYear(page, 1500);
      await selectRow(page, PARENT_NAME, PARENT_ID);
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
      await expect(page.getByTestId('end-here-impact-ends')).toContainText('一緒に終わります');
      await expect(page.getByTestId('end-here-impact-promoted')).not.toContainText('再び現れます');
      await page.getByTestId('end-here-impact-confirm').click();
      await expect(page.getByTestId('end-here-impact')).toHaveCount(0);

      // 1600 年: 子はどれも最上位。1700 年: 子 0 は外の国のまま、子 1 も最上位（親は戻らない）。
      await jumpToYear(page, 1600);
      expect(await parentOf(page, childName(0), childId(0))).toBe('上位領域なし');
      expect(await parentOf(page, childName(1), childId(1))).toBe('上位領域なし');
      await jumpToYear(page, 1700);
      expect(await parentOf(page, childName(0), childId(0))).toBe(OUTSIDER_NAME);
      expect(await parentOf(page, childName(1), childId(1))).toBe('上位領域なし');

      // 取り消し・やり直しでも 1700 年の外の国との所属は残る。
      await blurToLedger(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      expect(await parentOf(page, childName(0), childId(0))).toBe(OUTSIDER_NAME);
      await blurToLedger(page);
      await page.keyboard.press('Control+y');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');
      expect(await parentOf(page, childName(0), childId(0))).toBe(OUTSIDER_NAME);

      // 保存 → 開き直し。保存の前の確認も、開き直しの修復の板も出ない。
      await saveWithCtrlS(page);
      await expect(page.getByTestId('pre-save-dialog')).toHaveCount(0);
      expect(await reopenWithoutBoards(page, savePath)).toBe('loaded');
      await enterEditMode(page);
      await jumpToYear(page, 1700);
      expect(await parentOf(page, childName(0), childId(0))).toBe(OUTSIDER_NAME);
      await jumpToYear(page, 1600);
      expect(await parentOf(page, childName(0), childId(0))).toBe('上位領域なし');
    });
  });

  test('D1: 王国の下へ入れた国を先に終わらせてから王国を終わらせ、保存 → 開き直しで修復を聞かれない', async () => {
    await withSavePath(async ({ page }, savePath) => {
      await nested(page, 3, [1000], 1000);
      // 外の国を 1000 年に親の下へ入れる（自分の系列を持つ子になる）。
      await markRow(page, OUTSIDER_NAME, OUTSIDER_ID);
      await moveMarkedInto(page, PARENT_ID);
      expect(await parentOf(page, OUTSIDER_NAME, OUTSIDER_ID)).toBe(PARENT_NAME);
      // 1200 年に外の国を終わらせ（子が居ないので板は出ない）、1500 年に親を終わらせる。
      await jumpToYear(page, 1200);
      await endHere(page, OUTSIDER_NAME, OUTSIDER_ID);
      await jumpToYear(page, 1500);
      await endHere(page, PARENT_NAME, PARENT_ID);

      await saveWithCtrlS(page);
      await expect(page.getByTestId('pre-save-dialog')).toHaveCount(0);
      expect(await reopenWithoutBoards(page, savePath)).toBe('loaded');
      await enterEditMode(page);
      await jumpToYear(page, 1600);
      expect(await parentOf(page, childName(0), childId(0))).toBe('上位領域なし');
    });
  });
});

// ---------------------------------------------------------------------------
// B-6 / B-7: 退行
// ---------------------------------------------------------------------------

test.describe('B-6 — 印から来た対象でも、Escape を連打すれば道具まで降りる', () => {
  test('素性欄の［最上位へ］→ 板 → Escape を続けて押すと、板・選択・道具の順に戻り、印が残ることを言う', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1200);
      await selectRow(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('parent-clear').click();
      await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();

      // 1 回目: 板が閉じる（選んだものはそのまま）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.reparent');
      // 2 回目: 選択が外れる（旧版はここから何も起きなかった）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      // 3 回目: 道具を降りる。印は一覧に残り、そのことと外し方を状態行が言う。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-tool')).not.toHaveText('edit.reparent');
      await expect(page.getByTestId('statusbar-result')).toContainText('1 件');
      await expect(page.getByTestId('ledger-marked-count')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

test.describe('B-7 — 自分の年表を持たない子を所属変更して Ctrl+Z しても、選択が外れない', () => {
  test('［最上位へ］で独立 → 選び直す → Ctrl+Z で選択はその子のまま', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1200);
      await selectRow(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('parent-clear').click();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
      await page.getByTestId('tool-edit.select').click();

      await selectRow(page, childName(0), childId(0));
      await blurToLedger(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      await expect(page.getByTestId('app-active-feature')).toHaveText(childId(0));
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// B-8 / B-9: 印の寿命
// ---------------------------------------------------------------------------

test.describe('B-8 / B-9 — 印の寿命', () => {
  test('時刻の移動で外した印の件数が、移動の知らせと 1 つの文で読める', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 2, [1000], 1300);
      await markRow(page, childName(0), childId(0));
      await markRow(page, OUTSIDER_NAME, OUTSIDER_ID);
      // 外の国を 1300 年で終わらせ、1400 年へ動かすと、外の国の印は外れる。
      await endHere(page, OUTSIDER_NAME, OUTSIDER_ID);
      await jumpToYear(page, 1400);
      const result = page.getByTestId('statusbar-result');
      await expect(result).toContainText('1400年');
      await expect(result).toContainText('1 件の印');
    } finally {
      await app.close();
    }
  });

  test('まとめて種別を付けて確定したら、印は外れる', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 2, [1000], 1200);
      await markRow(page, childName(0), childId(0));
      await markRow(page, childName(1), childId(1));
      await page.getByTestId(`feature-list-item-${childId(1)}`).click({ button: 'right' });
      await page.locator('[data-item-kind="bulkKindLabel"]').click();
      await page.getByTestId('bulk-kind-input').fill('州');
      await page.getByTestId('bulk-kind-confirm').click();
      await expect(page.getByTestId('bulk-kind-dialog')).toHaveCount(0);
      await expect(page.getByTestId('ledger-marks')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// B-10 / D4: 終わらせた年の見え方
// ---------------------------------------------------------------------------

test.describe('B-10 — 終わらせた年に、選択を保ったまま「○○年で終わっています」と読める', () => {
  test('押した直後の素性欄・見出し、前の年の「終わります」、0 年の錨しか無い地物のレーン', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 2, [0], 1500);
      await endHere(page, OUTSIDER_NAME, OUTSIDER_ID);
      // 選択は保たれ、素性欄は名前と「1500年で終わっています」を言う。
      await expect(page.getByTestId('app-active-feature')).toHaveText(OUTSIDER_ID);
      await expect(page.getByTestId('property-title-name')).toHaveText(OUTSIDER_NAME);
      await expect(page.getByTestId('end-here-state')).toContainText('1500年');
      await expect(page.getByTestId('property-guidance')).toHaveCount(0);
      // 見出しは「まだ」ではなく「もう」。
      await expect(page.getByTestId('rail-edit-time-badge')).toContainText('もう');
      // 0 年にしか節目が無い案内文は、終わりのある系列には出さない（終端の印を隠さない）。
      await expect(page.locator('[data-testid="anchor-lane-empty"][data-kind="only-origin"]')).toHaveCount(0);

      // 前の年では居て、「1500年で終わります」と言う。
      await jumpToYear(page, 1400);
      await expect(page.getByTestId('end-here-state')).toContainText('1500年');
      await expect(page.getByTestId('end-here-state')).toContainText('終わります');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D5: まとめ役の子でレールの「この年に錨を作る」
// ---------------------------------------------------------------------------

test.describe('D5 — まとめ役の子でレールの「この年に錨を作る」を押すと、どこに増えたかを言う', () => {
  test('親の年表に記録が増え、状態行が移動と合わせて「上位領域『○○』の年表に」と言う', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 2, [1000], 1000);
      await selectRow(page, childName(0), childId(0));
      await expect.poll(async () => (await railLaneStats(page)).anchorCount).toBe(1);
      const before = (await projectStats(page)).anchorCount;
      const box = await page.getByTestId('anchor-lane').boundingBox();
      if (box === null) throw new Error('レーンが見えない');
      const v = await railView(page);
      const px = ((3000 - v.minYear) / (v.maxYear - v.minYear)) * v.pixelLength;
      await page.mouse.click(box.x + px, box.y + box.height / 2, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await menu.locator('[data-rail-item="createAnchorHere"]').click();
      await expect.poll(async () => (await projectStats(page)).anchorCount).toBe(before + 1);
      const result = page.getByTestId('statusbar-result');
      await expect(result).toContainText(PARENT_NAME);
      await expect(result).toContainText('移動しました');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A-4: 年をまたぐ食い違いは、保存の前に聞く（止めない）
// ---------------------------------------------------------------------------

test.describe('A-4 — 年をまたぐ所属の食い違いは、保存を止めずに聞く', () => {
  test('まとめ役の開始年を前へ動かすと、保存の前に理由と次に開いたときの直し方が出て、開き直しの既定の修復で記録が消えない', async () => {
    await withSavePath(async ({ page }, savePath) => {
      await nested(page, 2, [1000], 1000);
      // 外の国を 1000 年に親の下へ入れ（自分の系列を持つ子）、親の開始年を 900 年へ動かす。
      // 900〜1000 年の親の下位領域の一覧には、まだ居ない外の国が載っている（年をまたぐ食い違い。
      // `docs/現状.md` B74 の形。子の開始年を親より前へ動かす形は、手直し 3 回目で作らなくなった）。
      await markRow(page, OUTSIDER_NAME, OUTSIDER_ID);
      await moveMarkedInto(page, PARENT_ID);
      await selectRow(page, PARENT_NAME, PARENT_ID);
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'anchor-section');
      await clickClearOfStickyBars(page.getByTestId('anchor-interval-summary-syn-nest-a-1000'));
      await page.getByTestId('anchor-interval-start-syn-nest-a-1000-year').fill('900');
      await clickClearOfStickyBars(page.getByTestId('anchor-interval-start-syn-nest-a-1000-confirm'));
      await jumpToYear(page, 900);
      await revealRow(page, PARENT_NAME, PARENT_ID);

      // Ctrl+S → 止めずに聞く板。理由は名前と年で言い、次に開いたときに何をするかも言う。
      await blurToLedger(page);
      await page.keyboard.press('Control+s');
      const dialog = page.getByTestId('pre-save-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('app-focus-owner')).toHaveText('modal');
      const line = page.getByTestId('pre-save-line').first();
      await expect(line).toContainText(PARENT_NAME);
      await expect(line).toContainText('900年');
      await expect(line).toContainText('次に開くと');

      // やめる → 書かない。
      await page.getByTestId('pre-save-cancel').click();
      await expect(dialog).toHaveCount(0);
      expect(existsSync(savePath)).toBe(false);

      // このまま保存する → 書く（行き止まりにしない）。
      await blurToLedger(page);
      await page.keyboard.press('Control+s');
      await page.getByTestId('pre-save-confirm').click();
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expect(existsSync(savePath)).toBe(true);

      // 開き直す → 修復の板の各行の先頭（既定）を選んで適用 → 記録は消えていない。
      expect(await reopenWithDefaultRepairs(page, savePath)).toBe('loaded');
      await enterEditMode(page);
      await jumpToYear(page, 1100);
      expect(await parentOf(page, OUTSIDER_NAME, OUTSIDER_ID)).toBe(PARENT_NAME);
      expect(await parentOf(page, childName(0), childId(0))).toBe(PARENT_NAME);
    });
  });
});

// ---------------------------------------------------------------------------
// B76: 過去の年の編集が、終わりを越えて地物を生き返らせない
// ---------------------------------------------------------------------------

test.describe('B76 — 終わった地物を終わる前の年で改名しても、終わりの後に生き返らない', () => {
  test('1500 年で終わった国を 1300 年で改名 → 2000 年に居ない・取り消しで戻る・保存 → 開き直しで同じ', async () => {
    await withSavePath(async ({ page }, savePath) => {
      await nested(page, 2, [1000], 1500);
      await endHere(page, OUTSIDER_NAME, OUTSIDER_ID);

      // 1300 年で改名して保存する（その年に錨が無いので、新しい錨が挿される）。
      await jumpToYear(page, 1300);
      await selectRow(page, OUTSIDER_NAME, OUTSIDER_ID);
      await page.getByTestId('sidebar-tab-properties').click();
      const NEW_NAME = '改名した外の国';
      await page.getByTestId('basic-info').getByLabel('名前').fill(NEW_NAME);
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('property-title-name')).toHaveText(NEW_NAME);

      const listed = async (year: number, name: string): Promise<number> => {
        await jumpToYear(page, year);
        await page.getByTestId('sidebar-tab-list').click();
        await page.getByTestId('unified-list-filter').fill(name);
        return page.locator(`[data-testid="feature-list-item-${OUTSIDER_ID}"]`).count();
      };
      // 1400 年は新しい名前で居る。2000 年には居ない（以前は改名した錨が終わりを持たず、生き返っていた）。
      expect(await listed(1400, NEW_NAME)).toBe(1);
      expect(await listed(2000, '外の国')).toBe(0);

      // 取り消すと名前が戻り、2000 年にはやはり居ない。やり直しも同じ。
      await blurToLedger(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      expect(await listed(1400, OUTSIDER_NAME)).toBe(1);
      expect(await listed(2000, '外の国')).toBe(0);
      await blurToLedger(page);
      await page.keyboard.press('Control+y');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');
      expect(await listed(1400, NEW_NAME)).toBe(1);

      // 保存 → 開き直しても同じ（修復の板も出ない）。
      await saveWithCtrlS(page);
      expect(await reopenWithoutBoards(page, savePath)).toBe('loaded');
      await enterEditMode(page);
      expect(await listed(1400, NEW_NAME)).toBe(1);
      expect(await listed(2000, '外の国')).toBe(0);
    });
  });
});
