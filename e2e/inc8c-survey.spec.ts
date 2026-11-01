// 増分 8C「測量」（設計書 §E.1 V15 / 実装計画 8C の完了の定義）。
//
// 実物（Electron ＋ 本物のレンダラ）を本物のポインタで動かし、DOM の観測と、描いた
// プリミティブの数（`window.__E2E__` のフレームの観測。空のプロジェクトでは `line` は
// 測量の線だけ）の両方を見る。固定すること:
//   - V15: `U`（測る）→ 2 点 → 読む（距離・凡例・度分秒）→ 右クリック「この線を消す」で消える。
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

import {
  armVertexTool,
  besideSquareX,
  commitOneFace,
  commitSquareFace,
  launchApp,
  listedFeatureCount,
  openSurveyCoords,
} from './helpers';
import { greatCirclePath } from '../src/domain/survey/great-circle-path';

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
  test('V15: U → 2 点 → 読む（凡例・度分秒）→ 右クリック「この線を消す」で 2 本セットが消える／地図の高さは動かない', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const heightBefore = await mapHeight(page);

      // V15 の 1 手目は打鍵 `U`（設計書 §I.2）。読むだけのままで効く（測るは編集ではない）。
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('survey-input-layer')).toBeVisible();
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
      // もう一度 `U` で測るのを終える（レールの「📏 測る」と同じ切り替え）。
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('survey-input-layer')).toHaveCount(0);
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

// --- 増分 8C の手直し（反証 #1・#2・#4、設計適合 2-3、GPT #2・#4）-------------------------

async function activeFeature(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}

/** 面を 2 つ左右に並べて確定する。2 つ目（B）を確定した直後なので B が選ばれている。 */
async function twoFaces(page: Page) {
  const layer = page.getByTestId('map-input-layer');
  const box = (await layer.boundingBox())!;
  const cy = box.y + box.height / 2;
  const half = 60;
  const aX = box.x + box.width / 2 - 110;
  const bX = besideSquareX(aX, half);
  const aId = await commitSquareFace(page, aX, cy, half, { name: '面A' });
  const bId = await commitSquareFace(page, bX, cy, half, { name: '面B' });
  expect(aId).not.toBe(bId);
  expect(await activeFeature(page)).toBe(bId);
  return { cy, aX, bX, half, aId, bId };
}

/** 画面の x・y と経度・緯度の対応（正距円筒なので一次式）。 */
async function screenMapping(page: Page) {
  const box = (await page.getByTestId('map-input-layer').boundingBox())!;
  const xLeft = box.x + 2;
  const xRight = box.x + box.width - 2;
  const yTop = box.y + 2;
  const yBottom = box.y + box.height - 2;
  const tl = await screenToWorld(page, xLeft, yTop);
  const br = await screenToWorld(page, xRight, yBottom);
  return {
    box,
    xForLon: (lon: number): number => xLeft + ((lon - tl.lon) / (br.lon - tl.lon)) * (xRight - xLeft),
    yForLat: (lat: number): number => yTop + ((lat - tl.lat) / (br.lat - tl.lat)) * (yBottom - yTop),
    pxPerDeg: (xRight - xLeft) / (br.lon - tl.lon),
  };
}

test.describe('増分 8C の手直し — 線の上の右クリックの相手（反証 #1）', () => {
  test('線から数 px の別の地物を右クリックしても、メニューに地物の項目は出ず、選択中の地物は消えない', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const f = await twoFaces(page);
      await enableSurvey(page);
      // A の中を横切る線を 1 本測る。
      const y = f.cy + 20;
      await page.mouse.click(f.aX - 50, y);
      await page.mouse.click(f.aX + 50, y);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // 線から 3px の A の上を右クリック（線の 8px の帯の中）。
      await page.mouse.click(f.aX, y + 3, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      await expect(surveyItems(page)).toHaveCount(1);
      // 地物を相手にする項目（終わり・削除・分割・所属変更…）は 1 つも出ない。見る側の項目は出る。
      await expect(menu.locator('[data-item-kind]')).toHaveCount(0);
      await expect(menu.locator('[data-command]').first()).toBeVisible();
      // 選択は B のまま（A は引き上げられない）。
      expect(await activeFeature(page)).toBe(f.bId);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      expect(await listedFeatureCount(page)).toBe(2);
      expect(await activeFeature(page)).toBe(f.bId);

      // 対照: 線から離れた A の上を右クリックすると、従来どおり A が選ばれて地物の項目が出る。
      await page.mouse.click(f.aX, f.cy - 40, { button: 'right' });
      await expect(menu).toBeVisible();
      await expect.poll(async () => activeFeature(page)).toBe(f.aId);
      await expect(menu.locator('[data-item-kind]').first()).toBeVisible();
      await expect(surveyItems(page)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('頂点の把手は線より優先する（線が通る頂点を右クリックすると「頂点を削除」が出る）', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const { faceId, corners } = await commitOneFace(page);
      const [vx, vy] = corners[0]!;
      // 頂点を通る線を 1 本測ってから、測るのを終える（線は残る）。
      await enableSurvey(page);
      await page.mouse.click(vx - 80, vy);
      await page.mouse.click(vx + 80, vy);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-input-layer')).toHaveCount(0);
      await armVertexTool(page); // 把手が描かれるのは「頂点」の道具（B114）。

      await page.mouse.click(vx, vy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      await expect(surveyItems(page)).toHaveCount(0);
      await expect(menu.locator('[data-item-kind="deleteVertex"]')).toBeVisible();
      await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
      await expect(page.getByTestId('app-active-vertex-owner')).toHaveText(faceId);
      await page.keyboard.press('Escape');
      // 線は消えていない（押した相手は頂点）。
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // 「選択」では同じ場所に頂点の当たりが無いので、線が相手になる（B114）。
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(vx, vy, { button: 'right' });
      await expect(menu).toBeVisible();
      await expect(surveyItems(page).first()).toBeVisible();
      await expect(menu.locator('[data-item-kind="deleteVertex"]')).toHaveCount(0);
      await expect(page.getByTestId('app-active-vertex')).toHaveText('');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 8C の手直し — 消した線を戻す（反証 #2）', () => {
  test('線を消した直後の Ctrl+Z はその線を戻し、地物の編集は取り消さない。状態行の［戻す］でも戻せる', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const f = await twoFaces(page);
      await enableSurvey(page);
      const y = f.cy + 20;
      await page.mouse.click(f.aX - 50, y);
      await page.mouse.click(f.aX + 50, y);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // 消す → 状態行に「測量の線を消しました［戻す］」。
      await page.mouse.click(f.aX, y, { button: 'right' });
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await expect(page.getByTestId('statusbar-result')).toContainText('測量の線を消しました');
      await expect(page.getByTestId('statusbar-result-action')).toHaveText('戻す');

      // 反射の Ctrl+Z → 線が戻る。地物は 2 件のまま。
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      expect(await listedFeatureCount(page)).toBe(2);
      await expect(page.getByTestId('statusbar-result')).toContainText('測量の線を戻しました');
      await expect(page.getByTestId('statusbar-result-action')).toHaveCount(0);
      await expect.poll(async () => (await frameCounts(page)).line).toBe(2);

      // もう一度消して、今度は［戻す］ボタンで戻す。
      await page.mouse.click(f.aX, y, { button: 'right' });
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await page.getByTestId('statusbar-result-action').click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      expect(await listedFeatureCount(page)).toBe(2);
    } finally {
      await app.close();
    }
  });

  // 増分 8C の再手直し（再検証 #1）: 始点を置いた途中で線を消すと、下書き中で Ctrl+Z は届かない。
  // 案内どおり Esc で下書きをやめたあとの Ctrl+Z は、関係のない地物の取り消しではなく線を戻す。
  test('始点を置いた途中で線を消す → Ctrl+Z は届かない → Esc → Ctrl+Z で線が戻り、地物は減らない', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const f = await twoFaces(page);
      await enableSurvey(page);
      const y = f.cy + 20;
      await page.mouse.click(f.aX - 50, y);
      await page.mouse.click(f.aX + 50, y);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      // 次の測量の始点だけを置く（下書きあり）。
      await page.mouse.click(f.bX, f.cy - 40);
      await expect(page.getByTestId('option-bar-next-step')).toContainText('終点を指定');

      await page.mouse.click(f.aX, y, { button: 'right' });
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await expect(page.getByTestId('statusbar-result-action')).toHaveCount(1);

      // 下書き中は大域の打鍵が止まっている ―― 何も起きない（地物の取り消しにも流れない）。
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      expect(await listedFeatureCount(page)).toBe(2);

      // 案内どおり Esc で下書きをやめる。覚えは残る（［戻す］も残る）。
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('option-bar-next-step')).toContainText('地図で 2 点を押すと');
      await expect(page.getByTestId('statusbar-result-action')).toHaveCount(1);

      // もう一度 Ctrl+Z → 線が戻る。地物は 2 件のまま。
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      expect(await listedFeatureCount(page)).toBe(2);
    } finally {
      await app.close();
    }
  });

  // 増分 8C の再手直し（再検証 #2・#3）: U で測るを終えても覚えは捨てない。［戻す］を押したあとは
  // 焦点が状態行に残らず、U がそのまま効く。
  test('線を消して U で測るを終えても Ctrl+Z で線が戻る／［戻す］のあとも U が効く', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const f = await twoFaces(page);
      await enableSurvey(page);
      const y = f.cy + 20;
      await page.mouse.click(f.aX - 50, y);
      await page.mouse.click(f.aX + 50, y);
      await page.mouse.click(f.aX, y, { button: 'right' });
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');

      const toggle = page.getByTestId('survey-toggle');
      await page.keyboard.press('u');
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('statusbar-result-action')).toHaveCount(1);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      expect(await listedFeatureCount(page)).toBe(2);

      // 測るを終えたあとでも線は右クリックで消せる。消して［戻す］を押し、そのまま U で測るを持つ。
      await page.mouse.click(f.aX, y, { button: 'right' });
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await page.getByTestId('statusbar-result-action').click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      await page.keyboard.press('u');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await app.close();
    }
  });

  test('消したあとに測量の操作をすると覚えは捨てられ、Ctrl+Z は従来どおり地物の取り消しへ戻る', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const f = await twoFaces(page);
      await enableSurvey(page);
      const y = f.cy + 20;
      await page.mouse.click(f.aX - 50, y);
      await page.mouse.click(f.aX + 50, y);
      await page.mouse.click(f.aX, y, { button: 'right' });
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await expect(page.getByTestId('statusbar-result-action')).toHaveCount(1);

      // 次の測量（点を置く）で覚えを捨てる ―― ［戻す］も消える（文は残る）。
      await page.mouse.click(f.bX - 50, y);
      await page.mouse.click(f.bX + 50, y);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      await expect(page.getByTestId('statusbar-result-action')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('測量の線を消しました');

      // Ctrl+Z は地物の取り消し（直前の面の追加）。消した線は戻らない。
      await page.keyboard.press('Control+z');
      await expect.poll(async () => listedFeatureCount(page)).toBe(1);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 8C の手直し — 細部（反証 #4、GPT #2・#4、設計適合 2-3）', () => {
  test('大円の線がまっすぐな線から離れた場所（北緯 60° で 150°→−150° の曲線の左端の複製）を右クリックしても消せる', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);
      const m = await screenMapping(page);
      await page.mouse.click(m.xForLon(150), m.yForLat(60));
      await page.mouse.click(m.xForLon(-150), m.yForLat(60));
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // 線は 150°〜210° に描かれ、地図の左端にはその複製（−210°〜−150°）が見えている。
      // 曲線の上で、まっすぐな線（北緯 60°）から 8px より離れた点を左端の複製で選ぶ。
      const path = greatCirclePath({ lon: 150, lat: 60 }, { lon: 210, lat: 60 });
      const onLeftReplica = path
        .map((p) => ({ lon: p.lon - 360, lat: p.lat }))
        .filter((p) => p.lon > -178 && p.lon < -165)
        .sort((a, b) => b.lat - a.lat)[0];
      expect(onLeftReplica).toBeDefined();
      const target = onLeftReplica!;
      const gapPx = (target.lat - 60) * m.pxPerDeg;
      expect(gapPx).toBeGreaterThan(8);
      const x = m.xForLon(target.lon);
      const yy = m.yForLat(target.lat);
      expect(x).toBeGreaterThan(m.box.x);
      await page.mouse.click(x, yy, { button: 'right' });
      await expect(surveyItems(page)).toHaveCount(1);
      await surveyItems(page).first().click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await expect.poll(async () => (await frameCounts(page)).line).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('「この線を消す」を二重クリックしても、2 回目は地図に落ちず測量の始点は置かれない', async () => {
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
      await page.mouse.click(cx, cy, { button: 'right' });
      const ib = (await surveyItems(page).first().boundingBox())!;
      await page.mouse.dblclick(ib.x + ib.width / 2, ib.y + ib.height / 2);
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      // 始点は置かれていない（次の一手は 2 点を押す前の文のまま）。`U` も効く。
      await expect(page.getByTestId('option-bar-next-step')).toContainText('地図で 2 点を押すと');
      await page.keyboard.press('u');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'false');
    } finally {
      await app.close();
    }
  });

  test('U は地図に焦点があるときだけ効く（時刻レールのボタンに焦点があると効かない）', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      const toggle = page.getByTestId('survey-toggle');
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      const focused = await page.getByTestId('timeline-playback').evaluate((el) => {
        const b = el.querySelector('button');
        b?.focus();
        return b !== null && document.activeElement === b;
      });
      expect(focused).toBe(true);
      await page.keyboard.press('u');
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      // 焦点を外す（地図を押した直後と同じ）と効く。
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('u');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      // レールの「📏 測る」を押した直後（焦点がレール）でも効く。
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('u');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await app.close();
    }
  });

  test('凡例の見本が実際に描かれている（計算済みの背景・色・線種、凡例の背景を外すと見た目が変わる）', async () => {
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

      const read = (testId: string) =>
        page.getByTestId(testId).evaluate((el) => {
          const cs = getComputedStyle(el);
          const style = (el as HTMLElement).style;
          // 変数で渡した色を、ブラウザが解いた rgb の形に直して比べる。
          const probe = document.createElement('span');
          probe.style.color = style.getPropertyValue('--survey-legend-color');
          document.body.appendChild(probe);
          const rgb = getComputedStyle(probe).color;
          probe.remove();
          return {
            image: cs.backgroundImage,
            size: cs.backgroundSize,
            repeat: cs.backgroundRepeat,
            paddingBottom: cs.paddingBottom,
            rgb,
            width: style.getPropertyValue('--survey-legend-width').trim(),
            period: style.getPropertyValue('--survey-legend-period').trim(),
          };
        });
      const eq = await read('survey-legend-eq');
      const gc = await read('survey-legend-gc');
      for (const s of [eq, gc]) {
        expect(s.image).toContain('linear-gradient');
        expect(s.image).toContain(s.rgb);
        // 見本の線の下の余白（B103 の余白の体系 4 / 6 / 8 / 10 / 12 / 16px に寄せた）。
        expect(s.paddingBottom).toBe('4px');
        expect(s.width).toMatch(/^\d+(\.\d+)?px$/);
      }
      // 正距円筒は横いっぱいの実線、大円は刻みを横に繰り返す破線。
      expect(eq.size).toBe(`100% ${eq.width}`);
      expect(eq.repeat).toBe('no-repeat');
      expect(gc.size).toBe(`${gc.period} ${gc.width}`);
      expect(gc.repeat).toMatch(/^(repeat-x|repeat no-repeat)$/);
      // 刻みのすき間は透明（ブラウザは transparent を rgba(0, 0, 0, 0) と書き直す）。
      expect(gc.image).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);

      // 見本の線が画面に描かれていること: 背景を外すと見た目が変わる。
      for (const id of ['survey-legend-eq', 'survey-legend-gc']) {
        const el = page.getByTestId(id);
        const withLegend = await el.screenshot();
        await el.evaluate((node) => {
          (node as HTMLElement).style.backgroundImage = 'none';
        });
        const withoutLegend = await el.screenshot();
        await el.evaluate((node) => {
          (node as HTMLElement).style.backgroundImage = '';
        });
        expect(withLegend.equals(withoutLegend)).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});
