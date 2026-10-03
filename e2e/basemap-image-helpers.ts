// 背景地図の差し替えの E2E で使う小道具（増分 8E）。`inc8e-basemap-aspect.spec.ts` と、
// 縦横比の板を K-2 の走査・打鍵の検査に載せる `inc5-shell.spec.ts`・`inc7-fix-ui.spec.ts` が使う。
//
// 画像の選択はネイティブのダイアログなので、main 側の `dialog.showOpenDialog` をテストの間だけ
// 差し替えて、書き出した PNG を選ばせる（アプリのコードは変えない）。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type ElectronApplication, type Page } from '@playwright/test';

import { leaveViewMode } from './helpers';

/** 見分けのつく模様の色（左上の印・地）。 */
export const PATTERN = {
  /** 地の色。 */
  ground: [0x33, 0x66, 0xaa] as const,
  /** 左上の 1/6 × 1/4 の印の色（上下左右の向きが分かる非対称の模様）。 */
  mark: [0xff, 0x00, 0x00] as const,
};

/**
 * 画面の canvas で width×height の PNG を作り、ファイルへ書き出す。地は青、**左上だけ赤い印**
 * （非対称なので、切り落とし・裏返し・空の画像への置き換えを見分けられる）。
 */
export async function writePng(
  page: Page,
  dir: string,
  width: number,
  height: number,
): Promise<string> {
  const b64 = await page.evaluate(
    ([w, h, ground, mark]) => {
      const c = document.createElement('canvas');
      c.width = w as number;
      c.height = h as number;
      const g = c.getContext('2d')!;
      const rgb = (v: readonly number[]): string => `rgb(${v.join(',')})`;
      g.fillStyle = rgb(ground as readonly number[]);
      g.fillRect(0, 0, w as number, h as number);
      g.fillStyle = rgb(mark as readonly number[]);
      g.fillRect(0, 0, Math.round((w as number) / 6), Math.round((h as number) / 4));
      return c.toDataURL('image/png').split(',')[1]!;
    },
    [width, height, [...PATTERN.ground], [...PATTERN.mark]] as const,
  );
  const path = join(dir, `image-${String(width)}x${String(height)}.png`);
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}

/** main 側の画像選択を、このテストの間だけ「このファイルを選んだ」にする。 */
export async function stubImagePicker(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [p],
    });
  }, path);
}

/** 設定の板を開いて［差し替え］を押す（縦横比が 2:1 でなければ、縦横比の板が出る）。 */
export async function openSettingsAndReplace(page: Page): Promise<void> {
  await leaveViewMode(page);
  await page.getByTestId('menu-tools').click();
  await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-basemap-replace').click();
}

/**
 * PNG のバイト列を画面の中で読み、指定した点の画素（RGBA）を返す。寸法も返す。
 */
export async function samplePng(
  page: Page,
  bytes: Uint8Array,
  points: readonly (readonly [number, number])[],
): Promise<{ width: number; height: number; pixels: number[][] }> {
  return page.evaluate(
    async ([b64, pts]) => {
      const bin = atob(b64 as string);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([arr], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const g = c.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      const pixels = (pts as number[][]).map(([x, y]) => Array.from(g.getImageData(x!, y!, 1, 1).data));
      return { width: bitmap.width, height: bitmap.height, pixels };
    },
    [Buffer.from(bytes).toString('base64'), points.map((p) => [...p])] as const,
  );
}
