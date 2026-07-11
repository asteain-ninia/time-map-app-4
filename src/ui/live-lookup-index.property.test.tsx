// S3d — the broad-phase `leafAtPoint` index EQUIVALENCE property.
//
// `leafAtPoint` (the knife / merge / reparent / drill / ring-edit `featureAtPoint` port)
// narrows its O(全頂点) linear scan — `resolveLeafShape` + point-in-polygon over EVERY
// leaf — through a per-(root, time) RBush broad phase (live-lookup.ts). This suite pins the
// ONE invariant the optimisation must hold under: for the SAME inputs, the INDEXED path
// and the un-indexed full scan return the byte-identical FeatureId (索引ありなしで返り値
// 一致). The index is a candidate SUPERSET run in the SAME scan order, so the exact
// per-candidate containment still decides every hit — this proves the pruning never
// changes the answer.
//
// The fixture lights up every branch the task calls out: overlapping leaves (最前面
// タイブレーク — a later leaf on top wins), a leaf grabbable only via a ±360° wrap replica
// (wrap カメラ相当), a leaf straddling the seam from FOLDED stored representatives
// (シーム跨ぎ leaf, whose raw bbox is the deceptive full-width band), a HOLED leaf (穴あき —
// a click in the hole is a candidate by bbox yet a miss by the exact test), and individual
// child leaves under an aggregate (leafAtPoint ignores display-control — HB3-16).

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  leafAtPoint,
  clearLiveLookupCache,
  setLeafIndexEnabledForTest,
} from './live-lookup';
import type { DomainRoot } from './consistency-binding';
import { applyAddProposal } from '../domain/editing/apply-proposal';
import { createEditProposal } from '../domain/consistency/index';
import { timePointYear } from '../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  withParentId,
  type LeafFeature,
} from '../domain/feature';
import { createShape, createTerritoryRing, createHoleRing } from '../domain/ring';
import { createVertex, type Vertex } from '../domain/vertex';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../domain/ids';
import { createGeoParams } from '../domain/geo/geo-params';
import type { AddSnapshot } from '../domain/add/index';
import type { WorldCoordinate } from '../domain/coordinate';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const time = timePointYear(1000);

function emptyProject(): DomainRoot {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

/** A leaf whose single territory ring is the given explicit `[lon, lat]` corners. */
function polyLeaf(
  idRaw: string,
  vPrefix: string,
  corners: readonly (readonly [number, number])[],
  parentId?: FeatureId,
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]!, lat: c[1]! }),
  );
  const ring = createTerritoryRing(
    asRingId(`r-${idRaw}`),
    vertices.map((v) => v.id),
  );
  let feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([ring]),
  );
  if (parentId !== undefined) feature = withParentId(feature, parentId);
  return { feature, vertices };
}

/** A leaf with an outer territory ring and one hole ring punched into it (穴あき). */
function holedLeaf(
  idRaw: string,
  vPrefix: string,
  outer: readonly (readonly [number, number])[],
  hole: readonly (readonly [number, number])[],
): { feature: LeafFeature; vertices: Vertex[] } {
  const outerVerts = outer.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-o-${i}`), { lon: c[0]!, lat: c[1]! }),
  );
  const holeVerts = hole.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-h-${i}`), { lon: c[0]!, lat: c[1]! }),
  );
  const outerRing = createTerritoryRing(
    asRingId(`r-${idRaw}`),
    outerVerts.map((v) => v.id),
  );
  const holeRing = createHoleRing(
    asRingId(`r-${idRaw}-hole`),
    holeVerts.map((v) => v.id),
    outerRing.id,
  );
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([outerRing, holeRing]),
  );
  return { feature, vertices: [...outerVerts, ...holeVerts] };
}

function commit(
  root: DomainRoot,
  f: { feature: LeafFeature; vertices: Vertex[] },
): DomainRoot {
  const snapshot: AddSnapshot = {
    feature: f.feature,
    vertices: f.vertices,
    sharedCandidateIds: new Map(),
  };
  return applyAddProposal(root, createEditProposal(f.feature.id, time, snapshot));
}

// --- The fixture: a mix that lights up every leafAtPoint branch ---------------
const AGG_ID = asFeatureId('f-agg');

// Two OVERLAPPING leaves (share the [4,6]×[4,6] region) so the later-committed one must
// win the tie in that overlap — indexed and scanned identically (最前面タイブレーク).
const overlapLow = polyLeaf('f-lo', 'vLo', [
  [0, 0],
  [6, 0],
  [6, 6],
  [0, 6],
]);
const overlapHigh = polyLeaf('f-hi', 'vHi', [
  [4, 4],
  [10, 4],
  [10, 10],
  [4, 10],
]);
// A disjoint leaf far away.
const far = polyLeaf('f-far', 'vFar', [
  [-40, -40],
  [-30, -40],
  [-30, -30],
  [-40, -30],
]);
// A wrap leaf covering [179,181]×[0,2]: grabbable via the −179° replica of a click.
const wrapLeaf = polyLeaf('f-wrap', 'vWrap', [
  [179, 0],
  [181, 0],
  [181, 2],
  [179, 2],
]);
// A leaf straddling the seam from FOLDED representatives ([170,-170]) — its raw bbox is
// the deceptive ~340° band, yet the index (bbox from the SAME folded coords the exact test
// reads) and the scan must still agree everywhere.
const seamLeaf = polyLeaf('f-seam', 'vSeam', [
  [170, 10],
  [-170, 10],
  [-170, 12],
  [170, 12],
]);
// A HOLED leaf: outer [20,28]×[20,28] with a [23,25]×[23,25] hole. A click in the hole is a
// bbox candidate but an exact-test MISS (穴透過).
const holed = holedLeaf(
  'f-holed',
  'vHoled',
  [
    [20, 20],
    [28, 20],
    [28, 28],
    [20, 28],
  ],
  [
    [23, 23],
    [25, 23],
    [25, 25],
    [23, 25],
  ],
);
// Two child leaves under an aggregate (leafAtPoint picks the INDIVIDUAL leaves regardless
// of display-control — HB3-16).
const childA = polyLeaf(
  'f-ca',
  'vCA',
  [
    [30, 30],
    [34, 30],
    [34, 34],
    [30, 34],
  ],
  AGG_ID,
);
const childB = polyLeaf(
  'f-cb',
  'vCB',
  [
    [34, 30],
    [38, 30],
    [38, 34],
    [34, 34],
  ],
  AGG_ID,
);

let ROOT: DomainRoot = [overlapLow, overlapHigh, far, wrapLeaf, seamLeaf, holed, childA, childB].reduce(
  commit,
  emptyProject(),
);
// The (shapeless) aggregate parent so the children genuinely have a present parent.
ROOT = applyAddProposal(
  ROOT,
  createEditProposal(AGG_ID, time, {
    feature: createAggregateFeature(AGG_ID, createBasicAttributes('f-agg', 0, 0), color, [
      childA.feature.id,
      childB.feature.id,
    ]),
    vertices: [],
    sharedCandidateIds: new Map(),
  }),
);

/** Run leafAtPoint twice — index ON then OFF — and return both results. */
function bothPaths(point: WorldCoordinate): {
  indexed: FeatureId | null;
  scan: FeatureId | null;
} {
  setLeafIndexEnabledForTest(true);
  const indexed = leafAtPoint(ROOT, time, point);
  setLeafIndexEnabledForTest(false);
  const scan = leafAtPoint(ROOT, time, point);
  return { indexed, scan };
}

afterEach(() => setLeafIndexEnabledForTest(true));

describe('leafAtPoint broad-phase index ≡ full scan (S3d)', () => {
  it('indexed and un-indexed leafAtPoint agree for random world points (±360° wrapped)', () => {
    fc.assert(
      fc.property(
        fc.record({
          lon: fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
          lat: fc.double({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true }),
          // Shift the click by whole turns so wrap replicas / the seam leaf are exercised.
          turnK: fc.integer({ min: -2, max: 2 }),
        }),
        (g) => {
          const point: WorldCoordinate = { lon: g.lon + g.turnK * 360, lat: g.lat };
          const { indexed, scan } = bothPaths(point);
          expect(indexed).toBe(scan);
        },
      ),
      { numRuns: 6000 },
    );
  });

  // Targeted world points aimed at each fixture feature's key spots + its ±360° replicas,
  // so the overlap tie, the wrap/seam replicas, the hole transparency, and the aggregate
  // children are each hit directly (not left to random sampling).
  it('agrees at every fixture key point and its ±360° replicas', () => {
    const keyPoints: WorldCoordinate[] = [
      { lon: 2, lat: 2 }, // overlapLow only
      { lon: 5, lat: 5 }, // overlap region → later leaf wins
      { lon: 8, lat: 8 }, // overlapHigh only
      { lon: -35, lat: -35 }, // far
      { lon: 180, lat: 1 }, // wrapLeaf canonical
      { lon: -180, lat: 1 }, // wrapLeaf via −360° replica
      { lon: 0, lat: 11 }, // inside the seam leaf's FOLDED bbox (raw-polygon behaviour)
      { lon: 180, lat: 11 }, // the seam leaf's geometric position
      { lon: 21, lat: 21 }, // holed: inside outer, outside hole → hit
      { lon: 24, lat: 24 }, // holed: inside the hole → miss (穴透過)
      { lon: 32, lat: 32 }, // childA (aggregate child)
      { lon: 36, lat: 32 }, // childB (aggregate child)
      { lon: 34, lat: 32 }, // shared edge of the two children
      { lon: 100, lat: 40 }, // empty space
    ];
    for (const base of keyPoints) {
      for (const k of [-2, -1, 0, 1, 2]) {
        const point: WorldCoordinate = { lon: base.lon + k * 360, lat: base.lat };
        const { indexed, scan } = bothPaths(point);
        expect(indexed).toBe(scan);
      }
    }
  });

  it('the index result matches the documented containment (sanity, not just self-consistency)', () => {
    setLeafIndexEnabledForTest(true);
    // Overlap tie: a later leaf on top wins in the shared region.
    expect(leafAtPoint(ROOT, time, { lon: 5, lat: 5 })).toBe(overlapHigh.feature.id);
    // Hole transparency: inside the hole is a MISS, the surrounding ring is a hit.
    expect(leafAtPoint(ROOT, time, { lon: 24, lat: 24 })).toBeNull();
    expect(leafAtPoint(ROOT, time, { lon: 21, lat: 21 })).toBe(holed.feature.id);
    // Wrap replica: a click on the −179° replica hits the [179,181] leaf.
    expect(leafAtPoint(ROOT, time, { lon: -180, lat: 1 })).toBe(wrapLeaf.feature.id);
    // Aggregate children resolve to the INDIVIDUAL leaves (distinct ids).
    expect(leafAtPoint(ROOT, time, { lon: 32, lat: 32 })).toBe(childA.feature.id);
    expect(leafAtPoint(ROOT, time, { lon: 36, lat: 32 })).toBe(childB.feature.id);
    // Empty space clears.
    expect(leafAtPoint(ROOT, time, { lon: 100, lat: 40 })).toBeNull();
  });

  afterEach(() => clearLiveLookupCache());
});
