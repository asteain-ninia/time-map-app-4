// 増分 8E — G-10（FR-04）: 2:1 でない画像を背景地図に差し替えようとすると、補正の提案が出る。
//
// 地図は正距円筒（横が縦の 2 倍＝2:1）で描くので、2:1 でない画像をそのまま使うと引き伸ばされて
// 歪む。これまでは黙って採用していた（現状分析 §6.2 の G-10）。完了の定義:
// 「3:2 の画像を背景に差し替えようとすると補正の提案が出る」。
//
// 画像の選択はネイティブのダイアログなので、main 側の `dialog.showOpenDialog` をこの
// テストの間だけ差し替えて、書き出した PNG を選ばせる（アプリのコードは変えない）。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';
import { unzipSync } from 'fflate';

import { openSettingsAndReplace, samplePng, stubImagePicker, writePng } from './basemap-image-helpers';
import { loadProject, launchApp } from './helpers';

/** 保存したファイルの中の、背景地図の参照（`baseMap`）を JSON の中から探す。 */
function baseMapOf(entries: Record<string, Uint8Array>): unknown {
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.endsWith('.json')) continue;
    const found = findKey(JSON.parse(new TextDecoder().decode(bytes)) as unknown, 'baseMap');
    if (found !== undefined) return found;
  }
  return undefined;
}

function findKey(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  if (key in value) return (value as Record<string, unknown>)[key];
  for (const v of Object.values(value)) {
    const found = findKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
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
      // 補正すると地図の上で絵がずれることを言う（増分 8E の手直し。反証 2-4）。
      await expect(page.getByTestId('basemap-aspect-shift')).toHaveText(
        '余白を足すので、絵は横方向に縮んで見え、地図の端の地物と合わなくなることがあります。',
      );
      await page.getByTestId('basemap-aspect-correct').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('2:1 に補正しました');

      // 保存したファイルの背景地図は 400×200（縦はそのまま、横に余白を足して 2:1）。
      await page.getByTestId('settings-cancel').click();
      await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      const first = unzipSync(new Uint8Array(readFileSync(target)));
      const image = first['assets/basemap.img'];
      expect(image).toBeDefined();

      // **画像の中身** を見る（増分 8E の手直し。GPT 重 2）: 元の絵は横の真ん中（左右 50px ずつ
      // ずらした位置）にそのまま載り、左上の赤い印も向きも保たれ、足した余白は透明。
      const RED = [255, 0, 0, 255];
      const BLUE = [0x33, 0x66, 0xaa, 255];
      const sample = await samplePng(page, image!, [
        [60, 10], // 元の (10,10)＝左上の赤い印
        [95, 45], // 元の (45,45)＝印の内側の右下の角あたり
        [250, 100], // 元の (200,100)＝地
        [340, 190], // 元の (290,190)＝右下の地
        [10, 100], // 左の余白
        [45, 10], // 印のすぐ左（余白）
        [390, 100], // 右の余白
      ]);
      expect({ width: sample.width, height: sample.height }).toEqual({ width: 400, height: 200 });
      expect(sample.pixels[0]).toEqual(RED);
      expect(sample.pixels[1]).toEqual(RED);
      expect(sample.pixels[2]).toEqual(BLUE);
      expect(sample.pixels[3]).toEqual(BLUE);
      for (const i of [4, 5, 6]) expect(sample.pixels[i]![3], `余白 ${String(i)} は透明`).toBe(0);

      // **開き直し**: 保存したファイルを開き、もう一度保存しても、背景の画像と範囲は同じ。
      const baseMapFirst = baseMapOf(first);
      expect(baseMapFirst).toBeDefined();
      expect(await loadProject(page, target)).toBe('loaded');
      rmSync(target);
      await page.keyboard.press('Control+s');
      await expect.poll(() => existsSync(target), { timeout: 15_000 }).toBe(true);
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      const second = unzipSync(new Uint8Array(readFileSync(target)));
      expect(Buffer.from(second['assets/basemap.img']!).equals(Buffer.from(image!))).toBe(true);
      expect(baseMapOf(second)).toEqual(baseMapFirst);
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
