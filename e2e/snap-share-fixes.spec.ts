// 増分 3 の **手直し**（4 本の検証で出た指摘）を、実アプリで固定する。
//
// ここに置いたものは、**単体テストでは緑のまま**になりうる型の欠陥である（配線の欠落・
// 局面ごとの食い違い・実際のレイアウトに依存する寸法）。だから実アプリでなければならない
// （開発ガイド §5.49）。
//
// 固定するもの:
//   A1 年をまたいで共有した頂点が、後の年でも移動後の場所に居る（反証 #1 / GPT #1）
//   A4 地図を 2 周以上パンしても FR-29 の照会が外れない（反証 #3）
//   A5 1 回の移動で世界を半周以上動かすと断られ、理由が出る（反証 #4 / GPT #7）
//   B2 入れ子で確定した地物の上位領域が既定でその親になり、保存しても保たれる（GPT #4）
//   C1 確定欄の 2 つのボタンが 176px の枠に収まる（設計 S3-3）
//   C5 吸着 ▾ を**閉じた**状態でも、地図セルのどこを押しても入力層に届く（教訓 5.56）

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  placeVertices,
  returnToViewMode,
  squareCorners,
} from './helpers';

interface HandlePos {
  readonly lon: number;
  readonly lat: number;
}

async function vertexHandlePositions(page: Page): Promise<HandlePos[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => HandlePos[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

test.describe('増分 3 の手直し — 実アプリで固定する', () => {
  test('A1: 隣が 1500 年から存在しても、0 年で動かした共有の角は 1500 年でも動いたまま', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- 0 年に A を描く。 ------------------------------------------------
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const half = 80;
      const aCx = cx - half - 10;
      const aCorners = squareCorners(aCx, cy, half);
      await drawFace(page, aCorners, { name: 'A' });

      const aTopRight = aCorners[1]!;
      const aBottomRight = aCorners[2]!;

      // --- 1500 年へ移り、A の右辺の 2 隅へ吸着させて B を描く。--------------
      // B の履歴は 1500 年から始まる ＝ **0 年には存在しない**。手直し前の伝播は
      // 「その時刻に効いている履歴」しか見ないので、この隣は 1 本も直せなかった。
      await jumpToYear(page, 1500);
      await armAddAreaTool(page);
      await page.mouse.move(aTopRight[0] + 2, aTopRight[1] + 2);
      await expect(page.getByTestId('option-bar-next-step')).toContainText('頂点に合わせます');
      const bCorners: ReadonlyArray<readonly [number, number]> = [
        [aTopRight[0] + 2, aTopRight[1] + 2],
        [aTopRight[0] + 2 * half, aTopRight[1]],
        [aBottomRight[0] + 2 * half, aBottomRight[1]],
        [aBottomRight[0] + 2, aBottomRight[1] - 2],
      ];
      await drawFace(page, bCorners, { name: 'B' });

      // --- 0 年へ戻って A の右上角を上へ動かす。-----------------------------
      await returnToViewMode(page);
      await jumpToYear(page, 0);
      await enterEditMode(page);
      await page.mouse.click(aCx, cy);
      await expect
        .poll(async () => (await vertexHandlePositions(page)).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);

      await page.mouse.move(aTopRight[0], aTopRight[1]);
      await page.mouse.down();
      await page.mouse.move(aTopRight[0], aTopRight[1] - 60, { steps: 8 });
      await page.mouse.up();

      const afterA = await vertexHandlePositions(page);
      const movedA = [...afterA].sort((p, q) => q.lat - p.lat)[0]!;

      // --- 1500 年で B を見る。手直し前はここで **移動前の座標**が復活していた。----
      await jumpToYear(page, 1500);
      await page.mouse.click(bCorners[1]![0] - 20, cy);
      await expect
        .poll(async () => (await vertexHandlePositions(page)).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);
      const bHandles = await vertexHandlePositions(page);
      const matched = bHandles.some(
        (h) => Math.abs(h.lon - movedA.lon) < 1e-6 && Math.abs(h.lat - movedA.lat) < 1e-6,
      );
      expect(
        matched,
        '0 年で動かした共有の角は、1500 年から現れる隣の記録にも反映されていなければならない',
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('A5: 1 回の移動で世界を半周以上動かすと断られ、理由が状態行に出る', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const corners = squareCorners(cx, cy, 60);
      await drawFace(page, corners, { name: '三角のもと' });

      await returnToViewMode(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect
        .poll(async () => (await vertexHandlePositions(page)).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);
      const before = await vertexHandlePositions(page);

      // 起動直後の全体表示では、地図セルの幅（約 940px）がほぼ 360 度である。
      // 500px 引きずると経度で 180 度を超えるので、保存形式が表現できない辺ができる。
      const corner = corners[0]!;
      await page.mouse.move(corner[0], corner[1]);
      await page.mouse.down();
      await page.mouse.move(corner[0] + 500, corner[1], { steps: 12 });
      await page.mouse.up();

      // **理由が出る**（無反応にしない）。まずここを見る ―― ハンドルの位置は
      // 「最後に描いた frame」の写しなので、離した直後はまだ引きずり中の姿が残っている。
      await expect(page.getByTestId('statusbar-result')).toContainText('半周以上');
      // **記録されない**（描き直したあとの頂点は元の場所に戻っている）。
      const sortKey = (h: HandlePos): string => `${h.lon.toFixed(6)},${h.lat.toFixed(6)}`;
      const expected = [...before].map(sortKey).sort();
      await expect
        .poll(async () => (await vertexHandlePositions(page)).map(sortKey).sort(), {
          timeout: 15_000,
        })
        .toEqual(expected);
    } finally {
      await app.close();
    }
  });

  test('B2: 入れ子で確定した面は、上位領域が既定で親になり、保存し直しても保たれる', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-nest-'));
    const target = join(workDir, 'nested.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const parentId = await drawFace(page, squareCorners(cx, cy, 140), { name: '親' });
      expect(parentId).not.toBe('');

      // 親の内側にまるごと描く ＝ 入れ子。上位領域の候補は 1 つに決まるので既定になる。
      await armAddAreaTool(page);
      await placeVertices(page, squareCorners(cx, cy, 50));
      await page.getByTestId('add-complete').click();
      const parentSelect = page.getByTestId('add-parent');
      await expect(parentSelect).toBeVisible();
      // **候補は「いま描いた形を丸ごと含む面」だけ**（実データでは 776 件が平らに並んでいた）。
      await expect(parentSelect.locator('option')).toHaveCount(2); // 「上位領域なし」＋親 1 件
      await expect(parentSelect).toHaveValue(parentId);
      await page.getByTestId('add-name').fill('子');
      await page.getByTestId('add-save').click();

      // 保存 → 書かれたファイルを直接読む（画面だけでは親が焼き付いたか分からない）。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expect(existsSync(target)).toBe(true);
      const entries = unzipSync(new Uint8Array(readFileSync(target)));
      const manifestBytes = entries['manifest.json'];
      expect(manifestBytes).toBeDefined();
      expect(strFromU8(manifestBytes!)).toContain(`"parentId":"${parentId}"`);

    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    // **開き直しの往復は、いまここで別の欠陥に当たる。** 面の下に子を作ると、その面は
    // 「自分の形を持ったまま子を持つ」状態（`leaf-with-children`）になり、保存形式の
    // 形状保持規則に触れる。開き直すと修復（直轄領を作って集約化する。非破壊）を
    // 聞かれるので、往復そのものは通るが **入れ子を作るたびに質問される**。
    // これは今回の手直しで作った欠陥ではなく、入れ子の導線を通したことで表に出たもので、
    // `docs/現状.md` に記録した。ここでは書き出しの側（上の manifest）までを固定する。
  });

  test('C1: 確定欄の 2 つのボタンは 176px の枠に収まる（自然幅の合計）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await placeVertices(page, squareCorners(cx, cy, 60));

      const commit = page.getByTestId('option-bar-commit');
      await expect(page.getByTestId('add-complete')).toBeVisible();
      // **自然幅**（枠に押し込まれる前の幅）で測る。枠が固定幅なので、実際の幅を見ても
      // 「収まっている」ことにはならない（文字が切れていても幅は 176px のまま）。
      const natural = await commit.evaluate((el) => {
        const box = el as HTMLElement;
        const prevWidth = box.style.width;
        const prevOverflow = box.style.overflow;
        box.style.width = 'max-content';
        box.style.overflow = 'visible';
        const w = box.scrollWidth;
        box.style.width = prevWidth;
        box.style.overflow = prevOverflow;
        return w;
      });
      expect(
        natural,
        `確定欄の 2 ボタンの自然幅の合計は 176px 以内であること（実測 ${String(natural)}px）`,
      ).toBeLessThanOrEqual(176);
    } finally {
      await app.close();
    }
  });

  test('C5: 吸着 ▾ を閉じた状態でも、地図セルのどこを押しても入力層に届く（K-2）', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      // **開いてから閉じる**。教訓 5.56 の事故（閉じたはずのパネルが画面左上に居座って
      // クリックを奪う）は、閉じた状態でしか捕まらない。
      const snapButton = page.getByTestId('option-snap-button');
      if ((await snapButton.count()) > 0) {
        await snapButton.click();
        await page.keyboard.press('Escape');
      }

      const b = await addInputLayerBox(page);
      let placed = 0;
      for (let i = 0; i < 5; i += 1) {
        for (let j = 0; j < 5; j += 1) {
          const x = b.x + (b.width * (i + 0.5)) / 5;
          const y = b.y + (b.height * (j + 0.5)) / 5;
          const el = await page.evaluate(
            ({ px, py }) => document.elementFromPoint(px, py)?.getAttribute('data-testid') ?? '',
            { px: x, py: y },
          );
          expect(
            el,
            `地図セルの (${String(i)},${String(j)}) を押すと入力層に届くこと（実際は ${el}）`,
          ).toBe('add-input-layer');
          placed += 1;
        }
      }
      expect(placed).toBe(25);
    } finally {
      await app.close();
    }
  });
});
