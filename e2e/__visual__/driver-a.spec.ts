// VISUAL-A (discovery-only, NOT committed) — real-screen visual verification of
//   FR-22  リング編集: 既存地物へ穴を追加 (A1) / 飛び地を追加 (A2)
//   FR-24  リング削除 (A3)
//   FR-45  drill ツールで穴あけ = 新地物生成 (A4)
//   FR-30  共有頂点の琥珀色ハンドル (A5, ナイフ分割で共有頂点を作る)
//   選択頂点ハイライトの接写ペア (A6, 同一ビューポートで選択前/選択後)
//
// Drives the REAL built Electron composite like a user (launch helper + testid 導線
// read from the LIVE source, not from memory). Discovery style: screenshots are the
// deliverable; assertions are light; a jam is recorded and the run moves on. app /
// domain / src code is NEVER touched.
//
// 到達可能性ノート (U-C): リング編集は「面を選ぶクリック」と「リングを描く/選ぶ
// クリック」の 2 段構えである。ライブの featureAtPoint (leafAtPoint) は穴透過なので
// 面選択は必ずソリッド部分をクリックする必要があるが、面選択後のクリックはヒット
// テストに依存しない。よって A2 の飛び地 (面の外に頂点) と A3 の穴リング削除 (穴の
// 内側をクリック) は生クリックだけで到達する — この spec はそれを実機で固定する。
// __E2E__.screenToWorld のアフィンは、クリック位置の world 座標を記録するために測る。

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from '../helpers';
import { placeSquareScene, assertClickable, type SceneBox } from '../__bughunt__/scene-layout';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotDir = resolve(projectRoot, 'screenshots', '__visual__');
mkdirSync(shotDir, { recursive: true });

interface Note {
  readonly kind: string;
  readonly detail: string;
}
const notes: Note[] = [];
function record(kind: string, detail: string): void {
  notes.push({ kind, detail });
  // eslint-disable-next-line no-console
  console.log(`VISUALA:${kind}: ${detail}`);
}

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: resolve(shotDir, `${name}.png`) });
  } catch (e) {
    record('screenshot-fail', `${name}: ${String(e)}`);
  }
}

async function shotClip(
  page: Page,
  name: string,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Buffer | null> {
  try {
    return await page.screenshot({ path: resolve(shotDir, `${name}.png`), clip });
  } catch (e) {
    record('screenshot-fail', `${name}: ${String(e)}`);
    return null;
  }
}

function attachListeners(page: Page): void {
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('VISUALA')) return;
    if (msg.type() === 'error') record('console.error', text);
  });
  page.on('pageerror', (err) => record('pageerror', `${err.name}: ${err.message}`));
  page.on('crash', () => record('page.crash', 'renderer crashed'));
}

// --- live observability hooks -------------------------------------------------
async function activeFeature(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}
async function activeVertex(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-vertex').textContent()) ?? '').trim();
}
async function handleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getPrimitiveCounts: () => { handle: number } };
    }).__E2E__;
    return e2e === undefined ? -1 : e2e.getPrimitiveCounts().handle;
  });
}
async function drawnFeatureCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (window as unknown as { __E2E__?: { getDrawnFeatureCount: () => number } }).__E2E__;
    return e2e === undefined ? -1 : e2e.getDrawnFeatureCount();
  });
}
async function showListTab(page: Page): Promise<void> {
  const tab = page.getByTestId('sidebar-tab-list');
  if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => undefined);
  const current = page.getByTestId('list-mode-current');
  if (await current.isVisible().catch(() => false)) await current.click().catch(() => undefined);
}
async function featureListCount(page: Page): Promise<number> {
  await showListTab(page);
  if ((await page.getByTestId('unified-list-empty').count()) > 0) return 0;
  return page.locator('[data-testid^="feature-list-item-"]').count();
}
async function textOf(page: Page, testid: string): Promise<string> {
  const loc = page.getByTestId(testid);
  if ((await loc.count()) === 0) return '';
  return ((await loc.first().textContent()) ?? '').trim();
}

// --- mode / tool helpers ------------------------------------------------------
async function leaveView(page: Page): Promise<void> {
  const v = page.getByTestId('mode-view');
  if ((await v.getAttribute('aria-pressed')) === 'true') await v.click();
}
async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  await leaveView(page);
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
}
async function armEditTool(page: Page, tool: string): Promise<boolean> {
  await enterEditMode(page);
  const btn = page.getByTestId(`tool-edit.${tool}`);
  if (!(await btn.isVisible().catch(() => false))) {
    record('edit-tool-missing', `tool-edit.${tool} not visible`);
    return false;
  }
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  return (await btn.getAttribute('aria-pressed')) === 'true';
}

/** Commit ONE 面 through the LIVE add 導線 from four explicit screen corners. */
async function commitFaceAt(
  page: Page,
  corners: ReadonlyArray<readonly [number, number]>,
): Promise<string> {
  await leaveView(page);
  const add = page.getByTestId('mode-add');
  await expect(add).toBeEnabled();
  if ((await add.getAttribute('aria-pressed')) !== 'true') await add.click();
  const area = page.getByTestId('tool-add.area');
  await expect(area).toBeVisible();
  if ((await area.getAttribute('aria-pressed')) !== 'true') await area.click();
  await expect(page.getByTestId('add-input-layer')).toBeVisible();
  for (const [px, py] of corners) await page.mouse.click(px, py);
  const complete = page.getByTestId('add-complete');
  await expect(complete).toBeEnabled();
  await complete.click();
  await page.getByTestId('add-save').click();
  try {
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/, { timeout: 8000 });
  } catch {
    record('add-no-selection', 'active-feature empty after add commit');
  }
  return activeFeature(page);
}

// --- screen⇄world affine (measured from the LIVE renderer inverse) ------------
interface Affine {
  lonAt(x: number): number;
  latAt(y: number): number;
  xAt(lon: number): number;
  yAt(lat: number): number;
  readonly lonPerPx: number;
  readonly latPerPx: number;
}

async function s2w(
  page: Page,
  x: number,
  y: number,
): Promise<{ lon: number; lat: number } | null> {
  return page.evaluate(
    ([cx, cy]: readonly [number, number]) => {
      const e2e = (window as unknown as {
        __E2E__?: {
          screenToWorld: (a: number, b: number) => { lon: number; lat: number } | null;
        };
      }).__E2E__;
      return e2e === undefined ? null : e2e.screenToWorld(cx, cy);
    },
    [x, y] as const,
  );
}

async function measureAffine(page: Page, x0: number, y0: number): Promise<Affine> {
  const a = await s2w(page, x0, y0);
  const b = await s2w(page, x0 + 200, y0);
  const c = await s2w(page, x0, y0 + 200);
  if (a === null || b === null || c === null) throw new Error('screenToWorld hook unavailable');
  const lonPerPx = (b.lon - a.lon) / 200;
  const latPerPx = (c.lat - a.lat) / 200;
  record(
    'affine',
    `origin=(${x0},${y0}) world=(${a.lon.toFixed(3)},${a.lat.toFixed(3)}) ` +
      `lonPerPx=${lonPerPx.toFixed(4)} latPerPx=${latPerPx.toFixed(4)} ` +
      `crossLat=${(b.lat - a.lat).toFixed(4)} crossLon=${(c.lon - a.lon).toFixed(4)}`,
  );
  return {
    lonAt: (x) => a.lon + (x - x0) * lonPerPx,
    latAt: (y) => a.lat + (y - y0) * latPerPx,
    xAt: (lon) => Math.round(x0 + (lon - a.lon) / lonPerPx),
    yAt: (lat) => Math.round(y0 + (lat - a.lat) / latPerPx),
    lonPerPx,
    latPerPx,
  };
}

/** Sample the live map canvas around a client point; count amber (FR-30) pixels. */
async function sampleHandleColors(
  page: Page,
  x: number,
  y: number,
  radius: number,
): Promise<string> {
  return page.evaluate(
    ([cx, cy, r]: readonly [number, number, number]) => {
      const mount = document.querySelector('[data-testid="map-canvas-mount"]');
      const canvas = mount?.querySelector('canvas') as HTMLCanvasElement | null;
      if (canvas === null) return 'no-canvas';
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      const px = Math.round((cx - rect.left) * sx);
      const py = Math.round((cy - rect.top) * sy);
      const half = Math.round(r * sx);
      const ctx = canvas.getContext('2d');
      if (ctx === null) return 'no-2d-context';
      let data: ImageData;
      try {
        data = ctx.getImageData(px - half, py - half, half * 2, half * 2);
      } catch (e) {
        return `getImageData-failed: ${String(e)}`;
      }
      let amber = 0;
      let white = 0;
      let blue = 0;
      const counts = new Map<string, number>();
      for (let i = 0; i < data.data.length; i += 4) {
        const rr = data.data[i]!;
        const gg = data.data[i + 1]!;
        const bb = data.data[i + 2]!;
        const key = `${rr},${gg},${bb}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (Math.abs(rr - 255) < 24 && Math.abs(gg - 213) < 24 && Math.abs(bb - 74) < 40) amber += 1;
        else if (rr > 240 && gg > 240 && bb > 240) white += 1;
        else if (Math.abs(rr - 10) < 40 && Math.abs(gg - 102) < 40 && Math.abs(bb - 194) < 50) blue += 1;
      }
      const top = [...counts.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
      return `amber=${amber} white=${white} blueStroke=${blue} top=${JSON.stringify(top)}`;
    },
    [x, y, radius] as const,
  );
}

// =============================================================================
// A1 / A2 / A3 — FR-22 穴追加・飛び地追加 / FR-24 リング削除
// =============================================================================
test.describe('VISUAL-A — FR-22 / FR-24 リング編集', () => {
  test('A1 穴を追加 / A2 飛び地を追加 / A3 リング削除', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const inputLayer = page.getByTestId('map-input-layer');
      const raw = await inputLayer.boundingBox();
      expect(raw).not.toBeNull();
      const box: SceneBox = raw!;
      record('map-box', JSON.stringify(box));

      // Scene: a 240×240 face, nudged right so the 飛び地 has clear canvas on its left.
      const half = 120;
      const scene = placeSquareScene(box, {
        fx: 0.6,
        fy: 0.45,
        half,
        avoidTopChrome: true,
        name: 'ring-face',
      });
      const { cx, cy } = scene;

      const aff = await measureAffine(page, cx, cy);

      // A plain square face; every ring interaction below is a RAW click (no grid-snap
      // coordinate trick), which is the point of this driver after the U-C fix.
      const faceCorners: ReadonlyArray<readonly [number, number]> = [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ];
      record(
        'scene',
        `cx=${cx} cy=${cy} half=${half} ` +
          `faceLon=[${aff.lonAt(cx - half).toFixed(2)}, ${aff.lonAt(cx + half).toFixed(2)}] ` +
          `faceLat=[${aff.latAt(cy + half).toFixed(2)}, ${aff.latAt(cy - half).toFixed(2)}]`,
      );
      assertClickable(box, faceCorners, { avoidTopChrome: true, name: 'ring-face-corners' });

      const faceId = await commitFaceAt(page, faceCorners);
      record('face-committed', `faceId="${faceId}"`);

      // The three named spots every step below reuses:
      //   solid — inside the face, ABOVE the hole (always solid fill ⇒ the hit-test finds
      //           the face there, so it is the target-selection click);
      //   holeIn — the middle of the hole punched in A1 (a 穴透過 MISS for the hit-test);
      //   enclaveIn — the middle of the 飛び地 added in A2 (clear of the face).
      const solid: readonly [number, number] = [cx, cy - 90];
      const holeIn: readonly [number, number] = [cx, cy];
      const holeCorners: ReadonlyArray<readonly [number, number]> = [
        [cx - 55, cy - 55],
        [cx + 55, cy - 55],
        [cx + 55, cy + 55],
        [cx - 55, cy + 55],
      ];
      const enclaveIn: readonly [number, number] = [cx - half - 110, cy];
      const enclaveCorners: ReadonlyArray<readonly [number, number]> = [
        [cx - half - 60, cy - 60],
        [cx - half - 160, cy - 60],
        [cx - half - 160, cy + 60],
        [cx - half - 60, cy + 60],
      ];
      assertClickable(box, [solid, holeIn, enclaveIn], {
        avoidTopChrome: true,
        name: 'ring-spots',
      });
      assertClickable(box, holeCorners, { avoidTopChrome: true, name: 'hole-corners' });
      assertClickable(box, enclaveCorners, { avoidTopChrome: true, name: 'enclave-corners' });

      const flowOf = async (): Promise<string> =>
        (await page.getByTestId('ring-edit-tool').getAttribute('data-flow')) ?? '';
      const clickAt = async ([px, py]: readonly [number, number]): Promise<void> => {
        await page.mouse.click(px, py);
        await page.waitForTimeout(120);
      };
      const dismissConflict = async (label: string): Promise<void> => {
        if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
          record('conflict-modal', `${label} surfaced the conflict modal`);
          await page.getByTestId('conflict-cancel').click().catch(() => undefined);
          await page.waitForTimeout(200);
        }
      };

      // ---------------------------------------------------------------------
      // A1 — FR-22 既存地物へ穴を追加 (面を選択 → 面の内側に頂点 → 確定)
      // ---------------------------------------------------------------------
      const armedRing = await armEditTool(page, 'ring');
      record('ring-armed', `tool-edit.ring pressed=${armedRing}`);
      await expect(page.getByTestId('ring-edit-tool')).toBeVisible();
      record('ring-guide', await textOf(page, 'ring-edit-guide'));
      // FR-78 グリッドスナップ: the checkbox reflects the hook toggle, so it renders
      // checked even BEFORE a draft exists (it used to silently render unchecked).
      const gridSnap = page.getByTestId('ring-edit-gridsnap');
      await gridSnap.click();
      await page.waitForTimeout(150);
      const snapCheckedNoDraft = await gridSnap.isChecked();
      record('gridsnap-before-draft', `checked=${snapCheckedNoDraft} (no draft yet)`);
      expect(snapCheckedNoDraft).toBe(true);
      await gridSnap.click(); // back OFF: the ring clicks below are RAW coordinates
      await page.waitForTimeout(150);
      expect(await gridSnap.isChecked()).toBe(false);
      await shot(page, 'a-01-hole-before');

      // Phase 1: pick the target face. It places NO vertex.
      await clickAt(solid);
      record(
        'hole-target',
        `flow=${await flowOf()} vertex-count=${await textOf(page, 'ring-edit-vertex-count')} ` +
          `active-feature="${await activeFeature(page)}" ` +
          `guide="${await textOf(page, 'ring-edit-guide')}"`,
      );
      expect(await flowOf()).toBe('drafting');
      expect(await textOf(page, 'ring-edit-vertex-count')).toBe('0');

      // Phase 2: four RAW clicks inside the solid fill → 穴 (the first one classifies).
      for (const c of holeCorners) await clickAt(c);
      record(
        'hole-draft',
        `vertex-count=${await textOf(page, 'ring-edit-vertex-count')} flow=${await flowOf()}`,
      );
      expect(await textOf(page, 'ring-edit-vertex-count')).toBe('4');
      await shot(page, 'a-02-hole-draft');

      const confirmRing = page.getByTestId('ring-edit-confirm');
      record('hole-confirm-enabled', String(await confirmRing.isEnabled()));
      expect(await confirmRing.isEnabled()).toBe(true);
      await confirmRing.click();
      await page.waitForTimeout(500);
      await dismissConflict('hole add');
      record(
        'hole-committed',
        `message="${await textOf(page, 'ring-edit-message')}" ` +
          `vertex-count=${await textOf(page, 'ring-edit-vertex-count')} ` +
          `drawn-features=${await drawnFeatureCount(page)}`,
      );
      expect(await textOf(page, 'ring-edit-message')).toBe('');
      await shot(page, 'a-03-hole-after');

      // The hole is now REAL: the live hit-test is 穴透過, so a target-selection click in
      // the hole void finds no face and SAYS so instead of doing nothing (教訓 5.12).
      await clickAt(holeIn);
      const holeVoidMessage = await textOf(page, 'ring-edit-message');
      record('hole-void-is-a-miss', `message="${holeVoidMessage}" flow=${await flowOf()}`);
      expect(holeVoidMessage).not.toBe('');
      expect(await flowOf()).toBe('selecting-target');

      // ---------------------------------------------------------------------
      // A2 — FR-22 飛び地 (enclave) を追加: 面を選択 → 面の「外」に頂点 (生クリック)
      // ---------------------------------------------------------------------
      await clickAt(solid); // phase 1 again (the previous ring was committed)
      expect(await flowOf()).toBe('drafting');
      for (const c of enclaveCorners) await clickAt(c);
      record(
        'enclave-draft',
        `vertex-count=${await textOf(page, 'ring-edit-vertex-count')} ` +
          `message="${await textOf(page, 'ring-edit-message')}" ` +
          `active-feature="${await activeFeature(page)}"`,
      );
      expect(await textOf(page, 'ring-edit-vertex-count')).toBe('4');
      await shot(page, 'a-04-enclave-draft');

      const confirmEnclave = page.getByTestId('ring-edit-confirm');
      expect(await confirmEnclave.isEnabled()).toBe(true);
      await confirmEnclave.click();
      await page.waitForTimeout(500);
      await dismissConflict('enclave add');
      const enclaveMessage = await textOf(page, 'ring-edit-message');
      record(
        'enclave-result',
        `message="${enclaveMessage}" ` +
          `vertex-count=${await textOf(page, 'ring-edit-vertex-count')} ` +
          `drawn-features=${await drawnFeatureCount(page)}`,
      );
      expect(enclaveMessage).toBe('');
      await shot(page, 'a-05-enclave-after');

      // ---------------------------------------------------------------------
      // A3 — FR-24 リング削除: 穴リング削除 → 飛び地リング削除 (どちらも生クリック)
      // ---------------------------------------------------------------------
      await page.getByTestId('ring-edit-submode').click();
      await page.waitForTimeout(200);
      record(
        'delete-submode',
        `guide="${await textOf(page, 'ring-edit-guide')}" flow=${await flowOf()}`,
      );
      expect(await flowOf()).toBe('selecting-target');
      const listBeforeDelete = await featureListCount(page);
      await shot(page, 'a-06-ringdelete-before');

      // 穴削除 — phase 1 on the solid, phase 2 INSIDE the hole void (the click the
      // 穴透過 hit-test cannot resolve; the face's own ring containment decides).
      await clickAt(solid);
      expect(await flowOf()).toBe('deleting');
      await clickAt(holeIn);
      await page.waitForTimeout(400);
      await dismissConflict('hole delete');
      record(
        'holedelete-result',
        `message="${await textOf(page, 'ring-edit-message')}" ` +
          `feature-list=${await featureListCount(page)} ` +
          `drawn-features=${await drawnFeatureCount(page)}`,
      );
      expect(await textOf(page, 'ring-edit-message')).toBe('');
      // PROOF the hole ring is gone: the same point is SOLID again, so a phase-1 click
      // there now selects the face instead of reporting a miss.
      await clickAt(holeIn);
      record(
        'holedelete-proof',
        `re-click in the former hole → flow=${await flowOf()} ` +
          `message="${await textOf(page, 'ring-edit-message')}"`,
      );
      expect(await flowOf()).toBe('deleting');
      expect(await textOf(page, 'ring-edit-message')).toBe('');

      // 飛び地削除 — the face is already the delete target; click inside the 飛び地.
      await clickAt(enclaveIn);
      await page.waitForTimeout(400);
      await dismissConflict('enclave delete');
      const listAfterDelete = await featureListCount(page);
      record(
        'ringdelete-result',
        `message="${await textOf(page, 'ring-edit-message')}"; ` +
          `feature-list ${listBeforeDelete} -> ${listAfterDelete}; ` +
          `drawn-features=${await drawnFeatureCount(page)}`,
      );
      // FR-23 / FR-24: ring edits never add or drop a 地物 — the face survives both deletes.
      expect(listAfterDelete).toBe(listBeforeDelete);
      // PROOF the enclave ring is gone: that spot is empty canvas again ⇒ phase 1 misses.
      await clickAt(enclaveIn);
      const enclaveGoneMessage = await textOf(page, 'ring-edit-message');
      record(
        'enclavedelete-proof',
        `re-click in the former 飛び地 → message="${enclaveGoneMessage}" flow=${await flowOf()}`,
      );
      expect(enclaveGoneMessage).not.toBe('');
      await shot(page, 'a-07-ringdelete-after');

      // キャンセル releases the TOOL too, so the toolbar button un-presses and the SAME
      // button re-arms the tool (it used to stay pressed with the hook disarmed, and only
      // a detour through another tool could revive it).
      await page.getByTestId('ring-edit-cancel').click().catch(() => undefined);
      await page.waitForTimeout(250);
      const goneAfterCancel = (await page.getByTestId('ring-edit-tool').count()) === 0;
      const stillPressed =
        (await page.getByTestId('tool-edit.ring').getAttribute('aria-pressed')) === 'true';
      await page.getByTestId('tool-edit.ring').click();
      await page.waitForTimeout(250);
      const revivedBySameButton = (await page.getByTestId('ring-edit-tool').count()) > 0;
      record(
        'ring-cancel-rearm',
        `after キャンセル: chrome gone=${goneAfterCancel}, toolbar still aria-pressed=${stillPressed}, ` +
          `re-click same button revived=${revivedBySameButton}`,
      );
      expect(goneAfterCancel).toBe(true);
      expect(stillPressed).toBe(false);
      expect(revivedBySameButton).toBe(true);

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A123: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });

  // ===========================================================================
  // A4 — FR-45 drill: 穴あけ = 新地物生成
  // ===========================================================================
  test('A4 drill ツールで穴あけ → 新地物が生成され選択・一覧に現れる', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const half = 120;
      const scene = placeSquareScene(box, {
        fx: 0.5,
        fy: 0.45,
        half,
        avoidTopChrome: true,
        name: 'drill-face',
      });
      const { cx, cy } = scene;
      const faceId = await commitFaceAt(page, [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ]);
      record('drill-face-committed', `faceId="${faceId}"`);

      const listBefore = await featureListCount(page);
      const armed = await armEditTool(page, 'drill');
      record('drill-armed', `tool-edit.drill pressed=${armed}`);
      await expect(page.getByTestId('drill-tool')).toBeVisible();
      record('drill-guide', await textOf(page, 'drill-guide'));
      await page.waitForTimeout(250);
      await shot(page, 'a-08-drill-before');

      // The region: a square well inside the face. The FIRST click picks the target
      // 末端 AND becomes region vertex #1 (useDrillTool.handleClick).
      const region: ReadonlyArray<readonly [number, number]> = [
        [cx - 60, cy - 60],
        [cx + 60, cy - 60],
        [cx + 60, cy + 60],
        [cx - 60, cy + 60],
      ];
      assertClickable(box, region, { avoidTopChrome: true, name: 'drill-region' });
      for (const [px, py] of region) {
        await page.mouse.click(px, py);
        await page.waitForTimeout(90);
      }
      record(
        'drill-region',
        `vertex-count=${await textOf(page, 'drill-vertex-count')} ` +
          `flow=${await page.getByTestId('drill-tool').getAttribute('data-flow')} ` +
          `guide="${await textOf(page, 'drill-guide')}"`,
      );
      await shot(page, 'a-09-drill-region');

      const drillConfirm = page.getByTestId('drill-confirm');
      record('drill-confirm-enabled', String(await drillConfirm.isEnabled()));
      await drillConfirm.click();
      await page.waitForTimeout(400);
      const propsUp = (await page.getByTestId('drill-props').count()) > 0;
      record(
        'drill-props',
        `drill-props mounted=${propsUp} flow=${await page
          .getByTestId('drill-tool')
          .getAttribute('data-flow')} guide="${await textOf(page, 'drill-guide')}"`,
      );
      const nameInput = page.getByTestId('add-name');
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('穴あけ新地物');
      }
      await shot(page, 'a-10-drill-props');

      await page.getByTestId('add-save').click();
      await page.waitForTimeout(700);
      if ((await page.getByTestId('conflict-modal-root').count()) > 0) {
        record('drill-conflict', 'drill save surfaced the conflict modal');
        await page.getByTestId('conflict-cancel').click().catch(() => undefined);
      }
      const rejected = await textOf(page, 'drill-rejected');
      if (rejected !== '') record('drill-rejected', rejected);
      const newActive = await activeFeature(page);
      const listAfter = await featureListCount(page);
      record(
        'drill-result',
        `active-feature "${faceId}" -> "${newActive}" (${newActive === faceId ? 'UNCHANGED' : 'new feature selected'}); ` +
          `feature-list ${listBefore} -> ${listAfter}; drawn-features=${await drawnFeatureCount(page)}; ` +
          `message="${await textOf(page, 'drill-message')}"`,
      );
      // Show the sidebar 一覧 with the new feature row alongside the drilled map.
      await showListTab(page);
      await page.waitForTimeout(300);
      const rows = page.locator('[data-testid^="feature-list-item-"]');
      const labels: string[] = [];
      for (let i = 0; i < (await rows.count()); i += 1) {
        labels.push(((await rows.nth(i).textContent()) ?? '').trim().replace(/\s+/g, ' '));
      }
      record('drill-list-rows', JSON.stringify(labels));
      await shot(page, 'a-11-drill-after');

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A4: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });

  // ===========================================================================
  // A5 — FR-30 共有頂点の琥珀色ハンドル (ナイフ分割 → 編集モードで表示)
  // ===========================================================================
  test('A5 ナイフ分割で共有頂点を作り、編集モードで琥珀色ハンドルを撮る', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      // A 200×200 face with a 140px pierce: the only lane the live map cell leaves for
      // a cut whose BOTH endpoints stay on hittable canvas (the solver rejects 120/165).
      const half = 100;
      const scene = placeSquareScene(box, {
        fx: 0.5,
        fy: 0.45,
        half,
        pierce: half + 40,
        avoidTopChrome: true,
        name: 'knife-face',
      });
      const { cx, cy, cutTopY, cutBottomY } = scene;
      const faceId = await commitFaceAt(page, [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ]);
      record('knife-face-committed', `faceId="${faceId}"`);
      const listBefore = await featureListCount(page);

      // A straight vertical cut through the face: 2 crossings ⇒ 2 pieces, and the two
      // NEW boundary vertices are cited by BOTH pieces ⇒ FR-30 共有頂点.
      const cutX = cx - 30;
      const armed = await armEditTool(page, 'knife');
      record('knife-armed', `tool-edit.knife pressed=${armed}`);
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      await page.mouse.click(cx, cy); // pick the split target (promotes selection)
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
      assertClickable(
        box,
        [
          [cutX, cutTopY],
          [cutX, cutBottomY],
        ],
        { avoidTopChrome: true, name: 'knife-cut' },
      );
      await page.mouse.click(cutX, cutTopY);
      await page.mouse.click(cutX, cutBottomY);
      record('knife-cut', `cut-count=${await textOf(page, 'knife-cut-count')} cutX=${cutX}`);
      await shot(page, 'a-12-knife-cut');

      await page.getByTestId('knife-confirm-cut').click();
      await page.waitForTimeout(400);
      const knifeRejected = await textOf(page, 'knife-rejected');
      if (knifeRejected !== '') record('knife-rejected', knifeRejected);
      const modal = page.getByTestId('knife-inheritor-modal-root');
      if (await modal.isVisible().catch(() => false)) {
        await page.getByTestId('knife-choose-0').click();
        await page.getByTestId('knife-confirm-inheritor').click();
        await expect(page.getByTestId('knife-props')).toBeVisible();
        await page.getByTestId('add-save').click();
        await page.waitForTimeout(700);
      } else {
        record('knife-modal-missing', 'knife-inheritor-modal-root never appeared');
      }
      const listAfter = await featureListCount(page);
      record('knife-split', `feature-list ${listBefore} -> ${listAfter}`);

      // Select ONE piece with 選択 tool so the static edit handles composite.
      await armEditTool(page, 'select');
      await page.mouse.click(cutX - 50, cy); // the LEFT piece body
      await page.waitForTimeout(400);
      record(
        'shared-vertex-selection',
        `active-feature="${await activeFeature(page)}" handles=${await handleCount(page)}`,
      );
      await shot(page, 'a-13-shared-vertex-full');

      // The two cut-line vertices sit where the cut crossed the top / bottom edges.
      const topCut: readonly [number, number] = [cutX, cy - half];
      const bottomCut: readonly [number, number] = [cutX, cy + half];
      const cornerRef: readonly [number, number] = [cx - half, cy - half];
      record('pixel-top-cut-vertex', await sampleHandleColors(page, topCut[0], topCut[1], 14));
      record(
        'pixel-bottom-cut-vertex',
        await sampleHandleColors(page, bottomCut[0], bottomCut[1], 14),
      );
      record(
        'pixel-plain-corner-vertex',
        await sampleHandleColors(page, cornerRef[0], cornerRef[1], 14),
      );
      // Close-up strip covering the shared (cut) vertex AND a plain corner vertex.
      await shotClip(page, 'a-14-shared-vertex-closeup', {
        x: Math.round(cx - half - 40),
        y: Math.round(cy - half - 35),
        width: Math.round(half + 30 + 80),
        height: 90,
      });

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A5: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });

  // ===========================================================================
  // A6 — 選択頂点ハイライトの接写ペア (同一ビューポート / 選択前・選択後)
  // ===========================================================================
  test('A6 頂点ハンドルの接写ペア: 選択前 / 選択後 (同一ビューポート)', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const half = 120;
      const scene = placeSquareScene(box, {
        fx: 0.5,
        fy: 0.45,
        half,
        avoidTopChrome: true,
        name: 'zoom-face',
      });
      const { cx, cy } = scene;
      const faceId = await commitFaceAt(page, [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ]);
      record('zoom-face-committed', `faceId="${faceId}"`);

      const armed = await armEditTool(page, 'vertex');
      record('vertex-tool-armed', `tool-edit.vertex pressed=${armed}`);
      await page.mouse.click(cx, cy); // select the face → handles composite
      await page.waitForTimeout(300);
      record(
        'zoom-selected-feature',
        `active-feature="${await activeFeature(page)}" handles=${await handleCount(page)}`,
      );

      // Cursor-anchored wheel zoom AT the corner vertex: the world point under the
      // cursor is invariant, so the handle stays at this exact client position while
      // the surrounding geometry magnifies (the handle itself is screen-fixed 5px —
      // FR-17 — so the close-up crop is what makes it read large).
      const vx = cx - half;
      const vy = cy - half;
      const zoomBefore = await page.getByTestId('map-input-layer').getAttribute('data-zoom');
      await page.mouse.move(vx, vy);
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(400);
      const zoomAfter = await page.getByTestId('map-input-layer').getAttribute('data-zoom');
      record('zoom', `data-zoom ${zoomBefore} -> ${zoomAfter}`);
      const handlesZoomed = await handleCount(page);
      record('zoom-handles', `handle primitives after zoom=${handlesZoomed}`);

      const clip = { x: Math.round(vx - 90), y: Math.round(vy - 70), width: 180, height: 140 };
      const beforeBuf = await shotClip(page, 'a-15-vertexsel-before-closeup', clip);
      await shot(page, 'a-16-vertexsel-before-full');
      record(
        'vertex-before',
        `active-vertex="${await activeVertex(page)}" handles=${await handleCount(page)}`,
      );
      record('pixel-before', await sampleHandleColors(page, vx, vy, 14));

      // SELECT the vertex (a plain click on the handle promotes it, U22 vertex branch).
      await page.mouse.click(vx, vy);
      await page.waitForTimeout(400);
      const selectedVertex = await activeVertex(page);
      record(
        'vertex-after',
        `active-vertex="${selectedVertex}" (${selectedVertex === '' ? 'NOT SELECTED' : 'selected'}) ` +
          `handles=${await handleCount(page)}`,
      );
      record('pixel-after', await sampleHandleColors(page, vx, vy, 14));
      const afterBuf = await shotClip(page, 'a-17-vertexsel-after-closeup', clip);
      await shot(page, 'a-18-vertexsel-after-full');

      if (beforeBuf !== null && afterBuf !== null) {
        record(
          'closeup-pair-diff',
          `before/after close-up PNG bytes ${beforeBuf.equals(afterBuf) ? 'IDENTICAL (no visual change on vertex selection)' : 'DIFFER'} ` +
            `(${beforeBuf.length} vs ${afterBuf.length})`,
        );
      }

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A6: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });
});
