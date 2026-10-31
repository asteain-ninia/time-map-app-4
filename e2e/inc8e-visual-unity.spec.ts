// 見た目の統一（増分 8E 後半 / N-24・N-25・N-26・N-28）を実機の寸法と色で固定する。
//
// 宣言の側は `src/ui/shell/visual-unity.test.ts`。ここは実際にレイアウトした結果を見る（教訓 5.49 の 2 段目）。
// 既定の窓と最小の窓で代表の画面を回し、見えているボタンと見出しを全部測る。判定は `controlProblems`
// （巡回と共通）で、例外は数でなく顔ぶれで書く（教訓 5.83）。

import { expect, test, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  commitSquareFace,
  controlProblems,
  drawFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  leaveViewMode,
  MIN_CONTRAST,
  openPreSaveBoard,
  readControlMetrics,
  readControlMetricsAllDisabled,
  returnToViewMode,
  type ScreenPoint,
} from './helpers';

const WINDOWS = [
  { width: 1280, height: 800 },
  { width: 800, height: 600 },
] as const;

async function expectUnified(page: Page, where: string): Promise<void> {
  const { controls, headings } = await readControlMetrics(page);
  expect(controls.filter((c) => c.tag === 'button').length, `${where}: 測ったボタンの数`).toBeGreaterThan(3);
  expect(controlProblems(controls), where).toEqual([]);
  // 帯のメニューの見出し（`menu-file` など）は無効にならないので、全部を無効にした測定から外す
  const allDisabled = (await readControlMetricsAllDisabled(page)).filter((c) => !/^menu-[a-z]+$/.test(c.testid ?? ''));
  expect(controlProblems(allDisabled), `${where}（全部を無効にして）`).toEqual([]);
  for (const h of headings) {
    expect(['16px', '13px', '12px'], `${where}: 見出し「${h.text}」の大きさ`).toContain(h.fontSize);
    expect(h.fontWeight, `${where}: 見出し「${h.text}」の太さ`).toBe('600');
  }
}

/** 面を 2 つ並べて、鍵を開けた状態から始める。戻り値は 2 つの面の中心。 */
async function twoFaces(page: Page): Promise<{ readonly leftX: number; readonly rightX: number; readonly y: number }> {
  const box = await page.getByTestId('map-input-layer').boundingBox();
  if (box === null) throw new Error('地図の矩形が取れない');
  const cx = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const off = Math.min(110, box.width / 4);
  await commitSquareFace(page, cx - off, y, 40);
  await commitSquareFace(page, cx + off, y, 40);
  await returnToViewMode(page);
  await enterEditMode(page);
  return { leftX: cx - off, rightX: cx + off, y };
}

/** 要素の矩形の縁のすぐ内側が、その要素自身に当たるか（行の上下に押せない帯が残っていないか）。 */
async function edgesHit(page: Page, testid: string): Promise<{ top: boolean; bottom: boolean; rowHeight: number; h: number }> {
  return page.getByTestId(testid).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const row = el.parentElement?.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const at = (y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };
    const rowTop = row?.top ?? box.top;
    const rowBottom = row?.bottom ?? box.bottom;
    return { top: at(rowTop + 1), bottom: at(rowBottom - 1), rowHeight: row?.height ?? 0, h: box.height };
  });
}

test.describe('見た目の統一（N-24 / N-25 / N-26 / N-28）', () => {
  for (const size of WINDOWS) {
    const label = `${String(size.width)}x${String(size.height)}`;

    test(`${label}: 起動直後のガイド・シェル・道具を構えた帯`, async () => {
      const { app, page } = await launchApp({ keepFirstRunGuide: true });
      try {
        await page.setViewportSize(size);
        await expect(page.getByTestId('first-run-guide')).toBeVisible();
        // 窓を変えた直後は、時刻レールの畳み（ResizeObserver のあとの描き直し）がまだ終わっていない
        // ことがある。全件を並列で走らせると時々ここで「窓の外」と読んだ。落ち着くまで待つ。
        await expect
          .poll(async () => controlProblems((await readControlMetrics(page)).controls))
          .toEqual([]);
        await expectUnified(page, `${label} ガイド`);
        await page.getByTestId('first-run-guide-close').click();
        await expectUnified(page, `${label} 空の画面`);

        // 起動直後は読むだけで、道具のレールが無効で並ぶ。無効の検査が空振りしていないことも見る。
        const { controls } = await readControlMetrics(page);
        const disabledTools = controls.filter((c) => c.disabled && (c.testid ?? '').startsWith('tool-'));
        expect(disabledTools.length, `${label}: 無効の道具の数`).toBeGreaterThanOrEqual(10);
        for (const tool of disabledTools) {
          expect(tool.contrast ?? 0, `${String(tool.testid)} のコントラスト比`).toBeGreaterThanOrEqual(MIN_CONTRAST);
          expect(tool.opacity, `${String(tool.testid)} の透明度`).toBe(1);
        }

        await leaveViewMode(page);
        await armAddAreaTool(page);
        await expectUnified(page, `${label} 面の道具`);
      } finally {
        await app.close();
      }
    });

    test(`${label}: 面を選んだ素性欄と、設定の 3 つのタブ`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        await leaveViewMode(page);
        await commitOneFace(page);
        await expectUnified(page, `${label} 素性欄`);

        // 詳細文書の切替: 押された側は土台の色の組（青地に白い文字）
        const { controls } = await readControlMetrics(page);
        const pressed = controls.find((c) => c.testid?.startsWith('detail-doc-mode-') === true && c.pressed);
        expect(pressed, `${label}: 詳細文書の押された側`).toBeDefined();
        expect(pressed?.contrast ?? 0).toBeGreaterThanOrEqual(MIN_CONTRAST);

        await page.getByTestId('menu-tools').click();
        await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
        await expect(page.getByTestId('settings-dialog')).toBeVisible();
        for (const tab of ['project', 'app', 'backup']) {
          await page.getByTestId(`settings-tab-${tab}`).click();
          await expectUnified(page, `${label} 設定 ${tab}`);
          // 確定の列はどのタブでも窓の中で押せる（本文だけがスクロールする）
          for (const id of ['settings-cancel', 'settings-save']) {
            const hit = await page.getByTestId(id).evaluate((el) => {
              const r = el.getBoundingClientRect();
              const found = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return { bottom: r.bottom, hit: found === el };
            });
            expect(hit.hit, `${label} ${tab} ${id}: 押せる位置に見える`).toBe(true);
            expect(hit.bottom).toBeLessThanOrEqual(size.height);
          }
        }
        await page.getByTestId('settings-cancel').click();

        await page.getByTestId('menu-help').click();
        await page.getByTestId('menu-items-help').locator('[data-command="help.shortcuts"]').click();
        await expect(page.getByTestId('shortcuts-panel-row').first()).toBeVisible();
        const close = await page.getByTestId('shortcuts-panel-close').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { bottom: r.bottom, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el };
        });
        expect(close.hit, `${label} ショートカット一覧の［閉じる］`).toBe(true);
        expect(close.bottom).toBeLessThanOrEqual(size.height);
      } finally {
        await app.close();
      }
    });

    test(`${label}: 保存の前の確認の板の確定の列は、窓の中に収まる`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        await openPreSaveBoard(page);
        await expectUnified(page, `${label} 保存の前の確認`);
        const dialog = await page.getByTestId('pre-save-dialog').boundingBox();
        expect((dialog?.x ?? 0) + (dialog?.width ?? 0)).toBeLessThanOrEqual(size.width);
        const cancel = page.getByTestId('pre-save-cancel');
        const confirm = page.getByTestId('pre-save-confirm');
        for (const button of [cancel, confirm]) {
          const box = await button.boundingBox();
          expect(box).not.toBeNull();
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
        }
        // 短いボタンの文字は、長い隣に押されて縦に折れない
        const { controls } = await readControlMetrics(page);
        expect(controls.find((c) => c.testid === 'pre-save-cancel')?.lines).toBe(1);
      } finally {
        await app.close();
      }
    });

    test(`${label}: 重なりの解決の板（押されている行の文字が読める）`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        const rect = (cx: number, cy: number, hw: number, hh: number): readonly ScreenPoint[] => [
          [cx - hw, cy - hh],
          [cx + hw, cy - hh],
          [cx + hw, cy + hh],
          [cx - hw, cy + hh],
        ];
        await leaveViewMode(page);
        await jumpToYear(page, 1200);
        await armAddAreaTool(page);
        const b = await addInputLayerBox(page);
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        await drawFace(page, rect(cx, cy, 120, 30), { name: '横長' });
        await armAddAreaTool(page);
        await drawFace(page, rect(cx, cy, 30, 100), { name: '縦長', waitForSelection: false });
        await expect(page.getByTestId('conflict-dialog')).toBeVisible();
        await expectUnified(page, `${label} 重なりの解決`);
      } finally {
        await app.close();
      }
    });

    test(`${label}: メニューの中身が帯に切られず、押せる位置に見える`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        let disabledItems = 0;
        for (const menu of ['file', 'edit', 'view', 'tools', 'help']) {
          await page.getByTestId(`menu-${menu}`).click();
          // `click()` ではなく当たりを直接見る ―― Playwright の click は overflow: hidden の帯を
          // 中でスクロールしてから押すので、切れていても通る（教訓 5.105）。
          const seen = await page.getByTestId(`menu-items-${menu}`).evaluate((list) => {
            const box = list.getBoundingClientRect();
            const first = list.querySelector('button')?.getBoundingClientRect();
            const hit =
              first === undefined
                ? null
                : document.elementFromPoint(first.left + first.width / 2, first.top + first.height / 2);
            return {
              below: box.top,
              bottom: box.bottom,
              hit: hit !== null && list.contains(hit),
              barScroll: list.closest('.app-shell__menubar')?.scrollTop ?? -1,
            };
          });
          expect(seen.hit, `${menu}: 先頭の項目に当たる`).toBe(true);
          expect(seen.below, `${menu}: 帯の下に出る`).toBeGreaterThanOrEqual(32);
          expect(seen.bottom, `${menu}: 窓の中に収まる`).toBeLessThanOrEqual(size.height);
          expect(seen.barScroll, `${menu}: 帯が中でスクロールしていない`).toBe(0);
          await expectUnified(page, `${label} メニュー ${menu}`);
          const { controls } = await readControlMetrics(page);
          disabledItems += controls.filter((c) => c.disabled && c.cls.includes('menubar__item')).length;

          // 吹き出しは、どの項目に載せても項目の文字を隠さない（先頭・中ほど・末尾）。
          const items = page.getByTestId(`menu-items-${menu}`).locator('button');
          const count = await items.count();
          for (const index of [0, Math.floor(count / 2), count - 1]) {
            await items.nth(index).hover();
            const overlap = await page.getByTestId(`menu-items-${menu}`).evaluate((list) => {
              const bubble = list.querySelector('[data-testid="tooltip-bubble"]:not([hidden])');
              if (bubble === null) return { shown: false, covers: 0, inWindow: false };
              const b = bubble.getBoundingClientRect();
              const covers = Array.from(list.querySelectorAll('button')).filter((button) => {
                const r = button.getBoundingClientRect();
                return b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom;
              }).length;
              return {
                shown: b.width > 0,
                covers,
                inWindow: b.right <= window.innerWidth && b.bottom <= window.innerHeight && b.left >= 0 && b.top >= 0,
              };
            });
            expect(overlap.shown, `${menu} の ${String(index)} 番目: 吹き出しが出る`).toBe(true);
            expect(overlap.covers, `${menu} の ${String(index)} 番目: 吹き出しが項目を隠さない`).toBe(0);
            expect(overlap.inWindow, `${menu} の ${String(index)} 番目: 吹き出しが窓の中`).toBe(true);
          }
          await page.mouse.move(1, 1);
          await page.keyboard.press('Escape');
        }
        expect(disabledItems, `${label}: 無効の項目を測った数`).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });

    test(`${label}: 右クリックメニューは窓の中に収まり、全部の項目が押せて、行の形に揃う`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        await leaveViewMode(page);
        const { cx, cy } = await commitOneFace(page);
        const map = await page.getByTestId('map-input-layer').boundingBox();
        if (map === null) throw new Error('地図の矩形が取れない');

        // 面の上（項目がいちばん多い）・地図の右下の隅（窓の外へ出やすい）の 2 か所で開く
        for (const [where, x, y] of [
          ['面の上', cx, cy],
          ['右下の隅', map.x + map.width - 2, map.y + map.height - 2],
        ] as const) {
          await page.mouse.click(x, y, { button: 'right' });
          const menu = page.getByTestId('context-menu');
          await expect(menu).toBeVisible();
          await expectUnified(page, `${label} 右クリック ${where}`);
          const seen = await menu.evaluate((list) => {
            const box = list.getBoundingClientRect();
            const rows = Array.from(list.querySelectorAll('button')).map((button) => {
              const r = button.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return { w: r.width, hit: hit === button, bg: getComputedStyle(button).backgroundColor };
            });
            return {
              top: box.top,
              bottom: box.bottom,
              left: box.left,
              right: box.right,
              inner: list.clientWidth,
              rows,
            };
          });
          expect(seen.top, `${where}: 上端`).toBeGreaterThanOrEqual(0);
          expect(seen.left, `${where}: 左端`).toBeGreaterThanOrEqual(0);
          expect(seen.bottom, `${where}: 下端`).toBeLessThanOrEqual(size.height);
          expect(seen.right, `${where}: 右端`).toBeLessThanOrEqual(size.width);
          expect(seen.rows.length, `${where}: 項目の数`).toBeGreaterThan(3);
          for (const row of seen.rows) {
            expect(row.hit, `${where}: 項目の中心に当たる`).toBe(true);
            // 行は器の幅いっぱいで、箱の地を持たない（幅 41〜174px の白い箱の積み重ねにしない）
            expect(row.w, `${where}: 項目の幅`).toBe(seen.inner);
            expect(row.bg, `${where}: 項目の地`).toBe('rgba(0, 0, 0, 0)');
          }
          await page.keyboard.press('Escape');
          await expect(menu).toHaveCount(0);
        }
      } finally {
        await app.close();
      }
    });

    test(`${label}: 窓より低いと右クリックメニューは中でスクロールする`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        await leaveViewMode(page);
        const { cx, cy } = await commitOneFace(page);
        await page.mouse.click(cx, cy, { button: 'right' });
        const menu = page.getByTestId('context-menu');
        await expect(menu).toBeVisible();
        const before = await menu.evaluate((list) => list.getBoundingClientRect().height);
        // 開いたまま窓を縮める（最小の窓より低い状態は実際には作れないので、器の高さで確かめる）
        await menu.evaluate((list) => {
          list.style.maxHeight = '100px';
        });
        const scroll = await menu.evaluate((list) => {
          list.scrollTop = 40;
          return { top: list.scrollTop, full: list.scrollHeight, height: list.clientHeight };
        });
        expect(before).toBeGreaterThan(100);
        expect(scroll.full).toBeGreaterThan(scroll.height);
        expect(scroll.top).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });

    test(`${label}: 結ぶ・分ける・所属の板`, async () => {
      test.setTimeout(120_000);
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        const { leftX, rightX, y } = await twoFaces(page);

        // 結ぶ: 確定は名前を入れるまで無効
        await page.getByTestId('tool-edit.merge').click();
        await page.mouse.click(leftX, y);
        await page.mouse.click(rightX, y);
        await page.getByTestId('merge-confirm').click();
        await expect(page.getByTestId('merge-options-dialog')).toBeVisible();
        await expectUnified(page, `${label} 結ぶの板`);
        await page.getByTestId('merge-parent-existing').click();
        await expectUnified(page, `${label} 結ぶの板（既存の上位）`);
        await page.getByTestId('merge-options-cancel').click();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        // 所属: 候補の行は 28px の高さいっぱいを押せる
        await page.getByTestId('tool-edit.reparent').click();
        await page.mouse.click(leftX, y);
        await page.getByTestId('reparent-confirm').click();
        await expect(page.getByTestId('reparent-options-dialog')).toBeVisible();
        await expectUnified(page, `${label} 所属の板`);
        const parentExisting = page.getByTestId('reparent-parent-existing');
        if ((await parentExisting.count()) > 0) await parentExisting.click();
        const pick = page.locator('[data-testid^="reparent-parent-existing-pick-item-"]').first();
        await expect(pick).toBeVisible();
        const pickId = (await pick.getAttribute('data-testid')) ?? '';
        const edges = await edgesHit(page, pickId);
        expect(edges.h, '候補の行の押せる高さ').toBe(edges.rowHeight);
        expect(edges.h).toBe(28);
        expect(edges.top, '候補の行の上の縁').toBe(true);
        expect(edges.bottom, '候補の行の下の縁').toBe(true);
        await page.getByTestId('reparent-options-cancel').click();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        // 分ける: 線を引いて確定すると、継承先を選ぶ板が出る
        await page.getByTestId('tool-edit.knife').click();
        await page.mouse.click(leftX, y);
        await page.mouse.click(leftX - 70, y);
        await page.mouse.click(leftX + 70, y);
        await expectUnified(page, `${label} 分けるの線`);
        await page.getByTestId('knife-confirm-cut').click();
        await expect(page.getByTestId('knife-choose-0')).toBeVisible();
        await expectUnified(page, `${label} 分けるの板`);
        await page.getByTestId('knife-choose-0').click();
        await expectUnified(page, `${label} 分けるの板（選んだあと）`);
      } finally {
        await app.close();
      }
    });

    test(`${label}: 一覧の 👁 と種別は行の高さいっぱいを押せる`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        await leaveViewMode(page);
        await commitOneFace(page);
        await page.getByTestId('sidebar-tab-list').click();
        const eye = page.locator('[data-testid^="ledger-eye-"]').first();
        await expect(eye).toBeVisible();
        const eyeId = (await eye.getAttribute('data-testid')) ?? '';
        const kindId = eyeId.replace('ledger-eye-', 'ledger-kind-');
        for (const id of [eyeId, kindId]) {
          const edges = await edgesHit(page, id);
          expect(edges.h, `${id} の高さ`).toBeGreaterThanOrEqual(edges.rowHeight - 1);
          expect(edges.h, `${id} の高さ`).toBeGreaterThanOrEqual(24);
          expect(edges.top, `${id} の上の縁`).toBe(true);
          expect(edges.bottom, `${id} の下の縁`).toBe(true);
        }
      } finally {
        await app.close();
      }
    });

    test(`${label}: 状態行の × は行の高さいっぱいを押せて、行の箱は動かない`, async () => {
      const { app, page } = await launchApp();
      try {
        await page.setViewportSize(size);
        await leaveViewMode(page);
        await commitOneFace(page);
        const dismiss = page.getByTestId('statusbar-result-dismiss');
        await expect(dismiss).toBeVisible();
        const box = await dismiss.boundingBox();
        const bar = await page.getByTestId('statusbar-result').evaluate((el) => {
          const strip = el.closest('.statusbar')?.getBoundingClientRect();
          return { h: strip?.height ?? 0 };
        });
        expect(bar.h, '状態行の高さ').toBe(28);
        expect(box?.height, '× の高さ').toBe(28);
        expect(box?.width ?? 0, '× の幅').toBeGreaterThanOrEqual(24);
      } finally {
        await app.close();
      }
    });
  }
});
