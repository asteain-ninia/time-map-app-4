// 増分 3 の受け入れ条件を、実アプリで固定する（V2 / FR-29 / N-51 / K-2 / K-3）。
//
// 現状分析 C1 が言う「部品はあるのに配線されていない」は、**単体テストでは緑のまま**に
// なる型の欠陥である（ポートの型宣言はあり、渡す側が渡していないだけ）。だから検査は
// 実アプリでなければならない（開発ガイド §5.49）。
//
// ここで固定するもの:
//   1. **V2 ①** 吸着していることが**描いている最中に見える**（琥珀の輪＋次の一手の文）。
//   2. **V2 ②** 描き終えたあと **A の角を動かすと B も追随する**（＝ 同じ頂点を共有した）。
//   3. **FR-29** 他の面の内側に頂点を置こうとすると **理由が文字で出る**（無反応をやめる）。
//   4. **N-51** 1 辺で経度 180 度以上を渡る形は **確定できない**。
//   5. **K-2** 吸着 ▾ を開いていても、パネルの外は地図に届く。
//   6. **K-3** 道具の帯に本物の API 経由で中身が出ても、地図セルの矩形が動かない。

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  enterEditMode,
  launchApp,
  placeVertices,
  returnToViewMode,
  squareCorners,
} from './helpers';

interface HandlePos {
  readonly lon: number;
  readonly lat: number;
}

/** 最後に描かれた frame の primitive 種別ごとの数（観測フック __E2E__）。 */
async function handleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getPrimitiveCounts: () => { handle: number } };
    }).__E2E__;
    return e2e === undefined ? -1 : e2e.getPrimitiveCounts().handle;
  });
}

async function vertexHandlePositions(page: Page): Promise<HandlePos[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => HandlePos[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

async function mapAreaRect(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const box = await page.getByTestId('map-area').boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x, y: box!.y, w: box!.width, h: box!.height };
}

test.describe('増分 3 — 隣り合う国が境界を共有して描ける（C1 / V2）', () => {
  test('V2: A の頂点に吸着することが描いている最中に見え、A の角を動かすと B も追随する', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- A を描く（左側の正方形）。 -------------------------------------
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const half = 90;
      const aCx = cx - half - 10;
      const aCorners = squareCorners(aCx, cy, half);
      await drawFace(page, aCorners, { name: 'A' });

      // A の右辺の 2 隅（B が共有する角）。
      const aTopRight = aCorners[1]!;
      const aBottomRight = aCorners[2]!;

      // --- B を描く。最初の 2 点は A の右辺の隅を**狙って**押す（吸着させる）。---
      await armAddAreaTool(page);
      // カーソルを A の右上隅へ運ぶと、予告（琥珀の輪＋文）が出る。
      await page.mouse.move(aTopRight[0] + 2, aTopRight[1] + 2);
      await expect(page.getByTestId('option-bar-next-step')).toContainText('頂点に合わせます');
      // 琥珀の輪は handle primitive 1 個として描かれる（追加モードでは他にハンドルが無い）。
      await expect.poll(async () => handleCount(page), { timeout: 10_000 }).toBeGreaterThan(0);

      const bCorners: ReadonlyArray<readonly [number, number]> = [
        [aTopRight[0] + 2, aTopRight[1] + 2],
        [aTopRight[0] + 2 * half, aTopRight[1]],
        [aBottomRight[0] + 2 * half, aBottomRight[1]],
        [aBottomRight[0] + 2, aBottomRight[1] - 2],
      ];
      await drawFace(page, bCorners, { name: 'B' });

      // --- A の右上角を動かすと、B の対応する角も同じだけ動く（＝ 共有頂点）。---
      await returnToViewMode(page);
      await enterEditMode(page);
      // A を選ぶ（A の内側を押す）。
      await page.mouse.click(aCx, cy);
      await expect
        .poll(async () => (await vertexHandlePositions(page)).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);

      const before = await vertexHandlePositions(page);
      // 画面の右上 ＝ 経度が大きく緯度も大きい頂点。
      const target = [...before].sort((p, q) => q.lon - p.lon || q.lat - p.lat)[0]!;

      // その角を上へドラッグする。
      await page.mouse.move(aTopRight[0], aTopRight[1]);
      await page.mouse.down();
      await page.mouse.move(aTopRight[0], aTopRight[1] - 60, { steps: 8 });
      await page.mouse.up();

      const after = await vertexHandlePositions(page);
      const movedA = [...after].sort((p, q) => q.lat - p.lat)[0]!;
      expect(movedA.lat).toBeGreaterThan(target.lat);

      // B を選び直して、B 側の同じ角も動いていることを見る。
      await page.mouse.click(bCorners[1]![0] - 20, cy);
      await expect
        .poll(async () => (await vertexHandlePositions(page)).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);
      const bHandles = await vertexHandlePositions(page);
      const bMatched = bHandles.some(
        (h) => Math.abs(h.lon - movedA.lon) < 1e-6 && Math.abs(h.lat - movedA.lat) < 1e-6,
      );
      expect(
        bMatched,
        'B が A と同じ頂点を共有していれば、A を動かしたあとの座標が B のハンドルにも現れる',
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('FR-29: 隣を描いていて他の面の内側へ入ると、理由が文字で出る（無反応をやめた）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await drawFace(page, squareCorners(cx, cy, 100), { name: 'バアカ' });

      // 隣の国を描き始める（外側から）。そのあと誤って「バアカ」の内側へ頂点を入れる。
      // **これが FR-29 が本当に止めたい形**である（入れ子＝全部の頂点が同じ面の内側、は
      // 通す ―― 親の中に子を描く正しい使い方なので）。
      await armAddAreaTool(page);
      await placeVertices(page, [[cx + 180, cy - 150]]);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('1');
      await placeVertices(page, [[cx, cy]]);

      // 頂点は増えず、理由が「次の一手」欄に出る。
      await expect(page.getByTestId('add-vertex-count')).toHaveText('1');
      const next = page.getByTestId('option-bar-next-step');
      await expect(next).toContainText('内側');
      await expect(next).toContainText('バアカ');
    } finally {
      await app.close();
    }
  });

  test('入れ子は通す: 親の面の中に子の面をまるごと描ける（B33 の裏返し）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await drawFace(page, squareCorners(cx, cy, 140), { name: '親' });

      // 全部の頂点が親の内側 ＝ 入れ子を作っているとみなして通す。
      await armAddAreaTool(page);
      await placeVertices(page, squareCorners(cx, cy, 50));
      await expect(page.getByTestId('add-vertex-count')).toHaveText('4');
      await expect(page.getByTestId('add-complete')).toBeEnabled();
    } finally {
      await app.close();
    }
  });

  test('N-51: 1 辺で経度 180 度以上を渡る形は確定できない（保存形式の表現限界）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      // 地図セルの幅いっぱいに広げた三角形。既定ズームでは幅 940px ≒ 360 度なので、
      // 左端から右端までの 1 辺は 180 度を超える。
      const left = b.x + 10;
      const right = b.x + b.width - 10;
      const top = b.y + 40;
      const bottom = b.y + b.height - 40;
      await placeVertices(page, [
        [left, top],
        [right, top],
        [right, bottom],
      ]);
      await expect(page.getByTestId('add-vertex-count')).toHaveText('3');

      // 確定は押せるが、断られて素性欄の「新規の姿」は開かない。
      await page.getByTestId('add-complete').click();
      await expect(page.getByTestId('add-property-form')).toHaveCount(0);
      await expect(page.getByTestId('option-bar-next-step')).toContainText('世界を半周以上');
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 3 — 帯の中身（K-2 / K-3）', () => {
  test('K-2: 吸着 ▾ を開いていても、パネルの外を押すと地図の入力層に届く', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      await page.getByTestId('option-snap-button').click();
      await expect(page.getByTestId('option-snap-panel')).toBeVisible();

      const b = await addInputLayerBox(page);
      const panel = await page.getByTestId('option-snap-panel').boundingBox();
      expect(panel).not.toBeNull();

      // 地図セルを 5×5 の格子で走査し、パネルが覆っていない点では入力層が返ることを見る。
      const covered: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        for (let j = 1; j <= 5; j += 1) {
          const x = b.x + (b.width * i) / 6;
          const y = b.y + (b.height * j) / 6;
          const insidePanel =
            x >= panel!.x &&
            x <= panel!.x + panel!.width &&
            y >= panel!.y &&
            y <= panel!.y + panel!.height;
          if (insidePanel) continue;
          const testId = await page.evaluate(
            ({ px, py }) => {
              const el = document.elementFromPoint(px, py);
              return el === null ? null : el.getAttribute('data-testid');
            },
            { px: x, py: y },
          );
          if (testId !== 'add-input-layer') covered.push(`(${x},${y}) → ${String(testId)}`);
        }
      }
      expect(covered, `パネルの外なのに地図へ届かない点: ${covered.join(' / ')}`).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('K-3: 道具の帯に本物の API 経由で中身が入っても、地図セルの矩形が動かない', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const empty = await mapAreaRect(page);

      // 道具を構える ＝ 道具名・対象・次の一手・設定・確定が**本物の API 経由で**入る
      // （増分 1 の申し送り「対象欄検査を本物 API 経由に」）。
      await armAddAreaTool(page);
      await expect(page.getByTestId('option-bar-tool')).toContainText('面を描く');
      const armed = await mapAreaRect(page);
      expect(armed).toEqual(empty);

      // 頂点を打って対象欄が 0 件 → 3 件に変わっても動かない。
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await placeVertices(page, squareCorners(cx, cy, 60).slice(0, 3));
      await expect(page.getByTestId('option-bar-target')).toContainText('頂点 3 個');
      expect(await mapAreaRect(page)).toEqual(empty);

      // 長い拒否理由が「次の一手」欄に入っても動かない（教訓 5.50 の型）。
      await page.getByTestId('add-cancel').click();
      await armAddAreaTool(page);
      await placeVertices(page, [[cx, cy]]);
      expect(await mapAreaRect(page)).toEqual(empty);
    } finally {
      await app.close();
    }
  });
});
