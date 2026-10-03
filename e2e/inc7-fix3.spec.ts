// 増分 7 の手直し 3 回目 —— 画面の結線でしか確かめられないものを実アプリで押す。
//
//   (a) 連邦の州を全部同じ年で終わらせると、後ろ側が空になった連邦もその年から終わる（押す前の
//       板が言う）。取り消し・やり直し・保存 → 開き直しで修復の板が出ない（再検証 #1 の 1）。
//   (b) 州の開始年を連邦より前へ動かすと、連邦が居ない区間だけ所属が外れ、保存 → 開き直しで
//       修復の板が出ない（再検証 #1 の 2）。
//   #2  州 a を 1500 年で終わらせて連邦の記録が割られても、連邦を 1300 年で終わらせれば 1500 年に
//       戻ってこない（再検証 #2）。
//   自動保存: 年をまたぐ食い違いを聞かずに書いたファイルも、開き直しの既定の修復で記録が消えない。
//
// **画面の言葉は直書きしない**（教訓 5.64）。件数・年・名前のように意味のある部分だけを読む。

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  clickClearOfStickyBars,
  enterEditMode,
  jumpToYear,
  launchApp,
  listedFeatureCount,
  loadProject,
  loadSyntheticNested,
  openPropertySection,
  type LaunchedApp,
  type LoadProjectOutcome,
} from './helpers';

const FED = '第一連邦';

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

/** 名前で絞って最初の行を選ぶ（作った連邦のように id を知らない地物）。 */
async function selectByName(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(name);
  const row = page.locator('[data-testid^="feature-list-item-"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('app-active-feature')).not.toHaveText('');
}

async function countListed(page: Page, year: number, name: string): Promise<number> {
  await jumpToYear(page, year);
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(name);
  return listedFeatureCount(page);
}

async function parentOf(page: Page, name: string, featureId: string): Promise<string> {
  await selectRow(page, name, featureId);
  await page.getByTestId('sidebar-tab-properties').click();
  return (await page.getByTestId('parent-value').textContent()) ?? '';
}

async function blurToLedger(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill('');
  await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
}

async function nested(page: Page, children: number, years: readonly number[], year: number): Promise<void> {
  await loadSyntheticNested(page, children, years);
  await enterEditMode(page);
  await jumpToYear(page, year);
}

/** 子 0・1 に印を付け、新しい上位領域「第一連邦」の下に入れる（連邦化）。 */
async function federate(page: Page): Promise<void> {
  for (const i of [0, 1]) {
    await revealRow(page, childName(i), childId(i));
    await page.getByTestId(`ledger-mark-${childId(i)}`).check();
  }
  await page.getByTestId('tool-edit.reparent').click();
  await page.getByTestId('reparent-confirm').click();
  await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
  await page.getByTestId('reparent-parent-create').check();
  await page.getByTestId('reparent-parent-create-name').fill(FED);
  await page.getByTestId('reparent-options-confirm').click();
  await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
  await page.getByTestId('tool-edit.select').click();
}

/** 選んでいる地物の最初の錨の開始年を、素性欄の存続期間の欄で直す。 */
async function changeStartOfSelected(page: Page, year: number): Promise<void> {
  await page.getByTestId('sidebar-tab-properties').click();
  await openPropertySection(page, 'anchor-section');
  await clickClearOfStickyBars(page.locator('[data-testid^="anchor-interval-summary-"]').first());
  await page.locator('[data-testid^="anchor-interval-start-"][data-testid$="-year"]').first().fill(String(year));
  await clickClearOfStickyBars(
    page.locator('[data-testid^="anchor-interval-start-"][data-testid$="-confirm"]').first(),
  );
}

/** 開き直す。修復の板・未保存の確認が出たら失敗にする。 */
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

/** 開き直し、修復の板が出たら各行の先頭（既定）の方法を選んで適用する。 */
async function reopenWithDefaultRepairs(page: Page, path: string): Promise<LoadProjectOutcome> {
  const loading = loadProject(page, path);
  const shown = await page
    .getByTestId('repair-dialog')
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

async function withSavePath(run: (launched: LaunchedApp, savePath: string) => Promise<void>): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc7-fix3-'));
  const savePath = join(workDir, 'fix3.gimoza');
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: savePath } });
    await run(launched, savePath);
  } finally {
    await launched?.app.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

test.describe('(a) 連邦の州を全部同じ年で終わらせると、後ろ側が空になった連邦もその年から終わる', () => {
  test('2 件目の州を終わらせる前に板が「連邦も終わる」と言い、保存 → 開き直しで修復の板が出ない', async () => {
    await withSavePath(async ({ page }, savePath) => {
      await nested(page, 3, [1000], 1200);
      await federate(page);
      await jumpToYear(page, 1400);

      // 1 件目: 連邦にはまだ州が残るので板は出ない。
      await selectRow(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
      await expect(page.getByTestId('end-here-impact')).toHaveCount(0);

      // 2 件目: 末端を終わらせるだけだが、連邦が下位領域を全て失うので、押す前に板が出る（締め D）。
      await selectRow(page, childName(1), childId(1));
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
      await expect(page.getByTestId('end-here-impact-cascaded')).toContainText(FED);
      await expect(page.getByTestId('end-here-impact-cascaded')).toContainText('1400年');
      await page.getByTestId('end-here-impact-confirm').click();
      await expect(page.getByTestId('end-here-impact')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText(FED);

      expect(await countListed(page, 1300, FED)).toBe(1);
      expect(await countListed(page, 1400, FED)).toBe(0);

      // 取り消すと連邦は 1400 年に戻る（2 件目の州も）。やり直すとまた終わる。
      await blurToLedger(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      expect(await countListed(page, 1400, FED)).toBe(1);
      await blurToLedger(page);
      await page.keyboard.press('Control+y');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');
      expect(await countListed(page, 1400, FED)).toBe(0);

      // 保存の前の板も、開き直しの修復の板も出ない。連邦の 1200〜1400 年の記録は残る。
      await saveWithCtrlS(page);
      await expect(page.getByTestId('pre-save-dialog')).toHaveCount(0);
      expect(await reopenWithoutBoards(page, savePath)).toBe('loaded');
      await enterEditMode(page);
      expect(await countListed(page, 1300, FED)).toBe(1);
      expect(await countListed(page, 1500, FED)).toBe(0);
    });
  });
});

test.describe('(b) 州の開始年を連邦より前へ動かすと、連邦が居ない区間だけ所属が外れる', () => {
  test('保存の前の板も、開き直しの修復の板も出ない', async () => {
    await withSavePath(async ({ page }, savePath) => {
      await nested(page, 3, [1000], 1000);
      await federate(page);
      await selectRow(page, childName(0), childId(0));
      await changeStartOfSelected(page, 900);

      await jumpToYear(page, 950);
      expect(await parentOf(page, childName(0), childId(0))).toBe('上位領域なし');
      await jumpToYear(page, 1100);
      expect(await parentOf(page, childName(0), childId(0))).toBe(FED);

      await saveWithCtrlS(page);
      await expect(page.getByTestId('pre-save-dialog')).toHaveCount(0);
      expect(await reopenWithoutBoards(page, savePath)).toBe('loaded');
      await enterEditMode(page);
      await jumpToYear(page, 950);
      expect(await parentOf(page, childName(0), childId(0))).toBe('上位領域なし');
      await jumpToYear(page, 1100);
      expect(await parentOf(page, childName(0), childId(0))).toBe(FED);
    });
  });
});

test.describe('#2 帳簿のために割られた記録のせいで、終わらせた連邦が後の年に戻ってこない', () => {
  test('州 a を 1500 年で終わらせてから連邦を 1300 年で終わらせると、1500 年にも 3000 年にも連邦は居ない', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1200);
      await federate(page);
      await jumpToYear(page, 1500);
      await selectRow(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();

      await jumpToYear(page, 1300);
      await selectByName(page, FED);
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
      await expect(page.getByTestId('end-here-impact-promoted')).not.toContainText('再び現れます');
      await page.getByTestId('end-here-impact-confirm').click();
      await expect(page.getByTestId('end-here-impact')).toHaveCount(0);

      expect(await countListed(page, 1250, FED)).toBe(1);
      expect(await countListed(page, 1500, FED)).toBe(0);
      expect(await countListed(page, 3000, FED)).toBe(0);
      await jumpToYear(page, 1500);
      expect(await parentOf(page, childName(1), childId(1))).toBe('上位領域なし');
    } finally {
      await app.close();
    }
  });
});

test.describe('自動保存 — 年をまたぐ食い違いを聞かずに書いたファイルも、開き直しの既定の修復で記録が消えない', () => {
  test('連邦の開始年を前へ動かした形を自動保存で書き、開き直して既定の修復を当てても、連邦と州の所属が残る', async () => {
    await withSavePath(async ({ app, page }, savePath) => {
      // 1000 年に連邦化し、いったん手で保存する（名前を付けて保存を通るので、自動保存が動ける）。
      await nested(page, 3, [1000], 1000);
      await federate(page);
      await saveWithCtrlS(page);
      const firstWrite = statSync(savePath).mtimeMs;

      // 連邦の開始年を 900 年へ（900〜1000 年は下位領域の居ない連邦＝年をまたぐ食い違い）。
      // 自動保存は聞く相手が居ないので、この形を聞かずに書く。
      await selectByName(page, FED);
      await changeStartOfSelected(page, 900);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('tmap:auto-save-tick');
      });
      await expect.poll(() => statSync(savePath).mtimeMs, { timeout: 20_000 }).toBeGreaterThan(firstWrite);
      await expect(page.getByTestId('pre-save-dialog')).toHaveCount(0);

      // 開き直し → 既定の修復（子の居ない区間だけ連邦を無くす）→ 1000 年からの連邦と所属は残る。
      // 直す前の既定は「読み込みから除外」で、連邦が全部の年から消えていた（再検証 #1 の 3）。
      expect(await reopenWithDefaultRepairs(page, savePath)).toBe('loaded');
      await enterEditMode(page);
      expect(await countListed(page, 1100, FED)).toBe(1);
      await jumpToYear(page, 1100);
      expect(await parentOf(page, childName(0), childId(0))).toBe(FED);
    });
  });
});
