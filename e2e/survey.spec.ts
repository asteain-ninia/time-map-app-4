// U37 — 測量モード (FR-14 / FR-15 / FR-16) behavioural E2E.
//
// Drives the REAL built composite (Electron + the live renderer) with real
// pointer clicks and observes BOTH the DOM (readout testids) and the ACTUAL
// RENDER via the window.__E2E__ frame hook (per-frame primitive counts — the
// survey lines are the only `line`-kind primitives in an empty project, so the
// count is an exact mirror of the drawn survey layer). It locks:
//   - 測量 ON → 2 clicks → BOTH distances (正距円筒 + 大円) and BOTH coordinate
//     forms (度分秒 + 十進) are displayed (FR-14 / FR-16);
//   - 測量 OFF keeps the confirmed line DRAWN (FR-15 — the named U37 §6 pitfall:
//     解除はドラフトのみ破棄) — this is exactly the regression a shared
//     tool-overlay slot would break silently (仕様書 §3);
//   - Escape / a mode switch discard the DRAFT ONLY (確定線は残る);
//   - クリア erases every line (the ONLY line-emptying path);
//   - a world-seam pair (+179° ↔ −179°) measures the SHORT way round (~2°), not
//     the 358° detour, and draws ONE un-split line (2 line primitives: the
//     equirectangular + the great-circle path) — the ±360° seam fold contract.

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

interface PrimitiveCounts {
  handle: number;
  label: number;
  shape: number;
  point: number;
  line: number;
  preview: number;
  hasLivePreview: boolean;
}

/** Read the last-drawn-frame primitive counts off the live __E2E__ render hook. */
async function primitiveCounts(page: Page): Promise<PrimitiveCounts> {
  return page.evaluate(() => {
    const e2e = (
      window as unknown as {
        __E2E__?: { getPrimitiveCounts: () => PrimitiveCounts };
      }
    ).__E2E__;
    if (e2e === undefined) {
      return {
        handle: -1,
        label: -1,
        shape: -1,
        point: -1,
        line: -1,
        preview: -1,
        hasLivePreview: false,
      };
    }
    return e2e.getPrimitiveCounts();
  });
}

/** Wait for the renderer's __E2E__ observation hook to exist (map mounted). */
async function waitForE2EHook(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(
        () => typeof (window as unknown as { __E2E__?: unknown }).__E2E__,
      ),
    )
    .toBe('object');
}

/** Convert a CLIENT screen point to world via the live renderer inverse. */
async function screenToWorld(
  page: Page,
  x: number,
  y: number,
): Promise<{ lon: number; lat: number }> {
  const world = await page.evaluate(
    ([cx, cy]) => {
      const e2e = (
        window as unknown as {
          __E2E__?: {
            screenToWorld: (
              a: number,
              b: number,
            ) => { lon: number; lat: number } | null;
          };
        }
      ).__E2E__;
      return e2e?.screenToWorld(cx!, cy!) ?? null;
    },
    [x, y],
  );
  expect(world).not.toBeNull();
  return world!;
}

/** Parse `… 1,234.56 km` into a number (km). */
function parseKm(text: string | null): number {
  const m = /([\d,]+\.\d{2})\s*km/.exec(text ?? '');
  expect(m, `distance text should contain a km value: ${String(text)}`).not.toBeNull();
  return Number(m![1]!.replace(/,/g, ''));
}

/** Parse a `北緯 12.345678° / 東経 23.456789°` decimal readout into signed degrees. */
function parseDecimalCoord(text: string | null): { lat: number; lon: number } {
  const m = /(北緯|南緯)\s*([\d.]+)°\s*\/\s*(東経|西経)\s*([\d.]+)°/.exec(text ?? '');
  expect(m, `decimal coord text should parse: ${String(text)}`).not.toBeNull();
  const lat = Number(m![2]!) * (m![1] === '南緯' ? -1 : 1);
  const lon = Number(m![4]!) * (m![3] === '西経' ? -1 : 1);
  return { lat, lon };
}

/** Enable 測量モード via the topBar toggle and wait for the input bridge. */
async function enableSurvey(page: Page): Promise<void> {
  const toggle = page.getByTestId('survey-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('survey-input-layer')).toBeVisible();
}

test.describe('U37 — 測量モード結線 (FR-14 / FR-15 / FR-16)', () => {
  test('測量 ON→2点で両距離+両形式 / OFF で線残存 / Esc・mode切替はドラフトのみ / クリアで全消去', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);

      // Baseline: an empty project draws no `line` primitives.
      const base = await primitiveCounts(page);
      expect(base.line).toBe(0);

      // ---- 測量 ON (View モードのまま — 補助モードは editable でゲートされない).
      await enableSurvey(page);
      await expect(page.getByTestId('survey-guide')).toContainText('始点');

      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      expect(box).not.toBeNull();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      // ---- 2 clicks confirm ONE line (FR-14).
      await page.mouse.click(cx - 100, cy - 60);
      await expect(page.getByTestId('survey-guide')).toContainText('終点');
      await page.mouse.click(cx + 100, cy + 60);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // BOTH coordinate forms for both endpoints (FR-16 度分秒+十進, default=両方).
      await expect(page.getByTestId('survey-start-dms')).toContainText('″');
      await expect(page.getByTestId('survey-start-decimal')).toContainText('°');
      await expect(page.getByTestId('survey-end-dms')).toContainText('″');
      await expect(page.getByTestId('survey-end-decimal')).toContainText('°');

      // BOTH distances are shown (FR-14) and the equirectangular one is CONSISTENT
      // with the DISPLAYED endpoints under the default geo params (equator 40075 km,
      // flattening 0 → 111.319 km/deg on both axes): the readout's coordinates and
      // its distance describe the SAME measurement (FR-14↔FR-16 の単一真実源).
      // (Expected is not derived from re-projected screen positions: the topBar
      // readout appearing can resize the map cell and re-clamp the camera, so the
      // click-time transform is not re-observable afterwards.)
      const start = parseDecimalCoord(
        await page.getByTestId('survey-start-decimal').textContent(),
      );
      const end = parseDecimalCoord(
        await page.getByTestId('survey-end-decimal').textContent(),
      );
      const kmPerDeg = 40075 / 360;
      // Shortest seam-side longitude delta: fold (end-start) into [-180, 180).
      const dLonShort = Math.abs(((end.lon - start.lon + 540) % 360) - 180);
      const expectedEqKm = kmPerDeg * Math.hypot(dLonShort, end.lat - start.lat);
      const eqKm = parseKm(
        await page.getByTestId('survey-eq-distance').textContent(),
      );
      expect(Math.abs(eqKm - expectedEqKm)).toBeLessThan(0.5);
      const gcKm = parseKm(await page.getByTestId('survey-gc-distance').textContent());
      expect(gcKm).toBeGreaterThan(0);
      // The format switch narrows the display (UI-local, FR-16 切替).
      await page.getByTestId('survey-format-dms').click();
      await expect(page.getByTestId('survey-start-decimal')).toHaveCount(0);
      await page.getByTestId('survey-format-both').click();
      await expect(page.getByTestId('survey-start-decimal')).toBeVisible();

      // The ACTUAL RENDER carries the survey layer: 1 confirmed line = the
      // equirectangular + great-circle line primitives + 2 endpoint markers.
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(2);
      expect((await primitiveCounts(page)).point).toBe(2);

      // ---- 測量 OFF: the line STAYS drawn (FR-15) and the bridge unmounts.
      await page.getByTestId('survey-toggle').click();
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(page.getByTestId('survey-input-layer')).toHaveCount(0);
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(2);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // ---- ON again → another line (confirmed lines accumulate, FR-15).
      await enableSurvey(page);
      await page.mouse.click(cx - 40, cy + 90);
      await page.mouse.click(cx + 40, cy - 90);
      await expect(page.getByTestId('survey-line-count')).toHaveText('2');
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(4);

      // ---- Escape discards the DRAFT ONLY (確定線は残る, U37 §4.2).
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('survey-guide')).toContainText('終点');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('survey-guide')).toContainText('始点');
      await expect(page.getByTestId('survey-line-count')).toHaveText('2');

      // ---- A mode switch (View → Edit) discards the DRAFT ONLY; survey stays
      // active (別軸の補助モード) and the confirmed lines survive (仕様書 §7).
      await page.mouse.click(cx - 10, cy - 10);
      await expect(page.getByTestId('survey-guide')).toContainText('終点');
      await page.getByTestId('mode-view').click(); // leave 表示専用 → 編集モード
      await expect(page.getByTestId('survey-guide')).toContainText('始点');
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByTestId('survey-line-count')).toHaveText('2');
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(4);

      // ---- クリア erases EVERYTHING (the only line-emptying path, FR-15).
      await page.getByTestId('survey-clear').click();
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(0);
      await expect(page.getByTestId('survey-readout')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  // ---- survey レビュー修正 F1/F2/F4 の回帰ロック ------------------------------

  test('F1: 測量ON中の左ドラッグはパンとして生きる（カメラが動き、クリック確定しない）', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);

      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      // The live camera mirrors on the map input layer (HB-1 観測フック).
      const mapLayer = page.getByTestId('map-input-layer');
      const before = {
        panX: await mapLayer.getAttribute('data-pan-x'),
        panY: await mapLayer.getAttribute('data-pan-y'),
      };

      // A REAL left drag across the survey bridge (well past the click threshold).
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 160, cy + 90, { steps: 8 });
      await page.mouse.up();

      // The camera moved (the drag was delegated to the ONE dispatcher pan path)…
      await expect
        .poll(async () => ({
          panX: await mapLayer.getAttribute('data-pan-x'),
          panY: await mapLayer.getAttribute('data-pan-y'),
        }))
        .not.toEqual(before);
      // …and the gesture confirmed NOTHING (no start point, no line — 教訓 5.8).
      await expect(page.getByTestId('survey-guide')).toContainText('始点');
      await expect(page.getByTestId('survey-line-count')).toHaveText('0');
    } finally {
      await app.close();
    }
  });

  test('F2: 測量ON中の右クリックはカスタムメニューのみ（ネイティブ抑止）', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);

      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      await page.mouse.click(cx, cy, { button: 'right' });
      // The FR-96 custom menu opened (survey forwards the right press to the SAME
      // dispatcher; no draft is in progress, so the suspended gate is open).
      await expect(page.getByTestId('context-menu')).toBeVisible();
      // The menu owns Escape (fr96): close it and the survey layer is still live.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('context-menu')).toHaveCount(0);
      await expect(page.getByTestId('survey-input-layer')).toBeVisible();

      // NATIVE suppression (F2 regression lock): a contextmenu event dispatched at
      // the survey BRIDGE is default-prevented by its own handler (the real click's
      // contextmenu lands on the just-opened menu element, so the bridge handler is
      // asserted directly — dispatchEvent returns false iff preventDefault ran).
      const prevented = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="survey-input-layer"]');
        if (el === null) return null;
        const ev = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        });
        return !el.dispatchEvent(ev);
      });
      expect(prevented).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('F4: ドラフト中に編集ツールを選ぶと survey が disable され入力レイヤが片付く', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);

      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      // One CONFIRMED line first (it must survive the disable — FR-15).
      await page.mouse.click(cx - 80, cy - 40);
      await page.mouse.click(cx + 80, cy + 40);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(2);

      // Leave 表示専用 → 編集モード (mode switch cancels the DRAFT only; survey stays).
      await page.getByTestId('mode-view').click();
      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');

      // Start a DRAFT, then arm an edit tool: the reset契約 disables survey — the
      // bridge unmounts (the edit tool's own bridge is the only input layer) and the
      // confirmed line stays drawn (draft 破棄・確定線 保持).
      await page.mouse.click(cx - 10, cy - 10);
      await expect(page.getByTestId('survey-guide')).toContainText('終点');
      await page.getByTestId('tool-edit.knife').click();

      await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('survey-input-layer')).toHaveCount(0);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(2);
    } finally {
      await app.close();
    }
  });

  test('世界端跨ぎ (+179°↔−179°) は最短側で測られ、線が分断しない', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);
      await enableSurvey(page);

      const box = (await page.getByTestId('survey-input-layer').boundingBox())!;
      expect(box).not.toBeNull();
      const cy = box.y + box.height / 2;
      const xLeft = box.x + 2;
      const xRight = box.x + box.width - 2;

      // Solve the screen x for lon = ±179° by linear interpolation over the live
      // equirectangular transform (sampled through the SAME renderer inverse).
      const wl = await screenToWorld(page, xLeft, cy);
      const wr = await screenToWorld(page, xRight, cy);
      expect(wr.lon).toBeGreaterThan(wl.lon);
      const xForLon = (lon: number): number =>
        xLeft + ((lon - wl.lon) / (wr.lon - wl.lon)) * (xRight - xLeft);
      const xWest = xForLon(-179);
      const xEast = xForLon(179);
      expect(xWest).toBeGreaterThan(box.x);
      expect(xEast).toBeLessThan(box.x + box.width);

      await page.mouse.click(xEast, cy);
      await page.mouse.click(xWest, cy);
      await expect(page.getByTestId('survey-line-count')).toHaveText('1');

      // The SHORT way round: ~2° ≈ 222 km (±click resolution), NEVER the ~39,600 km
      // detour — the ±360° seam fold reached the display (FR-14 / U04 wrap契約).
      const eqKm = parseKm(await page.getByTestId('survey-eq-distance').textContent());
      expect(eqKm).toBeLessThan(1500);
      expect(eqKm).toBeGreaterThan(50);
      const gcKm = parseKm(await page.getByTestId('survey-gc-distance').textContent());
      expect(gcKm).toBeLessThan(1500);

      // ONE un-split line: exactly the 2 line primitives (equirectangular +
      // great-circle) — a seam-split line would surface as extra primitives.
      await expect.poll(async () => (await primitiveCounts(page)).line).toBe(2);
      expect((await primitiveCounts(page)).point).toBe(2);
    } finally {
      await app.close();
    }
  });
});
