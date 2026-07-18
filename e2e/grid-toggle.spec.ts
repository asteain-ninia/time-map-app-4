// FR-13 グリッド（グラティキュール）ON/OFF 切替 behavioural E2E.
//
// Drives the REAL built composite (Electron + the live renderer) and observes the
// ACTUAL RENDER via the window.__E2E__ frame hook (per-frame primitive counts). In an
// EMPTY new project the ONLY `label`-kind primitives are the graticule's lat/lon labels
// (no features ⇒ no feature labels; the base map is a `basemap` primitive), so the label
// count is an exact mirror of whether the grid is drawn. It locks:
//   - 既定 ON: the graticule draws (label > 0) and the topBar toggle is aria-pressed;
//   - OFF: clicking the toggle removes EVERY grid primitive (label → 0, aria-pressed
//     false) — the FR-13 ON/OFF切替 reaching the pixels (明示的空, 教訓 5.18);
//   - ON again: the grid comes back (label > 0).
//
// The toggle → redraw path is the regression this locks: gridVisible feeds the host's
// live getter AND the redraw-on-settings subscription, so a toggle re-composites at once
// (教訓 5.35). Save/load persistence of gridVisible is locked at the UNIT level
// (round-trip.test.ts + ui-settings-bridge.test.ts); the e2e suite deliberately avoids
// native file dialogs (playwright.config.ts).

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** The last-drawn-frame label-primitive count off the live __E2E__ render hook. */
async function labelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e2e = (
      window as unknown as {
        __E2E__?: { getPrimitiveCounts: () => { label: number } };
      }
    ).__E2E__;
    return e2e === undefined ? -1 : e2e.getPrimitiveCounts().label;
  });
}

/** Wait for the renderer's __E2E__ observation hook to exist (map mounted). */
async function waitForE2EHook(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => typeof (window as unknown as { __E2E__?: unknown }).__E2E__),
    )
    .toBe('object');
}

test.describe('FR-13 — グリッド ON/OFF 切替 結線', () => {
  test('既定ONで描画 / トグルOFFでグリッド消滅 / 再ONで復活', async () => {
    const { app, page } = await launchApp();
    try {
      await waitForE2EHook(page);

      const toggle = page.getByTestId('grid-toggle');
      await expect(toggle).toBeVisible();

      // 既定: the grid is visible — graticule labels are drawn, the toggle is pressed.
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => labelCount(page)).toBeGreaterThan(0);

      // OFF: every grid primitive disappears (empty project ⇒ label count → 0).
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => labelCount(page)).toBe(0);

      // ON again: the graticule returns (the toggle round-trips).
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => labelCount(page)).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
