// 実データで［動かす］の集約地物を引く（所有者の裁定 2026-11-01）。デーレ共和国は下位 60 州、動く頂点
// 2,615 個、動かない頂点 452 個で、実データの集約地物でいちばん大きい。
//
//   - 引いている間の 1 コマの時間を測る（数字は標準出力へ出す）。
//   - 半周より小さい引きでも、領海の穴が外周を越えれば理由を言って断る。
//   - 重なりの板で外の地物を残して確定し、保存して開き直しても修復を聞かれない。
//
// ⚠️ 正本は開かない。一時ディレクトリのコピーを開く（§5.48）。

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import { APP_STRINGS } from '../src/ui/shell/strings';
import {
  committedVertices,
  launchApp,
  leafReport,
  leaveViewMode,
  liveCamera,
  loadProject,
  projectStats,
  worldToClient,
} from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);
const STATUS = 'statusbar-result';

/** デーレ共和国の下にある州。頂点の平均がその州の内側に落ちる。 */
const STATE_NAME = 'イニーカミド州';

interface FrameTimes {
  readonly count: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

async function startFrameRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as { __frames: number[]; __recording: boolean };
    host.__frames = [];
    host.__recording = true;
    let last = performance.now();
    const tick = (now: number): void => {
      host.__frames.push(now - last);
      last = now;
      if (host.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopFrameRecorder(page: Page): Promise<FrameTimes> {
  const frames = await page.evaluate(() => {
    const host = window as unknown as { __frames: number[]; __recording: boolean };
    host.__recording = false;
    return host.__frames;
  });
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** 書き出したファイルから、`rootId` の下にある末端地物の名前を全部拾う。 */
function namesUnder(path: string, rootId: string): ReadonlySet<string> {
  const manifest = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['manifest.json']!),
  ) as unknown;
  const features = new Map<
    string,
    { readonly kind: string; readonly parentId?: string; readonly attributes: { readonly name: string } }
  >();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o['id'] === 'string' && (o['kind'] === 'leaf' || o['kind'] === 'aggregate')) {
      features.set(o['id'], o as never);
    }
    Object.values(o).forEach(walk);
  };
  walk(manifest);
  const names = new Set<string>();
  for (const f of features.values()) {
    if (f.kind !== 'leaf') continue;
    for (let up = f.parentId; up !== undefined; up = features.get(up)?.parentId) {
      if (up === rootId) names.add(f.attributes.name);
    }
  }
  return names;
}

/** 州の内側の点。 */
async function insideState(page: Page): Promise<{ readonly lon: number; readonly lat: number }> {
  const report = await leafReport(page, { names: [STATE_NAME] });
  const id = report.entries[0]!.id;
  const vertices = [...(await committedVertices(page, id)).values()];
  return {
    lon: vertices.reduce((a, p) => a + p.lon, 0) / vertices.length,
    lat: vertices.reduce((a, p) => a + p.lat, 0) / vertices.length,
  };
}

/** 押した点を中心に、倍率が `zoom` を超えるまで拡大する。 */
async function zoomInAround(
  page: Page,
  world: { readonly lon: number; readonly lat: number },
  zoom: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const at = await worldToClient(page, world);
        await page.mouse.move(at.x, at.y);
        const now = (await liveCamera(page)).zoom;
        if (now >= zoom) return true;
        await page.mouse.wheel(0, -300);
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test.describe('実データの集約地物を［動かす］で引く', () => {
  test.skip(!existsSync(canonicalPath), `実データが無い (${canonicalPath})`);

  test('引き心地を測り、大きな引きは理由を言って断り、板で確定したものは保存して開き直しても修復を聞かれない', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-aggregate-real-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const { app, page } = await launchApp();
    try {
      expect(await loadProject(page, workingCopy)).toBe('loaded');
      await leaveViewMode(page);
      const inside = await insideState(page);
      await page.getByTestId('tool-edit.move').click();
      let at = await worldToClient(page, inside);
      await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId('app-active-feature')).not.toHaveText('');
      const federationId = (await page.getByTestId('app-active-feature').textContent()) ?? '';
      const before = await projectStats(page);

      // 引いている間の 1 コマ。全体図で 60 回に分けて引く。
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 5, at.y, { steps: 2 });
      await startFrameRecorder(page);
      const moveStart = Date.now();
      for (let i = 0; i < 60; i += 1) {
        await page.mouse.move(at.x + 5 + (i % 30), at.y + (i % 20));
        await page.waitForTimeout(16);
      }
      const frames = await stopFrameRecorder(page);
      const wallMs = Date.now() - moveStart;
      const releaseStart = Date.now();
      await page.mouse.up();
      await expect(page.getByTestId(STATUS)).not.toHaveText('');
      // 半周より小さくても、領海の穴が外周を越える引きは断る。
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expect(page.getByTestId(STATUS)).toContainText('領海');
      console.log(
        `[実データ] 引いている間のコマ: ${JSON.stringify(frames)} 60 回の移動 ${String(wallMs)}ms、離してから断りまで ${String(Date.now() - releaseStart)}ms`,
      );
      expect(await projectStats(page)).toEqual(before);

      // 寄せて小さく引くと重なりの板で止まる。外の地物を残して確定する。
      await zoomInAround(page, inside, 25);
      at = await worldToClient(page, inside);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 7, at.y - 3, { steps: 4 });
      const commitStart = Date.now();
      await page.mouse.up();
      const dialog = page.getByTestId('conflict-dialog');
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      console.log(`[実データ] 離してから板まで ${String(Date.now() - commitStart)}ms`);
      if (await page.getByTestId('conflict-guide').isVisible()) {
        await page.getByTestId('conflict-guide-close').click();
      }
      const rows = page.getByTestId('conflict-rows').locator('li');
      const moved = namesUnder(workingCopy, federationId);
      // 名前で数えるので 60 より少ない（???州 が 10 件ある）。
      expect(moved.size).toBeGreaterThan(40);
      for (let i = 0; i < (await rows.count()); i += 1) {
        // 外の地物のほうを残す（動かした州を削る）。
        const radios = rows.nth(i).getByRole('radio');
        const first = (await radios.nth(0).locator('xpath=ancestor::label[1]').textContent()) ?? '';
        const firstIsMoved = [...moved].some((name) => first.includes(name));
        await radios.nth(firstIsMoved ? 1 : 0).check();
      }
      await page.getByTestId('conflict-apply').click();
      await expect(dialog).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByTestId(STATUS)).toContainText(APP_STRINGS.moveAggregateDone(60, 452));

      const movedState = Object.fromEntries(
        await committedVertices(page, (await leafReport(page, { names: [STATE_NAME] })).entries[0]!.id),
      );
      await page.getByTestId(STATUS).click();
      await page.keyboard.press('Control+s');
      await page.getByTestId('overwrite-confirm').click();
      await expect(page.getByTestId(STATUS)).toContainText('保存しました');

      expect(await loadProject(page, workingCopy)).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
      expect(
        Object.fromEntries(
          await committedVertices(page, (await leafReport(page, { names: [STATE_NAME] })).entries[0]!.id),
        ),
      ).toEqual(movedState);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
