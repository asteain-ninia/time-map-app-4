// HB3-9 回帰ロック — 編集モードの選択ハンドル描画 behavioural E2E.
//
// ROOT (診断 HB3-9 / 教訓 5.7「ロジックはあるが UI から呼ばれない」): `computeHandles`
// resolved a selected feature's vertex / edge-midpoint handles in world coordinates, but
// NOTHING in the render pipeline ever consumed it — the only caller was its unit test.
// So a user who selected a feature in 編集モード saw NO grab handles and could not tell
// what to drag. The fix adds an edit-handles render layer (computeHandles → screen-fixed
// HandlePrimitive) composited每フレーム for the active feature in 編集モード.
//
// This spec drives the REAL built composite with REAL pointer events (mousedown→move→up
// for the add corners are real clicks; the selection is a real click) and observes the
// ACTUAL RENDER via the window.__E2E__ hook (per-frame primitive 種別カウント). A synthetic
// shortcut could not detect this bug — only观察ing the drawn frame proves handles appear.
// A re-regression (handle layer unwired) reddens here even while computeHandles stays
// green in its unit test (the classic 教訓 5.7 失敗 mode).

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  drawFace,
  enterEditMode,
  launchApp,
  squareCorners,
  DEFAULT_FACE_HALF,
} from './helpers';

interface PrimitiveCounts {
  handle: number;
  label: number;
  shape: number;
  point: number;
  line: number;
  /** FR-82 点線アウトライン (頂点選択コンテキスト地物) drawn this frame. */
  dashedLine: number;
  preview: number;
  hasLivePreview: boolean;
}

/** Read the last-drawn-frame primitive counts off the live __E2E__ render hook. */
async function primitiveCounts(page: Page): Promise<PrimitiveCounts> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getPrimitiveCounts: () => PrimitiveCounts };
    }).__E2E__;
    if (e2e === undefined) {
      return {
        handle: -1,
        label: -1,
        shape: -1,
        point: -1,
        line: -1,
        dashedLine: -1,
        preview: -1,
        hasLivePreview: false,
      };
    }
    return e2e.getPrimitiveCounts();
  });
}

test.describe('HB3-9 — 編集モードで選択地物に編集ハンドルが描画される', () => {
  test('面を選択するとハンドルが描かれ、選択解除/View で消える', async () => {
    const { app, page } = await launchApp();
    try {
      // The __E2E__ render-observation hook must exist once the map renderer mounted.
      await expect
        .poll(async () => page.evaluate(() => typeof (window as unknown as {
          __E2E__?: unknown;
        }).__E2E__))
        .toBe('object');

      // 1) Commit one 面 (face) through the LIVE add導線 with four REAL corner clicks,
      //    so its vertices live at known SCREEN positions under the live camera.
      const { faceId, cx, cy } = await commitOneFace(page);
      expect(faceId.length).toBeGreaterThan(0);

      const activeFeature = page.getByTestId('app-active-feature');

      // 2) Enter 編集モード (which clears the post-commit selection, 教訓 5.2) and then
      //    REAL-click the face BODY centre to select it. The committed face becomes the
      //    active feature, so its edit handles must now be composited. A square face has
      //    4 vertices + 4 edges (closed ring) → at least 4 vertex + 4 edge handles = 8.
      await enterEditMode(page);
      await expect(activeFeature).toHaveText('');
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      await expect.poll(async () => (await primitiveCounts(page)).handle, {
        message: 'edit handles must be drawn for the selected face in 編集モード',
      }).toBeGreaterThanOrEqual(8);

      // The __E2E__ active-feature mirror agrees with the DOM marker (single truth).
      await expect
        .poll(async () =>
          page.evaluate(() => (window as unknown as {
            __E2E__: { getActiveFeature: () => string };
          }).__E2E__.getActiveFeature()),
        )
        .toBe(faceId);

      // 3) Switch to View mode → no edit handles draw.
      //
      // **2026-09-05（増分 4 の手直し B12）で「選択は残る」に変わった。** 所有者の裁定
      // 「読むだけでも選べる・読める・直せない」に合わせて、鍵を掛けても選択は捨てない
      // （`store.setMode`）。**だからこの検査はいっそう強くなる** ―― 「選択が消えたから
      // ハンドルも消えた」ではなく、**選んだままでもハンドルは 1 本も描かれない**ことを
      // 見るので、ハンドルの層が本当に編集モードで閉じているかを固定できる。
      await page.getByTestId('mode-view').click();
      await expect(activeFeature).toHaveText(faceId);
      await expect.poll(async () => (await primitiveCounts(page)).handle, {
        message: 'handles must NOT draw in View mode (HB3-9 編集モード gate)',
      }).toBe(0);

      // 4) Re-enter 編集モード → handles return（選択は保たれているので選び直さなくてよい）。
      //    これも層が **選択ではなくモード**で駆動されている証である。
      await enterEditMode(page);
      await expect(activeFeature).toHaveText(faceId);
      await expect.poll(async () => (await primitiveCounts(page)).handle, {
        message: 'handles must reappear when the face is re-selected in 編集モード',
      }).toBeGreaterThanOrEqual(8);
    } finally {
      await app.close();
    }
  });

  // 敵対レビュー回帰ロック (FR-80 / FR-82 / 教訓 5.7 / 5.35) — 頂点選択だけが変わる導線。
  //
  // 二つの実バグを同時に締める。どちらも「頂点選択は成立しているのに画面が変わらない」
  // という同じ症状で、単体テストでは踏めない結線側の欠陥:
  //
  //   (1) FR-82 頂点選択コンテキスト地物: U22 の頂点分岐は activeFeature を昇格させない
  //       (FR-82 はアクティブ地物と別状態として定義している) 一方、ハンドル層は
  //       activeFeature が null なら即 [] を返していた。よって「編集モードで最初に頂点を
  //       直接クリックする」= 最も素直な導線で、選択は store に入るのにハンドルもリングも
  //       0 個 = 完全な無反応だった。
  //   (2) 再描画購読の watch 漏れ: 唯一の再描画購読は selection を一切 watch していな
  //       かったので、activeFeature が既に不変な状態で選択だけが変わる遷移 (ここでは
  //       空白クリックによる選択解除) はフレームを更新せず、古いハンドルが残り続けた。
  //
  // どちらも実際に描かれたフレーム (__E2E__ プリミティブ数) でしか観測できない。
  test('アクティブ地物なしで頂点を直接クリックすると所有地物のハンドルが出て、空白クリックで消える', async () => {
    const { app, page } = await launchApp();
    try {
      await expect
        .poll(async () => page.evaluate(() => typeof (window as unknown as {
          __E2E__?: unknown;
        }).__E2E__))
        .toBe('object');

      // 入力層の box は「空白クリック」の座標にも使うので、面ツールを構えてから採る。
      await armAddAreaTool(page);
      const a = await addInputLayerBox(page);
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;
      const corners = squareCorners(cx, cy, DEFAULT_FACE_HALF);
      const faceId = await drawFace(page, corners);

      const activeFeature = page.getByTestId('app-active-feature');

      // 編集モードに入ると選択は破棄され (教訓 5.2)、ハンドルは 0。
      await enterEditMode(page);
      await expect(activeFeature).toHaveText('');
      await expect.poll(async () => (await primitiveCounts(page)).handle).toBe(0);

      // (1) アクティブ地物ゼロのまま、頂点を直接クリック。activeFeature は空のままで、
      //     頂点選択だけが立つ — その所有地物の頂点ハンドルが描かれなければならない。
      const [vx, vy] = corners[0]!;
      await page.mouse.click(vx, vy);
      await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
      await expect(page.getByTestId('app-active-vertex-owner')).toHaveText(faceId);
      await expect(activeFeature).toHaveText(''); // 昇格していない = FR-82 の別状態
      await expect.poll(async () => (await primitiveCounts(page)).handle, {
        message:
          '頂点選択の所有地物には頂点ハンドル (と選択リング) が描かれる — 0 なら選択が不可視',
      }).toBeGreaterThanOrEqual(4);

      // (2) 空白クリックで選択解除。activeFeature も mode も表示制御も不変で、変わるのは
      //     selection だけ — それでもフレームは更新され、ハンドルは消えなければならない。
      await page.mouse.click(a.x + 8, a.y + 8);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await expect.poll(async () => (await primitiveCounts(page)).handle, {
        message:
          '選択解除は再描画されなければならない (selection を watch しないと古いハンドルが残る)',
      }).toBe(0);
    } finally {
      await app.close();
    }
  });

  // FR-82 本体の回帰ロック —「頂点選択コンテキスト地物は点線アウトライン」。
  //
  // 86948d7 は選択頂点リング (シアン) / ドラッグ中リング (橙) までは実装したが、FR-82 が
  // 並記するもう一つの視覚状態=「頂点選択の所有地物を点線で囲む」は未実装のままだった:
  // domain/selection/visual.ts の classifyVisual が Context を分類していながら描画消費者が
  // ゼロ (教訓 5.7「ロジックはあるが UI から呼ばれない」= HB3-9 と同型の欠陥)。ユーザ側の
  // 症状は「頂点は光るが、どの地物の頂点なのかが画面から読めない」。
  //
  // 観測は __E2E__ の dashedLine (dashPx を持つ line プリミティブ数) — 「線が 1 本増えた」
  // では他の折れ線と区別できず、点線であること自体が要件なので、破線チャンネルを直接数える。
  // 単体テストでは踏めない: 分類 → プリミティブ → レンダラの各層が緑でも、App からの結線
  // (選択オーナー供給・selection watch による再描画) が切れていれば画面は無反応になる。
  test('頂点を選ぶと所有地物が点線で囲まれ、アクティブ化/選択解除で消える', async () => {
    const { app, page } = await launchApp();
    try {
      await expect
        .poll(async () => page.evaluate(() => typeof (window as unknown as {
          __E2E__?: unknown;
        }).__E2E__))
        .toBe('object');

      // 入力層の box は「空白クリック」の座標にも使うので、面ツールを構えてから採る。
      await armAddAreaTool(page);
      const a = await addInputLayerBox(page);
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;
      const corners = squareCorners(cx, cy, DEFAULT_FACE_HALF);
      const faceId = await drawFace(page, corners);

      const activeFeature = page.getByTestId('app-active-feature');

      // 編集モードに入ると選択は破棄され (教訓 5.2)、点線は 0 本。
      await enterEditMode(page);
      await expect(activeFeature).toHaveText('');
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine).toBe(0);

      // (1) アクティブ地物ゼロのまま頂点を直接クリック → 所有地物が点線で囲まれる。
      const [vx, vy] = corners[0]!;
      await page.mouse.click(vx, vy);
      await expect(page.getByTestId('app-active-vertex-owner')).toHaveText(faceId);
      await expect(activeFeature).toHaveText(''); // FR-82 の別状態 (昇格していない)
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine, {
        message:
          'FR-82: 頂点選択コンテキスト地物は点線アウトラインで囲まれなければならない',
      }).toBeGreaterThanOrEqual(1);
      // 頂点ハンドル (86948d7 の挙動) は据え置きで共存する。
      await expect.poll(async () => (await primitiveCounts(page)).handle)
        .toBeGreaterThanOrEqual(4);

      // (2) 同じ地物の本体をクリックしてアクティブ地物にすると、点線は消える。
      //     FR-82 の二つの地物状態は同一地物に重畳しない (合成規則: 選択スタイル優先) —
      //     アクティブ表示のまま点線も出ると「別状態」の区別が読めなくなる。
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine, {
        message: 'アクティブ地物には点線を重ねない (FR-82 の二状態は排他)',
      }).toBe(0);

      // (3) 空白クリックで選択解除 → 点線もハンドルも消える (再描画されること自体の確認)。
      await page.mouse.click(a.x + 8, a.y + 8);
      await expect(activeFeature).toHaveText('');
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine).toBe(0);
      await expect.poll(async () => (await primitiveCounts(page)).handle).toBe(0);

      // (4) 再度頂点を選び直してから View モードへ → 編集モード外では点線も出ない
      //     (このレイヤ全体が編集モードのゲート下にある)。
      await page.mouse.click(vx, vy);
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine)
        .toBeGreaterThanOrEqual(1);
      await page.getByTestId('mode-view').click();
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine, {
        message: '点線アウトラインは編集モードのゲート下にある',
      }).toBe(0);
    } finally {
      await app.close();
    }
  });
});
