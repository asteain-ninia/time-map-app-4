// ［頂点］［動かす］で引いている最中は年を動かさない（所有者の方針 2026-11-01。設計の記録は
// `docs/ui-redesign/README.md` の B-3）。
//
// 直す前の実機（1500 年に面を作って引き始める）:
//   押したまま `.`  ― 1501 年へ動き、離すと錨が 1 本から 2 本に増える。形は 1501 年に入り、1500 年は変わらない。
//   再生中に引く   ― 1500 年で押し 1502 年で離れ、同じく錨が増える（打鍵なし）。
//   1501 年に別の形 ― 1501 年の形が書き換わる。
//   `,` で 1499 年 ― 面が居ないので何も記録されず、ドラッグが消えたことも言わない。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { PROJECT_FIELD_STRINGS } from '../src/ui/settings/strings';
import { APP_STRINGS } from '../src/ui/shell/strings';
import { SYNTHETIC_NEST_PARENT_ID } from '../src/ui/e2e/synthetic-project';

import {
  addInputLayerBox,
  armAddAreaTool,
  armVertexTool,
  commitOneFace,
  commitSquareFace,
  committedVertices,
  jumpControls,
  jumpToYear,
  launchApp,
  leaveViewMode,
  liveCamera,
  loadProject,
  loadSyntheticNested,
  projectStats,
  worldToClient,
} from './helpers';

const STATUS = 'statusbar-result';
const YEAR = 'timeline-current';

type DragTool = 'edit.vertex' | 'edit.move';

interface Grip {
  readonly x: number;
  readonly y: number;
}

/** 1500 年に面を作り、道具を構えて、掴む位置（頂点の隅か面の内側）を返す。 */
async function faceReady(
  page: Page,
  tool: DragTool,
): Promise<{ readonly faceId: string; readonly grip: Grip; readonly cx: number; readonly cy: number }> {
  await jumpToYear(page, 1500);
  const { faceId, cx, cy, corners } = await commitOneFace(page);
  await page.getByTestId(`tool-${tool}`).click();
  await expect(page.getByTestId(`tool-${tool}`)).toHaveAttribute('aria-pressed', 'true');
  const [cornerX, cornerY] = corners[0]!;
  const grip = tool === 'edit.vertex' ? { x: cornerX, y: cornerY } : { x: cx, y: cy };
  return { faceId, grip, cx, cy };
}

/** 押して、しきい値を越えるまで引く（離さない）。 */
async function pressAndPull(page: Page, grip: Grip): Promise<void> {
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 30, grip.y - 20, { steps: 4 });
}

/** 年の形を読む（年を動かすので、読み終えたら戻す年を渡す）。 */
async function shapeAt(page: Page, year: number, faceId: string, back: number) {
  await jumpToYear(page, year);
  const shape = await committedVertices(page, faceId);
  await jumpToYear(page, back);
  return shape;
}

const TOOLS: readonly DragTool[] = ['edit.vertex', 'edit.move'];

for (const tool of TOOLS) {
  test.describe(`引いている最中の年 — ${tool}`, () => {
    test('押したまま `.`: 年は動かず、言う。離すと押した年に記録され、錨は増えない。Ctrl+Z とやり直しも押した年', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        const before = await committedVertices(page, faceId);
        const stats = await projectStats(page);

        await pressAndPull(page, grip);
        await page.keyboard.press('.');
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
        await expect(page.getByTestId(YEAR)).toHaveText('1500年');
        await page.mouse.move(grip.x - 60, grip.y - 40, { steps: 3 });
        await page.mouse.up();

        await expect(page.getByTestId(YEAR)).toHaveText('1500年');
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(before);
        const moved = await committedVertices(page, faceId);
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
        // 関門が開いたままでない: 離したあとの `.` は効き、後ろの年も同じ形を引き継ぐ。
        await page.keyboard.press('.');
        await expect(page.getByTestId(YEAR)).toHaveText('1501年');
        expect(await committedVertices(page, faceId)).toEqual(moved);
        await jumpToYear(page, 1500);

        await page.keyboard.press('Control+z');
        await expect.poll(async () => committedVertices(page, faceId)).toEqual(before);
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
        await page.keyboard.press('Control+y');
        await expect.poll(async () => committedVertices(page, faceId)).toEqual(moved);
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
      } finally {
        await app.close();
      }
    });

    test('押したまま `,`（面の居ない 1499 年）: 年は動かず、ドラッグは消えず、押した年に記録される', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        const before = await committedVertices(page, faceId);
        await pressAndPull(page, grip);
        await page.keyboard.press(',');
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
        await expect(page.getByTestId(YEAR)).toHaveText('1500年');
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        await page.mouse.up();
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(before);
      } finally {
        await app.close();
      }
    });

    test('1501 年に別の形があるとき: 1501 年の形も錨の本数も変わらず、1500 年だけ変わる', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        const original = await committedVertices(page, faceId);
        // 1501 年に別の形を作る（隅を引く）。
        await jumpToYear(page, 1501);
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        await page.mouse.move(grip.x + 25, grip.y + 15, { steps: 4 });
        await page.mouse.up();
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(original);
        const at1501 = await committedVertices(page, faceId);
        const stats = await projectStats(page);
        await jumpToYear(page, 1500);

        await pressAndPull(page, grip);
        await page.keyboard.press('.');
        await page.mouse.up();

        await expect(page.getByTestId(YEAR)).toHaveText('1500年');
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(original);
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
        expect(await shapeAt(page, 1501, faceId, 1500)).toEqual(at1501);

        // 取り消すと 1500 年は元の形へ戻り、1501 年はそのまま。
        await page.keyboard.press('Control+z');
        await expect.poll(async () => committedVertices(page, faceId)).toEqual(original);
        expect(await shapeAt(page, 1501, faceId, 1500)).toEqual(at1501);
      } finally {
        await app.close();
      }
    });

    test('再生中に引き始める: 再生が止まり、そう言う。止めた年に記録され、離すまで年は動かない', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        const original = await committedVertices(page, faceId);
        const stats = await projectStats(page);
        const play = page.getByTestId('timeline-playback').getByRole('button').first();
        await play.click();
        await expect(play).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId(YEAR)).not.toHaveText('1500年');

        await pressAndPull(page, grip);
        await expect(play).toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragStoppedPlayback);
        const pressedText = (await page.getByTestId(YEAR).textContent()) ?? '';
        await page.waitForTimeout(1500);
        await expect(page.getByTestId(YEAR)).toHaveText(pressedText);
        const pressedShape = await committedVertices(page, faceId);
        await page.mouse.up();

        await expect(page.getByTestId(YEAR)).toHaveText(pressedText);
        await expect(play).toHaveAttribute('aria-pressed', 'false');
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(pressedShape);
        // 押した年に錨が 1 本だけ増え、1500 年はそのまま。
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount + 1);
        const pressedYear = Number(pressedText.replace(/\D/g, ''));
        expect(await shapeAt(page, 1500, faceId, pressedYear)).toEqual(original);
      } finally {
        await app.close();
      }
    });

    test('押したまま年を動かす入口はどれも効かない（直接ジャンプ・通史の行・戻る・再生）', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        // 通史の行の行き先を作る（1700 年の別の面）。面の真上を避けて置く。
        await jumpToYear(page, 1700);
        await armAddAreaTool(page);
        const b = await addInputLayerBox(page);
        await commitSquareFace(page, b.x + b.width / 2 - 300, b.y + b.height / 2 - 150, 30, {
          name: 'other-1700',
        });
        await jumpToYear(page, 1500);
        await page.getByTestId(`tool-${tool}`).click();
        await page.getByTestId('list-mode-history').click();
        await jumpControls(page).year.fill('1600');
        const stats = await projectStats(page);
        const before = await committedVertices(page, faceId);
        const row = page
          .locator('[data-testid^="event-list-item-"]')
          .filter({ hasText: 'other-1700' })
          .first();
        await expect(row).toBeVisible();

        // 面を選び直してから引く（1700 年の面の作成で選択が移っている）。
        await page.mouse.click(grip.x + (tool === 'edit.vertex' ? 40 : 0), grip.y + (tool === 'edit.vertex' ? 40 : 0));
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        await pressAndPull(page, grip);

        // マウスは押したままなので、ボタンへは合図を直接送る。
        const asserts = async (): Promise<void> => {
          await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
          await expect(page.getByTestId(YEAR)).toHaveText('1500年');
          await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        };
        await jumpControls(page).go.dispatchEvent('click');
        await asserts();
        await row.dispatchEvent('click');
        await asserts();
        await page.keyboard.press('Alt+ArrowLeft');
        await asserts();
        // 再生のボタン: 動かず、止まる。
        const play = page.getByTestId('timeline-playback').getByRole('button').first();
        await play.dispatchEvent('click');
        await expect(play).toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId(YEAR)).toHaveText('1500年');

        await page.mouse.up();
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(before);
        await expect(page.getByTestId(YEAR)).toHaveText('1500年');
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
      } finally {
        await app.close();
      }
    });

    test('設定の板を開くと記録せずに取り消して言い、範囲を狭めて年が補正されても何も記録しない', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        const before = await committedVertices(page, faceId);
        const stats = await projectStats(page);
        const undo = await page.getByTestId('app-can-undo').textContent();
        await pressAndPull(page, grip);
        // 板の覆いが地図を隠すので、押下は板が開いた時点で終わる（年の補正より先）。補正が生きた押下に
        // 当たる形は、`src/ui/map/mount/input.drag-year.test.tsx` が見る。
        await openSettingsWhilePressed(page);
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByBoard);
        await saveTimelineMaxWhilePressed(page, 1400);
        await expect(page.getByTestId(YEAR)).toHaveText('1400年');
        await page.mouse.up();
        await page.waitForTimeout(200);
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
        await expect(page.getByTestId('app-can-undo')).toHaveText(undo ?? '');
        // 範囲を戻して元の年を読む。
        await openSettingsWhilePressed(page);
        await saveTimelineMaxWhilePressed(page, 10000);
        await jumpToYear(page, 1500);
        expect(await committedVertices(page, faceId)).toEqual(before);
      } finally {
        await app.close();
      }
    });

    test('ファイルを開く: 記録せずに取り消して言う', async () => {
      const target = join(mkdtempSync(join(tmpdir(), 'gimoza-drag-year-')), 'a.gimoza');
      const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
      try {
        const { grip } = await faceReady(page, tool);
        await page.keyboard.press('Control+s');
        await expect(page.getByTestId(STATUS)).toContainText('保存しました');
        const stats = await projectStats(page);
        await pressAndPull(page, grip);
        expect(await loadProject(page, target)).toBe('loaded');
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByProject);
        await page.mouse.up();
        await page.waitForTimeout(200);
        expect(await projectStats(page)).toEqual(stats);
      } finally {
        await app.close();
      }
    });

    test('押したまま読み込みを始める: 反映の前に離しても記録しない。始めた時点で言い、反映のあとも言う', async () => {
      const target = join(mkdtempSync(join(tmpdir(), 'gimoza-drag-year-')), 'a.gimoza');
      const { app, page } = await launchApp({
        extraEnv: { E2E_SAVE_AS_PATH: target, E2E_OPEN_PATH: target },
      });
      try {
        const { faceId, grip } = await faceReady(page, tool);
        await page.keyboard.press('Control+s');
        await expect(page.getByTestId(STATUS)).toContainText('保存しました');
        const before = await committedVertices(page, faceId);
        // 読み込みの遅いファイルの代わり（主プロセスの返事を遅らせる）。E2E は OS のダイアログを飛ばす
        // ので焦点も動かず、読み込みの開始の取り消しだけが効く。
        await delayFileLoads(app, 1500);
        const undo = await page.getByTestId('app-can-undo').textContent();
        await pressAndPull(page, grip);
        await page.keyboard.press('Control+o');
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByLoadStart);
        await page.mouse.up();
        await page.waitForTimeout(200);
        // 反映の前: 旧書類へ何も記録していない。
        expect(await committedVertices(page, faceId)).toEqual(before);
        await expect(page.getByTestId('app-can-undo')).toHaveText(undo ?? '');
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByProject);
        expect(await committedVertices(page, faceId)).toEqual(before);
      } finally {
        await app.close();
      }
    });

    test('読み込みに失敗したら、始めた時点の文が残り、あとの読み込みで「閉じた」と言わない', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gimoza-drag-year-'));
      const target = join(dir, 'a.gimoza');
      const { app, page } = await launchApp({
        extraEnv: { E2E_SAVE_AS_PATH: target, E2E_OPEN_PATH: join(dir, 'missing.gimoza') },
      });
      try {
        const { faceId, grip } = await faceReady(page, tool);
        await page.keyboard.press('Control+s');
        await expect(page.getByTestId(STATUS)).toContainText('保存しました');
        const before = await committedVertices(page, faceId);
        await pressAndPull(page, grip);
        await page.keyboard.press('Control+o');
        await expect(page.getByTestId(STATUS)).not.toContainText('保存しました');
        await page.mouse.up();
        await page.waitForTimeout(200);
        expect(await committedVertices(page, faceId)).toEqual(before);
        expect(await loadProject(page, target)).toBe('loaded');
        await page.waitForTimeout(200);
        await expect(page.getByTestId(STATUS)).not.toContainText(APP_STRINGS.dragCancelledByProject);
      } finally {
        await app.close();
      }
    });

    test('押したまま Ctrl+Z: 取り消しが走ったら、引いていたものも記録せずに取り消して言う', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        // 取り消す相手を作る: 一度引いて確定する。
        const original = await committedVertices(page, faceId);
        await pressAndPull(page, grip);
        await page.mouse.up();
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(original);

        const grip2 = await currentGrip(page, faceId, tool, grip);
        await pressAndPull(page, grip2);
        await page.keyboard.press('Control+z');
        await expect.poll(async () => committedVertices(page, faceId)).toEqual(original);
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByDocument);
        await page.mouse.up();
        await page.waitForTimeout(200);
        expect(await committedVertices(page, faceId)).toEqual(original);
      } finally {
        await app.close();
      }
    });
  });
}

/** 主プロセスの読み込みの返事を遅らせる（読み込みの遅いファイルの代わり）。 */
async function delayFileLoads(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate(({ ipcMain }, delay) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })
      ._invokeHandlers;
    const original = handlers.get('tmap:load');
    if (original === undefined) throw new Error('読み込みの口が見つからない');
    handlers.set('tmap:load', async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return original(...args);
    });
  }, ms);
}

/** 確定のあとの掴む位置（頂点の道具は動いた隅、面の道具は面の真ん中のまま）。 */
async function currentGrip(page: Page, faceId: string, tool: DragTool, grip: Grip): Promise<Grip> {
  if (tool === 'edit.move') return { x: grip.x - 30, y: grip.y - 20 };
  // 頂点は引いた先に居る（押した隅から -30, -20）。
  const vertices = await committedVertices(page, faceId);
  const first = [...vertices.values()];
  const near = await Promise.all(first.map((w) => worldToClient(page, w)));
  near.sort(
    (a, b) =>
      Math.hypot(a.x - (grip.x - 30), a.y - (grip.y - 20)) -
      Math.hypot(b.x - (grip.x - 30), b.y - (grip.y - 20)),
  );
  return near[0]!;
}

/** マウスを押したまま設定の板を開く（ボタンへは合図を直接送る）。 */
async function openSettingsWhilePressed(page: Page): Promise<void> {
  await page.getByTestId('menu-tools').dispatchEvent('click');
  await page
    .getByTestId('menu-items-tools')
    .locator('[data-command="tools.settings"]')
    .dispatchEvent('click');
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
}

/** 開いている設定の板で、表示年の上限を変えて保存する。 */
async function saveTimelineMaxWhilePressed(page: Page, year: number): Promise<void> {
  await page.getByTestId('settings-tab-project').dispatchEvent('click');
  const max = page.getByLabel(PROJECT_FIELD_STRINGS.timelineMaxYear);
  await expect(max).toBeEnabled();
  await max.fill(String(year));
  await expect(max).toHaveValue(String(year));
  await page.getByTestId('settings-save').dispatchEvent('click');
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
}

test.describe('引いている最中の年 — 同じ確定の経路に乗る引き', () => {
  test('複数の頂点を一緒に引く: `.` は効かず、選んだ全部が押した年に動く', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, grip } = await faceReady(page, 'edit.vertex');
      const before = await committedVertices(page, faceId);
      const stats = await projectStats(page);
      // 右上の隅（DEFAULT_FACE_HALF ぶん離れた頂点）も Shift で足す。
      const corners = await Promise.all([...before.values()].map((w) => worldToClient(page, w)));
      const other = corners.find((c) => Math.abs(c.x - grip.x) > 5 && Math.abs(c.y - grip.y) < 5)!;
      await page.mouse.click(grip.x, grip.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(other.x, other.y);
      await page.keyboard.up('Shift');

      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x, grip.y - 30, { steps: 4 });
      await page.keyboard.press('.');
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      await page.mouse.up();

      await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(before);
      const after = await committedVertices(page, faceId);
      const movedCount = [...before.entries()].filter(
        ([id, w]) => after.get(id)?.lat !== w.lat,
      ).length;
      expect(movedCount).toBe(2);
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
    } finally {
      await app.close();
    }
  });

  test('辺のスライド（中点の印から引いて頂点を足す）: `.` は効かず、押した年に足す', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, grip } = await faceReady(page, 'edit.vertex');
      const before = await committedVertices(page, faceId);
      const stats = await projectStats(page);
      const corners = await Promise.all([...before.values()].map((w) => worldToClient(page, w)));
      const other = corners.find((c) => Math.abs(c.x - grip.x) > 5 && Math.abs(c.y - grip.y) < 5)!;
      const mid = { x: (grip.x + other.x) / 2, y: (grip.y + other.y) / 2 };
      await pressAndPull(page, mid);
      await page.keyboard.press('.');
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
      await page.mouse.up();
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      await expect.poll(async () => (await committedVertices(page, faceId)).size).toBe(before.size + 1);
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
    } finally {
      await app.close();
    }
  });

  test('辺の中点のクリック（動かさず離す）も、押してから `.` は効かず、押した年に足す', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, grip } = await faceReady(page, 'edit.vertex');
      const before = await committedVertices(page, faceId);
      const stats = await projectStats(page);
      const corners = await Promise.all([...before.values()].map((w) => worldToClient(page, w)));
      const other = corners.find((c) => Math.abs(c.x - grip.x) > 5 && Math.abs(c.y - grip.y) < 5)!;
      await page.mouse.move((grip.x + other.x) / 2, (grip.y + other.y) / 2);
      await page.mouse.down();
      await page.keyboard.press('.');
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
      await page.mouse.up();
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      await expect.poll(async () => (await committedVertices(page, faceId)).size).toBe(before.size + 1);
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
    } finally {
      await app.close();
    }
  });

  test('吸着つきの移動: `.` は効かず、隣の頂点を共有する形が押した年に入る', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, grip } = await faceReady(page, 'edit.vertex');
      // 左の隅から少し離して隣の面を置く（隣の右上の頂点へ吸着させる）。
      await armAddAreaTool(page);
      const neighbourHalf = 30;
      const nx = grip.x - neighbourHalf - 40;
      const ny = grip.y + 60;
      const neighbour = await commitSquareFace(page, nx, ny, neighbourHalf, { name: 'neighbour' });
      const target = { x: nx + neighbourHalf, y: ny - neighbourHalf };
      const stats = await projectStats(page);
      await armVertexTool(page);
      await page.mouse.click(grip.x + 40, grip.y + 40); // 元の面を選び直す
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(target.x + 2, target.y + 2, { steps: 6 });
      await page.keyboard.press('.');
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
      await page.mouse.up();
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');

      await expect
        .poll(async () => {
          const mine = await committedVertices(page, faceId);
          const theirs = await committedVertices(page, neighbour);
          return [...mine.keys()].filter((id) => theirs.has(id)).length;
        })
        .toBe(1);
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
    } finally {
      await app.close();
    }
  });

  test('集約地物の分岐: 引いている間 `.` は効かず、離すと押した年に下位領域が動く', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticNested(page, 6, [1000, 1200]);
      await jumpToYear(page, 1000);
      await leaveViewMode(page);
      const vertices = [...(await committedVertices(page, 'syn-nest-child-2')).values()];
      const at = await worldToClient(page, {
        lon: vertices.reduce((a, p) => a + p.lon, 0) / vertices.length,
        lat: vertices.reduce((a, p) => a + p.lat, 0) / vertices.length,
      });
      await page.getByTestId('tool-edit.move').click();
      await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText(SYNTHETIC_NEST_PARENT_ID);
      const year = await page.getByTestId(YEAR).textContent();
      const stats = await projectStats(page);
      await pressAndPull(page, at);
      await page.keyboard.press('.');
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
      await expect(page.getByTestId(YEAR)).toHaveText(year ?? '');
      await page.mouse.up();
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(6, 0));
      await expect(page.getByTestId(YEAR)).toHaveText(year ?? '');
      // 押した 1000 年の錨へ入り、錨は増えない。
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
    } finally {
      await app.close();
    }
  });

  test('重なりで板が出る引き: 引いている間 `.` は効かず、板の適用も押した年に入る', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await faceReady(page, 'edit.move');
      await armAddAreaTool(page);
      const blocker = await commitSquareFace(page, cx + 260, cy, 60, { name: 'blocker' });
      const stats = await projectStats(page);
      await page.getByTestId('tool-edit.move').click();
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      const before = await committedVertices(page, faceId);

      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 200, cy, { steps: 6 });
      await page.keyboard.press('.');
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragHoldsTime);
      await page.mouse.up();
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      // 形はまだ変わっていない。
      expect(await committedVertices(page, faceId)).toEqual(before);
      const guide = page.getByTestId('conflict-guide');
      if (await guide.isVisible()) await page.getByTestId('conflict-guide-close').click();
      const row = page.getByTestId('conflict-rows').locator('li').first();
      // 名前は検査が描いた面のデータで、画面の文言ではない。
      await row.getByRole('radio', { name: /blocker/ }).check();
      await page.getByTestId('conflict-apply').click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(before);
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
      expect(blocker).not.toBe('');
    } finally {
      await app.close();
    }
  });
});

test.describe('引いている最中の年 — 関門が要らない所', () => {
  test('「選択」の地図の移動（記録しない）は対象外で、押したまま `.` で年が動く', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      const cam = await liveCamera(page);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 40, cy + 30, { steps: 4 });
      await page.keyboard.press('.');
      await expect(page.getByTestId(YEAR)).toHaveText('1501年');
      await page.mouse.up();
      expect((await liveCamera(page)).centerLon).not.toBe(cam.centerLon);
    } finally {
      await app.close();
    }
  });

  test('Escape で取りやめたら関門は残らず、`.` は効く。何も記録しない', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, grip } = await faceReady(page, 'edit.vertex');
      const before = await committedVertices(page, faceId);
      await pressAndPull(page, grip);
      await page.keyboard.press('Escape');
      await page.keyboard.press('.');
      await expect(page.getByTestId(YEAR)).toHaveText('1501年');
      await page.mouse.up();
      await jumpToYear(page, 1500);
      expect(await committedVertices(page, faceId)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test('地図の外へ出て畳まれたら関門は残らず、`.` は効く', async () => {
    const { app, page } = await launchApp();
    try {
      const { grip } = await faceReady(page, 'edit.vertex');
      await pressAndPull(page, grip);
      const rail = (await page.getByTestId('timeline').boundingBox())!;
      await page.mouse.move(rail.x + 40, rail.y + rail.height / 2);
      await page.keyboard.press('.');
      await expect(page.getByTestId(YEAR)).toHaveText('1501年');
      await page.mouse.up();
    } finally {
      await app.close();
    }
  });

  test('読むだけの地図の移動中は何も止めない', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.getByTestId('mode-view').click();
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 3 });
      await page.keyboard.press('.');
      await expect(page.getByTestId(YEAR)).toHaveText('1501年');
      await page.mouse.up();
    } finally {
      await app.close();
    }
  });
});

// 離した知らせを取りこぼす（2026-11-01）。OS の窓の切り替えはオフスクリーンの窓では作れないので、
// 実機で届くはずの合図の列を合成して地図の入力層へ送る。実機の `blur`・`buttons` の値そのものは
// ここでは確かめていない（`docs/現状.md` の B121）。
const INPUT_LAYER = 'map-input-layer';

interface SyntheticPointer {
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
}

/** 地図の入力層へポインタの合図を 1 つ送る（マウスの `pointerId` は 1）。 */
async function sendPointer(page: Page, type: string, p: SyntheticPointer): Promise<void> {
  await page.getByTestId(INPUT_LAYER).dispatchEvent(type, {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: p.buttons,
    clientX: p.x,
    clientY: p.y,
  });
}

/** 押して引く（離さない）を合成で行う。 */
async function pressAndPullSynthetic(page: Page, grip: Grip): Promise<void> {
  await sendPointer(page, 'pointerdown', { ...grip, buttons: 1 });
  await sendPointer(page, 'pointermove', { x: grip.x - 15, y: grip.y - 10, buttons: 1 });
  await sendPointer(page, 'pointermove', { x: grip.x - 30, y: grip.y - 20, buttons: 1 });
}

/** 取り消しのあと: 年は普通に動き、再生も始まって止まる。 */
async function expectTimeWorks(page: Page): Promise<void> {
  await page.keyboard.press('.');
  await expect(page.getByTestId(YEAR)).toHaveText('1501年');
  const play = page.getByTestId('timeline-playback').getByRole('button').first();
  await play.click();
  await expect(page.getByTestId(YEAR)).not.toHaveText('1501年');
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await jumpToYear(page, 1500);
}

for (const tool of TOOLS) {
  test.describe(`離した知らせの取りこぼし — ${tool}`, () => {
    test('押したボタンが無い移動: 記録せずに取り消して言う。年と再生は動き、古いドラッグは確定しない', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        const before = await committedVertices(page, faceId);
        const stats = await projectStats(page);
        const undo = await page.getByTestId('app-can-undo').textContent();
        await pressAndPullSynthetic(page, grip);
        await sendPointer(page, 'pointermove', { x: grip.x - 40, y: grip.y - 25, buttons: 0 });
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByLostRelease);
        await expectTimeWorks(page);
        // 遅れて届いた離しは、もう何も確定しない。
        await sendPointer(page, 'pointerup', { x: grip.x - 80, y: grip.y - 50, buttons: 0 });
        await page.waitForTimeout(200);
        expect(await committedVertices(page, faceId)).toEqual(before);
        expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);
        await expect(page.getByTestId('app-can-undo')).toHaveText(undo ?? '');
      } finally {
        await app.close();
      }
    });

    test('離しが無いまま次の押下: 前を取り消して言い、その離しは古いドラッグを確定しない', async () => {
      const { app, page } = await launchApp();
      try {
        const { faceId, grip } = await faceReady(page, tool);
        const before = await committedVertices(page, faceId);
        await pressAndPullSynthetic(page, grip);
        // 同じものを掴み直して、動かさず離す。古いドラッグが確定する形なら、ここで形が変わる。
        await sendPointer(page, 'pointerdown', { ...grip, buttons: 1 });
        await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByLostRelease);
        await sendPointer(page, 'pointerup', { ...grip, buttons: 0 });
        await page.waitForTimeout(200);
        expect(await committedVertices(page, faceId)).toEqual(before);
        // そのあとの押下は新しい押下として効く。
        await pressAndPull(page, grip);
        await page.mouse.up();
        await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(before);
      } finally {
        await app.close();
      }
    });

    for (const signal of ['blur', 'visibilitychange'] as const) {
      test(`押したまま ${signal}: 記録せずに取り消して言う。離しても確定しない`, async () => {
        const { app, page } = await launchApp();
        try {
          const { faceId, grip } = await faceReady(page, tool);
          const before = await committedVertices(page, faceId);
          await pressAndPull(page, grip);
          await page.evaluate((s) => {
            if (s === 'blur') {
              window.dispatchEvent(new Event('blur'));
              return;
            }
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            // 覆った読み取りを外すと、元の値が見える。
            delete (document as unknown as { visibilityState?: unknown }).visibilityState;
          }, signal);
          await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.dragCancelledByWindowLeft);
          await page.mouse.up();
          await expectTimeWorks(page);
          expect(await committedVertices(page, faceId)).toEqual(before);
        } finally {
          await app.close();
        }
      });
    }
  });
}

test.describe('離した知らせの取りこぼし — 地図の移動', () => {
  test('押したボタンが無い移動・焦点が外れたあとは地図が動かず、次の押下は新しい押下として動く。何も言わない', async () => {
    const { app, page } = await launchApp();
    try {
      await faceReady(page, 'edit.move');
      await page.getByTestId('tool-edit.select').click();
      const box = (await page.getByTestId(INPUT_LAYER).boundingBox())!;
      // 面から離れた、何もない所（下の左隅の近く）。
      const start = { x: box.x + 40, y: box.y + box.height - 40 };
      const status = await page.getByTestId(STATUS).textContent();
      await sendPointer(page, 'pointerdown', { ...start, buttons: 1 });
      await sendPointer(page, 'pointermove', { x: start.x + 30, y: start.y, buttons: 1 });
      const panned = await liveCamera(page);
      await sendPointer(page, 'pointermove', { x: start.x + 60, y: start.y, buttons: 0 });
      await sendPointer(page, 'pointermove', { x: start.x + 90, y: start.y, buttons: 1 });
      expect(await liveCamera(page)).toEqual(panned);

      await sendPointer(page, 'pointerdown', { ...start, buttons: 1 });
      await sendPointer(page, 'pointermove', { x: start.x + 30, y: start.y, buttons: 1 });
      const moved = await liveCamera(page);
      expect(moved).not.toEqual(panned);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await sendPointer(page, 'pointermove', { x: start.x + 90, y: start.y, buttons: 1 });
      expect(await liveCamera(page)).toEqual(moved);

      await sendPointer(page, 'pointerdown', { ...start, buttons: 1 });
      await sendPointer(page, 'pointerdown', { x: start.x + 5, y: start.y, buttons: 1 });
      await sendPointer(page, 'pointermove', { x: start.x + 45, y: start.y, buttons: 1 });
      await sendPointer(page, 'pointerup', { x: start.x + 45, y: start.y, buttons: 0 });
      expect(await liveCamera(page)).not.toEqual(moved);
      await expect(page.getByTestId(STATUS)).toHaveText(status ?? '');
    } finally {
      await app.close();
    }
  });
});
