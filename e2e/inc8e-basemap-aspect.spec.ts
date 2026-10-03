// 増分 8E — G-10（FR-04）: 2:1 でない画像を背景地図に差し替えようとすると、補正の提案が出る。
//
// 地図は正距円筒（横が縦の 2 倍＝2:1）で描くので、2:1 でない画像をそのまま使うと引き伸ばされて
// 歪む。これまでは黙って採用していた（現状分析 §6.2 の G-10）。完了の定義:
// 「3:2 の画像を背景に差し替えようとすると補正の提案が出る」。
//
// 画像の選択はネイティブのダイアログなので、main 側の `dialog.showOpenDialog` をこの
// テストの間だけ差し替えて、書き出した PNG を選ばせる（アプリのコードは変えない）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';

import { launchApp, leaveViewMode } from './helpers';

/** 画面の canvas で width×height の PNG を作り、ファイルへ書き出す。 */
async function writePng(page: Page, dir: string, width: number, height: number): Promise<string> {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w!;
      c.height = h!;
      const g = c.getContext('2d')!;
      g.fillStyle = '#3366aa';
      g.fillRect(0, 0, w!, h!);
      return c.toDataURL('image/png').split(',')[1]!;
    },
    [width, height],
  );
  const path = join(dir, `image-${String(width)}x${String(height)}.png`);
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}

/** main 側の画像選択を、このテストの間だけ「このファイルを選んだ」にする。 */
async function stubImagePicker(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [p],
    });
  }, path);
}

async function openSettingsAndReplace(page: Page): Promise<void> {
  await leaveViewMode(page);
  await page.getByTestId('menu-tools').click();
  await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-basemap-replace').click();
}

/** PNG の IHDR から寸法を読む。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

test.describe('増分 8E — G-10: 背景地図の縦横比', () => {
  test('3:2 の画像に差し替えようとすると補正の提案が出て、補正すると 2:1 の画像で保存される', async () => {
    test.setTimeout(120_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-basemap-aspect-'));
    const target = join(workDir, 'aspect.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await stubImagePicker(app, await writePng(page, workDir, 300, 200));
      await openSettingsAndReplace(page);

      // 補正の提案（設計書 §F の G-10 の文）。設定の板の上に出て、押せる。
      const dialog = page.getByTestId('basemap-aspect-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('basemap-aspect-question')).toHaveText(
        'この画像は 3:2 です。2:1 に補正しますか、このまま使いますか。',
      );
      await expect(page.getByTestId('basemap-aspect-keep')).toBeVisible();
      await page.getByTestId('basemap-aspect-correct').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('2:1 に補正しました');

      // 保存したファイルの背景地図は 400×200（縦はそのまま、横に余白を足して 2:1）。
      await page.getByTestId('settings-cancel').click();
      await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      const entries = unzipSync(new Uint8Array(readFileSync(target)));
      const image = entries['assets/basemap.img'];
      expect(image).toBeDefined();
      expect(pngSize(image!)).toEqual({ width: 400, height: 200 });
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('［やめる］なら地図は変わらず、やめたことが状態行に出る', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-basemap-aspect-'));
    const { app, page } = await launchApp();
    try {
      await stubImagePicker(app, await writePng(page, workDir, 300, 200));
      const identity = page.getByTestId('app-identity');
      const before = await identity.textContent();
      await openSettingsAndReplace(page);
      await expect(page.getByTestId('basemap-aspect-dialog')).toBeVisible();
      await page.getByTestId('basemap-aspect-cancel').click();
      await expect(page.getByTestId('basemap-aspect-dialog')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText(
        '背景地図の差し替えをやめました',
      );
      // 未保存の印は立っていない（何も変えていない）。
      await expect(identity).toHaveText(before ?? '');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('2:1 の画像なら聞かずに差し替える', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-basemap-aspect-'));
    const { app, page } = await launchApp();
    try {
      await stubImagePicker(app, await writePng(page, workDir, 400, 200));
      await openSettingsAndReplace(page);
      await expect(page.getByTestId('statusbar-result')).toHaveText(/背景地図を差し替えました。/);
      await expect(page.getByTestId('basemap-aspect-dialog')).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
