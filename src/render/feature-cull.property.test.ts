// HB-14 再発防止 — property / metamorphic test for the feature view-clip ("拡大すると
// 地物が消える", v1/2/3 で再発した古典).
//
// THE INVARIANT (the one that, broken, makes features vanish): the per-frame
// candidate/clip set is a SUPERSET of every feature actually visible on screen.
// Formally, for any camera + viewport, if ANY ±360° replica of a feature's geometry
// projects to a point inside the viewport, `selectVisibleFeatures` MUST keep that
// feature. Clipping may KEEP a marginally-offscreen feature (the inflate margin);
// it must NEVER DROP an on-screen one — that drop IS the bug.
//
// We use the SAME world↔screen transform the renderer draws with as the GROUND
// TRUTH for "on screen" (worldToScreen over the ±360° turns the renderer tiles), so
// the property can never disagree with what is painted (教訓 5.29 単一真実源). The
// generators include zoomed-IN cameras, continuous longitudes wound many turns past
// the seam, and points / lines / areas — exactly the boundaries HB-14 hides in.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { latArb, viewportArb } from './arbitraries';
import type { Camera, Viewport } from './camera';
import {
  DEFAULT_SCREEN_SIZES,
  selectVisibleFeatures,
  type EvaluatedArea,
  type EvaluatedFeature,
  type EvaluatedLine,
  type EvaluatedPoint,
} from './feature-layer';
import { worldToScreen, wrapTurnsForLonSpan, type WorldPoint } from './vtransform';

const LONGITUDE_PERIOD = 360;

/** A zoom range biased toward the ZOOMED-IN end where HB-14 was reported. */
function zoomedInArb(): fc.Arbitrary<number> {
  return fc.double({ min: 1, max: 4000, noNaN: true, noDefaultInfinity: true });
}

/** Continuous longitude that may wind several turns past ±180 (FR-07 seam). */
function woundLonArb(): fc.Arbitrary<number> {
  return fc.double({ min: -1500, max: 1500, noNaN: true, noDefaultInfinity: true });
}

function cameraArb(): fc.Arbitrary<Camera> {
  return fc.record({ zoom: zoomedInArb(), centerLon: woundLonArb(), centerLat: latArb() });
}

/** True iff ANY ±360° replica of `p` projects inside the viewport (renderer ground truth). */
function worldPointOnScreen(p: WorldPoint, camera: Camera, viewport: Viewport): boolean {
  for (let k = -4; k <= 4; k += 1) {
    const s = worldToScreen({ lon: p.lon + k * LONGITUDE_PERIOD, lat: p.lat }, camera, viewport);
    if (s.x >= 0 && s.x <= viewport.widthCss && s.y >= 0 && s.y <= viewport.heightCss) {
      return true;
    }
  }
  return false;
}

/** Does the feature have ANY vertex whose replica lands on screen? (sufficient ⇒ visible). */
function featureHasOnScreenVertex(
  feature: EvaluatedFeature,
  camera: Camera,
  viewport: Viewport,
): boolean {
  switch (feature.kind) {
    case 'point':
      return worldPointOnScreen(feature.at, camera, viewport);
    case 'line':
      return feature.points.some((p) => worldPointOnScreen(p, camera, viewport));
    case 'area':
      return feature.shape.some((piece) =>
        piece.some((ring) => ring.some((c) => worldPointOnScreen(c, camera, viewport))),
      );
    default:
      return false;
  }
}

const STYLE = { fill: '#111', stroke: '#222', selectedColor: '#0ff' } as const;

function pointArb(): fc.Arbitrary<EvaluatedPoint> {
  return fc
    .record({ lon: woundLonArb(), lat: latArb() })
    .map((at) => ({ kind: 'point', id: 'p', at, style: STYLE, label: '', selected: false }));
}

function lineArb(): fc.Arbitrary<EvaluatedLine> {
  return fc
    .array(fc.record({ lon: woundLonArb(), lat: latArb() }), { minLength: 2, maxLength: 6 })
    .map((points) => ({ kind: 'line', id: 'l', points, style: STYLE, label: '', selected: false }));
}

function areaArb(): fc.Arbitrary<EvaluatedArea> {
  // A single closed quad piece [territory] whose corners wander; enough to exercise
  // the bbox-based area clip across the seam at deep zoom.
  return fc
    .record({
      lon: woundLonArb(),
      lat: latArb(),
      w: fc.double({ min: 0.001, max: 90, noNaN: true, noDefaultInfinity: true }),
      h: fc.double({ min: 0.001, max: 60, noNaN: true, noDefaultInfinity: true }),
    })
    .map(({ lon, lat, w, h }) => {
      const la = Math.max(-90, Math.min(90, lat));
      const lb = Math.max(-90, Math.min(90, lat + h));
      const ring = [
        { lon, lat: la },
        { lon: lon + w, lat: la },
        { lon: lon + w, lat: lb },
        { lon, lat: lb },
        { lon, lat: la },
      ];
      return {
        kind: 'area',
        id: 'a',
        shape: [[ring]],
        style: STYLE,
        label: '',
        selected: false,
      } satisfies EvaluatedArea;
    });
}

function featureArb(): fc.Arbitrary<EvaluatedFeature> {
  return fc.oneof(pointArb(), lineArb(), areaArb());
}

describe('HB-14: selectVisibleFeatures keeps every on-screen feature (candidate ⊇ visible)', () => {
  it('never drops a feature with an on-screen vertex, at any zoom-in / wound longitude', () => {
    fc.assert(
      fc.property(
        cameraArb(),
        viewportArb(),
        fc.array(featureArb(), { minLength: 0, maxLength: 6 }),
        (camera, viewport, features) => {
          const kept = new Set(
            selectVisibleFeatures(features, camera, viewport, DEFAULT_SCREEN_SIZES),
          );
          for (const f of features) {
            if (featureHasOnScreenVertex(f, camera, viewport)) {
              // The metamorphic core: an on-screen feature MUST survive the clip.
              expect(kept.has(f)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('metamorphic: zooming IN at a feature-centred camera never removes that feature', () => {
    fc.assert(
      fc.property(
        viewportArb(),
        fc.record({ lon: woundLonArb(), lat: latArb() }),
        fc.array(fc.double({ min: 1.0001, max: 50, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 6,
        }),
        (viewport, center, factors) => {
          // A point at the camera centre is always on screen; zooming IN (multiplying
          // zoom) while keeping the centre fixed must keep it visible at every step.
          const feature: EvaluatedPoint = {
            kind: 'point',
            id: 'p',
            at: center,
            style: STYLE,
            label: '',
            selected: false,
          };
          let zoom = 1;
          for (const factor of factors) {
            zoom *= factor; // strictly zoom IN each step
            const camera: Camera = { centerLon: center.lon, centerLat: center.lat, zoom };
            const kept = selectVisibleFeatures(
              [feature],
              camera,
              viewport,
              DEFAULT_SCREEN_SIZES,
            );
            expect(kept).toHaveLength(1);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  // The decisive end-to-end invariant (Codex #5 — the lock must observe what the
  // RENDERER actually paints, not an arbitrary replica search). The renderer draws a
  // wrapping primitive at exactly the turns `wrapTurnsForLonSpan` returns for the
  // primitive's longitude span; so "kept by the clip ⇒ the renderer paints an
  // on-screen replica" is the real anti-vanish guarantee. We assert: for a feature
  // whose vertex projects on screen, the renderer's per-primitive turn set includes a
  // turn that lands SOME vertex inside the viewport (it would NOT, with the old base-
  // range turn list, for a continuous longitude wound past ±180 — exactly HB-14).
  it('renderer paints an on-screen replica for every feature the clip keeps (clip ⇒ draw)', () => {
    fc.assert(
      fc.property(cameraArb(), viewportArb(), featureArb(), (camera, viewport, f) => {
        const kept = selectVisibleFeatures([f], camera, viewport, DEFAULT_SCREEN_SIZES);
        if (kept.length === 0) return; // not kept ⇒ nothing to draw, trivially fine
        const verts = featureVertices(f);
        if (verts.length === 0) return;
        const lonMin = Math.min(...verts.map((v) => v.lon));
        const lonMax = Math.max(...verts.map((v) => v.lon));
        const turns = wrapTurnsForLonSpan(lonMin, lonMax, camera, viewport);
        // Some (vertex, turn) replica the renderer actually draws lands on screen.
        const paintsOnScreen = verts.some((v) =>
          turns.some((t) => {
            const s = worldToScreen(
              { lon: v.lon + t * LONGITUDE_PERIOD, lat: v.lat },
              camera,
              viewport,
            );
            return s.x >= 0 && s.x <= viewport.widthCss && s.y >= 0 && s.y <= viewport.heightCss;
          }),
        );
        // If a vertex was on screen by the unconstrained ground truth, the renderer's
        // turn set must paint it (no vanish). When only an interior segment crosses the
        // view (no vertex on screen) this can be vacuously true — still never a vanish.
        if (featureHasOnScreenVertex(f, camera, viewport)) {
          expect(paintsOnScreen).toBe(true);
        }
      }),
      { numRuns: 3000 },
    );
  });
});

/** Every vertex of a feature (point/line/area) as a flat WorldPoint list. */
function featureVertices(f: EvaluatedFeature): WorldPoint[] {
  switch (f.kind) {
    case 'point':
      return [f.at];
    case 'line':
      return [...f.points];
    case 'area':
      return f.shape.flatMap((piece) => piece.flatMap((ring) => ring.map((c) => c)));
    default:
      return [];
  }
}
