// UI/map — featureBoundsAt tests (HB5-3): resolve a feature's world bbox at a time.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createAggregateFeature,
  createLineFeature,
  createLeafFeature,
  createPointFeature,
  type AggregateFeature,
  type LeafFeature,
} from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createGeoParams } from '../../domain/geo/geo-params';
import { wrapLonDeg } from '../../domain/geo/longitude';
import { WORLD_LON_SPAN_DEG } from '../../render';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import type { AddSnapshot } from '../../domain/add/index';
import type { DomainProject } from '../../domain/persistence/index';
import { timePointYear } from '../../domain/time/time-point';

import { clearLiveLookupCache } from '../live-lookup';
import { allFeaturesBoundsAt, featureBoundsAt } from './feature-bounds';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T = timePointYear(1000);

function emptyProject(): DomainProject {
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

function addFeature(
  root: DomainProject,
  feature: LeafFeature | AggregateFeature | ReturnType<typeof createPointFeature> | ReturnType<typeof createLineFeature>,
  vertices: Vertex[],
): DomainProject {
  const snapshot: AddSnapshot = { feature, vertices, sharedCandidateIds: new Map() };
  return applyAddProposal(root, createEditProposal(feature.id, T, snapshot));
}

/** Same as {@link addFeature} but anchors the feature at an ARBITRARY time. */
function addFeatureAtTime(
  root: DomainProject,
  feature: Parameters<typeof addFeature>[1],
  vertices: Vertex[],
  time: ReturnType<typeof timePointYear>,
): DomainProject {
  const snapshot: AddSnapshot = { feature, vertices, sharedCandidateIds: new Map() };
  return applyAddProposal(root, createEditProposal(feature.id, time, snapshot));
}

/** A square leaf with corners offset from (0,0), side `side`. */
function squareLeaf(
  idRaw: string,
  lonOffset = 0,
  latOffset = 0,
  side = 2,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${idRaw}-v${i}`), {
      lon: c[0]! + lonOffset,
      lat: c[1]! + latOffset,
    }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 1000, 1100),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

describe('featureBoundsAt (HB5-3)', () => {
  it('returns the bbox of a leaf shape at the time', () => {
    clearLiveLookupCache();
    const leaf = squareLeaf('leaf', 3, 5, 2); // corners (3,5)..(5,7)
    const root = addFeature(emptyProject(), leaf.feature, leaf.vertices);
    const bounds = featureBoundsAt(root, T, leaf.feature.id);
    expect(bounds).not.toBeNull();
    expect(bounds!.minLon).toBeCloseTo(3, 9);
    expect(bounds!.maxLon).toBeCloseTo(5, 9);
    expect(bounds!.minLat).toBeCloseTo(5, 9);
    expect(bounds!.maxLat).toBeCloseTo(7, 9);
  });

  it('returns a zero-span bbox for a point feature (its vertex)', () => {
    clearLiveLookupCache();
    const v = createVertex(asVertexId('pv'), { lon: 12, lat: -3 });
    const point = createPointFeature(
      asFeatureId('pt'),
      createBasicAttributes('pt', 1000, 1100),
      color,
      v.id,
    );
    const root = addFeature(emptyProject(), point, [v]);
    const bounds = featureBoundsAt(root, T, point.id);
    expect(bounds).toEqual({ minLon: 12, maxLon: 12, minLat: -3, maxLat: -3 });
  });

  it('returns the bbox over a line feature vertices', () => {
    clearLiveLookupCache();
    const v0 = createVertex(asVertexId('lv0'), { lon: -4, lat: 1 });
    const v1 = createVertex(asVertexId('lv1'), { lon: 6, lat: 9 });
    const line = createLineFeature(
      asFeatureId('ln'),
      createBasicAttributes('ln', 1000, 1100),
      color,
      [v0.id, v1.id],
    );
    const root = addFeature(emptyProject(), line, [v0, v1]);
    const bounds = featureBoundsAt(root, T, line.id);
    expect(bounds).toEqual({ minLon: -4, maxLon: 6, minLat: 1, maxLat: 9 });
  });

  it('returns null for a feature absent at the time', () => {
    clearLiveLookupCache();
    const leaf = squareLeaf('leaf');
    const root = addFeature(emptyProject(), leaf.feature, leaf.vertices);
    expect(featureBoundsAt(root, T, asFeatureId('nope'))).toBeNull();
  });

  it('frames an antimeridian-straddling leaf the SHORT way (continuous lon span < 180)', () => {
    clearLiveLookupCache();
    // A square whose east edge is stored folded to -175 (= 185). leafShapeAt aligns it
    // to a continuous run so the bbox is the short (~10°) way, not a ~350° band.
    const vertices = [
      createVertex(asVertexId('w-v0'), { lon: 175, lat: 0 }),
      createVertex(asVertexId('w-v1'), { lon: -175, lat: 0 }),
      createVertex(asVertexId('w-v2'), { lon: -175, lat: 2 }),
      createVertex(asVertexId('w-v3'), { lon: 175, lat: 2 }),
    ];
    const ring = createTerritoryRing(asRingId('r-wrap'), vertices.map((v) => v.id));
    const feature = createLeafFeature(
      asFeatureId('wrap'),
      createBasicAttributes('wrap', 1000, 1100),
      color,
      createShape([ring]),
    );
    const root = addFeature(emptyProject(), feature, vertices);
    const bounds = featureBoundsAt(root, T, feature.id);
    expect(bounds).not.toBeNull();
    const span = bounds!.maxLon - bounds!.minLon;
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(180); // short way, NOT the ~350° folded span
    // The center sits near the seam (±180), the natural short-way framing.
    const center = (bounds!.minLon + bounds!.maxLon) / 2;
    expect(Math.abs(Math.abs(center) - 180)).toBeLessThan(20);
  });

  it('returns the child-union bbox for an aggregate parent', () => {
    clearLiveLookupCache();
    const a = squareLeaf('ca', 0, 0, 2); // [0,2]×[0,2]
    const b = squareLeaf('cb', 2, 0, 2); // [2,4]×[0,2]
    const childA: LeafFeature = { ...a.feature, parentId: asFeatureId('agg') };
    const childB: LeafFeature = { ...b.feature, parentId: asFeatureId('agg') };
    const aggregate = createAggregateFeature(
      asFeatureId('agg'),
      createBasicAttributes('agg', 1000, 1100),
      color,
      [childA.id, childB.id],
    );
    let root = addFeature(emptyProject(), childA, a.vertices);
    root = addFeature(root, childB, b.vertices);
    root = addFeature(root, aggregate, []);
    const bounds = featureBoundsAt(root, T, aggregate.id);
    expect(bounds).not.toBeNull();
    // Union spans both children: [0,4]×[0,2].
    expect(bounds!.minLon).toBeCloseTo(0, 6);
    expect(bounds!.maxLon).toBeCloseTo(4, 6);
    expect(bounds!.minLat).toBeCloseTo(0, 6);
    expect(bounds!.maxLat).toBeCloseTo(2, 6);
  });

  it('returns null for a childless aggregate (empty derived shape)', () => {
    clearLiveLookupCache();
    const aggregate = createAggregateFeature(
      asFeatureId('agg-empty'),
      createBasicAttributes('empty', 1000, 1100),
      color,
      [],
    );
    const root = addFeature(emptyProject(), aggregate, []);
    expect(featureBoundsAt(root, T, aggregate.id)).toBeNull();
  });
});

// --- 全体表示 (fit-all) ------------------------------------------------------
//
// The 表示 → 全体表示 command frames EVERY feature effective at the current time.
// It reuses the SAME per-feature extent resolution as the 錨一覧 fit (featureBoundsAt),
// so a shape that frames correctly from the anchor list frames correctly here too
// (単一真実源 — no second bbox derivation).
describe('allFeaturesBoundsAt (全体表示)', () => {
  it('returns null for a project with no features at the time', () => {
    clearLiveLookupCache();
    expect(allFeaturesBoundsAt(emptyProject(), T)).toBeNull();
  });

  it('unions the extents of every feature effective at the time', () => {
    clearLiveLookupCache();
    const a = squareLeaf('fa', 0, 0, 2); // [0,2]×[0,2]
    const b = squareLeaf('fb', 10, 4, 2); // [10,12]×[4,6]
    let root = addFeature(emptyProject(), a.feature, a.vertices);
    root = addFeature(root, b.feature, b.vertices);
    const bounds = allFeaturesBoundsAt(root, T);
    expect(bounds).not.toBeNull();
    expect(bounds!.minLon).toBeCloseTo(0, 6);
    expect(bounds!.maxLon).toBeCloseTo(12, 6);
    expect(bounds!.minLat).toBeCloseTo(0, 6);
    expect(bounds!.maxLat).toBeCloseTo(6, 6);
  });

  it('ignores features NOT effective at the time', () => {
    clearLiveLookupCache();
    const now = squareLeaf('now', 0, 0, 2); // [0,2]×[0,2], anchored at T
    const later = squareLeaf('later', 50, 50, 2);
    const laterFeature: LeafFeature = {
      ...later.feature,
      attributes: createBasicAttributes('later', 2000, 2100),
    };
    let root = addFeature(emptyProject(), now.feature, now.vertices);
    // Anchored only at year 2000 — it has no state at T, so it must not contribute.
    root = addFeatureAtTime(root, laterFeature, later.vertices, timePointYear(2000));
    const bounds = allFeaturesBoundsAt(root, T);
    expect(bounds).not.toBeNull();
    // Only the 1000..1100 square contributes; the 2000..2100 one is out of time.
    expect(bounds!.maxLon).toBeCloseTo(2, 6);
    expect(bounds!.maxLat).toBeCloseTo(2, 6);
  });

  it('covers point and line features too (not only areas)', () => {
    clearLiveLookupCache();
    const v = createVertex(asVertexId('apv'), { lon: -20, lat: -8 });
    const point = createPointFeature(
      asFeatureId('apt'),
      createBasicAttributes('apt', 1000, 1100),
      color,
      v.id,
    );
    const leaf = squareLeaf('al', 0, 0, 2);
    let root = addFeature(emptyProject(), leaf.feature, leaf.vertices);
    root = addFeature(root, point, [v]);
    const bounds = allFeaturesBoundsAt(root, T);
    expect(bounds).not.toBeNull();
    expect(bounds!.minLon).toBeCloseTo(-20, 6);
    expect(bounds!.minLat).toBeCloseTo(-8, 6);
    expect(bounds!.maxLon).toBeCloseTo(2, 6);
    expect(bounds!.maxLat).toBeCloseTo(2, 6);
  });

  it('an aggregate adds nothing beyond its children (no double counting)', () => {
    clearLiveLookupCache();
    const a = squareLeaf('ga', 0, 0, 2);
    const b = squareLeaf('gb', 2, 0, 2);
    const childA: LeafFeature = { ...a.feature, parentId: asFeatureId('gagg') };
    const childB: LeafFeature = { ...b.feature, parentId: asFeatureId('gagg') };
    const aggregate = createAggregateFeature(
      asFeatureId('gagg'),
      createBasicAttributes('gagg', 1000, 1100),
      color,
      [childA.id, childB.id],
    );
    let root = addFeature(emptyProject(), childA, a.vertices);
    root = addFeature(root, childB, b.vertices);
    root = addFeature(root, aggregate, []);
    const bounds = allFeaturesBoundsAt(root, T);
    expect(bounds).not.toBeNull();
    expect(bounds!.minLon).toBeCloseTo(0, 6);
    expect(bounds!.maxLon).toBeCloseTo(4, 6);
    expect(bounds!.minLat).toBeCloseTo(0, 6);
    expect(bounds!.maxLat).toBeCloseTo(2, 6);
  });

  // --- CROSS-FEATURE seam alignment (review fix HIGH) -----------------------
  //
  // `featureBoundsAt` aligns each feature's OWN box to a continuous run, but the
  // union across features must ALSO be taken on a common branch: a plain
  // Math.min/Math.max over independently-aligned boxes frames the LONG way around
  // the seam, and a box carrying whole +360k turns (an infinite-scroll click never
  // folds longitude — U03) produces a span WIDER than the world.
  it('unions two features across the antimeridian the SHORT way', () => {
    clearLiveLookupCache();
    const east = squareLeaf('sa', 176, 0, 2); // [176,178]
    const west = squareLeaf('sb', -179, 0, 2); // [-179,-177]
    let root = addFeature(emptyProject(), east.feature, east.vertices);
    root = addFeature(root, west.feature, west.vertices);
    const bounds = allFeaturesBoundsAt(root, T);
    expect(bounds).not.toBeNull();
    // The two squares are ~5° apart ACROSS the seam: 176..183 (or the equivalent
    // −184..−177 branch), i.e. a 7° span — NOT the 357° long way round.
    expect(bounds!.maxLon - bounds!.minLon).toBeCloseTo(7, 6);
    // Either branch folds to the same representative center, near the seam.
    const center = (bounds!.minLon + bounds!.maxLon) / 2;
    expect(wrapLonDeg(center)).toBeCloseTo(179.5, 6);
  });

  it('unions a +360-turn replica onto the SAME branch as its neighbour', () => {
    clearLiveLookupCache();
    // Drawn while scrolling east: the stored longitude carries one whole turn, yet
    // the renderer paints it at exactly the same place as the lon≈10 square.
    const home = squareLeaf('ta', 10, 0, 2); // [10,12]
    const turned = squareLeaf('tb', 370, 0, 2); // [370,372] == [10,12] on screen
    let root = addFeature(emptyProject(), home.feature, home.vertices);
    root = addFeature(root, turned.feature, turned.vertices);
    const bounds = allFeaturesBoundsAt(root, T);
    expect(bounds).not.toBeNull();
    // Same place ⇒ the union is the 2° square, not a 362° band.
    expect(bounds!.maxLon - bounds!.minLon).toBeCloseTo(2, 6);
    const center = (bounds!.minLon + bounds!.maxLon) / 2;
    expect(wrapLonDeg(center)).toBeCloseTo(11, 6);
  });

  it('never returns a longitude span WIDER than the world', () => {
    clearLiveLookupCache();
    // Features every 45° all the way round, some stored with +360k turns.
    let root = emptyProject();
    for (let i = 0; i < 8; i += 1) {
      const lon = i * 45 + (i % 2 === 0 ? 720 : 0);
      const leaf = squareLeaf(`w${i}`, lon, 0, 2);
      root = addFeature(root, leaf.feature, leaf.vertices);
    }
    const bounds = allFeaturesBoundsAt(root, T);
    expect(bounds).not.toBeNull();
    expect(bounds!.maxLon - bounds!.minLon).toBeLessThanOrEqual(WORLD_LON_SPAN_DEG);
  });

  // --- FR-113 visibility (review fix MEDIUM) -------------------------------
  //
  // 全体表示 must frame what is DRAWN. A feature hidden by the FR-113 filter /
  // 個別非表示 is never painted, so including its extent would zoom out onto empty
  // space (「絞り込みで1地物だけ表示中なのに全体表示すると全世界へ引く」).
  it('skips features the caller reports as NOT visible', () => {
    clearLiveLookupCache();
    const near = squareLeaf('va', 0, 0, 2); // [0,2]×[0,2]
    const far = squareLeaf('vb', 100, 40, 2); // [100,102]×[40,42]
    let root = addFeature(emptyProject(), near.feature, near.vertices);
    root = addFeature(root, far.feature, far.vertices);
    const bounds = allFeaturesBoundsAt(root, T, {
      isVisible: (id) => id !== far.feature.id,
    });
    expect(bounds).not.toBeNull();
    expect(bounds!.minLon).toBeCloseTo(0, 6);
    expect(bounds!.maxLon).toBeCloseTo(2, 6);
    expect(bounds!.minLat).toBeCloseTo(0, 6);
    expect(bounds!.maxLat).toBeCloseTo(2, 6);
  });

  it('returns null when NOTHING is visible under the filter', () => {
    clearLiveLookupCache();
    const leaf = squareLeaf('vc', 0, 0, 2);
    const root = addFeature(emptyProject(), leaf.feature, leaf.vertices);
    expect(allFeaturesBoundsAt(root, T, { isVisible: () => false })).toBeNull();
  });
});
