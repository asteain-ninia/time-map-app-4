// 増分 7「歴史の構造編集（所属変更・削除・拒否理由）」の受け入れを実アプリで押す。
//
// **なぜ本体（main）に置くのか**: 所属変更・輪郭・穴あけの 3 道具は、**振る舞いの検査が
// 探索用（`__visual__` / `__bughunt__`）にしか無かった**（現状分析 §8.2 の読み取り 3）。
// `npm run e2e` は探索用を走らせないので、この 3 つは **毎回の検査に載っていなかった**。
// 増分 7 で構造編集を作り直すにあたり、回帰を捕まえる網をここへ張る。
//
// ここで見るのは jsdom では測れないものだけである（教訓 5.49）:
//   ① 3 択の板が実アプリで開き、台帳と同じツリーから親を選んで確定できる（V6・V7）
//   ② 一覧で複数に印を付け、まとめて新しい上位領域の下に入れ、Ctrl+Z 1 回で戻る（V8）
//   ③ 印を付けた地物が **対象色**で地図に同時に描かれる（結合点 #4）
//   ④ 素性欄の親欄の 3 ボタンが所属変更の手順へ入る（中身 3b）
//   ⑤「この年に終わったことにする」が既定の入口から 2 手（中身 5）
//   ⑥ 全部の年から消す前に、影響の一覧が出る（中身 6）
//   ⑦ まとめて種別を付けたものが Ctrl+Z 1 回で戻る（中身 8）
//   ⑧ 輪郭（穴を足す・消す）と穴あけが最後まで通る（3 道具の網）
//
// **座標は「箱と世界の帯」から解く**（増分 1 の教訓を増分 6 で踏み直した）。固定 px で
// 置くと、地図セルの寸法が変わった瞬間に「世界の外です」で落ちる。

import { expect, test, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  besideSquareX,
  commitFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  leaveViewMode,
  listedFeatureCount,
  openPropertySection,
  squareCorners,
  worldBandIn,
  type ScreenPoint,
} from './helpers';

/** 面を 3 つ横に並べるときの半径（px）。地図セルの縦に収まる大きさにする。 */
const HALF = 70;

interface Placed {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly corners: readonly ScreenPoint[];
}

/**
 * 世界の帯の中に、重ならない正方形の面を `count` 個、横に並べて確定する。
 *
 * **世界の帯から解く**（`worldBandIn`）―― 地図セルの縦横比で世界の占める矩形は変わる
 * ので、固定 px で置くと「そこは世界の外です」で落ちる。左右の端はさらに 1 個ぶん内側へ
 * 寄せる（日付変更線の向こう側が回り込んでいる帯を避ける＝増分 1 の教訓）。
 */
async function placeFaces(page: Page, count: number, names: readonly string[]): Promise<Placed[]> {
  await enterEditMode(page);
  const box = await (async (): Promise<{ x: number; y: number; width: number; height: number }> => {
    // 入力層は追加の道具を構えてからでないと出ないので、最初の 1 個で測る。
    await page.getByTestId('tool-add.area').click();
    return addInputLayerBox(page);
  })();
  const band = worldBandIn(box);
  const cy = (band.top + band.bottom) / 2;
  const out: Placed[] = [];
  let cx = band.left + (band.right - band.left) * 0.2;
  for (let i = 0; i < count; i += 1) {
    const corners = squareCorners(cx, cy, HALF);
    const id = await commitFace(page, corners, { name: names[i] ?? `面${String(i + 1)}` });
    out.push({ id, cx, cy, corners });
    cx = besideSquareX(cx, HALF);
  }
  return out;
}

/** 一覧タブを開いて、行の「対象にする」升目を入れる（`markedFeatures`）。 */
async function markInLedger(page: Page, featureId: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  const mark = page.getByTestId(`ledger-mark-${featureId}`);
  await expect(mark).toBeVisible();
  await mark.check();
}

/** 一覧の行を選ぶ（素性欄がその地物に切り替わる）。 */
async function selectInLedger(page: Page, featureId: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId(`feature-list-item-${featureId}`).click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(featureId);
}

/** 所属変更の道具を構える。 */
async function armReparent(page: Page): Promise<void> {
  await enterEditMode(page);
  const tool = page.getByTestId('tool-edit.reparent');
  if ((await tool.getAttribute('aria-pressed')) === 'true') await tool.click();
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

/** 地図に描かれた図形の本数（`window.__E2E__` の観測口）。 */
async function shapeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (
      globalThis as { __E2E__?: { getPrimitiveCounts?: () => Record<string, number> } }
    ).__E2E__;
    if (e2e?.getPrimitiveCounts === undefined) throw new Error('window.__E2E__ が無い');
    return e2e.getPrimitiveCounts()['shape'] ?? 0;
  });
}

test.describe('増分 7 — 所属変更の 3 択（V6 / V7 / 中身 1・2・4）', () => {
  test('地図で対象を掴み、台帳と同じツリーから新しい上位領域を選んで確定できる', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 2, ['移す面', '行き先の面']);
      const [target, destination] = faces;
      expect(target).toBeDefined();
      expect(destination).toBeDefined();

      await armReparent(page);
      // 手順 1: 対象を掴む。
      await page.mouse.click(target!.cx, target!.cy);
      await expect(page.getByTestId('reparent-target')).toHaveText(target!.id);

      // ［所属を変える］は **対象さえ掴んでいれば押せる**（増分 7 の中身 1）。
      const confirm = page.getByTestId('reparent-confirm');
      await expect(confirm).toBeEnabled();
      await confirm.click();

      // 3 択の板が開く。用語集の 7 操作名が説明文に出ている（中身 11 / N-31）。
      const dialog = page.getByTestId('reparent-options-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('reparent-options-parent')).toContainText('割譲');
      await expect(page.getByTestId('reparent-options-parent')).toContainText('連邦化');
      await expect(page.getByTestId('reparent-dismantle-note')).toContainText('解体');

      // **773 件の素のプルダウンではなく、台帳と同じツリー**（中身 2）。
      const tree = page.getByTestId('reparent-parent-existing-pick-tree');
      await expect(tree).toBeVisible();
      await page.getByTestId(`reparent-parent-existing-pick-item-${destination!.id}`).click();

      // **分け残し（直轄領）の名前を確定前に上書きできる**（中身 4 / G-4 / FR-37 must）。
      const ddName = page.getByTestId('reparent-direct-domain-name');
      await expect(ddName).toBeVisible();
      await ddName.fill('行き先の本国');

      await page.getByTestId('reparent-options-confirm').click();
      await expect(dialog).toHaveCount(0);

      // 確定後、対象の上位領域が行き先になっている（素性欄の親欄）。
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-value')).toHaveText('行き先の面');

      // 名前を上書きした分け残しが一覧に増えている（既定名称ではない）。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('行き先の本国');
      expect(await listedFeatureCount(page)).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('素性欄の親欄の［最上位へ］は、押した瞬間に所属変更の手順へ入る（中身 3b）', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 2, ['子になる面', '親になる面']);
      const [child, parent] = faces;

      // まず子を親の下に入れる。
      await armReparent(page);
      await page.mouse.click(child!.cx, child!.cy);
      await page.getByTestId('reparent-confirm').click();
      await page.getByTestId(`reparent-parent-existing-pick-item-${parent!.id}`).click();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);

      // 素性欄の親欄の 3 ボタンは **押せる**（増分 4 では無効＋理由だった）。
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-pick')).toBeEnabled();
      await expect(page.getByTestId('parent-create')).toBeEnabled();
      const clear = page.getByTestId('parent-clear');
      await expect(clear).toBeEnabled();

      // 押すと **所属変更の板が独立の枝で開く**（保存ボタンでは親を変えない）。
      await clear.click();
      await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
      await expect(page.getByTestId('reparent-parent-none')).toBeChecked();
      await expect(page.getByTestId('reparent-detach-confirm')).toContainText(
        'どこにも所属しなくなります',
      );
      await page.getByTestId('reparent-options-confirm').click();

      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-value')).toHaveText('上位領域なし');
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 7 — 複数対象（V8 / 中身 2b）', () => {
  test('一覧で 3 件に印を付け、まとめて新しい上位領域の下に入れ、Ctrl+Z 1 回で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 3, ['エテ合議国', 'テレン合議国', 'ピニア']);
      expect(faces).toHaveLength(3);

      // **印を付ける前の図形の本数を先に測る**。描き直しは間引かれている
      // （`FrameScheduler`）ので、**付けてから消して測る**と 1 コマ前の姿を掴む
      // ―― それだと「消したはずなのに 3 本入ったままの数」を下敷きにしてしまう。
      await page.getByTestId('sidebar-tab-list').click();
      const withoutMarks = await shapeCount(page);
      expect(withoutMarks).toBeGreaterThan(0);

      // 一覧で 3 件に印を付ける（`markedFeatures`。設計書 §D.5）。
      for (const f of faces) await markInLedger(page, f.id);
      await expect(page.getByTestId('ledger-marked-count')).toHaveText('対象 3 件');

      // **3 件が対象色で同時に地図に描かれる**（結合点 #4）。
      await expect.poll(async () => (await shapeCount(page)) - withoutMarks).toBe(3);

      await armReparent(page);
      await expect(page.getByTestId('reparent-target')).toHaveText(faces[0]!.id);

      await page.getByTestId('reparent-confirm').click();
      await page.getByTestId('reparent-parent-create').check();
      await page.getByTestId('reparent-parent-create-name').fill('エテ連邦');
      await page.getByTestId('reparent-parent-create-kind').fill('連邦');
      // 予告文が件数と行き先を言う（V8）。
      await expect(page.getByTestId('reparent-preview')).toContainText('3 件');
      await expect(page.getByTestId('reparent-preview')).toContainText('エテ連邦');
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);

      // 新しい上位領域ができている。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('エテ連邦');
      expect(await listedFeatureCount(page)).toBe(1);

      // **Ctrl+Z 1 回で戻る**（3 件ぶんが 1 つの取り消し単位）。
      // **絞り込み欄から焦点を外してから押す** ―― 文字の欄に焦点があるあいだ、大域の
      // 打鍵は素通しされる（設計書 §I.1 / `focus-guard`）。
      await page.getByTestId('unified-list-filter').fill('');
      await page.getByTestId('ledger-scroller').click();
      await page.keyboard.press('Control+z');
      await page.getByTestId('unified-list-filter').fill('エテ連邦');
      await expect(page.getByTestId('unified-list-no-match')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 7 — 削除の 2 経路（中身 5・6）', () => {
  test('「この年に終わったことにする」は素性欄から 2 手で届く', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 1, ['滅ぶ国']);
      await jumpToYear(page, 1500);
      await selectInLedger(page, faces[0]!.id);
      await page.getByTestId('sidebar-tab-properties').click();

      // 1 手目: 目立つ位置のボタン（畳んだ節の中ではない）。年が文言に入っている。
      const endHere = page.getByTestId('end-here');
      await expect(endHere).toBeVisible();
      await expect(endHere).toContainText('1500年に終わったことにする');
      // 2 手目: 押す。
      await endHere.click();

      // 状態行に結果が出る（消えない形＝設計書 §H.5）。
      await expect(page.getByTestId('statusbar-result')).toContainText('1500年で終わった');
    } finally {
      await app.close();
    }
  });

  test('全部の年から消す前に、影響の一覧が出る（畳んだ節の中にある）', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 2, ['子の面', '親の面']);
      // 子を親の下に入れて、親を消したときに「最上位へ移る下位領域」が出る形を作る。
      await armReparent(page);
      await page.mouse.click(faces[0]!.cx, faces[0]!.cy);
      await page.getByTestId('reparent-confirm').click();
      await page.getByTestId(`reparent-parent-existing-pick-item-${faces[1]!.id}`).click();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);

      await selectInLedger(page, faces[1]!.id);
      await page.getByTestId('sidebar-tab-properties').click();

      // **取り返しのつかないことは畳んである**（設計書 §A.3 / §C.6）。
      await openPropertySection(page, 'danger-zone');
      await page.getByTestId('delete-feature').getByRole('button').click();

      // 影響の一覧が出る（「よろしいですか」だけではない）。
      const impact = page.getByTestId('delete-impact');
      await expect(impact).toBeVisible();
      await expect(page.getByTestId('delete-impact-gone')).toContainText('錨');
      await expect(page.getByTestId('delete-impact-referenced')).toContainText(
        'すべての年で最上位へ移ります',
      );
      await expect(page.getByTestId('delete-impact-note')).toContainText('Ctrl+Z');

      // やめれば何も起きない（教訓 5.22）。
      await page.getByTestId('delete-impact-cancel').click();
      await expect(impact).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 7 — まとめて種別を付ける（中身 8）', () => {
  test('印を付けた 3 件へまとめて種別を付け、Ctrl+Z 1 回で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 3, ['甲', '乙', '丙']);
      for (const f of faces) await markInLedger(page, f.id);

      // 一覧の行を右クリック → まとめて種別を付ける（設計書 §I.3 の「台帳の行」）。
      await page.getByTestId(`feature-list-item-${faces[0]!.id}`).click({ button: 'right' });
      await expect(page.getByTestId('context-menu')).toBeVisible();
      await page.locator('[data-item-kind="bulkKindLabel"]').click();

      await page.getByTestId('bulk-kind-input').fill('州');
      await page.getByTestId('bulk-kind-confirm').click();
      await expect(page.getByTestId('bulk-kind-dialog')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('3 件へ種別「州」');

      // 行の種別の欄に出ている。
      for (const f of faces) {
        await expect(page.getByTestId(`ledger-kind-${f.id}`)).toHaveText('州');
      }

      // **Ctrl+Z 1 回で 3 件とも戻る**（335 件でも同じ形）。
      await page.getByTestId('ledger-scroller').click();
      await page.keyboard.press('Control+z');
      for (const f of faces) {
        await expect(page.getByTestId(`ledger-kind-${f.id}`)).toHaveText('');
      }
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 7 — 輪郭と穴あけを本体の検査に載せる', () => {
  test('輪郭: 穴を足して、消すときは確認が出る（N-05 / 中身 7）', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 1, ['穴をあける面']);
      const face = faces[0]!;

      await enterEditMode(page);
      const ring = page.getByTestId('tool-edit.ring');
      await ring.click();
      await expect(page.getByTestId('ring-edit-tool')).toBeVisible();

      // 手順 1: 対象の面（塗りの上）。
      await page.mouse.click(face.cx, face.cy);
      // 手順 2: 穴の輪郭を 3 点（面の内側）。
      const r = HALF / 3;
      await page.mouse.click(face.cx - r, face.cy - r);
      await page.mouse.click(face.cx + r, face.cy - r);
      await page.mouse.click(face.cx, face.cy + r);
      await page.getByTestId('ring-edit-confirm').click();

      // 消す側へ切り替える。**消す側も 2 段**である ―― まず対象の面を「塗りの上」で
      // 拾い（当たり判定は穴を透かすので、穴の外を押す）、そのあと消したい穴の内側を押す。
      await page.getByTestId('ring-edit-submode').click();
      await page.mouse.click(face.cx + HALF * 0.7, face.cy); // 手順 1: 対象の面（穴の外）
      await page.mouse.click(face.cx, face.cy - r / 2); // 手順 2: 穴の内側
      const impact = page.getByTestId('ring-delete-impact');
      await expect(impact).toBeVisible();
      await page.getByTestId('ring-delete-impact-cancel').click();
      await expect(impact).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('穴あけ: くり抜いた形が新しい地物になる（FR-45）', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 1, ['くり抜かれる面']);
      const face = faces[0]!;

      await enterEditMode(page);
      await page.getByTestId('tool-edit.drill').click();
      await expect(page.getByTestId('drill-tool')).toBeVisible();

      await page.mouse.click(face.cx, face.cy); // 対象の面
      const r = HALF / 3;
      await page.mouse.click(face.cx - r, face.cy - r);
      await page.mouse.click(face.cx + r, face.cy - r);
      await page.mouse.click(face.cx, face.cy + r);
      await page.getByTestId('drill-confirm').click();

      // 新しい地物の素性を右パネルで入れる（増分 5 で板をやめた形）。
      await page.getByTestId('add-name').fill('くり抜いた島');
      await page.getByTestId('add-save').click();

      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('unified-list-filter').fill('くり抜いた島');
      // 件数の書式は「一致 / 総数件」（あいだに空白が入る）。**表示の書式を直書きせず**
      // 一致数だけを読む（教訓 5.64）。
      expect(await listedFeatureCount(page)).toBe(1);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 7 — 読むだけでは構造を変えられない（K-6）', () => {
  test('鍵を閉じると、印の項目も削除の入口も出ない', async () => {
    const { app, page } = await launchApp();
    try {
      const faces = await placeFaces(page, 1, ['読むだけの面']);
      await selectInLedger(page, faces[0]!.id);

      // 鍵を閉じる（読むだけ）。
      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('mode-view')).toHaveAttribute('aria-pressed', 'true');

      await page.getByTestId(`feature-list-item-${faces[0]!.id}`).click({ button: 'right' });
      await expect(page.getByTestId('context-menu')).toBeVisible();
      // 編集の項目は 1 つも出ない（教訓 5.13 の一括無効化）。
      await expect(page.locator('[data-item-kind="markTarget"]')).toHaveCount(0);
      await expect(page.locator('[data-item-kind="endHere"]')).toHaveCount(0);
      await expect(page.locator('[data-item-kind="delete"]')).toHaveCount(0);
      await page.keyboard.press('Escape');

      // 素性欄の親欄も押せない。
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('parent-clear')).toBeDisabled();
      await leaveViewMode(page);
    } finally {
      await app.close();
    }
  });
});
