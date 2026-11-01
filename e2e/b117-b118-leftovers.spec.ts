// B117 / B118: 押している最中に板や測量が割り込む形の残りと、下書きと選択の小さな残り。
//
// どれも保存するデータは変わらないが、人の手の動きと画面が食い違う。直す前の実機の形は
// `docs/実装済み.md` の B117・B118 に書く。

import { expect, test, type Page } from '@playwright/test';

import { ADD_STRINGS } from '../src/ui/add/strings';
import { PROJECT_FIELD_STRINGS } from '../src/ui/settings/strings';
import { APP_STRINGS, DRAFT_DISCARD_STRINGS } from '../src/ui/shell/strings';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  committedVertices,
  drawFace,
  jumpToYear,
  launchApp,
  liveCamera,
  returnToViewMode,
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
  },
  {
    tool: 'edit.drill',
    prefix: 'drill-draft-discard',
    root: 'drill-tool',
    count: 'drill-vertex-count',
    confirm: 'drill-confirm',
    full: [[-40, -40], [40, -40], [0, 40]],
    short: [[-40, -40], [40, -40]],
  },
  {
    tool: 'edit.knife',
    prefix: 'knife-draft-discard',
    root: 'knife-tool',
    count: 'knife-point-count',
    confirm: 'knife-confirm-cut',
    full: [[-200, 0], [200, 0]],
    short: [[-200, 0]],
  },
];

const RELEASED = 'selecting-target';
const OTHER_NAME = 'B118-other';

/** 地図の中心から `dx` ずらした面を今の年に置く。 */
async function faceBeside(page: Page, name: string, dx: number): Promise<string> {
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  return drawFace(page, squareCorners(b.x + b.width / 2 + dx, b.y + b.height / 2, 40), { name });
}

/** 右クリックのメニューで、いま選んでいる面を隠す（選択は残る。決定 B55）。 */
async function hideFaceAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y, { button: 'right' });
  await page.getByTestId('context-menu').locator('[data-item-kind="hideFeature"]').click();
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
}

/** 同じ年に面を 2 つ置き、道具で中央の面を掴んで点を打つ。 */
async function draftBesideOther(
  page: Page,
  c: ToolCase,
  points: readonly (readonly [number, number])[],
): Promise<{ readonly target: string; readonly other: string; readonly cx: number; readonly cy: number }> {
  await jumpToYear(page, 1500);
  const other = await faceBeside(page, OTHER_NAME, -320);
  const { faceId: target, cx, cy } = await commitOneFace(page);
  await page.getByTestId(`tool-${c.tool}`).click();
  await page.mouse.click(cx, cy);
  await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', RELEASED);
  for (const [dx, dy] of points) await page.mouse.click(cx + dx, cy + dy);
  await expect(page.getByTestId(c.count)).toHaveText(String(points.length));
  await expect(page.getByTestId('app-active-feature')).toHaveText(target);
  return { target, other, cx, cy };
}

async function expectNoBoard(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  await expect(page.locator('[data-testid$="-draft-discard-confirm"]')).toHaveCount(0);
}

for (const c of CASES) {
  test.describe(`B118 — ${c.tool}`, () => {
    test('同じ年の別の地物を一覧で選ぶ: 聞く。続けるで選択も視点も元のまま、捨てるで選んだ地物へ移る', async () => {
      const { app, page } = await launchApp();
      try {
        const { target, other } = await draftBesideOther(page, c, c.full);
        const cam = await liveCamera(page);
        const confirm = page.getByTestId(`${c.prefix}-confirm`);

        await page.getByTestId(`feature-list-item-${other}`).click();
        await expect(confirm).toBeVisible();
        await expect(confirm).toContainText(DRAFT_DISCARD_STRINGS.message(c.full.length, 'select'));
        expect(await liveCamera(page)).toEqual(cam);

        await page.getByTestId(`${c.prefix}-no`).click();
        await expectNoBoard(page);
        await expect(page.getByTestId('app-active-feature')).toHaveText(target);
        await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));
        expect(await liveCamera(page)).toEqual(cam);

        // 外で起きたことで出た板の Escape は取り消し（教訓 5.70）。
        await page.getByTestId(`feature-list-item-${other}`).click();
        await expect(confirm).toBeVisible();
        await page.keyboard.press('Escape');
        await expectNoBoard(page);
        await expect(page.getByTestId('app-active-feature')).toHaveText(target);
        await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));

        await page.getByTestId(`feature-list-item-${other}`).click();
        await page.getByTestId(`${c.prefix}-yes`).click();
        await expectNoBoard(page);
        await expect(page.getByTestId('app-active-feature')).toHaveText(other);
        await expect(page.getByTestId(c.count)).toHaveText('0');
        await expect(page.getByTestId('app-active-tool')).toHaveText(c.tool);
        await expect(page.getByTestId('statusbar-result')).toContainText(
          ADD_STRINGS.draftDiscarded(c.full.length),
        );
        await expect.poll(async () => (await liveCamera(page)).centerLon).not.toBe(cam.centerLon);
      } finally {
        await app.close();
      }
    });

    test('確定できない点数なら聞かずに捨てて、捨てたことを言う', async () => {
      const { app, page } = await launchApp();
      try {
        const { other } = await draftBesideOther(page, c, c.short);
        await page.getByTestId(`feature-list-item-${other}`).click();
        await expectNoBoard(page);
        await expect(page.getByTestId('app-active-feature')).toHaveText(other);
        await expect(page.getByTestId(c.count)).toHaveText('0');
        await expect(page.getByTestId('statusbar-result')).toContainText(
          ADD_STRINGS.draftDiscarded(c.short.length),
        );
      } finally {
        await app.close();
      }
    });

    test('隠して選んだままの面は掴める。確定の手前まで進む', async () => {
      const { app, page } = await launchApp();
      try {
        await jumpToYear(page, 1500);
        const { faceId, cx, cy } = await commitOneFace(page);
        await page.getByTestId('tool-edit.select').click();
        await page.mouse.click(cx, cy);
        await hideFaceAt(page, cx, cy);
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        const before = await committedVertices(page, faceId);

        await page.getByTestId(`tool-${c.tool}`).click();
        await page.mouse.click(cx, cy);
        await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', RELEASED);
        await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
        for (const [dx, dy] of c.full) await page.mouse.click(cx + dx, cy + dy);
        await expect(page.getByTestId(c.count)).toHaveText(String(c.full.length));
        await page.getByTestId(c.confirm).click();
        // 輪郭はここで記録して対象を離す。穴あけ・分けるは素性・継承先の局面へ進む。
        if (c.tool === 'edit.ring') {
          await expect.poll(async () => committedVertices(page, faceId)).not.toEqual(before);
        } else {
          await expect(page.getByTestId(c.root)).not.toHaveAttribute('data-flow', RELEASED);
        }
      } finally {
        await app.close();
      }
    });

    test('隠していて選んでいない面は、見えないので掴めない', async () => {
      const { app, page } = await launchApp();
      try {
        await jumpToYear(page, 1500);
        const { cx, cy } = await commitOneFace(page);
        await page.getByTestId('tool-edit.select').click();
        await page.mouse.click(cx, cy);
        await hideFaceAt(page, cx, cy);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('app-active-feature')).toHaveText('');

        await page.getByTestId(`tool-${c.tool}`).click();
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(200);
        await expect(page.getByTestId(c.root)).toHaveAttribute('data-flow', RELEASED);
        await expect(page.getByTestId('app-active-feature')).toHaveText('');
      } finally {
        await app.close();
      }
    });
  });
}

test.describe('B118 — 下書きと選択', () => {
  test('素性を入れている局面でも、別の地物を一覧で選ぶと聞く', async () => {
    const { app, page } = await launchApp();
    try {
      const drill = CASES[1]!;
      const { target, other } = await draftBesideOther(page, drill, drill.full);
      await page.getByTestId(drill.confirm).click();
      await expect(page.getByTestId('add-name')).toBeVisible();
      await page.getByTestId(`feature-list-item-${other}`).click();
      const confirm = page.getByTestId(`${drill.prefix}-confirm`);
      await expect(confirm).toBeVisible();
      await page.getByTestId(`${drill.prefix}-no`).click();
      await expectNoBoard(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(target);
      await expect(page.getByTestId('add-name')).toBeVisible();

      await page.getByTestId(`feature-list-item-${other}`).click();
      await page.getByTestId(`${drill.prefix}-yes`).click();
      await expectNoBoard(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(other);
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('道具が自分で対象を選び直すときと確定のあとは聞かない', async () => {
    const { app, page } = await launchApp();
    try {
      const drill = CASES[1]!;
      const { target, cx, cy } = await draftBesideOther(page, drill, drill.full);
      await page.getByTestId(drill.confirm).click();
      await page.getByTestId('add-name').fill('B118-hole');
      await page.getByTestId('add-save').click();
      await expectNoBoard(page);
      await expect(page.getByTestId('app-active-feature')).not.toHaveText(target);
      // 穴あけのあと、同じ道具で別の点を押しても聞かない。
      await page.mouse.click(cx + 45, cy + 45);
      await expectNoBoard(page);
    } finally {
      await app.close();
    }
  });

  test('隠していて選んでいない面は［動かす］で引けない', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1500);
      const { faceId, cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(cx, cy);
      await hideFaceAt(page, cx, cy);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      const before = await committedVertices(page, faceId);

      await page.getByTestId('tool-edit.move').click();
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 30, cy, { steps: 4 });
      await page.mouse.up();
      expect(await committedVertices(page, faceId)).toEqual(before);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
    } finally {
      await app.close();
    }
  });

  test('年の補正で下書きを捨て、印が外れ、対象も居なくなったら、全部言う', async () => {
    const { app, page } = await launchApp();
    try {
      const ring = CASES[0]!;
      await jumpToYear(page, 1500);
      const marked = await faceBeside(page, OTHER_NAME, -320);
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.getByTestId(`ledger-mark-${marked}`).click();
      await expect(page.getByTestId('ledger-marked-count')).toContainText('1');
      await page.getByTestId(`tool-${ring.tool}`).click();
      await page.mouse.click(cx, cy);
      for (const [dx, dy] of ring.full) await page.mouse.click(cx + dx, cy + dy);
      await expect(page.getByTestId(ring.count)).toHaveText('3');

      await page.getByTestId('menu-tools').click();
      await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
      await page.getByTestId('settings-tab-project').click();
      await page.getByLabel(PROJECT_FIELD_STRINGS.timelineMaxYear).fill('1400');
      await page.getByTestId('settings-save').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1400年');

      const status = page.getByTestId('statusbar-result');
      await expect(status).toContainText(
        DRAFT_DISCARD_STRINGS.rangeClampedDiscarded('1400年', DRAFT_DISCARD_STRINGS.discarded(3)),
      );
      await expect(status).toContainText(APP_STRINGS.markDroppedByTime(1));
      await expect(status).toContainText(APP_STRINGS.toolTargetGoneByTime);
    } finally {
      await app.close();
    }
  });
});

test.describe('B117 — 読むだけ', () => {
  /** 読むだけで面を選び、地図の隅の何もないところへポインタを置く。 */
  async function selectInViewMode(
    page: Page,
  ): Promise<{ readonly faceId: string; readonly from: { readonly x: number; readonly y: number } }> {
    const { faceId, cx, cy } = await commitOneFace(page);
    await returnToViewMode(page);
    await page.mouse.click(cx, cy);
    await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    const box = (await page.getByTestId('map-input-layer').boundingBox())!;
    const from = { x: box.x + 20, y: box.y + 20 };
    await page.mouse.move(from.x, from.y);
    return { faceId, from };
  }

  test('何もないところを押したまま U で測量へ入り、離しても動かしても元の押下は働かない', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, from } = await selectInViewMode(page);
      const before = await liveCamera(page);
      await page.mouse.down();
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.up();
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      // 測量の点も打たれない（押したのは測量へ入る前）。
      await expect(page.getByTestId('app-focus-owner')).toHaveText('map');

      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'false');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.move(from.x + 150, from.y + 100, { steps: 5 });
      expect(await liveCamera(page)).toEqual(before);
      await page.mouse.up();
      expect(await liveCamera(page)).toEqual(before);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    } finally {
      await app.close();
    }
  });

  test('何もないところを押したまま Ctrl+P の板を開いて閉じ、離しても選択は外れない。板の裏で地図も動かない', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, from } = await selectInViewMode(page);
      const before = await liveCamera(page);
      await page.mouse.down();
      await page.keyboard.press('Control+p');
      await expect(page.getByTestId('jump-palette')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('jump-palette')).toHaveCount(0);
      await page.mouse.up();
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.keyboard.press('Control+p');
      await expect(page.getByTestId('jump-palette')).toBeVisible();
      await page.mouse.move(from.x + 150, from.y + 100, { steps: 5 });
      expect(await liveCamera(page)).toEqual(before);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      expect(await liveCamera(page)).toEqual(before);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    } finally {
      await app.close();
    }
  });

  test('読むだけのほかの動きは変わらない: 左ドラッグで地図が動き、クリックで選び、空き地で外れる', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, from } = await selectInViewMode(page);
      const before = await liveCamera(page);
      await page.mouse.down();
      await page.mouse.move(from.x + 100, from.y + 60, { steps: 4 });
      await page.mouse.up();
      expect((await liveCamera(page)).centerLon).not.toBe(before.centerLon);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await page.mouse.click(from.x, from.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
    } finally {
      await app.close();
    }
  });
});

test.describe('B117 — 測量の左', () => {
  /** 面を選んだまま測量へ入り、地図の隅へポインタを置く（Delete の板を開けるように）。 */
  async function surveyWithSelection(
    page: Page,
  ): Promise<{ readonly faceId: string; readonly from: { readonly x: number; readonly y: number } }> {
    const { faceId, cx, cy } = await commitOneFace(page);
    await page.getByTestId('tool-edit.select').click();
    await page.mouse.click(cx, cy);
    await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    await page.keyboard.press('u');
    await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
    const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
    const from = { x: box.x + 20, y: box.y + 20 };
    await page.mouse.move(from.x, from.y);
    return { faceId, from };
  }

  /** 打った点の数を読む手がかり。始点を打つと線の下書きで鍵盤の持ち主が道具へ移る。 */
  async function expectNoSurveyPoint(page: Page): Promise<void> {
    await page.waitForTimeout(200);
    await expect(page.getByTestId('app-focus-owner')).toHaveText('map');
  }

  test('押したまま Delete で板を開き、板の裏で離しても点は打たれない', async () => {
    const { app, page } = await launchApp();
    try {
      await surveyWithSelection(page);
      await page.mouse.down();
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('delete-impact')).toHaveCount(0);
      await expectNoSurveyPoint(page);
    } finally {
      await app.close();
    }
  });

  test('押したまま Delete で板を開き、閉じてから離しても点は打たれない。次のクリックは打てる', async () => {
    const { app, page } = await launchApp();
    try {
      const { from } = await surveyWithSelection(page);
      await page.mouse.down();
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('delete-impact')).toHaveCount(0);
      await page.mouse.up();
      await expectNoSurveyPoint(page);

      await page.mouse.click(from.x, from.y);
      await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');
    } finally {
      await app.close();
    }
  });

  test('左ドラッグで動かしている最中に Delete で板が開くと、そこで止まる。中ボタンの移動は今までどおり動く', async () => {
    const { app, page } = await launchApp();
    try {
      const { from } = await surveyWithSelection(page);
      await page.mouse.down();
      await page.mouse.move(from.x + 60, from.y + 40, { steps: 3 });
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      const panned = await liveCamera(page);
      await page.mouse.move(from.x + 200, from.y + 120, { steps: 3 });
      expect(await liveCamera(page)).toEqual(panned);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('delete-impact')).toHaveCount(0);
      expect(await liveCamera(page)).toEqual(panned);
      await expectNoSurveyPoint(page);

      // 板を閉じたあとの左ドラッグは動く。
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 60, from.y + 40, { steps: 3 });
      await page.mouse.up();
      expect((await liveCamera(page)).centerLon).not.toBe(panned.centerLon);

      // 中ボタンは板の裏でも動く（今までの決まり）。
      await page.mouse.move(from.x, from.y);
      await page.mouse.down({ button: 'middle' });
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('delete-impact')).toBeVisible();
      const beforeMiddle = await liveCamera(page);
      await page.mouse.move(from.x + 80, from.y + 40, { steps: 3 });
      expect((await liveCamera(page)).centerLon).not.toBe(beforeMiddle.centerLon);
      await page.mouse.up({ button: 'middle' });
      await page.keyboard.press('Escape');
    } finally {
      await app.close();
    }
  });
});
