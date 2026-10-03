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

import { test, expect } from '@playwright/test';

import {
  commitOneFace,
  confirmDeleteIfAsked,
  jumpToYear,
  launchApp,
  loadProject,
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
      // 在る年へ戻れば、閉じていないパネルはまた見える（利用者は閉じていない）。
      await jumpToYear(page, 1300);
      await expect(panel).toBeVisible();
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
});
