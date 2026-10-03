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
  commitOneFace,
  enterEditMode,
  launchApp,
  launchAppWithProject,
  openVertexCandidatesOnTinySquare,
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

async function primitiveCounts(page: Page): Promise<{ handle: number; dashedLine: number }> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getPrimitiveCounts: () => { handle: number; dashedLine: number } };
    }).__E2E__;
    return e2e === undefined ? { handle: 0, dashedLine: 0 } : e2e.getPrimitiveCounts();
  });
}

/** 「34.10°N 12.51°E」（`vertex-candidates.ts` の書式と同じ）。 */
function formatCoord(p: WorldPos): string {
  const lat = `${Math.abs(p.lat).toFixed(2)}°${p.lat < 0 ? 'S' : 'N'}`;
  const folded = ((((p.lon + 180) % 360) + 360) % 360) - 180;
  const lon = `${Math.abs(folded).toFixed(2)}°${folded < 0 ? 'W' : 'E'}`;
  return `${lat} ${lon}`;
}

const key = (p: WorldPos): string => `${p.lon.toFixed(9)},${p.lat.toFixed(9)}`;

/**
 * **狙った頂点を掴めるか**を見る（V9 の本体）。
 *
 * 1. `target` の位置をクリックする。候補一覧が出たら、**いま選んでいる地物の行のうち
 *    いちばん近いもの以外**（＝ 素の当たり判定なら掴まれない頂点）を選ぶ。出なければ
 *    クリックで選ばれた頂点がそのまま狙いである。
 * 2. 同じ位置を押して `direction` へ少し動かし、**ドラッグ中の印の位置**を読む。動いた印が
 *    ちょうど 1 つで、それが選んだ頂点（一覧の行の座標と同じ）であることを確かめる。
 *
 * 動かす量は小さく（6px）、確定の成否は見ない ―― 見たいのは「何を掴んだか」である。
 */
async function grabTargetedVertex(
  page: Page,
  target: WorldPos,
  direction: 'inward' | 'outward',
): Promise<{ usedList: boolean }> {
  const at = await worldToClient(page, target);
  await page.mouse.click(at.x, at.y);
  const list = page.getByTestId('vertex-candidates');
  let expectedCoord: string | null = null;
  let usedList = false;
  if ((await list.count()) > 0) {
    usedList = true;
    const active = ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
    const rows = list.locator(`button[data-feature-id="${active}"]`);
    const n = await rows.count();
    expect(n, '一覧に、いま選んでいる地物の頂点が 1 つも無い').toBeGreaterThan(0);
    const row = rows.nth(n >= 2 ? 1 : 0);
    const label = (await row.locator('.vertex-candidates__name').textContent()) ?? '';
    expect(label).toMatch(/^頂点 #/);
    const m = /（(\d+\.\d\d°[NS] \d+\.\d\d°[EW])/.exec(label);
    expect(m, `行の書式が違う: ${label}`).not.toBeNull();
    expectedCoord = m![1]!;
    const testId = (await row.getAttribute('data-testid')) ?? '';
    const vertexId = testId.replace(/^vertex-candidate-/, '');
    await row.click();
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId('app-active-vertex')).toHaveText(vertexId);
  } else {
    await expect(page.getByTestId('app-active-vertex')).toHaveText(/\S/);
  }

  const before = await vertexHandlePositions(page);
  expect(before.length).toBeGreaterThan(0);
  const c = {
    lon: before.reduce((s, h) => s + h.lon, 0) / before.length,
    lat: before.reduce((s, h) => s + h.lat, 0) / before.length,
  };
  const centre = await worldToClient(page, c);
  const vx = centre.x - at.x;
  const vy = centre.y - at.y;
  const len = Math.hypot(vx, vy) || 1;
  const sign = direction === 'inward' ? 1 : -1;
  const dx = (sign * 6 * vx) / len;
  const dy = (sign * 6 * vy) / len;

  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx / 2, at.y + dy / 2);
  await page.mouse.move(at.x + dx, at.y + dy);
  let moved: WorldPos[] = [];
  await expect
    .poll(async () => {
      const during = new Set((await vertexHandlePositions(page)).map(key));
      moved = before.filter((p) => !during.has(key(p)));
      return moved.length;
    })
    .toBe(1);
  if (expectedCoord !== null) {
    expect(formatCoord(moved[0]!), '一覧で選んだのとは別の頂点が動いた').toBe(expectedCoord);
  }
  // 掴んだものは見た。ドラッグは Escape で元の位置へ戻して終える（確定の成否は見ない）。
  await page.keyboard.press('Escape');
  await page.mouse.up();
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
      // 上の辺の中点（動かさずに押して離す）。
      await page.mouse.click((x0 + x1) / 2, y0);
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(5);
      await page.keyboard.press('Control+z');
      await expect.poll(async () => (await vertexHandlePositions(page)).length).toBe(4);
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
});
