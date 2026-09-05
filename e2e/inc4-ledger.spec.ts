// 増分 4 の受け入れ条件を **実アプリ** で固定する（実装計画 §4 の「完了の定義」）。
//
// 単体テストだけでは「実アプリで効いていない」を見逃す（増分 1〜3 の教訓）。ここで見るのは
// 画面の実物だけで、内部の関数は 1 つも呼ばない。
//
// 固定するもの:
//   1. 右パネルの **2 区画が同時に見える**（タブを押さずに一覧と素性欄が両方読める）
//   2. **どの窓の大きさでも、一覧の行が区画の中に見えている**（2026-09-05 の手直し A1）
//   3. **器をいちばん低くしても、名前欄が保存列の下に潜らない**（同 A2）
//   4. **地物を選んでも区画の矩形が動かない**（K-3）
//   5. **5,000 行の合成データで、台帳の DOM の行が 20 個以下**（仮想スクロール）＋
//      **いちばん下まで送れる**（行の実高が 28px ちょうど＝同 A3）
//   6. 行が [色][展開][名前][種別][錨の本数][👁] を運び、**隠しても行は消えない**（同 B1）
//   7. **作業のまとまりを作った瞬間**に、先頭の未処理が選ばれ、名前欄に焦点が入る
//   8. **その場編集**（名前）と、**素性欄の Enter＝保存して次へ**
//   9. **「済」は保存しない**（同じ式を選び直せば同じ並びで出て、直したものが済になる）
//  10. **V3 の 3 手**（Ctrl+P → 打つ → Enter で一覧の行・素性欄が揃う。同 B2）
//  11. **一覧の鍵盤**（矢印・Home/End・F2。窓の外の行にも届く。同 B8）
//  12. **読むだけの断りに「次の一手」のボタンが添う**（同 E1 / K-6）
//  13. **隠した地物を一覧から選ぶと地図に出る**（「必ず描く」。旧 BUG#3 の後継）
//  14. **親欄の 3 ボタンが無効で、理由の文が出ている**
//  15. **表示制御がオプションバーの「表示 ▾」から 1 クリックで開く**（C7）
//
// **`toBeVisible()` で「見えている」を測らない**（教訓 5.62）。祖先のスクロール範囲の外に
// ある要素も真になるので、行の可視は **矩形の交差** で数える（`rowsInsidePanel`）。
//
// 実データ（「???州」10 件の見分け・深さ 1 の州を選ぶと描かれる・束の保存と復元）は
// `real-data-inc4.spec.ts`。Ctrl+P の中身は `help-tools.spec.ts`。

import { expect, test, type Page } from '@playwright/test';

import {
  commitOneFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  listedFeatureCount,
  loadSyntheticProject,
} from './helpers';

/**
 * いまの視点（ズームと平行移動）を 1 本の文字列で読む（2026-09-06、2 回目の手直し）。
 * 地図の入力層が `data-zoom` / `data-pan-x` / `data-pan-y` を名乗っているので、
 * 「視点が動いたか」はこの文字列が変わったかで見る。
 */
async function readCamera(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-input-layer"]');
    if (el === null) return '';
    return `${el.getAttribute('data-zoom') ?? ''}|${el.getAttribute('data-pan-x') ?? ''}|${
      el.getAttribute('data-pan-y') ?? ''
    }`;
  });
}

/** 台帳に **DOM として載っている** 行の数（仮想スクロールなので件数とは別物）。 */
async function ledgerDomRows(page: Page): Promise<number> {
  return page.locator('[data-testid^="ledger-row-"]').count();
}

/**
 * 一覧の行が **区画の矩形の中に交差して見えている** 数。
 *
 * **`toBeVisible()` では測れない**（教訓 5.62）。Playwright の `toBeVisible` は
 * 「表示ボックスがあり、`visibility` が見えている」だけを見るので、**先祖のスクロール
 * 範囲の外にある要素も「見えている」と判定する**。増分 4 の実装では行が区画の
 * 23px 下から始まっていたのに、行の locator は全部 visible だった。
 */
async function rowsInsidePanel(page: Page): Promise<number> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="sidebar-panel-list"]');
    if (panel === null) return -1;
    const p = panel.getBoundingClientRect();
    let n = 0;
    for (const el of document.querySelectorAll('[data-testid^="ledger-row-"]')) {
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, p.top);
      const bottom = Math.min(r.bottom, p.bottom);
      if (bottom - top > 0 && r.width > 0) n += 1;
    }
    return n;
  });
}

test.describe('増分 4 — 右パネルの 2 区画・台帳・作業のまとまり', () => {
  test('2 区画が同時に見える（タブを押さずに一覧と素性欄が両方読める）', async () => {
    const { app, page } = await launchApp();
    try {
      // **どちらの区画にも hidden が付かない。** 排他タブなら片方は必ず隠れている。
      await expect(page.getByTestId('sidebar-panel-list')).toBeVisible();
      await expect(page.getByTestId('sidebar-panel-properties')).toBeVisible();
      await expect(page.getByTestId('unified-list')).toBeVisible();
      await expect(page.getByTestId('property-panel')).toBeVisible();

      // 面を 1 つ描く → **タブを 1 度も押さずに**素性欄へ名前が出る（V3 の手数の芯）。
      await commitOneFace(page);
      await expect(
        page.getByTestId('sidebar-panel-properties').getByTestId('basic-info'),
      ).toBeVisible();
      // 一覧も同時に見えたまま（探すのと直すのが 1 画面で閉じる＝C5）。
      await expect(page.getByTestId('unified-list')).toBeVisible();

      // 仕切りが在って掴める。
      await expect(page.getByTestId('sidebar-splitter')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('どの窓の大きさでも、一覧の行が区画の中に見えている（起動直後 / 1280×800 / 800×600 / 1366×768）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      // ①起動直後（窓は既定のまま）。
      await expect(page.getByTestId('unified-list-count')).toHaveText('30件');
      expect(await rowsInsidePanel(page), '起動直後の窓で行が 1 行も区画に入っていない').toBeGreaterThan(0);

      // ②③④ 既定の窓・最小の窓・広く使われている窓。
      for (const size of [
        { width: 1280, height: 800 },
        { width: 800, height: 600 },
        { width: 1366, height: 768 },
      ]) {
        await page.setViewportSize(size);
        await page.waitForTimeout(300);
        expect(
          await rowsInsidePanel(page),
          `${String(size.width)}×${String(size.height)} で行が 1 行も区画に入っていない`,
        ).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  test('器をいちばん低くしても、名前欄が保存列の下に潜らない', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await enterEditMode(page);
      // 仕切りを下いっぱいまで引く（＝素性欄をいちばん低くする）。
      const splitter = page.getByTestId('sidebar-splitter');
      await splitter.focus();
      for (let i = 0; i < 40; i += 1) await splitter.press('ArrowDown');
      await page.waitForTimeout(200);

      // 束を作る＝名前欄へ焦点が入る第 1 手（設計書 §C.5）。
      await page.getByTestId('bundle-expression').fill('^合成地物00[0-2][0-9]$');
      await page.getByTestId('bundle-make').click();
      const name = page.getByLabel('名前', { exact: true });
      await expect(name).toBeFocused();

      // **保存列に隠れていない**（重なりが 0 で、素性欄の器の中に完全に入っている）。
      const overlap = await page.evaluate(() => {
        const input = document.querySelector('input[aria-label="名前"]');
        const bar = document.querySelector('[data-testid="property-save-bar"]');
        const body = document.querySelector(
          '[data-testid="sidebar-panel-properties"] .sidebar__panel-body',
        );
        if (input === null || bar === null || body === null) return null;
        const i = input.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        const v = body.getBoundingClientRect();
        return {
          covered: Math.max(0, Math.min(i.bottom, b.bottom) - Math.max(i.top, b.top)),
          // 器の中に入っている高さと、入りうる高さ（器が入力欄より低いこともある）。
          insideBody: Math.max(0, Math.min(i.bottom, v.bottom) - Math.max(i.top, v.top)),
          couldBeInside: Math.min(i.height, v.height),
        };
      });
      expect(overlap, '名前欄・保存列・器のどれかが見つからない').not.toBeNull();
      expect(overlap?.covered, '名前欄が保存列に覆われている').toBe(0);
      expect(
        overlap === null ? -1 : overlap.insideBody,
        '名前欄が素性欄の器の外にある',
      ).toBeGreaterThanOrEqual((overlap?.couldBeInside ?? 0) - 1);
    } finally {
      await app.close();
    }
  });

  // K-3（増分 4 の手直し F4）: **選んでも区画の寸法が動かない。** 下段の基準を
  // 中身に依らない `1 1 0` にしてあるのはこのためで、動くとダブルクリックの 2 回目が
  // 仕切りに当たってその場編集が開かない（実測で踏んだ）。窓の下限も一緒に見る。
  test('K-3: 地物を選んでも、右パネルの 2 区画の矩形が動かない', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      const rects = async (): Promise<unknown> =>
        page.evaluate(() =>
          ['sidebar-panel-list', 'sidebar-panel-properties'].map((id) => {
            const el = document.querySelector(`[data-testid="${id}"]`);
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            return {
              y: Math.round(r.y),
              h: Math.round(r.height),
              w: Math.round(r.width),
            };
          }),
        );
      const before = await rects();
      await page.getByTestId('feature-list-item-syn-0000').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      await page.waitForTimeout(200);
      expect(await rects(), '地物を選んだら区画の矩形が動いた（K-3）').toEqual(before);
    } finally {
      await app.close();
    }
  });

  // 旧 BUG#3（検索ヒットを地図で強調する）の後継（手直し F4）。検索モーダルは無くなり、
  // 強調も消えたが、**選んだものが地図に出る**という目的は「必ず描く」が引き受けた。
  // 隠した地物を一覧から選んでも地図に出ることを、実アプリで固定する。
  test('隠した地物を一覧から選んでも、地図には出る（「必ず描く」が引き受けた）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 10);
      const drawn = async (): Promise<number> =>
        page.evaluate(() => {
          const e2e = (window as unknown as { __E2E__?: { getDrawnFeatureCount: () => number } })
            .__E2E__;
          if (e2e === undefined) throw new Error('__E2E__ not ready');
          return e2e.getDrawnFeatureCount();
        });
      const all = await drawn();
      // 👁 で 1 件隠す → 描かれる数が減る（行は残る＝手直し B1）。
      await page.getByTestId('ledger-eye-syn-0000').click();
      await expect.poll(async () => drawn()).toBe(all - 1);
      await expect(page.getByTestId('ledger-row-syn-0000')).toHaveAttribute(
        'data-hidden',
        'true',
      );
      // その行を選ぶと **また描かれる**（選んでいるあいだだけ）。
      await page.getByTestId('feature-list-item-syn-0000').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      await expect.poll(async () => drawn()).toBe(all);
      // 表示 ▾ に「表示条件から外れています」と緩める導線が出る（手直し E1 / §D.6）。
      await page.getByTestId('option-display-button').click();
      await expect(page.getByTestId('display-hidden-notice')).toBeVisible();
      await page.getByTestId('display-relax-individual').click();
      await expect(page.getByTestId('ledger-row-syn-0000')).toHaveAttribute(
        'data-hidden',
        'false',
      );
    } finally {
      await app.close();
    }
  });

  test('5,000 行の合成データでも、台帳の DOM の行は 20 個以下（仮想スクロール）', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 5000);
      // 件数の真実源は表示（DOM の行数ではない）。
      await expect(page.getByTestId('unified-list-count')).toHaveText('5000件');
      expect(await listedFeatureCount(page)).toBe(5000);

      // **DOM に載るのは窓に入るぶんだけ。**
      const rows = await ledgerDomRows(page);
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(20);

      // スクロールしても DOM の行数は増えない（窓が動くだけ）。
      await page.getByTestId('ledger-scroller').evaluate((el) => {
        el.scrollTop = 28 * 2000;
      });
      await page.waitForTimeout(120);
      expect(await ledgerDomRows(page)).toBeLessThanOrEqual(20);
      // スクロールした先の行が出ている（空の窓ではない）。
      expect(await ledgerDomRows(page)).toBeGreaterThan(0);

      // **いちばん下まで送れる。** 行の実高が 28px からずれていると（`content-box` の
      // まま境界線を外へ足すと 28.8px になる）、5,000 行で 4,000px ぶん積み上がって
      // **最後の行に届かない**。行の器の高さと仮想スクロールの前提を突き合わせる検査。
      await page.getByTestId('ledger-scroller').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(200);
      // **`toBeVisible()` では測らない**（教訓 5.62 / 審査 T1）。同じファイルがその教訓を
      // 掲げているのに、ここだけが「先祖のスクロール範囲の外でも真になる」判定を使って
      // いた。末尾の行が **器と交差している**ことを矩形で見る。
      const lastRowInside = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="ledger-row-syn-4999"]');
        const scroller = document.querySelector('[data-testid="ledger-scroller"]');
        if (row === null || scroller === null) return -1;
        const r = row.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        return Math.max(0, Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top));
      });
      expect(lastRowInside, '5,000 行目が一覧の器と交差していない').toBeGreaterThan(0);
      await expect(page.getByTestId('feature-list-item-syn-4999')).toHaveText(/合成地物4999/);
      const rowHeight = await page
        .locator('[data-testid^="ledger-row-"]')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
      expect(rowHeight).toBeCloseTo(28, 0);
    } finally {
      await app.close();
    }
  });

  test('行が [色][名前][種別][錨の本数][👁] を運ぶ', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 20);
      const id = 'syn-0000';
      await expect(page.getByTestId(`ledger-color-${id}`)).toBeVisible();
      await expect(page.getByTestId(`feature-list-item-${id}`)).toContainText('合成地物0000');
      await expect(page.getByTestId(`ledger-kind-${id}`)).toHaveText('合成の州');
      await expect(page.getByTestId(`ledger-anchors-${id}`)).toHaveText('1本');
      await expect(page.getByTestId(`ledger-eye-${id}`)).toBeVisible();

      // **👁 を押しても行は消えない**（手直し B1 / 決定 (2)）。印が 🚫 に変わり、
      // 同じボタンで戻せる ―― 消えると「隠したこと自体を取り消せない」ので、
      // 一覧（＝探す場所）から隠す設定へ戻る道が無くなる。
      await page.getByTestId(`ledger-eye-${id}`).click();
      await expect(page.getByTestId(`ledger-row-${id}`)).toHaveAttribute('data-hidden', 'true');
      await expect(page.getByTestId(`ledger-eye-${id}`)).toHaveText('🚫');
      await page.getByTestId(`ledger-eye-${id}`).click();
      await expect(page.getByTestId(`ledger-row-${id}`)).toHaveAttribute('data-hidden', 'false');
    } finally {
      await app.close();
    }
  });

  test('作業のまとまりを作った瞬間に、先頭の未処理が選ばれ、名前欄に焦点が入る', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      // 鍵を「直せる」にしてから（読むだけでは直せない＝K-6）。
      await enterEditMode(page);

      // 自分で式を書く（既定の式は実データの命名規約なので、合成データには当たらない）。
      await page.getByTestId('bundle-expression').fill('^合成地物00[0-2][0-9]$');
      await page.getByTestId('bundle-make').click();

      // ①先頭の未処理が選ばれる ②名前欄に焦点が入る ③件数が出る
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      await expect(page.getByTestId('bundle-position')).toHaveText('1 / 30');
      await expect(page.getByLabel('名前', { exact: true })).toBeFocused();
    } finally {
      await app.close();
    }
  });

  test('素性欄の Enter は「保存して次へ」— 直したものは「済」になり、束の並びは動かない', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await enterEditMode(page);
      // **錨の開始年ではない年へ移ってから直す。** 保存は「いま見ている年」に効く
      // （裁定 §N-2）ので、錨の開始年ちょうどで直すとその錨を **上書き** し、過去の
      // 名前が残らない ―― そのときは「開き直して同じ式を選ぶ」で束に戻ってこない
      // （`docs/現状.md` B51）。実運用は「ある年を見ながら直す」なので、こちらが常態。
      await jumpToYear(page, 1200);
      await page.getByTestId('bundle-expression').fill('^合成地物00[0-2][0-9]$');
      await page.getByTestId('bundle-make').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');

      const name = page.getByLabel('名前', { exact: true });
      await name.fill('本名アルファ');
      await name.press('Enter');

      // **次の未処理へ送られる**（カーソルも進む）。
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0001');
      await expect(page.getByTestId('bundle-position')).toHaveText('2 / 30');

      // **直したものは「済」の印が付く**（保存しない導出）。
      await expect(page.getByTestId('ledger-done-syn-0000')).toBeVisible();
      // **束の並びは動かない** — 改名しても 1 番目は syn-0000 のままである
      // （報告 E §2.10 の「改名すると絞り込みが 0 件になる」が構造的に消える）。
      await expect(page.getByTestId('bundle-prev')).toBeEnabled();
      await page.getByTestId('bundle-prev').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      await expect(page.getByTestId('bundle-position')).toHaveText('1 / 30');

      // **同じ式で作り直しても同じ 30 件が同じ並びで出て、済が残る**（開き直しても
      // 続けられる仕掛けの芯 ―― 式は通史で当てはめるので、改名しても束から落ちない）。
      await page.getByTestId('bundle-make').click();
      await expect(page.getByTestId('bundle-position')).toHaveText(/\/ 30$/);
      await expect(page.getByTestId('ledger-done-syn-0000')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('一覧のその場編集（ダブルクリックで改名）が保存の 1 本を通る', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 10);
      await enterEditMode(page);
      // **先頭の行を使う。** 仮想スクロールなので、窓の外の行を掴むと Playwright の
      // 「見えるところまでスクロールする」と窓の作り直しが競って不安定になる。
      const row = page.getByTestId('feature-list-item-syn-0000');
      await row.dblclick();
      const input = page.getByTestId('ledger-name-input-syn-0000');
      await expect(input).toBeVisible();
      await input.fill('その場で改名');
      await input.press('Enter');
      await expect(page.getByTestId('feature-list-item-syn-0000')).toContainText('その場で改名');
      // 取り消しが 1 手で効く（＝`recordCommand` の 1 本を通っている）。
      await page.getByTestId('statusbar').click();
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('feature-list-item-syn-0000')).toContainText('合成地物0000');
    } finally {
      await app.close();
    }
  });

  // 増分 4 の手直し B2。V3 の 3 手（Ctrl+P → 打つ → Enter）で「一覧の行・地図・素性欄」の
  // 3 つが揃うことを通しで見る。旧版は `expandLedgerPath` に呼び出し元が無かったので、
  // **選ばれてはいるのに一覧に行が出ない**（畳んだ親の下にある子は見えないまま）だった。
  test('V3 の 3 手: Ctrl+P で選ぶと、一覧に行が出て素性欄にも出る', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await page.keyboard.press('Control+p');
      await page.getByTestId('jump-palette-input').fill('合成地物0011');
      await page.keyboard.press('Enter');

      // ①選ばれている ②一覧に行が出ている ③素性欄に出ている
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0011');
      await expect(page.getByTestId('feature-list-item-syn-0011')).toHaveCount(1);
      expect(await rowsInsidePanel(page)).toBeGreaterThan(0);
      await expect(
        page.getByTestId('sidebar-panel-properties').getByTestId('basic-info'),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // 増分 4 の手直し B8 / 設計書 §I.2。増分 2 の錨表と同じ作法で鍵盤から操れる。
  test('一覧を鍵盤で操れる（矢印・Home/End・Enter・F2）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await enterEditMode(page);
      // 行を 1 つ押してから鍵盤に移る（焦点は一覧の器が持つ）。
      await page.getByTestId('feature-list-item-syn-0000').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');

      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0001');
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0002');
      await page.keyboard.press('ArrowUp');
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0001');

      // **窓の外の行にも届く**（仮想スクロールなので End の行き先は DOM に無い）。
      await page.keyboard.press('End');
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0029');
      await page.keyboard.press('Home');
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');

      // F2 でその場改名が開く。
      await page.keyboard.press('F2');
      await expect(page.getByTestId('ledger-name-input-syn-0000')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('ledger-name-input-syn-0000')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  // 増分 4 の手直し B11 / K-6。読むだけでも **理由が出る**（黙って何も起きない、が
  // いちばん読めない）。理由には「次の一手」のボタンが添う（設計書 §H.5 / 手直し E1）。
  test('読むだけでその場編集を試すと、理由と「鍵を直せるにする」ボタンが出る', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 10);
      await expect(page.getByTestId('app-mode')).toHaveText('view');
      await page.getByTestId('feature-list-item-syn-0000').dblclick();
      // 入力欄は開かない。理由が状態行と次の一手に出る。
      await expect(page.getByTestId('ledger-name-input-syn-0000')).toHaveCount(0);
      await expect(page.getByTestId('option-bar-next-step')).toContainText('読むだけ');
      const unlock = page.getByTestId('option-bar-next-action-ledger-unlock');
      await expect(unlock).toBeVisible();
      await unlock.click();
      await expect(page.getByTestId('app-mode')).toHaveText('edit');
      // 鍵が開いたので、今度は入力欄が開く（検査が空振りしていない証）。
      await page.getByTestId('feature-list-item-syn-0000').dblclick();
      await expect(page.getByTestId('ledger-name-input-syn-0000')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('親欄の 3 ボタンが無効で、理由の文が出ている（増分 7 まで）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await expect(page.getByTestId('parent-row')).toBeVisible();
      for (const id of ['parent-pick', 'parent-create', 'parent-clear']) {
        await expect(page.getByTestId(id)).toBeDisabled();
      }
      // ツールチップだけにしない（マウスを乗せないと読めない理由は無いのと同じ）。
      await expect(page.getByTestId('parent-disabled-reason')).toBeVisible();
      await expect(page.getByTestId('parent-disabled-reason')).toContainText('まだ使えません');
    } finally {
      await app.close();
    }
  });

  test('表示制御はオプションバーの「表示 ▾」から 1 クリックで開く（C7）', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 10);
      // 閉じているあいだ、パネルは **入力を奪わない**（教訓 5.56 の [hidden] 打ち消し）。
      await expect(page.getByTestId('option-display-panel')).toBeHidden();
      await page.getByTestId('option-display-button').click();
      await expect(page.getByTestId('display-filter')).toBeVisible();

      // 種別（札）ごとの 3 トグルが出る（V5(b)）。
      await expect(page.getByTestId('display-filter-label-row-合成の州')).toBeVisible();
      await page.getByTestId('display-filter-label-hide-合成の州').click();
      // **「隠す」でも一覧の行は消えない**（手直し B1 / 決定 (2)）。件数は 10 件のまま
      // で、その札の 5 件に 🚫 が付く。行の 🚫 を押すとその札の［隠す］が外れる
      // （設計書 §C.5「設定も解除もこの 1 か所」）。
      await expect(page.getByTestId('unified-list-count')).toHaveText('10件');
      await expect(page.getByTestId('ledger-row-syn-0000')).toHaveAttribute(
        'data-hidden',
        'true',
      );
      await expect(page.getByTestId('ledger-row-syn-0001')).toHaveAttribute(
        'data-hidden',
        'false',
      );
      // ポップオーバーを閉じてから行を押す（開いたままだと帯が行を覆う）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('option-display-panel')).toBeHidden();
      await page.getByTestId('ledger-eye-syn-0000').click();
      await expect(page.getByTestId('ledger-row-syn-0000')).toHaveAttribute(
        'data-hidden',
        'false',
      );
    } finally {
      await app.close();
    }
  });

  // 2026-09-06、2 回目の手直し（1）。**保存列が育つ年でも、本文の中身は本文の中に出る。**
  //
  // 錨の無い年（1500 年）では保存列が「この年に錨だけ作るなら…」の説明文とボタン 2 つで
  // 103px に育つ。旧版は見出しと保存列を中身の **上に重ねて**いたので、1280×800 の実測で
  // あいだの帯が 20px しか残らず、26px の名前欄が **どのスクロール位置でもマウスで押せな
  // かった**（1366×768 では帯 3px）。0 年では帯 58px で押せていたので、それまでの検査は
  // 全部すり抜けていた（教訓 5.61 の再々発）。
  //
  // ここで見るのは 3 つ。①保存列がほんとうに育っていること（筋書きが本物であること）、
  // ②名前欄が保存列とも見出しとも重なっていないこと、③名前欄の真ん中を `elementFromPoint`
  // で突いて **自分が前面に出ていること**（＝マウスで押せる）。`force: true` では押さない
  // ―― それではこの罠そのものを検査が通してしまう（教訓 5.61）。
  test('錨の無い年で保存列が育っても、名前欄は本文の中に出て押せる（1280×800 / 1366×768 / 800×600）', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await enterEditMode(page);
      await page.getByTestId('feature-list-item-syn-0000').click();
      await expect(page.getByTestId('property-panel')).toBeVisible();

      // 合成データの錨は 0 年にしかない。1500 年へ移ると保存列が育つ。
      await jumpToYear(page, 1500);

      for (const size of [
        { width: 1280, height: 800 },
        { width: 1366, height: 768 },
        { width: 800, height: 600 },
      ]) {
        const label = `${String(size.width)}x${String(size.height)}`;
        await page.setViewportSize(size);
        await page.waitForTimeout(300);

        // 名前欄を本文の中へ送る（人がスクロールするのと同じこと）。
        await page.getByLabel('名前', { exact: true }).scrollIntoViewIfNeeded();
        await page.waitForTimeout(120);

        const m = await page.evaluate(() => {
          const input = document.querySelector('input[aria-label="名前"]');
          const bar = document.querySelector('[data-testid="property-save-bar"]');
          const head = document.querySelector('.property-panel__head');
          const body = document.querySelector('[data-testid="property-panel-body"]');
          if (input === null || bar === null || head === null || body === null) return null;
          const i = input.getBoundingClientRect();
          const b = bar.getBoundingClientRect();
          const h = head.getBoundingClientRect();
          const v = body.getBoundingClientRect();
          const overlap = (a: DOMRect, c: DOMRect): number =>
            Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
          const hit = document.elementFromPoint(i.left + i.width / 2, i.top + i.height / 2);
          return {
            barHeight: b.height,
            coveredByBar: overlap(i, b),
            coveredByHead: overlap(i, h),
            insideBody: overlap(i, v),
            inputHeight: i.height,
            bodyHeight: v.height,
            hitIsInput: hit === input || (hit !== null && input.contains(hit)),
            hitWhat:
              hit === null
                ? 'null'
                : `${hit.tagName}#${hit.getAttribute('data-testid') ?? ''}.${String(hit.className)}`,
            // 落ちたときに「何が前に出たのか」まで言えるようにする（覆っている犯人が
            // 分からないと、次に踏んだ人が同じ調べ直しをすることになる）。
            stack: document
              .elementsFromPoint(i.left + i.width / 2, i.top + i.height / 2)
              .slice(0, 4)
              .map((e) => `${e.tagName}.${String(e.className)}`)
              .join(' > '),
            headHeight: h.height,
            point: [i.left + i.width / 2, i.top + i.height / 2] as const,
          };
        });

        expect(m, `${label}: 名前欄・保存列・見出し・本文のどれかが見つからない`).not.toBeNull();
        if (m === null) continue;
        // ①筋書きが本物か（保存列が育っている）。
        expect(
          m.barHeight,
          `${label}: 保存列が育っていない（筋書きが再現できていない）`,
        ).toBeGreaterThan(90);
        // ②重なっていない。**1px 未満は端数**（本文と保存列は上下に並ぶ兄弟なので
        // 境界は共有していて、`scrollIntoView` が端へ寄せると小数の丸めで 0.8px ほど
        // 触れることがある）。旧版の壊れ方は「26px の欄が 103px の帯に丸ごと隠れる」
        // なので、1px の閾値でも十分に捕まる。
        expect(m.coveredByBar, `${label}: 名前欄が保存列に覆われている`).toBeLessThan(1);
        expect(m.coveredByHead, `${label}: 名前欄が見出しに覆われている`).toBeLessThan(1);
        // ③**本文には少なくとも 1 行ぶんの高さがある。** 覆われていなくても、本文の
        // 取り分が 0 なら中身は 1px も出ない（実測でそうなった。器 178px ＝ 見出し 55 ＋
        // 保存列 103 ＋ すき間 24 で本文 0px）。「覆われない」だけでは足りない。
        expect(
          m.bodyHeight,
          `${label}: 本文の取り分が名前欄 1 つぶんに足りない`,
        ).toBeGreaterThanOrEqual(m.inputHeight);
        // ④本文の中に丸ごと入っていて、真ん中を突くと自分が出る（＝押せる）。
        expect(
          m.insideBody,
          `${label}: 名前欄が本文の外にある（本文 ${String(Math.round(m.bodyHeight))}px）`,
        ).toBeGreaterThanOrEqual(Math.min(m.inputHeight, m.bodyHeight) - 2);
        expect(
          m.hitIsInput,
          `${label}: 名前欄の真ん中（${m.point
            .map((n) => Math.round(n))
            .join(',')}）を押すと ${m.hitWhat} が前に出る（見出し ${String(
            Math.round(m.headHeight),
          )}px ／ 保存列 ${String(Math.round(m.barHeight))}px ／ 本文 ${String(
            Math.round(m.bodyHeight),
          )}px ／ 重なり ${m.stack}）`,
        ).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  // 2026-09-06、2 回目の手直し（2）。**入力欄の中では、一覧の器の鍵盤を働かせない。**
  //
  // 器の `onKeyDown` は中の入力欄から浮き上がる鍵も横取りしていたので、絞り込み欄で
  // Home を押すと行頭へ戻らずに **焦点ごと一覧へ飛び**、その場編集では入力欄が閉じて
  // 打ちかけが理由もなく消えた（実測）。
  test('一覧の中の入力欄で Home/End/矢印を押しても、焦点も打ちかけも奪われない', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      const filter = page.getByTestId('unified-list-filter');
      await filter.click();
      await filter.fill('合成地物00');
      for (const key of ['Home', 'End', 'ArrowDown', 'ArrowUp']) {
        await page.keyboard.press(key);
        await expect(filter, `${key} で絞り込み欄から焦点が飛んだ`).toBeFocused();
        await expect(filter, `${key} で打ちかけが変わった`).toHaveValue('合成地物00');
      }

      // その場編集の入力欄も同じ（F2 で開き、Home を押しても閉じない）。
      await filter.fill('');
      await enterEditMode(page);
      await page.getByTestId('feature-list-item-syn-0003').click();
      await page.getByTestId('ledger-scroller').press('F2');
      const inline = page.getByTestId('ledger-name-input-syn-0003');
      await expect(inline).toBeVisible();
      await inline.fill('打ちかけの名前');
      for (const key of ['Home', 'End', 'ArrowDown']) {
        await page.keyboard.press(key);
        await expect(inline, `${key} でその場編集が閉じた`).toBeVisible();
        await expect(inline, `${key} で焦点が飛んだ`).toBeFocused();
        await expect(inline, `${key} で打ちかけが消えた`).toHaveValue('打ちかけの名前');
      }
    } finally {
      await app.close();
    }
  });

  // 2026-09-06、2 回目の手直し（3）。**名前欄に焦点が残ったままでも取り消せる。**
  //
  // 素性欄の Enter は「保存して次へ」なので、送ったあと焦点は次の地物の名前欄に入った
  // ままである。旧版はそこで Ctrl+Z を押しても「焦点が入力欄にある」というだけで
  // 大域の門番が止め、**押しても何も起きなかった**。ここでは **焦点を外さずに**押す。
  test('名前欄に焦点を残したまま Ctrl+Z が効く（保存して次へ、の直後）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await enterEditMode(page);
      await page.getByTestId('feature-list-item-syn-0000').click();
      const name = page.getByLabel('名前', { exact: true });
      await name.fill('直した名前');
      await name.press('Enter'); // 保存して次へ（焦点は次の地物の名前欄へ）
      await expect(page.getByTestId('feature-list-item-syn-0000')).toContainText('直した名前');

      // **焦点は入力欄のまま。** ここが検査の芯なので、押す前に確かめる。
      const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
      expect(focusedTag, '「保存して次へ」の直後に焦点が入力欄に無い').toBe('INPUT');

      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('feature-list-item-syn-0000')).toContainText('合成地物0000');
    } finally {
      await app.close();
    }
  });

  // 2026-09-06、2 回目の手直し（4）。**隠れた行を選んでも、視点を合わせて理由を言う。**
  //
  // 旧版は「表示条件を通っていなければ何もしない」と門を閉じていたので、隠れた行を選んでも
  // 視点は動かず状態行も黙ったまま、地図には「必ず描く」で当人だけが描かれていた
  // ―― 描いてあるのに、どこに描いたかを教えない。
  test('隠した行を一覧から選ぶと、視点が合って状態行が理由を言う', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      // 離れた地物を選んで視点を動かしておく（次に選ぶものと違う場所にする）。
      // **一覧は仮想スクロールなので、DOM に載っているのは窓に入る行だけ**である。
      // 遠い通し番号の行を名前で掴もうとすると、行そのものが存在しない（実測で踏んだ）。
      await page.getByTestId('feature-list-item-syn-0003').click();
      await page.waitForTimeout(200);
      const before = await readCamera(page);

      // syn-0000 を個別に隠す（合成データは 3.5 度ごとに並ぶので、0003 とは離れている）。
      await page.getByTestId('ledger-eye-syn-0000').click();
      await expect(page.getByTestId('ledger-row-syn-0000')).toHaveAttribute('data-hidden', 'true');

      // **選ぶのは「どこへでも移動」から**（2026-09-06）。一覧は仮想スクロールなので、
      // 隠した直後は行が組み直されて DOM から外れたり戻ったりする ―― 行を押しにいくと
      // 「押そうとしたら要素が消えた」で落ちる（実測）。ここで見たいのは「隠れた地物を
      // 選んだときに視点と状態行がどうなるか」なので、選び方は安定した経路を使う
      // （どちらも `onFocusFeatureCamera` の同じ 1 本を通る）。
      await page.keyboard.press('Control+p');
      await expect(page.getByTestId('jump-palette')).toBeVisible();
      await page.getByTestId('jump-palette-input').fill('合成地物0000');
      await expect(page.locator('[data-kind="feature"]').first()).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('jump-palette')).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      await page.waitForTimeout(300);
      expect(await readCamera(page), '隠れた行を選んでも視点が動かない').not.toBe(before);
      await expect(page.getByTestId('statusbar-result')).toContainText('表示条件で隠れています');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        '選んでいるあいだだけ地図に描いています',
      );
    } finally {
      await app.close();
    }
  });
});
