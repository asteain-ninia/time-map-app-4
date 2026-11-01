// 読み込みが動いている間は、書類を変える操作を全部断る（`docs/現状.md` の B120 の直し。2026-11-01 の
// 所有者の裁定）。断らないと、旧書類へ記録して反映で履歴ごと消える。未保存の確認はもう済んでいるので、
// 何も聞かれずに消える。
//
// 読み込みの間は主プロセスの返事を止めて作る（時間で待たない。止めた口を開くまで反映は来ない）。
// OS のダイアログは差し替えで見る（本物を出すと焦点を奪う）。

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { PROPERTY_STRINGS } from '../src/ui/property/messages';
import { APP_STRINGS } from '../src/ui/shell/strings';

import {
  armAddAreaTool,
  commitOneFace,
  committedVertices,
  jumpToYear,
  launchApp,
  leaveViewMode,
  placeVertices,
  projectStats,
  squareCorners,
} from './helpers';

const STATUS = 'statusbar-result';
const CAN_UNDO = 'app-can-undo';
const IMPACT = 'impact-confirm';
const REFUSED = APP_STRINGS.editRefusedDuringLoad;

/** 読み込みの返事を、{@link releaseLoads} まで止める。 */
async function holdLoads(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })
      ._invokeHandlers;
    const original = handlers.get('tmap:load');
    if (original === undefined) throw new Error('読み込みの口が見つからない');
    const g = globalThis as unknown as { __loadHeld?: number; __releaseLoads?: () => void };
    g.__loadHeld = 0;
    const gate = new Promise<void>((resolve) => {
      g.__releaseLoads = resolve;
    });
    handlers.set('tmap:load', async (...args: unknown[]) => {
      g.__loadHeld = (g.__loadHeld ?? 0) + 1;
      await gate;
      return original(...args);
    });
  });
}

async function releaseLoads(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    (globalThis as unknown as { __releaseLoads: () => void }).__releaseLoads();
  });
}

async function startHeldLoad(app: ElectronApplication, page: Page): Promise<void> {
  await holdLoads(app);
  await page.keyboard.press('Control+o');
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __loadHeld: number }).__loadHeld))
    .toBe(1);
}

/** 面を 1 つ保存した書類で、頂点の道具を構えたところまで進める。 */
async function savedFace(page: Page) {
  await jumpToYear(page, 1500);
  const { faceId, corners, cx, cy } = await commitOneFace(page);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId(STATUS)).toContainText('保存しました');
  await page.getByTestId('tool-edit.vertex').click();
  await expect(page.getByTestId('tool-edit.vertex')).toHaveAttribute('aria-pressed', 'true');
  const [x, y] = corners[0]!;
  return { faceId, grip: { x, y }, cx, cy };
}

async function pull(page: Page, grip: { readonly x: number; readonly y: number }): Promise<void> {
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 30, grip.y - 20, { steps: 4 });
  await page.mouse.up();
}

function savedTarget(): string {
  return join(mkdtempSync(join(tmpdir(), 'gimoza-load-gate-')), 'a.gimoza');
}

test.describe('読み込みの間の編集', () => {
  test('頂点を引く: 押した時点で断り、形も履歴も変わらない。反映のあとは普通に引ける', async () => {
    const target = savedTarget();
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target, E2E_OPEN_PATH: target } });
    try {
      const { faceId, grip } = await savedFace(page);
      const before = await committedVertices(page, faceId);
      const undo = await page.getByTestId(CAN_UNDO).textContent();
      await startHeldLoad(app, page);

      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      await page.mouse.move(grip.x - 30, grip.y - 20, { steps: 4 });
      await page.mouse.up();
      expect(await committedVertices(page, faceId)).toEqual(before);
      await expect(page.getByTestId(CAN_UNDO)).toHaveText(undo ?? '');

      await releaseLoads(app);
      // 反映すると状態行は消える。断りは残らない。
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await expect(page.getByTestId(CAN_UNDO)).toHaveText('0');
      await jumpToYear(page, 1500);
      // 反映すると鍵は閉じる（読むだけで始まる）。
      await leaveViewMode(page);
      await page.getByTestId('tool-edit.vertex').click();
      const after = await committedVertices(page, faceId);
      expect(after).toEqual(before);
      await pull(page, grip);
      await expect.poll(() => committedVertices(page, faceId)).not.toEqual(before);
      await expect(page.getByTestId(CAN_UNDO)).toHaveText('1');
    } finally {
      await app.close();
    }
  });

  test('地図を引いて動かすのと年を動かすのは、読み込みの間も断らない', async () => {
    const target = savedTarget();
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target, E2E_OPEN_PATH: target } });
    try {
      await savedFace(page);
      await startHeldLoad(app, page);
      await page.keyboard.press('.');
      await expect(page.getByTestId('timeline-current')).toHaveText('1501年');
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await releaseLoads(app);
    } finally {
      await app.close();
    }
  });

  test('Delete: 確認の板も出さずに断り、地物は残る', async () => {
    const target = savedTarget();
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target, E2E_OPEN_PATH: target } });
    try {
      const { faceId } = await savedFace(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await page.keyboard.press('Delete');
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      await expect(page.getByTestId(IMPACT)).toHaveCount(0);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount);
      await releaseLoads(app);
    } finally {
      await app.close();
    }
  });

  test('素性の保存: 記録せず、打った値は未保存のまま残る。読み込みに失敗したら保存し直せる', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-load-gate-'));
    const { app, page } = await launchApp({
      extraEnv: { E2E_SAVE_AS_PATH: join(dir, 'a.gimoza'), E2E_OPEN_PATH: join(dir, 'missing.gimoza') },
    });
    try {
      const { faceId } = await savedFace(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await page.getByTestId('sidebar-tab-properties').click();
      const title = await page.getByTestId('property-title-name').textContent();
      const undo = await page.getByTestId(CAN_UNDO).textContent();
      await startHeldLoad(app, page);

      const nameField = page.getByTestId('basic-info').getByLabel(PROPERTY_STRINGS.nameLabel);
      await nameField.fill('読み込みの間の名前');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      await expect(page.getByTestId('property-title-name')).toHaveText(title ?? '');
      await expect(page.getByTestId(CAN_UNDO)).toHaveText(undo ?? '');
      // 保存したことにしない: 打った値が残り、保存ボタンが押せるまま。
      await expect(nameField).toHaveValue('読み込みの間の名前');
      await expect(page.getByTestId('save-button')).toBeEnabled();

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('property-title-name')).toHaveText('読み込みの間の名前');
    } finally {
      await app.close();
    }
  });

  test('取り消し: Ctrl+Z を断り、地物は残る', async () => {
    const target = savedTarget();
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target, E2E_OPEN_PATH: target } });
    try {
      await savedFace(page);
      await expect(page.getByTestId(CAN_UNDO)).toHaveText('1');
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await page.keyboard.press('Control+z');
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount);
      await expect(page.getByTestId(CAN_UNDO)).toHaveText('1');
      await releaseLoads(app);
    } finally {
      await app.close();
    }
  });

  test('道具の確定: 記録せず、下書きは残る。読み込みに失敗したら確定し直せる', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-load-gate-'));
    const { app, page } = await launchApp({
      extraEnv: { E2E_SAVE_AS_PATH: join(dir, 'a.gimoza'), E2E_OPEN_PATH: join(dir, 'missing.gimoza') },
    });
    try {
      const { cx, cy } = await savedFace(page);
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await armAddAreaTool(page);
      await placeVertices(page, squareCorners(cx + 150, cy + 100, 30));
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      await page.waitForTimeout(200);
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount);
      // 下書きを捨てない: 素性の欄がまだ出ている。
      await expect(page.getByTestId('add-property-form')).toBeVisible();

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount + 1);
    } finally {
      await app.close();
    }
  });

  test('読み込みに失敗したら断りが消え、編集は普通に戻る', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gimoza-load-gate-'));
    const { app, page } = await launchApp({
      extraEnv: { E2E_SAVE_AS_PATH: join(dir, 'a.gimoza'), E2E_OPEN_PATH: join(dir, 'missing.gimoza') },
    });
    try {
      const { faceId, grip } = await savedFace(page);
      const before = await committedVertices(page, faceId);
      await startHeldLoad(app, page);

      await pull(page, grip);
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      expect(await committedVertices(page, faceId)).toEqual(before);

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await pull(page, grip);
      await expect.poll(() => committedVertices(page, faceId)).not.toEqual(before);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
    } finally {
      await app.close();
    }
  });
});

test.describe('OS のダイアログ', () => {
  /**
   * 本物の代わりに、渡された引数を覚えて「やめた」を返す。**使い回しの起動へ漏らさない**ため、起動の鍵を
   * 検査ごとに変える。
   */
  async function replaceDialogs(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ dialog, BrowserWindow }) => {
      const g = globalThis as unknown as { __dialogCalls?: string[]; __closeOpenDialog?: () => void };
      g.__dialogCalls = [];
      const parentOf = (args: readonly unknown[]): string =>
        args[0] instanceof BrowserWindow ? 'window' : 'none';
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async (...args: unknown[]) => {
        g.__dialogCalls?.push(`open:${parentOf(args)}`);
        await new Promise<void>((resolve) => {
          g.__closeOpenDialog = resolve;
        });
        return { canceled: true, filePaths: [] };
      };
      (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (...args: unknown[]) => {
        g.__dialogCalls?.push(`save:${parentOf(args)}`);
        return { canceled: true, filePath: '' };
      };
    });
  }
  const dialogCalls = (app: ElectronApplication): Promise<readonly string[]> =>
    app.evaluate(() => (globalThis as unknown as { __dialogCalls: string[] }).__dialogCalls);

  test('開く・保存のダイアログは親の窓を受け取る。開くをやめたら編集は普通に戻り、断りは残らない', async () => {
    const { app, page } = await launchApp({ extraEnv: { E2E_LOAD_GATE_LAUNCH: randomUUID() } });
    try {
      await jumpToYear(page, 1500);
      const { faceId, corners } = await commitOneFace(page);
      await replaceDialogs(app);

      // 名前を付けて保存（保存先が無いのでダイアログへ行く）。
      await page.keyboard.press('Control+s');
      await expect.poll(() => dialogCalls(app)).toEqual(['save:window']);

      // 開く: 未保存の確認に答えると、ダイアログが開いたままになる。
      await page.keyboard.press('Control+o');
      await page.getByTestId('unsaved-discard').click();
      await expect.poll(() => dialogCalls(app)).toEqual(['save:window', 'open:window']);

      await app.evaluate(() => {
        (globalThis as unknown as { __closeOpenDialog: () => void }).__closeOpenDialog();
      });
      await page.getByTestId('tool-edit.vertex').click();
      const before = await committedVertices(page, faceId);
      const [x, y] = corners[0]!;
      await pull(page, { x, y });
      await expect.poll(() => committedVertices(page, faceId)).not.toEqual(before);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
    } finally {
      await app.close();
    }
  });
});
