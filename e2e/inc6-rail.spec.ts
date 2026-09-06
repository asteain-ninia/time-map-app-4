// 増分 6「時刻レール（読む側だけ）」の受け入れを実アプリで押す。
//
// **jsdom では測れないものだけをここで測る**（教訓 5.49）。112px の内訳や畳みの段は
// CSS と純粋関数の契約テストが持っているので、ここが見るのは
//   ①実寸（帯 112px / 地図 912×588 / 操作列があふれない / レーンが 20px に縮む）
//   ②観測口（`window.__E2E__` の 3 口 と `app-edit-time`）
//   ③規模（5 万錨で 16ms・1ms・図形数 ≤ 画素数・錨表 25 行以下）
//   ④振る舞い（印を押すとその年へ／`[` `]` が端で止まる／再生中に再集計が走らない）
// の 4 つである。
//
// **可視の検査は矩形の交差で数える**（教訓 5.62: `toBeVisible()` は器の外へはみ出した
// 要素も真にする）。操作列のあふれは「区画の矩形と中の部品の矩形の突き合わせ」で見る
// （教訓 5.74: `scrollWidth` では `overflow: hidden` の区画は内寸と一致してしまう）。

import { expect, test, type Page } from '@playwright/test';

import { RAIL_STRINGS } from '../src/ui/timeline/rail-strings';

import {
  jumpToYear,
  launchApp,
  leaveViewMode,
  loadSyntheticAnchors,
  openPropertySection,
  railLaneStats,
  railMarkPositions,
  railView,
} from './helpers';

/** 窓の大きさを変えて、レイアウトが落ち着くまで待つ。 */
async function resizeWindow(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(150);
}

/** その要素が親の矩形からはみ出していないか（教訓 5.74 の検出）。 */
async function overflowingChildren(page: Page, containerTestId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const box = document.querySelector(`[data-testid="${id}"]`);
    if (box === null) return ['(器が無い)'];
    const outer = box.getBoundingClientRect();
    const out: string[] = [];
    for (const child of Array.from(box.children)) {
      const r = child.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // 1px の丸めは許す（表示倍率で端数が出る）。
      if (r.left < outer.left - 1 || r.right > outer.right + 1) {
        out.push(
          `${child.getAttribute('data-testid') ?? child.className.toString()} ` +
            `(${String(Math.round(r.left))}..${String(Math.round(r.right))} / ` +
            `器 ${String(Math.round(outer.left))}..${String(Math.round(outer.right))})`,
        );
      }
    }
    return out;
  }, containerTestId);
}

test.describe('増分 6 — 時刻レールの寸法（設計書 §C.7 / §B.4）', () => {
  test('帯は 112px で、1280×800 の地図は 912×588px（設計書の完了の定義）', async () => {
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1280, 800);
      const rail = (await page.getByTestId('timeline').boundingBox())!;
      expect(Math.round(rail.height)).toBe(112);

      const map = (await page.getByTestId('map-area').boundingBox())!;
      // 設計書 §C.7 の「地図が縦に +89.2px。1280×800 で地図が 912 × 588px」。
      // 実測は表示倍率の丸めで ±2px 動くので、その幅で押さえる。
      expect(Math.abs(map.width - 912)).toBeLessThanOrEqual(2);
      expect(Math.abs(map.height - 588)).toBeLessThanOrEqual(2);
    } finally {
      await app.close();
    }
  });

  test('4 段が上から順に並び、どれも重ならない', async () => {
    const { app, page } = await launchApp();
    try {
      const rows = ['rail-readout', 'rail-lane', 'timeline-ticks', 'rail-controls'];
      const boxes = [];
      for (const id of rows) boxes.push((await page.getByTestId(id).boundingBox())!);
      for (let i = 1; i < boxes.length; i += 1) {
        expect(boxes[i]!.y, `${rows[i]!} が ${rows[i - 1]!} より上に居る`).toBeGreaterThanOrEqual(
          boxes[i - 1]!.y + boxes[i - 1]!.height - 1,
        );
      }
      // 錨レーンと目盛りの軸は同じ内寸（印と目盛りがずれない）。
      const lane = (await page.getByTestId('rail-lane').boundingBox())!;
      const axis = (await page.getByTestId('rail-axis').boundingBox())!;
      expect(Math.abs(lane.width - axis.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(lane.x - axis.x)).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  test('窓幅 800〜1600 のどこでも操作列があふれない（畳みの段が効いている）', async () => {
    const { app, page } = await launchApp();
    try {
      for (const [width, fold] of [
        [1600, 'full'],
        [1440, 'full'],
        [1439, 'noHundred'],
        [1280, 'noHundred'],
        [1119, 'zoomMenu'],
        [960, 'zoomMenu'],
        [959, 'keysOnly'],
        [800, 'keysOnly'],
      ] as const) {
        await resizeWindow(page, width, 800);
        await expect(page.getByTestId('rail-controls')).toHaveAttribute('data-fold', fold);
        expect(
          await overflowingChildren(page, 'rail-controls'),
          `窓幅 ${String(width)}px で操作列からこぼれた`,
        ).toEqual([]);
        // **±1 の送り・年入力・再生はどの段でも残る**（§B.4）。
        await expect(page.getByRole('button', { name: '1年次へ進む' })).toBeVisible();
        await expect(page.getByLabel('直接ジャンプ 年', { exact: true })).toBeVisible();
        await expect(page.getByTestId('timeline-playback')).toBeVisible();
      }
      // **広げたら戻る**（教訓 5.69 の検出: 狭くする側だけ見るとこの欠陥は通る）。
      await resizeWindow(page, 1600, 800);
      await expect(page.getByTestId('rail-controls')).toHaveAttribute('data-fold', 'full');
      await expect(page.getByTestId('rail-step-100')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('落としたものは必ず「≫」から開ける（行＋≫＝全部。800〜1120px）', async () => {
    // 実測で **800〜959px では 10 年送りと再生速度が行にも「≫」にも無かった**
    // （届く手が 1 つも無い＝進捗 §2 の約束に反する）。段ごとに「行に出ていないものが
    // ≫ の中にある」ことを見る。
    const { app, page } = await launchApp();
    try {
      for (const width of [1120, 1000, 900, 800]) {
        await resizeWindow(page, width, 800);
        const inRow = async (id: string): Promise<boolean> =>
          (await page.getByTestId('rail-controls').locator(`[data-testid="${id}"]`).count()) > 0;
        const rowHas = {
          step100: await inRow('rail-step-100'),
          step10: await inRow('rail-step-10'),
          unit: await inRow('rail-unit'),
          ymd: await inRow('rail-ymd'),
          anchor: await inRow('rail-anchor-jump'),
          speed: await inRow('rail-speed'),
        };
        await page.getByTestId('rail-overflow-button').click();
        const panel = page.getByTestId('rail-overflow-panel');
        await expect(panel).toBeVisible();
        for (const [id, testId] of [
          ['step100', 'rail-step-100'],
          ['step10', 'rail-step-10'],
          ['unit', 'rail-unit'],
          ['ymd', 'rail-ymd'],
          ['anchor', 'rail-anchor-jump'],
          ['speed', 'rail-speed'],
        ] as const) {
          if (rowHas[id]) continue;
          expect(
            await panel.locator(`[data-testid="${testId}"]`).count(),
            `窓幅 ${String(width)}px で ${testId} が行にも ≫ にも無い`,
          ).toBe(1);
        }
        await page.keyboard.press('Escape');
      }
    } finally {
      await app.close();
    }
  });

  test('再生を押しても操作列の幅が動かない（畳みの予算が押すたびに崩れない）', async () => {
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1120, 800);
      const width = async (): Promise<number> =>
        Math.round((await page.getByTestId('timeline-playback').boundingBox())!.width);
      const stopped = await width();
      await page.getByRole('button', { name: '再生' }).click();
      await expect(page.getByRole('button', { name: '一時停止' })).toBeVisible();
      expect(await width(), '再生を押すと再生の区画の幅が変わった').toBe(stopped);
      expect(await overflowingChildren(page, 'rail-controls')).toEqual([]);
      await page.getByRole('button', { name: '一時停止' }).click();
    } finally {
      await app.close();
    }
  });

  test('窓高 700px 未満でレーンが 20px に縮み、地物を選んでも縮んだまま（K-3）', async () => {
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1280, 800);
      expect(Math.round((await page.getByTestId('rail-lane').boundingBox())!.height)).toBe(28);

      await resizeWindow(page, 1280, 660);
      const short = Math.round((await page.getByTestId('rail-lane').boundingBox())!.height);
      expect(short).toBe(20);

      // 選択状態では変わらない（畳みも縮みも窓の大きさだけで決まる）。
      await loadSyntheticAnchors(page, 5, { asAggregateChild: false });
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      expect(
        Math.round((await page.getByTestId('rail-lane').boundingBox())!.height),
      ).toBe(short);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 6 — 観測口（中身 8）', () => {
  test('`window.__E2E__` の 3 口と `app-edit-time` が生えている', async () => {
    const { app, page } = await launchApp();
    try {
      const stats = await railLaneStats(page);
      expect(stats.featureId).toBe('');
      expect(stats.anchorCount).toBe(0);

      const view = await railView(page);
      expect(view.pixelLength).toBeGreaterThan(100);
      expect(view.minYear).toBe(0);
      expect(view.maxYear).toBe(10000);
      expect(view.currentYear).toBe(0);
      expect(view.fold).toBe('noHundred');

      expect(await railMarkPositions(page)).toEqual([]);

      // 編集時刻バッジの隠し観測（既存の `app-active-feature` と同じ方式）。
      await expect(page.getByTestId('app-edit-time')).toHaveText(/0年/);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 6 — V11（選んだ地物の変化年が軸から読める）', () => {
  test('印の位置が錨の年と一致し、押すとその年へ 1 手で行ける', async () => {
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1280, 800);
      // 0 年・1 年・…・9 年に錨を持つ 1 地物（自分の履歴を持つ形）。
      await loadSyntheticAnchors(page, 10, { asAggregateChild: false });
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      const stats = await railLaneStats(page);
      expect(stats.anchorCount).toBe(10);
      expect(stats.inherited).toBe(false);
      // 0〜9 年は 1 万年の軸では同じ画素列に重なる（＝密度帯 1 本）。
      expect(stats.shapeCount).toBeGreaterThan(0);
      expect(stats.shapeCount).toBeLessThanOrEqual(stats.width);

      // レールを拡大すると、重なっていた錨がほどけて 1 本ずつの印になる。
      // **ホイールは押した位置の年を留めたまま寄せる**ので、錨の居る左端で回す
      // （中央で回すと 0〜9 年は視野の外へ出る ―― それが正しい振る舞いである）。
      const lane = (await page.getByTestId('anchor-lane').boundingBox())!;
      await page.mouse.move(lane.x + 0.5, lane.y + lane.height / 2);
      for (let i = 0; i < 25; i += 1) await page.mouse.wheel(0, -100);
      await page.waitForTimeout(150);
      const zoomed = await railLaneStats(page);
      expect(zoomed.inView, '拡大したら錨が視野から消えた').toBeGreaterThan(1);
      expect(zoomed.markCount, '拡大しても印がほどけない').toBeGreaterThan(1);
      expect(zoomed.denseCount).toBe(0);

      // 印を押すとその年へ飛ぶ（狙った年へ 1 手）。
      const marks = await railMarkPositions(page);
      expect(marks.length).toBeGreaterThan(1);
      const target = marks[marks.length - 1]!;
      await page.mouse.click(lane.x + target + 0.5, lane.y + lane.height / 2);
      const after = await railView(page);
      expect(after.currentYear).toBeGreaterThan(0);
      // **年の粒度が汚れない**（月日を作らない）。
      await expect(page.getByTestId('timeline-current')).toHaveText(/^\d+年$/);
    } finally {
      await app.close();
    }
  });

  test('まとめ役の子を選んでもレーンが空にならない（裁定 §N-15 の (A)）', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticAnchors(page, 20, { asAggregateChild: true });
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('list-shape-flat').click();
      await page.getByTestId('unified-list-filter').fill('合成の錨だらけ');
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      const stats = await railLaneStats(page);
      // **自分の履歴を持たないのにレーンは空でない**（親の系列から選り分けた）。
      expect(stats.inherited).toBe(true);
      expect(stats.anchorCount).toBeGreaterThan(0);
      // 借りていることを画面にも書く（設計書 §C.6）。
      await expect(page.getByTestId('anchor-lane-owner')).toHaveText(/合成のまとめ役/);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 6 — 規模（設計書 §F.2 の受け入れ条件）', () => {
  test('5 万錨で 再集計 16ms 以内・ヒットテスト 1ms 以内・図形数 ≤ 軸の画素数', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1280, 800);
      await loadSyntheticAnchors(page, 50_000, { asAggregateChild: false });
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      // 表示範囲を動かして **再集計を 1 回起こしてから** 測る（初回の値ではなく、
      // 契機 (b) が走ったときの値を見る）。
      const lane = (await page.getByTestId('anchor-lane').boundingBox())!;
      await page.mouse.move(lane.x + lane.width / 2, lane.y + lane.height / 2);
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(120);

      const stats = await railLaneStats(page);
      expect(stats.anchorCount).toBe(50_000);
      expect(stats.shapeCount).toBeLessThanOrEqual(stats.width);
      expect(
        stats.lastAggregateMs,
        `再集計 ${String(stats.lastAggregateMs)}ms`,
      ).toBeLessThanOrEqual(16);

      // ヒットテスト（押した 1 回ぶん）。
      await page.mouse.click(lane.x + lane.width / 2, lane.y + lane.height / 2);
      await page.waitForTimeout(80);
      const afterHit = await railLaneStats(page);
      expect(
        afterHit.lastHitTestMs,
        `ヒットテスト ${String(afterHit.lastHitTestMs)}ms`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  test('まとめ役の子でも同じ（系列を引く経路が違うので別に測る）', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1280, 800);
      await loadSyntheticAnchors(page, 50_000, { asAggregateChild: true });
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('list-shape-flat').click();
      await page.getByTestId('unified-list-filter').fill('合成の錨だらけ');
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      const lane = (await page.getByTestId('anchor-lane').boundingBox())!;
      await page.mouse.move(lane.x + lane.width / 2, lane.y + lane.height / 2);
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(200);

      const stats = await railLaneStats(page);
      expect(stats.inherited).toBe(true);
      expect(stats.shapeCount).toBeLessThanOrEqual(stats.width);
      expect(
        stats.lastAggregateMs,
        `まとめ役の子の再集計 ${String(stats.lastAggregateMs)}ms`,
      ).toBeLessThanOrEqual(16);
    } finally {
      await app.close();
    }
  });

  test('再生中にレーンの再集計が走らない（規則 4 の契機は 3 つだけ）', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticAnchors(page, 2000, { asAggregateChild: false });
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      const before = await railLaneStats(page);

      await page.getByRole('button', { name: '再生' }).click();
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: '一時停止' }).click();

      const after = await railLaneStats(page);
      expect(after.aggregateCount, '再生で再集計が走った').toBe(before.aggregateCount);
      // **素材づくりも走らない**（2026-09-07 の手直し。GPT の指摘）。再集計だけを見ていると、
      // 「集計はしていないが親の系列を毎コマ引き直している」経路を見逃す ―― 費用が
      // 大きいのは素材づくりのほうである（教訓 5.78 の 2 つの契機）。
      expect(after.sourceCount, '再生で素材づくりが走った').toBe(before.sourceCount);
      // 時刻は実際に動いている（＝再生そのものは効いている）。
      expect((await railView(page)).currentYear).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 6 — 鍵盤と断り（中身 3・4・7）', () => {
  test('`[` `]` で前後の錨へ飛び、端では止まって理由が出る', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticAnchors(page, 5, { asAggregateChild: false });
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
      // **地図を押して焦点を移さない** ―― 何も無いところを押すと選択が外れる（U22）ので、
      // 錨ジャンプの相手が消えてしまう。大域の割り振りは一覧の行（ボタン）に焦点が
      // あっても効く（`[` は空白でも文字でもない）。

      // 0 年に居るので、次の錨（1 年）へ。
      await page.keyboard.press(']');
      await expect(page.getByTestId('timeline-current')).toHaveText('1年');
      await page.keyboard.press('[');
      await expect(page.getByTestId('timeline-current')).toHaveText('0年');
      // 端では **止まって理由を出す**（黙って何も起きない、を作らない）。
      await page.keyboard.press('[');
      await expect(page.getByTestId('timeline-current')).toHaveText('0年');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        RAIL_STRINGS.noPreviousAnchor,
      );
    } finally {
      await app.close();
    }
  });

  test('`,` `.` と修飾で 1・10・100 年送り、Alt+← で直前の年へ戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('map-input-layer').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('.');
      await expect(page.getByTestId('timeline-current')).toHaveText('1年');
      await page.keyboard.press('Shift+.');
      await expect(page.getByTestId('timeline-current')).toHaveText('11年');
      await page.keyboard.press('Control+.');
      await expect(page.getByTestId('timeline-current')).toHaveText('111年');
      await page.keyboard.press(',');
      await expect(page.getByTestId('timeline-current')).toHaveText('110年');
      // 直前にいた年へ戻る。
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(page.getByTestId('timeline-current')).toHaveText('111年');
    } finally {
      await app.close();
    }
  });

  test('Ctrl+G で年の欄へ焦点が入り、Enter で確定する', async () => {
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('map-input-layer').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+g');
      const field = page.getByLabel('直接ジャンプ 年', { exact: true });
      await expect(field).toBeFocused();
      await field.fill('1234');
      await field.press('Enter');
      await expect(page.getByTestId('timeline-current')).toHaveText('1234年');
    } finally {
      await app.close();
    }
  });

  test('Space で再生／一時停止（焦点のあるボタンの空白は奪わない）', async () => {
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('map-input-layer').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press(' ');
      await expect(page.getByRole('button', { name: '一時停止' })).toBeVisible();
      await page.keyboard.press(' ');
      await expect(page.getByRole('button', { name: '再生' })).toBeVisible();

      // ボタンに焦点があるときの空白は **そのボタンが受ける**（1 回で 2 つ起きない）。
      const zoomFit = page.getByTestId('rail-zoom-fit');
      await zoomFit.focus();
      await page.keyboard.press(' ');
      await expect(page.getByRole('button', { name: '再生' })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('範囲外の年は丸めず、状態行に理由が出る（中身 7）', async () => {
    const { app, page } = await launchApp();
    try {
      const field = page.getByLabel('直接ジャンプ 年', { exact: true });
      await field.fill('20000');
      await page.getByRole('button', { name: 'ジャンプ', exact: true }).click();
      await expect(page.getByTestId('timeline-current')).toHaveText('0年');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        RAIL_STRINGS.outOfRange('20000年', '0年', '10000年'),
      );
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 6 — 地図セルの中の 3 部品（設計書 §B.5 の台帳 #10〜#12）', () => {
  test('ズーム・全体表示・縮尺バーが地図の中に出て、押せるのはボタンだけ', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('map-view-controls')).toBeVisible();
      await expect(page.getByTestId('map-scale-bar')).toBeVisible();

      // 地図セルの中に居る（矩形の交差で見る＝教訓 5.62）。
      const map = (await page.getByTestId('map-area').boundingBox())!;
      for (const id of ['map-view-controls', 'map-scale-bar']) {
        const b = (await page.getByTestId(id).boundingBox())!;
        expect(b.x, id).toBeGreaterThanOrEqual(map.x - 1);
        expect(b.x + b.width, id).toBeLessThanOrEqual(map.x + map.width + 1);
        expect(b.y + b.height, id).toBeLessThanOrEqual(map.y + map.height + 1);
      }

      // 縮尺バーは **押せない**（下の地図へ抜ける）。
      const bar = (await page.getByTestId('map-scale-bar').boundingBox())!;
      const under = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? '?',
        { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 },
      );
      expect(under).toBe('map-input-layer');

      // ズームは押せて、実際に倍率が動く（コマンドの登録簿を通る＝メニューと同じ 1 本）。
      const layer = page.getByTestId('map-input-layer');
      const before = Number(await layer.getAttribute('data-zoom'));
      await page.getByTestId('map-zoom-in').click();
      await page.waitForTimeout(120);
      expect(Number(await layer.getAttribute('data-zoom'))).toBeGreaterThan(before);
      await page.getByTestId('map-fit-all').click();
      await page.waitForTimeout(120);
      expect(Number(await layer.getAttribute('data-zoom'))).toBeLessThan(
        Number(await layer.getAttribute('data-zoom')) + 1,
      );
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 6 — 初回起動のガイド（FR-118 / 設計書 §H.3）', () => {
  test('4 枚出て、閉じられて、地図の押下を奪わない', async () => {
    // `launchApp` はガイドを畳んでから返すので、ここでは **設定を戻してから**見る。
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('first-run-guide')).toHaveCount(0);
      // 設定から出し直せる（「今後表示しない」を押したきりにならない）。
      await page.getByTestId('menu-tools').click();
      await page
        .getByTestId('menu-items-tools')
        .locator('[data-command="tools.settings"]')
        .click();
      await expect(page.getByTestId('settings-dialog')).toBeVisible();
      await expect(page.getByLabel('起動時にこの画面の使い方を表示する')).toBeChecked();
    } finally {
      await app.close();
    }
  });

  test('本番の初回起動で本当に出て、地図とズームの 3 ボタンに重ならない', async () => {
    // **`launchApp` の畳みを外して**、出るところから見る（2026-09-07 の手直し）。
    // 旧版の検査は「畳んだあと」しか見ていなかったので、**出るかどうか**は誰も
    // 見張っていなかった。置き場も実測で見る（矩形の交差＝教訓 5.62）―― 旧版は
    // 右パネルから地図セルへ 52px はみ出し、地図の中のズーム 3 ボタンを覆っていた。
    const { app, page } = await launchApp({ keepFirstRunGuide: true });
    try {
      await expect(page.getByTestId('first-run-guide')).toBeVisible();
      const guide = (await page.getByTestId('first-run-guide-root').boundingBox())!;
      const map = (await page.getByTestId('map-area').boundingBox())!;
      expect(
        guide.x,
        `ガイドの左端 ${String(Math.round(guide.x))} が地図セル（右端 ${String(
          Math.round(map.x + map.width),
        )}）に食い込んでいる`,
      ).toBeGreaterThanOrEqual(map.x + map.width - 1);
      // ズームの 3 ボタンとも交差しない（覆っていたのはここ）。
      for (const id of ['map-zoom-in', 'map-zoom-out', 'map-fit-all']) {
        const b = (await page.getByTestId(id).boundingBox())!;
        const overlaps =
          guide.x < b.x + b.width &&
          b.x < guide.x + guide.width &&
          guide.y < b.y + b.height &&
          b.y < guide.y + guide.height;
        expect(overlaps, `ガイドが ${id} を覆っている`).toBe(false);
        // 覆っていないので押せる（板が出ていても地図の部品は生きている）。
        await expect(page.getByTestId(id)).toBeEnabled();
      }
    } finally {
      await app.close();
    }
  });

  test('「今後表示しない」は次の起動でも効く（アプリ側に覚える＝決定 (2)）', async () => {
    // 旧版はプロジェクトの設定にしか書いていなかったので、**押しても次の起動でまた出た**
    // （起動直後は新規プロジェクトなので、押した印の行き先が無い）。
    const first = await launchApp({ keepFirstRunGuide: true });
    try {
      await expect(first.page.getByTestId('first-run-guide')).toBeVisible();
      await first.page.getByTestId('first-run-guide-dismiss').click();
      await expect(first.page.getByTestId('first-run-guide')).toHaveCount(0);
    } finally {
      await first.app.close();
    }

    const second = await launchApp({ keepFirstRunGuide: true });
    try {
      // 起動しても出ない（新規プロジェクトの既定は「出す」のままなのに、である）。
      await second.page.waitForTimeout(500);
      await expect(second.page.getByTestId('first-run-guide')).toHaveCount(0);

      // **設定欄は嘘をつかない**: 覚え書きが「出さない」なら、印も外れている。
      await second.page.getByTestId('menu-tools').click();
      await second.page
        .getByTestId('menu-items-tools')
        .locator('[data-command="tools.settings"]')
        .click();
      await expect(second.page.getByTestId('settings-dialog')).toBeVisible();
      await second.page.getByTestId('settings-tab-app').click();
      const box = second.page.getByLabel('起動時にこの画面の使い方を表示する');
      await expect(box).not.toBeChecked();
      // **入口として生きている**: 入れ直すと、また出るようになる。
      // （ここで戻しておかないと、同じワーカーの後続のテストにも出なくなる。）
      await box.check();
      await second.page.getByTestId('settings-save').click();
      await expect(second.page.getByTestId('first-run-guide')).toBeVisible();
    } finally {
      await second.app.close();
    }
  });
});

test.describe('増分 6 — 逃げ道 2（束の吹き出し）と錨表の規模', () => {
  test('同じ年に重なる錨は、押すと束の吹き出しが 100ms 以内に開く', async () => {
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1280, 800);
      // 1200 年の中に 12 本（月ごと）。**同じ日には置けない**（系列は開始が厳密に増加する）
      // ので、月で分けたものが「1 年に複数の錨がある」形になる。
      await loadSyntheticAnchors(page, 12, { asAggregateChild: false, withinOneYear: 12 });
      // **1200 年へ移ってから選ぶ。** 錨は 1200 年から始まるので、0 年の一覧
      // （現在時刻に存在する地物）にはまだ 1 件も出ない。
      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      const lane = (await page.getByTestId('anchor-lane').boundingBox())!;
      const stats = await railLaneStats(page);
      expect(stats.anchorCount).toBe(12);
      // 12 本は 1 万年の軸では 1 列に重なる（＝密度帯 1 本）。
      expect(stats.denseCount).toBeGreaterThan(0);

      const view = await railView(page);
      const px = ((1200 - view.minYear) / (view.maxYear - view.minYear)) * view.pixelLength;
      const started = Date.now();
      await page.mouse.click(lane.x + px, lane.y + lane.height / 2);
      await expect(page.getByTestId('anchor-bundle')).toBeVisible();
      const elapsed = Date.now() - started;
      expect(elapsed, `束が開くまで ${String(elapsed)}ms`).toBeLessThanOrEqual(100);

      // 件数が合っている（見出しの数と、並んだ行の数）。
      await expect(page.getByTestId('anchor-bundle-title')).toContainText('12 件');
      const rows = page.locator('[data-testid^="anchor-bundle-row-"]');
      expect(await rows.count()).toBe(12);
      // **12 行目まで本当に届く**（2026-09-07 の手直し）。旧版は一覧の高さが 168px で
      // 12 行（264px）が入らず、しかも器が押下を通す設定だったので **スクロールも
      // できず下 4 行に手が届かなかった**。可視は `toBeVisible()` ではなく
      // **矩形が一覧の矩形に入るか**で見る（教訓 5.62）。
      const list = (await page.getByTestId('anchor-bundle').locator('ul').boundingBox())!;
      const last = (await rows.last().boundingBox())!;
      expect(last.y, '12 行目が一覧の上へはみ出した').toBeGreaterThanOrEqual(list.y - 1);
      expect(
        last.y + last.height,
        '12 行目が一覧の下へはみ出した（届かない）',
      ).toBeLessThanOrEqual(list.y + list.height + 1);
      // 閉じる道が複数ある（Escape でも閉じる＝共有の器の作法 3）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('anchor-bundle')).toHaveCount(0);
      await page.mouse.click(lane.x + px, lane.y + lane.height / 2);
      await expect(page.getByTestId('anchor-bundle')).toBeVisible();

      // 行を押すとその年へ飛び、吹き出しは畳まれる。
      await page.locator('[data-testid^="anchor-bundle-row-"]').first().click();
      await expect(page.getByTestId('anchor-bundle')).toHaveCount(0);
      await expect(page.getByTestId('timeline-current')).toContainText('1200年');
    } finally {
      await app.close();
    }
  });

  test('5 万錨の錨表を開いても DOM の行は 25 行以下（増分 2 の仮想スクロールが効く）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticAnchors(page, 50_000, { asAggregateChild: false });
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'anchor-section');

      const rows = await page.locator('[data-testid^="anchor-row-"]').count();
      expect(rows, `錨表の DOM 行が ${String(rows)} 行`).toBeLessThanOrEqual(25);
      expect(rows).toBeGreaterThan(0);
      // 差分の文も **DOM に載っている行のぶんだけ**（行ごとに 1 つ）。
      const diffs = await page.locator('[data-testid^="anchor-diff-"]').count();
      expect(diffs).toBeLessThanOrEqual(rows);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 6 — 時刻を動かした 1 コマ（設計書 §F.2 の最後の受け入れ条件）', () => {
  test('5 万錨を選んだまま 1 年送ったときの 1 コマを実測し、人の待ち時間にならないことを見る', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await resizeWindow(page, 1280, 800);
      await loadSyntheticAnchors(page, 50_000, { asAggregateChild: false });

      /**
       * 「押してから画面（`timeline-current` の文字）が変わるまで」を 20 回測って平均を返す。
       *
       * **設計書 §F.2 は「16ms 以内。超えるなら実測値を上限として明記する」**としている。
       * 実測（1 台で静かに動かして）は **選んでいないとき 4.0ms / 5 万錨 34.8ms** で、
       * 16ms を超える。**この値が唯一の記録である**（`docs/現状.md` の B59 と
       * 進捗 §11.4 は同じ数を引く。旧版は 2 か所に別の数が書かれていた）。**残りの費用は増分 6 の外にある** ―― `resolveAt`（U09）は
       * 「読み込み直後の未検証な系列でも正しく解ける」ことを理由に **意図的に線形走査**で
       * あり（同関数のコメント）、`featuresAt` / `verticesAt` / 表示解決が時刻ごとに
       * それを呼ぶ。5 万錨では 1 回の呼び出しが 5 万回の比較になる。**錨の意味論と
       * 保存の経路に触る変更**なので、読む側だけの増分 6 では手を付けない
       * （`docs/現状.md` の B59）。
       *
       * ここは **catastrophic な後退の見張り**として置く（**目標値ではない**）。6 つの
       * Electron が同時に走るゲートの中では同じコードでも 34.8ms が 46ms 前後に伸びるので、
       * 絶対値の線は「人が明らかに待つ域」に置く。実測値は毎回 `console.log` に出すので、
       * **記録する数はその印字から引く**（司令塔の決定 (6)、2026-09-07）。
       */
      const measure = async (): Promise<number> =>
        page.evaluate(async () => {
          const button = document.querySelector<HTMLElement>('[aria-label="1年次へ進む"]');
          const readout = document.querySelector<HTMLElement>(
            '[data-testid="timeline-current"]',
          );
          if (button === null || readout === null) throw new Error('送りのボタンが無い');
          const samples: number[] = [];
          for (let i = 0; i < 20; i += 1) {
            const before = readout.textContent ?? '';
            const started = performance.now();
            // **押しっぱなしで送り続けるボタンなので `click()` では何も起きない**
            // （`useLongPress` は pointerdown / pointerup で駆動する）。
            button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            const changed = await new Promise<boolean>((resolve) => {
              const observer = new MutationObserver(() => {
                if ((readout.textContent ?? '') !== before) {
                  observer.disconnect();
                  resolve(true);
                }
              });
              observer.observe(readout, {
                childList: true,
                subtree: true,
                characterData: true,
              });
              setTimeout(() => {
                observer.disconnect();
                resolve((readout.textContent ?? '') !== before);
              }, 2000);
            });
            if (!changed) throw new Error('送りのボタンを押しても年が動かない');
            samples.push(performance.now() - started);
          }
          return samples.reduce((a, b) => a + b, 0) / samples.length;
        });

      // ①何も選んでいないとき（レーンは空）。
      const idle = await measure();

      // ②5 万錨を選んだまま。
      await page.getByTestId('sidebar-tab-list').click();
      await page.locator('[data-testid^="feature-list-item-"]').first().click();
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
      const loaded = await measure();

      console.log(
        `[増分6] 1 コマ: 選んでいない ${idle.toFixed(2)}ms / 5 万錨 ${loaded.toFixed(2)}ms`,
      );
      // 実測の上限（34.8ms）に、混んだゲートでの揺れぶん（46ms 前後）の余裕を足した線。
      // ここを割るのは「1 コマが人の待ち時間になった」ときだけである。
      expect(
        loaded,
        `5 万錨の 1 コマ ${loaded.toFixed(2)}ms（選んでいないとき ${idle.toFixed(2)}ms）`,
      ).toBeLessThanOrEqual(100);
      // **選んでいないときは軽いまま**（レールを足したことで素の 1 コマが重くなっていない）。
      expect(idle, `何も選んでいないときの 1 コマ ${idle.toFixed(2)}ms`).toBeLessThanOrEqual(16);

      // レーンの再集計は 1 度も走っていない（時刻が動いただけでは数え直さない）。
      const stats = await railLaneStats(page);
      expect(stats.aggregateCount).toBeLessThanOrEqual(3);
    } finally {
      await app.close();
    }
  });
});


// ---------------------------------------------------------------------------
// 2026-09-07 の手直し — 実機でしか捕まらないもの
// ---------------------------------------------------------------------------

test.describe('増分 6 の手直し — 地図の 3 部品・目盛り・読み取り', () => {
  test('道具を構えていても地図のズーム 3 ボタンは押せる（決定 (3)）', async () => {
    // 旧版は道具の入力ブリッジが **後から並ぶ兄弟**として上に乗り、3 部品を飲み込んで
    // いた（しかも理由が出ない）。層を上げ、器は押下を通してボタンの矩形だけが受ける。
    const { app, page } = await launchApp();
    try {
      await leaveViewMode(page);
      await page.getByTestId('tool-add.area').click();
      await expect(page.getByTestId('add-input-layer')).toBeVisible();

      const layer = page.getByTestId('map-input-layer');
      const before = Number(await layer.getAttribute('data-zoom'));
      const button = (await page.getByTestId('map-zoom-in').boundingBox())!;
      // ボタンの真ん中で押下を受けるのは **ボタン**（入力ブリッジではない）。
      const onButton = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? '?',
        { x: button.x + button.width / 2, y: button.y + button.height / 2 },
      );
      expect(onButton).toBe('map-zoom-in');
      await page.getByTestId('map-zoom-in').click();
      await page.waitForTimeout(120);
      expect(Number(await layer.getAttribute('data-zoom'))).toBeGreaterThan(before);

      // **ボタンの間の隙間は地図へ抜ける**（覆いを作らないという K-2 の約束）。
      const box = (await page.getByTestId('map-view-controls').boundingBox())!;
      const zoomIn = (await page.getByTestId('map-zoom-in').boundingBox())!;
      const gapY = zoomIn.y + zoomIn.height + 2;
      const inGap = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? '?',
        { x: box.x + box.width / 2, y: gapY },
      );
      expect(inGap).toBe('add-input-layer');
    } finally {
      await app.close();
    }
  });

  test('目盛りの行は既定のスライダーの絵で覆われない（左端の年が読める）', async () => {
    const { app, page } = await launchApp();
    try {
      // `appearance: none` を実機の計算済みスタイルで見る（実測の画面では既定の
      // 太い青帯と大きなつまみが 0 年のラベルを完全に隠していた）。
      const appearance = await page.evaluate(() => {
        const el = document.querySelector('.rail__slider');
        if (el === null) return '(無い)';
        const s = getComputedStyle(el);
        return `${s.appearance}/${s.getPropertyValue('-webkit-appearance')}`;
      });
      expect(appearance).toContain('none');
      // 目盛りのラベルは 2 本以上出ていて、軸の中に収まっている。
      const labels = page.getByTestId('timeline-tick-label');
      expect(await labels.count()).toBeGreaterThanOrEqual(2);
      const axis = (await page.getByTestId('rail-axis').boundingBox())!;
      const first = (await labels.first().boundingBox())!;
      expect(first.x).toBeGreaterThanOrEqual(axis.x - 20);
    } finally {
      await app.close();
    }
  });

  test('目盛りに焦点を入れて → を押すと 1 単位進む', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      await page.getByLabel('時間軸スライダー').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('timeline-current')).toContainText('1201年');
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('timeline-current')).toContainText('1200年');
    } finally {
      await app.close();
    }
  });

  test('深く拡大しても読み取りが読める（「1px ≒ 0.00年」にならない）', async () => {
    const { app, page } = await launchApp();
    try {
      await jumpToYear(page, 1200);
      for (let i = 0; i < 6; i += 1) await page.getByTestId('rail-zoom-in').click();
      await page.waitForTimeout(120);
      const note = (await page.getByTestId('rail-span-note').textContent()) ?? '';
      expect(note).not.toContain('0年ぶん');
      expect(note).not.toContain('≒ 0.00年');
      expect(await page.getByTestId('timeline-tick-label').count()).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });

  test('レールのホイールで passive のエラーが出ない（1 走行 96 件だった）', async () => {
    const { app, page } = await launchApp();
    try {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      const lane = (await page.getByTestId('anchor-lane').boundingBox())!;
      await page.mouse.move(lane.x + lane.width / 2, lane.y + lane.height / 2);
      for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -120);
      await page.waitForTimeout(200);
      expect(errors.filter((e) => e.includes('passive'))).toEqual([]);

      // **横送りしても端が半端な日にならない**（バグ狩り #5）。旧版は割り算の誤差が
      // そのまま画面の文字になり、読み取りが「1200年5月10.499999999941792日」になった。
      await page.keyboard.down('Shift');
      for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, 120);
      await page.keyboard.up('Shift');
      await page.waitForTimeout(150);
      const view = await railView(page);
      expect(Number.isInteger(view.spanDays), `表示範囲の幅が ${String(view.spanDays)} 日`).toBe(
        true,
      );
      expect(await page.getByTestId('rail-view-min').textContent()).not.toMatch(/\.\d{3}/);
    } finally {
      await app.close();
    }
  });

  test('選んでいないときのバッジは行き先を言わない（指す相手が画面に無い）', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('rail-edit-time-badge')).toHaveAttribute(
        'data-plan',
        'none',
      );
      expect(await page.getByTestId('rail-edit-time-note').count()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
