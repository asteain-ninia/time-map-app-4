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

// --- PIXEL PROBING without the tainted-canvas risk (A7〜A9) -------------------
//
// `sampleHandleColors` above reads the LIVE canvas through `getImageData`, which an
// Electron file:// base-map image can TAINT (it already carries a
// `getImageData-failed` fallback). The A7〜A9 cuts must ASSERT on pixels, not merely
// record them, so they take a Playwright screenshot of the probe rectangle instead
// and decode that PNG through a `data:` URL (same-origin ⇒ never tainted) in a
// throw-away canvas. Same pixels the user sees, no tainting failure mode.
interface Clip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function clipAround(x: number, y: number, size: number): Clip {
  return {
    x: Math.round(x - size / 2),
    y: Math.round(y - size / 2),
    width: size,
    height: size,
  };
}

async function meanRgb(page: Page, clip: Clip): Promise<Rgb> {
  const buf = await page.screenshot({ clip });
  const decoded = await page.evaluate(async (data: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i] ?? 0;
      g += px[i + 1] ?? 0;
      b += px[i + 2] ?? 0;
    }
    return { r: r / n, g: g / n, b: b / n };
  }, buf.toString('base64'));
  if (decoded === null) throw new Error('meanRgb: no 2d context for the decode canvas');
  return decoded;
}

/**
 * The FR-90 対象面強調 is amber (`targetFill` rgba(255,193,7,.30) + `targetStroke`
 * #ffc107) composited OVER whatever is already there, so it always pushes RED up and
 * BLUE down: `r - b` is a monotone「琥珀っぽさ」score for a probe rectangle. Absolute
 * values depend on the underlying paint, so every assertion below compares the SAME
 * rectangle across two states (emphasis on / off) — the base cancels, the amber does not.
 */
function amberScore(c: Rgb): number {
  return c.r - c.b;
}

async function probeAmber(page: Page, x: number, y: number, size: number): Promise<number> {
  return amberScore(await meanRgb(page, clipAround(x, y, size)));
}

// --- live display-pipeline observation ---------------------------------------
async function waitForE2E(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => typeof (window as unknown as { __E2E__?: unknown }).__E2E__),
    )
    .toBe('object');
}
async function drawnFeatureIds(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getDrawnFeatureFills: () => Record<string, string> };
    }).__E2E__;
    return e2e === undefined ? [] : Object.keys(e2e.getDrawnFeatureFills());
  });
}
async function vertexHandleWorldPositions(
  page: Page,
): Promise<readonly { readonly lon: number; readonly lat: number }[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => readonly { lon: number; lat: number }[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

/** Arm 追加モード + 面ツール deterministically (reset-then-arm — a prior commit may leave it pressed). */
async function armAddArea(page: Page): Promise<void> {
  await leaveView(page);
  const add = page.getByTestId('mode-add');
  await expect(add).toBeEnabled();
  if ((await add.getAttribute('aria-pressed')) !== 'true') await add.click();
  await expect(add).toHaveAttribute('aria-pressed', 'true');
  const area = page.getByTestId('tool-add.area');
  await expect(area).toBeVisible();
  if ((await area.getAttribute('aria-pressed')) === 'true') await area.click();
  await area.click();
  await expect(area).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('add-input-layer')).toBeVisible();
}

/**
 * Commit ONE 面 through the LIVE add 導線, optionally choosing a 上位領域 (parent) in the
 * property form — the ONLY real 導線 that builds a hierarchy (FR-36 親→集約 + FR-37 直轄領
 * 自動生成). Returns the committed feature id.
 */
async function commitFace(
  page: Page,
  corners: ReadonlyArray<readonly [number, number]>,
  parentIndex?: number,
): Promise<string> {
  await armAddArea(page);
  for (const [px, py] of corners) await page.mouse.click(px, py);
  await expect(page.getByTestId('add-vertex-count')).toHaveText(String(corners.length));
  await page.getByTestId('add-complete').click();
  if (parentIndex !== undefined) {
    const parentSelect = page.getByTestId('add-parent');
    await expect(parentSelect).toBeVisible();
    await parentSelect.selectOption({ index: parentIndex });
  }
  await page.getByTestId('add-save').click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
  return activeFeature(page);
}

/** Jump the time cursor to a precise year through the 直接ジャンプ field (FR-70 導線). */
async function jumpToYear(page: Page, year: number): Promise<void> {
  await page.getByLabel('直接ジャンプ 年', { exact: true }).fill(String(year));
  await page.getByRole('button', { name: 'ジャンプ', exact: true }).click();
  await expect(page.getByTestId('timeline-current')).toHaveText(`${year}年`);
}

/** The live knife flow (`data-flow`), or '' when the chrome is not mounted. */
async function knifeFlow(page: Page): Promise<string> {
  const tool = page.getByTestId('knife-tool');
  if ((await tool.count()) === 0) return '';
  return (await tool.getAttribute('data-flow')) ?? '';
}

/** Reveal the 一覧 tab (the FR-113 表示制御フィルタ panel lives there). */
async function revealFilterPanel(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await expect(page.getByTestId('display-filter')).toBeVisible();
}

/**
 * Close any open FR-112 tooltip bubble before touching the toolbar. A toolbar button
 * keeps FOCUS after a click, and the shell `Tooltip` opens on focus as well as hover —
 * the open bubble then overlays the NEIGHBOURING tool button and swallows its pointer
 * events. Blurring + parking the cursor over the map is the same thing a user does by
 * moving the mouse; it changes no app state (no button is down).
 */
async function dismissTooltips(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const b = await page.getByTestId('map-input-layer').boundingBox();
  if (b !== null) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator('.tooltip__bubble:not([hidden])')).toHaveCount(0);
}

/**
 * Assert the W3-B cancel 規約 for ONE tool: キャンセル (button and/or Escape) releases the
 * TOOL as well, so the toolbar button un-presses and pressing the SAME button re-arms.
 * Before the fix the button stayed `aria-pressed=true` with the session disarmed, and the
 * next press ran the store's press-toggle (tool → null) instead of re-arming.
 */
async function assertCancelReArms(
  page: Page,
  tool: string,
  chromeTestId: string,
  cancelTestId: string | null,
): Promise<void> {
  const button = page.getByTestId(`tool-edit.${tool}`);
  const chrome = page.getByTestId(chromeTestId);

  await enterEditMode(page);
  await dismissTooltips(page);
  await expect(button).toBeVisible();
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(chrome).toBeVisible();

  if (cancelTestId !== null) {
    await page.getByTestId(cancelTestId).click();
    await page.waitForTimeout(250);
    const goneByButton = (await chrome.count()) === 0;
    const pressedByButton = (await button.getAttribute('aria-pressed')) === 'true';
    record(
      `${tool}-cancel-button`,
      `chrome gone=${goneByButton} toolbar aria-pressed=${pressedByButton}`,
    );
    expect(goneByButton, `${cancelTestId} must drop the ${tool} chrome`).toBe(true);
    expect(pressedByButton, `${cancelTestId} must release tool-edit.${tool}`).toBe(false);

    await dismissTooltips(page);
    await button.click();
    await page.waitForTimeout(250);
    const revivedByButton = (await chrome.count()) > 0;
    record(`${tool}-rearm-button`, `same-button re-press revived=${revivedByButton}`);
    expect(
      revivedByButton,
      `pressing tool-edit.${tool} again after キャンセル must RE-ARM it`,
    ).toBe(true);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  // Escape path — the SAME 契約 (the tool controllers funnel Escape into cancel()).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const goneByEsc = (await chrome.count()) === 0;
  const pressedByEsc = (await button.getAttribute('aria-pressed')) === 'true';
  record(`${tool}-cancel-escape`, `chrome gone=${goneByEsc} toolbar aria-pressed=${pressedByEsc}`);
  expect(goneByEsc, `Escape must drop the ${tool} chrome`).toBe(true);
  expect(pressedByEsc, `Escape must release tool-edit.${tool}`).toBe(false);

  await dismissTooltips(page);
  await button.click();
  await page.waitForTimeout(250);
  const revivedByEsc = (await chrome.count()) > 0;
  record(`${tool}-rearm-escape`, `same-button re-press after Escape revived=${revivedByEsc}`);
  expect(revivedByEsc, `pressing tool-edit.${tool} again after Escape must RE-ARM it`).toBe(true);

  // Leave the tool disarmed for the next case (Escape, then confirm it is off).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
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

  // ===========================================================================
  // A7 — W3-A 実機確認: 集約表示 (globalDepth=0) × ナイフ
  //
  // 従来の欠陥: ナイフだけが対象取得を表示解決 (`drawnAreaAt`) で行い、強調は生リーフ
  // (`leafShapeAt`) で解決していた二重真実源。既定の集約表示では
  //   - FR-35 の真の集約体 → leafShapeAt が undefined ⇒ 強調ゼロ
  //   - FR-37 直轄領構成 → 丸め先の親 id ⇒ クリックした場所と「別の場所」が光る
  // この cut は実機導線で階層 (親 + 子 = 直轄領が生成される親付け) を作り、N=0 の集約
  // 表示のままナイフで子の位置をクリックし、「クリックした場所」が光ることを
  // DOM (取得 id / flow) と画素 (琥珀スコア) の両方で固定する。
  // ===========================================================================
  test('A7 集約表示(N=0)でナイフが子をクリック → クリックした場所の形が強調される', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      record('a7-map-box', JSON.stringify(box));
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      // Two DISJOINT squares: 親 on the left, 子 on the right. Parenting the 子 to the 親
      // promotes the 親 to a 集約 (FR-36) and auto-generates a 直轄領 for the 親's own
      // footprint (FR-37) — exactly the構成 that used to light up the WRONG place.
      const half = 70;
      const pcx = cx - 200;
      const ccx = cx + 150;
      const square = (sx: number, sy: number): ReadonlyArray<readonly [number, number]> => [
        [sx - half, sy - half],
        [sx + half, sy - half],
        [sx + half, sy + half],
        [sx - half, sy + half],
      ];
      const parentCorners = square(pcx, cy);
      const childCorners = square(ccx, cy);
      assertClickable(box, [...parentCorners, ...childCorners, [pcx, cy], [ccx, cy]], {
        avoidTopChrome: true,
        name: 'a7-hierarchy',
      });

      const parentId = await commitFace(page, parentCorners);
      // index 1 = the only real parent candidate (index 0 = 親なし).
      const childId = await commitFace(page, childCorners, 1);
      record('a7-hierarchy', `parentId="${parentId}" childId="${childId}"`);
      expect(childId).not.toBe('');
      expect(childId).not.toBe(parentId);

      // --- The scene really IS 集約表示 at the default depth ---------------------
      await expect(page.getByTestId('global-depth-readout')).toContainText('階層深度: 0');
      const drawnAtZero = await drawnFeatureIds(page);
      await page.getByRole('button', { name: '階層深度を上げる' }).click();
      await expect(page.getByTestId('global-depth-readout')).toContainText('階層深度: 1');
      const drawnAtOne = await drawnFeatureIds(page);
      await page.getByRole('button', { name: '階層深度を下げる' }).click();
      await expect(page.getByTestId('global-depth-readout')).toContainText('階層深度: 0');
      record(
        'a7-aggregation',
        `N=0 drawn=${JSON.stringify(drawnAtZero)} / N=1 drawn=${JSON.stringify(drawnAtOne)}`,
      );
      // N=0 rolls the children up: strictly fewer drawn features, and the 子 itself is NOT
      // in the drawn set — the exact state in which the old resolution lit the wrong shape.
      expect(drawnAtOne.length).toBeGreaterThan(drawnAtZero.length);
      expect(drawnAtZero).not.toContain(childId);
      expect(drawnAtOne).toContain(childId);

      // --- Arm the knife at N=0 and take the NO-EMPHASIS baseline --------------
      const armed = await armEditTool(page, 'knife');
      record('a7-knife-armed', `tool-edit.knife pressed=${armed}`);
      expect(armed).toBe(true);
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      expect(await knifeFlow(page)).toBe('selecting-target');
      await page.waitForTimeout(300);
      await shot(page, 'a-19-agg-knife-armed');
      const probeSize = 70;
      const childBefore = await probeAmber(page, ccx, cy, probeSize);
      const parentBefore = await probeAmber(page, pcx, cy, probeSize);
      record('a7-baseline', `child=${childBefore.toFixed(2)} parent=${parentBefore.toFixed(2)}`);

      // --- Click the 子 の位置 (still 集約表示) --------------------------------
      await page.mouse.click(ccx, cy);
      await page.waitForTimeout(400);
      const flowAfter = await knifeFlow(page);
      const acquired = await activeFeature(page);
      record(
        'a7-target',
        `flow=${flowAfter} active-feature="${acquired}" message="${await textOf(page, 'knife-message')}"`,
      );
      // 集約体ではなく「クリック位置の末端リーフ」が取得される (FR-44 は拒否ではなく解決で満たす).
      expect(await textOf(page, 'knife-message')).toBe('');
      expect(flowAfter).toBe('drawing-cut');
      expect(acquired).toBe(childId);

      await page.waitForTimeout(300);
      await shot(page, 'a-20-agg-knife-target');
      const childAfter = await probeAmber(page, ccx, cy, probeSize);
      const parentAfter = await probeAmber(page, pcx, cy, probeSize);
      const dChild = childAfter - childBefore;
      const dParent = parentAfter - parentBefore;
      record(
        'a7-emphasis-pixels',
        `Δamber(child clicked)=${dChild.toFixed(2)} Δamber(parent 直轄領)=${dParent.toFixed(2)} ` +
          `(child ${childBefore.toFixed(2)}→${childAfter.toFixed(2)}, ` +
          `parent ${parentBefore.toFixed(2)}→${parentAfter.toFixed(2)})`,
      );
      // クリックした場所が光る: 琥珀 (255,193,7) の合成で r−b が大きく上がる。
      expect(dChild, 'the CLICKED child shape must gain the amber 対象面強調').toBeGreaterThan(20);
      // 別の場所は光らない: 親(直轄領)側は琥珀を得ない (旧欠陥はここが光っていた)。
      expect(dParent, 'the parent 直轄領 must NOT be emphasized instead').toBeLessThan(8);
      expect(dChild - dParent).toBeGreaterThan(20);

      // Close-ups of both squares in the SAME emphasized frame (視覚証拠).
      await shotClip(page, 'a-21-agg-knife-child-closeup', clipAround(ccx, cy, 200));
      await shotClip(page, 'a-22-agg-knife-parent-closeup', clipAround(pcx, cy, 200));

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A7: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });

  // ===========================================================================
  // A8 — W3-AB 実機確認: 取得済みナイフ対象の強調が「現在時刻の形」へ追随する
  //
  // 欠陥の形: 強調ジオメトリを session state だけで memo 化すると、取得時点の形で
  // FROZEN になる。時間を動かすと「強調されている形」と「確定で実際に切られる形
  // (anchorTime = 現在時刻)」が食い違う。ここでは実機で 2 錨 (年0 の四角 / 年3000 の
  // 左向きスパイク) を作り、年0 で対象取得 → 年3000 へスクラブ → 年3000 でしか
  // 内側にならない probe 点が琥珀を得ることを画素で固定する。
  // ===========================================================================
  test('A8 ナイフ対象取得後にタイムラインをスクラブすると強調が現在時刻の形へ追随する', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const half = 80;
      const scene = placeSquareScene(box, {
        fx: 0.62,
        fy: 0.5,
        half,
        avoidTopChrome: true,
        name: 'a8-face',
      });
      const { cx, cy } = scene;
      const corners: ReadonlyArray<readonly [number, number]> = [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ];
      // The 年3000 spike: the top-left corner dragged 140px LEFT. Probe P sits inside the
      // spike but OUTSIDE the 年0 square; P' mirrors it on the right (outside at BOTH times).
      const dragTo: readonly [number, number] = [cx - half - 140, cy - half];
      const probeIn: readonly [number, number] = [cx - 140, cy - 40];
      const probeOut: readonly [number, number] = [cx + 140, cy - 40];
      assertClickable(box, [...corners, dragTo, probeIn, probeOut, [cx, cy]], {
        avoidTopChrome: true,
        name: 'a8-scene',
      });

      const faceId = await commitFace(page, corners);
      record('a8-face', `faceId="${faceId}"`);
      await jumpToYear(page, 0);

      // --- 年3000 に新しい錨を作る: 頂点を実ドラッグして形を変える ---------------
      await jumpToYear(page, 3000);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await expect.poll(async () => (await vertexHandleWorldPositions(page)).length).toBeGreaterThanOrEqual(4);
      const tlWorld = await s2w(page, cx - half, cy - half);
      expect(tlWorld).not.toBeNull();
      const [sx, sy] = [cx - half, cy - half];
      const [dx, dy] = dragTo;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      for (let i = 1; i <= 6; i += 1) {
        await page.mouse.move(sx + ((dx - sx) * i) / 6, sy + ((dy - sy) * i) / 6);
      }
      await page.mouse.up();
      await page.waitForTimeout(500);
      const atThreeThousand = await vertexHandleWorldPositions(page);
      const stillAtOrigin = (
        handles: readonly { readonly lon: number; readonly lat: number }[],
      ): boolean =>
        handles.some(
          (h) =>
            Math.abs(h.lon - tlWorld!.lon) < 1e-9 && Math.abs(h.lat - tlWorld!.lat) < 1e-9,
        );
      record(
        'a8-anchor-3000',
        `handles=${atThreeThousand.length} originalTopLeftStillPresent=${stillAtOrigin(atThreeThousand)}`,
      );
      expect(stillAtOrigin(atThreeThousand), '年3000 の錨で左上頂点が動いていること').toBe(false);
      await shot(page, 'a-23-time-shape-3000');

      // 年0 へ戻すと ORIGINAL の四角へ戻る = 形が本当に時刻依存 (2 錨) である証拠。
      await jumpToYear(page, 0);
      await page.waitForTimeout(400);
      const atZero = await vertexHandleWorldPositions(page);
      record(
        'a8-anchor-0',
        `handles=${atZero.length} originalTopLeftStillPresent=${stillAtOrigin(atZero)}`,
      );
      expect(stillAtOrigin(atZero), '年0 の錨は元の四角のままであること').toBe(true);
      await shot(page, 'a-24-time-shape-0');

      // --- 年0 でナイフ対象を取得 ------------------------------------------------
      const armed = await armEditTool(page, 'knife');
      expect(armed).toBe(true);
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      expect(await knifeFlow(page)).toBe('selecting-target');
      await page.waitForTimeout(300);
      const size = 40;
      const inBefore0 = await probeAmber(page, probeIn[0], probeIn[1], size);
      const bodyBefore0 = await probeAmber(page, cx, cy, 60);

      await page.mouse.click(cx, cy);
      await page.waitForTimeout(400);
      expect(await knifeFlow(page)).toBe('drawing-cut');
      expect(await activeFeature(page)).toBe(faceId);
      await page.waitForTimeout(300);
      await shot(page, 'a-25-knife-target-year0');
      const inAfter0 = await probeAmber(page, probeIn[0], probeIn[1], size);
      const bodyAfter0 = await probeAmber(page, cx, cy, 60);
      record(
        'a8-year0-emphasis',
        `Δamber(body)=${(bodyAfter0 - bodyBefore0).toFixed(2)} ` +
          `Δamber(spike probe, OUTSIDE the year-0 shape)=${(inAfter0 - inBefore0).toFixed(2)}`,
      );
      expect(bodyAfter0 - bodyBefore0, '年0 の本体は強調される').toBeGreaterThan(20);
      expect(
        inAfter0 - inBefore0,
        '年0 では spike 位置は形の外なので強調されない',
      ).toBeLessThan(8);

      // --- スクラブ: 年3000 へ。対象は保持されたまま、強調は年3000 の形になる -----
      await jumpToYear(page, 3000);
      await page.waitForTimeout(500);
      record(
        'a8-after-scrub',
        `flow=${await knifeFlow(page)} active-feature="${await activeFeature(page)}" ` +
          `message="${await textOf(page, 'knife-message')}"`,
      );
      // 対象は落ちない (年3000 でも有効 = 表示され続けている)。
      expect(await knifeFlow(page)).toBe('drawing-cut');
      expect(await textOf(page, 'knife-message')).toBe('');
      await shot(page, 'a-26-knife-target-year3000');
      const inEmph3000 = await probeAmber(page, probeIn[0], probeIn[1], size);
      const outEmph3000 = await probeAmber(page, probeOut[0], probeOut[1], size);

      // 同一時刻・同一カメラで「強調だけ」を外した参照フレーム: Escape で解除 → 同じ
      // ボタンで再アーム (W3-B) すると 対象選択 = オーバーレイあり・強調なし に戻る。
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const reArmed = await armEditTool(page, 'knife');
      expect(reArmed, 'Escape 後に同じボタンで再アームできること (W3-B)').toBe(true);
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      expect(await knifeFlow(page)).toBe('selecting-target');
      await page.waitForTimeout(400);
      await shot(page, 'a-27-knife-noemphasis-year3000');
      const inPlain3000 = await probeAmber(page, probeIn[0], probeIn[1], size);
      const outPlain3000 = await probeAmber(page, probeOut[0], probeOut[1], size);

      const dIn = inEmph3000 - inPlain3000;
      const dOut = outEmph3000 - outPlain3000;
      record(
        'a8-year3000-emphasis',
        `Δamber(spike probe, INSIDE the year-3000 shape)=${dIn.toFixed(2)} ` +
          `Δamber(mirror probe, outside at BOTH times)=${dOut.toFixed(2)}`,
      );
      // 凍結していれば年3000 でも spike 位置は強調されない (Δ≈0)。追随していれば琥珀が乗る。
      expect(dIn, '年3000 では spike 位置が強調される = 強調が現在時刻の形へ追随した').toBeGreaterThan(20);
      expect(dOut, '両時刻で形の外の対照点は強調されない').toBeLessThan(8);
      expect(dIn - dOut).toBeGreaterThan(20);

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A8: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });

  // ===========================================================================
  // A9 — FR-113 非表示とナイフ対象の一貫性 (取得側 + 保持側) + 段階7 優先規則
  //
  //   (1) 右クリック「この地物を非表示」→ ナイフは その地物を取得できない
  //       (不変条件「非表示地物はツール取得からも消える」の取得側)。
  //   (2) 対象取得済みのナイフ session 中は右クリックメニュー自体が抑止される
  //       (段階7 優先規則 — ドラフト中は競合する編集メニューを開かない)。
  //   (3) 取得後に FR-113 で対象が消える (種別オフ) → 強調が消え、対象選択へ戻り、
  //       KNIFE_TARGET_GONE の日本語ガイドが出る。ツールはアーム状態のまま。
  // ===========================================================================
  test('A9 非表示になった対象はナイフから消え、対象選択へ戻る (KNIFE_TARGET_GONE)', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const half = 90;
      const scene = placeSquareScene(box, {
        fx: 0.5,
        fy: 0.45,
        half,
        avoidTopChrome: true,
        name: 'a9-face',
      });
      const { cx, cy } = scene;
      const faceId = await commitFace(page, [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ]);
      record('a9-face', `faceId="${faceId}"`);
      const drawnWithFace = await drawnFeatureIds(page);
      expect(drawnWithFace).toContain(faceId);

      // --- (1) 右クリック「この地物を非表示」→ ナイフ取得からも消える -------------
      await enterEditMode(page);
      await page.mouse.click(cx, cy, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      const hideItem = menu.locator('[data-item-kind="hideFeature"]');
      await expect(hideItem).toHaveText('この地物を非表示');
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);
      await shot(page, 'a-28-contextmenu-hide');
      await hideItem.click();
      await expect(menu).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect.poll(async () => drawnFeatureIds(page)).not.toContain(faceId);

      const armed = await armEditTool(page, 'knife');
      expect(armed).toBe(true);
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(400);
      record(
        'a9-hidden-not-targetable',
        `flow=${await knifeFlow(page)} active-feature="${await activeFeature(page)}"`,
      );
      expect(await knifeFlow(page)).toBe('selecting-target');
      expect(await activeFeature(page)).toBe('');
      await shot(page, 'a-29-knife-hidden-untargetable');

      // --- 全て再表示 → 取得できる ---------------------------------------------
      await revealFilterPanel(page);
      await page.getByTestId('display-filter-show-all').click();
      await expect.poll(async () => drawnFeatureIds(page)).toContain(faceId);
      await page.waitForTimeout(300);

      const bodyBefore = await probeAmber(page, cx, cy, 80);
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(400);
      expect(await knifeFlow(page)).toBe('drawing-cut');
      expect(await activeFeature(page)).toBe(faceId);
      await page.waitForTimeout(300);
      await shot(page, 'a-30-knife-target-visible');
      const bodyEmphasized = await probeAmber(page, cx, cy, 80);
      record(
        'a9-emphasis-on',
        `Δamber(target)=${(bodyEmphasized - bodyBefore).toFixed(2)}`,
      );
      expect(bodyEmphasized - bodyBefore).toBeGreaterThan(20);

      // --- (2) 段階7 優先規則: ドラフト中の右クリックはメニューを開かない ---------
      await page.mouse.click(cx, cy, { button: 'right' });
      await page.waitForTimeout(400);
      const menuCount = await menu.count();
      record(
        'a9-contextmenu-suspended',
        `right-click during the knife draft opened ${menuCount} menu(s); ` +
          `flow=${await knifeFlow(page)} active-feature="${await activeFeature(page)}"`,
      );
      expect(
        menuCount,
        'ドラフト中の右クリックは競合する編集メニューを開かない (段階7 優先規則)',
      ).toBe(0);
      // ...and the drop was WHOLE: the session's own selection is untouched.
      expect(await knifeFlow(page)).toBe('drawing-cut');
      expect(await activeFeature(page)).toBe(faceId);

      // --- (3) 取得後に FR-113 で対象が消える → 対象選択へ戻る ---------------------
      // 個別非表示と同じ単一の可視判定 (isFeatureVisibleUnderFilter) を、ドラフト中でも
      // 到達できる 種別オフ 経路で駆動する (右クリックは上記のとおり抑止されている)。
      const areaToggle = page.getByTestId('display-filter-kind-area');
      await expect(areaToggle).toBeChecked();
      await areaToggle.uncheck();
      await page.waitForTimeout(600);
      const gone = await textOf(page, 'knife-message');
      record(
        'a9-target-gone',
        `flow=${await knifeFlow(page)} message="${gone}" ` +
          `toolbar aria-pressed=${await page.getByTestId('tool-edit.knife').getAttribute('aria-pressed')}`,
      );
      await shot(page, 'a-31-knife-target-gone');
      expect(await knifeFlow(page)).toBe('selecting-target');
      expect(gone).toContain('表示されなくなった');
      expect(gone).toContain('対象選択に戻りました');
      // キャンセルではない: ツールはアームされたまま、入力ブリッジも生きている。
      await expect(page.getByTestId('tool-edit.knife')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('knife-input-layer')).toBeVisible();
      const bodyAfterGone = await probeAmber(page, cx, cy, 80);
      record(
        'a9-emphasis-off',
        `amber target ${bodyEmphasized.toFixed(2)} → ${bodyAfterGone.toFixed(2)} ` +
          `(baseline ${bodyBefore.toFixed(2)})`,
      );
      expect(
        bodyEmphasized - bodyAfterGone,
        '対象が消えたら琥珀の強調も消える',
      ).toBeGreaterThan(20);

      // 面を戻しても対象は勝手に復活しない (対象選択のまま) が、再クリックで取り直せる。
      await areaToggle.check();
      await page.waitForTimeout(500);
      expect(await knifeFlow(page)).toBe('selecting-target');
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(400);
      record('a9-reacquire', `flow=${await knifeFlow(page)} active="${await activeFeature(page)}"`);
      expect(await knifeFlow(page)).toBe('drawing-cut');
      expect(await activeFeature(page)).toBe(faceId);
      await shot(page, 'a-32-knife-reacquired');

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A9: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });

  // ===========================================================================
  // A10 — W3-B 実機確認: キャンセル → 同一ボタン再押下で再アーム (全ツール共通規約)
  //
  // 旧欠陥: キャンセルは session だけを畳み、toolbar の aria-pressed は true のまま
  // だったので、同じボタンを押すと store の press-toggle (tool → null) が走り、別の
  // ツールを経由しないと復活しなかった。A1 が ring を押さえているので、ここでは
  // 結合 / 所属変更 / ナイフ / 穴あけ を実機で押さえる。
  // ===========================================================================
  test('A10 結合・所属変更・ナイフ・穴あけ: キャンセル後に同じボタンで再アームできる', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    attachListeners(page);
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await waitForE2E(page);
      const box = (await page.getByTestId('map-input-layer').boundingBox())!;
      const half = 90;
      const scene = placeSquareScene(box, {
        fx: 0.5,
        fy: 0.45,
        half,
        avoidTopChrome: true,
        name: 'a10-face',
      });
      const { cx, cy } = scene;
      await commitFace(page, [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ]);
      await enterEditMode(page);

      // 結合 (FR-52) — キャンセルボタン と Escape の両方。
      await assertCancelReArms(page, 'merge', 'merge-tool', 'merge-cancel');
      await shot(page, 'a-33-merge-rearm');
      // 所属変更 (FR-46).
      await assertCancelReArms(page, 'reparent', 'reparent-tool', 'reparent-cancel');
      await shot(page, 'a-34-reparent-rearm');
      // ナイフ (対象選択中は キャンセルボタンが出ないので Escape のみ).
      await assertCancelReArms(page, 'knife', 'knife-tool', null);
      // 穴あけ (FR-45) — ナイフ同様、対象選択中は キャンセルボタンが出ないので Escape のみ.
      await assertCancelReArms(page, 'drill', 'drill-tool', null);
      await shot(page, 'a-35-drill-rearm');

      // eslint-disable-next-line no-console
      console.log(`VISUALA_SUMMARY_A10: ${JSON.stringify(notes)}`);
    } finally {
      await app.close();
    }
  });
});
