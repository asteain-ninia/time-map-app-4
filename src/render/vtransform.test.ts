// VTransform unit tests (U17): fixed input → expected output for the pure
// world↔screen math, fit-all zoom, cursor-anchored zoom, and seam wrap turns.

import { describe, expect, it } from 'vitest';

import { wrapLonDeg } from '../domain/geo/longitude';

import type { Camera, Viewport, ZoomRange } from './camera';
import { clampZoom, DEFAULT_ZOOM_RANGE } from './camera';
import {
  fitWorldZoom,
  initialCamera,
  representativeCenterLon,
  screenToWorld,
  worldToScreen,
  wrapTurnsForViewport,
  wrapTurnsForLonSpan,
  zoomAtCursor,
  zoomStepAtCursor,
} from './vtransform';

const VP: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAM: Camera = { centerLon: 0, centerLat: 0, zoom: 2 };

describe('worldToScreen', () => {
  it('maps the camera center to the viewport center', () => {
    const s = worldToScreen({ lon: 0, lat: 0 }, CAM, VP);
    expect(s).toEqual({ x: 400, y: 300 });
  });

  it('scales longitude east as +x and latitude north as -y (flip)', () => {
    // +10° lon at zoom 2 = +20px x; +10° lat = -20px y (north is up).
    const s = worldToScreen({ lon: 10, lat: 10 }, CAM, VP);
    expect(s.x).toBeCloseTo(420);
    expect(s.y).toBeCloseTo(280);
  });

  it('uses the raw continuous longitude difference (no ±360 fold)', () => {
    // centerLon 350 (continuous), point at 360 = +10° east of center.
    const cam: Camera = { centerLon: 350, centerLat: 0, zoom: 2 };
    const s = worldToScreen({ lon: 360, lat: 0 }, cam, VP);
    expect(s.x).toBeCloseTo(420);
  });
});

describe('screenToWorld', () => {
  it('is the algebraic inverse at the center', () => {
    expect(screenToWorld({ x: 400, y: 300 }, CAM, VP)).toEqual({ lon: 0, lat: 0 });
  });

  it('round-trips a sample world point exactly enough', () => {
    const w = { lon: 37.5, lat: -12.25 };
    const back = screenToWorld(worldToScreen(w, CAM, VP), CAM, VP);
    expect(back.lon).toBeCloseTo(w.lon, 9);
    expect(back.lat).toBeCloseTo(w.lat, 9);
  });
});

describe('fitWorldZoom (FR-11)', () => {
  it('picks the latitude-limited zoom for a wide viewport', () => {
    // 800/360 = 2.22 vs 600/180 = 3.33 → min = 2.22 (lon-limited here, wide-ish).
    expect(fitWorldZoom(VP)).toBeCloseTo(800 / 360);
  });

  it('picks the longitude-limited zoom for a tall viewport', () => {
    const tall: Viewport = { widthCss: 400, heightCss: 1200, devicePixelRatio: 1 };
    // 400/360 = 1.11 vs 1200/180 = 6.67 → min = 1.11 (lon-limited).
    expect(fitWorldZoom(tall)).toBeCloseTo(400 / 360);
  });

  it('is symmetric for a square viewport (lat is the tighter axis)', () => {
    const sq: Viewport = { widthCss: 720, heightCss: 720, devicePixelRatio: 1 };
    // 720/360 = 2 vs 720/180 = 4 → min = 2.
    expect(fitWorldZoom(sq)).toBeCloseTo(2);
  });

  it('returns 0 for a degenerate (zero / non-finite) viewport', () => {
    expect(fitWorldZoom({ widthCss: 0, heightCss: 600, devicePixelRatio: 1 })).toBe(0);
    expect(fitWorldZoom({ widthCss: 800, heightCss: 0, devicePixelRatio: 1 })).toBe(0);
    expect(
      fitWorldZoom({ widthCss: Number.NaN, heightCss: 600, devicePixelRatio: 1 }),
    ).toBe(0);
  });

  it('keeps the whole world inside the viewport at the fit zoom', () => {
    const z = fitWorldZoom(VP);
    expect(360 * z).toBeLessThanOrEqual(VP.widthCss + 1e-9);
    expect(180 * z).toBeLessThanOrEqual(VP.heightCss + 1e-9);
  });
});

describe('initialCamera (FR-11)', () => {
  it('is centered at lon 0 / lat 0 with the fit-all zoom', () => {
    const cam = initialCamera(VP);
    expect(cam.centerLon).toBe(0);
    expect(cam.centerLat).toBe(0);
    expect(cam.zoom).toBeCloseTo(fitWorldZoom(VP));
  });
});

describe('clampZoom (single clamp boundary — finite guarantee)', () => {
  it('clamps into the inclusive range and passes an in-range value through', () => {
    expect(clampZoom(9999, DEFAULT_ZOOM_RANGE)).toBe(DEFAULT_ZOOM_RANGE.maxZoom);
    expect(clampZoom(0.001, DEFAULT_ZOOM_RANGE)).toBe(DEFAULT_ZOOM_RANGE.minZoom);
    expect(clampZoom(10, DEFAULT_ZOOM_RANGE)).toBe(10);
  });

  it('never passes a non-finite zoom through — returns a finite, sign-correct bound (REGRESSION)', () => {
    // Before the fix `NaN < min` and `NaN > max` were both false, so clampZoom
    // returned NaN unchanged, which then propagated into a NaN camera center via
    // zoomAtCursor. The clamp must yield a FINITE bound instead.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = clampZoom(bad, DEFAULT_ZOOM_RANGE);
      expect(Number.isFinite(out)).toBe(true);
    }
    // A non-finite target is resolved by its SIGN, not blindly to `min`: the old
    // "always min" behaviour silently REVERSED an extreme wheel zoom-IN (whose
    // factor overflowed `camera.zoom * factor` to +∞) into a full zoom-OUT
    // (bughunt). +∞ is above every finite bound → upper; -∞ below every finite
    // bound → lower; NaN is positionless → lower (conservative default).
    expect(clampZoom(Number.NaN, DEFAULT_ZOOM_RANGE)).toBe(DEFAULT_ZOOM_RANGE.minZoom);
    expect(clampZoom(Number.POSITIVE_INFINITY, DEFAULT_ZOOM_RANGE)).toBe(
      DEFAULT_ZOOM_RANGE.maxZoom,
    );
    expect(clampZoom(Number.NEGATIVE_INFINITY, DEFAULT_ZOOM_RANGE)).toBe(
      DEFAULT_ZOOM_RANGE.minZoom,
    );
  });

  it('stays finite when the supplied range bounds are non-finite', () => {
    const nanRange: ZoomRange = { minZoom: Number.NaN, maxZoom: Number.NaN };
    expect(Number.isFinite(clampZoom(10, nanRange))).toBe(true);
    const infMax: ZoomRange = { minZoom: 2, maxZoom: Number.POSITIVE_INFINITY };
    // A non-finite max must not let an arbitrarily large zoom escape unbounded.
    expect(Number.isFinite(clampZoom(1e9, infMax))).toBe(true);
    expect(clampZoom(1, infMax)).toBe(2); // still honours the finite lower bound
  });

  it('collapses a degenerate range (min > max) to min, never NaN', () => {
    const degenerate: ZoomRange = { minZoom: 50, maxZoom: 1 };
    expect(clampZoom(10, degenerate)).toBe(50);
  });
});

describe('zoomAtCursor (FR-08 cursor-anchored)', () => {
  it('yields a FINITE camera even for a non-finite target zoom (REGRESSION)', () => {
    // Guard against the NaN-camera corruption path: a NaN nextZoom previously
    // produced centerLon/centerLat === NaN (division by a NaN clamped zoom).
    const next = zoomAtCursor(CAM, VP, { x: 600, y: 200 }, Number.NaN, DEFAULT_ZOOM_RANGE);
    expect(Number.isFinite(next.zoom)).toBe(true);
    expect(Number.isFinite(next.centerLon)).toBe(true);
    expect(Number.isFinite(next.centerLat)).toBe(true);
  });

  it('yields a finite camera when a range bound is non-finite (REGRESSION)', () => {
    const badRange: ZoomRange = { minZoom: Number.NaN, maxZoom: Number.NaN };
    const next = zoomAtCursor(CAM, VP, { x: 600, y: 200 }, 10, badRange);
    expect(Number.isFinite(next.zoom)).toBe(true);
    expect(Number.isFinite(next.centerLon)).toBe(true);
    expect(Number.isFinite(next.centerLat)).toBe(true);
  });

  it('keeps the world point under the cursor fixed on screen', () => {
    const cursor = { x: 600, y: 200 };
    const before = screenToWorld(cursor, CAM, VP);
    const next = zoomAtCursor(CAM, VP, cursor, 10);
    const after = worldToScreen(before, next, VP);
    expect(after.x).toBeCloseTo(cursor.x, 6);
    expect(after.y).toBeCloseTo(cursor.y, 6);
  });

  it('clamps the requested zoom into the supplied range', () => {
    const tooBig = zoomAtCursor(CAM, VP, { x: 400, y: 300 }, 9999, DEFAULT_ZOOM_RANGE);
    expect(tooBig.zoom).toBe(DEFAULT_ZOOM_RANGE.maxZoom);
    const tooSmall = zoomAtCursor(CAM, VP, { x: 400, y: 300 }, 0.001, DEFAULT_ZOOM_RANGE);
    expect(tooSmall.zoom).toBe(DEFAULT_ZOOM_RANGE.minZoom);
  });

  it('does not mutate the input camera (教訓 5.17)', () => {
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 2 };
    zoomAtCursor(cam, VP, { x: 100, y: 100 }, 5);
    expect(cam).toEqual({ centerLon: 0, centerLat: 0, zoom: 2 });
  });
});

describe('zoomStepAtCursor', () => {
  it('multiplies the current zoom by the factor (before clamp)', () => {
    const next = zoomStepAtCursor(CAM, VP, { x: 400, y: 300 }, 1.5);
    expect(next.zoom).toBeCloseTo(3);
  });
});

describe('wrapTurnsForViewport (FR-07 seam tiling)', () => {
  it('returns a single offset [0] when the viewport stays within one world turn', () => {
    // zoom 2, width 800 → 400° wide... that DOES exceed 360. Use a tighter zoom.
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 10 };
    // 800/10 = 80° wide, centered at 0 → covers [-40, 40], one turn.
    expect(wrapTurnsForViewport(cam, VP)).toEqual([0]);
  });

  it('includes the +1 turn when the viewport crosses the +180 seam', () => {
    const cam: Camera = { centerLon: 170, centerLat: 0, zoom: 10 };
    // covers [130, 210] → crosses +180, needs turns 0 and +1.
    expect(wrapTurnsForViewport(cam, VP)).toContain(0);
    expect(wrapTurnsForViewport(cam, VP)).toContain(1);
  });

  it('enumerates several turns when zoomed out past one world width', () => {
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 0.5 };
    // 800/0.5 = 1600° wide → > 4 turns; expect a contiguous integer range.
    const turns = wrapTurnsForViewport(cam, VP);
    expect(turns.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]! - turns[i - 1]!).toBe(1);
    }
  });

  it('returns [0] for a degenerate viewport / zoom', () => {
    expect(wrapTurnsForViewport(CAM, { ...VP, widthCss: 0 })).toEqual([0]);
    expect(wrapTurnsForViewport({ ...CAM, zoom: 0 }, VP)).toEqual([0]);
  });

  it('returns [0] (does not hang) for a non-finite centerLon', () => {
    // Regression: a non-finite center makes leftLon/rightLon — and hence
    // minTurn/maxTurn — non-finite, and the `t += 1` loop would never advance past
    // an infinite maxTurn, hanging the frame. The guard must short-circuit to [0].
    // The 1s vitest timeout fails (rather than hangs the suite) if the guard regresses.
    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(wrapTurnsForViewport({ ...CAM, centerLon: bad }, VP)).toEqual([0]);
    }
  }, 1000);

  it('returns [0] (does not hang) for a finite but out-of-safe-integer-magnitude centerLon (REGRESSION)', () => {
    // Bughunt: centerLon is a continuous, unbounded, never-clamped scalar. At ~1e20
    // leftLon/rightLon stay FINITE (so the finiteness guard passes) but minTurn/maxTurn
    // exceed Number.MAX_SAFE_INTEGER, where `t += 1` is a no-op → the t-loop never
    // terminates and the frame hangs. The magnitude guard must short-circuit to [0].
    // The 1s timeout fails (rather than hanging the suite) if the guard regresses.
    const cam: Camera = { centerLon: 1e20, centerLat: 0, zoom: 10 };
    expect(wrapTurnsForViewport(cam, VP)).toEqual([0]);
  }, 1000);

  it('returns [0] for a tiny zoom over a wide span (no unbounded array alloc) (REGRESSION)', () => {
    // Bughunt: a tiny-but-positive zoom yields a huge-but-finite covered span, so
    // (maxTurn − minTurn) is finite but enormous and the loop would allocate a giant
    // array each frame (renderer AND hit-test). The replica cap must bail to [0].
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 1e-12 };
    const turns = wrapTurnsForViewport(cam, VP);
    expect(turns).toEqual([0]);
  }, 1000);
});

describe('wrapTurnsForLonSpan (HB-14 — per-primitive turns for continuous longitude)', () => {
  const VP800: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

  it('picks the −1 turn for a feature at lon=360 viewed from centerLon=0 when zoomed in', () => {
    // The recurring vanish: at zoom 10 the view spans one turn, so the base-range turn
    // list collapses to [0] and a continuous lon=360 feature draws off-screen. The
    // per-primitive span turns must include −1 (replica 360−360=0 lands at screen centre).
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 10 };
    expect(wrapTurnsForLonSpan(360, 360, cam, VP800)).toContain(-1);
  });

  it('agrees with the identity turn for in-view base-range content', () => {
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 10 };
    expect(wrapTurnsForLonSpan(0, 0, cam, VP800)).toContain(0);
  });

  it('covers a seam-crossing continuous span [179,181] viewed near +180', () => {
    const cam: Camera = { centerLon: 180, centerLat: 0, zoom: 50 };
    const turns = wrapTurnsForLonSpan(179, 181, cam, VP800);
    // Some turn t makes [179+360t, 181+360t] overlap the view span centred at 180 ⇒ t=0.
    expect(turns).toContain(0);
  });

  it('returns a contiguous integer range, zoomed out across several turns', () => {
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 0.5 };
    const turns = wrapTurnsForLonSpan(0, 0, cam, VP800);
    expect(turns.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]! - turns[i - 1]!).toBe(1);
    }
  });

  it('returns [0] for degenerate viewport / zoom / span', () => {
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 10 };
    expect(wrapTurnsForLonSpan(0, 0, cam, { ...VP800, widthCss: 0 })).toEqual([0]);
    expect(wrapTurnsForLonSpan(0, 0, { ...cam, zoom: 0 }, VP800)).toEqual([0]);
    expect(wrapTurnsForLonSpan(10, -10, cam, VP800)).toEqual([0]); // min > max
  });

  it('returns [0] (does not hang) for a non-finite centerLon', () => {
    // Regression: same hang vector as wrapTurnsForViewport — a non-finite center
    // yields non-finite turn bounds and the enumeration loop would never terminate.
    for (const bad of [Infinity, -Infinity, NaN]) {
      const cam: Camera = { centerLon: bad, centerLat: 0, zoom: 10 };
      expect(wrapTurnsForLonSpan(0, 0, cam, VP800)).toEqual([0]);
    }
  }, 1000);

  it('returns [0] (does not hang) for a finite but out-of-safe-integer-magnitude centerLon (REGRESSION)', () => {
    // Same hang vector as wrapTurnsForViewport: a finite ~1e20 centerLon makes the
    // turn bounds exceed safe-integer precision, where `t += 1` never advances. The
    // magnitude guard must bail to [0].
    const cam: Camera = { centerLon: 1e20, centerLat: 0, zoom: 10 };
    expect(wrapTurnsForLonSpan(0, 0, cam, VP800)).toEqual([0]);
  }, 1000);

  it('returns [0] for a tiny zoom over a wide span (no unbounded array alloc) (REGRESSION)', () => {
    // A tiny zoom yields a finite-but-enormous (maxTurn − minTurn); the replica cap
    // must prevent the per-frame unbounded array allocation.
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 1e-12 };
    expect(wrapTurnsForLonSpan(0, 0, cam, VP800)).toEqual([0]);
  }, 1000);
});

describe('representativeCenterLon (FR-12, delegates to U05)', () => {
  it('folds a continuous center into [-180, 180) via wrapLonDeg', () => {
    expect(representativeCenterLon({ centerLon: 540, centerLat: 0, zoom: 1 })).toBe(
      wrapLonDeg(540),
    );
    expect(representativeCenterLon({ centerLon: -190, centerLat: 0, zoom: 1 })).toBe(
      wrapLonDeg(-190),
    );
  });
});
