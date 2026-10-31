// 増分 5a — 固定行のシェル（設計書 §B.0 / §B.4、実装計画 §5 の「完了の定義」）。
//
// **なぜ E2E なのか**: ここで固定したいのは全部「実際にレイアウトした結果の寸法」である。
// jsdom はレイアウトを計算せず `getBoundingClientRect()` が常に 0 を返すので、単体で
// 書くと中身が何であっても一致して**永久に緑**になる（開発ガイド §5.49）。CSS の宣言
// そのものを読む契約テストは `src/ui/shell/shell-layout.test.ts` が持ち、こちらは実寸を測る。
//
// ここが守るもの（実装計画 §5 の完了の定義から）:
//   1. **窓幅を 1600 → 1280 → 1024 → 800 と変えても、地図セルの上端 y が変わらない。**
//      アプリバーが `auto` だった頃は、窓幅で 54 → 81.2 → 149.2px と段が増え、地図の
//      上端が最大 95px 飛んだ（現状分析 §1.3）。
//   2. **窓幅 800px で、アプリバー・オプションバー・時刻レールのどれも横にあふれない。**
//      畳みは §B.4 の表のとおり **窓幅だけ**で決まる。
//   3. **地図を再マウントしていない**（結合点 #2）。**既定ではないズームと位置へ動かして
//      から**帯の中身・右パネルの幅・窓の大きさを変え、3 つの値が変わらないことを見る。
//      「既定へ戻って偶然同じ値になる」を排除するために、動かした後の値が起動時の値と
//      違うことも同時に確かめる（設計書 §O の GPT 結合点#2）。
//   4. **行の高さが固定**（アプリバー 32 / オプションバー 40 / 状態行 28）。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';

import { openSettingsAndReplace, stubImagePicker, writePng } from './basemap-image-helpers';
import {
  armVertexTool,
  ALL_TOOL_TESTIDS,
  DEFAULT_FACE_HALF,
  MAP_CELL_PARTS,
  clickClearOfStickyBars,
  enterEditMode,
  jumpToYear,
  loadSyntheticNested,
  openPropertySection,
  worldBandIn,
  addInputLayerBox,
  answerDraftDiscardIfAsked,
  armAddAreaTool,
  commitOneFace,
  drawFace,
  launchApp,
  leaveViewMode,
  openDepthOptions,
  openSurveyCoords,
  openVertexCandidatesOnTinySquare,
  placeVertices,
  returnToViewMode,
  squareCorners,
  openPreSaveBoard,
} from './helpers';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function rectOf(page: Page, testId: string): Promise<Rect> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} の矩形が取れない`).not.toBeNull();
  const b = box!;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** カメラの観測値（地図の入力層に載っている 3 つ）。 */
interface Camera {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

/**
 * **この地図が何回目のマウントかの印**（増分 5 の手直し F2 / GPT #15）。
 *
 * 「地図を再マウントしていない」を **カメラの値**で見るのは弱い ―― カメラは外の店に
 * 居るので、**地図セルが作り直されても同じ値を復元できてしまう**（検査は緑のまま、
 * Canvas も入力の途中も一時的な予告も失われる）。`onMapMount` が走るたびに 1 つ増える
 * 印を要素そのものへ書いてあるので、こちらは**作り直しを直接**見る。
 */
async function readMountId(page: Page): Promise<string> {
  const cell = page.getByTestId('map-canvas-mount');
  await expect(cell).toHaveAttribute('data-mount-id', /.+/);
  return (await cell.getAttribute('data-mount-id')) ?? '';
}

async function readCamera(page: Page): Promise<Camera> {
  const layer = page.getByTestId('map-input-layer');
  await expect(layer).toHaveAttribute('data-zoom', /.+/);
  return {
    zoom: Number(await layer.getAttribute('data-zoom')),
    panX: Number(await layer.getAttribute('data-pan-x')),
    panY: Number(await layer.getAttribute('data-pan-y')),
  };
}

/** 要素が自分の器から横にあふれているか（`overflow: hidden` でも scrollWidth は伸びる）。 */
async function overflowsHorizontally(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`要素が無い: ${sel}`);
    return el.scrollWidth - el.clientWidth;
  }, selector);
}

test.describe('増分 5a — 固定行のシェル（地図セルは窓の大きさだけで動く）', () => {
  test('窓幅を 1600 → 1280 → 1024 → 800 と変えても、地図セルの上端 y が変わらない', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-area')).toBeVisible();

      const tops: { width: number; top: number }[] = [];
      for (const width of [1600, 1280, 1024, 800]) {
        await page.setViewportSize({ width, height: 800 });
        // レイアウトが落ち着くのを「同じ値が 2 回続いたら止まった」で待つ
        // （固定の待ち時間は環境で揺れる＝増分 4 の全件ゲートの教訓）。
        let last = -1;
        await expect
          .poll(async () => {
            const now = (await rectOf(page, 'map-area')).y;
            const stable = now === last;
            last = now;
            return stable;
          })
          .toBe(true);
        tops.push({ width, top: (await rectOf(page, 'map-area')).y });
      }

      const first = tops[0]!;
      for (const t of tops) {
        expect(
          t.top,
          `窓幅 ${t.width} で地図の上端が動いた（${first.top} → ${t.top}）`,
        ).toBe(first.top);
      }
      // 「上端 = アプリバー 32 ＋ オプションバー 40」であることも確かめる。
      // **ここは 32 と 40 を直書きしている**（増分 5 の手直し E4 でコメントを実物に
      // 合わせた。旧版は「数字を直書きせず実寸から組み立てる」と書いていたが、下の 3 行は
      // どれも数字そのものを期待値にしていて、書いてあることと逆だった）。直書きなのは
      // わざとで、この 2 つの高さは `shell.css` の `--shell-appbar-h` /
      // `--shell-optionbar-h` が決める **仕様の数字**だからである ―― 実寸から組み立てると
      // 「両方いっしょにずれた」ときに緑のまま通る（開発ガイド §5.49）。
      // 数字を変えるときは css と一緒にここも直す。
      const appBar = await rectOf(page, 'app-shell-identity');
      expect(appBar.height).toBeLessThanOrEqual(32);
      const optionBar = await rectOf(page, 'option-bar');
      expect(optionBar.height).toBe(40);
      expect(first.top).toBe(32 + 40);
    } finally {
      await app.close();
    }
  });

  test('アプリバーの中身がどれだけ増えても、行は 32px のままで地図は動かない', async () => {
    // **これが「固定行」の本体である。** 上の検査（窓幅を変えても上端が動かない）は、
    // 増分 5a で重い部品をアプリバーから降ろしたせいで**中身が少なければ折り返す作りでも
    // 通ってしまう**（実際に `flex-wrap: wrap` へ戻して確かめたら緑のままだった＝
    // 開発ガイド §5.49「必ず一致する対象を測ってしまう」）。そこで **わざと中身を増やして**
    // 測る ―― 折り返す作りなら段が増えて地図が下がり、ここが赤くなる。
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-area')).toBeVisible();
      const before = await rectOf(page, 'map-area');

      // 折り返さない長い中身をアプリバーへ差し込む（利用者には作れないが、
      // 「部品を 1 つ戻した」ときに起きることと同じである）。
      await page.evaluate(() => {
        const bar = document.querySelector('.app-shell__topbar');
        if (bar === null) throw new Error('.app-shell__topbar が無い');
        const probe = document.createElement('div');
        probe.id = 'inc5-appbar-probe';
        probe.textContent = 'ながい中身'.repeat(60);
        probe.style.whiteSpace = 'nowrap';
        probe.style.flex = '0 0 auto';
        bar.appendChild(probe);
      });
      await page.waitForTimeout(200);

      expect(await rectOf(page, 'map-area'), 'アプリバーの中身が増えて地図が動いた').toEqual(
        before,
      );

      // 実際に配られている CSS（ソースの文字列ではなく、エンジンが解決した値）でも
      // 固定されていることを見る。
      const style = await page.evaluate(() => {
        const el = document.querySelector('.app-shell__menubar');
        if (el === null) throw new Error('.app-shell__menubar が無い');
        const cs = getComputedStyle(el);
        return { height: cs.height, flexWrap: cs.flexWrap, overflow: cs.overflowX };
      });
      expect(style.height).toBe('32px');
      expect(style.flexWrap).toBe('nowrap');
      expect(style.overflow).toBe('hidden');

      await page.evaluate(() => {
        document.getElementById('inc5-appbar-probe')?.remove();
      });
    } finally {
      await app.close();
    }
  });

  test('窓幅 800px で、アプリバー・オプションバー・時刻レールが横にあふれない', async () => {
    const { app, page } = await launchApp();
    try {
      await page.setViewportSize({ width: 800, height: 600 });
      await expect(page.getByTestId('map-area')).toBeVisible();
      await page.waitForTimeout(200);

      for (const selector of [
        '.app-shell__menubar',
        '.option-bar',
        '.app-shell__timeline',
        '.statusbar',
      ]) {
        const over = await overflowsHorizontally(page, selector);
        expect(over, `${selector} が横に ${over}px あふれている`).toBeLessThanOrEqual(1);
      }

      // 畳んでも「いまの中心経度が読めて ◀▶ で動かせる」ことは残す（届かなくなる操作を
      // 作らない）。畳んで消えるのはつまみ・プリセット・直接入力だけである。
      await expect(page.getByTestId('center-lon-readout')).toBeVisible();
      await expect(page.getByRole('button', { name: '右へシフト' })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('帯の中身・右パネルの幅・窓の大きさを変えても、地図は再マウントされない（結合点 #2）', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-area')).toBeVisible();
      const initial = await readCamera(page);
      // **印を先に控える。** カメラの値だけでは「作り直して同じ値を復元した」を
      // 見分けられないので、要素の同一性そのものを見る（手直し F2）。
      const mountId = await readMountId(page);
      expect(mountId, '地図のマウントの印が空').not.toBe('');

      // ---- ① 既定ではないズームと位置へ動かす。
      const map = await rectOf(page, 'map-area');
      const cx = map.x + map.width / 2;
      const cy = map.y + map.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -480); // ズームイン
      await expect
        .poll(async () => (await readCamera(page)).zoom)
        .toBeGreaterThan(initial.zoom);
      // 中ボタンでパン（既定の中心から確実に離す）。
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(cx - 160, cy - 60, { steps: 8 });
      await page.mouse.up({ button: 'middle' });
      await expect
        .poll(async () => (await readCamera(page)).panX)
        .not.toBe(initial.panX);

      const moved = await readCamera(page);
      // **「既定へ戻って偶然同じ値になる」を排除する**（設計書 §O の GPT 結合点#2）。
      expect(moved.zoom).not.toBe(initial.zoom);
      expect(moved.panX).not.toBe(initial.panX);

      // ---- ② 帯の中身を変える（測量 ON → 読み取りが載る、深さ ▾ を開く）。
      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-readout')).toBeVisible();
      expect(await readCamera(page), '測量の帯で地図が作り直された').toEqual(moved);
      expect(await readMountId(page), '測量の帯で地図が作り直された（印）').toBe(mountId);
      await page.getByTestId('survey-toggle').click();
      await openDepthOptions(page);
      expect(await readCamera(page), '深さ ▾ で地図が作り直された').toEqual(moved);
      expect(await readMountId(page), '深さ ▾ で地図が作り直された（印）').toBe(mountId);
      await page.keyboard.press('Escape');

      // ---- ③ 右パネルの中身（タブの切替）を変える。
      await page.getByTestId('sidebar-tab-properties').click();
      expect(await readCamera(page), '右パネルの切替で地図が作り直された').toEqual(moved);
      expect(await readMountId(page), '右パネルの切替で地図が作り直された（印）').toBe(mountId);

      // ---- ④ 窓の大きさを変える。**カメラは保つ**（大きさが変わってもマウントは同じ）。
      await page.setViewportSize({ width: 1024, height: 700 });
      await page.waitForTimeout(300);
      const afterResize = await readCamera(page);
      expect(afterResize.zoom, '窓を変えたらズームが既定へ戻った').toBe(moved.zoom);
      expect(afterResize.panX, '窓を変えたら位置が既定へ戻った').toBe(moved.panX);
      expect(afterResize.panY, '窓を変えたら位置が既定へ戻った').toBe(moved.panY);
      expect(await readMountId(page), '窓を変えたら地図が作り直された（印）').toBe(mountId);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 増分 5b — 鍵と道具の 1 段（裁定 1 / 裁定 N-4）
// ---------------------------------------------------------------------------

test.describe('増分 5b — 鍵と道具の 1 段', () => {
  test('道具を押すだけで面が描ける（「追加モードに入る」の 1 手が要らない）', async () => {
    const { app, page } = await launchApp();
    try {
      // 起動直後は「読むだけ」。鍵を 1 回開けたら、あとは道具を押すだけで描ける。
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');

      await page.getByTestId('tool-add.area').click();
      // 内部の mode は道具から導出される（設計書 §D.1）。
      await expect(page.getByTestId('app-mode')).toHaveText('add');
      await expect(page.getByTestId('add-input-layer')).toBeVisible();

      // 直す道具へ持ち替えると edit へ戻る（画面にモードの段は無いまま）。
      await page.getByTestId('tool-edit.knife').click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');

      // 「選択」へ戻すと素の状態（内部の mode は edit）。
      await page.getByTestId('tool-edit.select').click();
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.select');
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      await expect(page.getByTestId('tool-edit.select')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      await app.close();
    }
  });

  test('鍵を閉じると app-mode が view になり、道具が 1 つ残らず押せなくなる（K-6）', async () => {
    const { app, page } = await launchApp();
    try {
      await leaveViewMode(page);
      const tools = page.locator('[data-testid="toolbar-tools"] button[data-tool]');
      const count = await tools.count();
      // 1 段に並んでいる道具の数（群の合計）。0 だと以下の検査が空回りする。
      expect(count).toBeGreaterThanOrEqual(11);
      for (let i = 0; i < count; i += 1) await expect(tools.nth(i)).toBeEnabled();

      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      for (let i = 0; i < count; i += 1) await expect(tools.nth(i)).toBeDisabled();
      // 測る（測量）は編集ではないので、読むだけでも押せる（U37 §2.1）。
      await expect(page.getByTestId('survey-toggle')).toBeEnabled();
    } finally {
      await app.close();
    }
  });

  test('読むだけでも地図クリックで選べて、Escape で外せる（裁定 N-4(A)）', async () => {
    // **HB5-4 を覆した裁定である。** 読むだけでも「選べる・読める・直せない」。
    // 選ぶ手だけあって外す手が無いと行き止まりになるので、Escape も一緒に通す。
    const { app, page } = await launchApp();
    try {
      const { cx, cy, faceId } = await commitOneFace(page);
      expect(faceId).not.toBe('');

      // 鍵を閉じる。**選択は保つ**（増分 4 の手直し B12）。
      await returnToViewMode(page);
      await expect(page.getByTestId('app-mode')).toHaveText('view');

      // 読むだけで Escape → 選択が外れる（旧版はここで止まっていた）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      // 読むだけで地図をクリック → また選べる。
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      // **直せはしない**: 削除の打鍵は通らない（K-6 は選択解除だけを覆した）。
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      // 左ドラッグはパンのまま（読むだけの主要な操作を奪っていない）。
      const layer = page.getByTestId('map-input-layer');
      const beforeX = Number(await layer.getAttribute('data-pan-x'));
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 120, cy, { steps: 6 });
      await page.mouse.up();
      await expect
        .poll(async () => Number(await layer.getAttribute('data-pan-x')))
        .not.toBe(beforeX);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 増分 5c — 選択を捨てない・鍵盤の持ち主・Esc の階段
// ---------------------------------------------------------------------------

test.describe('増分 5c — 選択を捨てない・鍵盤の持ち主・Esc の階段', () => {
  test('道具を持ち替えても選択が空にならない（docs/現状.md B28 の解消）', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId } = await commitOneFace(page);
      expect(faceId).not.toBe('');
      const active = page.getByTestId('app-active-feature');
      await expect(active).toHaveText(faceId);

      // **1 つずつ全部の道具を持ち替える。** 旧版はどの持ち替えでも選択が消えていた
      // （実測 2.65 秒／回の手戻り）。1 つでも消えればここで落ちる。
      //
      // **顔ぶれは実装（`ALL_TOOLS`）から引く**（増分 5 の手直し F3）。手で並べていた
      // ころは編集の 7 個しか回しておらず、**面／線／点へ持ち替える経路（＝内部の
      // `mode` が追加へ移る経路）が 1 つも入っていなかった**。裁定は「道具を持ち替えて
      // も選択を捨てない」であって、編集の道具どうしに限った話ではない。
      // 最後にもう一度「選択」へ戻して、素の状態でも残っていることを見る。
      for (const tool of [...ALL_TOOL_TESTIDS, 'tool-edit.select']) {
        await page.getByTestId(tool).click();
        await expect(active, `${tool} を構えたら選択が消えた`).toHaveText(faceId);
        // **ここで Escape を挟んではいけない。** 道具のボタンはレール（地図の外）に
        // あるので板に邪魔されないし、Escape は階段の 1 段目として **選択を外す**
        // （設計書 §D.4）―― 挟むと「持ち替えで消えた」と「Esc で外れた」の区別が
        // つかなくなる。
      }
    } finally {
      await app.close();
    }
  });

  test('Esc は 1 段ずつ戻り、連打すれば必ず素の状態になる（設計書 §D.4）', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitOneFace(page);
      const active = page.getByTestId('app-active-feature');
      const activeTool = page.getByTestId('app-active-tool');

      // 頂点の道具で、地物を選んだうえで頂点を 1 つ掴む。
      await page.getByTestId('tool-edit.vertex').click();
      await expect(activeTool).toHaveText('edit.vertex');
      await page.mouse.click(cx, cy); // 地物を選び直す（すでに選ばれている）
      await expect(active).toHaveText(faceId);

      // 1 段目: 地物の選択が外れる（頂点を掴んでいなければここが先頭の段）。
      await page.keyboard.press('Escape');
      await expect(active).toHaveText('');
      // 2 段目: 道具が「選択」へ戻る（＝ 何も構えていない状態）。
      await page.keyboard.press('Escape');
      await expect(activeTool).toHaveText('');
      await expect(page.getByTestId('tool-edit.select')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // 3 回目以降は何も起きない（素の状態で止まる）。
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(active).toHaveText('');
      await expect(activeTool).toHaveText('');
    } finally {
      await app.close();
    }
  });

  test('所属変更を確定した直後の Ctrl+Z が効く（道具を外さずに）', async () => {
    // **報告 04 §3.5 の再現**: 所属変更を確定した直後（775→776 件）の Ctrl+Z が
    // 無反応だった。原因は「道具を構えている」だけで大域の打鍵が全部降りていたこと
    // （11 項目の手書き OR）。増分 5c で鍵盤の持ち主を 1 値に畳み、**下書きが空なら
    // 持ち主は地図に戻る**ようにしたので、確定直後の Ctrl+Z は必ず効く（設計書 §D.4）。
    //
    // わざと壊すなら: `shortcutsSuspended` を `toolOwnsKeyboard` を含む OR へ戻すと、
    // ここが「やり直せる印が立たない」で赤くなる。
    const { app, page } = await launchApp();
    try {
      const box = await (async () => {
        await armAddAreaTool(page);
        return addInputLayerBox(page);
      })();
      // **世界の帯から解く**（増分 6 で地図が縦に 89.2px 伸び、セルの上下に「世界の外」が
      // できた ―― 固定の割合でセルを割ると、上の四角が北緯 90 度より上へ出て置けない）。
      const band = worldBandIn(box);
      const bandW = band.right - band.left;
      const bandH = band.bottom - band.top;
      const half = Math.round(Math.min(bandW, bandH) * 0.12);
      // **3 つとも重ならない場所に置く。** 重ねると所属変更の確定が重なり競合の板を
      // 開き、そこで鍵盤の持ち主が「板」になる ―― この検査が見たいのは
      // 「確定して板も出ていないのに Ctrl+Z が効かない」ことなので、板を出さない
      // 場面で測る（板が出ているあいだ止まるのは設計どおりで、別の検査の担当）。
      const left = { x: band.left + bandW * 0.22, y: band.top + bandH * 0.62 };
      const right = { x: band.left + bandW * 0.78, y: band.top + bandH * 0.62 };
      const top = { x: band.left + bandW * 0.5, y: band.top + bandH * 0.22 };

      await drawFace(page, squareCorners(left.x, left.y, half), { name: 'A' });
      await armAddAreaTool(page);
      await drawFace(page, squareCorners(right.x, right.y, half), { name: 'B' });
      await armAddAreaTool(page);
      await drawFace(page, squareCorners(top.x, top.y, half), { name: 'C' });

      // 所属変更: C を掴んで、新しい親に B を指す。
      await page.getByTestId('tool-edit.reparent').click();
      await expect(page.getByTestId('reparent-input-layer')).toBeVisible();
      await page.mouse.click(top.x, top.y); // 対象 = C
      await expect(page.getByTestId('reparent-target')).not.toHaveText('');
      await page.mouse.click(right.x, right.y); // 新しい親 = B
      const confirm = page.getByTestId('reparent-confirm');
      await expect(confirm).toBeEnabled();
      await confirm.click();
      // **増分 7**: ［所属を変える］は 3 択の板を開く。地図で拾った親（B）が
      // 「既存から選ぶ」枝の初期値になっているので、そのまま確定できる。
      await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(page.getByTestId('reparent-options-dialog')).toHaveCount(0);

      // **道具は外さない。** ここで Ctrl+Z を押す。
      // 確定したら鍵盤の持ち主は地図へ戻っていること（原因を直接指す観測）。
      await expect(page.getByTestId('app-focus-owner')).toHaveText('map');
      await expect(page.getByTestId('app-can-undo')).toHaveText('1');
      await expect(page.getByTestId('app-can-redo')).toHaveText('0');
      await page.keyboard.press('Control+z');
      // 取り消しが本当に走ったことは「やり直せる」が立つことで見る（件数より確か）。
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 増分 5d — 確定バーの移設と、地図に重なる部品の台帳（K-2）
// ---------------------------------------------------------------------------

/**
 * 地図セルを 5×5 の格子で走査して、その点で入力を受ける要素の名前を返す（K-2 の機械検査）。
 *
 * **「覆っていない領域で入力層が返る」だけでは足りない**（設計書 §B.5 のテストの形）。
 * 閉じたパネルが画面の左上に居座って下のクリックを奪う事故（教訓 5.56）は
 * **閉じた状態でしか捕まらない**し、開いた状態でどこが覆われているかは開いた状態でしか
 * 分からない。だから **出ている状態と出ていない状態の両方**を走査する。
 */
async function scanMapGrid(page: Page): Promise<string[]> {
  const b = (await page.getByTestId('map-input-layer').boundingBox())!;
  const out: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      const x = b.x + (b.width * (i + 0.5)) / 5;
      const y = b.y + (b.height * (j + 0.5)) / 5;
      out.push(
        await page.evaluate(
          ({ px, py }) => {
            const el = document.elementFromPoint(px, py);
            if (el === null) return 'null';
            // **`alertdialog` も板として数える**（増分 5 の手直し。所属変更の最上位化の
            // 確認・追加の「捨てますか」がこれ）。`dialog` だけを見ていたころは、
            // 板の中を指した点が中の要素の testid として返り、走査の期待値が
            // 「板が出ているのに地図に届いた」と読めてしまった。
            const panel = el.closest('[role="dialog"], [role="alertdialog"]');
            if (panel !== null) return `popover:${panel.getAttribute('data-testid') ?? '?'}`;
            return el.getAttribute('data-testid') ?? el.className.toString();
          },
          { px: x, py: y },
        ),
      );
    }
  }
  return out;
}

/**
 * 走査の結果が「地図へ届いている」と言えるか（増分 6 で足した）。
 *
 * **台帳（設計書 §B.5）に載っている常設の部品は押せてよい** ―― 増分 6 で置いた
 * ズーム・全体表示・縮尺バーがそれで、窓が小さいと地図の隅の点に当たる。K-2 が禁じて
 * いるのは「地図の押下を奪う覆い」なので、次の 3 つで見る（2026-09-07 の手直しで
 * 「25 点中 21 点届けばよい」という **数の余裕をやめた**＝教訓 5.83）:
 *   ①どの点も **入力層か、開いている板か、台帳の常設部品**のどれかへ届く
 *   ②**常設の部品が覆う点は名指しで言い当てる**（`covered`。省略＝1 点も覆わない）
 *   ③板が開いている場面でも **入力層へ届く点が 1 つ以上残る**（画面を丸ごと飲み込まない）
 *
 * **顔ぶれは `MAP_CELL_PARTS`（helpers）から引く** ―― 決め打ちで書くと、台帳に足した
 * 部品が検査に入らないまま増える（K-2 の 3 回目がその形だった）。
 */
function expectMapReachable(
  hits: readonly string[],
  options: {
    readonly primary?: string;
    readonly extra?: readonly string[];
    /**
     * **常設の部品**（台帳 #10・#11）のうち、その場面で実際に点を覆うものの顔ぶれ。
     * 省略＝**1 点も覆われない**。
     *
     * `extra` に挙げた板は「いま開いている」ものなので、何点覆っても構わない（覆うのが
     * 仕事である）。数えるのは **常設の部品**のほうで、こちらに数の余裕を置くと、
     * 地図の隅を覆う部品が黙って増えても緑のままになる（教訓 5.83）。
     */
    readonly covered?: readonly string[];
  } = {},
): void {
  const primary = options.primary ?? 'map-input-layer';
  const extra = options.extra ?? [];
  const allowed = new Set([primary, ...MAP_CELL_PARTS, ...extra]);
  for (const hit of hits) {
    expect(allowed.has(hit), `地図の点が ${hit} に奪われた`).toBe(true);
  }
  // **覆っている顔ぶれを言い当てる**（2026-09-07 の手直し）。旧版は「25 点のうち
  // 21 点が届けばよい」という **4 点ぶんの余裕**を持たせていたので、地図の隅を覆う
  // 部品が 4 つまで黙って増えても緑のままだった（実際には 1 点も覆っていない）。
  // 板が出ている場面でも数えるのをやめない ―― 覆ってよいのは **その板だけ** である。
  const covered = hits.filter((h) => h !== primary);
  // **開いている板は何点覆ってもよい。常設の部品は名指しで数える。**
  const permanent = covered.filter((h) => !extra.includes(h));
  expect(
    [...new Set(permanent)].sort(),
    `常設の部品が覆った先: ${permanent.join(' / ') || '（なし）'}`,
  ).toEqual([...new Set(options.covered ?? [])].sort());
  // 何かが覆っていても **地図はどこかしら生きている**（画面を丸ごと飲み込まない）。
  if (covered.length > 0 && extra.length > 0) {
    expect(hits.filter((h) => h === primary).length).toBeGreaterThan(0);
  }
}

test.describe('増分 5d — 確定の列はオプションバーへ（地図に押せる部品を置かない）', () => {
  test('手順のある道具の確定・やめる・1 つ戻すが、すべてオプションバーに出る（U-10 / E-2）', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      const optionBar = page.getByTestId('option-bar');
      const commitSlot = page.getByTestId('option-bar-commit');

      // ナイフ: 対象を選んで分断線を引く局面で、確定の列が帯の中にある。
      await page.getByTestId('tool-edit.knife').click();
      await page.mouse.click(cx, cy); // 対象を掴む
      await expect(page.getByTestId('knife-confirm-cut')).toBeVisible();
      // **地図の上ではなく帯の中に居る**（これが N-27 / E-2 の中身）。
      await expect(commitSlot).toContainText('分断線を確定');
      await expect(optionBar).toContainText('1 つ戻す');
      await expect(page.getByTestId('map-area')).not.toContainText('分断線を確定');
      await page.keyboard.press('Escape');

      // 所属変更・結合・輪郭・穴あけも同じ場所（U-10: どの道具でも確定は同じ場所）。
      for (const [tool, testId] of [
        ['tool-edit.reparent', 'reparent-confirm'],
        ['tool-edit.merge', 'merge-confirm'],
        ['tool-edit.ring', 'ring-edit-confirm'],
        ['tool-edit.drill', 'drill-confirm'],
      ] as const) {
        await page.getByTestId(tool).click();
        const button = page.getByTestId(testId);
        await expect(button, `${tool} の確定が帯に出ていない`).toBeVisible();
        await expect(
          commitSlot.getByTestId(testId),
          `${tool} の確定が確定欄の中に無い`,
        ).toHaveCount(1);
        await page.keyboard.press('Escape');
      }
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // K-2 の走査は **設計書 §B.5 の台帳を上から回す**（増分 5 の手直し F1）。
  //
  // **なぜ表にするか**: 旧版は道具 4 つとポップオーバー 2 枚を **手で並べて**いた。
  // 台帳へ部品を足しても検査に入らないまま増えるので、**K-2 の 3 回目の事故がまさに
  // その形**だった（設計書 §B.5 の「テストの形」）。台帳と同じ並びの表にしておけば、
  // 部品を足したときにここへ 1 行足すのが手続きになる。
  // -------------------------------------------------------------------------

  /** 台帳 #1 の入力ブリッジ 7 枚（道具ごと）。`arm` はその道具を構える手順。 */
  const INPUT_BRIDGES: readonly {
    readonly ledger: string;
    readonly layer: string;
    readonly arm: (page: Page) => Promise<void>;
  }[] = [
    { ledger: '#1 面', layer: 'add-input-layer', arm: (p) => p.getByTestId('tool-add.area').click() },
    { ledger: '#1 線', layer: 'add-input-layer', arm: (p) => p.getByTestId('tool-add.line').click() },
    { ledger: '#1 点', layer: 'add-input-layer', arm: (p) => p.getByTestId('tool-add.point').click() },
    { ledger: '#1 分ける', layer: 'knife-input-layer', arm: (p) => p.getByTestId('tool-edit.knife').click() },
    { ledger: '#1 結ぶ', layer: 'merge-input-layer', arm: (p) => p.getByTestId('tool-edit.merge').click() },
    { ledger: '#1 所属', layer: 'reparent-input-layer', arm: (p) => p.getByTestId('tool-edit.reparent').click() },
    { ledger: '#1 輪郭', layer: 'ring-edit-input-layer', arm: (p) => p.getByTestId('tool-edit.ring').click() },
    { ledger: '#1 穴あけ', layer: 'drill-input-layer', arm: (p) => p.getByTestId('tool-edit.drill').click() },
    { ledger: '#1 測る', layer: 'survey-input-layer', arm: (p) => p.getByTestId('survey-toggle').click() },
  ];

  test('K-2: 台帳 #1 の入力ブリッジは、どれを構えても地図の 25 点をそのブリッジ 1 枚が受ける', async () => {
    // **確定の列を帯へ移したので、地図の上に押せる部品は道具の入力ブリッジ 1 枚だけ**に
    // なった ―― それがこの増分の中身である。台帳の 9 通り（道具 8 ＋ 測る）を全部回す。
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-area')).toBeVisible();
      // ①道具なし: 25 点すべてが地図の入力層。
      expectMapReachable(await scanMapGrid(page));

      await leaveViewMode(page);
      for (const bridge of INPUT_BRIDGES) {
        await bridge.arm(page);
        await expect(page.getByTestId(bridge.layer)).toBeVisible();
        const hits = new Set(await scanMapGrid(page));
        expect(hits, `${bridge.ledger} を構えたら地図の当たりが奪われた`).toEqual(
          new Set([bridge.layer]),
        );
        // 測るは Escape では降りないので、入口をもう一度押して戻す。
        if (bridge.layer === 'survey-input-layer') {
          await page.getByTestId('survey-toggle').click();
        } else {
          await page.keyboard.press('Escape');
        }
      }

      // ③「選択」へ戻したら、また 25 点すべてが地図の入力層へ戻る（一時部品が居座らない）。
      await page.getByTestId('tool-edit.select').click();
      expectMapReachable(await scanMapGrid(page));
    } finally {
      await app.close();
    }
  });

  test('K-2: 台帳のポップオーバー 4 枚は、開いていても閉じていても地図の当たりを奪わない', async () => {
    // 教訓 5.56（`[hidden]` はクラスの `display` に負ける）を **台帳の 4 枚全部**に掛ける。
    // 閉じた状態でしか捕まらない事故なので、開閉の両方を走査する。旧版は 2 枚だけだった。
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-area')).toBeVisible();
      expectMapReachable(await scanMapGrid(page));

      // 台帳 #14 深さ ▾（読むだけでも出ている常設の設定）。
      await openDepthOptions(page);
      expectMapReachable(await scanMapGrid(page), {
        extra: ['popover:option-depth-panel'],
      });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('option-depth-panel')).toBeHidden();
      expectMapReachable(await scanMapGrid(page));

      // 台帳 #15 表示 ▾。
      await page.getByTestId('option-display-button').click();
      await expect(page.getByTestId('option-display-panel')).toBeVisible();
      expectMapReachable(await scanMapGrid(page), {
        extra: ['popover:option-display-panel'],
      });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('option-display-panel')).toBeHidden();
      expectMapReachable(await scanMapGrid(page));

      // 台帳 #5 吸着 ▾（追加の道具を構えてから出る。地図は追加の入力ブリッジが受ける）。
      await leaveViewMode(page);
      await page.getByTestId('tool-add.area').click();
      await page.getByTestId('option-snap-button').click();
      await expect(page.getByTestId('option-snap-panel')).toBeVisible();
      expectMapReachable(await scanMapGrid(page), {
        primary: 'add-input-layer',
        extra: ['popover:option-snap-panel'],
      });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('option-snap-panel')).toBeHidden();
      expectMapReachable(await scanMapGrid(page), { primary: 'add-input-layer' });
      await page.keyboard.press('Escape');

      // 台帳 #16 座標 ▾（測量を始めてから出る）。
      await page.getByTestId('survey-toggle').click();
      await openSurveyCoords(page);
      expectMapReachable(await scanMapGrid(page), {
        primary: 'survey-input-layer',
        extra: ['popover:survey-coords-panel'],
      });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('survey-coords-panel')).toBeHidden();
      expectMapReachable(await scanMapGrid(page), { primary: 'survey-input-layer' });
    } finally {
      await app.close();
    }
  });

  test('K-2: 台帳 #8 の「捨てますか」の板は本物のモーダルで、答えるまで背後へ抜けない', async () => {
    // 一時の板は **出している状態でも走査する**（設計書 §B.5 の「テストの形」）。
    //
    // **2 回目の手直しで意味が変わった。** 旧版は板が層を持たない普通の子だったので、
    // 板の外は地図へ抜けた ―― ところが同じ覆いに居る道具の入力ブリッジ（`z-index: 1`）が
    // **板の上に乗って**、［続ける］がマウスで押せなかった。いまは背面を覆う板を持つ
    // 本物のモーダルなので、**板が出ているあいだは地図の 25 点すべてがモーダルに当たる**
    // のが正しい姿である。答えたら 25 点すべてが地図へ戻る（居座らない）ことを見る。
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const box = await addInputLayerBox(page);
      // 確定できる点数（面は 3 点）まで **打つだけ**（確定はしない）。そのうえで道具を
      // 持ち替えると、増分 5 の手直し A3 の確認の板が出る。
      await placeVertices(
        page,
        squareCorners(box.x + box.width / 2, box.y + box.height / 2, 60),
      );
      await page.getByTestId('tool-edit.select').click();
      await expect(page.getByTestId('add-draft-discard-confirm')).toBeVisible();

      for (const hit of await scanMapGrid(page)) {
        expect(
          ['add-draft-discard-confirm-backdrop', 'popover:add-draft-discard-confirm'],
          `板が出ているのに ${hit} へ抜けた`,
        ).toContain(hit);
      }
      // 板を閉じれば 25 点すべてが地図へ戻る（居座らない）。
      await page.getByTestId('add-draft-discard-yes').click();
      await expect(page.getByTestId('add-draft-discard-confirm')).toHaveCount(0);
      expectMapReachable(await scanMapGrid(page));
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 台帳 #20〜#27 と #30 の板（増分 7 で足した 6 枚＋増分 7 の手直しの 2 枚。Fable #9。#27 は本体の
  // 取り込みで、#30 は増分 8E の手直しで足した）。
  // どれも **本物のモーダル**（背面を覆う板＋`role="alertdialog"` / `"dialog"`）なので、
  // 出ているあいだは地図の 25 点すべてが板に当たり、閉じたら板の名前が 1 点も残らない
  // （居座らない）ことを見る。表は設計書 §B.5 の台帳と同じ並び。
  // -------------------------------------------------------------------------
  const IMPACT_BOARDS: readonly {
    readonly ledger: string;
    /** 背面の覆いの testid。 */
    readonly backdrop: string;
    /** 板の本体（`role="dialog"` / `"alertdialog"`）の testid。 */
    readonly dialog: string;
    /**
     * 出たことを確かめる要素（省略時は `dialog`）。`role="dialog"` の根が大きさを持たない器
     * （ファイル操作の板。中身は `DraggablePanel`）では、中身の testid で見る。
     */
    readonly shown?: string;
    /** 板を開く。`app` は main 側の差し替えが要る板（#30 の画像選択）だけが使う。 */
    readonly open: (page: Page, app: ElectronApplication) => Promise<void>;
    readonly close: (page: Page) => Promise<void>;
  }[] = [
    {
      ledger: '#20 所属変更の 3 択',
      backdrop: 'reparent-options-backdrop',
      dialog: 'reparent-options-dialog',
      open: async (page) => {
        const { cx, cy } = await commitOneFace(page);
        await enterEditMode(page);
        await page.getByTestId('tool-edit.reparent').click();
        await page.mouse.click(cx, cy);
        await page.getByTestId('reparent-confirm-none').click();
      },
      close: (page) => page.getByTestId('reparent-options-cancel').click(),
    },
    {
      ledger: '#21 地物の削除の影響',
      backdrop: 'delete-impact-backdrop',
      dialog: 'delete-impact',
      open: async (page) => {
        const { faceId } = await commitOneFace(page);
        await enterEditMode(page);
        await page.getByTestId('sidebar-tab-list').click();
        await page.getByTestId(`feature-list-item-${faceId}`).click({ button: 'right' });
        await page.locator('[data-item-kind="delete"]').click();
      },
      close: (page) => page.getByTestId('delete-impact-cancel').click(),
    },
    {
      ledger: '#22 錨の削除の影響',
      backdrop: 'anchor-delete-impact-backdrop',
      dialog: 'anchor-delete-impact',
      open: async (page) => {
        await loadSyntheticNested(page, 2, [1000, 1200]);
        await enterEditMode(page);
        await jumpToYear(page, 1200);
        await page.getByTestId('sidebar-tab-list').click();
        await page.getByTestId('unified-list-filter').fill('合成の連邦');
        await page.getByTestId('feature-list-item-syn-nest-parent').click();
        await page.getByTestId('sidebar-tab-properties').click();
        await openPropertySection(page, 'anchor-section');
        await clickClearOfStickyBars(page.getByTestId('anchor-interval-summary-syn-nest-a-1200'));
        await clickClearOfStickyBars(page.getByTestId('anchor-interval-delete-syn-nest-a-1200'));
      },
      close: (page) => page.getByTestId('anchor-delete-impact-cancel').click(),
    },
    {
      ledger: '#23 輪郭の削除の影響',
      backdrop: 'ring-delete-impact-backdrop',
      dialog: 'ring-delete-impact',
      open: async (page) => {
        const { cx, cy } = await commitOneFace(page);
        await enterEditMode(page);
        await page.getByTestId('tool-edit.ring').click();
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
      close: (page) => page.getByTestId('ring-delete-impact-cancel').click(),
    },
    {
      ledger: '#24 頂点の削除の影響',
      backdrop: 'vertex-delete-impact-backdrop',
      dialog: 'vertex-delete-impact',
      open: async (page) => {
        const { corners } = await commitOneFace(page);
        await armVertexTool(page);
        const [vx, vy] = corners[0]!;
        await page.mouse.click(vx, vy, { button: 'right' });
        await page.locator('[data-item-kind="deleteVertex"]').click();
      },
      close: (page) => page.getByTestId('vertex-delete-impact-cancel').click(),
    },
    {
      ledger: '#25 まとめて種別を付ける',
      backdrop: 'bulk-kind-backdrop',
      dialog: 'bulk-kind-dialog',
      open: async (page) => {
        const { faceId } = await commitOneFace(page);
        await enterEditMode(page);
        await page.getByTestId('sidebar-tab-list').click();
        await page.getByTestId(`ledger-mark-${faceId}`).check();
        await page.getByTestId(`feature-list-item-${faceId}`).click({ button: 'right' });
        await page.locator('[data-item-kind="bulkKindLabel"]').click();
      },
      close: (page) => page.getByTestId('bulk-kind-cancel').click(),
    },
    {
      ledger: '#26 まとめ役を終わらせる前の影響',
      backdrop: 'end-here-impact-backdrop',
      dialog: 'end-here-impact',
      open: async (page) => {
        await loadSyntheticNested(page, 2, [1000]);
        await enterEditMode(page);
        await jumpToYear(page, 1500);
        await page.getByTestId('sidebar-tab-list').click();
        await page.getByTestId('unified-list-filter').fill('合成の連邦');
        await page.getByTestId('feature-list-item-syn-nest-parent').click();
        await page.getByTestId('sidebar-tab-properties').click();
        await page.getByTestId('end-here').click();
      },
      close: (page) => page.getByTestId('end-here-impact-cancel').click(),
    },
    // 本体の取り込みで足した: 保存の前の確認の板（#27。増分 7 の手直し 2 回目）。ファイル操作の板
    // なので背面の覆いは `file-ops-backdrop`、`role="dialog"` は根の `pre-save-modal-root` が持つ。
    {
      ledger: '#27 保存の前の確認',
      backdrop: 'file-ops-backdrop',
      dialog: 'pre-save-modal-root',
      shown: 'pre-save-dialog',
      open: (page) => openPreSaveBoard(page),
      close: (page) => page.getByTestId('pre-save-cancel').click(),
    },
    // 増分 8E の手直し（設計適合 S2-2）: 縦横比の板（#30）。設定の板の上に出る板なので、
    // 走査では背面の覆いが地図の 25 点すべてを受けることを見る。閉じるときは設定の板も閉じる。
    {
      ledger: '#30 背景地図の縦横比',
      backdrop: 'basemap-aspect-backdrop',
      dialog: 'basemap-aspect-dialog',
      open: async (page, app) => {
        const dir = mkdtempSync(join(tmpdir(), 'tmap-e2e-k2-aspect-'));
        await stubImagePicker(app, await writePng(page, dir, 300, 200));
        await openSettingsAndReplace(page);
      },
      close: async (page) => {
        await page.getByTestId('basemap-aspect-cancel').click();
        await page.getByTestId('settings-cancel').click();
        await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
      },
    },
  ];

  for (const board of IMPACT_BOARDS) {
    test(`K-2: 台帳 ${board.ledger} の板は本物のモーダルで、閉じたら居座らない`, async () => {
      const { app, page } = await launchApp();
      try {
        await board.open(page, app);
        await expect(page.getByTestId(board.shown ?? board.dialog)).toBeVisible();
        for (const hit of await scanMapGrid(page)) {
          expect(
            [board.backdrop, `popover:${board.dialog}`],
            `板が出ているのに ${hit} へ抜けた`,
          ).toContain(hit);
        }
        await board.close(page);
        await expect(page.getByTestId(board.dialog)).toHaveCount(0);
        for (const hit of await scanMapGrid(page)) {
          expect([board.backdrop, `popover:${board.dialog}`], `閉じた板が ${hit} に居座った`).not.toContain(
            hit,
          );
        }
      } finally {
        await app.close();
      }
    });
  }

  test('K-2: 台帳 #12 の頂点の候補一覧は、出ていても地図の他所の押下が入力層に届き、閉じたら居座らない', async () => {
    // 増分 8A。候補一覧は **一時の吹き出し**（板ではない）なので、出ているあいだも覆って
    // よいのは一覧の矩形だけで、残りの点は地図の入力層へ届かなければならない。
    const { app, page } = await launchApp();
    try {
      const at = await openVertexCandidatesOnTinySquare(page);
      const hits = await scanMapGrid(page);
      expectMapReachable(hits, { extra: ['popover:vertex-candidates'] });
      // 一覧の外の地図の点を **実際に押す**と、一覧は消える（地図の他所のクリック）。
      const b = (await page.getByTestId('map-input-layer').boundingBox())!;
      const elsewhere = { x: b.x + b.width * 0.1, y: b.y + b.height * 0.9 };
      expect(Math.hypot(elsewhere.x - at.x, elsewhere.y - at.y)).toBeGreaterThan(100);
      await page.mouse.click(elsewhere.x, elsewhere.y);
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      expectMapReachable(await scanMapGrid(page));
      // もう一度出して、Escape でも消える。
      await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId('vertex-candidates')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      expectMapReachable(await scanMapGrid(page));
    } finally {
      await app.close();
    }
  });

  test('K-2: 初回起動のガイドが出ていても、地図の 25 点はすべて地図へ届く', async () => {
    // **ガイドを畳まずに走査する**（2026-09-07 の手直し）。旧版のガイドは右パネルから
    // 地図セルへ 52px はみ出していて、**5 つの窓の大きさすべてで**地図の中のズーム
    // 3 ボタンを覆っていた。ガイドは地図の外に置くものなので、出ていても走査は
    // 「1 点も覆われない」で通らなければならない。
    const { app, page } = await launchApp({ keepFirstRunGuide: true });
    try {
      await expect(page.getByTestId('first-run-guide')).toBeVisible();
      expectMapReachable(await scanMapGrid(page));
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 増分 5 の手直し D — シェルの寸法と畳み（D1 鍵の引っ越し / D2 レール / D3 「≫」）
// ---------------------------------------------------------------------------
//
// **どれも実寸を測る。** 「入り切っているか」「文字が切れていないか」は、レイアウトを
// 計算する環境でしか分からない（開発ガイド §5.49）。CSS の宣言そのものを読む契約テストは
// `src/ui/shell/shell-layout.test.ts` が持ち、こちらは実物を測る。

/** 器が縦にあふれている量（`overflow-y: auto` の器なら、正なら縦スクロールバーが出る）。 */
async function verticalOverflow(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`要素が無い: ${sel}`);
    return el.scrollHeight - el.clientHeight;
  }, selector);
}

/** 実際に縦スクロールバーが出ている幅（器の外寸 − 内寸 − 枠線）。 */
async function scrollbarWidth(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) throw new Error(`要素が無い: ${sel}`);
    const cs = getComputedStyle(el);
    const border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    return el.offsetWidth - el.clientWidth - border;
  }, selector);
}

/**
 * 窓の大きさを変えたあと、対象の矩形が落ち着くまで待つ。**固定の待ち時間は環境で揺れる**
 * （増分 4 の全件ゲートの教訓）ので「同じ値が 2 回続いたら止まった」で待つ。
 */
async function settleLayout(page: Page, testId: string): Promise<void> {
  let last = '';
  await expect
    .poll(async () => {
      const box = await page.getByTestId(testId).boundingBox();
      const now = box === null ? '' : `${box.x},${box.y},${box.width},${box.height}`;
      const stable = now !== '' && now === last;
      last = now;
      return stable;
    })
    .toBe(true);
}

test.describe('手直し D1 — 鍵はアプリバー右端の 96px 枠', () => {
  test('鍵はアプリバーの中の 96px 枠に居て、2 状態とも文字が切れない', async () => {
    // **わざと壊すなら**: `AppShell.tsx` の `<div className="app-shell__lock">` を
    // `Toolbar.tsx` へ戻すと「親が app-shell-lock でない」で赤くなる。
    // `shell.css` の `--shell-lock-w` を 72px へ下げると「文字が切れている」で赤くなる。
    const { app, page } = await launchApp();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.getByTestId('mode-view')).toBeVisible();
      await settleLayout(page, 'app-shell-lock');

      // ① 鍵の **直接の親**が 96px の枠で、その枠はアプリバーの中に居る。
      const placement = await page.getByTestId('mode-view').evaluate((el) => ({
        parent: el.parentElement?.getAttribute('data-testid') ?? '',
        inAppBar: el.closest('.app-shell__menubar') !== null,
        inRail: el.closest('[data-testid="toolbar"]') !== null,
      }));
      expect(placement.parent).toBe('app-shell-lock');
      expect(placement.inAppBar, '鍵がアプリバーの外に居る').toBe(true);
      expect(placement.inRail, '鍵がまだ左のレールに居る').toBe(false);

      // ② 枠はアプリバーの **いちばん右**。
      const bar = await page.locator('.app-shell__menubar').boundingBox();
      expect(bar).not.toBeNull();
      const frameBefore = await rectOf(page, 'app-shell-lock');
      expect(
        Math.abs(frameBefore.x + frameBefore.width - (bar!.x + bar!.width)),
        '鍵がアプリバーの右端に付いていない',
      ).toBeLessThanOrEqual(1);

      // ③ **2 状態とも同じ 96px の枠**で、どちらも文字が切れない。
      for (const expectedMode of ['view', 'edit'] as const) {
        await expect(page.getByTestId('app-mode')).toHaveText(expectedMode);
        const frame = await rectOf(page, 'app-shell-lock');
        expect(frame.width, `${expectedMode} で鍵の枠が 96px でない`).toBe(96);
        const clip = await page
          .getByTestId('mode-view')
          .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        expect(
          clip.scroll,
          `${expectedMode} で鍵の文字が切れている（${clip.scroll} > ${clip.client}）`,
        ).toBeLessThanOrEqual(clip.client);
        if (expectedMode === 'view') await page.getByTestId('mode-view').click();
      }
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し D2 — 左のレールは縦に収まり、文字も切れない', () => {
  test('1280×800 でも 1366×768 でも、レールに縦スクロールバーが出ない', async () => {
    // **わざと壊すなら**: `shell.css` の `.toolbar button` から `box-sizing: border-box`
    // を外す（1 個 32 → 42px になる）か `min-height` を 36px 以上へ上げると、
    // 1366×768 のほうから赤くなる。
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('toolbar')).toBeVisible();
      for (const [width, height] of [
        [1280, 800],
        [1366, 768],
      ] as const) {
        await page.setViewportSize({ width, height });
        await settleLayout(page, 'toolbar');

        const over = await verticalOverflow(page, '.app-shell__toolbar');
        expect(
          over,
          `${width}×${height} でレールが縦に ${over}px あふれている`,
        ).toBeLessThanOrEqual(1);
        // あふれの実害は「スクロールバーが出て道具の幅がさらに痩せる」ことなので、
        // 出ていないことそのものも測る。
        const bar = await scrollbarWidth(page, '.app-shell__toolbar');
        expect(
          bar,
          `${width}×${height} でレールに縦スクロールバーが出ている（${bar}px）`,
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      await app.close();
    }
  });

  test('レールには道具 12 個だけが並び、どれも文字が切れない', async () => {
    // **わざと壊すなら**: `strings.ts` の道具名を長くする（例「✥ 動かす」→
    // 「✥ 地物を動かす」）か、`shell.css` の `.toolbar button` の `font-size: 12px` を
    // 消す（13px に戻る）と「文字が切れている」で赤くなる。
    // 鍵をレールへ戻すと「12 個でない」で赤くなる。
    const { app, page } = await launchApp();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.getByTestId('toolbar')).toBeVisible();
      await settleLayout(page, 'toolbar');

      const report = await page.evaluate(() => {
        const rail = document.querySelector('[data-testid="toolbar"]');
        if (rail === null) throw new Error('レールが無い');
        const buttons = Array.from(rail.querySelectorAll('button'));
        return {
          ids: buttons.map((b) => b.getAttribute('data-testid') ?? '?'),
          clipped: buttons
            .filter((b) => b.scrollWidth > b.clientWidth)
            .map((b) => ({
              id: b.getAttribute('data-testid') ?? '?',
              text: (b.textContent ?? '').trim(),
              scroll: b.scrollWidth,
              client: b.clientWidth,
            })),
        };
      });

      // 道具 11 個（ALL_TOOLS）＋「測る」1 個。鍵はアプリバーへ引っ越した（D1）。
      expect(report.ids, `レールのボタン: ${report.ids.join(' / ')}`).toHaveLength(12);
      expect(report.ids).not.toContain('mode-view');
      expect(report.ids).toContain('survey-toggle');
      expect(
        report.clipped,
        `文字が切れている道具: ${JSON.stringify(report.clipped)}`,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し D3 — 設定欄の畳み「≫」', () => {
  test('どの窓幅でも設定欄の部品は枠に収まり、「表示 ▾」に必ず手が届く', async () => {
    // **親の `scrollWidth` では捕まらない**（設定欄は `overflow: hidden` なので、
    // 中の部品が切り落とされていても親の内寸と一致してしまう ―― 開発ガイド §5.49 の型）。
    // だから **部品ごとの矩形を枠の矩形と突き合わせる**。
    //
    // **わざと壊すなら**: `OptionBar.tsx` の畳みを外す（`visibleCount` を常に `null` に
    // する）と、狭い窓で「設定欄からはみ出した部品」が出て赤くなる。
    // `shell.css` の `.option-bar__slot` の `flex: 0 0 auto` を消すと、部品が潰れて
    // はみ出しは消えるが、代わりに「表示 ▾ に手が届く」ほうが（潰れて押せず）赤くなる。
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('option-bar-settings')).toBeVisible();

      for (const width of [800, 960, 1120, 1280, 1920]) {
        await page.setViewportSize({ width, height: 800 });
        await settleLayout(page, 'option-bar-settings');

        // ---- ① 部品の矩形が設定欄の矩形の中にある。
        const report = await page.evaluate(() => {
          const box = document.querySelector('[data-testid="option-bar-settings"]');
          if (box === null) throw new Error('設定欄が無い');
          const frame = box.getBoundingClientRect();
          const escapees: { id: string; left: number; right: number }[] = [];
          for (const el of Array.from(box.querySelectorAll('[data-testid]'))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue; // 出ていない部品は数えない
            if (r.left < frame.left - 1 || r.right > frame.right + 1) {
              escapees.push({
                id: el.getAttribute('data-testid') ?? '?',
                left: Math.round(r.left),
                right: Math.round(r.right),
              });
            }
          }
          return {
            frame: { left: Math.round(frame.left), right: Math.round(frame.right) },
            escapees,
          };
        });
        expect(
          report.escapees,
          `窓幅 ${width} で設定欄（${report.frame.left}〜${report.frame.right}）から` +
            `はみ出した部品: ${JSON.stringify(report.escapees)}`,
        ).toEqual([]);

        // ---- ② 「表示 ▾」には必ず手が届く（帯に出ているか、「≫」を開けば出る）。
        //
        // これが手直し D3 の目的そのものである。畳む前は、狭い窓で「表示 ▾」が
        // **切り落とされて画面から消えて**いた（切れていることすら見えない）。
        const display = page.getByTestId('option-display-button');
        const overflow = page.getByTestId('option-bar-overflow');
        let openedOverflow = false;
        if (!(await display.isVisible())) {
          await expect(
            overflow,
            `窓幅 ${width} で「表示 ▾」が帯から消えたのに「≫」が出ていない`,
          ).toBeVisible();
          await overflow.click();
          await expect(page.getByTestId('option-bar-overflow-panel')).toBeVisible();
          openedOverflow = true;
        }
        await expect(display, `窓幅 ${width} で「表示 ▾」に手が届かない`).toBeVisible();
        await expect(display).toBeEnabled();

        // 実際に押せる（重なって奪われていない）ことまで見る。
        await display.click();
        await expect(page.getByTestId('option-display-panel')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('option-display-panel')).toBeHidden();
        if (openedOverflow) {
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('option-bar-overflow-panel')).toBeHidden();
        }
      }
    } finally {
      await app.close();
    }
  });

  test('K-2: 「≫」は開いていても閉じていても地図の当たりを奪わない', async () => {
    // 教訓 5.56（`[hidden]` はクラスの `display` に負ける）を、新しく足したこの 1 枚にも
    // 掛ける。**閉じた状態でしか捕まらない事故**なので、開閉の両方を走査する。
    //
    // **わざと壊すなら**: `shell.css` の `.option-bar__overflow-panel[hidden]` の規則を
    // 消すと、閉じているのにパネルが画面左上に居座り、ここが赤くなる。
    const { app, page } = await launchApp();
    try {
      // 「≫」が出るまで窓を狭める（畳みは窓幅だけで決まる＝設計書 §B.4）。
      await page.setViewportSize({ width: 800, height: 600 });
      await expect(page.getByTestId('map-area')).toBeVisible();
      await settleLayout(page, 'option-bar-settings');

      const overflow = page.getByTestId('option-bar-overflow');
      if ((await overflow.count()) === 0) {
        // 設定欄に載っている部品が少なくて畳む必要が無い窓では、この検査は空振りする。
        // そのときは「パネルが存在しないこと」だけ確かめて終える（居座りようがない）。
        await expect(page.getByTestId('option-bar-overflow-panel')).toHaveCount(0);
        return;
      }

      // 800×600 では地図セルが小さいので、走査の点が **右下のズームと全体表示に当たる**
      // （台帳 #10 の部品なので覆ってよい ―― ただし名指しで数える＝教訓 5.83）。
      const zoomParts = ['map-zoom-in', 'map-fit-all'];
      expectMapReachable(await scanMapGrid(page), { covered: zoomParts });

      await overflow.click();
      await expect(page.getByTestId('option-bar-overflow-panel')).toBeVisible();
      expectMapReachable(await scanMapGrid(page), {
        extra: ['popover:option-bar-overflow-panel'],
        covered: zoomParts,
      });

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('option-bar-overflow-panel')).toBeHidden();
      expectMapReachable(await scanMapGrid(page), { covered: zoomParts });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 増分 5 の手直し B — Esc の階段と確定（設計書 §D.4 / §D.4.1 / §C.4）
// ---------------------------------------------------------------------------
//
// **なぜ E2E なのか**: 階段が本当に「1 回で 1 段」なのかは、**道具のリスナーと大域の
// リスナーが同じ 1 つの打鍵をどう分け合うか**の話である。単体では道具のリスナーしか
// 載らないので、「道具が止めなかったときに大域が続きを引き受ける」ところが検査できない
// （道具側の単体テストは `preventDefault` されないことまでしか見られない）。
//
// **わざと壊すなら**（この節の全体）:
//   - 5 つのコントローラの Escape で `cancel()` を呼ぶ旧実装へ戻すと、1 回目の Escape で
//     道具まで落ちるので「点列だけ消える」の行が赤くなる。
//   - 段 3 で `e.preventDefault()` を足すと、大域の階段へ届かなくなり「3 回目で『選ぶ』へ
//     戻る」の行が赤くなる。
//   - `releaseToolOnCancel` に `clearSelection()` を戻すと、「元からの選択が残る」の行が
//     赤くなる。

test.describe('増分 5 の手直し B1 — Esc の階段は 1 回で 1 段だけ下りる', () => {
  test('分ける: 点列 → 対象 → 地物 → 道具、の順に 1 段ずつ戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);

      await page.getByTestId('tool-edit.knife').click();
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      await page.mouse.click(cx, cy); // 対象を掴む
      await expect(page.getByTestId('knife-tool')).toHaveAttribute('data-flow', 'drawing-cut');
      // 分断線を 2 点引く（面を貫く向き）。
      await page.mouse.click(cx - 200, cy);
      await page.mouse.click(cx + 200, cy);
      await expect(page.getByTestId('knife-cut-count')).toHaveText('2');

      // ---- 1 段目: 点列だけがまとめて消える。対象も道具も残る。
      // **分断線 2 点は「確定できる点数」なので 1 度聞く**（設計書 §D.4.1 の 3。
      // 2 回目の手直しで足した段）。利用者自身の Escape で出た板なので、もう一度の
      // Escape は「捨てる」＝ 先へ進む（教訓 5.70 の輪にしない）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('knife-draft-discard-confirm')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('knife-draft-discard-confirm')).toHaveCount(0);
      await expect(page.getByTestId('knife-cut-count')).toHaveText('0');
      await expect(page.getByTestId('knife-tool')).toHaveAttribute('data-flow', 'drawing-cut');
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.knife');

      // ---- 2 段目: 対象だけが外れる。道具は持ったまま。
      // **元からの選択は保つ**（設計書 §D.4.1 の表。2 回目の手直しで直した ―― それまでは
      // 対象を離すと選択が `null` になり、階段が 1 段飛んでいた）。ここでは面を確定した
      // 直後にその面が選ばれているので、対象を離すと **その選択へ戻る**。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('knife-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.knife');
      await expect(page.getByTestId('app-active-feature')).not.toHaveText('');

      // ---- 3 段目: 道具は何もせず大域の階段へ譲る → 地物の選択が外れる（U-5）。
      // ここが「道具側で preventDefault しない」の実物の効き目である。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.knife');

      // ---- 4 段目: 何も残っていないので、道具が「選択」へ戻る（階段のいちばん下）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-tool')).toHaveText('');
      await expect(page.getByTestId('knife-tool')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('結ぶ: 元からの選択は、対象を外す Escape で巻き添えにならない', async () => {
    // GPT #8 の核心。結ぶ道具は `activeFeature` を 1 度も書かないのに、旧実装は
    // 取りやめのたびに `clearSelection()` を呼んで **道具が掴んだのではない選択**を
    // 消していた。
    const { app, page } = await launchApp();
    try {
      // 重ならない位置に 2 つ描く（FR-29: 他の面の内側には頂点を置けない）。座標は
      // 入力層の実寸から解く ―― 固定 px で書くと窓の大きさで外れる（増分 1 の教訓）。
      await armAddAreaTool(page);
      const box = await addInputLayerBox(page);
      const half = Math.round(Math.min(box.width, box.height) * 0.14);
      const leftX = box.x + box.width * 0.28;
      const rightX = box.x + box.width * 0.72;
      const midY = box.y + box.height * 0.5;
      const firstId = await drawFace(page, squareCorners(leftX, midY, half), { name: 'A' });
      await armAddAreaTool(page);
      await drawFace(page, squareCorners(rightX, midY, half), { name: 'B' });

      // 「選択」で 1 つ目の面を選んでおく（＝道具の外で選んだもの）。
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(leftX, midY);
      await expect(page.getByTestId('app-active-feature')).toHaveText(firstId);

      // 結ぶを構えて、2 つ目の面を対象に押す（選択は書き換わらない）。
      await page.getByTestId('tool-edit.merge').click();
      await expect(page.getByTestId('merge-input-layer')).toBeVisible();
      await page.mouse.click(rightX, midY);
      await expect(page.getByTestId('merge-target-count')).toHaveText('1');
      await expect(page.getByTestId('app-active-feature')).toHaveText(firstId);

      // Escape 1 回目 ＝ 対象を全部外す。**元からの選択も道具も残る。**
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('merge-target-count')).toHaveText('0');
      await expect(page.getByTestId('app-active-feature')).toHaveText(firstId);
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.merge');

      // Escape 2 回目 ＝ 道具は何もせず大域へ譲る → 地物の選択が外れる（U-5）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.merge');

      // Escape 3 回目 ＝ 道具が「選択」へ戻る（階段のいちばん下）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('app-active-tool')).toHaveText('');
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 5 の手直し B3 — 案内・断り・対象欄はオプションバーが出す', () => {
  test('所属変更: 案内の文は地図に描かれず、帯の「次の一手」に出る', async () => {
    // バグ狩り #4 / 設計書 §B.5 の台帳 #2。旧版はこの 2 つだけが `hidden` になって
    // おらず、地図の上端に黒帯として出たまま、同じ文言が帯にも出る二重表示だった。
    //
    // **わざと壊すなら**: `ReparentToolController` の `reparent-guide` から `hidden` を
    // 外すと、地図の上に文が出てここが赤くなる。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.reparent').click();
      await expect(page.getByTestId('reparent-input-layer')).toBeVisible();

      // 地図側は観測のミラーだけ（読めるが、描かれていない）。
      await expect(page.getByTestId('reparent-guide')).toBeHidden();
      // 本文は帯の「次の一手」に出ている。
      await expect(page.getByTestId('option-bar-next-step')).toContainText('所属を変更する地物');

      // 対象を掴むと、対象欄に「手順 2/3」と名前が出る（バグ狩り #9 / 設計書 §C.4）。
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('option-bar-stage')).toHaveText('手順 2/3');
      await expect(page.getByTestId('option-bar-target')).toContainText('→ 親: ?');
    } finally {
      await app.close();
    }
  });

  test('分ける: 対象を 1 度も押していなければ、対象欄に地物の名前は出ない', async () => {
    // バグ狩り #6。旧版は対象欄を `activeFeature` から作っていたので、**一覧で選んで
    // からナイフを構えると、押していない地物の名前が出て**「切る面を押してください」と
    // 矛盾していた。
    //
    // **わざと壊すなら**: `shell/ToolOptionBar` の `TOOLS_WITH_OWN_TARGET` から
    // `EditKnife` を抜くと、構えた瞬間に選んでいる面の名前が出てここが赤くなる。
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      await page.getByTestId('tool-edit.knife').click();
      // 選択は残る（増分 5c の裁定）が、**道具の対象ではない**ので対象欄は空である。
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect(page.getByTestId('option-bar-stage')).toHaveText('手順 1/4');
      await expect(page.getByTestId('option-bar-target')).toContainText('選んでいません');

      // 押したら初めて名前が出る。
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('option-bar-stage')).toHaveText('手順 2/4');
      await expect(page.getByTestId('option-bar-target')).not.toContainText('選んでいません');
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 5 の手直し B4 — 最上位へは、何が起きるかを見せてから確定する', () => {
  test('［最上位へ（所属を外す）］は押した瞬間には確定せず、確認の板を出す', async () => {
    // バグ狩り B-1 / E4。削除と同じ作法で、押した結果を見せてから確定する。
    //
    // **増分 7 で器が 3 択の作業ダイアログ 1 つに変わった**（設計書 §B.5）。押した部品が
    // 「最初に開く枝」を決めるので、［最上位へ］は **独立の枝が選ばれた状態**で開く。
    // 何が起きるかを言う文（`reparent-detach-confirm`）はその枝の中に残っている。
    //
    // **わざと壊すなら**: `reparent-confirm-none` の `onClick` を `reparent.confirmNone()`
    // に戻すと、板が出ないままその場で確定してここが赤くなる。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.reparent').click();
      await page.mouse.click(cx, cy); // 対象を掴む
      await expect(page.getByTestId('reparent-target')).not.toHaveText('');

      const detach = page.getByTestId('reparent-confirm-none');
      await expect(detach).toBeEnabled();
      await detach.click();

      // 確認の板が出る。答えるまでは何も起きない。
      const dialog = page.getByTestId('reparent-options-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(page.getByTestId('reparent-parent-none')).toBeChecked();
      await expect(page.getByTestId('reparent-detach-confirm')).toContainText(
        'どこにも所属しなくなります',
      );
      // 板が出ているあいだは鍵盤の持ち主が「板」（＝背後で保存や削除が走らない）。
      await expect(page.getByTestId('app-focus-owner')).toHaveText('modal');

      // Escape は階段の最上段 ―― 板を閉じるだけで、掴んだ対象は残る。
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('reparent-target')).not.toHaveText('');
      await expect(page.getByTestId('app-focus-owner')).not.toHaveText('modal');
    } finally {
      await app.close();
    }
  });
});

// **5 道具で確定後のふるまいを揃えた**（増分 5 の手直し B2 / 設計書 §D.2）。ナイフだけが
// 確定後に道具を降りていた ―― 合成ルートの `onKnifeCommitted` が
// `setActiveTool(null, s.selection)` を呼んでいたためで、続けて分けたい人は毎回ナイフを
// 選び直すことになっていた。道具側（`useKnifeTool` の確定）が対象選択へ戻す再武装を
// するようにし、合成ルートの 1 行を外した。
test(
  '増分 5 の手直し B2 — 分けるを確定しても道具は残る',
  async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.knife').click();
      await page.mouse.click(cx, cy);
      await page.mouse.click(cx - 200, cy);
      await page.mouse.click(cx + 200, cy);
      await page.getByTestId('knife-confirm-cut').click();
      await page.getByTestId('knife-confirm-inheritor').click();
      await page.getByTestId('add-save').click();

      // 確定しても道具は残り、次の対象待ちへ戻る（設計書 §D.2 の「道具の確定」の行）。
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.knife');
      await expect(page.getByTestId('knife-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
      // 確定直後は鍵盤が地図に戻っているので、Ctrl+Z が大域の履歴へ届く（§D.4）。
      await expect(page.getByTestId('app-focus-owner')).toHaveText('map');
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('app-can-redo')).toHaveText('1');
    } finally {
      await app.close();
    }
  },
);

// --- 司令塔の決定 (5): 切った非継承側・穴あけの新地物の素性も「右パネルの新規の姿」で受ける
//
// 設計書 §B.5 の台帳 #9 / §C.2 の 27。**同じ「新しい地物の素性を入れる」作業なのに置き場が
// 2 通りある**と、名前欄の焦点も保存ボタンの名前も 2 通りになる。加えて地図の中央の板は
// **いま切った／くり抜いた形の真上に出る**ので、形を見ながら名前を入れられなかった
// （追加の道具が N-15 で直したのと同じ害）。右パネルなら覆わない。
//
// **なぜ E2E なのか**: 「板が地図に出ていない」は木の位置だけでは半分しか言えない。jsdom は
// レイアウトを計算しないので、地図セルの中の要素が実際に見えているかを測れない（開発ガイド
// §5.49）。ここでは **地図セルの中を探して見える `*-props` が無い**ことと、**右パネルに
// 素性欄が出て［保存］で確定できる**ことを、実物の画面で見る。
test.describe('司令塔の決定 (5) — 切った側・穴あけの新地物の素性は右パネルで入れる', () => {
  test('分ける: 継承先を決めたあと、新しい地物の素性は右パネルで入れる', async () => {
    // **どこを壊すと赤くなるか**:
    //   - `KnifeToolController` の `addDraft` の押し込み（`addDraft.set({...})`）を外すと、
    //     右パネルに `add-property-form` が出ず「素性欄が見える」で赤くなる。
    //   - 消した `NonInheritedForm`（地図の中央の板）を戻すと、地図セルの中に**見える**
    //     `knife-props` が現れて「板が出ていない」で赤くなる。
    //   - `App.tsx` の `<KnifeToolController addDraft={addDraftStore}>` の 1 行を外しても、
    //     入力の口がどこにも無くなって同じところで赤くなる。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.knife').click();
      await page.mouse.click(cx, cy); // 切る面を掴む
      await page.mouse.click(cx - 200, cy); // 分断線 1 点目（面の外）
      await page.mouse.click(cx + 200, cy); // 分断線 2 点目（面の外・貫く）
      await page.getByTestId('knife-confirm-cut').click();
      await page.getByTestId('knife-confirm-inheritor').click();

      // (1) 地図セルの中に **見える** 板は無い。残っているのは `hidden` の観測ミラーだけ
      //     である（T-1 役割のまま／T-2 隠し観測は足す一方）。
      const mapProps = page.getByTestId('map-area').getByTestId('knife-props');
      await expect(mapProps).toHaveCount(1);
      await expect(mapProps).toBeHidden();

      // (2) 素性は **右パネル**の「新規の姿」で受ける。
      const form = page.getByTestId('sidebar').getByTestId('add-property-form');
      await expect(form).toBeVisible();
      // 上位領域はドメインが元の面から継ぐ（FR-44）ので、その欄は出さない
      // ―― 出すと「選んだのに反映されない欄」になる。
      await expect(page.getByTestId('add-parent')).toHaveCount(0);
      // 帯の確定欄は［やめる］だけ（保存は右パネルの［保存］が持つ）。
      await expect(page.getByTestId('knife-cancel')).toBeVisible();

      // (3) ［保存］で確定できる ―― 確定すると入力待ちは閉じ、道具は次の対象待ちへ戻る。
      await page.getByTestId('add-name').fill('切り分けた側');
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      await expect(page.getByTestId('knife-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
    } finally {
      await app.close();
    }
  });

  test('穴あけ: くり抜く形を確定したあと、新しい地物の素性は右パネルで入れる', async () => {
    // **どこを壊すと赤くなるか**:
    //   - `DrillToolController` の `addDraft` の押し込みを外すと、右パネルに
    //     `add-property-form` が出ず「素性欄が見える」で赤くなる。
    //   - 消した `NewFeatureForm`（地図の中央の板）を戻すと、地図セルの中に**見える**
    //     `drill-props` が現れて「板が出ていない」で赤くなる。
    //   - `drillCommit` の `drillRejected || drillEntering` から `drillEntering` を抜くと、
    //     素性入力中も［確定］が帯に残って「［やめる］だけ」で赤くなる。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.drill').click();
      await page.mouse.click(cx, cy); // 穴をあける末端地物を掴む（頂点は置かれない）
      // くり抜く形（面は半径 120px なので、±40px の三角形は完全に内側）。
      await page.mouse.click(cx - 40, cy - 40);
      await page.mouse.click(cx + 40, cy - 40);
      await page.mouse.click(cx, cy + 40);
      await page.getByTestId('drill-confirm').click();

      // (1) 地図セルの中に **見える** 板は無い（`hidden` の観測ミラーだけ）。
      const mapProps = page.getByTestId('map-area').getByTestId('drill-props');
      await expect(mapProps).toHaveCount(1);
      await expect(mapProps).toBeHidden();

      // (2) 素性は **右パネル**の「新規の姿」で受ける。
      const form = page.getByTestId('sidebar').getByTestId('add-property-form');
      await expect(form).toBeVisible();
      // 上位領域はドメインが元の末端地物から継ぐ（FR-45）ので、その欄は出さない。
      await expect(page.getByTestId('add-parent')).toHaveCount(0);
      // 帯の確定欄は［やめる］だけ。［1 つ戻す］も引っ込む（押せると確定済みの形から
      // 頂点が黙って 1 つ減る）。
      await expect(page.getByTestId('drill-cancel')).toBeVisible();
      await expect(page.getByTestId('drill-confirm')).toHaveCount(0);
      await expect(page.getByTestId('drill-undo')).toHaveCount(0);

      // (3) ［保存］で確定できる ―― 確定すると入力待ちは閉じ、道具は次の対象待ちへ戻る。
      await page.getByTestId('add-name').fill('くり抜いた中身');
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      await expect(page.getByTestId('drill-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 増分 5 の手直し 2 回目（2026-09-06）
// ---------------------------------------------------------------------------
//
// 実機の再検証で残った 5 件を固定する。**どれも E2E でしか捕まらない** ―― 重なりの層・
// 実測の幅・道具どうしの押し合いは、レイアウトを計算しない環境では全部 0 になる
// （開発ガイド §5.49）。

/** その座標でいちばん手前に居る要素の `data-testid`（教訓 5.61 の測り方）。 */
async function topmostTestIdAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ({ px, py }) => {
      const el = document.elementFromPoint(px, py);
      if (el === null) return 'null';
      const named = el.closest('[data-testid]');
      return named?.getAttribute('data-testid') ?? el.className.toString();
    },
    { px: x, py: y },
  );
}

/** その部品の中央でいちばん手前に居る要素の `data-testid`。 */
async function topmostTestIdOver(page: Page, testId: string): Promise<string> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} の矩形が取れない`).not.toBeNull();
  const b = box!;
  return topmostTestIdAt(page, b.x + b.width / 2, b.y + b.height / 2);
}

test.describe('手直し 2 回目 (1) — 捨てる前の確認は本物のモーダル', () => {
  test('確定できる下書き中にナイフへ持ち替えても、板をマウスで押せて、地図はナイフに届かない', async () => {
    // **旧版の壊れ方**: 板は地図セルの覆いの中の普通の子で層を持たず、切替先の道具の
    // 入力ブリッジ（`knife.css` の `z-index: 1`）が板の上に乗っていた。板のボタンの
    // 座標で `elementFromPoint` が `knife-input-layer` を返し、マウスでは押せない。
    // 板の外を押せばナイフが対象を掴み、選択理由の板が二重に出た。
    //
    // **わざと壊すなら**: `shell.css` の `.draft-discard-modal-root` の `z-index` を
    // 落とすと (2) が赤くなる。`AddToolController` の「切替先を構えないまま聞く」
    // （板を出す瞬間の `setActiveTool(restore)`）を外すと (1) が赤くなる。
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const box = await addInputLayerBox(page);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await placeVertices(page, squareCorners(cx, cy, 60));
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');

      await page.getByTestId('tool-edit.knife').click();
      const confirm = page.getByTestId('add-draft-discard-confirm');
      await expect(confirm).toBeVisible();

      // ---- (1) 板が出ているあいだ、**切替先は構えていない**。
      await expect(
        page.getByTestId('app-active-tool'),
        '板が出ているのに切替先が構えられている',
      ).toHaveText('add.area');
      await expect(page.getByTestId('knife-input-layer')).toHaveCount(0);
      await expect(page.getByTestId('tool-edit.knife')).toHaveAttribute('aria-pressed', 'false');

      // ---- (2) 板のボタンの上でいちばん手前に居るのは、そのボタン自身である。
      expect(
        await topmostTestIdOver(page, 'add-draft-discard-no'),
        '［続ける］の上に別の層が乗っている',
      ).toBe('add-draft-discard-no');
      expect(await topmostTestIdOver(page, 'add-draft-discard-yes')).toBe('add-draft-discard-yes');

      // ---- (3) 板の外の地図は、背面を覆う板が受ける（切替先にも作図にも届かない）。
      for (const hit of await scanMapGrid(page)) {
        expect(
          ['add-draft-discard-confirm-backdrop', 'popover:add-draft-discard-confirm'],
          `板が出ているのに ${hit} へ抜けた`,
        ).toContain(hit);
      }

      // ---- (4) 実際にマウスで［続ける］を押せる（`force` を使わない）。
      await page.getByTestId('add-draft-discard-no').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('app-active-tool')).toHaveText('add.area');
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');

      // ---- (5) ［捨てる］と答えて初めて切替先が構えられる。
      await page.getByTestId('tool-edit.knife').click();
      await expect(confirm).toBeVisible();
      await page.getByTestId('add-draft-discard-yes').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.knife');
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      expectMapReachable(await scanMapGrid(page), { primary: 'knife-input-layer' });
    } finally {
      await app.close();
    }
  });

  test('鍵を閉じる経路でも、答えるまで「読むだけ」にならない', async () => {
    // 旧版は **先に鍵が閉じてから**聞いていたので、板が出ているあいだ「読むだけなのに
    // 下書きが生きている」状態が一瞬存在し、そこから確認なしで view へ抜ける道が残った。
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const box = await addInputLayerBox(page);
      await placeVertices(
        page,
        squareCorners(box.x + box.width / 2, box.y + box.height / 2, 60),
      );
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');

      await page.getByTestId('mode-view').click();
      const confirm = page.getByTestId('add-draft-discard-confirm');
      await expect(confirm).toBeVisible();
      // 鍵はまだ開いたまま（答えるまで閉じない）。
      await expect(page.getByTestId('app-mode')).toHaveText('add');
      await expect(page.getByTestId('mode-view')).toHaveAttribute('aria-pressed', 'false');

      await page.getByTestId('add-draft-discard-no').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('app-mode')).toHaveText('add');
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');

      await page.getByTestId('mode-view').click();
      await expect(confirm).toBeVisible();
      await page.getByTestId('add-draft-discard-yes').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('app-mode')).toHaveText('view');
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し 2 回目 (2) — 右パネルの素性入力でも Escape が効く', () => {
  test('分ける: 空欄なら 1 回で対象を離し、打ちかけがあれば 1 度聞く', async () => {
    // **旧版の壊れ方**: 決定 (5) で素性入力を右パネルへ移した結果、名前欄に焦点が
    // あるあいだ **Escape を誰も受けなかった**（道具は焦点の関門で降り、大域も同じ
    // 関門で落ちる）。10 回押しても `tool=edit.knife owner=text` のままだった。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.knife').click();
      await page.mouse.click(cx, cy);
      await page.mouse.click(cx - 200, cy);
      await page.mouse.click(cx + 200, cy);
      await page.getByTestId('knife-confirm-cut').click();
      await page.getByTestId('knife-confirm-inheritor').click();
      await expect(page.getByTestId('add-name')).toBeVisible();

      // ---- (1) 空欄（打ちかけ無し）なら 1 回でやめる。行き先は「対象を離す」段で、
      //      **道具は持ったまま**である（設計書 §D.4.1 の階段）。
      await page.getByTestId('add-name').focus();
      await expect(page.getByTestId('app-focus-owner')).toHaveText('text');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      await expect(page.getByTestId('knife-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.knife');

      // ---- (2) 打ちかけがあれば 1 度聞く。［続ける］で入力は残る。
      await page.mouse.click(cx, cy);
      await page.mouse.click(cx - 200, cy + 40);
      await page.mouse.click(cx + 200, cy + 40);
      await page.getByTestId('knife-confirm-cut').click();
      await page.getByTestId('knife-confirm-inheritor').click();
      await page.getByTestId('add-name').fill('打ちかけ');
      await page.keyboard.press('Escape');
      const confirm = page.getByTestId('knife-draft-discard-confirm');
      await expect(confirm).toBeVisible();
      await page.getByTestId('knife-draft-discard-no').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('add-name')).toHaveValue('打ちかけ');

      // ---- (3) もう 1 回の Escape で板が出て、さらにもう 1 回で捨てる
      //      （利用者自身の Escape で出た板は Escape ＝「捨てる」＝ 教訓 5.70）。
      await page.getByTestId('add-name').focus();
      await page.keyboard.press('Escape');
      await expect(confirm).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      await expect(page.getByTestId('knife-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
    } finally {
      await app.close();
    }
  });

  test('穴あけ: 空欄なら 1 回で対象を離し、打ちかけがあれば 1 度聞く', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      await page.getByTestId('tool-edit.drill').click();
      await page.mouse.click(cx, cy);
      await page.mouse.click(cx - 40, cy - 40);
      await page.mouse.click(cx + 40, cy - 40);
      await page.mouse.click(cx, cy + 40);
      await page.getByTestId('drill-confirm').click();
      await expect(page.getByTestId('add-name')).toBeVisible();

      await page.getByTestId('add-name').focus();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      await expect(page.getByTestId('drill-tool')).toHaveAttribute(
        'data-flow',
        'selecting-target',
      );
      await expect(page.getByTestId('app-active-tool')).toHaveText('edit.drill');

      await page.mouse.click(cx, cy);
      await page.mouse.click(cx - 40, cy - 40);
      await page.mouse.click(cx + 40, cy - 40);
      await page.mouse.click(cx, cy + 40);
      await page.getByTestId('drill-confirm').click();
      await page.getByTestId('add-name').fill('打ちかけ');
      await page.keyboard.press('Escape');
      const confirm = page.getByTestId('drill-draft-discard-confirm');
      await expect(confirm).toBeVisible();
      await page.getByTestId('drill-draft-discard-no').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('add-name')).toHaveValue('打ちかけ');

      await page.getByTestId('add-name').focus();
      await page.keyboard.press('Escape');
      await expect(confirm).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し 2 回目 (3) — 手順のある道具から降りても帯が踏み消されない', () => {
  test('5 道具 × 選択・頂点・動かす・測る の 20 通りで、対象欄と帯が残る', async () => {
    // **旧版の壊れ方**: 5 道具は `activeTool` が外れたあと **effect の中で**自分の状態を
    // 畳む（`resetForSwitch()` → `setState`）ので、`setTarget(null, null)` などの後片付けが
    // **1 コミット遅れて**走り、同じ持ち替えで先に押し込んだ `ToolOptionBar` の対象名や
    // `SurveyOptionBar` の帯を踏み消した。地物は選ばれたままなのに対象欄が
    // 「（選んでいません）」で固まる。
    //
    // **わざと壊すなら**: `option-bar.ts` の `epoch()` を常に 0 を返す形にする（または
    // 5 道具と `useToolBarChrome` の後片付けから代の照合を外す）と、20 通りのうち
    // 手順のある道具から降りた直後が赤くなる。
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitOneFace(page);
      const stepTools = [
        'edit.knife',
        'edit.merge',
        'edit.reparent',
        'edit.ring',
        'edit.drill',
      ] as const;
      const plainTools = ['edit.select', 'edit.vertex', 'edit.move'] as const;

      for (const from of stepTools) {
        for (const to of [...plainTools, 'survey'] as const) {
          // 素の状態から始める（「選択」に戻して、地物を 1 つ選んでおく）。
          await page.getByTestId('tool-edit.select').click();
          await page.mouse.click(cx, cy);
          await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

          await page.getByTestId(`tool-${from}`).click();
          await expect(page.getByTestId('app-active-tool')).toHaveText(from);

          if (to === 'survey') {
            await page.getByTestId('survey-toggle').click();
            // 測るは自分で帯を持つ（司令塔の決定 (4)）。5 区画が全部 **測るのもの**である。
            await expect(
              page.getByTestId('option-bar-tool'),
              `${from} → 測る で道具名が踏み消された`,
            ).toHaveText('📏 測る');
            await expect(
              page.getByTestId('option-bar-target'),
              `${from} → 測る で対象欄が踏み消された`,
            ).not.toHaveText('（選んでいません）');
            await expect(
              page.getByTestId('option-bar-commit'),
              `${from} → 測る で確定欄が踏み消された`,
            ).toContainText('測量を終える');
            await page.getByTestId('survey-toggle').click();
          } else {
            await page.getByTestId(`tool-${to}`).click();
            await expect(page.getByTestId('app-active-tool')).toHaveText(to);
            // 地物は選ばれたまま ―― その名前が対象欄に出ていなければならない。
            await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
            await expect(
              page.getByTestId('option-bar-target'),
              `${from} → ${to} で対象欄が「（選んでいません）」で固まった`,
            ).not.toHaveText('（選んでいません）');
          }
        }
      }
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し 2 回目 (4) — 道具を構えても「≫」が設定欄からこぼれない', () => {
  test('面・分ける・測る を構えた 1024〜1280px で「≫」が設定欄の中に完全に見える', async () => {
    // **旧版の壊れ方**: 畳みの予算は「次の一手」に 160px を見込むのに、実際の
    // 「次の一手」は `flex: 1 1 auto` で **基準幅に比例して**縮むので 189〜204px を取り、
    // 設定欄は予算より狭くなった。いちばん右の「≫」が欄の外へこぼれ、`overflow: hidden`
    // なので **見えないまま**格子・深さに手が届かなかった（1120px で「≫」が x 929〜953、
    // 設定欄の右端が 926）。
    //
    // **わざと壊すなら**: `shell.css` の `.option-bar__settings` を `flex: 0 1 auto` へ
    // 戻すか、`OptionBar.tsx` の `box.style.maxWidth` の代入を外す。
    const { app, page } = await launchApp();
    try {
      await leaveViewMode(page);
      for (const arm of ['add.area', 'edit.knife', 'survey'] as const) {
        if (arm === 'survey') await page.getByTestId('survey-toggle').click();
        else await page.getByTestId(`tool-${arm}`).click();

        for (const width of [1024, 1060, 1120, 1200, 1280]) {
          await page.setViewportSize({ width, height: 800 });
          await settleLayout(page, 'option-bar-settings');

          const report = await page.evaluate(() => {
            const box = document.querySelector('[data-testid="option-bar-settings"]');
            if (box === null) throw new Error('設定欄が無い');
            const frame = box.getBoundingClientRect();
            const escapees: { id: string; left: number; right: number }[] = [];
            for (const el of Array.from(box.querySelectorAll('[data-testid]'))) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              if (r.left < frame.left - 1 || r.right > frame.right + 1) {
                escapees.push({
                  id: el.getAttribute('data-testid') ?? '?',
                  left: Math.round(r.left),
                  right: Math.round(r.right),
                });
              }
            }
            return {
              frame: { left: Math.round(frame.left), right: Math.round(frame.right) },
              escapees,
            };
          });
          expect(
            report.escapees,
            `${arm} を構えた窓幅 ${width} で設定欄（${report.frame.left}〜` +
              `${report.frame.right}）からはみ出した部品: ${JSON.stringify(report.escapees)}`,
          ).toEqual([]);

          // 「≫」が出ているなら、**その上でいちばん手前に居るのは「≫」自身**で、
          // 押せば畳んだ中身に手が届く。
          const overflow = page.getByTestId('option-bar-overflow');
          if ((await overflow.count()) === 0) continue;
          expect(
            await topmostTestIdOver(page, 'option-bar-overflow'),
            `${arm} / ${width}px で「≫」が別の層に覆われている`,
          ).toBe('option-bar-overflow');
          await overflow.click();
          await expect(page.getByTestId('option-bar-overflow-panel')).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('option-bar-overflow-panel')).toBeHidden();
        }

        await page.setViewportSize({ width: 1280, height: 800 });
        if (arm === 'survey') await page.getByTestId('survey-toggle').click();
        else await page.getByTestId('tool-edit.select').click();
      }
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し 2 回目 (5) — 対象を離しても元の選択は残り、確定できる点列は聞いてから捨てる', () => {
  test('分ける・輪郭・穴あけ: 対象を離しても、道具の外で選んでいた地物は選ばれたまま', async () => {
    // 設計書 §D.4.1 の表「対象を離す／元からの選択: **保つ**」。結ぶ・所属は元から
    // 保っていたが、この 3 つは対象を離すと選択が `null` になっていた。
    const { app, page } = await launchApp();
    try {
      // 重ならない位置に 2 つ描く（FR-29）。
      await armAddAreaTool(page);
      const box = await addInputLayerBox(page);
      const half = Math.round(Math.min(box.width, box.height) * 0.14);
      const leftX = box.x + box.width * 0.28;
      const rightX = box.x + box.width * 0.72;
      const midY = box.y + box.height * 0.5;
      const firstId = await drawFace(page, squareCorners(leftX, midY, half), { name: 'X' });
      await armAddAreaTool(page);
      await drawFace(page, squareCorners(rightX, midY, half), { name: 'Y' });

      for (const tool of ['edit.knife', 'edit.ring', 'edit.drill'] as const) {
        // 「選択」で X を選んでおく（＝道具の外で選んだもの）。
        await page.getByTestId('tool-edit.select').click();
        await page.mouse.click(leftX, midY);
        await expect(page.getByTestId('app-active-feature')).toHaveText(firstId);

        // 道具を構えて、別の面 Y を対象に押す（対象は選択へ昇格する）。
        await page.getByTestId(`tool-${tool}`).click();
        await page.mouse.click(rightX, midY);
        await expect(page.getByTestId('app-active-feature')).not.toHaveText(firstId);

        // Escape で対象を離すと、**元からの選択 X へ戻る**（`null` にはならない）。
        await page.keyboard.press('Escape');
        await expect(
          page.getByTestId('app-active-feature'),
          `${tool} が対象を離したときに元からの選択を捨てた`,
        ).toHaveText(firstId);
        await expect(page.getByTestId('app-active-tool')).toHaveText(tool);
      }
    } finally {
      await app.close();
    }
  });

  test('輪郭 4 点・穴あけ 4 点: 持ち替えでも鍵でも Escape でも、確認なしには捨てない', async () => {
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);

      for (const tool of ['edit.ring', 'edit.drill'] as const) {
        const prefix = tool === 'edit.ring' ? 'ring-edit-draft-discard' : 'drill-draft-discard';
        const countId = tool === 'edit.ring' ? 'ring-edit-vertex-count' : 'drill-vertex-count';
        await page.getByTestId(`tool-${tool}`).click();
        await page.mouse.click(cx, cy); // 対象の面を掴む
        // 面の内側に 4 点（確定できる点数を超える）。
        await page.mouse.click(cx - 40, cy - 40);
        await page.mouse.click(cx + 40, cy - 40);
        await page.mouse.click(cx + 40, cy + 40);
        await page.mouse.click(cx - 40, cy + 40);
        await expect(page.getByTestId(countId)).toHaveText('4');

        const confirm = page.getByTestId(`${prefix}-confirm`);

        // ---- 持ち替え: 板が出て、答えるまで切替先を構えない。
        await page.getByTestId('tool-edit.select').click();
        await expect(confirm, `${tool} の 4 点が確認なしで捨てられた`).toBeVisible();
        await expect(page.getByTestId('app-active-tool')).toHaveText(tool);
        await page.getByTestId(`${prefix}-no`).click();
        await expect(confirm).toHaveCount(0);
        await expect(page.getByTestId(countId)).toHaveText('4');

        // ---- 鍵: 同じ板が出て、答えるまで「読むだけ」にならない。
        await page.getByTestId('mode-view').click();
        await expect(confirm).toBeVisible();
        await expect(page.getByTestId('app-mode')).toHaveText('edit');
        await page.getByTestId(`${prefix}-no`).click();
        await expect(confirm).toHaveCount(0);
        await expect(page.getByTestId(countId)).toHaveText('4');

        // ---- Escape: 板が出て、もう 1 回の Escape で捨てる（輪にならない＝教訓 5.70）。
        await page.keyboard.press('Escape');
        await expect(confirm).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(confirm).toHaveCount(0);
        await expect(page.getByTestId(countId)).toHaveText('0');

        // Escape を連打すれば必ず素の状態へ戻る（設計書 §D.4 の保証）。
        for (let i = 0; i < 6; i += 1) await page.keyboard.press('Escape');
        await expect(page.getByTestId('app-active-tool')).toHaveText('');
      }
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 増分 5 の手直し 3 回目（2026-09-06）
// ---------------------------------------------------------------------------

/** 「捨てますか」の板を出している道具ごとの `data-testid` の頭。 */
const DISCARD_PREFIX: Readonly<Record<string, string>> = {
  'add.area': 'add-draft-discard',
  'edit.knife': 'knife-draft-discard',
  'edit.ring': 'ring-edit-draft-discard',
  'edit.drill': 'drill-draft-discard',
};

/** その道具の下書きの点数を返す観測口。 */
const DRAFT_COUNT_ID: Readonly<Record<string, string>> = {
  'add.area': 'add-vertex-count',
  'edit.knife': 'knife-cut-count',
  'edit.ring': 'ring-edit-vertex-count',
  'edit.drill': 'drill-vertex-count',
};

/**
 * 確定できる点数まで打った下書きを、その道具で作る。戻り値は打てた点の数。
 *
 * 追加の道具は面の 4 隅、手順のある 3 道具は対象を掴んでから点を打つ。座標は
 * `commitOneFace` が作った面の中心から解く（固定 px で書かない＝増分 1 の教訓）。
 */
async function armWithCommittableDraft(
  page: Page,
  tool: string,
  cx: number,
  cy: number,
): Promise<string> {
  if (tool === 'add.area') {
    await armAddAreaTool(page);
    const box = await addInputLayerBox(page);
    await placeVertices(
      page,
      squareCorners(box.x + box.width * 0.78, box.y + box.height * 0.28, 40),
    );
  } else {
    await page.getByTestId(`tool-${tool}`).click();
    await page.mouse.click(cx, cy); // 対象を掴む
    if (tool === 'edit.knife') {
      await page.mouse.click(cx - 200, cy);
      await page.mouse.click(cx + 200, cy);
    } else {
      await page.mouse.click(cx - 40, cy - 40);
      await page.mouse.click(cx + 40, cy - 40);
      await page.mouse.click(cx, cy + 40);
    }
  }
  const count = page.getByTestId(DRAFT_COUNT_ID[tool]!);
  await expect(count).not.toHaveText('0');
  return (await count.textContent()) ?? '';
}

test.describe('手直し 3 回目 (1) — 板が出ているあいだ、道具の打鍵は Escape だけが通る', () => {
  test('4 道具 × 持ち替え・鍵 で、板の中の Ctrl+Z / Enter / Delete が下書きに届かない', async () => {
    // **旧版の壊れ方**: 各道具の keydown は **Escape のときだけ**板を見ていた。実測で
    // 4 道具 × 3 理由の 12 通りすべて、板の中の `Ctrl+Z` が頂点を 1 つ減らし
    // （面 3→2・分断線 2→1・輪郭 3→2・穴あけ 3→2）、面の道具は `Enter` で形が確定して
    // 素性入力へ進んだ ―― しかも状態行は「『元に戻す』はいま使えません。確認に答えてから、
    // もう一度押してください。」と言う。**画面が嘘をつき、［続ける］でも減った点は戻らない。**
    //
    // **わざと壊すなら**: `confirmBlocksToolKey` の関門を道具の keydown の入口から外す。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      for (const tool of ['add.area', 'edit.knife', 'edit.ring', 'edit.drill'] as const) {
        for (const reason of ['tool', 'lock'] as const) {
          await page.getByTestId('tool-edit.select').click();
          await answerDraftDiscardIfAsked(page, 'yes');
          const before = await armWithCommittableDraft(page, tool, cx, cy);

          if (reason === 'tool') await page.getByTestId('tool-edit.move').click();
          else await page.getByTestId('mode-view').click();

          const prefix = DISCARD_PREFIX[tool]!;
          const confirm = page.getByTestId(`${prefix}-confirm`);
          await expect(confirm, `${tool} / ${reason} で板が出ない`).toBeVisible();

          for (const key of ['Control+z', 'Enter', 'Delete', 'Backspace']) {
            await page.keyboard.press(key);
            await expect(
              page.getByTestId(DRAFT_COUNT_ID[tool]!),
              `${tool} / ${reason} で板の中の ${key} が下書きに届いた`,
            ).toHaveText(before);
            await expect(confirm, `${tool} / ${reason} の ${key} で板が閉じた`).toBeVisible();
            // 面の道具は Enter で形が確定して素性入力へ進んでいた ―― 進んでいないこと。
            await expect(page.getByTestId('add-property-form')).toHaveCount(0);
          }

          // ［続ける］で戻ったら、打った点はそのまま残っている。
          await page.getByTestId(`${prefix}-no`).click();
          await expect(confirm).toHaveCount(0);
          await expect(page.getByTestId(DRAFT_COUNT_ID[tool]!)).toHaveText(before);
        }
      }
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し 3 回目 (2) — ［続ける］の後も板の中も、帯は元の道具のもの', () => {
  test('分ける・輪郭・穴あけ × 選ぶ・鍵 で、対象欄・次の一手・確定欄が戻る', async () => {
    // **旧版の壊れ方**: 板を出すときに元の道具へ戻しても、そのあいだに次の持ち主
    // （`ToolOptionBar`）が帯を持ち直して中身を空へ戻していた。元の道具は自分の状態が
    // 変わっていないので押し直さず、**道具も点も残っているのに対象欄が
    // 「（選んでいません）」のまま固まった**（1.5 秒後も、1 点足しても戻らない）。
    //
    // **わざと壊すなら**: `option-bar.ts` の `subscribeOwner` の報せを止めるか、
    // 押し込みの effect の依存から `optionBarEpoch` を外す。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      const target = page.getByTestId('option-bar-target');
      const nextStep = page.getByTestId('option-bar-next-step');
      const commit = page.getByTestId('option-bar-commit');

      for (const tool of ['edit.knife', 'edit.ring', 'edit.drill'] as const) {
        for (const reason of ['tool', 'lock'] as const) {
          await page.getByTestId('tool-edit.select').click();
          await answerDraftDiscardIfAsked(page, 'yes');
          await armWithCommittableDraft(page, tool, cx, cy);

          const beforeTarget = (await target.textContent()) ?? '';
          const beforeNext = (await nextStep.textContent()) ?? '';
          const beforeCommit = (await commit.textContent()) ?? '';
          expect(beforeTarget, `${tool} の対象欄が最初から空`).not.toBe('（選んでいません）');

          if (reason === 'tool') await page.getByTestId('tool-edit.select').click();
          else await page.getByTestId('mode-view').click();

          const prefix = DISCARD_PREFIX[tool]!;
          await expect(page.getByTestId(`${prefix}-confirm`)).toBeVisible();

          // ---- 板が出ているあいだも帯は **元の道具のもの**である。
          await expect(target, `${tool} / ${reason}: 板中の対象欄が選ぶのもの`).toHaveText(
            beforeTarget,
          );
          await expect(nextStep, `${tool} / ${reason}: 板中の次の一手が選ぶのもの`).toHaveText(
            beforeNext,
          );
          await expect(commit, `${tool} / ${reason}: 板中の確定欄が選ぶのもの`).toHaveText(
            beforeCommit,
          );

          // ---- ［続ける］の後も同じ。
          await page.getByTestId(`${prefix}-no`).click();
          await expect(page.getByTestId(`${prefix}-confirm`)).toHaveCount(0);
          await expect(target, `${tool} / ${reason}: ［続ける］の後に対象欄が戻らない`).toHaveText(
            beforeTarget,
          );
          await expect(nextStep).toHaveText(beforeNext);
          await expect(commit).toHaveText(beforeCommit);
          await expect(page.getByTestId('app-active-tool')).toHaveText(tool);
        }
      }
    } finally {
      await app.close();
    }
  });
});

test.describe('手直し 3 回目 (3)(4) — 素性入力の局面は、聞き方も文も道具で揃う', () => {
  test('穴あけも素性入力中の持ち替え・鍵では聞かない（ナイフと同じ）', async () => {
    // **旧版の壊れ方**: 穴あけの `hasCommittableDraft` が `region.length >= 3` で、
    // `region` は素性を入力している局面でも確定済みの形として生きている。だから
    // **穴あけだけ**素性入力中の持ち替え・鍵で板が出た（ナイフは出ない）。設計書 §D.4.1 の
    // 「聞くのは点を打っている最中だけ」と、配下 README の B-3 に合わせる。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      for (const tool of ['edit.knife', 'edit.drill'] as const) {
        await page.getByTestId('tool-edit.select').click();
        await answerDraftDiscardIfAsked(page, 'yes');
        await page.getByTestId(`tool-${tool}`).click();
        await page.mouse.click(cx, cy);
        if (tool === 'edit.knife') {
          await page.mouse.click(cx - 200, cy);
          await page.mouse.click(cx + 200, cy);
          await page.getByTestId('knife-confirm-cut').click();
          await page.getByTestId('knife-confirm-inheritor').click();
        } else {
          await page.mouse.click(cx - 40, cy - 40);
          await page.mouse.click(cx + 40, cy - 40);
          await page.mouse.click(cx, cy + 40);
          await page.getByTestId('drill-confirm').click();
        }
        await expect(page.getByTestId('add-name')).toBeVisible();

        // 素性を入力している局面での持ち替え ―― **聞かずに畳む**（アプリ自身の再武装が
        // 確認待ちで止まらないようにするための限定。両方の道具で同じ）。
        await page.getByTestId('tool-edit.select').click();
        await expect(
          page.getByTestId(`${DISCARD_PREFIX[tool]!}-confirm`),
          `${tool} が素性入力中の持ち替えで聞いた`,
        ).toHaveCount(0);
        await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      }
    } finally {
      await app.close();
    }
  });

  test('素性入力中の Escape で出る板の文は、分けると穴あけで同じ', async () => {
    // 局面が同じなら同じ文（設計書 §H の文言の作法）。旧版はナイフが「打ちかけの入力が
    // あります。」、穴あけが「描きかけの頂点が 3 個あります。」で、穴あけだけ **失われる
    // のが頂点だと読める**文になっていた（実際に失われるのは打ちかけの名前である）。
    const { app, page } = await launchApp();
    try {
      const { cx, cy } = await commitOneFace(page);
      const messages: string[] = [];
      for (const tool of ['edit.knife', 'edit.drill'] as const) {
        await page.getByTestId('tool-edit.select').click();
        await answerDraftDiscardIfAsked(page, 'yes');
        await page.getByTestId(`tool-${tool}`).click();
        await page.mouse.click(cx, cy);
        if (tool === 'edit.knife') {
          await page.mouse.click(cx - 200, cy);
          await page.mouse.click(cx + 200, cy);
          await page.getByTestId('knife-confirm-cut').click();
          await page.getByTestId('knife-confirm-inheritor').click();
        } else {
          await page.mouse.click(cx - 40, cy - 40);
          await page.mouse.click(cx + 40, cy - 40);
          await page.mouse.click(cx, cy + 40);
          await page.getByTestId('drill-confirm').click();
        }
        await page.getByTestId('add-name').fill('打ちかけ');
        await page.keyboard.press('Escape');
        const confirm = page.getByTestId(`${DISCARD_PREFIX[tool]!}-confirm`);
        await expect(confirm).toBeVisible();
        messages.push(((await confirm.textContent()) ?? '').trim());
        await page.getByTestId(`${DISCARD_PREFIX[tool]!}-yes`).click();
        await expect(confirm).toHaveCount(0);
      }
      expect(messages[0], '素性入力の板の文が道具で違う').toBe(messages[1]);
      expect(messages[0]).toContain('打ちかけの入力があります');
    } finally {
      await app.close();
    }
  });
});
