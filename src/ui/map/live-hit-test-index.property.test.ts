// S3c — the broad-phase pointer hit-test index EQUIVALENCE property.
//
// `liveHitTestAt` (and the knife `drawnAreaAt`) narrow their two O(全頂点) full scans
// — vertex proximity + area-body containment — through a per-generation RBush broad
// phase (live-hit-test.ts). This suite pins the ONE invariant the optimisation must
// hold under: for the SAME inputs, the INDEXED path and the un-indexed full scan return
// a byte-identical `HitResult` (索引ありなしでヒット結果が同一). The index is a candidate
// SUPERSET filter run in the SAME iteration order, so the exact per-candidate test still
// decides every hit — this test proves the pruning never changes the answer.
//
// Random screen points are scattered over random cameras (including ±360° WRAP turns),
// zooms, grab radii, active features, and display-controls, exercising every branch:
// vertex-first (including SHARED vertices with multiple owners and DISTINCT coincident
// vertices whose distance TIE must break identically), point/line bodies (including a
// seam-crossing line), the aggregate/leaf area body, and the exactly-at-radius boundary.

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { liveHitTestAt, drawnAreaAt, setHitIndexEnabledForTest } from './live-hit-test';
import type { LiveHitTestInput } from './live-hit-test';
import type { HitResult } from '../../domain/selection';
import type { DomainRoot } from '../consistency-binding';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import { timePointYear } from '../../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  withParentId,
  type Feature,
} from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../../domain/ids';
import { createGeoParams } from '../../domain/geo/geo-params';
import type { AddSnapshot } from '../../domain/add/index';
import { worldToScreen, screenToWorld } from '../../render';
import type { Camera, Viewport, ScreenPoint } from '../../render';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { DisplayControlInput } from '../../render/display-pipeline';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const time = timePointYear(1000);
const viewport: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

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

/** A leaf from explicit `[vertexId, lon, lat]` corners (shared ids across leaves are
 *  intentional — a reused id + coord makes a genuine multi-owner shared vertex). */
function leaf(
  idRaw: string,
  corners: readonly (readonly [string, number, number])[],
  parentId?: FeatureId,
): { feature: Feature; vertices: Vertex[] } {
  const vertices = corners.map(([vid, lon, lat]) =>
    createVertex(asVertexId(vid), { lon, lat }),
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

function point(idRaw: string, vid: string, lon: number, lat: number): {
  feature: Feature;
  vertices: Vertex[];
} {
  const vertex = createVertex(asVertexId(vid), { lon, lat });
  const feature = createPointFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    vertex.id,
  );
  return { feature, vertices: [vertex] };
}

function line(
  idRaw: string,
  vPrefix: string,
  pts: readonly (readonly [number, number])[],
): { feature: Feature; vertices: Vertex[] } {
  const vertices = pts.map((p, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: p[0]!, lat: p[1]! }),
  );
  const feature = createLineFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    vertices.map((v) => v.id),
  );
  return { feature, vertices };
}

function commit(
  root: DomainRoot,
  f: { feature: Feature; vertices: Vertex[] },
): DomainRoot {
  const snapshot: AddSnapshot = {
    feature: f.feature,
    vertices: f.vertices,
    sharedCandidateIds: new Map(),
  };
  return applyAddProposal(root, createEditProposal(f.feature.id, time, snapshot));
}

// --- The fixture: a rich mix that lights up every hit-test branch -------------
const AGG_ID = asFeatureId('f-agg');

// leafA [0,4]² and leafB [4,8]² SHARE the (4,4) corner vertex `vShared` (multi-owner).
const leafA = leaf('f-a', [
  ['vA-0', 0, 0],
  ['vA-1', 4, 0],
  ['vShared', 4, 4],
  ['vA-3', 0, 4],
]);
const leafB = leaf('f-b', [
  ['vShared', 4, 4],
  ['vB-1', 8, 4],
  ['vB-2', 8, 8],
  ['vB-3', 4, 8],
]);
// A standalone point whose vertex is COINCIDENT with the shared corner (distance tie
// among DISTINCT vertices → the later owner in iteration order must win, identically).
const pointP = point('f-p', 'vP', 4, 4);
const pointQ = point('f-q', 'vQ', 20, 18);
const lineL = line('f-l', 'vL', [
  [10, 0],
  [14, 0],
  [14, 6],
]);
// A line straddling the antimeridian (stored [179,-179] → drawn unwrapped [179,181]).
const seamLine = line('f-seam-l', 'vSL', [
  [179, -1],
  [-179, 1],
]);
// A leaf straddling the antimeridian (drawn unwrapped near [178,182]).
const seamLeaf = leaf('f-seam-a', [
  ['vSA-0', 178, -2],
  ['vSA-1', -178, -2],
  ['vSA-2', -178, 2],
  ['vSA-3', 178, 2],
]);
// An aggregate over two children (hidden at N=0 → aggregate area; shown deep as leaves).
const childA2 = leaf(
  'f-ca2',
  [
    ['vCA2-0', 30, 30],
    ['vCA2-1', 34, 30],
    ['vCA2-2', 34, 34],
    ['vCA2-3', 30, 34],
  ],
  AGG_ID,
);
const childB2 = leaf(
  'f-cb2',
  [
    ['vCB2-0', 36, 30],
    ['vCB2-1', 40, 30],
    ['vCB2-2', 40, 34],
    ['vCB2-3', 36, 34],
  ],
  AGG_ID,
);
const agg = createAggregateFeature(AGG_ID, createBasicAttributes('f-agg', 0, 0), color, [
  childA2.feature.id,
  childB2.feature.id,
]);

const ROOT: DomainRoot = [
  { feature: agg, vertices: [] },
  leafA,
  leafB,
  pointP,
  pointQ,
  lineL,
  seamLine,
  seamLeaf,
  childA2,
  childB2,
].reduce(commit, emptyProject());

// Stable display-control identities so the shared (root,time,control) resolution memo
// HITS across property runs (the broad-phase index is keyed by that resolution).
const CONTROL_DEFAULT: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};
const CONTROL_DEEP: DisplayControlInput = {
  globalDepth: 10,
  focus: { originId: null, depth: 0, emphasize: false },
};
const CONTROL_FOCUS_AGG: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: AGG_ID, depth: 10, emphasize: false },
};
const CONTROLS = [CONTROL_DEFAULT, CONTROL_DEEP, CONTROL_FOCUS_AGG];

const ACTIVE_FEATURES: (FeatureId | null)[] = [
  null,
  leafA.feature.id,
  leafB.feature.id,
  seamLeaf.feature.id,
  childA2.feature.id,
  AGG_ID,
];

/** World coordinates the cameras are aimed at — every feature's key points. */
const TARGETS: WorldCoordinate[] = [
  { lon: 0, lat: 0 },
  { lon: 4, lat: 4 }, // shared corner + coincident point
  { lon: 2, lat: 2 }, // inside leafA
  { lon: 6, lat: 6 }, // inside leafB
  { lon: 8, lat: 4 },
  { lon: 20, lat: 18 }, // pointQ
  { lon: 12, lat: 0 }, // on lineL mid-segment
  { lon: 14, lat: 3 },
  { lon: 180, lat: 0 }, // seam line / leaf drawn position
  { lon: 179, lat: -1 },
  { lon: 32, lat: 32 }, // inside childA2 / aggregate
  { lon: 38, lat: 32 }, // inside childB2 / aggregate
  { lon: 35, lat: 32 }, // between children (aggregate body, gap between leaves)
  { lon: 50, lat: 50 }, // empty space
];

/** Run the hit-test twice — index ON then OFF — and return both results. */
function bothPaths(input: LiveHitTestInput, worldPoint: WorldCoordinate): {
  indexed: HitResult;
  scan: HitResult;
} {
  setHitIndexEnabledForTest(true);
  const indexed = liveHitTestAt(input, worldPoint);
  setHitIndexEnabledForTest(false);
  const scan = liveHitTestAt(input, worldPoint);
  return { indexed, scan };
}

afterEach(() => setHitIndexEnabledForTest(true));

describe('liveHitTestAt broad-phase index ≡ full scan (S3c)', () => {
  it('indexed and un-indexed hit-tests agree for random points/cameras/controls', () => {
    fc.assert(
      fc.property(
        fc.record({
          targetIdx: fc.nat({ max: TARGETS.length - 1 }),
          turnK: fc.integer({ min: -2, max: 2 }),
          lonJitter: fc.double({ min: -3, max: 3, noNaN: true, noDefaultInfinity: true }),
          latJitter: fc.double({ min: -3, max: 3, noNaN: true, noDefaultInfinity: true }),
          zoom: fc.double({ min: 4, max: 200, noNaN: true, noDefaultInfinity: true }),
          sjx: fc.double({ min: -16, max: 16, noNaN: true, noDefaultInfinity: true }),
          sjy: fc.double({ min: -16, max: 16, noNaN: true, noDefaultInfinity: true }),
          radiusPx: fc.constantFrom(4, 8, 12),
          controlIdx: fc.nat({ max: CONTROLS.length - 1 }),
          activeIdx: fc.nat({ max: ACTIVE_FEATURES.length - 1 }),
        }),
        (g) => {
          const target = TARGETS[g.targetIdx]!;
          const shift = g.turnK * 360;
          const camera: Camera = {
            centerLon: target.lon + shift + g.lonJitter,
            centerLat: target.lat + g.latJitter,
            zoom: g.zoom,
          };
          const toScreen = (w: WorldCoordinate): ScreenPoint =>
            worldToScreen(w, camera, viewport);
          // Aim the click at the target's ±360° REPLICA (so a wrap replica is grabbed
          // when turnK≠0), then screen-jitter it and invert to the world point exactly
          // as production does (worldPoint = screenToWorld(point)).
          const replicaScreen = worldToScreen(
            { lon: target.lon + shift, lat: target.lat },
            camera,
            viewport,
          );
          const clickPoint: ScreenPoint = {
            x: replicaScreen.x + g.sjx,
            y: replicaScreen.y + g.sjy,
          };
          const worldPoint = screenToWorld(clickPoint, camera, viewport);
          const input: LiveHitTestInput = {
            root: ROOT,
            time,
            displayControl: CONTROLS[g.controlIdx]!,
            toScreen,
            wrap: { camera, viewport },
            point: clickPoint,
            radiusPx: g.radiusPx,
            activeFeature: ACTIVE_FEATURES[g.activeIdx]!,
          };
          const { indexed, scan } = bothPaths(input, worldPoint);
          expect(indexed).toEqual(scan);
        },
      ),
      { numRuns: 4000 },
    );
  });

  // EXACTLY-AT-RADIUS boundary (閾値ちょうどの距離): a click placed exactly `radiusPx`
  // screen pixels from a vertex is a hit (`d <= radiusSq`), and the broad-phase margin
  // (widened by a float epsilon) must never prune that boundary candidate.
  it('a click exactly at the grab radius agrees (index must not drop the boundary)', () => {
    for (const zoom of [5, 25, 137.5]) {
      for (const radiusPx of [4, 8, 12]) {
        for (const turnK of [-1, 0, 1]) {
          const shift = turnK * 360;
          const camera: Camera = { centerLon: shift, centerLat: 0, zoom };
          const toScreen = (w: WorldCoordinate): ScreenPoint =>
            worldToScreen(w, camera, viewport);
          // The shared (4,4) corner's replica, exactly `radiusPx` px to its right.
          const vScreen = worldToScreen({ lon: 4 + shift, lat: 4 }, camera, viewport);
          const clickPoint: ScreenPoint = { x: vScreen.x + radiusPx, y: vScreen.y };
          const worldPoint = screenToWorld(clickPoint, camera, viewport);
          const input: LiveHitTestInput = {
            root: ROOT,
            time,
            displayControl: CONTROL_DEFAULT,
            toScreen,
            wrap: { camera, viewport },
            point: clickPoint,
            radiusPx,
          };
          const { indexed, scan } = bothPaths(input, worldPoint);
          expect(indexed).toEqual(scan);
        }
      }
    }
  });

  it('knife drawnAreaAt agrees with/without the index (aggregate + wrap)', () => {
    fc.assert(
      fc.property(
        fc.record({
          targetIdx: fc.nat({ max: TARGETS.length - 1 }),
          turnK: fc.integer({ min: -2, max: 2 }),
          lonJitter: fc.double({ min: -2, max: 2, noNaN: true, noDefaultInfinity: true }),
          latJitter: fc.double({ min: -2, max: 2, noNaN: true, noDefaultInfinity: true }),
          zoom: fc.double({ min: 4, max: 200, noNaN: true, noDefaultInfinity: true }),
          controlIdx: fc.nat({ max: CONTROLS.length - 1 }),
        }),
        (g) => {
          const target = TARGETS[g.targetIdx]!;
          const shift = g.turnK * 360;
          const camera: Camera = {
            centerLon: target.lon + shift + g.lonJitter,
            centerLat: target.lat + g.latJitter,
            zoom: g.zoom,
          };
          const worldPoint: WorldCoordinate = {
            lon: target.lon + shift + g.lonJitter,
            lat: target.lat + g.latJitter,
          };
          const knifeInput = {
            root: ROOT,
            time,
            displayControl: CONTROLS[g.controlIdx]!,
            wrap: { camera, viewport },
          };
          setHitIndexEnabledForTest(true);
          const indexed = drawnAreaAt(knifeInput, worldPoint);
          setHitIndexEnabledForTest(false);
          const scan = drawnAreaAt(knifeInput, worldPoint);
          expect(indexed).toEqual(scan);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
