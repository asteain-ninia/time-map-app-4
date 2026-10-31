// 重なりの解決で面を削ったあとの形（B105 と同じ崩れ）。
//
// 削りは集合演算の結果を記録へ書くので、幅いっぱいの面では一直線上の点が消えて経度 180 度以上の
// 1 本の辺になり、読み直すと別の形になる。実データの `area-188` の中に上位領域なしで面を描き、
// 「子を優先」で適用すると、崩れた面が偽の重なりを 10 件出し、どちらを選んでも断られた。

import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../domain/coordinate';
import type { AddSnapshot } from '../domain/add/index';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createEditProposal, PROCESS_STATUS } from '../domain/consistency/index';
import { createLeafFeature, type LeafFeature } from '../domain/feature';
import { alignMultiPolygon, wrapLonDeg } from '../domain/geo/index';
import { countLongEdgesInMultiPolygon } from '../domain/geo/long-edge';
import type { GeoMultiPolygon, GeoRing } from '../domain/geometry/index';
import { resolveLeafShape } from '../domain/hierarchy/resolve-shape';
import { asFeatureId, asRingId, asVertexId } from '../domain/ids';
import { checkConsistency } from '../domain/persistence/consistency';
import { createHoleRing, createShape, createTerritoryRing, RING_KIND, type Ring } from '../domain/ring';
import { validateRingHierarchy } from '../domain/ring-hierarchy';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';
import { createVertex, type Vertex } from '../domain/vertex';
import { createGeoParams } from '../domain/geo/geo-params';

import { createLiveAddBinding, type DomainRoot } from './consistency-binding';
import { featureByIdAt, verticesAt } from './live-lookup';

const T = timePointYear(1000);
const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const box = (w: number, s: number, e: number, n: number): GeoRing => [
  c(w, s),
  c(e, s),
  c(e, n),
  c(w, n),
];

function emptyRoot(): DomainRoot {
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

const addSnapshot = (b: Built): AddSnapshot => ({
  feature: b.feature,
  vertices: b.vertices,
  sharedCandidateIds: new Map(),
});

function band(w: number, s: number, e: number, n: number, step = 90): GeoRing {
  const ring: WorldCoordinate[] = [];
  for (let lon = w; lon < e; lon += step) ring.push(c(lon, s));
  ring.push(c(e, s), c(e, n));
  for (let lon = e - step; lon > w; lon -= step) ring.push(c(lon, n));
  ring.push(c(w, n));
  return ring;
}

interface Built {
  readonly feature: LeafFeature;
  readonly vertices: Vertex[];
}

function leaf(
  id: string,
  outer: GeoRing,
  holes: readonly { ring: GeoRing; enclaves?: readonly GeoRing[] }[] = [],
): Built {
  const vertices: Vertex[] = [];
  let n = 0;
  const mint = (ring: GeoRing) =>
    ring.map((q) => {
      const v = createVertex(asVertexId(`${id}-${(n += 1)}`), c(wrapLonDeg(q.lon), q.lat));
      vertices.push(v);
      return v.id;
    });
  const outerId = asRingId(`${id}-o`);
  const rings: Ring[] = [createTerritoryRing(outerId, mint(outer))];
  holes.forEach((hole, h) => {
    const holeId = asRingId(`${id}-h${h}`);
    rings.push(createHoleRing(holeId, mint(hole.ring), outerId));
    hole.enclaves?.forEach((ring, e) => {
      rings.push(createTerritoryRing(asRingId(`${id}-e${h}-${e}`), mint(ring), holeId));
    });
  });
  return {
    vertices,
    feature: createLeafFeature(
      asFeatureId(id),
      createBasicAttributes(id, 0, 0),
      COLOR,
      createShape(rings),
    ),
  };
}

function netArea(mp: GeoMultiPolygon): number {
  const area = (r: GeoRing): number => {
    let s = 0;
    r.forEach((a, i) => {
      const b = r[(i + 1) % r.length]!;
      s += a.lon * b.lat - b.lon * a.lat;
    });
    return Math.abs(s) / 2;
  };
  let total = 0;
  for (const poly of mp) poly.forEach((r, i) => (total += i === 0 ? area(r) : -area(r)));
  return total;
}

/** `adjust` と `priority` を置き、`priority` を優先して `adjust` を削る。 */
function trim(adjust: Built, priority: Built): { root: DomainRoot; committed: boolean } {
  let root = emptyRoot();
  let n = 0;
  const binding = createLiveAddBinding({
    getRoot: () => root,
    nextVertexId: () => asVertexId(`rv-${(n += 1)}`),
    nextRingId: () => asRingId(`rr-${(n += 1)}`),
  });
  const seed = binding.startProcess(
    createEditProposal(adjust.feature.id, T, addSnapshot(adjust)),
  );
  if (seed.status !== PROCESS_STATUS.Committed) throw new Error(`置けない: ${seed.status}`);
  root = seed.state;
  const proposal = createEditProposal(priority.feature.id, T, addSnapshot(priority));
  const pending = binding.startProcess(proposal);
  if (pending.status !== PROCESS_STATUS.ConflictsPending) throw new Error(pending.status);
  const applied = binding.applyResolutionsFor(proposal)(
    pending.conflicts.map((k) => ({
      conflictId: k.id,
      priorityFeatureId: priority.feature.id,
      adjustFeatureId: adjust.feature.id,
    })),
  );
  if (applied.status !== PROCESS_STATUS.Committed) return { root, committed: false };
  return { root: applied.command.execute(root).state, committed: true };
}

function shapeOf(root: DomainRoot, id: string): { mp: GeoMultiPolygon; feature: LeafFeature } {
  const feature = featureByIdAt(root, T, asFeatureId(id));
  if (feature === undefined || feature.kind !== 'leaf') throw new Error(`面が無い: ${id}`);
  return { feature, mp: alignMultiPolygon(resolveLeafShape(feature.shape, verticesAt(root, T))!) };
}

describe('重なりの解決で面を削る', () => {
  it('幅いっぱいの面の中の子を優先すると、面積が保たれ、長い辺が残らない', () => {
    const { root, committed } = trim(
      leaf('W', band(-180, -90, 179.99, -60)),
      leaf('K', box(-1, -80, 1, -70)),
    );
    expect(committed).toBe(true);
    const { mp, feature } = shapeOf(root, 'W');
    // 359.99 × 30 − 2 × 10。
    expect(netArea(mp)).toBeCloseTo(10799.7 - 20, 5);
    expect(countLongEdgesInMultiPolygon(mp)).toBe(0);
    expect(validateRingHierarchy(feature.shape, verticesAt(root, T)).violations).toEqual([]);
    expect(checkConsistency(root, CAL).inconsistencies).toEqual([]);
  });

  it('子が幅いっぱいの面の南の辺に接するとき、辺の刻みが残る', () => {
    const { root, committed } = trim(
      leaf('W', band(-180, -90, 179.99, -60)),
      leaf('K', box(-1, -90, 1, -80)),
    );
    expect(committed).toBe(true);
    const { mp } = shapeOf(root, 'W');
    expect(netArea(mp)).toBeCloseTo(10799.7 - 20, 5);
    expect(countLongEdgesInMultiPolygon(mp)).toBe(0);
  });

  it('継ぎ目にかかる優先の面は、両側とも削られる', () => {
    const { root, committed } = trim(
      leaf('W', band(-180, -90, 179.99, -60)),
      leaf('K', box(179, -80, 181, -70)),
    );
    expect(committed).toBe(true);
    // 東の端の 0.99 × 10 と、西の端の 1 × 10。
    expect(netArea(shapeOf(root, 'W').mp)).toBeCloseTo(10799.7 - 19.9, 5);
  });

  it('穴の中の飛び地を持つ面を削っても、飛び地は穴の子のまま', () => {
    const { root, committed } = trim(
      leaf('E', box(0, 0, 40, 40), [{ ring: box(10, 10, 30, 30), enclaves: [box(15, 15, 25, 25)] }]),
      leaf('K', box(-5, 0, 5, 40)),
    );
    expect(committed).toBe(true);
    const { mp, feature } = shapeOf(root, 'E');
    // 35 × 40 − 20 × 20 + 10 × 10。
    expect(netArea(mp)).toBeCloseTo(1400 - 400 + 100, 6);
    expect(validateRingHierarchy(feature.shape, verticesAt(root, T)).violations).toEqual([]);
    const nested = feature.shape.rings.filter(
      (r) => r.kind === RING_KIND.Territory && r.parentRingId !== undefined,
    );
    expect(nested).toHaveLength(1);
  });

  it('ふつうの面の削りは今までと同じ', () => {
    const { root, committed } = trim(leaf('A', box(0, 0, 10, 10)), leaf('K', box(8, 0, 12, 10)));
    expect(committed).toBe(true);
    expect(netArea(shapeOf(root, 'A').mp)).toBeCloseTo(80, 6);
  });
});
