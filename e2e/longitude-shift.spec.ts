// FR-12 回帰ロック — behavioural E2E: the 経度シフト control (U18
// LongitudeShiftControl) is MOUNTED in the live composite and actually moves the
// map center longitude (bughunt2 発見「FR-12 longitude-shift control is implemented
// and unit-tested but never mounted in the live app — feature is user-unreachable」).
//
// The widget existed + passed its unit tests but was only re-exported from the
// map barrel and consumed by its own test — App.tsx never rendered it, so there
// was NO live UI path to change centerLon. The earlier discovery-only bughunt
// spec recorded `lon-control-missing` because the testid was absent everywhere.
//
// This spec closes that死角 with a HARD assertion (it FAILS, not just records, if
// the control is unmounted again): it locks that the control + readout are present
// AND that a real shift button / preset click changes the LIVE camera center
// longitude — read through the SAME observation hook the pan/zoom regression lock
// uses (data-pan-x on the map input layer == the live render-camera centerLon,
// mirrored on every camera change). The control writes the renderer camera (the
// single camera the draw uses), so a shift is a real, user-reachable map move.

import { test, expect } from '@playwright/test';

import { launchApp } from './helpers';

test.describe('FR-12: 経度シフト control is mounted and moves the live camera', () => {
  test('the longitude-shift control + readout are present in the live app', async () => {
    const { app, page } = await launchApp();
    try {
      // The control is mounted in the上部バー / menu-bar row (relocated from the old
      // .map-area__overlay bottom-left panel — A2「経度シフトを上部表示に」). Regression
      // lock: it was user-unreachable before — no testid anywhere in the running app.
      const control = page.getByTestId('longitude-shift');
      await expect(control).toBeAttached();
      const readout = page.getByTestId('center-lon-readout');
      await expect(readout).toBeAttached();
      // The readout shows a real center-longitude string (boots prime-meridian
      // centered: "中心経度: 0°"), never blank / NaN.
      await expect(readout).toContainText('中心経度');
      await expect(readout).not.toContainText('NaN');
    } finally {
      await app.close();
    }
  });

  test('a shift button click moves the live camera center longitude', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      await expect(inputLayer).toBeAttached();
      // data-pan-x mirrors the live render-camera centerLon (publishCameraHooks);
      // wait for the baseline seeded on mount.
      await expect(inputLayer).toHaveAttribute('data-pan-x', /.+/);
      const beforeLon = Number(await inputLayer.getAttribute('data-pan-x'));
      expect(Number.isFinite(beforeLon)).toBe(true);

      // A real ▶ (右へシフト) click shifts the continuous center east. The control
      // writes the renderer camera, which mirrors centerLon back into the hook.
      await page.getByRole('button', { name: '右へシフト' }).click();

      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .not.toBe(beforeLon);
      const afterLon = Number(await inputLayer.getAttribute('data-pan-x'));
      expect(Number.isFinite(afterLon)).toBe(true);

      // The ◀ (左へシフト) button reverses the direction (op∘逆op trends back).
      await page.getByRole('button', { name: '左へシフト' }).click();
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .toBeLessThan(afterLon);
    } finally {
      await app.close();
    }
  });

  test('the 180度中心 preset jumps the center longitude to 180°', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      const readout = page.getByTestId('center-lon-readout');
      await expect(inputLayer).toHaveAttribute('data-pan-x', /.+/);

      // The Pacific-centered preset sets the continuous center to 180°.
      await page.getByRole('button', { name: '180度中心', exact: true }).click();
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .toBeCloseTo(180, 3);
      // The readout folds the seam: continuous 180 reads canonically as "180°".
      await expect(readout).toContainText('180°');

      // The 0度中心 preset returns it to 0° (metamorphic round-trip).
      await page.getByRole('button', { name: '0度中心', exact: true }).click();
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .toBeCloseTo(0, 3);
      await expect(readout).toContainText('中心経度: 0°');
    } finally {
      await app.close();
    }
  });

  test('絶対経度入力 jumps the center to the typed longitude (HB3-1 裁定 2026-08-06)', async () => {
    const { app, page } = await launchApp();
    try {
      const inputLayer = page.getByTestId('map-input-layer');
      const readout = page.getByTestId('center-lon-readout');
      await expect(inputLayer).toHaveAttribute('data-pan-x', /.+/);

      // Type an absolute longitude and commit with the 移動 button: the live camera
      // center jumps to exactly that longitude (same writeCamera path as a preset).
      const absolute = page.getByTestId('center-lon-absolute-input');
      await absolute.fill('90');
      await page.getByRole('button', { name: '指定経度へ移動' }).click();
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .toBeCloseTo(90, 3);
      await expect(readout).toContainText('90°E');
      // The draft clears after the jump — the readout stays the only truth.
      await expect(absolute).toHaveValue('');

      // Enter commits too, and an out-of-range value folds through the seam
      // (250 → 110°W) rather than rejecting or over-rotating.
      await absolute.fill('250');
      await absolute.press('Enter');
      await expect
        .poll(async () => Number(await inputLayer.getAttribute('data-pan-x')))
        .toBeCloseTo(-110, 3);
      await expect(readout).toContainText('110°W');
    } finally {
      await app.close();
    }
  });
});
