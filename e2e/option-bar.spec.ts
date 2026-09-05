// オプションバー（設計書 §C.4）の器と、K-3 の機械検査。
//
// **なぜ E2E なのか**: K-3 が守りたいのは「選択のたびに地図が上下にずれない」ことで、
// 検査対象は `map-area` の実寸でなければならない。jsdom はレイアウトを持たず
// `getBoundingClientRect()` が常に 0 を返すので、単体テストで矩形を比べても中身に関わらず
// 一致し、**常に緑になって何も守らない**（設計書 §O の B-13 が「① と ② の矩形を測る」旧案を
// 却下したのと同じ理由が、そのまま「jsdom で測る」にも当てはまる）。CSS の宣言そのものは
// `src/ui/shell/shell-layout.test.ts` が固定し、ここは実寸を見る。
//
// 併せて T-3 / 結合点 #1 の確認をここに置く: **シェルに行を 1 本足したあとも**
// `data-zoom` / `data-pan-x` / `data-pan-y` が同じ要素（map-canvas-mount の兄弟である
// map-input-layer）に付いていること。ここが崩れると 11 ファイルの pan/zoom 検証が
// **例外も警告も出さずに** 壊れる。

import { test, expect, type Page } from '@playwright/test';

import { launchApp, commitOneFace, enterEditMode } from './helpers';

/** 地図セルの実寸。K-3 の検査対象はここ（帯そのものではない）。 */
async function mapAreaRect(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const box = await page.getByTestId('map-area').boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test.describe('オプションバーの枠（設計書 §C.4）', () => {
  test('全幅 × 40px 固定の行として、地図セルの外に存在する', async () => {
    const { app, page } = await launchApp();
    try {
      const bar = page.getByTestId('option-bar');
      await expect(bar).toBeVisible();

      const barBox = (await bar.boundingBox())!;
      const shellBox = (await page.getByTestId('app-shell').boundingBox())!;

      // 高さ 40px 固定（設計書 §C.4）。実測は端末の表示倍率で 1px 未満の端数が出るので
      // 丸めて比べる（39.99999… で落ちても意味がない）。
      expect(Math.round(barBox.height)).toBe(40);
      // 全幅（シェルと同じ幅・同じ左端）。
      expect(Math.round(barBox.width)).toBe(Math.round(shellBox.width));
      expect(Math.round(barBox.x)).toBe(Math.round(shellBox.x));

      // 地図セルの **外**（帯の下端が地図セルの上端以下）。地図に重なる部品ではないので
      // K-2 の事故（クリックを奪う）が構造的に起こり得ない。
      const mapBox = await mapAreaRect(page);
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(mapBox.y + 1);
    } finally {
      await app.close();
    }
  });

  test('5 区画が全部あり、既定の中身が出る（対象欄は 0 件でも枠が残る）', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('option-bar-tool')).toHaveText('✦ 選ぶ');
      await expect(page.getByTestId('option-bar-target')).toHaveText('（選んでいません）');
      await expect(page.getByTestId('option-bar-next-step')).toHaveText('地図か台帳から地物を選ぶ');
      // 増分 4: 設定欄には **「表示 ▾」が常設** で載る（道具に属さない部品なので、
      // 道具を持っていなくても・読むだけでも使える）。だから「（設定なし）」はもう出ない。
      const settings = page.getByTestId('option-bar-settings');
      await expect(settings).not.toHaveText('（設定なし）');
      await expect(settings.getByTestId('option-display-button')).toHaveText('表示 ▾');
      // 確定欄は「確定の要らない道具」のとき空。枠だけが残る（設計書 §B.4）。
      const commit = page.getByTestId('option-bar-commit');
      await expect(commit).toBeAttached();
      expect(((await commit.textContent()) ?? '').trim()).toBe('');

      // 固定幅 3 区画の実寸（112 / 240 / 176）。
      expect(Math.round((await page.getByTestId('option-bar-tool').boundingBox())!.width)).toBe(112);
      expect(Math.round((await page.getByTestId('option-bar-target').boundingBox())!.width)).toBe(
        240,
      );
      expect(Math.round((await commit.boundingBox())!.width)).toBe(176);
    } finally {
      await app.close();
    }
  });
});

test.describe('K-3 の機械検査 — 地図セルの矩形は選択・道具・対象欄の中身で動かない', () => {
  test('地物を選ぶ前後・道具を持ち替える前後・対象欄が 0 件から 1 件になる前後で map-area の矩形が完全一致する', async () => {
    const { app, page } = await launchApp();
    try {
      const atBoot = await mapAreaRect(page);

      // --- (1) 道具を持ち替える前後 -----------------------------------------
      // commitOneFace は 表示専用 → 追加モード → 面ツール → 確定 まで通る（＝道具の
      // 持ち替えを含む）。確定後は新しい地物が選択された状態になる（教訓 5.11）。
      const { faceId, cx, cy } = await commitOneFace(page);
      const afterToolSwitch = await mapAreaRect(page);
      expect(afterToolSwitch).toEqual(atBoot);

      // --- (2) 地物を選ぶ前後 -------------------------------------------------
      await enterEditMode(page);
      const mapBox = (await page.getByTestId('map-input-layer').boundingBox())!;
      const activeFeature = page.getByTestId('app-active-feature');

      // 空白クリックで選択を外す（0 件）。
      await page.mouse.click(mapBox.x + 40, mapBox.y + mapBox.height - 40);
      await expect(activeFeature).toHaveText('');
      const withoutSelection = await mapAreaRect(page);

      // 面の本体をクリックして選ぶ（1 件）。
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      const withSelection = await mapAreaRect(page);

      expect(withSelection).toEqual(withoutSelection);
      expect(withSelection).toEqual(atBoot);

      // --- (3) 対象欄が 0 件から 1 件になる前後 -------------------------------
      // 増分 1 の時点では対象欄へ押し込む道具がまだ無いので、DOM へ直接いちばん長い
      // 中身を差し込んで「枠が中身に押し広げられないこと」を実寸で確かめる。中身を
      // 増やしても外寸が動かない、が K-3 の本体である。
      const injected = await page.evaluate(() => {
        const target = document.querySelector('[data-testid="option-bar-target"]');
        const commit = document.querySelector('[data-testid="option-bar-commit"]');
        const next = document.querySelector('[data-testid="option-bar-next-step"]');
        if (target === null || commit === null || next === null) return false;
        target.textContent =
          '手順 2/3 ヴィオニア大陸付近の領域01 → 親: ラヴィエンド・ウィル同君王国（とても長い名前）';
        next.textContent =
          '新しい上位領域を台帳から選ぶか、［新しく作る］［最上位へ］を押してください。'.repeat(4);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'option-bar__commit-button';
        button.textContent = '所属を変える';
        commit.appendChild(button);
        return true;
      });
      expect(injected).toBe(true);

      const afterTargetFilled = await mapAreaRect(page);
      expect(afterTargetFilled).toEqual(atBoot);

      // 帯そのものも 40px のまま（折り返して 2 段にならない）。
      const barBox = (await page.getByTestId('option-bar').boundingBox())!;
      expect(Math.round(barBox.height)).toBe(40);
      // 固定幅の枠が中身で広がっていない。
      expect(Math.round((await page.getByTestId('option-bar-target').boundingBox())!.width)).toBe(
        240,
      );
      expect(Math.round((await page.getByTestId('option-bar-commit').boundingBox())!.width)).toBe(
        176,
      );
    } finally {
      await app.close();
    }
  });
});

test.describe('T-3 / 結合点 #1 — 行を足しても地図セルの入れ子は崩れていない', () => {
  test('data-zoom / data-pan-x / data-pan-y が map-canvas-mount の兄弟 map-input-layer に付いている', async () => {
    const { app, page } = await launchApp();
    try {
      const attached = await page.evaluate(() => {
        const mount = document.querySelector('[data-testid="map-canvas-mount"]');
        const cell = mount?.parentElement ?? null;
        const layer = cell?.querySelector('[data-testid="map-input-layer"]') ?? null;
        return {
          // 地図セルは .map-area のまま（オプションバー行はこの外側のシェル行）。
          cellTestid: cell?.getAttribute('data-testid') ?? null,
          // 入力層は取付要素の「兄弟」である。
          isSibling: layer !== null && layer.parentElement === cell,
          zoom: layer?.getAttribute('data-zoom') ?? null,
          panX: layer?.getAttribute('data-pan-x') ?? null,
          panY: layer?.getAttribute('data-pan-y') ?? null,
          // オプションバーは地図セルの中に入っていない（K-2 / K-4）。
          optionBarInsideMap: cell?.querySelector('[data-testid="option-bar"]') !== null,
        };
      });

      expect(attached.cellTestid).toBe('map-area');
      expect(attached.isSibling).toBe(true);
      expect(attached.optionBarInsideMap).toBe(false);

      // 値が付いていること（フォールバックすると付かない＝静かに壊れる）。
      //
      // **以前の検査は空振りだった**（B4）。`Number.isFinite(Number(attached.zoom))` は
      // 属性が **無い**（`getAttribute` が null）ときも `Number(null) === 0` で真になるので、
      // 属性が丸ごと消えても緑のままだった。守りたいのは「属性が在って、数として読める
      // 文字列が入っている」ことなので、null を先に弾き、数値の形も見る
      // （開発ガイド §5.49「わざと壊して赤くなるか」を満たすための最低条件）。
      for (const [name, raw] of [
        ['data-zoom', attached.zoom],
        ['data-pan-x', attached.panX],
        ['data-pan-y', attached.panY],
      ] as const) {
        expect(
          raw,
          `${name} が付いていない（属性ごと消えると 11 ファイルの検証が静かに壊れる）`,
        ).not.toBeNull();
        expect(raw, `${name} が空文字`).not.toBe('');
        // 「12.5」「-3」「0」だけを通す（"abc" や "" は落ちる）。
        expect(raw!, `${name} が数の形をしていない: ${String(raw)}`).toMatch(
          /^-?\d+(\.\d+)?$/,
        );
        expect(Number.isFinite(Number(raw))).toBe(true);
      }
      // ズームは正の値（0 や負は「フォールバックで 0 を書いた」印）。
      expect(Number(attached.zoom)).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// K-3 の機械検査 その 2 — 窓幅・素性表示・タブ切替（B1 / B2 / B3）
// ---------------------------------------------------------------------------
//
// **増分 1 の検証で実機に出た 2 つの症状**をここで固定する。
//   ① 未保存の印「●」が付いた瞬間に、窓幅 1340 / 1500 で地図が 34px 飛ぶ
//      （素性表示の占有幅が中身で変わり、上部バーの折り返し段数が 1 つ増える）。
//   ② 「プロパティ」タブを押すと画面全体が 0.8px 左へずれて戻らない
//      （主行の列が `1fr` で、各セルの `min-width` が効いて行の合計が窓幅を超える）。
//
// **測る対象は「守りたいものが動かないこと」**（開発ガイド §5.49）。帯そのものではなく
// `map-area` の矩形を、**同じ窓幅の中で** 中身だけ変えて比べる。

/** 実データにある、いちばん長い部類のファイル名（素性表示の最悪ケース）。 */
const LONG_FILE_NAME = 'derle-world-full-2026-08-16.gimoza';

const WIDTHS = [800, 1280, 1340, 1500, 1600] as const;

/** アプリバーの素性表示の中身を DOM から差し替える（表示の最悪ケースを作る）。 */
async function setIdentityText(page: Page, fileName: string): Promise<void> {
  await page.evaluate((name) => {
    const file = document.querySelector('[data-testid="app-identity-file"]');
    if (file !== null) file.textContent = name;
  }, fileName);
}

test.describe('K-3 の機械検査 — 窓幅ごとに、素性表示の中身とタブ切替で地図が動かない', () => {
  test('未保存の印・長いファイル名・「プロパティ」タブの前後で map-area の矩形が完全一致する', async () => {
    const { app, page } = await launchApp();
    try {
      // 窓幅ごとの「素の」矩形をまず全部取る。
      const baseline = new Map<number, { x: number; y: number; width: number; height: number }>();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(150);
        baseline.set(width, await mapAreaRect(page));
      }

      // --- ① 長いファイル名を入れる（素性表示の中身がいちばん長い状態） --------
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(150);
        await setIdentityText(page, LONG_FILE_NAME);
        await page.waitForTimeout(80);
        expect(await mapAreaRect(page), `窓幅 ${width}: 長いファイル名で地図が動いた`).toEqual(
          baseline.get(width),
        );
      }

      // --- ② 未保存の印を実際に立てる（1 面を追加して確定する） ----------------
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(150);
      await commitOneFace(page);
      // ● は「枠は常にあり、中身だけ出入りする」形になっている（B1）。
      await expect(page.getByTestId('app-identity-dirty')).toHaveCount(1);
      await expect(page.getByTestId('app-identity-dirty-slot')).toHaveAttribute(
        'data-dirty',
        'true',
      );

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(150);
        await setIdentityText(page, LONG_FILE_NAME);
        await page.waitForTimeout(80);
        expect(
          await mapAreaRect(page),
          `窓幅 ${width}: 未保存の印が付いた瞬間に地図が動いた（実測 34px の再発）`,
        ).toEqual(baseline.get(width));
      }

      // --- ③ 「プロパティ」タブを押す前後（0.8px 左ずれの再発） ----------------
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(150);
        const before = await mapAreaRect(page);
        await page.getByTestId('sidebar-tab-properties').click();
        await page.waitForTimeout(150);
        expect(await mapAreaRect(page), `窓幅 ${width}: プロパティタブで地図が動いた`).toEqual(
          before,
        );
        await page.getByTestId('sidebar-tab-list').click();
        await page.waitForTimeout(150);
        expect(await mapAreaRect(page), `窓幅 ${width}: 一覧タブへ戻して地図が動いた`).toEqual(
          before,
        );
      }
    } finally {
      await app.close();
    }
  });

  test('表示倍率 1.25 でも主行が窓幅を超えない（0.8px の左ずれの根）', async () => {
    // **起動時にしか効かない条件**なので専用に立ち上げる。1280 の窓で
    // 「120 + 中央 + 220」が 1280.8px に解決され、画面全体が 0.8px 左へずれていた。
    const { app, page } = await launchApp({
      extraArgs: ['--force-device-scale-factor=1.25'],
    });
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(250);

      const before = await mapAreaRect(page);
      const overflow = await page.evaluate(() => ({
        dpr: window.devicePixelRatio,
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      }));
      // 横スクロールが生えない = 行の合計が窓幅に収まっている。
      expect(overflow.scrollW).toBeLessThanOrEqual(overflow.innerW);

      await page.getByTestId('sidebar-tab-properties').click();
      await page.waitForTimeout(200);
      expect(await mapAreaRect(page), '表示倍率 1.25 でタブを押すと画面がずれた').toEqual(before);
    } finally {
      await app.close();
    }
  });

  test('測量の ON / OFF は上部バーの段数を変える（既知の残り。OFF で必ず元へ戻る）', async () => {
    // **これは「動かない」ことの検査ではない。** 測量の可変表示（案内文・距離・座標の
    // 読み取り）はいまアプリバーに置かれていて、ON にすると段が増えて地図の上端が
    // 下がる（実測: 窓幅 1280 で 155.2 → 242）。設計書 §B.4 / §B.5 はこれを
    // 「個別フォーカスの 4 部品をアプリバーから降ろす（増分 5）」「確定部品を
    // オプションバーへ移す（増分 3-4）」で解くとしており、増分 1 の範囲ではない。
    //
    // ここで固定するのは **可逆であること**（OFF に戻したら矩形が寸分違わず戻る）である。
    // 残っている段差そのものは docs/現状.md に番号付きで記録してある。
    const { app, page } = await launchApp();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(200);
      const off = await mapAreaRect(page);

      await page.getByTestId('survey-toggle').click();
      await page.waitForTimeout(200);
      const on = await mapAreaRect(page);
      expect(on.y, '測量 ON で上部バーの段が増える（既知）').toBeGreaterThan(off.y);

      await page.getByTestId('survey-toggle').click();
      await page.waitForTimeout(200);
      expect(await mapAreaRect(page), '測量を OFF に戻したら矩形が元へ戻る').toEqual(off);
    } finally {
      await app.close();
    }
  });
});
