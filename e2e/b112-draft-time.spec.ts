// B112: 輪郭・穴あけ・分ける の打ちかけを持ったまま年を動かしたら、追加の道具と同じ 2 択になる。
//
// 直す前の実機（0 年に居ない面を 1500 年で掴んで 0 年へ移った）:
//   輪郭 ― 板なし、3 点が残り、確定を押しても何も記録されず、状態行は「0年へ移動しました。」のまま。
//   穴あけ ― 板なし、確定を押すと居ない面のまま素性入力へ進む。
//   分ける ― 板なし、確定できる 2 点の分断線が黙って消える。

import { expect, test, type Locator, type Page } from '@playwright/test';

import { ADD_STRINGS } from '../src/ui/add/strings';
import { APP_STRINGS, DRAFT_DISCARD_STRINGS } from '../src/ui/shell/strings';
import { RAIL_STRINGS } from '../src/ui/timeline/rail-strings';

import {
  armAddAreaTool,
  commitOneFace,
  jumpToYear,
  launchApp,
  placeVertices,
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
