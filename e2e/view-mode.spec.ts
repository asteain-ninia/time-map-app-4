// HB-4 の回帰: **鍵**（読むだけ ⇄ 直せる）が本当に道具を使えるようにし、実 UI の経路で
// 面を 1 つ置けること（コントローラ直叩きではない）。元の不具合は「起動すると保存以外の
// ボタンが全部灰色で、直せる状態へ入る道が無い」―― 鍵にあたる導線がメニューで何もせず、
// 道具は灰色のままだった。
//
// **語は鍵と道具に揃えてある**（増分 5 の手直し 2 回目）。「表示専用」「追加モード」
// 「編集モード」という言い方は画面から無くなった（鍵 1 個＋道具 1 段になった）ので、
// 説明にも残さない ―― 検査の説明だけが古い語のまま残ると、次に読む人が画面にまだ
// そのボタンがあると読む（教訓 5.64 と同じ型）。内部の値（`app-mode` の
// `view` / `edit` / `add`）は道具から導かれる観測なので、そちらの名前はそのまま使う。
//
// この spec はビルド済みの実アプリを Playwright for Electron で動かし（ほかの e2e と
// 同じ `launchApp`）、**状態の変化**を実際の入力（クリック・マウス）と観測口
// （`app-mode` / 道具ごとの `disabled` / `app-active-feature`）で見る。道具がまた
// 灰色に戻るか、鍵が効かなくなれば、ここが赤くなる。

import { test, expect } from '@playwright/test';

import {
  ALL_TOOL_TESTIDS,
  addInputLayerBox,
  commitOneFace,
  drawFace,
  enterEditMode,
  launchApp,
  openPropertySection,
  returnToViewMode,
  squareCorners,
} from './helpers';


test.describe('HB-4 — 鍵を「直せる」にすると道具が使えるようになる (live UI)', () => {
  test('起動直後は道具が全部灰色で、鍵を開けると押せるようになり、実 UI で面を 1 つ置ける', async () => {
    const { app, page } = await launchApp();
    try {
      // 1. 起動直後は **鍵が閉じている**（読むだけ）。鍵のボタンは押せて、押された姿で
      //    出ている。**道具は 1 つ残らず灰色**である（教訓 5.13: 関門は 1 本）。
      //    **増分 5b**: モードの 2 ボタンは廃止され、鍵 1 個＋道具の 1 段になった。
      //    「読むだけで編集の入口が閉じている」は **道具が全部灰色である**ことで見る。
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      const viewToggle = page.getByTestId('mode-view');
      await expect(viewToggle).toBeEnabled();
      await expect(viewToggle).toHaveAttribute('aria-pressed', 'true');
      for (const tool of ALL_TOOL_TESTIDS) {
        // 断りの文は **落ちたときに読む**ものなので、「起きてはいけないことが起きた」
        // と書く（増分 5 の手直し F3。「押せない」と書くと、落ちた画面で
        // 「押せないのが正しいのに落ちた？」と読めてしまう）。
        await expect(
          page.getByTestId(tool),
          `読むだけなのに ${tool} が押せてしまう`,
        ).toBeDisabled();
      }

      // 2. **鍵を開ける**（実際にボタンを押す）。内部の値は `edit`（＝道具を構えて
      //    いない直せる状態）へ移り、道具が全部押せるようになる ―― 原因（鍵）と
      //    結果（道具）の両方を観測する。
      await viewToggle.click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await expect(viewToggle).toHaveAttribute('aria-pressed', 'false');
      for (const tool of ALL_TOOL_TESTIDS) {
        await expect(page.getByTestId(tool), `${tool} が直せる状態でも押せない`).toBeEnabled();
      }

      // 3. 面の道具を構えると、内部の mode が add になる（設計書 §D.1 の導出式）。
      //    **「先に入る場所を選んでから道具を選ぶ」の 2 手が 1 手になった**のがここ。
      const areaTool = page.getByTestId('tool-add.area');
      await areaTool.click();
      await expect(areaTool).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('app-mode')).toHaveText('add');

      // 4. ADD A FACE through the REAL UI path: 面ツール → 四隅クリック → 完了 → 保存.
      //    This proves editing is genuinely reachable end-to-end (D23 evidence: a
      //    committed feature, not a controller 直叩き). The active tool hook shows
      //    the selection; the committed-feature marker confirms the save landed.
      //    **道具はもう構えてある**（手順 3 が構えた）。もう一度押すと外れるので押さない。
      await expect(page.getByTestId('app-active-tool')).toHaveText('add.area');

      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      // 頂点クリック → 完了 → 保存 → 選択の再解決待ち は drawFace が担う。
      // The add committed and the live selection re-resolved to the new face: the
      // hidden observability marker is now non-empty (a real committed feature
      // through the live add binding — the editing path is fully reachable).
      await drawFace(page, squareCorners(cx, cy, 120));
    } finally {
      await app.close();
    }
  });

  test('the 表示 menu「読むだけ ⇄ 直せる」command is registered + enabled and flips the mode (named導線 ViewToggleViewMode)', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-mode')).toHaveText('view');

      // Open the 表示 menu and assert the view-mode-toggle item is ENABLED (it was
      // 未登録==無効 before HB-4 — a dead导线). A real click flips the mode out of
      // View, proving the menu命令 and the store are one truth (教訓 5.13).
      await page.getByTestId('menu-view').click();
      const items = page.getByTestId('menu-items-view');
      await expect(items).toBeVisible();
      const toggleItem = items.locator('[data-command="view.toggleViewMode"]');
      await expect(toggleItem).toBeVisible();
      await expect(toggleItem).toBeEnabled();
      await toggleItem.click();

      // The mode left View → 編集 (the SAME transition the toolbar导线 drives) and
      // the toolbar edit toggles activated together — the menu导线 reaches the SAME
      // gate/store the toolbar does (教訓 5.13 単一真実源).
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await expect(page.getByTestId('tool-add.area')).toBeEnabled();
      await expect(page.getByTestId('tool-edit.knife')).toBeEnabled();

      // Re-dispatch the SAME menu命令: it toggles back to View (the reversal
      // contract), proving it is a real toggle, not a one-way switch.
      await page.getByTestId('menu-view').click();
      await expect(items).toBeVisible();
      await expect(toggleItem).toBeEnabled();
      await toggleItem.click();
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await expect(page.getByTestId('tool-add.area')).toBeDisabled();
      await expect(page.getByTestId('tool-edit.knife')).toBeDisabled();
    } finally {
      await app.close();
    }
  });

  // HB-16 — the left toolbar's mode-toggle buttons must carry NO tooltip (the
  // hover bubble obstructed the click target), while the tool buttons keep theirs.
  // Behavioral: assert no tooltip element near the mode buttons, that they still
  // function on a real click, and that a tool button still has its tooltip.
  test('mode-toggle buttons have no tooltip and still work; tool tooltips remain (HB-16)', async () => {
    const { app, page } = await launchApp();
    try {
      // No tooltip wrapper (data-testid="tooltip") or role="tooltip" bubble inside the mode group.
      // **増分 5b**: この群に居るのは鍵 1 個だけになった（testid は据え置き＝T-1）。
      // **増分 5 の手直し D1**: その鍵はレールからアプリバー右端の 96px 枠へ移った
      // （司令塔の決定 (1)。設計書 §C.1-4）。役割は同じなので `mode-view` は据え置き、
      // 器の testid だけが `toolbar-modes` → `app-shell-lock` に変わる。
      const modeGroup = page.getByTestId('app-shell-lock');
      await expect(modeGroup).toBeVisible();
      await expect(modeGroup.getByTestId('tooltip')).toHaveCount(0);
      await expect(modeGroup.locator('[role="tooltip"]')).toHaveCount(0);
      await expect(
        page.getByTestId('tooltip').filter({ has: page.getByTestId('mode-view') }),
      ).toHaveCount(0);

      // They still function: 鍵を開けて、面の道具を構える。
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await page.getByTestId('tool-add.area').click();
      await expect(page.getByTestId('app-mode')).toHaveText('add');

      // Tool buttons still carry their tooltip (regression: not all removed).
      const toolBtn = page.getByTestId('tool-add.point');
      await expect(page.getByTestId('tooltip').filter({ has: toolBtn })).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
});

test.describe('K-6 — 「読むだけ」では削除に手が届かない (N-03 の回帰)', () => {
  // N-03 は「読むだけでも『地物を削除』だけが押せる」と報告されていたが、**実アプリ
  // では今のところ届かない**。鍵を切り替えると store.setMode が選択を捨てる（結合点 #6）
  // ので、素性欄に地物が出ず、削除ボタンがそもそも描かれないためである。
  //
  // 欠陥は部品の契約のほうに実在した: DeleteFeatureButton は権限の入力を持たず、
  // PropertyPanel も権限を渡さずに onDeleteFeature を直接呼んでいた。つまり **「読むだけ」で
  // 地物が選ばれたまま素性欄が出る状態になった瞬間に押せるようになる**。設計書 §D.2 ★★ は
  // まさにそれ（鍵を閉めても選択を保つ）を予定しているので、いま塞いでおく。部品の契約は
  // src/ui/shell/view-only-gate.test.tsx の表と DeleteFeatureButton.test.tsx が固定する。
  //
  // **2026-09-05（増分 4 の手直し B12）でここが「無効なボタンが出る」側になった。**
  // 所有者の裁定「読むだけでも選べる・読める・直せない」に合わせて、鍵を閉めても
  // 選択を保つようにしたので（`store.setMode`）、素性欄は地物を出したまま、値を変える
  // 入力と削除ボタンだけが無効になる。上の注記が予告していた書き換えである。
  test('読むだけでも選択と素性欄は残り、削除ボタンは出るが押せない', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitOneFace(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      // **増分 7 の中身 5**: 削除の入口は 2 本になり、「全部の年から消す」ほうは
      // 畳んだ節「取り返しのつかないこと」の中にある（目立つ位置に立つのは
      // 「この年に終わったことにする」）。節を開いてからボタンを見る。
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'danger-zone');
      const deleteButton = page.getByTestId('delete-feature').getByRole('button');
      await expect(deleteButton).toBeEnabled();

      // 「読むだけ」へ。**選択は残る**（読める）が、削除は押せない（直せない）。
      await returnToViewMode(page);
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await openPropertySection(page, 'danger-zone');
      await expect(deleteButton).toBeDisabled();
      // 押しても確認ダイアログは開かない（disabled 属性だけに頼らない＝K-6）。
      await deleteButton.click({ force: true });
      await expect(page.getByTestId('delete-impact')).toHaveCount(0);

      // 「直せる」へ戻すと、選び直さなくても押せる（選択が保たれている証）。
      await enterEditMode(page);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(deleteButton).toBeEnabled();
    } finally {
      await app.close();
    }
  });
});
