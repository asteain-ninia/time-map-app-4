// 読み込みが動いている間は、書類を変える操作を全部断る（`docs/現状.md` の B120 の直し。2026-11-01 の
// 所有者の裁定）。断らないと、旧書類へ記録して反映で履歴ごと消える。未保存の確認はもう済んでいるので、
// 何も聞かれずに消える。
//
// 読み込みの間は主プロセスの返事を止めて作る（時間で待たない。止めた口を開くまで反映は来ない）。
// OS のダイアログは差し替えで見る（本物を出すと焦点を奪う）。

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { PROPERTY_STRINGS } from '../src/ui/property/messages';
import { PROJECT_FIELD_STRINGS } from '../src/ui/settings/strings';
import { RESULT_STRINGS, UI_COMMAND_LABEL, commandLabelJa } from '../src/ui/shell/command-result';
import { APP_STRINGS } from '../src/ui/shell/strings';

import {
  armAddAreaTool,
  besideSquareX,
  commitFace,
  commitOneFace,
  committedVertices,
  DEFAULT_FACE_HALF,
  jumpToYear,
  launchApp,
  leaveViewMode,
  openPropertySection,
  placeVertices,
  projectStats,
  squareCorners,
} from './helpers';

const STATUS = 'statusbar-result';
const CAN_UNDO = 'app-can-undo';
const IMPACT = 'delete-impact';
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

/** 検査ごとの一時フォルダ。検査のあとで消す。 */
const madeDirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gimoza-load-gate-'));
  madeDirs.push(dir);
  return dir;
}
test.afterEach(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function savedTarget(): string {
  return join(scratchDir(), 'a.gimoza');
}

/** 保存はでき、開くと失敗する起動（断られたあと、読み込みが失敗して続けられることを見る）。 */
function failingLoadEnv(): Readonly<Record<string, string>> {
  const dir = scratchDir();
  return { E2E_SAVE_AS_PATH: join(dir, 'a.gimoza'), E2E_OPEN_PATH: join(dir, 'missing.gimoza') };
}

/** 断りが出て、止まったまま変わらないこと（確定を 1 コマ遅らせる道具があるので少し待って読み直す）。 */
async function expectRefusedAndStays(page: Page): Promise<void> {
  await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
  await page.waitForTimeout(200);
  await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
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
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
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
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
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

  test('分ける: 切り線と名前が残り、読み込みに失敗したらそのまま確定し直せる', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      const { cx, cy } = await savedFace(page);
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await page.getByTestId('tool-edit.knife').click();
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('knife-tool')).toHaveAttribute('data-flow', 'drawing-cut');
      await page.mouse.click(cx - 200, cy);
      await page.mouse.click(cx + 200, cy);
      await page.getByTestId('knife-confirm-cut').click();
      await page.getByTestId('knife-choose-0').click();
      await page.getByTestId('knife-confirm-inheritor').click();
      await page.getByTestId('add-name').fill('切った片');
      await page.getByTestId('add-save').click();

      await expectRefusedAndStays(page);
      await expect(page.getByTestId('knife-tool')).toHaveAttribute('data-flow', 'entering-properties');
      await expect(page.getByTestId('add-name')).toHaveValue('切った片');
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount);

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount + 1);
    } finally {
      await app.close();
    }
  });

  test('穴あけ: 囲んだ頂点と名前が残り、読み込みに失敗したらそのまま確定し直せる', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      const { cx, cy } = await savedFace(page);
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await page.getByTestId('tool-edit.drill').click();
      await expect(page.getByTestId('drill-tool')).toBeVisible();
      await page.mouse.click(cx, cy);
      const r = DEFAULT_FACE_HALF / 3;
      await page.mouse.click(cx - r, cy - r);
      await page.mouse.click(cx + r, cy - r);
      await page.mouse.click(cx, cy + r);
      await page.getByTestId('drill-confirm').click();
      await page.getByTestId('add-name').fill('くり抜いた島');
      await page.getByTestId('add-save').click();

      await expectRefusedAndStays(page);
      await expect(page.getByTestId('drill-tool')).toHaveAttribute('data-flow', 'entering-properties');
      await expect(page.getByTestId('add-name')).toHaveValue('くり抜いた島');
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount);

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount + 1);
    } finally {
      await app.close();
    }
  });

  /** 2 つ目の面を足して保存する。戻り値は 2 つ目の面の id と中心。 */
  async function secondFace(page: Page, cx: number, cy: number) {
    const x = besideSquareX(cx, DEFAULT_FACE_HALF);
    const faceId = await commitFace(page, squareCorners(x, cy, DEFAULT_FACE_HALF));
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId(STATUS)).toContainText('保存しました');
    return { faceId, x };
  }

  test('結合: 板と対象が残り、読み込みに失敗したらそのまま確定し直せる', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      const { cx, cy } = await savedFace(page);
      const { x } = await secondFace(page, cx, cy);
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await page.getByTestId('tool-edit.merge').click();
      await page.mouse.click(cx, cy);
      await page.mouse.click(x, cy);
      await expect(page.getByTestId('merge-target-count')).toHaveText('2');
      await page.getByTestId('merge-confirm').click();
      const dialog = page.getByTestId('merge-options-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId('merge-options-confirm').click();

      await expectRefusedAndStays(page);
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('merge-tool')).toHaveAttribute('data-flow', 'choosing');
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount);

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('merge-options-confirm').click();
      await expect(dialog).toHaveCount(0);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount - 1);
    } finally {
      await app.close();
    }
  });

  test('所属変更: 板と選んだ行き先が残り、読み込みに失敗したらそのまま確定し直せる', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      const { cx, cy, faceId } = await savedFace(page);
      const second = await secondFace(page, cx, cy);
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId(`ledger-mark-${faceId}`).check();
      await page.getByTestId('tool-edit.reparent').click();
      await page.getByTestId('reparent-confirm').click();
      const dialog = page.getByTestId('reparent-options-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId(`reparent-parent-existing-pick-item-${second.faceId}`).click();
      await page.getByTestId('reparent-options-confirm').click();

      await expectRefusedAndStays(page);
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('reparent-tool')).not.toHaveAttribute('data-flow', 'rejected');
      expect(await projectStats(page)).toEqual(stats);

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('reparent-options-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId(STATUS)).toContainText(RESULT_STRINGS.done(commandLabelJa(UI_COMMAND_LABEL.Affiliation)));
    } finally {
      await app.close();
    }
  });

  test('輪郭の道具（手続きの入口の関門だけが守る）: 下書きが残り、読み込みに失敗したら確定し直せる', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      const { cx, cy, faceId } = await savedFace(page);
      const before = await committedVertices(page, faceId);
      await startHeldLoad(app, page);

      await page.getByTestId('tool-edit.ring').click();
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('ring-edit-tool')).toHaveAttribute('data-flow', 'drafting');
      const r = DEFAULT_FACE_HALF / 3;
      await page.mouse.click(cx - r, cy - r);
      await page.mouse.click(cx + r, cy - r);
      await page.mouse.click(cx, cy + r);
      await expect(page.getByTestId('ring-edit-vertex-count')).toHaveText('3');
      await page.getByTestId('ring-edit-confirm').click();

      await expectRefusedAndStays(page);
      await expect(page.getByTestId('ring-edit-vertex-count')).toHaveText('3');
      expect(await committedVertices(page, faceId)).toEqual(before);

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('ring-edit-confirm').click();
      await expect.poll(async () => (await committedVertices(page, faceId)).size).toBe(before.size + 3);
    } finally {
      await app.close();
    }
  });

  test('素性の欄の削除ボタン: 確認の板を出さずに断り、「削除しました」も出さない', async () => {
    const target = savedTarget();
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target, E2E_OPEN_PATH: target } });
    try {
      const { faceId } = await savedFace(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'danger-zone');
      const stats = await projectStats(page);
      await startHeldLoad(app, page);

      await page.getByTestId('delete-feature').getByRole('button').click();
      await expectRefusedAndStays(page);
      await expect(page.getByTestId(IMPACT)).toHaveCount(0);
      expect((await projectStats(page)).featureCount).toBe(stats.featureCount);
      await releaseLoads(app);
    } finally {
      await app.close();
    }
  });

  test('設定の板: 表示年の上限を変えて保存しても閉じず、入力が残り、理由を言う。読み込みに失敗したら保存し直せる', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      await savedFace(page);
      await startHeldLoad(app, page);

      await page.getByTestId('menu-tools').click();
      await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
      const dialog = page.getByTestId('settings-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId('settings-tab-project').click();
      const maxYear = page.getByLabel(PROJECT_FIELD_STRINGS.timelineMaxYear);
      await expect(maxYear).toBeEnabled();
      await maxYear.fill('9000');
      await page.getByTestId('settings-save').click();

      await expect(page.getByTestId('settings-error-documentLoad')).toHaveText(REFUSED);
      await expect(page.getByTestId(STATUS)).toContainText(REFUSED);
      await expect(dialog).toBeVisible();
      await expect(maxYear).toHaveValue('9000');

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('settings-save').click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('一括の種別（記録の漏斗の関門だけが守る）: 板と印が残り、読み込みに失敗したら確定し直せる', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      const { cx, cy, faceId } = await savedFace(page);
      const second = await secondFace(page, cx, cy);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId(`ledger-mark-${faceId}`).check();
      await page.getByTestId(`ledger-mark-${second.faceId}`).check();
      const undo = await page.getByTestId(CAN_UNDO).textContent();
      await startHeldLoad(app, page);

      await page.getByTestId(`feature-list-item-${faceId}`).click({ button: 'right' });
      await page.locator('[data-item-kind="bulkKindLabel"]').click();
      await page.getByTestId('bulk-kind-input').fill('州');
      await page.getByTestId('bulk-kind-confirm').click();

      await expectRefusedAndStays(page);
      await expect(page.getByTestId('bulk-kind-dialog')).toBeVisible();
      await expect(page.getByTestId('bulk-kind-input')).toHaveValue('州');
      await expect(page.getByTestId('ledger-marks')).toBeVisible();
      await expect(page.getByTestId(CAN_UNDO)).toHaveText(undo ?? '');

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await page.getByTestId('bulk-kind-confirm').click();
      await expect(page.getByTestId('bulk-kind-dialog')).toHaveCount(0);
      await expect(page.getByTestId('ledger-marks')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('存続期間の欄（記録の漏斗の関門だけが守る）: 開始年の即時の編集を断り、履歴も形も変わらない', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
    try {
      await savedFace(page);
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'anchor-section');
      const panel = page.getByTestId('sidebar-panel-properties');
      await panel.locator('[data-testid^="anchor-interval-summary-"]').first().click();
      const year = panel.locator('[data-testid^="anchor-interval-start-"][data-testid$="-year"]').first();
      const confirm = panel.locator('[data-testid^="anchor-interval-start-"][data-testid$="-confirm"]').first();
      const interval = panel.getByRole('status').filter({ hasText: '→' });
      await expect(interval).toContainText('1500');
      await startHeldLoad(app, page);

      await year.fill('1400');
      await confirm.click();
      await expectRefusedAndStays(page);
      await expect(interval).toContainText('1500');
      await expect(year).toHaveValue('1400');

      await releaseLoads(app);
      await expect(page.getByTestId(STATUS)).not.toContainText(REFUSED);
      await confirm.click();
      await expect(interval).toContainText('1400');
    } finally {
      await app.close();
    }
  });

  test('読み込みに失敗したら断りが消え、編集は普通に戻る', async () => {
    const { app, page } = await launchApp({ extraEnv: failingLoadEnv() });
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
