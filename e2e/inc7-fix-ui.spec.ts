// 増分 7 の手直し（再開分・実装係 2）—— 画面の結線でしか確かめられないものを実アプリで押す。
//
//   ① 決定 (2): まとめ役を「この年に終わったことにする」前に、影響の板が出る（素性欄・右クリック）
//   ② B64 / Fable #8: 所属変更の道具が対象を掴んだままでも、Ctrl+Z が黙らない
//   ③ B の残り: 板が出ている間、Ctrl+Z / Ctrl+S / Delete / Enter が背後へ抜けない（5 枚）
//   ④ C の残り: 複数対象の帯の名乗り「A ほか n 件」
//   ⑤ 決定 (4) V6: 子を独立させると、その子のレーンに 1200 年の印が増える
//   ⑥ 時刻レールの右クリック（設計書 §I.3）
//
// 板の「登録」そのもの（名乗り漏れ）は `src/ui/a11y/modal-registration.test.tsx` が総当たりで
// 見ている。ここで見るのは **背後に抜けないこと**（打鍵の結果）だけである。
//
// **画面の言葉は直書きしない**（教訓 5.64）。件数・年のように意味のある部分だけを読む。

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { openSettingsAndReplace, stubImagePicker, writePng } from './basemap-image-helpers';

import {
  armVertexTool,
  DEFAULT_FACE_HALF,
  commitOneFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  listedFeatureCount,
  loadSyntheticNested,
  openPropertySection,
  projectStats,
  railLaneStats,
  railMarkPositions,
  railView,
  clickClearOfStickyBars,
  openPreSaveBoard,
  type LaunchedApp,
} from './helpers';

const PARENT_ID = 'syn-nest-parent';
const PARENT_NAME = '合成の連邦';

function childId(index: number): string {
  return `syn-nest-child-${String(index)}`;
}
function childName(index: number): string {
  return `合成州 ${String(index + 1).padStart(2, '0')}`;
}

/** 一覧で 1 行を出す（まとめ役の子は畳まれているので名前で絞り込む）。 */
async function revealRow(page: Page, name: string, featureId: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('unified-list-filter').fill(name);
  await expect(page.getByTestId(`feature-list-item-${featureId}`)).toBeVisible();
}

async function selectRow(page: Page, name: string, featureId: string): Promise<void> {
  await revealRow(page, name, featureId);
  await page.getByTestId(`feature-list-item-${featureId}`).click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(featureId);
}

async function markRow(page: Page, name: string, featureId: string): Promise<void> {
  await revealRow(page, name, featureId);
  await page.getByTestId(`ledger-mark-${featureId}`).check();
}

/** 打鍵の持ち主が地図側になるよう、一覧の余白を押して焦点を外す。 */
async function blurToLedger(page: Page): Promise<void> {
  await page.getByTestId('unified-list-filter').fill('');
  await page.getByTestId('ledger-scroller').click({ position: { x: 5, y: 5 } });
}

/** 合成の入れ子を載せて編集できる状態にし、`year` へ動かす。 */
async function nested(page: Page, children: number, years: readonly number[], year: number): Promise<void> {
  await loadSyntheticNested(page, children, years);
  await enterEditMode(page);
  await jumpToYear(page, year);
}

// ---------------------------------------------------------------------------
// ① 決定 (2): 終わらせる前の影響の板
// ---------------------------------------------------------------------------

test.describe('決定 (2) — まとめ役を終わらせる前に、下位領域が最上位になることを見せる', () => {
  test('素性欄から押すと板が出て、やめれば何も起きず、確定すると子は次の年に最上位で居る', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1500);
      await selectRow(page, PARENT_NAME, PARENT_ID);
      await page.getByTestId('sidebar-tab-properties').click();
      const before = await projectStats(page);

      await page.getByTestId('end-here').click();
      const board = page.getByTestId('end-here-impact');
      await expect(board).toBeVisible();
      // 件数と「この年から」が出ている（名前は 2 件まで＋ほか n 件）。
      await expect(page.getByTestId('end-here-impact-promoted')).toContainText('3 件');
      await expect(page.getByTestId('end-here-impact-promoted')).toContainText(childName(0));
      // 板は鍵盤の持ち主へ名乗っている（決定 (13)）。
      await expect(page.getByTestId('app-focus-owner')).toHaveText('modal');

      // やめれば何も起きない（教訓 5.22）。
      await page.getByTestId('end-here-impact-cancel').click();
      await expect(board).toHaveCount(0);
      expect(await projectStats(page)).toEqual(before);

      // 確定すると子は道連れにならず、次の年に最上位で居る。
      await page.getByTestId('end-here').click();
      await page.getByTestId('end-here-impact-confirm').click();
      await expect(board).toHaveCount(0);
      await jumpToYear(page, 1600);
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('合成州');
      expect(await listedFeatureCount(page)).toBe(3);
      await page.getByTestId('unified-list-filter').fill(PARENT_NAME);
      expect(await listedFeatureCount(page)).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('別の親へ移した（自分の系列を持つ）子も数えて最上位にする — 連邦化した国を終わらせる形', async () => {
    // 2026-10-03 に見つけた穴: 確定は居候しか数えていなかったので、移された子は親が
    // 終わったあとも消えた親を指し続け、板も「子 0 件」で出なかった。
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1200);
      // 子 2 件を外の国へ移す（移した子は自分の系列を持つ）。
      await markRow(page, childName(0), childId(0));
      await markRow(page, childName(1), childId(1));
      await page.getByTestId('tool-edit.reparent').click();
      await page.getByTestId('reparent-confirm').click();
      await page.getByTestId('reparent-parent-existing-pick-item-syn-nest-outsider').click();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);
      await page.getByTestId('tool-edit.select').click();

      // 外の国を 1500 年で終わらせる → 板が出て、移した 2 件を数えている。
      await jumpToYear(page, 1500);
      await selectRow(page, '合成の外の国', 'syn-nest-outsider');
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
      const promoted = page.getByTestId('end-here-impact-promoted');
      await expect(promoted).toContainText(childName(0));
      await page.getByTestId('end-here-impact-confirm').click();
      await expect(page.getByTestId('end-here-impact')).toHaveCount(0);

      // 1600 年: 移した子は消えた親を指さず、最上位で居る。
      await jumpToYear(page, 1600);
      await selectRow(page, childName(0), childId(0));
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-value')).toHaveText('上位領域なし');
    } finally {
      await app.close();
    }
  });

  test('右クリックの「この年に終わったことにする」も同じ板を通る', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1500);
      await revealRow(page, PARENT_NAME, PARENT_ID);
      await page.getByTestId(`feature-list-item-${PARENT_ID}`).click({ button: 'right' });
      await page.locator('[data-item-kind="endHere"]').click();
      await expect(page.getByTestId('end-here-impact')).toBeVisible();
      await expect(page.getByTestId('end-here-impact-promoted')).toContainText('3 件');
      await page.getByTestId('end-here-impact-cancel').click();
      await expect(page.getByTestId('end-here-impact')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ② B64: 所属変更の道具が対象を掴んだままの Ctrl+Z
// ---------------------------------------------------------------------------

test.describe('B64 — 所属変更の道具が対象を掴んでいても Ctrl+Z は黙らない', () => {
  test('印から対象を引き継いだまま別の地物を終わらせ、Ctrl+Z で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1500);
      // 子 2 件に印を付け、所属の道具を構える（道具は印を対象として引き継ぐ＝下書きあり）。
      await markRow(page, childName(0), childId(0));
      await markRow(page, childName(1), childId(1));
      const tool = page.getByTestId('tool-edit.reparent');
      await tool.click();
      await expect(tool).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('reparent-target')).toHaveText(childId(0));

      // 別の地物（外の国。子が居ないので板は出ない）を素性欄から終わらせる。
      await selectRow(page, '合成の外の国', 'syn-nest-outsider');
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
      // 印から来た対象だけを持っているあいだ、道具は鍵盤を名乗らない（増分 7 の手直し 2 回目 /
      // 設計適合 指摘 1。印は一覧のもので道具の下書きではない）。
      await expect(page.getByTestId('app-focus-owner')).toHaveText('map');

      // 道具が対象を掴んだまま Ctrl+Z。**黙らずに大域の取り消しが効く**。
      await page.getByTestId('sidebar-tab-list').click();
      await blurToLedger(page);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
      // 道具の対象は壊れていない。
      await expect(page.getByTestId('reparent-target')).toHaveText(childId(0));
      // やり直しも同じく届く。
      await page.keyboard.press('Control+y');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ③ 板 × 打鍵: 背後へ抜けない
// ---------------------------------------------------------------------------

/** 出ていると数える板（どれか 1 枚だけが出ているはず）。 */
const BOARD_IDS = [
  'end-here-impact',
  'anchor-delete-impact',
  'vertex-delete-impact',
  'ring-delete-impact',
  'bulk-kind-dialog',
  'delete-impact',
  'delete-confirm',
  'basemap-aspect-dialog',
  'pre-save-dialog',
] as const;

async function openBoards(page: Page): Promise<string[]> {
  const open: string[] = [];
  for (const id of BOARD_IDS) {
    if ((await page.getByTestId(id).count()) > 0) open.push(id);
  }
  return open;
}

interface BoardCase {
  readonly board: (typeof BOARD_IDS)[number];
  /** 板を開くまで（開いた状態で返す）。`app` は main 側の差し替えが要る板だけが使う。 */
  readonly open: (page: Page, app: ElectronApplication) => Promise<void>;
}

const BOARD_CASES: readonly BoardCase[] = [
  {
    board: 'end-here-impact',
    open: async (page) => {
      await nested(page, 3, [1000], 1500);
      await selectRow(page, PARENT_NAME, PARENT_ID);
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
    },
  },
  {
    board: 'anchor-delete-impact',
    open: async (page) => {
      await nested(page, 2, [1000, 1200], 1200);
      await selectRow(page, PARENT_NAME, PARENT_ID);
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'anchor-section');
      await clickClearOfStickyBars(page.getByTestId('anchor-interval-summary-syn-nest-a-1200'));
      await clickClearOfStickyBars(page.getByTestId('anchor-interval-delete-syn-nest-a-1200'));
    },
  },
  {
    board: 'bulk-kind-dialog',
    open: async (page) => {
      await nested(page, 2, [1000], 1200);
      await markRow(page, childName(0), childId(0));
      await markRow(page, childName(1), childId(1));
      await page.getByTestId(`feature-list-item-${childId(1)}`).click({ button: 'right' });
      await page.locator('[data-item-kind="bulkKindLabel"]').click();
    },
  },
  {
    board: 'vertex-delete-impact',
    open: async (page) => {
      const { corners } = await commitOneFace(page);
      await armVertexTool(page);
      const [vx, vy] = corners[0]!;
      await page.mouse.click(vx, vy, { button: 'right' });
      await page.locator('[data-item-kind="deleteVertex"]').click();
    },
  },
  {
    board: 'ring-delete-impact',
    open: async (page) => {
      const { cx, cy } = await commitOneFace(page);
      await enterEditMode(page);
      await page.getByTestId('tool-edit.ring').click();
      await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
      const r = DEFAULT_FACE_HALF / 3;
      await page.mouse.click(cx, cy);
      await page.mouse.click(cx - r, cy - r);
      await page.mouse.click(cx + r, cy - r);
      await page.mouse.click(cx, cy + r);
      await page.getByTestId('ring-edit-confirm').click();
      await page.getByTestId('ring-edit-submode').click();
      await page.mouse.click(cx + DEFAULT_FACE_HALF * 0.7, cy);
      await page.mouse.click(cx, cy - r / 2);
    },
  },
  // 増分 8E の手直し（設計適合 S2-2）: 縦横比の板（台帳 #30）。設定の板の上に出る。
  {
    board: 'basemap-aspect-dialog',
    open: async (page, app) => {
      const dir = mkdtempSync(join(tmpdir(), 'tmap-e2e-board-keys-aspect-'));
      await stubImagePicker(app, await writePng(page, dir, 300, 200));
      await openSettingsAndReplace(page);
    },
  },
  // 本体の取り込みで足した: 保存の前の確認の板（台帳 #27）。
  {
    board: 'pre-save-dialog',
    open: (page) => openPreSaveBoard(page),
  },
];

test.describe('B — 板が出ている間、Ctrl+Z / Ctrl+S / Delete / Enter は背後へ抜けない', () => {
  for (const c of BOARD_CASES) {
    test(`${c.board}`, async () => {
      // Ctrl+S が背後で走ったら、ここへ書かれる（名前を付けて保存の行き先を固定する口）。
      const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-board-keys-'));
      const savePath = join(workDir, 'board-keys.gimoza');
      let launched: LaunchedApp | null = null;
      try {
        launched = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: savePath } });
        const { app, page } = launched;
        await c.open(page, app);
        await expect(page.getByTestId(c.board)).toBeVisible();
        await expect(page.getByTestId('app-focus-owner')).toHaveText('modal');

        const stats = await projectStats(page);
        const canUndo = await page.getByTestId('app-can-undo').textContent();
        const canRedo = await page.getByTestId('app-can-redo').textContent();

        for (const key of ['Control+z', 'Control+s', 'Delete', 'Enter']) {
          await page.keyboard.press(key);
          // 背後で何かが起きていれば、取り消し・保存・2 枚目の板のどれかに出る。
          await page.waitForTimeout(250);
          expect(await projectStats(page), `${key} で背後の企画が動いた`).toEqual(stats);
          await expect(page.getByTestId('app-can-redo'), `${key} で取り消しが走った`).toHaveText(
            canRedo ?? '',
          );
          await expect(page.getByTestId('app-can-undo')).toHaveText(canUndo ?? '');
          expect(existsSync(savePath), `${key} で背後の保存が走った`).toBe(false);
          const open = await openBoards(page);
          // Enter は板そのものが受けることがある（まとめて種別の入力欄で確定する）ので、
          // **背後の板が増えていない**ことだけを見る。それ以外は自分の板が残っている。
          if (key === 'Enter') {
            expect(open.filter((id) => id !== c.board), `${key} で背後の板が開いた`).toEqual([]);
          } else {
            expect(open, `${key} で板が増えた／消えた`).toEqual([c.board]);
          }
        }
      } finally {
        await launched?.app.close();
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// ④ C: 複数対象の帯の名乗り
// ---------------------------------------------------------------------------

test.describe('C — 複数対象のとき帯は「A ほか n 件」と名乗る', () => {
  test('印 3 件で所属の道具を構えると、帯の対象欄が 1 件目の名前と残りの件数を言う', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1200);
      for (let i = 0; i < 3; i += 1) await markRow(page, childName(i), childId(i));
      await page.getByTestId('tool-edit.reparent').click();
      const target = page.getByTestId('option-bar-target');
      await expect(target).toContainText(childName(0));
      await expect(target).toContainText('ほか 2 件');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ⑤ 決定 (4) V6
// ---------------------------------------------------------------------------

/** 年 → レーンの画素位置（表示範囲の線形写像。暦の端数は ±数 px に収まる）。 */
async function yearToLanePx(page: Page, year: number): Promise<number> {
  const v = await railView(page);
  return ((year - v.minYear) / (v.maxYear - v.minYear)) * v.pixelLength;
}

test.describe('決定 (4) V6 — 子を独立させると、その子のレーンに 1200 年の印が増える', () => {
  test('親から選り分けた印 1 本（1000 年）→ 独立後は自分の系列で 2 本（1000・1200 年）', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 3, [1000], 1200);
      await selectRow(page, childName(0), childId(0));
      // 独立前: 親の系列から選り分けた印（inherited）が 1 本。
      await expect.poll(async () => (await railLaneStats(page)).anchorCount).toBe(1);
      expect((await railLaneStats(page)).inherited).toBe(true);
      const before = await railMarkPositions(page);
      expect(before).toHaveLength(1);

      // 素性欄の［最上位へ］→ 3 択の板（独立の枝）→ 確定。
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('parent-clear').click();
      await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);

      // 選び直して読む（確定後に選択が残る保証は無い）。
      await page.getByTestId('tool-edit.select').click();
      await selectRow(page, childName(0), childId(0));
      // 独立後: **自分の系列**（記録の置き場の直しで、親から選り分けた印は自分の系列へ
      // 写っている）に 1000 年と 1200 年の 2 本。1000 年の印の位置は変わらない。
      await expect.poll(async () => (await railLaneStats(page)).anchorCount).toBe(2);
      expect((await railLaneStats(page)).inherited).toBe(false);
      const after = await railMarkPositions(page);
      expect(after).toHaveLength(2);
      const px1000 = await yearToLanePx(page, 1000);
      const px1200 = await yearToLanePx(page, 1200);
      expect(Math.abs((after[0] ?? -99) - px1000)).toBeLessThanOrEqual(3);
      expect(Math.abs((after[1] ?? -99) - px1200)).toBeLessThanOrEqual(3);
      expect(Math.abs((before[0] ?? -99) - px1000)).toBeLessThanOrEqual(3);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ⑥ 時刻レールの右クリック
// ---------------------------------------------------------------------------

async function laneBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId('anchor-lane').boundingBox();
  if (box === null) throw new Error('レーンが見えない');
  return box;
}

test.describe('時刻レールの右クリック（設計書 §I.3）', () => {
  test('錨の印: 移動・開始年を変える・消す（確認あり）。右クリックそのものは年を動かさない', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 2, [1000, 1200], 1500);
      await selectRow(page, PARENT_NAME, PARENT_ID);
      await expect.poll(async () => (await railLaneStats(page)).anchorCount).toBe(2);
      const box = await laneBox(page);
      const marks = await railMarkPositions(page);
      const y = box.y + box.height / 2;

      // 1200 年の印を右クリック。**年は動かない**（旧版は右ボタンでも移動していた）。
      await page.mouse.click(box.x + (marks[1] ?? 0), y, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toHaveAttribute('data-rail-target', 'anchor');
      await expect(page.getByTestId('timeline-current')).toHaveText('1500年');
      await expect(page.getByTestId('app-focus-owner')).toHaveText('modal');
      await expect(menu.locator('[data-rail-item]')).toHaveCount(3);

      // 消す → 錨表と同じ影響の板 → 確定で 1 本減る（Ctrl+Z 1 回で戻る）。
      await menu.locator('[data-rail-item="deleteAnchor"]').click();
      await expect(page.getByTestId('anchor-delete-impact')).toBeVisible();
      await page.getByTestId('anchor-delete-impact-confirm').click();
      await expect.poll(async () => (await railLaneStats(page)).anchorCount).toBe(1);

      // 残った 1 本は最後の 1 本なので、消す項目は理由つきで灰色。
      const marks2 = await railMarkPositions(page);
      await page.mouse.click(box.x + (marks2[0] ?? 0), y, { button: 'right' });
      await expect(menu.locator('[data-rail-item="deleteAnchor"]')).toBeDisabled();
      // 移動 → その錨の年へ。
      await menu.locator('[data-rail-item="jumpToAnchor"]').click();
      await expect(page.getByTestId('timeline-current')).toHaveText('1000年');

      // 開始年を変える → 素性欄の存続期間の欄が開き、開始の年の欄に焦点がある。
      await page.mouse.click(box.x + (marks2[0] ?? 0), y, { button: 'right' });
      await menu.locator('[data-rail-item="changeAnchorStart"]').click();
      const startYear = page.getByTestId('anchor-interval-start-syn-nest-a-1000-year');
      await expect(startYear).toBeFocused();
    } finally {
      await app.close();
    }
  });

  test('空白: この年へ移動・この年に錨を作る・全体表示', async () => {
    const { app, page } = await launchApp();
    try {
      await nested(page, 2, [1000], 1000);
      await selectRow(page, PARENT_NAME, PARENT_ID);
      await expect.poll(async () => (await railLaneStats(page)).anchorCount).toBe(1);
      const box = await laneBox(page);
      const y = box.y + box.height / 2;
      const px3000 = await yearToLanePx(page, 3000);

      await page.mouse.click(box.x + px3000, y, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toHaveAttribute('data-rail-target', 'empty');
      await expect(menu.locator('[data-rail-item]')).toHaveCount(4);
      await menu.locator('[data-rail-item="createAnchorHere"]').click();
      // その年へ動き、錨が 1 本増える（Ctrl+K と同じコマンド 1 本）。
      await expect(page.getByTestId('timeline-current')).toHaveText(/^\d+年$/);
      await expect.poll(async () => (await railLaneStats(page)).anchorCount).toBe(2);

      // Escape で閉じる（背後の選択は外れない）。
      await page.mouse.click(box.x + px3000 / 2, y, { button: 'right' });
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText(PARENT_ID);

      // 全体表示は押せる（表示範囲の観測が既定へ戻る）。
      await page.mouse.click(box.x + px3000 / 2, y, { button: 'right' });
      await menu.locator('[data-rail-item="fitAll"]').click();
      await expect(menu).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
