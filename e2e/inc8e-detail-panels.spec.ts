// 増分 8E — 結合点 #12（設計書 §J.4）: 浮遊する詳細パネルの掃除を 3 つの契機で固定する。
//
// 詳細パネルの掃除はストアの購読に寄りかかっており、「触らない」だけでは生きていることを
// 担保できない（§O の GPT）。次の 3 つでパネルが消えることを回帰テストにする:
//   1. 詳細パネルを開いた地物を削除する
//   2. 時刻を動かして、その年に存在しなくする
//   3. プロジェクトを開き直す
//
// 2 と 3 は増分 8E の探針で **実際に消えていなかった**（2 は 1 つ遅れて消え、3 は同じ
// ファイルを開き直すと id が同じなので残った）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import {
  commitOneFace,
  confirmDeleteIfAsked,
  enterEditMode,
  jumpToYear,
  launchApp,
  loadProject,
  loadSyntheticNested,
} from './helpers';

test.describe('増分 8E — 結合点 #12: 詳細パネルが 3 つの契機で消える', () => {
  test('詳細パネルを開いた地物を削除すると、パネルが消える', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.getByTestId('open-detail-button').click();
      const panel = page.getByTestId(`detail-panel-${faceId}`);
      await expect(panel).toBeVisible();

      await page.keyboard.press('Delete');
      await confirmDeleteIfAsked(page);
      await expect(page.getByTestId('statusbar-result')).toContainText('削除しました');
      await expect(panel).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('時刻を動かしてその年に存在しなくすると、その場でパネルが消える', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      const { faceId } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.getByTestId('open-detail-button').click();
      const panel = page.getByTestId(`detail-panel-${faceId}`);
      await expect(panel).toBeVisible();

      // 1200 年に作った面は 1000 年には無い。
      await jumpToYear(page, 1000);
      await expect(panel).toHaveCount(0);
      // **閉じたのであって隠したのではない**（増分 8E の手直し。一覧のチェックの裁定
      // 2026-09-07「その年に居ない州のチェックは外し、戻しても付け直さない」と揃える）。
      // 在る年へ戻っても、パネルはもう出ない。
      await jumpToYear(page, 1300);
      await page.waitForTimeout(300);
      await expect(panel).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('プロジェクトを開き直すと、同じ地物でもパネルが消える', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-detail-reopen-'));
    const target = join(workDir, 'reopen.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      const { faceId } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.getByTestId('open-detail-button').click();
      const panel = page.getByTestId(`detail-panel-${faceId}`);
      await expect(panel).toBeVisible();

      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      // 同じファイルを開き直す（地物の id は同じまま）。
      expect(await loadProject(page, target)).toBe('loaded');
      await expect(panel).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 増分 8E の手直し（反証 2-3）: **まとめ役の子** のパネル。子は自分の系列を持たず、
  // まとめ役の系列の中に居るので、「その id の系列があるか」で見ていた掃除は、関係のない
  // 編集のたびに子のパネルを閉じていた。いまは「その年に居るか」で見る。
  // -------------------------------------------------------------------------

  const CHILD_0 = 'syn-nest-child-0';
  const CHILD_1 = 'syn-nest-child-1';
  const childName = (i: number): string => `合成州 ${String(i + 1).padStart(2, '0')}`;

  /** 一覧で名前を絞り込んで、その子を選ぶ。 */
  async function selectChild(page: Page, index: number, id: string): Promise<void> {
    await page.getByTestId('sidebar-tab-list').click();
    await page.getByTestId('unified-list-filter').fill(childName(index));
    await page.getByTestId(`feature-list-item-${id}`).click();
    await expect(page.getByTestId('app-active-feature')).toHaveText(id);
  }

  /** 合成の入れ子（1000 年から居る子 3 つ）を 1200 年で開き、子 0 の詳細パネルを開く。 */
  async function openChildPanel(page: Page): Promise<void> {
    await loadSyntheticNested(page, 3, [1000]);
    await enterEditMode(page);
    await jumpToYear(page, 1200);
    await selectChild(page, 0, CHILD_0);
    await page.getByTestId('sidebar-tab-properties').click();
    await page.getByTestId('open-detail-button').click();
    await expect(page.getByTestId(`detail-panel-${CHILD_0}`)).toBeVisible();
  }

  test('まとめ役の子のパネルは、別の子の名前を直す（関係のない編集）では閉じない', async () => {
    const { app, page } = await launchApp();
    try {
      await openChildPanel(page);
      await selectChild(page, 1, CHILD_1);
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('basic-info').getByLabel('名前').fill('名前を直した州');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('statusbar-result')).toContainText('行いました');
      await page.waitForTimeout(300);
      await expect(page.getByTestId(`detail-panel-${CHILD_0}`)).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('まとめ役の子のパネルも、削除で閉じる', async () => {
    const { app, page } = await launchApp();
    try {
      await openChildPanel(page);
      await page.getByTestId('map-input-layer').hover();
      await page.keyboard.press('Delete');
      await confirmDeleteIfAsked(page);
      await expect(page.getByTestId('statusbar-result')).toContainText('削除しました');
      await expect(page.getByTestId(`detail-panel-${CHILD_0}`)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('まとめ役の子のパネルも、居ない年へ動かすと閉じ、戻っても開き直さない', async () => {
    const { app, page } = await launchApp();
    try {
      await openChildPanel(page);
      const panel = page.getByTestId(`detail-panel-${CHILD_0}`);
      await jumpToYear(page, 900);
      await expect(panel).toHaveCount(0);
      await jumpToYear(page, 1200);
      await page.waitForTimeout(300);
      await expect(panel).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('まとめ役の子のパネルも、プロジェクトを開き直すと閉じる', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-detail-child-reopen-'));
    const target = join(workDir, 'child-reopen.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await openChildPanel(page);
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expect(await loadProject(page, target)).toBe('loaded');
      await expect(page.getByTestId(`detail-panel-${CHILD_0}`)).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
