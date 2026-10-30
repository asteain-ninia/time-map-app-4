// 見た目の統一（増分 8E 後半 / N-24・N-25・N-26・N-28）を実機の寸法で固定する。
//
// 宣言の側は `src/ui/shell/visual-unity.test.ts`。ここは実際にレイアウトした結果を見る（教訓 5.49 の 2 段目）。
// 既定の窓と最小の窓で代表の画面を回し、見えているボタンと見出しを全部測る。例外は数でなく
// 顔ぶれで書く（教訓 5.83）。

import { expect, test, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  drawFace,
  jumpToYear,
  launchApp,
  leaveViewMode,
  openPreSaveBoard,
  readControlMetrics,
  type ControlMetrics,
  type ScreenPoint,
} from './helpers';

const WINDOWS = [
  { width: 1280, height: 800 },
  { width: 800, height: 600 },
] as const;

/** 揃えた高さ（設計変数 24 / 28 / 32）と、道具のレール（32）・地図のズーム（40）。 */
const ALLOWED_HEIGHTS = [24, 28, 32, 40];

/** 細い行の中にあるので、行の高さに従うボタン。 */
const ROW_BOUND = /^(ledger-|feature-list-item-|statusbar-|parent-tree-|conflict-row-select-)/;

/** 1 ボタンの中に複数行の情報を並べる行（ラベルではない）。 */
const MULTI_LINE_ROW = /^(anchor-row-|conflict-row-select-|backup-row-)/;

/** 確定の文そのものが板の幅より長いボタン（文言は総点検で直す。docs/現状.md の B103）。 */
const LONG_LABEL = new Set(['pre-save-confirm']);

function problems(controls: readonly ControlMetrics[]): string[] {
  const out: string[] = [];
  for (const c of controls) {
    if (c.tag !== 'button') continue;
    const name = c.testid ?? `.${c.cls}`;
    if (c.border.includes('outset')) out.push(`${name}: ブラウザ既定の枠 (${c.border})`);
    if (c.radius === '0px' && !c.border.startsWith('0px')) out.push(`${name}: 角丸なしの枠`);
    // 土台の「押されている」は文字を白にする。自分で背景を消した部品が色を書き忘れると文字が消える。
    if (c.color === 'rgb(255, 255, 255)' && /^(rgba\(0, 0, 0, 0\)|rgb\(255, 255, 255\))$/.test(c.bg)) {
      out.push(`${name}: 白い背景に白い文字「${c.text}」`);
    }
    const boundByRow = ROW_BOUND.test(name) || LONG_LABEL.has(name);
    if (!boundByRow && !ALLOWED_HEIGHTS.some((h) => Math.abs(c.h - h) <= 0.5)) {
      out.push(`${name}: 高さ ${String(c.h)}px`);
    }
    if (c.lines > 1 && !MULTI_LINE_ROW.test(name) && !LONG_LABEL.has(name)) {
      out.push(`${name}: ${String(c.lines)} 行に折り返す「${c.text}」`);
    }
  }
  return out;
}

async function expectUnified(page: Page, where: string): Promise<void> {
  const { controls, headings } = await readControlMetrics(page);
  expect(controls.filter((c) => c.tag === 'button').length, `${where}: 測ったボタンの数`).toBeGreaterThan(3);
  expect(problems(controls), where).toEqual([]);
  for (const h of headings) {
    expect(['16px', '13px', '12px'], `${where}: 見出し「${h.text}」の大きさ`).toContain(h.fontSize);
    expect(h.fontWeight, `${where}: 見出し「${h.text}」の太さ`).toBe('600');
  }
}

test.describe('見た目の統一（N-24 / N-25 / N-26 / N-28）', () => {
  for (const size of WINDOWS) {
    const label = `${String(size.width)}x${String(size.height)}`;

    test(`${label}: 起動直後のガイド・シェル・道具を構えた帯`, async () => {
      const { app, page } = await launchApp({ keepFirstRunGuide: true });
      try {
        await page.setViewportSize(size);
        await expect(page.getByTestId('first-run-guide')).toBeVisible();
        await expectUnified(page, `${label} ガイド`);
        await page.getByTestId('first-run-guide-close').click();
        await expectUnified(page, `${label} 空の画面`);
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

        await page.getByTestId('menu-tools').click();
        await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
        await expect(page.getByTestId('settings-dialog')).toBeVisible();
        for (const tab of ['project', 'app', 'backup']) {
          await page.getByTestId(`settings-tab-${tab}`).click();
          await expectUnified(page, `${label} 設定 ${tab}`);
        }
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
          await page.keyboard.press('Escape');
        }
      } finally {
        await app.close();
      }
    });
  }
});
