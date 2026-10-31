// B112 の検査の補い（2026-11-01 の検証の指摘 2〜5）。
//
// 年を動かす入口は、続きを `setCurrentTime` の第 3 引数で渡す（教訓 5.71）。続きを外へ書き戻しても
// b112-draft-time の検査は緑のままだった入口を、ここで 1 つずつ押さえる。どの検査も、下書きの板で
// ［続ける］と答えたら続きが走らないこと、［捨てる］で走ることを見る。戻して赤くなるかは実際に試した
// （結果は `docs/実装済み.md`）。
//
//   goBack        ［続ける］で履歴が減ると、行き先が 1700→1600→1500 でなく 1700→1500→0 になる。
//   jumpAnchor    ［続ける］でレールの見える範囲が動く。
//   開始年を変える ［続ける］で存続期間の欄が開く。
//   ここに錨を作る ［続ける］で錨が作られる／［捨てる］で作られない。
//   端の送り       板のあいだ状態行が「動いた」と言う／捨てたことだけ残って端が読めない。
//   打っていた場所 ［続ける］で選択だけ動く。

import { expect, test, type Page } from '@playwright/test';

import { DRAFT_DISCARD_STRINGS, APP_STRINGS } from '../src/ui/shell/strings';
import { RAIL_STRINGS } from '../src/ui/timeline/rail-strings';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  commitSquareFace,
  jumpToYear,
  launchApp,
  projectStats,
  railMarkPositions,
  railView,
  requestYear,
} from './helpers';

const RING = 'edit.ring';
const ASK = 'ring-edit-draft-discard-confirm';
const KEEP = 'ring-edit-draft-discard-no';
const DROP = 'ring-edit-draft-discard-yes';
const COUNT = 'ring-edit-vertex-count';
const YEAR = 'timeline-current';
const STATUS = 'statusbar-result';
const FULL = [[-40, -40], [40, -40], [0, 40]] as const;

/** 輪郭の道具で (cx, cy) の面を掴み、`points` を打つ。 */
async function ringDraft(
  page: Page,
  cx: number,
  cy: number,
  points: readonly (readonly [number, number])[] = FULL,
): Promise<void> {
  await page.getByTestId(`tool-${RING}`).click();
  if ((await page.getByTestId('ring-edit-tool').getAttribute('data-flow')) === 'selecting-target') {
    await page.mouse.click(cx, cy);
  }
  await expect(page.getByTestId('ring-edit-tool')).not.toHaveAttribute('data-flow', 'selecting-target');
  for (const [dx, dy] of points) await page.mouse.click(cx + dx, cy + dy);
  await expect(page.getByTestId(COUNT)).toHaveText(String(points.length));
}

/** 表示メニューの時間のコマンドを押す（鍵盤は道具が持っているので、メニューから）。 */
async function viewMenu(page: Page, command: string): Promise<void> {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-items-view').locator(`[data-command="${command}"]`).click();
}

async function laneY(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('anchor-lane').boundingBox())!;
  return { x: box.x, y: box.y + box.height / 2 };
}

async function yearToLanePx(page: Page, year: number): Promise<number> {
  const v = await railView(page);
  return ((year - v.minYear) / (v.maxYear - v.minYear)) * v.pixelLength;
}

test.describe('B112 の入口 — 続きは年と一緒に走る', () => {
  test('直前の年へ戻る: ［続ける］で履歴は減らず、行き先は 1700→1600→1500 のまま', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await jumpToYear(page, 1600);
      await jumpToYear(page, 1700);
      await ringDraft(page, cx, cy);

      await viewMenu(page, 'time.back');
      await expect(page.getByTestId(ASK)).toBeVisible();
      await expect(page.getByTestId(YEAR)).toHaveText('1700年');
      await page.getByTestId(KEEP).click();
      await expect(page.getByTestId(ASK)).toBeHidden();
      await expect(page.getByTestId(YEAR)).toHaveText('1700年');

      await viewMenu(page, 'time.back');
      await page.getByTestId(DROP).click();
      await expect(page.getByTestId(YEAR)).toHaveText('1600年');
      await viewMenu(page, 'time.back');
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
    } finally {
      await app.close();
    }
  });

  test('前の錨へ: ［続ける］でレールの見える範囲は動かず、［捨てる］で年と一緒に動く', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await jumpToYear(page, 9000);
      await page.keyboard.press('Control+k');
      await expect.poll(async () => (await projectStats(page)).anchorCount).toBe(2);
      // レールを 9000 年のあたりへ拡大して、1500 年を見える範囲の外へ出す。
      const axis = (await page.getByTestId('rail-axis').boundingBox())!;
      const px = await yearToLanePx(page, 9000);
      await page.mouse.move(axis.x + px, axis.y + axis.height / 2);
      for (let i = 0; i < 25; i += 1) await page.mouse.wheel(0, -100);
      await expect.poll(async () => (await railView(page)).minYear).toBeGreaterThan(1500);
      const view = await railView(page);
      await page.mouse.move(cx, cy);
      await ringDraft(page, cx, cy);

      await viewMenu(page, 'time.prevAnchor');
      await expect(page.getByTestId(ASK)).toBeVisible();
      expect((await railView(page)).minYear).toBe(view.minYear);
      await page.getByTestId(KEEP).click();
      await expect(page.getByTestId(ASK)).toBeHidden();
      await page.waitForTimeout(200);
      expect((await railView(page)).minYear).toBe(view.minYear);
      expect((await railView(page)).maxYear).toBe(view.maxYear);
      await expect(page.getByTestId(YEAR)).toHaveText('9000年');

      await viewMenu(page, 'time.prevAnchor');
      await page.getByTestId(DROP).click();
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      await expect.poll(async () => (await railView(page)).minYear).toBeLessThanOrEqual(1500);
    } finally {
      await app.close();
    }
  });

  test('右クリックの「開始年を変える」: ［続ける］で欄は開かず、［捨てる］で年と一緒に開く', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { faceId, cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await jumpToYear(page, 1600);
      await page.keyboard.press('Control+k');
      await expect.poll(async () => (await projectStats(page)).anchorCount).toBe(2);
      await ringDraft(page, cx, cy);
      const lane = await laneY(page);
      const [mark1500] = await railMarkPositions(page);
      const menu = page.getByTestId('context-menu');
      const startFields = page.locator('[data-testid^="anchor-interval-start-"][data-testid$="-year"]');

      await page.mouse.click(lane.x + (mark1500 ?? 0), lane.y, { button: 'right' });
      await menu.locator('[data-rail-item="changeAnchorStart"]').click();
      await expect(page.getByTestId(ASK)).toBeVisible();
      await page.getByTestId(KEEP).click();
      await expect(page.getByTestId(ASK)).toBeHidden();
      await page.waitForTimeout(200);
      await expect(page.getByTestId(YEAR)).toHaveText('1600年');
      await expect(page.getByTestId(`ring-edit-vertex-count`)).toHaveText('3');
      const focusedStart = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid')?.startsWith('anchor-interval-start-') ?? false,
      );
      expect(focusedStart).toBe(false);

      await page.mouse.click(lane.x + (mark1500 ?? 0), lane.y, { button: 'right' });
      await menu.locator('[data-rail-item="changeAnchorStart"]').click();
      await page.getByTestId(DROP).click();
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(startFields.first()).toBeFocused();
    } finally {
      await app.close();
    }
  });

  test('右クリックの「ここに錨を作る」: ［続ける］で作らず、［捨てる］で作り、文が句点で区切られる', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await ringDraft(page, cx, cy);
      const stats = await projectStats(page);
      const lane = await laneY(page);
      const px = await yearToLanePx(page, 5000);
      const menu = page.getByTestId('context-menu');

      await page.mouse.click(lane.x + px, lane.y, { button: 'right' });
      await menu.locator('[data-rail-item="createAnchorHere"]').click();
      await expect(page.getByTestId(ASK)).toBeVisible();
      await page.getByTestId(KEEP).click();
      await expect(page.getByTestId(ASK)).toBeHidden();
      await page.waitForTimeout(200);
      await expect(page.getByTestId(YEAR)).toHaveText('1500年');
      expect((await projectStats(page)).anchorCount).toBe(stats.anchorCount);

      await page.mouse.click(lane.x + px, lane.y, { button: 'right' });
      await menu.locator('[data-rail-item="createAnchorHere"]').click();
      await page.getByTestId(DROP).click();
      await expect(page.getByTestId(YEAR)).not.toHaveText('1500年');
      await expect.poll(async () => (await projectStats(page)).anchorCount).toBe(stats.anchorCount + 1);
      // 文がつながらない（指摘 5）: 「…記録を行いました。描きかけの頂点 3 個を捨てました。」
      const text = (await page.getByTestId(STATUS).textContent()) ?? '';
      expect(text).toContain(RAIL_STRINGS.movedTo(''));
      expect(text).toContain(`。${DRAFT_DISCARD_STRINGS.trailer(DRAFT_DISCARD_STRINGS.discarded(3))}`);
      expect(text).not.toMatch(/ました[^。]/);
    } finally {
      await app.close();
    }
  });

  test('打っていた場所へ戻る: ［続ける］で年も選択も動かず、［捨てる］で両方動く', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const a = await commitOneFace(page);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const bx = b.x + b.width / 2 + 260;
      const by = b.y + b.height / 2;
      const bId = await commitSquareFace(page, bx, by, 60);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(a.cx, a.cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(a.faceId);
      await page.getByTestId('basic-info').getByLabel('名前').fill('typed-on-a');
      await jumpToYear(page, 1600);
      await expect(page.getByTestId('draft-discard-confirm')).toBeVisible();

      // 別の面（b）を 1600 年で掴んで下書きを打つ。素性欄の確認は残っている。
      await page.getByTestId(`tool-${RING}`).click();
      await page.mouse.click(bx, by);
      await expect(page.getByTestId('app-active-feature')).toHaveText(bId);
      for (const [dx, dy] of FULL) await page.mouse.click(bx + dx / 2, by + dy / 2);
      await expect(page.getByTestId(COUNT)).toHaveText('3');
      await expect(page.getByTestId('draft-discard-confirm')).toBeVisible();

      await page.getByTestId('draft-discard-keep').click();
      await expect(page.getByTestId(ASK)).toBeVisible();
      await page.getByTestId(KEEP).click();
      await expect(page.getByTestId(ASK)).toBeHidden();
      await page.waitForTimeout(200);
      await expect(page.getByTestId(YEAR)).toHaveText('1600年');
      await expect(page.getByTestId('app-active-feature')).toHaveText(bId);
    } finally {
      await app.close();
    }
  });
});

test.describe('B112 の入口 — 端の送り（指摘 4）', () => {
  /** 9995 年に面を作って輪郭を打つ。 */
  async function atEdge(
    page: Page,
    points: readonly (readonly [number, number])[],
  ): Promise<void> {
    await jumpToYear(page, 9995);
    const { cx, cy } = await commitOneFace(page);
    await page.getByTestId('tool-edit.select').click();
    await ringDraft(page, cx, cy, points);
  }

  test('聞く点数: 板のあいだ「動いた」と言わず、［続ける］で動かず、［捨てる］で端へ動いたことも捨てたことも読める', async () => {
    const { app, page } = await launchApp();
    try {
      await atEdge(page, FULL);
      const clamped = RAIL_STRINGS.stepClampedTo('10000年');
      await viewMenu(page, 'time.stepForward10');
      await expect(page.getByTestId(ASK)).toBeVisible();
      await expect(page.getByTestId(YEAR)).toHaveText('9995年');
      await expect(page.getByTestId(STATUS)).not.toContainText(clamped);
      await page.getByTestId(KEEP).click();
      await expect(page.getByTestId(ASK)).toBeHidden();
      await page.waitForTimeout(200);
      await expect(page.getByTestId(YEAR)).toHaveText('9995年');
      await expect(page.getByTestId(STATUS)).not.toContainText(clamped);

      await viewMenu(page, 'time.stepForward10');
      await page.getByTestId(DROP).click();
      await expect(page.getByTestId(YEAR)).toHaveText('10000年');
      await expect(page.getByTestId(STATUS)).toContainText(clamped);
      await expect(page.getByTestId(STATUS)).toContainText(DRAFT_DISCARD_STRINGS.discarded(3));
    } finally {
      await app.close();
    }
  });

  test('聞かない点数: そのまま端へ動き、端へ動いたことも捨てたことも読める', async () => {
    const { app, page } = await launchApp();
    try {
      await atEdge(page, [[-40, -40]]);
      await viewMenu(page, 'time.stepForward10');
      await expect(page.getByTestId(YEAR)).toHaveText('10000年');
      await expect(page.getByTestId(STATUS)).toContainText(RAIL_STRINGS.stepClampedTo('10000年'));
      await expect(page.getByTestId(STATUS)).toContainText(DRAFT_DISCARD_STRINGS.discarded(1));
    } finally {
      await app.close();
    }
  });
});

test.describe('B112 の入口 — レールを引き戻して離す（指摘 3）', () => {
  test('板のあと押した位置へ引き戻して離し、［捨てる］を押すと、途中の年へ行かない', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      const axis = (await page.getByTestId('rail-axis').boundingBox())!;
      const y = axis.y + axis.height / 2;
      // レールの 30% の年へ送り、そこで面を掴む。
      await page.mouse.click(axis.x + axis.width * 0.3, y);
      const start = await page.getByTestId(YEAR).textContent();
      expect(start).not.toBe('1500年');
      await requestYear(page, Number((start ?? '').replace(/\D/g, '')));
      // 面はいまの年でも居る（1500 年から続いている）。
      await ringDraft(page, cx, cy);

      await page.mouse.move(axis.x + axis.width * 0.3, y);
      await page.mouse.down();
      for (const f of [0.4, 0.5, 0.6]) await page.mouse.move(axis.x + axis.width * f, y);
      await expect(page.getByTestId(ASK)).toBeVisible();
      await page.mouse.move(axis.x + axis.width * 0.3, y);
      await page.mouse.up();
      await page.getByTestId(DROP).click();
      await expect(page.getByTestId(ASK)).toBeHidden();
      await page.waitForTimeout(200);
      await expect(page.getByTestId(YEAR)).toHaveText(start ?? '');
      await expect(page.getByTestId(STATUS)).toContainText(DRAFT_DISCARD_STRINGS.discarded(3));
      await expect(page.getByTestId(COUNT)).toHaveText('0');
    } finally {
      await app.close();
    }
  });
});

test.describe('B112 の入口 — 新規作成で手放したとは言わない（「構えている」条件）', () => {
  const TOOLS = [
    { tool: 'edit.ring', count: 'ring-edit-vertex-count', root: 'ring-edit-tool', points: 3 },
    { tool: 'edit.drill', count: 'drill-vertex-count', root: 'drill-tool', points: 3 },
    { tool: 'edit.knife', count: 'knife-point-count', root: 'knife-tool', points: 2 },
  ] as const;

  for (const c of TOOLS) {
    test(`${c.tool}: 面は消えるが、捨てたことだけを言う`, async () => {
      const { app, page } = await launchApp();
      try {
        await jumpToYear(page, 1500);
        const { cx, cy } = await commitOneFace(page);
        await page.getByTestId('tool-edit.select').click();
        await page.getByTestId(`tool-${c.tool}`).click();
        await page.mouse.click(cx, cy);
        await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', 'selecting-target');
        const pts = c.points === 2 ? ([[-200, 0], [200, 0]] as const) : FULL;
        for (const [dx, dy] of pts) await page.mouse.click(cx + dx, cy + dy);
        await expect(page.getByTestId(c.count)).toHaveText(String(c.points));

        await page.getByTestId('menu-file').click();
        await page.getByTestId('menu-items-file').locator('[data-command="file.new"]').click();
        const unsaved = page.getByTestId('unsaved-discard');
        if (await unsaved.isVisible()) await unsaved.click();
        await expect(page.getByTestId('app-mode')).toHaveText('view');
        await expect(page.getByTestId(STATUS)).toContainText(
          DRAFT_DISCARD_STRINGS.projectSwitchedDiscarded(DRAFT_DISCARD_STRINGS.discarded(c.points)),
        );
        await page.waitForTimeout(300);
        await expect(page.getByTestId(STATUS)).not.toContainText(APP_STRINGS.toolTargetGoneByTime);
      } finally {
        await app.close();
      }
    });
  }
});
