// 増分 8C「測量」（設計書 §E.1 V15 / 実装計画 8C の完了の定義）。
//
// 実物（Electron ＋ 本物のレンダラ）を本物のポインタで動かし、DOM の観測と、描いた
// プリミティブの数（`window.__E2E__` のフレームの観測。空のプロジェクトでは `line` は
// 測量の線だけ）の両方を見る。固定すること:
//   - V15: 測る → 2 点 → 読む（距離・凡例・度分秒）→ 右クリック「この線を消す」で消える。
//     消えるのは正距円筒の線と大円の線の 2 本セット。
//   - 2 本の線が交差しているところを右クリックすると、項目が 2 つ出て選べる（どれか 1 つに
//     勝手に決めない）。
//   - 世界の東西端をまたぐ線を、地図の左端に見えている複製の上で右クリックしても消せる。
//   - 測量の道具を持っても、測っても、地図の高さが変わらない（増分 5 で済んでいることの回帰）。
//
// 項目は文言ではなく `data-survey-line-id` で掴む（開発ガイド §5.64: 言い換えで検査が
// 置き去りにならないように）。ただし「この線を消す」と「測っている間は地物を選べません」は
// **完了の定義（実装計画 8C）と設計書 §C.4 が名指ししている言葉そのもの**なので、
// 用語の回帰ロックとしてわざと直書きしている（§5.64 の例外）。言い換えるなら設計書と一緒に。

import { test, expect, type Page } from '@playwright/test';

import { launchApp, openSurveyCoords } from './helpers';

interface FrameCounts {
  line: number;
  point: number;
  dashedLine: number;
}

async function frameCounts(page: Page): Promise<FrameCounts> {
  return page.evaluate(() => {
    const e2e = (
      window as unknown as {
        __E2E__?: { getPrimitiveCounts: () => { line: number; point: number; dashedLine?: number } };
      }
    ).__E2E__;
    if (e2e === undefined) return { line: -1, point: -1, dashedLine: -1 };
    const c = e2e.getPrimitiveCounts();
    return { line: c.line, point: c.point, dashedLine: c.dashedLine ?? -1 };
  });
}

async function waitForE2EHook(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => typeof (window as unknown as { __E2E__?: unknown }).__E2E__),
    )
    .toBe('object');
}

async function screenToWorld(page: Page, x: number, y: number): Promise<{ lon: number; lat: number }> {
  const world = await page.evaluate(
    ([cx, cy]) => {
      const e2e = (
        window as unknown as {
          __E2E__?: { screenToWorld: (a: number, b: number) => { lon: number; lat: number } | null };
        }
      ).__E2E__;
      return e2e?.screenToWorld(cx!, cy!) ?? null;
    },
    [x, y],
  );
  expect(world).not.toBeNull();
  return world!;
}

/** 地図の入力層の高さ（地図セルの矩形）。 */
async function mapHeight(page: Page): Promise<number> {
  const box = await page.getByTestId('map-input-layer').boundingBox();
  expect(box).not.toBeNull();
  return box!.height;
}

async function enableSurvey(page: Page): Promise<void> {
  const toggle = page.getByTestId('survey-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('survey-input-layer')).toBeVisible();
}

/** 右クリックで開いたメニューの「この線を消す」の項目。 */
function surveyItems(page: Page) {
  return page.getByTestId('context-menu').locator('[data-survey-line-id]');
}

test.describe('増分 8C — 測量の線を 1 本だけ消す（V15）', () => {
  test('V15: 測る → 2 点 → 読む（凡例・度分秒）→ 右クリック「この線を消す」で 2 本セットが消える／地図の高さは動かない', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const heightBefore = await mapHeight(page);

      await enableSurvey(page);
      // N-54: 次の一手欄に「測っている間は地物を選べません」。
      await expect(page.getByTestId('option-bar-next-step')).toContainText(
        '測っている間は地物を選べません',
      );
      expect(await mapHeight(page)).toBe(heightBefore);

      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.click(cx - 100, cy - 60);
      await page.mouse.click(cx + 100, cy + 60);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // 読む: 2 本の線の凡例（正距円筒＝実線・大円＝破線）。地図でも大円の線だけが破線。
      await expect(page.getByTestId('survey-legend-eq')).toBeVisible();
      await expect(page.getByTestId('survey-legend-gc')).toBeVisible();
      await expect(page.getByTestId('survey-legend-eq')).toHaveAttribute('data-dash', 'solid');
      await expect(page.getByTestId('survey-legend-gc')).toHaveAttribute('data-dash', 'dashed');
      await expect.poll(async () => (await frameCounts(page)).line).toBe(2);
      expect((await frameCounts(page)).dashedLine).toBe(1);
      // 読む: 度分秒でも読める（G-11。「座標 ▾」の中）。
      await openSurveyCoords(page);
      await expect(page.getByTestId('survey-start-dms')).toContainText('″');
      await expect(page.getByTestId('survey-end-dms')).toContainText('″');
      // 開いたままだと鍵盤の持ち主がポップオーバーになるので、閉じてから右クリックする。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('survey-coords-button')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect(page.getByTestId('survey-coords-panel')).toBeHidden();
      // 測って読み取りと凡例が出ても、地図の高さは 1px も動かない（§B.4 / K-3）。
      expect(await mapHeight(page)).toBe(heightBefore);

      // 要らない線を右クリック → 「この線を消す」。まっすぐな線の中ほど（画面の中央）。
      await page.mouse.click(cx, cy, { button: 'right' });
      await expect(page.getByTestId('context-menu')).toBeVisible();
      await expect(surveyItems(page)).toHaveCount(1);
      await expect(surveyItems(page).first()).toHaveText('この線を消す');
      await surveyItems(page).first().click();

      await expect(page.getByTestId('context-menu')).toHaveCount(0);
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      // 2 本（正距円筒・大円）と端の印がまとめて消える。
      await expect.poll(async () => (await frameCounts(page)).line).toBe(0);
      expect((await frameCounts(page)).point).toBe(0);
      // 測量は続いている（線を消しても道具は持ったまま）。
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      expect(await mapHeight(page)).toBe(heightBefore);
    } finally {
      await app.close();
    }
  });

  test('線が交差しているところを右クリックすると、測量ごとに 1 項目ずつ出て選べる', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);
      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      // 2 本のまっすぐな線はどちらも画面の中央を通る（長さは違う）。
      await page.mouse.click(cx - 100, cy - 60);
      await page.mouse.click(cx + 100, cy + 60);
      await page.mouse.click(cx - 100, cy + 60);
      await page.mouse.click(cx + 140, cy - 84);
      await expect(page.getByTestId('survey-line-count')).toHaveText('2');
      await expect.poll(async () => (await frameCounts(page)).line).toBe(4);

      await page.mouse.click(cx, cy, { button: 'right' });
      await expect(surveyItems(page)).toHaveCount(2);
      const ids = await surveyItems(page).evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-survey-line-id')),
      );
      expect(new Set(ids).size).toBe(2);
      // 2 つの項目は距離で言い分けられている（同じ文にならない）。
      const labels = await surveyItems(page).allTextContents();
      expect(labels[0]).not.toBe(labels[1]);
      for (const label of labels) expect(label).toMatch(/km の線を消す$/);

      // 2 つ目の項目を選ぶ ―― 選んだほうだけが消える。
      const chosen = ids[1]!;
      await page.getByTestId('context-menu').locator(`[data-survey-line-id="${chosen}"]`).click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      await expect.poll(async () => (await frameCounts(page)).line).toBe(2);

      // 残った 1 本は、同じ場所を右クリックすると「この線を消す」1 項目になる。
      await page.mouse.click(cx, cy, { button: 'right' });
      await expect(surveyItems(page)).toHaveCount(1);
      await expect(surveyItems(page).first()).toHaveAttribute('data-survey-line-id', ids[0]!);
      await expect(surveyItems(page).first()).toHaveText('この線を消す');
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
    } finally {
      await app.close();
    }
  });

  test('世界の東西端をまたぐ線を、地図の左端に見えている複製の上で右クリックしても消せる', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);
      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      const cy = box.y + box.height / 2;
      const xLeft = box.x + 2;
      const xRight = box.x + box.width - 2;
      const wl = await screenToWorld(page, xLeft, cy);
      const wr = await screenToWorld(page, xRight, cy);
      const xForLon = (lon: number): number =>
        xLeft + ((lon - wl.lon) / (wr.lon - wl.lon)) * (xRight - xLeft);

      // 東の端（+179°）から西の端（−179°）へ。線は 179°〜181° に描かれ、地図の左端には
      // その複製（−181°〜−179°）が見えている。
      await page.mouse.click(xForLon(179), cy);
      await page.mouse.click(xForLon(-179), cy);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // 左端の複製の上（−179.6°）を右クリックする。押した点の経度は −179.6° のまま渡り、
      // 当たり判定が 360° ずらして線に重ねる。
      const xSeam = xForLon(-179.6);
      expect(xSeam).toBeGreaterThan(box.x);
      const pressed = await screenToWorld(page, xSeam, cy);
      expect(pressed.lon).toBeLessThan(-179);
      await page.mouse.click(xSeam, cy, { button: 'right' });
      await expect(surveyItems(page)).toHaveCount(1);
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await expect.poll(async () => (await frameCounts(page)).line).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('測量を終えたあとも、残っている線を右クリックで消せる（線は描かれている＝FR-15）', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);
      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.click(cx - 100, cy - 60);
      await page.mouse.click(cx + 100, cy + 60);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-input-layer')).toHaveCount(0);
      await expect.poll(async () => (await frameCounts(page)).line).toBe(2);

      await page.mouse.click(cx, cy, { button: 'right' });
      await expect(surveyItems(page)).toHaveCount(1);
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await expect.poll(async () => (await frameCounts(page)).line).toBe(0);
    } finally {
      await app.close();
    }
  });
});
