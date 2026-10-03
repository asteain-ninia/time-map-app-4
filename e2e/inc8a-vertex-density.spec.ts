// 増分 8A — 実データ密度で頂点を狙える（設計書 §E.1 V9 / 実装計画 §8 の 8A）。
//
// 完了の定義（実装計画 8A）をこの spec で見る:
//   1. バアカ（601 頂点）と領域01（2,230 頂点）の両方で、狙った頂点を掴める（実データの複写を
//      投入口で読む。実データが無い環境では skip）。
//   2. 全体表示のまま領域01 を選ぶと、印は出ないが理由と［拡大］が出る。［拡大］で出る。
//   3. 候補一覧は K-2 の機械検査を通る（`inc5-shell.spec.ts` の台帳 #12 の走査）。
//   4. 矩形選択の枠が描かれる／辺の中点のクリックで頂点が増える（取り消しで戻る）。
//
// 合成データの検査（いつでも走る）で 2〜4 の仕組みを固定し、実データの検査で 1・2 を見る。
//
// ⚠️ 実データの正準ファイルはアプリで開かない（教訓 5.48）。一時ディレクトリへ複写して開き、
// 最後に正準ファイルのサイズと更新時刻が動いていないことを確かめる。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import {
  DEFAULT_FACE_HALF,
  changedVertexIds,
  commitOneFace,
  committedVertices,
  enterEditMode,
  launchApp,
  launchAppWithProject,
  liveCamera,
  openVertexCandidatesOnTinySquare,
  selectedVertexIds,
  vertexHandlePositions,
  worldToClient,
  type WorldPos,
} from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

// ---------------------------------------------------------------------------
// 観測の小道具
// ---------------------------------------------------------------------------

async function primitiveCounts(page: Page): Promise<{ handle: number; line: number; dashedLine: number }> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getPrimitiveCounts: () => { handle: number; line: number; dashedLine: number } };
    }).__E2E__;
    return e2e === undefined ? { handle: 0, line: 0, dashedLine: 0 } : e2e.getPrimitiveCounts();
  });
}

const key = (p: WorldPos): string => `${p.lon.toFixed(9)},${p.lat.toFixed(9)}`;

async function activeFeatureId(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}

/**
 * **狙った頂点を掴めるか**を見る（V9 の本体）。照合は **頂点の id** で行う（手直し・GPT #3。
 * 小数 2 桁の座標文字列では、丸めると同じになる隣の頂点を見分けられない）。
 *
 * 1. `target` の位置をクリックする。候補一覧が出たら、**いま選んでいる地物の行のうち
 *    いちばん近いもの以外**（＝ 素の当たり判定なら掴まれない頂点）を選ぶ。出なければ
 *    クリックで選ばれた頂点が狙いで、それが `target` の座標の頂点であることを確かめる。
 * 2. 同じ位置を押して `direction` へ少し（6px）動かす。ドラッグ中に動いた印がちょうど 1 つで
 *    あることを見てから離し、**確定したデータで、位置が変わった（または吸着で共有へ
 *    付け替えられた）頂点がちょうど狙いの id 1 つだけ**であることを確かめる。
 *
 * 一時ファイルの上の確定なので、正準ファイルには触れない。
 */
async function grabTargetedVertex(
  page: Page,
  target: WorldPos,
  direction: 'inward' | 'outward',
): Promise<{ usedList: boolean }> {
  const at = await worldToClient(page, target);
  await page.mouse.click(at.x, at.y);
  const list = page.getByTestId('vertex-candidates');
  const featureId = await activeFeatureId(page);
  let expectedId: string;
  let usedList = false;
  if ((await list.count()) > 0) {
    usedList = true;
    const rows = list.locator(`button[data-feature-id="${featureId}"]`);
    const n = await rows.count();
    expect(n, '一覧に、いま選んでいる地物の頂点が 1 つも無い').toBeGreaterThan(0);
    const row = rows.nth(n >= 2 ? 1 : 0);
    const label = (await row.locator('.vertex-candidates__name').textContent()) ?? '';
    expect(label).toMatch(/^頂点 #.+（\d+\.\d\d°[NS] \d+\.\d\d°[EW]/);
    const testId = (await row.getAttribute('data-testid')) ?? '';
    expectedId = testId.replace(/^vertex-candidate-/, '');
    await row.click();
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId('app-active-vertex')).toHaveText(expectedId);
  } else {
    await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
    expectedId = ((await page.getByTestId('app-active-vertex').textContent()) ?? '').trim();
    // 一覧が出ないなら、クリックで選ばれた頂点が `target` そのものでなければならない。
    const p = (await committedVertices(page, featureId)).get(expectedId);
    expect(p, 'クリックで選ばれた頂点が、選んでいる地物に無い').toBeDefined();
    expect(key(p!)).toBe(key(target));
  }

  const committedBefore = await committedVertices(page, featureId);
  expect(committedBefore.has(expectedId)).toBe(true);
  const before = await vertexHandlePositions(page);
  expect(before.length).toBeGreaterThan(0);
  const c = {
    lon: before.reduce((s, h) => s + h.lon, 0) / before.length,
    lat: before.reduce((s, h) => s + h.lat, 0) / before.length,
  };
  const centre = await worldToClient(page, c);
  const vx = centre.x - at.x;
  const vy = centre.y - at.y;
  const len = Math.hypot(vx, vy);
  // 押す所が印の重心そのもの（小さな四角の真ん中）なら向きが決まらないので、右下へ動かす
  // （動かさずに離すと確定しない）。
  const [ux, uy] = len < 1 ? [Math.SQRT1_2, Math.SQRT1_2] : [vx / len, vy / len];
  const sign = direction === 'inward' ? 1 : -1;
  const dx = sign * 6 * ux;
  const dy = sign * 6 * uy;

  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx / 2, at.y + dy / 2);
  await page.mouse.move(at.x + dx, at.y + dy);
  await expect
    .poll(async () => {
      const during = new Set((await vertexHandlePositions(page)).map(key));
      return before.filter((p) => !during.has(key(p))).length;
    })
    .toBe(1);
  await page.mouse.up();
  // 確定したデータを id で照合する: 変わったのは狙いの頂点ただ 1 つ。
  await expect
    .poll(async () => changedVertexIds(committedBefore, await committedVertices(page, featureId)))
    .toEqual([expectedId]);
  return { usedList };
}

/** 頂点の印のうち、地図の真ん中寄りにあるもの（端の帯・ズームの部品に当たらない所）。 */
async function handleNearMapCentre(page: Page): Promise<WorldPos> {
  const handles = await vertexHandlePositions(page);
  const box = (await page.getByTestId('map-input-layer').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let best: WorldPos | null = null;
  let bestD = Infinity;
  for (const h of handles) {
    const s = await worldToClient(page, h);
    if (s.x < box.x + 60 || s.x > box.x + box.width - 200 || s.y < box.y + 60 || s.y > box.y + box.height - 160) {
      continue;
    }
    const d = Math.hypot(s.x - cx, s.y - cy);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  expect(best, '地図の真ん中寄りに頂点の印が無い').not.toBeNull();
  return best!;
}

async function setVertexMarkerCap(page: Page, cap: number): Promise<void> {
  await page.getByTestId('menu-tools').click();
  await page.getByTestId('menu-items-tools').locator('[data-command="tools.settings"]').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-tab-app').click();
  await page.getByLabel('全頂点マーカー表示上限').fill(String(cap));
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// 合成データ（いつでも走る）
// ---------------------------------------------------------------------------

test.describe('増分 8A — 頂点の候補一覧・理由と［拡大］・矩形の枠・辺の中点', () => {
  test('候補一覧の行は「頂点 #…（座標）」で、選んだ頂点が次のドラッグで掴まれる', async () => {
    const { app, page } = await launchApp();
    try {
      await openVertexCandidatesOnTinySquare(page);
      const rows = page.getByTestId('vertex-candidates').locator('button[data-feature-id]');
      // 一辺 0.05° の四角はズームの上限でも数 px なので、4 隅が全部候補に入る。
      await expect(rows).toHaveCount(4);
      await expect(rows.first().locator('.vertex-candidates__name')).toHaveText(
        /^頂点 #syn-0000-v\d（\d+\.\d\d°[NS] \d+\.\d\d°[EW]）$/,
      );
      // 一覧を閉じてから、同じ所で「狙って掴む」を通す。
      await page.keyboard.press('Escape');
      const handles = await vertexHandlePositions(page);
      const centre = {
        lon: handles.reduce((s, h) => s + h.lon, 0) / handles.length,
        lat: handles.reduce((s, h) => s + h.lat, 0) / handles.length,
      };
      const { usedList } = await grabTargetedVertex(page, centre, 'outward');
      expect(usedList).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('ドラッグでは候補一覧が出ない（クリックのときだけ）', async () => {
    const { app, page } = await launchApp();
    try {
      const at = await openVertexCandidatesOnTinySquare(page);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 20, at.y + 20);
      await page.mouse.up();
      await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('印が上限で出ないときは理由と［拡大］が出て、［拡大］で印が出る', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await enterEditMode(page);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      // 上限を 3 にすると、4 隅が全部見えている全体表示では印が出ない。
      await setVertexMarkerCap(page, 3);
      try {
        const next = page.getByTestId('option-bar-next-step');
        await expect(next).toContainText('頂点が 4 あり、上限 3 のため印を出していません。拡大すると出ます');
        await expect.poll(async () => (await primitiveCounts(page)).handle).toBe(0);
        const zoom = page.getByTestId('option-bar-next-action-handle-cap-zoom');
        await expect(zoom).toHaveText('拡大');
        await zoom.click();
        // 印が出て（0 個ではない）、理由は消える。
        await expect.poll(async () => (await vertexHandlePositions(page)).length).toBeGreaterThan(0);
        await expect(next).not.toContainText('上限 3');
        // 読むだけ（鍵を閉じた）ときは印をもともと描かないので、理由も出さない。
        await page.getByTestId('map-fit-all').click();
        await expect(next).toContainText('上限 3');
        await page.getByTestId('mode-view').click();
        await expect(next).not.toContainText('上限 3');
      } finally {
        await setVertexMarkerCap(page, 2000);
      }
    } finally {
      await app.close();
    }
  });

  test('空いた所からドラッグすると矩形選択の枠が描かれ、離すと消えて中の頂点が選ばれる', async () => {
    const { app, page } = await launchApp();
    try {
      const { corners } = await commitOneFace(page);
      await enterEditMode(page);
      const [lx, ty] = corners[0]!; // 左上の隅
      const base = (await primitiveCounts(page)).dashedLine;
      // 隅の外側（左上へ 30px）から、隅を囲むように右下へ引く。
      await page.mouse.move(lx - 30, ty - 30);
      await page.mouse.down();
      await page.mouse.move(lx - 10, ty - 10);
      await page.mouse.move(lx + 20, ty + 20);
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine).toBe(base + 1);
      await page.mouse.up();
      await expect.poll(async () => (await primitiveCounts(page)).dashedLine).toBe(base);
      await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
    } finally {
      await app.close();
    }
  });

  test('辺の中点の印をクリックすると頂点が 1 つ増え、Ctrl+Z 1 回で戻る', async () => {
    const { app, page } = await launchApp();
    try {
      const { corners } = await commitOneFace(page);
      await enterEditMode(page);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      const [x0, y0] = corners[0]!;
      const [x1] = corners[1]!;
      expect(x1 - x0).toBe(DEFAULT_FACE_HALF * 2);
      const featureId = await activeFeatureId(page);
      const before = await committedVertices(page, featureId);
      expect(before.size).toBe(4);
      // 上の辺の中点（動かさずに押して離す）。
      await page.mouse.click((x0 + x1) / 2, y0);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(5);
      // データ全体で見る（GPT #5）: 元の 4 頂点は 1 つも動かず、新しい頂点が 1 つだけ増え、
      // それは上の辺の両端のちょうど中点にある。
      const after = await committedVertices(page, featureId);
      expect(after.size).toBe(5);
      expect(changedVertexIds(before, after)).toEqual([]);
      const added = [...after.keys()].filter((id) => !before.has(id));
      expect(added).toHaveLength(1);
      const top: WorldPos[] = [];
      for (const p of before.values()) {
        if (Math.abs((await worldToClient(page, p)).y - y0) < 1) top.push(p);
      }
      expect(top).toHaveLength(2);
      const mid = after.get(added[0]!)!;
      expect(mid.lon).toBeCloseTo((top[0]!.lon + top[1]!.lon) / 2, 9);
      expect(mid.lat).toBeCloseTo((top[0]!.lat + top[1]!.lat) / 2, 9);
      // 取り消し 1 回で、id も座標も足す前とまるごと同じに戻る。
      await page.keyboard.press('Control+z');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      expect([...(await committedVertices(page, featureId)).entries()]).toEqual([
        ...before.entries(),
      ]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 手直し（検証の記録 3 本の指摘）— 合成データ
// ---------------------------------------------------------------------------

/**
 * 小さな四角で一覧を出し、`pickIndex` 行目の頂点 X を選ぶ。X と、X 以外の隅（Y の候補）を
 * id と窓の座標で返す。四角の隅どうしは 2.5px ほどしか離れていないので、どれも互いに
 * 掴める距離に居る。
 */
async function pickFromTinySquare(page: Page, pickIndex = 0) {
  await openVertexCandidatesOnTinySquare(page);
  const featureId = await activeFeatureId(page);
  const row = page.getByTestId('vertex-candidates').locator('button[data-feature-id]').nth(pickIndex);
  const x = ((await row.getAttribute('data-testid')) ?? '').replace(/^vertex-candidate-/, '');
  await row.click();
  await expect(page.getByTestId('vertex-candidates')).toHaveCount(0);
  await expect(page.getByTestId('app-active-vertex')).toHaveText(x);
  const committed = await committedVertices(page, featureId);
  const at = async (id: string) => worldToClient(page, committed.get(id)!);
  const others = [...committed.keys()].filter((id) => id !== x);
  return { featureId, x, others, committed, at };
}

test.describe('増分 8A の手直し — 一覧から選んだ頂点の優先は直後の左ドラッグ 1 回だけ（反証 重 3）', () => {
  test('X を一覧で選んだまま、隣の Y の真上を右クリックして「頂点を削除」すると、消えるのは Y', async () => {
    const { app, page } = await launchApp();
    try {
      const { featureId, x, others, at } = await pickFromTinySquare(page);
      const y = others[0]!;
      const yAt = await at(y);
      await page.mouse.click(yAt.x, yAt.y, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      // メニューの対象（右クリックで選択へ上がった頂点）は Y。
      await expect(page.getByTestId('app-active-vertex')).toHaveText(y);
      await menu.locator('[data-item-kind="deleteVertex"]').click();
      await page.getByTestId('vertex-delete-impact-confirm').click();
      await expect
        .poll(async () => [...(await committedVertices(page, featureId)).keys()].sort())
        .toEqual([x, ...others.slice(1)].sort());
    } finally {
      await app.close();
    }
  });

  test('X を一覧で選んだまま Y を Shift+クリックすると、選択は {X, Y}（X が外れない）', async () => {
    const { app, page } = await launchApp();
    try {
      const { x, others, at } = await pickFromTinySquare(page);
      const y = others[0]!;
      const yAt = await at(y);
      await page.keyboard.down('Shift');
      await page.mouse.click(yAt.x, yAt.y);
      await page.keyboard.up('Shift');
      await expect.poll(async () => selectedVertexIds(page)).toEqual([x, y].sort());
    } finally {
      await app.close();
    }
  });

  test('印は次の押下で必ず消える: 1 回目の押下（Escape で取り消し）のあと、Y を押してドラッグすると Y が動く', async () => {
    const { app, page } = await launchApp();
    try {
      const { featureId, x, others, at } = await pickFromTinySquare(page);
      const y = others[0]!;
      const yAt = await at(y);
      const before = await committedVertices(page, featureId);
      // 1 回目: Y の真上を押してドラッグ ―― 一覧から選んだ直後なので X が掴まれる。Escape で取り消す。
      await page.mouse.move(yAt.x, yAt.y);
      await page.mouse.down();
      await page.mouse.move(yAt.x, yAt.y + 10);
      await page.mouse.move(yAt.x, yAt.y + 20);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      expect(changedVertexIds(before, await committedVertices(page, featureId))).toEqual([]);
      await expect(page.getByTestId('app-active-vertex')).toHaveText(x);
      // 2 回目: 同じく Y の真上を押してドラッグ ―― 印はもう無いので、最寄りの Y が動く
      // （X はまだ選ばれていて、Y から掴める距離に居る）。
      await page.mouse.move(yAt.x, yAt.y);
      await page.mouse.down();
      await page.mouse.move(yAt.x, yAt.y + 10);
      await page.mouse.move(yAt.x, yAt.y + 20);
      await page.mouse.up();
      await expect
        .poll(async () => changedVertexIds(before, await committedVertices(page, featureId)))
        .toEqual([y]);
    } finally {
      await app.close();
    }
  });

  test('矩形で選んだ集合の外の隣を押してドラッグすると、動くのは押した 1 点だけ', async () => {
    const { app, page } = await launchApp();
    try {
      await openVertexCandidatesOnTinySquare(page);
      await page.keyboard.press('Escape');
      const featureId = await activeFeatureId(page);
      const before = await committedVertices(page, featureId);
      const screen = await Promise.all(
        [...before.entries()].map(async ([id, p]) => ({ id, s: await worldToClient(page, p) })),
      );
      const xs = screen.map((e) => e.s.x);
      const ys = screen.map((e) => e.s.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const midX = (minX + maxX) / 2;
      // 左の 2 隅だけを囲む（右の縁は左右の隅のちょうど間）。
      await page.mouse.move(minX - 40, Math.min(...ys) - 40);
      await page.mouse.down();
      await page.mouse.move(minX - 20, Math.min(...ys) - 20);
      await page.mouse.move(midX, Math.max(...ys) + 40);
      await page.mouse.up();
      const left = screen.filter((e) => e.s.x < midX).map((e) => e.id).sort();
      expect(left).toHaveLength(2);
      await expect.poll(async () => selectedVertexIds(page)).toEqual(left);
      // 右の隅（選んでいない。左の隅から掴める距離に居る）を押してドラッグ。
      const right = screen.find((e) => e.s.x > midX)!;
      await page.mouse.move(right.s.x, right.s.y);
      await page.mouse.down();
      await page.mouse.move(right.s.x + 10, right.s.y);
      await page.mouse.move(right.s.x + 20, right.s.y);
      await page.mouse.up();
      await expect
        .poll(async () => changedVertexIds(before, await committedVertices(page, featureId)))
        .toEqual([right.id]);
    } finally {
      await app.close();
    }
  });
});

test.describe('増分 8A の手直し — Escape・上限のズーム・一覧の止め方・行と地図の結びつき', () => {
  test('頂点のドラッグ中に Escape を押すと元の位置へ戻り、離しても何も確定しない（V9）', async () => {
    const { app, page } = await launchApp();
    try {
      const { corners } = await commitOneFace(page);
      await enterEditMode(page);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
      const [vx, vy] = corners[0]!;
      await page.mouse.click(vx, vy); // 頂点を選ぶ
      await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
      const selected = ((await page.getByTestId('app-active-vertex').textContent()) ?? '').trim();
      const featureId = await activeFeatureId(page);
      const before = await committedVertices(page, featureId);
      const handlesBefore = (await vertexHandlePositions(page)).map(key).sort();
      const undoBefore = await page.getByTestId('app-can-undo').textContent();
      await page.mouse.move(vx, vy);
      await page.mouse.down();
      await page.mouse.move(vx + 20, vy + 20);
      await page.mouse.move(vx + 40, vy + 40);
      // ドラッグ中は印が動いている。
      await expect
        .poll(async () => (await vertexHandlePositions(page)).map(key).sort())
        .not.toEqual(handlesBefore);
      await page.keyboard.press('Escape');
      // Escape で元の位置へ戻る（離す前から）。
      await expect
        .poll(async () => (await vertexHandlePositions(page)).map(key).sort())
        .toEqual(handlesBefore);
      await page.mouse.move(vx + 60, vy + 60);
      await page.mouse.up();
      // 離しても確定しない: データも、取り消しの有無も変わらない。選択も残る（Escape は
      // ドラッグの取り消しに使われ、選択を外す段へは渡らない）。
      expect(changedVertexIds(before, await committedVertices(page, featureId))).toEqual([]);
      await expect(page.getByTestId('app-can-undo')).toHaveText(undoBefore ?? '');
      await expect(page.getByTestId('app-active-vertex')).toHaveText(selected);
      expect((await vertexHandlePositions(page)).map(key).sort()).toEqual(handlesBefore);
    } finally {
      await app.close();
    }
  });

  test('ズームの上限まで寄っても印が上限で出ないときは、［拡大］を出さず「拡大すると出ます」も言わない', async () => {
    const { app, page } = await launchApp();
    try {
      await openVertexCandidatesOnTinySquare(page);
      await page.keyboard.press('Escape');
      // 一辺 0.05° の四角はズームの上限でも数 px なので、4 隅が全部視野に入ったまま。
      await setVertexMarkerCap(page, 3);
      try {
        // ズームの上限まで寄る（倍率が止まるまで Ctrl+=）。
        let prev = -1;
        for (let i = 0; i < 40; i += 1) {
          const z = (await liveCamera(page)).zoom;
          if (z === prev) break;
          prev = z;
          await page.keyboard.press('Control+=');
          await page.waitForTimeout(50);
        }
        const next = page.getByTestId('option-bar-next-step');
        await expect(next).toContainText('頂点が 4 あり、上限 3 のため印を出していません。これ以上は拡大できません。');
        await expect(next).not.toContainText('拡大すると出ます');
        await expect(page.getByTestId('option-bar-next-action-handle-cap-zoom')).toHaveCount(0);
        // 縮小すると、まだ寄れるので［拡大］が出る（この四角だけの「全体表示」は上限まで寄るので使わない）。
        await page.keyboard.press('Control+-');
        await expect(next).toContainText('拡大すると出ます');
        await expect(page.getByTestId('option-bar-next-action-handle-cap-zoom')).toBeVisible();
      } finally {
        await setVertexMarkerCap(page, 2000);
      }
    } finally {
      await app.close();
    }
  });

  test('一覧が出ている間の Delete・Ctrl+Z は止まり、止めた理由が状態行に出る（設計書 §D.4 のまま）', async () => {
    const { app, page } = await launchApp();
    try {
      await openVertexCandidatesOnTinySquare(page);
      const featureId = await activeFeatureId(page);
      const before = await committedVertices(page, featureId);
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('statusbar-result')).toContainText('「削除」はいま使えません');
      await expect(page.getByTestId('statusbar-result')).toContainText('閉じてから');
      expect(changedVertexIds(before, await committedVertices(page, featureId))).toEqual([]);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('statusbar-result')).toContainText('「元に戻す」はいま使えません');
      await expect(page.getByTestId('vertex-candidates')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('一覧の行に乗っている間だけ、地図の上でその頂点が輪で囲まれる', async () => {
    const { app, page } = await launchApp();
    try {
      await openVertexCandidatesOnTinySquare(page);
      const base = (await primitiveCounts(page)).line;
      const row = page.getByTestId('vertex-candidates').locator('button[data-feature-id]').nth(1);
      await row.hover();
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(base + 1);
      // 頂点の印の数は変わらない（輪は印ではない）。
      expect((await vertexHandlePositions(page)).length).toBe(4);
      await page.getByTestId('vertex-candidates').locator('.vertex-candidates__head').hover();
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(base);
      // 一覧を畳むと輪も消える。
      await row.hover();
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(base + 1);
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(base);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 実データ（DERLE_TMAP_DIR か derle-import/ に複写元が無ければ skip）
// ---------------------------------------------------------------------------

test.describe('増分 8A — 実データ（デーレ界）の密度で頂点を狙う（V9）', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  async function withRealData(body: (page: Page) => Promise<void>): Promise<void> {
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc8a-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);
    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await body(page);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
  }

  async function selectByName(page: Page, name: string): Promise<void> {
    await page.getByTestId('sidebar-tab-list').click();
    await page.getByTestId('unified-list-filter').fill(name);
    const row = page.locator('[data-testid^="feature-list-item-"]').first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
  }

  // B86（2026-10-03 の観察「一覧が出たまま別の点を押すと、前の一覧の持ち主が選ばれる」）の確かめ。
  // 実データの全体表示で、押すと一覧が出る点を 2 つ（A・B。B は A の一覧の矩形の外）探し、
  // 「A を押して一覧が出たまま B を押す」と「素の状態から B を押す」が同じ結果になることを見る。
  // 観察の正体は「B が A の一覧の矩形の上にあり、行を押していた」で、アプリの不具合では
  // なかった（行を押せばその頂点を選ぶのが正しい）。一覧の外の押下はそのまま地図に届く。
  test('B86: 一覧が出たまま一覧の外の点を押すと、素の状態から押したのと同じ結果になる', async () => {
    test.setTimeout(240_000);
    await withRealData(async (page) => {
      await enterEditMode(page);
      const map = (await page.getByTestId('map-input-layer').boundingBox())!;
      const cx = map.x + map.width / 2;
      const cy = map.y + map.height / 2;
      const list = page.getByTestId('vertex-candidates');
      const vertexNow = async (): Promise<string> =>
        ((await page.getByTestId('app-active-vertex').textContent()) ?? '').trim();
      const rowsNow = async (): Promise<string[]> =>
        list.locator('[data-testid^="vertex-candidate-v"]').evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-testid') ?? ''),
        );
      const fresh = async (): Promise<void> => {
        for (let i = 0; i < 4; i += 1) await page.keyboard.press('Escape');
        await expect(list).toHaveCount(0);
      };

      // 素の状態から押すと一覧が出る点を集める（一覧の矩形・選ばれた頂点・行の並びも覚える）。
      interface Spot {
        readonly x: number;
        readonly y: number;
        readonly box: { x: number; y: number; width: number; height: number };
        readonly vertex: string;
        readonly feature: string;
        readonly rows: string[];
      }
      const spots: Spot[] = [];
      for (const dy of [-120, -60, 0, 60, 120]) {
        for (const dx of [-240, -180, -120, -60, 0, 60, 120, 180, 240]) {
          await fresh();
          await page.mouse.click(cx + dx, cy + dy);
          if ((await list.count()) === 0) continue;
          spots.push({
            x: cx + dx,
            y: cy + dy,
            box: (await list.boundingBox())!,
            vertex: await vertexNow(),
            feature: await activeFeatureId(page),
            rows: await rowsNow(),
          });
        }
      }
      const outside = (s: Spot, p: { x: number; y: number }): boolean =>
        p.x < s.box.x - 4 ||
        p.x > s.box.x + s.box.width + 4 ||
        p.y < s.box.y - 4 ||
        p.y > s.box.y + s.box.height + 4;
      let pair: { a: Spot; b: Spot } | null = null;
      for (const a of spots) {
        const b = spots.find((s) => s !== a && outside(a, s) && s.vertex !== a.vertex);
        if (b !== undefined) {
          pair = { a, b };
          break;
        }
      }
      expect(pair, `一覧が出る点が 2 つ見つからない（見つかった点 ${String(spots.length)}）`).not.toBeNull();
      const { a, b } = pair!;
      // 素の状態から B を押したときは、地物は選ばれず頂点が選ばれて一覧が出る。
      expect(b.feature).toBe('');

      await fresh();
      await page.mouse.click(a.x, a.y);
      await expect(list).toHaveCount(1);
      await page.mouse.click(b.x, b.y);
      // A の一覧が出たまま B を押しても、素の状態から B を押したのと同じ。
      await expect(list).toHaveCount(1);
      expect(await vertexNow()).toBe(b.vertex);
      expect(await activeFeatureId(page)).toBe(b.feature);
      expect(await rowsNow()).toEqual(b.rows);
    });
  });

  test('バアカ（601 頂点）: 全体表示のまま、候補一覧から選んだ頂点を掴める', async () => {
    test.setTimeout(180_000);
    await withRealData(async (page) => {
      await enterEditMode(page);
      await selectByName(page, 'バアカ');
      await page.getByTestId('map-fit-all').click();
      await expect.poll(async () => (await vertexHandlePositions(page)).length, {
        timeout: 20_000,
      }).toBeGreaterThan(100);
      const target = await handleNearMapCentre(page);
      const { usedList } = await grabTargetedVertex(page, target, 'inward');
      // 全体表示では隣まで 1px 未満なので、必ず一覧を通っている。
      expect(usedList).toBe(true);
    });
  });

  test('領域01（2,230 頂点）: 全体表示では理由と［拡大］が出て、［拡大］のあと狙った頂点を掴める', async () => {
    test.setTimeout(180_000);
    await withRealData(async (page) => {
      await enterEditMode(page);
      await selectByName(page, 'ヴィオニア大陸付近の領域01');
      await page.getByTestId('map-fit-all').click();
      const next = page.getByTestId('option-bar-next-step');
      await expect(next).toContainText('頂点が 2,230 あり、上限 2,000 のため印を出していません。拡大すると出ます');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(0);
      await page.getByTestId('option-bar-next-action-handle-cap-zoom').click();
      await expect.poll(async () => (await vertexHandlePositions(page)).length, {
        timeout: 20_000,
      }).toBeGreaterThan(0);
      await expect(next).not.toContainText('上限 2,000');
      const target = await handleNearMapCentre(page);
      await grabTargetedVertex(page, target, 'inward');
    });
  });

  // 統合 8A〜8D の継ぎ目の検証 2-1（8A × 測る）。直す前は、中ボタンで地図を動かしていくと
  // 7 回目で次の一手が「地図か地物一覧から選ぶ」（選ぶの既定の文）に化け、寄ると上限の知らせ
  // ［拡大］に置き換わった。測っている間は上限の知らせを出さず、測るの帯は書いた人の印つきで書く。
  test('領域01 を選んだまま測ると、地図を動かしても寄っても、次の一手は測るの案内のまま', async () => {
    test.setTimeout(180_000);
    await withRealData(async (page) => {
      await enterEditMode(page);
      await selectByName(page, 'ヴィオニア大陸付近の領域01');
      await page.getByTestId('map-fit-all').click();
      const next = page.getByTestId('option-bar-next-step');
      const zoomAction = page.getByTestId('option-bar-next-action-handle-cap-zoom');
      await expect(next).toContainText('上限 2,000');

      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-input-layer')).toBeVisible();
      const idle = '測っている間は地物を選べません';
      await expect(next).toContainText(idle);
      await expect(zoomAction).toHaveCount(0);

      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // ホイールで 2 段寄る（視野内の頂点の数が変わる）。
      for (let i = 0; i < 2; i += 1) {
        const before = await liveCamera(page);
        await page.mouse.move(cx, cy);
        await page.mouse.wheel(0, -120);
        await expect.poll(async () => (await liveCamera(page)).zoom).toBeGreaterThan(before.zoom);
        await expect(next).toContainText(idle);
        await expect(zoomAction).toHaveCount(0);
      }
      // 中ボタンで少しずつ動かし、領域01 の一部を画面の外へ出していく（直す前は 7 回目で化けた）。
      for (let i = 0; i < 12; i += 1) {
        const before = await liveCamera(page);
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(cx + 60, cy + 20, { steps: 4 });
        await page.mouse.up({ button: 'middle' });
        await expect
          .poll(async () => (await liveCamera(page)).centerLon)
          .not.toBe(before.centerLon);
        await expect(next).toContainText(idle);
        await expect(zoomAction).toHaveCount(0);
      }
      // 始点を置くと終点を待つ案内になり、引いて（頂点の数を変えて）も置き換わらない。
      await page.mouse.click(cx, cy);
      await expect(next).toContainText('終点を指定');
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 120);
      await page.mouse.wheel(0, 120);
      await expect(next).toContainText('終点を指定');
      await expect(zoomAction).toHaveCount(0);
    });
  });
});
