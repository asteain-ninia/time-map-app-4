// Electron 既定アプリケーションメニュー無効化の behavioural E2E（実機 composite 経由）.
//
// 既定メニューが生きている間、Chromium 側のロールがアプリより先に以下を所有していた:
//   - Ctrl+R / Ctrl+Shift+R = リロード → **編集中プロジェクトが吹き飛ぶ**。未保存確認も
//     出ないので、データ損失の直接原因。
//   - Ctrl+W = ウィンドウ閉鎖 → 未保存確認を経ずに閉じる一経路。
//     ⚠️ FR-107 終了確認ガードは **これで直っていない**: main に `window.on('close')` の
//     ブリッジが無いので × / Alt+F4 / OS シャットダウンでは今も確認が出ない（残 HIGH リスク）。
//     この spec が固定するのは「既定メニューがキーを所有していないこと」だけ。
//   - Ctrl+0 / Ctrl+= / Ctrl+- = **ページ** ズーム → CSS px 尺度が変わり FR-16 の座標対応が壊れる。
//   - Ctrl+Shift+I = DevTools。
// さらに menu.ts が宣言済みの Ctrl+= / Ctrl+- は **ハンドラ未登録** だったため、
// 「押すとページズームだけが動く」という最悪の組み合わせになっていた。
//
// ⚠️ 実測知見（この spec を書く過程で判明・重要）: Playwright の `keyboard.press` は CDP の
// 合成キーイベントで、**offscreen/非フォーカスの E2E ウィンドウではネイティブ
// アクセラレータ経路を発火しない**。つまり「Ctrl+R を押してリロードしないこと」は、
// 修正の有無に関わらず緑になる（修正前ビルドで実測確認済み）。したがって既定メニュー除去の
// **決定的な検証は #1 の「アプリケーションメニューそのものの状態」** であり、
// キー入力レグ(#2)は「レンダラ側に reload/閉鎖/ページズームの導線を作ってしまう」退行を
// 弾くためのガード（このハーネスでは赤にできない）と位置づける。
// ハンドラ結線(#3) と クリップボード(#4) はレンダラ内で完結するので実測できる。

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** A marker planted on `window`: it survives everything EXCEPT a document reload. */
const MARKER = '__emenuAliveMarker';

async function plantMarker(page: Page): Promise<void> {
  await page.evaluate((name) => {
    (window as unknown as Record<string, unknown>)[name] = 'alive';
  }, MARKER);
  expect(await readMarker(page)).toBe('alive');
}

async function readMarker(page: Page): Promise<unknown> {
  return page.evaluate(
    (name) => (window as unknown as Record<string, unknown>)[name] ?? null,
    MARKER,
  );
}

/** The window's PAGE zoom factor, read from the main process (the real truth source). */
async function pageZoomFactor(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win === undefined ? -1 : win.webContents.getZoomFactor();
  });
}

/** The live MAP zoom mirrored onto the map input layer. */
async function mapZoom(page: Page): Promise<number> {
  const layer = page.getByTestId('map-input-layer');
  await expect(layer).toHaveAttribute('data-zoom', /.+/);
  return Number(await layer.getAttribute('data-zoom'));
}

/**
 * Give the main process a round-trip's worth of time to have acted on an accelerator
 * (a reload / close / page-zoom would have started by then), so "nothing happened" is
 * an observation and not just an un-awaited race.
 */
async function settle(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => new Promise<void>((r) => setTimeout(r, 250)));
}

test.describe('Electron 既定アプリケーションメニューの無効化', () => {
  // #1 決定的な検証: 実行中アプリの Menu そのものを main 側で観測する。修正前は Electron
  // 既定メニュー（File/Edit/View/Window/Help — reload・ページズーム・DevTools・Ctrl+W を
  // 所有）が入っており、このテストは赤になる（実測確認済み）。
  test('起動後のアプリケーションメニューに reload / ページズーム / DevTools / 閉鎖 が存在しない', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // Flatten the WHOLE menu tree (submenus included) into role+accelerator pairs.
      const state = await app.evaluate(({ Menu }) => {
        const root = Menu.getApplicationMenu();
        if (root === null) return null;
        const out: { role: string; label: string; accelerator: string }[] = [];
        const walk = (menu: Electron.Menu): void => {
          for (const item of menu.items) {
            out.push({
              role: item.role ?? '',
              label: item.label,
              accelerator: item.accelerator ?? '',
            });
            // NOTE: leaf items expose `submenu` as NULL (not undefined) across the
            // Electron bridge, so an `!== undefined` guard crashes the walk.
            const sub: Electron.Menu | null | undefined = item.submenu;
            if (sub !== null && sub !== undefined) walk(sub);
          }
        };
        walk(root);
        return out;
      });

      if (state === null) {
        // win32 / linux: メニューは丸ごと外れている（既定メニューは存在し得ない）.
        expect(process.platform === 'darwin').toBe(false);
        return;
      }

      // darwin: appMenu + editMenu の最小構成のみ。危険なロールは1つも無い.
      const roles = state.map((i) => i.role);
      for (const forbidden of [
        'reload',
        'forcereload',
        'toggledevtools',
        'resetzoom',
        'zoomin',
        'zoomout',
        'close',
        'togglefullscreen',
      ]) {
        expect(roles.map((r) => r.toLowerCase())).not.toContain(forbidden);
      }
      // ...and no menu item claims any of the chords the app owns.
      const accelerators = state.map((i) => i.accelerator.replace(/CmdOrCtrl/i, 'Ctrl'));
      for (const chord of ['Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+W', 'Ctrl+0', 'Ctrl+=', 'Ctrl+-']) {
        expect(accelerators, chord).not.toContain(chord);
      }
    } finally {
      await app.close();
    }
  });

  // #2 レンダラ側ガード（このハーネスでは赤にできない — 上のコメント参照）: リロード /
  // ウィンドウ閉鎖 / ページズーム の導線が **アプリ内に** 生まれていないこと。
  test('Ctrl+R / F5 / Ctrl+W / Ctrl+0 / Ctrl+± でリロード・閉鎖・ページズームが起きない', async () => {
    const { app, page } = await launchApp();
    try {
      await plantMarker(page);
      const zoomBefore = await pageZoomFactor(app);
      expect(zoomBefore).toBeGreaterThan(0);
      expect(app.windows()).toHaveLength(1);

      // NOTE: Ctrl+Shift+= は #3 で「拡大が動くこと」を積極的に検証する（ラベル「Ctrl++」
      // 通りの打鍵 = JIS 配列で唯一到達可能な経路）ので、ここには入れない。
      for (const chord of ['Control+r', 'Control+Shift+r', 'F5', 'Control+w', 'Control+0']) {
        await page.keyboard.press(chord);
        await settle(app);
        // A reload would have re-executed the renderer bundle and wiped the marker.
        expect(await readMarker(page), chord).toBe('alive');
        // A close would have destroyed the only window.
        expect(app.windows(), chord).toHaveLength(1);
        // Page zoom steps 20% per role press; unchanged to 6 places = nothing happened.
        expect(await pageZoomFactor(app), chord).toBeCloseTo(zoomBefore, 6);
      }

      await expect(page.getByTestId('app-shell')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // #3 決定的な検証: Ctrl+= / Ctrl+- のハンドラ結線。修正前は menu.ts に chord 宣言だけが
  // あってハンドラが無く、押しても・メニュー行を押しても data-zoom は動かなかった。
  test('Ctrl+= / Ctrl+- は MAP ズームを変える（メニュー行と同一挙動）', async () => {
    const { app, page } = await launchApp();
    try {
      const boot = await mapZoom(page);
      expect(boot).toBeGreaterThan(0);

      // --- 導線 A: アクセラレータ ------------------------------------------------
      await page.keyboard.press('Control+=');
      await expect.poll(async () => mapZoom(page)).toBeGreaterThan(boot);
      const zoomedIn = await mapZoom(page);

      await page.keyboard.press('Control+-');
      await expect.poll(async () => mapZoom(page)).toBeLessThan(zoomedIn);
      // 1押下ぶんの倍率は逆数なので、往復すると元の倍率へ戻る（対称ステップ）.
      expect(await mapZoom(page)).toBeCloseTo(boot, 6);

      // --- 導線 A': ラベル「Ctrl++」通りの打鍵 (shift 付き) ------------------------
      // メニューは '=' を '+' として表示する（Ctrl++）。ユーザーが素直にそれを打つと
      // shift が乗る（Playwright/US 配列では key='+'）。JIS 配列では '=' 自体が Shift+「-」
      // なので **shift 無しの Ctrl+= は原理的に発生し得ず**、この経路が拡大の唯一の導線。
      // menu.ts の shift 別名が無いと未登録=無反応（unit で赤を実測）.
      await page.keyboard.press('Control+Shift+=');
      await expect.poll(async () => mapZoom(page)).toBeGreaterThan(boot);
      expect(await mapZoom(page)).toBeCloseTo(zoomedIn, 6);
      await page.keyboard.press('Control+-');
      await expect.poll(async () => mapZoom(page)).toBeCloseTo(boot, 6);

      // --- 導線 B: 表示メニューの行 -----------------------------------------------
      await page.getByTestId('menu-view').click();
      await page.locator('button[data-command="view.zoomIn"]').click();
      await expect.poll(async () => mapZoom(page)).toBeGreaterThan(boot);
      // メニュー行とアクセラレータは同じ COMMAND_ID / 同じ算出を通る — 小数まで一致する.
      expect(await mapZoom(page)).toBeCloseTo(zoomedIn, 6);

      await page.getByTestId('menu-view').click();
      await page.locator('button[data-command="view.zoomOut"]').click();
      await expect.poll(async () => mapZoom(page)).toBeLessThan(zoomedIn);
      expect(await mapZoom(page)).toBeCloseTo(boot, 6);

      // ...and the PAGE zoom never moved while the MAP zoom did (単一真実源).
      expect(await pageZoomFactor(app)).toBeCloseTo(1, 6);
    } finally {
      await app.close();
    }
  });

  // #4 退行ガード（#2 と同格の**ハーネス制約つき** — 「決定的」ではない）: クリップボードが
  // 死んでいないこと。⚠️ 証明力の限界を明記する: ここで押す Ctrl+C/V/X も #2 と同じ CDP 合成
  // キーで、Blink の editing-command 経路に直接入る。よって仮に実機のクリップボードがアプリ
  // メニューのロール依存だったとしても、このテストは緑になり得る（非反証性）。
  // 実体としてクリップボードが無退行と判断する根拠は別にある（コードで確認済み）:
  //   - win32/linux では Blink の既定 editing key bindings が input/textarea 内の
  //     Ctrl+C/V/X/A を処理し、アプリケーションメニュー非依存。
  //   - useShortcuts の focus guard (focus-guard.ts) は編集要素上で dispatch も
  //     preventDefault もせず stand down するので、アプリ側 Ctrl+Z/Y の誤発火も無い。
  // darwin を正式対象にする際は editMenu ロール依存になるため、**実機手動確認**が必要
  // （このテストでは代替できない）。
  test('入力欄で Ctrl+C / Ctrl+V / Ctrl+X が生きている（クリップボード退行なし）', async () => {
    const { app, page } = await launchApp();
    try {
      // A real text input reachable at boot: ツール → 地物を検索 の検索欄.
      await page.getByTestId('menu-tools').click();
      await page.locator('button[data-command="tools.search"]').click();
      const input = page.getByTestId('search-panel-input');
      await expect(input).toBeVisible();

      await input.fill('コピー元テキスト');
      // Select through the DOM (not Ctrl+A) so this test isolates copy/paste only.
      await input.selectText();
      await page.keyboard.press('Control+c');

      await input.fill('');
      await expect(input).toHaveValue('');
      await input.click();
      await page.keyboard.press('Control+v');

      // If removing the application menu had killed the clipboard roles, this stays ''.
      await expect(input).toHaveValue('コピー元テキスト');

      // Ctrl+X も同じ Chromium ネイティブ編集コマンド経路 — 切り取りで空になる.
      await input.selectText();
      await page.keyboard.press('Control+x');
      await expect(input).toHaveValue('');
    } finally {
      await app.close();
    }
  });
});
