// 増分 3 の **手直し**（4 本の検証で出た指摘）を、実アプリで固定する。
//
// ここに置いたものは、**単体テストでは緑のまま**になりうる型の欠陥である（配線の欠落・
// 局面ごとの食い違い・実際のレイアウトに依存する寸法）。だから実アプリでなければならない
// （開発ガイド §5.49）。
//
// 固定するもの:
//   A1 年をまたいで共有した頂点が、後の年でも移動後の場所に居る（反証 #1 / GPT #1）
//   A5 移動後の辺が世界を半周以上になると断られ、理由が出る（反証 #4 / GPT #7）
//   B2 入れ子で確定した地物の上位領域が既定で **いちばん内側の親** になり、
//      2 人目・3 人目の子でも入り、保存しても保たれる（GPT #4）
//   C1 確定欄の 2 つのボタンが 176px の枠に収まる（設計 S3-3）
//   C5 吸着 ▾ を**閉じた**状態でも、地図セルのどこを押しても入力層に届く（教訓 5.56）
//
// **ここに入れなかったもの**:
//   A4（地図を 2 周以上パンしても照会が外れない）… カメラの中心経度は代表の範囲へ
//     折り返され、見えている経度の幅も 2 周に満たないので、**いまの実アプリでは
//     2 周のパンが作れない**。0〜3 周は `src/ui/live-lookup.test.tsx` の
//     「A4: 地図を 2 周以上パンしても照会が外れない」が直接固定している。

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
  requestYear,
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

      // 起動直後の全体表示では、**地図セルの幅がほぼ 360 度**である。だから
      // 「セルの幅の半分より少し多く」引きずれば経度で 180 度を超え、保存形式が
      // 表現できない辺ができる。
      //
      // **px の直書きをやめた**（増分 4）。右パネルが 220 → 280px になって地図セルが
      // 60px 狭くなったので、以前の 500px は ①度に直すと 180 度を超えるが ②終点が
      // 右パネルの上に出てしまい、掴んだままの移動が地図セルの外で終わっていた。
      // セルの実寸から出せば、以後どんな幅でも「半周より少し多い」を保てる。
      const dragPx = Math.round(b.width * 0.53); // 360 度 × 0.53 ≒ 191 度
      const corner = corners[0]!;
      await page.mouse.move(corner[0], corner[1]);
      await page.mouse.down();
      await page.mouse.move(corner[0] + dragPx, corner[1], { steps: 12 });
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

  test('B2: 上位領域は「いちばん内側の親」が既定になり、2 人目・3 人目でも入る', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-nest-'));
    const target = join(workDir, 'nested.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;

      // **面を 2 つ作る**（1 つだけだと「候補を絞っているか」を区別できない ―― 絞っても
      // 絞らなくても選択肢は「なし＋その 1 件」で同じになる）。
      const outsideId = await drawFace(page, squareCorners(cx - 260, cy, 60), { name: '外の面' });
      await armAddAreaTool(page);
      const parentId = await drawFace(page, squareCorners(cx + 60, cy, 150), { name: '親' });
      expect(parentId).not.toBe('');
      expect(outsideId).not.toBe(parentId);

      /** 親の内側に子を描いて確定し、上位領域の欄の状態を返す。 */
      const drawChild = async (
        ccx: number,
        ccy: number,
        half: number,
        name: string,
      ): Promise<{ value: string; options: number }> => {
        await armAddAreaTool(page);
        await placeVertices(page, squareCorners(ccx, ccy, half));
        await page.getByTestId('add-complete').click();
        const select = page.getByTestId('add-parent');
        await expect(select).toBeVisible();
        const options = await select.locator('option').count();
        const value = await select.inputValue();
        await page.getByTestId('add-name').fill(name);
        await page.getByTestId('add-save').click();
        await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
        return { value, options };
      };

      // 1 人目: 親の中。既定は親。
      const first = await drawChild(cx + 10, cy - 70, 35, '子1');
      expect(first.value).toBe(parentId);
      // **候補は絞られていない** ―― 親の中に居ないはずの「外の面」も選べる
      //（＝「上位領域なし」＋「外の面」＋「親」の 3 件）。
      expect(first.options).toBe(3);

      // 2 人目: 親の中の別の場所。**ここが 1 回目の手直しで空になっていた**
      //（含む面が「親」だけでも、当時の実装は「一意なら」を数え損ねる場面があった）。
      const second = await drawChild(cx + 110, cy - 70, 35, '子2');
      expect(second.value).toBe(parentId);

      // 3 人目: **1 人目の中**に描く。含む面は「子1 → 親」の 2 つになるので、
      // 「一意なら」では既定が入らない。**いちばん内側**＝子1 が入る。
      const third = await drawChild(cx + 10, cy - 70, 12, '子3');
      expect(third.value).not.toBe('');
      expect(third.value).not.toBe(parentId);

      // 保存 → 書かれたファイルを直接読む（画面だけでは親が焼き付いたか分からない）。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expect(existsSync(target)).toBe(true);
      const manifest = strFromU8(
        unzipSync(new Uint8Array(readFileSync(target)))['manifest.json']!,
      );
      // 子 3 つとも上位領域を持っている（黙って最上位で保存されていない）。
      const parented = manifest.split('"parentId"').length - 1;
      expect(parented).toBeGreaterThanOrEqual(3);
      expect(manifest).toContain(`"parentId":"${parentId}"`);
      // 3 人目の上位領域は 1 人目（＝いちばん内側）である。
      expect(manifest).toContain(`"parentId":"${third.value}"`);
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

  test('D1: 作図中に年を動かすと確認が出て、答えるまで年は動かない', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      // 確定できる点数（面は 3 点）まで打つ。
      await placeVertices(page, squareCorners(cx, cy, 60));
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');

      // **頼むだけ**（動いたことは確かめない）。2026-09-07 の手直しで、板を出す瞬間に
      // 年を元へ戻すようにした（教訓 5.71: 確認は行動の前。旧版は先に動かしてから
      // 聞いていたので、板の後ろでは **もう 1500 年の地図**が見えていた）。
      await requestYear(page, 1500);
      const confirm = page.getByTestId('add-draft-discard-confirm');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('年を動かす');
      // **板が出ているあいだ、年は 0 のまま。**
      await expect(page.getByTestId('timeline-current')).toHaveText('0年');
      // **状態行も「移動しました」と言わない**（2026-09-07 の最終手直し）。旧版は
      // ストアへ書いた直後に言い切っていたので、年が戻されても状態行だけが
      // 「1500年へ移動しました」と言い続けていた（画面が嘘をつく）。
      expect(await page.getByTestId('statusbar-result').textContent()).not.toContain(
        '移動しました',
      );

      // 「続ける」＝下書きを残す（年はもう戻っているので何も起きない）。**板は閉じた
      // ままでなければならない** ―― 年を戻したこと自体を見張りが新しい変化と読むと、
      // 板が開き直って年が 0 ⇄ 1500 を往復し、「捨てる」以外に抜け道が無くなる（実測 r2d）。
      await page.getByTestId('add-draft-discard-no').click();
      await expect(confirm).toBeHidden();
      await expect(page.getByTestId('timeline-current')).toHaveText('0年');
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');
      // 少し待っても開き直らない（往復が起きていないことを見る）。
      await page.waitForTimeout(700);
      await expect(confirm).toBeHidden();
      await expect(page.getByTestId('timeline-current')).toHaveText('0年');
    } finally {
      await app.close();
    }
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
