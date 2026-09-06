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

import { test, expect, type Page } from '@playwright/test';

import {
  commitOneFace,
  launchApp,
  leaveViewMode,
  openDepthOptions,
  returnToViewMode,
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
      // 「上端 = アプリバー 32 ＋ オプションバー 40」であることも確かめる。数字を
      // 直書きするのではなく、行そのものの実寸から組み立てる（数字の写しを作らない）。
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
      await page.getByTestId('survey-toggle').click();
      await openDepthOptions(page);
      expect(await readCamera(page), '深さ ▾ で地図が作り直された').toEqual(moved);
      await page.keyboard.press('Escape');

      // ---- ③ 右パネルの中身（タブの切替）を変える。
      await page.getByTestId('sidebar-tab-properties').click();
      expect(await readCamera(page), '右パネルの切替で地図が作り直された').toEqual(moved);

      // ---- ④ 窓の大きさを変える。**カメラは保つ**（大きさが変わってもマウントは同じ）。
      await page.setViewportSize({ width: 1024, height: 700 });
      await page.waitForTimeout(300);
      const afterResize = await readCamera(page);
      expect(afterResize.zoom, '窓を変えたらズームが既定へ戻った').toBe(moved.zoom);
      expect(afterResize.panX, '窓を変えたら位置が既定へ戻った').toBe(moved.panX);
      expect(afterResize.panY, '窓を変えたら位置が既定へ戻った').toBe(moved.panY);
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

      // 「選ぶ」へ戻すと道具は外れる（＝素の状態）。
      await page.getByTestId('tool-edit.select').click();
      await expect(page.getByTestId('app-active-tool')).toHaveText('');
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
