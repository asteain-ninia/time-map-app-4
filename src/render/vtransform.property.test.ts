// VTransform property tests (U17, NFR 5.8): the invariants the acceptance
// criteria name — round-trip identity (受け入れ基準 1), equirectangular linearity
// (1), cursor-center zoom (2), clamp (2), finiteness under extreme continuous
// longitudes (1), and the seam-tiling coverage (1).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ZOOM_RANGE } from './camera';
import {
  cameraArb,
  continuousLonArb,
  screenPointInArb,
  viewportArb,
  worldPointArb,
} from './arbitraries';
import {
  fitWorldZoom,
  screenToWorld,
  worldToScreen,
  wrapTurnsForViewport,
  zoomAtCursor,
} from './vtransform';

describe('property: round-trip identity (受け入れ基準 1)', () => {
  it('world → screen → world is the identity', () => {
    fc.assert(
      fc.property(cameraArb(), viewportArb(), worldPointArb(), (camera, vp, world) => {
        const back = screenToWorld(worldToScreen(world, camera, vp), camera, vp);
        expect(back.lon).toBeCloseTo(world.lon, 4);
        expect(back.lat).toBeCloseTo(world.lat, 6);
      }),
    );
  });

  it('screen → world → screen is the identity', () => {
    fc.assert(
      fc.property(cameraArb(), viewportArb(), (camera, vp) => {
        fc.assert(
          fc.property(screenPointInArb(vp), (screen) => {
            const back = worldToScreen(screenToWorld(screen, camera, vp), camera, vp);
            expect(back.x).toBeCloseTo(screen.x, 4);
            expect(back.y).toBeCloseTo(screen.y, 4);
          }),
          { numRuns: 20 },
        );
      }),
    );
  });
});

describe('property: equirectangular linearity (受け入れ基準 1)', () => {
  it('equal longitude steps produce equal screen-x steps at the same scale', () => {
    fc.assert(
      fc.property(
        cameraArb(),
        viewportArb(),
        continuousLonArb(),
        fc.double({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true }),
        (camera, vp, lon0, step) => {
          const lat = 0;
          const s0 = worldToScreen({ lon: lon0, lat }, camera, vp);
          const s1 = worldToScreen({ lon: lon0 + step, lat }, camera, vp);
          const s2 = worldToScreen({ lon: lon0 + 2 * step, lat }, camera, vp);
          // Two equal lon steps ⇒ two equal screen-x deltas.
          expect(s1.x - s0.x).toBeCloseTo(s2.x - s1.x, 4);
          // The x-scale equals the zoom (px per degree); y is unchanged by lon.
          expect(s1.x - s0.x).toBeCloseTo(step * camera.zoom, 3);
          expect(s1.y).toBeCloseTo(s0.y, 6);
        },
      ),
    );
  });
});

describe('property: finiteness under extreme continuous longitude (受け入れ基準 1)', () => {
  it('never yields NaN/Infinity for finite inputs, including far-wound longitudes', () => {
    fc.assert(
      fc.property(cameraArb(), viewportArb(), worldPointArb(), (camera, vp, world) => {
        const s = worldToScreen(world, camera, vp);
        const w = screenToWorld(s, camera, vp);
        expect(Number.isFinite(s.x)).toBe(true);
        expect(Number.isFinite(s.y)).toBe(true);
        expect(Number.isFinite(w.lon)).toBe(true);
        expect(Number.isFinite(w.lat)).toBe(true);
      }),
    );
  });
});

describe('property: cursor-anchored zoom (受け入れ基準 2)', () => {
  it('keeps the pre-zoom cursor world point under the cursor after zoom', () => {
    fc.assert(
      fc.property(
        cameraArb(),
        viewportArb(),
        (camera, vp) => {
          fc.assert(
            fc.property(
              screenPointInArb(vp),
              fc.double({ min: 0.05, max: 5000, noNaN: true, noDefaultInfinity: true }),
              (cursor, targetZoom) => {
                const worldBefore = screenToWorld(cursor, camera, vp);
                const next = zoomAtCursor(camera, vp, cursor, targetZoom);
                const screenAfter = worldToScreen(worldBefore, next, vp);
                // Tolerance scales with the (large) coordinate magnitudes involved.
                expect(screenAfter.x).toBeCloseTo(cursor.x, 2);
                expect(screenAfter.y).toBeCloseTo(cursor.y, 2);
              },
            ),
            { numRuns: 15 },
          );
        },
      ),
    );
  });

  it('always clamps zoom into the supplied range', () => {
    fc.assert(
      fc.property(
        cameraArb(),
        viewportArb(),
        fc.double({ min: -1e4, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (camera, vp, target) => {
          fc.assert(
            fc.property(screenPointInArb(vp), (cursor) => {
              const next = zoomAtCursor(camera, vp, cursor, target, DEFAULT_ZOOM_RANGE);
              expect(next.zoom).toBeGreaterThanOrEqual(DEFAULT_ZOOM_RANGE.minZoom);
              expect(next.zoom).toBeLessThanOrEqual(DEFAULT_ZOOM_RANGE.maxZoom);
            }),
            { numRuns: 10 },
          );
        },
      ),
    );
  });
});

describe('property: seam tiling covers the viewport (受け入れ基準 1)', () => {
  it('the union of replica spans covers [leftLon, rightLon] with no gap', () => {
    fc.assert(
      fc.property(cameraArb(), viewportArb(), (camera, vp) => {
        const turns = wrapTurnsForViewport(camera, vp);
        // At least one turn, contiguous integers.
        expect(turns.length).toBeGreaterThanOrEqual(1);
        for (let i = 1; i < turns.length; i += 1) {
          expect(turns[i]! - turns[i - 1]!).toBe(1);
        }
        // Each replica r covers world longitudes [-180 + 360r, 180 + 360r). The
        // union over the returned turns must cover the viewport's longitude span.
        const leftLon = screenToWorld({ x: 0, y: 0 }, camera, vp).lon;
        const rightLon = screenToWorld({ x: vp.widthCss, y: 0 }, camera, vp).lon;
        const minTurn = turns[0]!;
        const maxTurn = turns[turns.length - 1]!;
        expect(-180 + 360 * minTurn).toBeLessThanOrEqual(leftLon + 1e-6);
        expect(180 + 360 * maxTurn).toBeGreaterThanOrEqual(rightLon - 1e-6);
      }),
    );
  });
});

describe('property: fit-all zoom contains the world (受け入れ基準 4)', () => {
  it('fits 360°×180° without overflow for any viewport', () => {
    fc.assert(
      fc.property(viewportArb(), (vp) => {
        const z = fitWorldZoom(vp);
        expect(360 * z).toBeLessThanOrEqual(vp.widthCss + 1e-6);
        expect(180 * z).toBeLessThanOrEqual(vp.heightCss + 1e-6);
        // Not needlessly small: at least one axis is exactly filled.
        const fillsWidth = Math.abs(360 * z - vp.widthCss) < 1e-6;
        const fillsHeight = Math.abs(180 * z - vp.heightCss) < 1e-6;
        expect(fillsWidth || fillsHeight).toBe(true);
      }),
    );
  });
});
