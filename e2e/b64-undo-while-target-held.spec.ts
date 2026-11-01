// B64: 道具が対象だけを掴んでいて戻す点が無いとき、Ctrl+Z / Ctrl+Y は大域の取り消し・やり直しへ
// 届く。点があるあいだは今までどおり道具が 1 つ戻し、大域へは届かない。

import { expect, test, type Page } from '@playwright/test';

import {
  besideSquareX,
  commitOneFace,
  commitSquareFace,
  launchApp,
  DEFAULT_FACE_HALF,
} from './helpers';

const SMALL_HALF = 60;

interface Faces {
  readonly a: { readonly x: number; readonly y: number };
  readonly b: { readonly x: number; readonly y: number };
}

/** 面を 2 つ確定する（取り消しの相手は後から足した面 B）。道具は持っていない状態で返す。 */
async function twoFaces(page: Page): Promise<Faces> {
  const first = await commitOneFace(page);
  const bx = besideSquareX(first.cx, DEFAULT_FACE_HALF, SMALL_HALF);
  await commitSquareFace(page, bx, first.cy, SMALL_HALF);
  await page.getByTestId('tool-edit.select').click();
  await expect(page.getByTestId('app-can-undo')).toHaveText('1');
  await expect(page.getByTestId('app-can-redo')).toHaveText('0');
  return { a: { x: first.cx, y: first.cy }, b: { x: bx, y: first.cy } };
}

const TOOLS = [
  { label: '分ける', tool: 'tool-edit.knife', promotes: true },
  { label: '輪郭', tool: 'tool-edit.ring', promotes: true },
  { label: '穴あけ', tool: 'tool-edit.drill', promotes: true },
  // 結ぶは掴んだ面を選択へ引き上げない（選択は直前に足した面のままで、取り消しで外れる）。
  { label: '結ぶ', tool: 'tool-edit.merge', promotes: false },
] as const;

test.describe('B64 — 対象だけを掴んでいるあいだの Ctrl+Z / Ctrl+Y', () => {
  for (const { label, tool, promotes } of TOOLS) {
    test(`${label}: 別の面の追加を取り消してやり直せる。掴んだ対象はそのまま`, async () => {
      const { app, page } = await launchApp();
      try {
        const { a } = await twoFaces(page);
        await page.getByTestId(tool).click();
        await page.mouse.click(a.x, a.y);
        await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');
        const active = await page.getByTestId('app-active-feature').textContent();

        await page.keyboard.press('Control+z');
        await expect(page.getByTestId('app-can-redo')).toHaveText('1');
        // 対象は掴んだまま（道具は鍵盤を持ち続け、選択も変わらない）。
        await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');
        if (promotes) await expect(page.getByTestId('app-active-feature')).toHaveText(active ?? '');

        await page.keyboard.press('Control+y');
        await expect(page.getByTestId('app-can-redo')).toHaveText('0');
        await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');
      } finally {
        await app.close();
      }
    });
  }

  for (const { label, tool, kept } of [
    { label: '分ける', tool: 'tool-edit.knife', kept: 'knife-tool' },
    { label: '輪郭', tool: 'tool-edit.ring', kept: 'ring-edit-tool' },
    { label: '穴あけ', tool: 'tool-edit.drill', kept: 'drill-tool' },
  ] as const) {
    test(`${label}: 点があるあいだは道具が 1 つ戻し、無くなってから大域へ届く`, async () => {
      const { app, page } = await launchApp();
      try {
        const { a } = await twoFaces(page);
        await page.getByTestId(tool).click();
        await page.mouse.click(a.x, a.y);
        const flowBefore = await page.getByTestId(kept).getAttribute('data-flow');
        // 面の内側に 1 点打つ（穴あけ・輪郭）／分断線の 1 点目（分ける）。
        await page.mouse.click(a.x - 20, a.y - 20);

        await page.keyboard.press('Control+z');
        // 大域へは届かない。
        await expect(page.getByTestId('app-can-redo')).toHaveText('0');
        // 掴んだ対象は離さない。
        await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');
        await expect(page.getByTestId(kept)).toHaveAttribute('data-flow', flowBefore ?? '');

        // 2 回目は戻す点が無いので大域へ届く。対象はやはり掴んだまま。
        await page.keyboard.press('Control+z');
        await expect(page.getByTestId('app-can-redo')).toHaveText('1');
        await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');
      } finally {
        await app.close();
      }
    });
  }

  for (const { label, tool } of TOOLS) {
    test(`${label}: 掴んでいる面そのものを取り消しで消しても壊れない`, async () => {
      const { app, page } = await launchApp();
      try {
        const { a, b } = await twoFaces(page);
        await page.getByTestId(tool).click();
        await page.mouse.click(b.x, b.y);
        await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');

        await page.keyboard.press('Control+z');
        await expect(page.getByTestId('app-can-redo')).toHaveText('1');
        // 消えた面を掴んだままにならない: 残った面 A を掴み直せて、道具は動き続ける。
        await page.mouse.click(a.x, a.y);
        await expect(page.getByTestId('app-focus-owner')).toHaveText('tool-drawing');
        await expect(page.getByTestId(tool)).toHaveAttribute('aria-pressed', 'true');
      } finally {
        await app.close();
      }
    });
  }
});
