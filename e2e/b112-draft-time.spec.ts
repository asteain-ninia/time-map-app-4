// B112: 輪郭・穴あけ・分ける の打ちかけを持ったまま年を動かしたら、追加の道具と同じ 2 択になる。
//
// 直す前の実機（0 年に居ない面を 1500 年で掴んで 0 年へ移った）:
//   輪郭 ― 板なし、3 点が残り、確定を押しても何も記録されず、状態行は「0年へ移動しました。」のまま。
//   穴あけ ― 板なし、確定を押すと居ない面のまま素性入力へ進む。
//   分ける ― 板なし、確定できる 2 点の分断線が黙って消える。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { ADD_STRINGS } from '../src/ui/add/strings';
import { PROJECT_FIELD_STRINGS } from '../src/ui/settings/strings';
import { APP_STRINGS, DRAFT_DISCARD_STRINGS } from '../src/ui/shell/strings';
import { RAIL_STRINGS } from '../src/ui/timeline/rail-strings';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  committedVertices,
  drawFace,
  jumpToYear,
  launchApp,
  leaveViewMode,
  liveCamera,
  loadProject,
  openPropertySection,
  placeVertices,
  projectStats,
  requestYear,
  squareCorners,
} from './helpers';

interface ToolCase {
  readonly tool: string;
  readonly prefix: string;
  readonly root: string;
  readonly count: string;
  readonly confirm: string;
  /** 確定できる点数。 */
  readonly full: readonly (readonly [number, number])[];
  /** 確定できない点数（聞かずに捨てる）。 */
  readonly short: readonly (readonly [number, number])[];
  /** 対象を手放したあとの局面。 */
  readonly released: string;
}

const CASES: readonly ToolCase[] = [
  {
    tool: 'edit.ring',
    prefix: 'ring-edit-draft-discard',
    root: 'ring-edit-tool',
    count: 'ring-edit-vertex-count',
    confirm: 'ring-edit-confirm',
    full: [[-40, -40], [40, -40], [0, 40]],
    short: [[-40, -40], [40, -40]],
    released: 'selecting-target',
  },
  {
    tool: 'edit.drill',
    prefix: 'drill-draft-discard',
    root: 'drill-tool',
    count: 'drill-vertex-count',
    confirm: 'drill-confirm',
    full: [[-40, -40], [40, -40], [0, 40]],
    short: [[-40, -40], [40, -40]],
    released: 'selecting-target',
  },
  {
    tool: 'edit.knife',
    prefix: 'knife-draft-discard',
    root: 'knife-tool',
    count: 'knife-point-count',
    confirm: 'knife-confirm-cut',
    full: [[-200, 0], [200, 0]],
    short: [[-200, 0]],
    released: 'selecting-target',
  },
];

/** 時刻レールの「次へ」（1 年送り）。 */
function stepForwardButton(page: Page): Locator {
  return page.getByTestId('timeline-step').getByRole('button').last();
}

/** 1500 年に面を作り（0 年には居ない）、道具で掴んで点を打つ。 */
async function draftOnFace(
  page: Page,
  c: ToolCase,
  points: readonly (readonly [number, number])[],
): Promise<string> {
  await jumpToYear(page, 1500);
  const { faceId, cx, cy } = await commitOneFace(page);
  await page.getByTestId(`tool-${c.tool}`).click();
  await page.mouse.click(cx, cy);
  await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', 'selecting-target');
  for (const [dx, dy] of points) await page.mouse.click(cx + dx, cy + dy);
  await expect(page.getByTestId(c.count)).toHaveText(String(points.length));
  return faceId;
}

/** 板が出て、何も動いていない。［続ける］を押しても何も動かず、板は開き直らない。 */
async function expectAskedThenKeep(page: Page, c: ToolCase, faceId: string): Promise<void> {
  const confirm = page.getByTestId(`${c.prefix}-confirm`);
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(DRAFT_DISCARD_STRINGS.message(c.full.length, 'time'));
  await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
  await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
  expect(await page.getByTestId('statusbar-result').textContent()).not.toContain(
    RAIL_STRINGS.movedTo(''),
  );
  await page.getByTestId(`${c.prefix}-no`).click();
  await expect(confirm).toBeHidden();
  await page.waitForTimeout(700);
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
  await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
  await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));
}

for (const c of CASES) {
  test.describe(`B112 — ${c.tool}`, () => {
    test('相手の居ない年へ: 聞いてから動く。捨てると対象を手放し、そう言う', async () => {
      const { app, page } = await launchApp();
      try {
        const faceId = await draftOnFace(page, c, c.full);
        await requestYear(page, 0);
        await expectAskedThenKeep(page, c, faceId);

        await requestYear(page, 0);
        await expect(page.getByTestId(`${c.prefix}-confirm`)).toBeVisible();
        await page.getByTestId(`${c.prefix}-yes`).click();
        await expect(page.getByTestId('timeline-current')).toHaveText('0年');
        await expect(page.getByTestId(c.root)).toHaveAttribute('data-flow', c.released);
        await expect(page.getByTestId(c.count)).toHaveText('0');
        await expect(page.getByTestId('app-active-feature')).toHaveText('');
        await expect(page.getByTestId('app-active-tool')).toHaveText(c.tool);
        // 移動の知らせに上書きされず、捨てたことと手放したことが読める。
        const status = page.getByTestId('statusbar-result');
        await expect(status).toContainText(RAIL_STRINGS.movedTo('0年'));
        await expect(status).toContainText(ADD_STRINGS.draftDiscarded(c.full.length));
        await expect(status).toContainText(APP_STRINGS.toolTargetGoneByTime);
      } finally {
        await app.close();
      }
    });

    test('相手の居る年へ: 捨てても対象は掴んだまま。Escape は続ける', async () => {
      const { app, page } = await launchApp();
      try {
        const faceId = await draftOnFace(page, c, c.full);
        await requestYear(page, 1600);
        const confirm = page.getByTestId(`${c.prefix}-confirm`);
        await expect(confirm).toBeVisible();
        // 外で起きたことで出た板の Escape は取り消し（教訓 5.70）。
        await page.keyboard.press('Escape');
        await expect(confirm).toBeHidden();
        await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
        await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));

        await requestYear(page, 1600);
        await page.getByTestId(`${c.prefix}-yes`).click();
        await expect(page.getByTestId('timeline-current')).toHaveText('1600年');
        await expect(page.getByTestId(c.count)).toHaveText('0');
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', c.released);
      } finally {
        await app.close();
      }
    });

    test('送りのボタン・レールのクリック・再生のどれでも同じ 2 択になる。鍵盤の送りは下書きのあいだ効かない', async () => {
      const { app, page } = await launchApp();
      try {
        const faceId = await draftOnFace(page, c, c.full);

        // 鍵盤は道具が持っている（設計書 §D.4 の tool-drawing）ので `.` は年も下書きも動かさない。
        await page.keyboard.press('.');
        await page.waitForTimeout(300);
        await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
        await expect(page.getByTestId(`${c.prefix}-confirm`)).toHaveCount(0);
        await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));

        await stepForwardButton(page).click();
        await expectAskedThenKeep(page, c, faceId);

        const axis = (await page.getByTestId('rail-axis').boundingBox())!;
        await page.mouse.click(axis.x + axis.width * 0.9, axis.y + axis.height / 2);
        await expectAskedThenKeep(page, c, faceId);

        // 再生は板が開いた時点で止まり、閉じても勝手に再開しない（決定 (8)）。
        const play = page.getByTestId('timeline-playback').getByRole('button').first();
        await play.click();
        await expect(page.getByTestId(`${c.prefix}-confirm`)).toBeVisible();
        await expect(play).toHaveAttribute('aria-pressed', 'false');
        await expectAskedThenKeep(page, c, faceId);
        await expect(play).toHaveAttribute('aria-pressed', 'false');
      } finally {
        await app.close();
      }
    });

    test('確定できない点数なら聞かずに捨てて動き、捨てたことを言う。対象は保つ', async () => {
      const { app, page } = await launchApp();
      try {
        const faceId = await draftOnFace(page, c, c.short);
        await stepForwardButton(page).click();
        await expect(page.getByTestId('timeline-current')).toHaveText('1501年');
        await expect(page.getByTestId(`${c.prefix}-confirm`)).toHaveCount(0);
        await expect(page.getByTestId(c.count)).toHaveText('0');
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        await expect(page.getByTestId('statusbar-result')).toContainText(
          ADD_STRINGS.draftDiscarded(c.short.length),
        );
      } finally {
        await app.close();
      }
    });

    test('点を打つ前でも、相手の居ない年へ移れば対象を手放して言う', async () => {
      const { app, page } = await launchApp();
      try {
        await draftOnFace(page, c, []);
        await requestYear(page, 0);
        await expect(page.getByTestId('timeline-current')).toHaveText('0年');
        await expect(page.getByTestId(c.root)).toHaveAttribute('data-flow', c.released);
        await expect(page.getByTestId('statusbar-result')).toContainText(
          APP_STRINGS.toolTargetGoneByTime,
        );
      } finally {
        await app.close();
      }
    });
  });
}

test.describe('B112 — 共有の関門', () => {
  test('追加の道具でも、相手の居ない年へ頼んだ板の後ろで選択が外れない', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { faceId, cx, cy } = await commitOneFace(page);
      await armAddAreaTool(page);
      await placeVertices(page, squareCorners(cx - 220, cy, 30));
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      await requestYear(page, 0);
      await expect(page.getByTestId('add-draft-discard-confirm')).toBeVisible();
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await page.getByTestId('add-draft-discard-no').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    } finally {
      await app.close();
    }
  });

  test('素性を入れている穴あけで年を動かすと聞き、捨てると素性欄が閉じる', async () => {
    const { app, page } = await launchApp();
    try {
      const drill = CASES[1]!;
      await draftOnFace(page, drill, drill.full);
      await page.getByTestId('drill-confirm').click();
      await expect(page.getByTestId('add-name')).toBeVisible();

      await requestYear(page, 1600);
      await expect(page.getByTestId('drill-draft-discard-confirm')).toBeVisible();
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
      await page.getByTestId('drill-draft-discard-yes').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1600年');
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

// --- 検証と審査の指摘（2026-11-01）----------------------------------------------

const RING_CASE = CASES[0]!;
const DRILL_CASE = CASES[1]!;
const KNIFE_CASE = CASES[2]!;
const G_NAME = 'G-face';
const FILE_STATUS_SAVED = '保存しました';

/** `year` 年に、地図の中心から `dx` だけずらした面を置く。 */
async function faceBeside(page: Page, year: number, name: string, dx: number): Promise<string> {
  await jumpToYear(page, year);
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  return drawFace(page, squareCorners(b.x + b.width / 2 + dx, b.y + b.height / 2, 40), { name });
}

/** `faceYear` 年に面を作り、`draftYear` 年へ移ってから道具で掴んで点を打つ。 */
async function draftAt(
  page: Page,
  c: ToolCase,
  faceYear: number,
  draftYear: number,
): Promise<string> {
  await jumpToYear(page, faceYear);
  const { faceId, cx, cy } = await commitOneFace(page);
  await page.getByTestId('tool-edit.select').click();
  await jumpToYear(page, draftYear);
  await page.getByTestId(`tool-${c.tool}`).click();
  await page.mouse.click(cx, cy);
  await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', 'selecting-target');
  for (const [dx, dy] of c.full) await page.mouse.click(cx + dx, cy + dy);
  await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));
  return faceId;
}

/** 設定で表示年の上限を変える。 */
async function setTimelineMax(page: Page, year: number): Promise<void> {
  await page.getByTestId('menu-tools').click();
  await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-tab-project').click();
  const max = page.getByLabel(PROJECT_FIELD_STRINGS.timelineMaxYear);
  await expect(max).toBeEnabled();
  await max.fill(String(year));
  await expect(max).toHaveValue(String(year));
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
}

/** 通史の「G」の行。 */
function historyRow(page: Page): Locator {
  return page.locator('[data-testid^="event-list-item-"]').filter({ hasText: G_NAME }).first();
}

/** 板が出ていないことを、少し待ってから確かめる（遅れて開く板も拾う）。 */
async function expectNoBoard(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  await expect(page.locator('[data-testid$="-draft-discard-confirm"]')).toHaveCount(0);
}

async function yearOf(page: Page): Promise<number> {
  const text = (await page.getByTestId('timeline-current').textContent()) ?? '';
  return Number(text.replace(/\D/g, ''));
}

for (const c of CASES) {
  test.describe(`B112 の指摘 — ${c.tool}`, () => {
    test('通史の行: 板のあいだ年も選択も視点も動かず、続けるで元のまま、捨てるで全部動く', async () => {
      const { app, page } = await launchApp();
      try {
        const g = await faceBeside(page, 1700, G_NAME, -400);
        await page.getByTestId('tool-edit.select').click();
        const f = await draftOnFace(page, c, c.full);
        const cam = await liveCamera(page);
        await page.getByTestId('list-mode-history').click();

        await historyRow(page).click();
        const confirm = page.getByTestId(`${c.prefix}-confirm`);
        await expect(confirm).toBeVisible();
        await expect(page.getByTestId('app-active-feature')).toHaveText(f);
        await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
        expect(await liveCamera(page)).toEqual(cam);

        await page.getByTestId(`${c.prefix}-no`).click();
        await expectNoBoard(page);
        await expect(page.getByTestId('app-active-feature')).toHaveText(f);
        await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
        await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));
        expect(await liveCamera(page)).toEqual(cam);

        await historyRow(page).click();
        await page.getByTestId(`${c.prefix}-yes`).click();
        await expect(page.getByTestId('timeline-current')).toHaveText('1700年');
        await expect(page.getByTestId('app-active-feature')).toHaveText(g);
        await expectNoBoard(page);
        await expect.poll(async () => (await liveCamera(page)).centerLon).not.toBe(cam.centerLon);
      } finally {
        await app.close();
      }
    });

    test('設定の補正: 聞かずに捨てて状態行で言い、対象が居れば掴んだまま', async () => {
      const { app, page } = await launchApp();
      try {
        const f = await draftAt(page, c, 1300, 1500);
        const stats = await projectStats(page);
        await setTimelineMax(page, 1400);
        await expect(page.getByTestId('timeline-current')).toHaveText('1400年');
        await expectNoBoard(page);
        await expect(page.getByTestId(c.count)).toHaveText('0');
        await expect(page.getByTestId('app-active-feature')).toHaveText(f);
        await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', c.released);
        await expect(page.getByTestId('statusbar-result')).toContainText(
          DRAFT_DISCARD_STRINGS.rangeClampedDiscarded(
            '1400年',
            DRAFT_DISCARD_STRINGS.discarded(c.full.length),
          ),
        );
        expect(await projectStats(page)).toEqual(stats);
      } finally {
        await app.close();
      }
    });

    test('設定の補正: 対象が居ない年へ補正されたら、捨てたことも手放したことも言う', async () => {
      const { app, page } = await launchApp();
      try {
        await draftOnFace(page, c, c.full);
        await setTimelineMax(page, 1400);
        await expect(page.getByTestId('timeline-current')).toHaveText('1400年');
        await expectNoBoard(page);
        await expect(page.getByTestId(c.root)).toHaveAttribute('data-flow', c.released);
        const status = page.getByTestId('statusbar-result');
        await expect(status).toContainText(DRAFT_DISCARD_STRINGS.discarded(c.full.length));
        await expect(status).toContainText(APP_STRINGS.toolTargetGoneByTime);
      } finally {
        await app.close();
      }
    });

    test('ファイルを開く: 板を出さず、下書きを捨てて状態行で言う。新しい書類は変わらない', async () => {
      const target = join(mkdtempSync(join(tmpdir(), 'gimoza-b112-')), 'a.gimoza');
      const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
      try {
        await jumpToYear(page, 1500);
        const { cx, cy } = await commitOneFace(page);
        await page.getByTestId('tool-edit.select').click();
        await page.keyboard.press('Control+s');
        await expect(page.getByTestId('statusbar-result')).toContainText(FILE_STATUS_SAVED);
        const stats = await projectStats(page);
        await jumpToYear(page, 1650);
        await page.getByTestId(`tool-${c.tool}`).click();
        await page.mouse.click(cx, cy);
        for (const [dx, dy] of c.full) await page.mouse.click(cx + dx, cy + dy);
        await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));

        expect(await loadProject(page, target)).toBe('loaded');
        await expectNoBoard(page);
        await expect(page.getByTestId('app-active-tool')).toHaveText('');
        await expect(page.getByTestId('app-mode')).toHaveText('view');
        await expect(page.getByTestId('statusbar-result')).toContainText(
          DRAFT_DISCARD_STRINGS.projectSwitchedDiscarded(
            DRAFT_DISCARD_STRINGS.discarded(c.full.length),
          ),
        );
        expect(await projectStats(page)).toEqual(stats);

        // 構え直しても、前の点列は残っていない。
        await leaveViewMode(page);
        await page.getByTestId(`tool-${c.tool}`).click();
        await expect(page.getByTestId(c.root)).toHaveAttribute('data-flow', c.released);
        await expect(page.getByTestId(c.count)).toHaveText('0');
      } finally {
        await app.close();
      }
    });
  });
}

test.describe('B112 の指摘 — 追加の道具', () => {
  test('通史の行: 板は 1 枚で、続けるで元のまま、捨てるで全部動く', async () => {
    const { app, page } = await launchApp();
    try {
      const g = await faceBeside(page, 1700, G_NAME, -400);
      await page.getByTestId('tool-edit.select').click();
      await jumpToYear(page, 1500);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      await placeVertices(page, squareCorners(b.x + b.width / 2 + 100, b.y + b.height / 2, 40));
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');
      const active = await page.getByTestId('app-active-feature').textContent();
      await page.getByTestId('list-mode-history').click();

      await historyRow(page).click();
      const confirm = page.getByTestId('add-draft-discard-confirm');
      await expect(confirm).toBeVisible();
      await expect(page.getByTestId('app-active-feature')).toHaveText(active ?? '');
      await page.getByTestId('add-draft-discard-no').click();
      // 2 枚目の板が出ない。
      await expectNoBoard(page);
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
      await expect(page.getByTestId('app-active-feature')).toHaveText(active ?? '');
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');

      await historyRow(page).click();
      await page.getByTestId('add-draft-discard-yes').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1700年');
      await expect(page.getByTestId('app-active-feature')).toHaveText(g);
      await expectNoBoard(page);
    } finally {
      await app.close();
    }
  });

  test('設定の補正: 聞かずに捨てて言い、形は記録されない', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      await placeVertices(page, squareCorners(b.x + b.width / 2, b.y + b.height / 2, 40));
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');
      const stats = await projectStats(page);
      await setTimelineMax(page, 1400);
      await expect(page.getByTestId('timeline-current')).toHaveText('1400年');
      await expectNoBoard(page);
      await expect(page.getByTestId('statusbar-result')).toContainText(
        DRAFT_DISCARD_STRINGS.rangeClampedDiscarded('1400年', DRAFT_DISCARD_STRINGS.discarded(4)),
      );
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      expect(await projectStats(page)).toEqual(stats);
    } finally {
      await app.close();
    }
  });

  test('素性の局面の［捨てる］: 打った内容も捨てたと言う', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      await placeVertices(page, squareCorners(b.x + b.width / 2, b.y + b.height / 2, 40));
      await page.keyboard.press('Enter');
      await page.getByTestId('add-name').fill('typed-name');
      await requestYear(page, 1600);
      await page.getByTestId('add-draft-discard-yes').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1600年');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        DRAFT_DISCARD_STRINGS.discardedShapeAndTyped,
      );
    } finally {
      await app.close();
    }
  });

  test('ファイルを開く: 板を出さず、下書きを捨てて言う', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'gimoza-b112-')), 'a.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await jumpToYear(page, 1500);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText(FILE_STATUS_SAVED);
      const stats = await projectStats(page);
      await armAddAreaTool(page);
      await placeVertices(page, squareCorners(cx - 260, cy, 40));
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');

      expect(await loadProject(page, target)).toBe('loaded');
      await expectNoBoard(page);
      await expect(page.getByTestId('app-active-tool')).toHaveText('');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        DRAFT_DISCARD_STRINGS.projectSwitchedDiscarded(DRAFT_DISCARD_STRINGS.discarded(4)),
      );
      expect(await projectStats(page)).toEqual(stats);
    } finally {
      await app.close();
    }
  });
});

test.describe('B112 の指摘 — 素性の局面の［捨てる］', () => {
  const PHASES = [
    {
      name: '分ける・素性（打った内容あり）',
      c: KNIFE_CASE,
      advance: async (page: Page): Promise<void> => {
        await page.getByTestId('knife-confirm-cut').click();
        await page.getByTestId('knife-confirm-inheritor').click();
        await page.getByTestId('add-name').fill('typed-name');
      },
      said: DRAFT_DISCARD_STRINGS.discardedCutAndTyped,
    },
    {
      name: '分ける・素性（打った内容なし）',
      c: KNIFE_CASE,
      advance: async (page: Page): Promise<void> => {
        await page.getByTestId('knife-confirm-cut').click();
        await page.getByTestId('knife-confirm-inheritor').click();
        await expect(page.getByTestId('add-name')).toBeVisible();
      },
      said: DRAFT_DISCARD_STRINGS.discardedCut,
    },
    {
      name: '穴あけ・素性（打った内容あり）',
      c: DRILL_CASE,
      advance: async (page: Page): Promise<void> => {
        await page.getByTestId('drill-confirm').click();
        await page.getByTestId('add-name').fill('typed-name');
      },
      said: DRAFT_DISCARD_STRINGS.discardedRegionAndTyped,
    },
    {
      name: '穴あけ・素性（打った内容なし）',
      c: DRILL_CASE,
      advance: async (page: Page): Promise<void> => {
        await page.getByTestId('drill-confirm').click();
        await expect(page.getByTestId('add-name')).toBeVisible();
      },
      said: DRAFT_DISCARD_STRINGS.discardedRegion,
    },
  ] as const;

  for (const p of PHASES) {
    test(`${p.name}: 居る年では掴んだまま描き直せる局面へ戻り、捨てたものを言う`, async () => {
      const { app, page } = await launchApp();
      try {
        const f = await draftOnFace(page, p.c, p.c.full);
        await p.advance(page);
        await requestYear(page, 1600);
        await page.getByTestId(`${p.c.prefix}-yes`).click();
        await expect(page.getByTestId('timeline-current')).toHaveText('1600年');
        await expect(page.getByTestId('app-active-feature')).toHaveText(f);
        await expect(page.getByTestId(p.c.root)).not.toHaveAttribute('data-flow', p.c.released);
        await expect(page.getByTestId(p.c.root)).not.toHaveAttribute(
          'data-flow',
          /entering-properties|choosing-inheritor/,
        );
        await expect(page.getByTestId('add-property-form')).toHaveCount(0);
        await expect(page.getByTestId(p.c.count)).toHaveText('0');
        const status = page.getByTestId('statusbar-result');
        await expect(status).toContainText(RAIL_STRINGS.movedTo('1600年'));
        await expect(status).toContainText(p.said);
        // 描き直せる: 打てば数が増える。
        const box = (await page.getByTestId('map-input-layer').boundingBox())!;
        await page.mouse.click(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10);
        await expect(page.getByTestId(p.c.count)).toHaveText('1');
      } finally {
        await app.close();
      }
    });

    test(`${p.name}: 居ない年では手放して、捨てたものと手放したことを言う`, async () => {
      const { app, page } = await launchApp();
      try {
        await draftOnFace(page, p.c, p.c.full);
        await p.advance(page);
        await requestYear(page, 0);
        await page.getByTestId(`${p.c.prefix}-yes`).click();
        await expect(page.getByTestId('timeline-current')).toHaveText('0年');
        await expect(page.getByTestId(p.c.root)).toHaveAttribute('data-flow', p.c.released);
        await expect(page.getByTestId('add-property-form')).toHaveCount(0);
        const status = page.getByTestId('statusbar-result');
        await expect(status).toContainText(RAIL_STRINGS.movedTo('0年'));
        await expect(status).toContainText(p.said);
        await expect(status).toContainText(APP_STRINGS.toolTargetGoneByTime);
      } finally {
        await app.close();
      }
    });
  }
});

test.describe('B112 の指摘 — そのほかの入口', () => {
  test('錨の行: 板のあいだ印も年も動かず、続けるで元のまま、捨てるで動く', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await jumpToYear(page, 1600);
      await page.keyboard.press('Control+k');
      await openPropertySection(page, 'anchor-section');
      const rows = page.locator('[data-testid^="anchor-row-"]');
      await expect(rows).toHaveCount(2);
      const selectedIds = async (): Promise<(string | null)[]> =>
        rows.evaluateAll((els) =>
          els
            .filter((e) => e.getAttribute('aria-selected') === 'true')
            .map((e) => e.getAttribute('data-testid')),
        );
      await page.getByTestId('tool-edit.ring').click();
      if ((await page.getByTestId(RING_CASE.root).getAttribute('data-flow')) === 'selecting-target') {
        await page.mouse.click(cx, cy);
      }
      for (const [dx, dy] of RING_CASE.full) await page.mouse.click(cx + dx, cy + dy);
      await expect(page.getByTestId(RING_CASE.count)).toHaveText('3');
      const before = await selectedIds();
      const row1500 = rows.first();
      const row1500Id = await row1500.getAttribute('data-testid');
      expect(before).not.toContain(row1500Id);

      await row1500.click();
      await expect(page.getByTestId(`${RING_CASE.prefix}-confirm`)).toBeVisible();
      expect(await selectedIds()).toEqual(before);
      await page.getByTestId(`${RING_CASE.prefix}-no`).click();
      await expectNoBoard(page);
      expect(await selectedIds()).toEqual(before);
      await expect(page.getByTestId('timeline-current')).toHaveText('1600年');

      await row1500.click();
      await page.getByTestId(`${RING_CASE.prefix}-yes`).click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
      await expect.poll(selectedIds).toEqual([row1500Id]);
    } finally {
      await app.close();
    }
  });

  test('レールのドラッグ: 捨てると、押した位置でなく離した位置へ動く', async () => {
    const { app, page } = await launchApp();
    try {
      await draftOnFace(page, RING_CASE, RING_CASE.full);
      const axis = (await page.getByTestId('rail-axis').boundingBox())!;
      const y = axis.y + axis.height / 2;
      await page.mouse.move(axis.x + axis.width * 0.5, y);
      await page.mouse.down();
      for (const f of [0.55, 0.6, 0.7, 0.8]) await page.mouse.move(axis.x + axis.width * f, y);
      await expect(page.getByTestId(`${RING_CASE.prefix}-confirm`)).toBeVisible();
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
      await page.mouse.up();
      await page.getByTestId(`${RING_CASE.prefix}-yes`).click();
      await expect.poll(async () => yearOf(page)).toBeGreaterThan(7500);
      expect(await yearOf(page)).toBeLessThan(8500);
      await expect(page.getByTestId('statusbar-result')).toContainText(
        DRAFT_DISCARD_STRINGS.discarded(3),
      );
    } finally {
      await app.close();
    }
  });
});

test.describe('B112 の指摘 — ファイルを開く: 点列を持たない道具', () => {
  /** 面を 1 つ作って保存する。戻り値は窓の座標と、保存した記録の統計。 */
  async function savedFace(
    page: Page,
  ): Promise<{ cx: number; cy: number; stats: Awaited<ReturnType<typeof projectStats>> }> {
    await jumpToYear(page, 1500);
    const { cx, cy } = await commitOneFace(page);
    await page.getByTestId('tool-edit.select').click();
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('statusbar-result')).toContainText(FILE_STATUS_SAVED);
    return { cx, cy, stats: await projectStats(page) };
  }

  test('［動かす］で引いている最中に開いても、離したときに新しい書類へ何も確定しない', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'gimoza-b112-')), 'a.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      const { cx, cy, stats } = await savedFace(page);
      await page.getByTestId('tool-edit.move').click();
      await page.mouse.click(cx, cy);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 40, cy + 30, { steps: 4 });

      expect(await loadProject(page, target)).toBe('loaded');
      const undoBefore = await page.getByTestId('app-can-undo').textContent();
      const vertices = await committedVerticesOfAll(page);
      expect(vertices).not.toBe('[]');
      await page.mouse.move(cx + 80, cy + 60, { steps: 4 });
      await page.mouse.up();

      await expectNoBoard(page);
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expect(page.getByTestId('app-active-tool')).toHaveText('');
      expect(await projectStats(page)).toEqual(stats);
      expect(await committedVerticesOfAll(page)).toEqual(vertices);
      await expect(page.getByTestId('app-can-undo')).toHaveText(undoBefore ?? '');
    } finally {
      await app.close();
    }
  });

  test('測っている最中に開くと、測量は終わり、板も出ない', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'gimoza-b112-')), 'a.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      const { cx, cy, stats } = await savedFace(page);
      const toggle = page.getByTestId('survey-toggle');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.click(cx - 60, cy);

      expect(await loadProject(page, target)).toBe('loaded');
      await expectNoBoard(page);
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      expect(await projectStats(page)).toEqual(stats);
    } finally {
      await app.close();
    }
  });

  for (const tool of ['edit.merge', 'edit.reparent'] as const) {
    test(`${tool} で対象を選んでいる最中に開くと、板を出さず道具が外れる`, async () => {
      const target = join(mkdtempSync(join(tmpdir(), 'gimoza-b112-')), 'a.gimoza');
      const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
      try {
        const { cx, cy, stats } = await savedFace(page);
        await page.getByTestId(`tool-${tool}`).click();
        await page.mouse.click(cx, cy);

        expect(await loadProject(page, target)).toBe('loaded');
        await expectNoBoard(page);
        await expect(page.getByTestId('app-active-tool')).toHaveText('');
        await expect(page.getByTestId('app-active-feature')).toHaveText('');
        expect(await projectStats(page)).toEqual(stats);
      } finally {
        await app.close();
      }
    });
  }
});

/** いま描かれている全部の地物の頂点（書類が変わっていないことを見る）。 */
async function committedVerticesOfAll(page: Page): Promise<string> {
  const ids = await page
    .locator('[data-testid^="feature-list-item-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  const out: [string, unknown][] = [];
  for (const id of ids) {
    const fid = id.replace('feature-list-item-', '');
    out.push([fid, [...(await committedVertices(page, fid)).entries()]]);
  }
  return JSON.stringify(out);
}
