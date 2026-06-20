// Bug-hunt property / metamorphic suite for split-merge-knife-geometry.
//
// Focus units: U26 knife split (split-geometry.ts, proposal.ts), U30 merge
// (proposal.ts), U06 boolean ops + invariants. This suite generates RANDOM leaf
// geometries (rectangles, holes, enclaves, nested) and RANDOM cut lines (open +
// closed), then asserts the domain invariants that MUST hold after every
// split / merge:
//
//   - ring alternation (territory -> hole -> territory ...) valid on both sides,
//   - resulting multi-polygon is non-self-crossing + holes contained
//     (isMultiPolygonValid),
//   - no NaN / Infinity in any produced coordinate,
//   - hierarchy forest validity (aggregate childIds == direct children set),
//   - anchor / period ordering (startYear <= endYear) preserved,
//   - area preservation (split sides sum == whole filled area).
//
// Metamorphic relations:
//   - executeSplit re-runs checkSplittable: their sides are identical (idempotent
//     re-validation, the "op == op" determinism contract),
//   - smallerSide is consistent with the two side areas,
//   - split then merge-back (op then inverse-op): union area == original area
//     (op . op^-1 == identity, up to quantization),
//   - save -> load == identity: a JSON serialize/deserialize of the produced
//     geometry round-trips structurally (the persistence-relevant geometry value
//     is a pure plain object).
//
// Determinism: a fixed seed (1001) and a large numRuns are used so the search is
// reproducible. These tests are PERMANENT assets — a real defect must be fixed in
// the domain, never papered over by relaxing an assertion here.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createAggregateFeature, createLeafFeature, type LeafFeature } from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isAlternationValid,
  type Ring,
} from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { buildForest, directChildIds } from '../hierarchy/forest';
import {
  isMultiPolygonValid,
  type GeoMultiPolygon,
  union,
  isOk,
} from '../geometry/index';
import { createClosedKnifeLine, createOpenKnifeLine } from '../knife/knife-line';
import {
  SPLIT_CHECK_STATUS,
  checkSplittable,
  executeSplit,
  smallerSide,
  type SplitSide,
} from '../knife/split-geometry';
import {
  INHERITANCE_SIDE,
  assembleSplitProposal,
  createInheritanceChoice,
  inheritorFeature,
} from '../knife/proposal';
import {
  MERGE_STATUS,
  buildMergeProposal,
} from '../merge/proposal';
import { parentNone, propertyNew } from '../merge/decision';

const SEED = 1001;
const RUNS = 400;

const ATTRS = createBasicAttributes('p', 0, 100);
const COLOR = createColorInfo(true, '#ffffff', '#00ff00', '#000000');

// Unique-id minting across the whole file (ids only need to be distinct).
let counter = 0;
const freshVid = () => asVertexId(`bh-v-${counter++}`);
const freshRid = () => asRingId(`bh-r-${counter++}`);
const idPorts = () => ({
  nextFeatureId: () => asFeatureId(`bh-f-${counter++}`),
  nextVertexId: () => asVertexId(`bh-nv-${counter++}`),
  nextRingId: () => asRingId(`bh-nr-${counter++}`),
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

interface LeafParams {
  readonly w: number;
  readonly h: number;
  readonly leftHole: boolean;
  readonly enclave: boolean;
  readonly rightHole: boolean;
}

function box(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): { coords: WorldCoordinate[]; ids: ReturnType<typeof freshVid>[] } {
  const coords = [
    createCoordinate(x0, y0),
    createCoordinate(x1, y0),
    createCoordinate(x1, y1),
    createCoordinate(x0, y1),
  ];
  return { coords, ids: coords.map(() => freshVid()) };
}

/** A holey leaf at the requested extent; cutX is a vertical line crossing the left hole. */
function holeyLeaf(p: LeafParams): { feature: LeafFeature; store: VertexStore; cutX: number } {
  const { w, h } = p;
  const vertices: Vertex[] = [];
  const rings: Ring[] = [];
  const push = (b: { coords: WorldCoordinate[]; ids: ReturnType<typeof freshVid>[] }) => {
    b.ids.forEach((id, i) => vertices.push(createVertex(id, b.coords[i]!)));
  };

  const outer = box(0, w, 0, h);
  push(outer);
  const tOuter = createTerritoryRing(freshRid(), outer.ids);
  rings.push(tOuter);

  const cutX = w * 0.3;

  if (p.leftHole) {
    const lh = box(w * 0.15, w * 0.45, h * 0.2, h * 0.8);
    push(lh);
    const rLeft = createHoleRing(freshRid(), lh.ids, tOuter.id);
    rings.push(rLeft);
    if (p.enclave) {
      const en = box(w * 0.22, w * 0.38, h * 0.35, h * 0.65);
      push(en);
      rings.push(createTerritoryRing(freshRid(), en.ids, rLeft.id));
    }
  }
  if (p.rightHole) {
    const rh = box(w * 0.6, w * 0.85, h * 0.3, h * 0.7);
    push(rh);
    rings.push(createHoleRing(freshRid(), rh.ids, tOuter.id));
  }

  const feature = createLeafFeature(asFeatureId(`bh-leaf-${counter++}`), ATTRS, COLOR, createShape(rings));
  return { feature, store: createVertexStore(vertices), cutX };
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

function everyCoordFinite(mp: GeoMultiPolygon): boolean {
  for (const poly of mp) {
    for (const ring of poly) {
      for (const c of ring) {
        if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) return false;
      }
    }
  }
  return true;
}

function sideArea(side: SplitSide): number {
  let total = 0;
  for (const poly of side.area) {
    poly.forEach((ring, i) => {
      let s = 0;
      const m = ring.length;
      for (let k = 0; k < m; k += 1) {
        const a = ring[k]!;
        const b = ring[(k + 1) % m]!;
        s += a.lon * b.lat - b.lon * a.lat;
      }
      const a = Math.abs(s) / 2;
      total += i === 0 ? a : -a;
    });
  }
  return total;
}

function filledArea(p: LeafParams): number {
  const outer = p.w * p.h;
  let holes = 0;
  if (p.leftHole) {
    holes += p.w * 0.3 * (p.h * 0.6);
    if (p.enclave) holes -= p.w * 0.16 * (p.h * 0.3);
  }
  if (p.rightHole) holes += p.w * 0.25 * (p.h * 0.4);
  return outer - holes;
}

const dim = fc.double({ min: 20, max: 80, noNaN: true });
const flags = () => fc.record({
  leftHole: fc.boolean(),
  enclave: fc.boolean(),
  rightHole: fc.boolean(),
});

function makeParams(w: number, h: number, f: { leftHole: boolean; enclave: boolean; rightHole: boolean }): LeafParams {
  return { w, h, leftHole: f.leftHole, enclave: f.leftHole && f.enclave, rightHole: f.rightHole };
}

// ---------------------------------------------------------------------------
// 1. Split invariants (open vertical cut across holes / enclaves / nesting)
// ---------------------------------------------------------------------------

describe('split geometry invariants (fast-check, seed=1001)', () => {
  it('open vertical cut: both sides are valid, finite, alternation-correct, area-preserving', () => {
    fc.assert(
      fc.property(dim, dim, flags(), (w, h, f) => {
        const params = makeParams(w, h, f);
        const { feature, store, cutX } = holeyLeaf(params);
        const line = createOpenKnifeLine([
          createCoordinate(cutX, -5),
          createCoordinate(cutX, h + 5),
        ]);
        const res = checkSplittable(feature, store, line);
        expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

        for (const side of [res.sideA, res.sideB]) {
          // No NaN / Infinity.
          expect(everyCoordFinite(side.area)).toBe(true);
          // Valid multi-polygon: simple rings, holes contained, pieces disjoint.
          expect(isMultiPolygonValid(side.area)).toBe(true);
          // Non-empty positive area.
          expect(sideArea(side)).toBeGreaterThan(0);
        }

        // Area preservation (quantization tolerance).
        const sum = sideArea(res.sideA) + sideArea(res.sideB);
        const whole = filledArea(params);
        expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-3);

        // Rebuilt shapes alternate (FR-24) on both sides.
        const proposal = assembleSplitProposal({
          target: feature,
          store: store.byId,
          result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
          choice: createInheritanceChoice(INHERITANCE_SIDE.A),
          nonInherited: { attributes: ATTRS, color: COLOR },
          ids: idPorts(),
        });
        expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
        expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
        // Every minted vertex is finite.
        for (const v of proposal.vertices) {
          expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('random diagonal open cut: whenever splittable, both sides stay valid + finite + area-preserving', () => {
    fc.assert(
      fc.property(
        dim,
        dim,
        flags(),
        fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        (w, h, f, t0, t1) => {
          const params = makeParams(w, h, f);
          const { feature, store } = holeyLeaf(params);
          // A diagonal that enters from below-left and exits above-right; the two
          // crossing offsets t0,t1 vary where it pierces the outer boundary.
          const line = createOpenKnifeLine([
            createCoordinate(-5, h * t0),
            createCoordinate(w * 0.5, h * 0.5),
            createCoordinate(w + 5, h * t1),
          ]);
          const res = checkSplittable(feature, store, line);
          if (res.status !== SPLIT_CHECK_STATUS.Splittable) return; // non-pierce is fine.
          for (const side of [res.sideA, res.sideB]) {
            expect(everyCoordFinite(side.area)).toBe(true);
            expect(isMultiPolygonValid(side.area)).toBe(true);
            expect(sideArea(side)).toBeGreaterThan(0);
          }
          const sum = sideArea(res.sideA) + sideArea(res.sideB);
          const whole = filledArea(params);
          expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-3);
        },
      ),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('closed cut inside the left half: valid finite area-preserving split', () => {
    fc.assert(
      fc.property(dim, dim, fc.boolean(), (w, h, rightHole) => {
        const params = makeParams(w, h, { leftHole: false, enclave: false, rightHole });
        const { feature, store } = holeyLeaf(params);
        const closed = createClosedKnifeLine([
          createCoordinate(w * 0.1, h * 0.1),
          createCoordinate(w * 0.4, h * 0.1),
          createCoordinate(w * 0.4, h * 0.4),
          createCoordinate(w * 0.1, h * 0.4),
        ]);
        const res = checkSplittable(feature, store, closed);
        expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
        for (const side of [res.sideA, res.sideB]) {
          expect(everyCoordFinite(side.area)).toBe(true);
          expect(isMultiPolygonValid(side.area)).toBe(true);
          expect(sideArea(side)).toBeGreaterThan(0);
        }
        const sum = sideArea(res.sideA) + sideArea(res.sideB);
        const whole = filledArea(params);
        expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-3);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Metamorphic: executeSplit == checkSplittable (idempotent re-validation)
// ---------------------------------------------------------------------------

describe('metamorphic: split determinism + smallerSide', () => {
  it('executeSplit reproduces checkSplittable sides exactly; smallerSide is consistent', () => {
    fc.assert(
      fc.property(dim, dim, flags(), (w, h, f) => {
        const params = makeParams(w, h, f);
        const { feature, store, cutX } = holeyLeaf(params);
        const line = createOpenKnifeLine([
          createCoordinate(cutX, -5),
          createCoordinate(cutX, h + 5),
        ]);
        const check = checkSplittable(feature, store, line);
        const exec = executeSplit(feature, store, line);
        if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
          expect(exec).toBeUndefined();
          return;
        }
        expect(exec).toBeDefined();
        if (exec === undefined) return;
        // Re-validation is the identity: same sides, same areas.
        expect(JSON.stringify(exec.sideA.area)).toBe(JSON.stringify(check.sideA.area));
        expect(JSON.stringify(exec.sideB.area)).toBe(JSON.stringify(check.sideB.area));
        expect(exec.sideA.areaKm2).toBe(check.sideA.areaKm2);
        expect(exec.sideB.areaKm2).toBe(check.sideB.areaKm2);
        // smallerSide names the side whose km2 is <= the other.
        const smaller = smallerSide(exec);
        const aK = exec.sideA.areaKm2;
        const bK = exec.sideB.areaKm2;
        if (smaller === 'a') expect(aK).toBeLessThanOrEqual(bK);
        else expect(bK).toBeLessThanOrEqual(aK);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Metamorphic op . op^-1: split then merge-back preserves filled area
// ---------------------------------------------------------------------------

describe('metamorphic: split then merge-back (op . inverse-op == identity area)', () => {
  it('union of the two split sides equals the original filled area, and merge yields one valid leaf', () => {
    fc.assert(
      fc.property(dim, dim, flags(), (w, h, f) => {
        const params = makeParams(w, h, f);
        const { feature, store, cutX } = holeyLeaf(params);
        const line = createOpenKnifeLine([
          createCoordinate(cutX, -5),
          createCoordinate(cutX, h + 5),
        ]);
        const res = checkSplittable(feature, store, line);
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

        // Build the proposal: inheritor keeps the feature id (side A), side B is new.
        const proposal = assembleSplitProposal({
          target: feature,
          store: store.byId,
          result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
          choice: createInheritanceChoice(INHERITANCE_SIDE.A),
          nonInherited: { attributes: ATTRS, color: COLOR },
          ids: idPorts(),
        });
        const inheritor = inheritorFeature(feature, proposal);
        const newLeaf = proposal.newFeature;

        // The post-split vertex store contains all minted vertices.
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        // Direct geometric inverse: union(sideA, sideB) == original filled area.
        const merged = union(res.sideA.area, res.sideB.area);
        expect(isOk(merged)).toBe(true);
        if (!isOk(merged)) return;
        expect(isMultiPolygonValid(merged.result)).toBe(true);
        expect(everyCoordFinite(merged.result)).toBe(true);
        let mergedArea = 0;
        for (const poly of merged.result) {
          poly.forEach((ring, i) => {
            let s = 0;
            const m = ring.length;
            for (let k = 0; k < m; k += 1) {
              const a = ring[k]!;
              const b = ring[(k + 1) % m]!;
              s += a.lon * b.lat - b.lon * a.lat;
            }
            const ar = Math.abs(s) / 2;
            mergedArea += i === 0 ? ar : -ar;
          });
        }
        const whole = filledArea(params);
        expect(Math.abs(mergedArea - whole) / whole).toBeLessThan(1e-3);

        // Domain merge of the two leaf features back into one.
        const mergeRes = buildMergeProposal({
          features: [inheritor, newLeaf],
          vertices: postStore,
          targetIds: [inheritor.id, newLeaf.id],
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
          ids: idPorts(),
        });
        expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
        if (mergeRes.status !== MERGE_STATUS.Proposal) return;
        const mp = mergeRes.proposal;
        // Exactly one result leaf, original two consumed.
        const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
        expect(result?.kind).toBe('leaf');
        expect(mp.nextFeatures.find((x) => x.id === inheritor.id)).toBeUndefined();
        expect(mp.nextFeatures.find((x) => x.id === newLeaf.id)).toBeUndefined();
        // Result leaf shape alternates and references only finite vertices.
        if (result && result.kind === 'leaf') {
          expect(isAlternationValid(result.shape)).toBe(true);
          for (const ring of result.shape.rings) {
            for (const vid of ring.vertexIds) {
              const v = mp.nextVertices.byId.get(vid);
              expect(v).toBeDefined();
              if (v) expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
            }
          }
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Merge forest validity: childIds == direct children set (hierarchy 妥当)
// ---------------------------------------------------------------------------

describe('merge hierarchy / forest validity (fast-check, seed=1001)', () => {
  it('aggregate merge: result aggregate childIds equal its direct children (派生集約 = 子の和)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 5 }), (numAgg) => {
        const features = [];
        const verts: Vertex[] = [];
        const aggIds = [];
        for (let i = 0; i < numAgg; i += 1) {
          const aggId = asFeatureId(`bh-A-${counter++}`);
          aggIds.push(aggId);
          // one child leaf per aggregate.
          const lb = box(i * 100, i * 100 + 50, 0, 50);
          lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
          const childId = asFeatureId(`bh-c-${counter++}`);
          features.push(
            createLeafFeature(
              childId,
              createBasicAttributes(`c${i}`, 0, 100),
              COLOR,
              createShape([createTerritoryRing(freshRid(), lb.ids)]),
              { parentId: aggId },
            ),
          );
          features.push(
            createAggregateFeature(aggId, createBasicAttributes(`A${i}`, 0, 100), COLOR, [childId]),
          );
        }
        const vertices = createVertexStore(verts);
        const r = buildMergeProposal({
          features,
          vertices,
          targetIds: aggIds,
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: propertyNew({ attributes: createBasicAttributes('agg', 0, 100), color: COLOR }),
          ids: idPorts(),
        });
        expect(r.status).toBe(MERGE_STATUS.Proposal);
        if (r.status !== MERGE_STATUS.Proposal) return;
        const p = r.proposal;
        const forest = buildForest(p.nextFeatures);
        // For every aggregate in the result, its declared childIds == the forest's
        // direct children (the "derived aggregate = sum of children" invariant).
        for (const fe of p.nextFeatures) {
          if (fe.kind !== 'aggregate') continue;
          const declared = [...fe.childIds].sort();
          const actual = [...directChildIds(forest, fe.id)].sort();
          expect(declared).toEqual(actual);
        }
        // No duplicate feature ids.
        const ids = p.nextFeatures.map((x) => x.id);
        expect(new Set(ids).size).toBe(ids.length);
        // Period ordering preserved on result.
        const result = p.nextFeatures.find((x) => x.id === p.resultFeatureId);
        expect(result).toBeDefined();
        if (result) expect(result.attributes.startYear).toBeLessThanOrEqual(result.attributes.endYear);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. save -> load == identity on produced geometry (structural round-trip)
// ---------------------------------------------------------------------------

describe('save -> load identity (geometry round-trip, seed=1001)', () => {
  it('a split side multi-polygon JSON-round-trips structurally (恒等)', () => {
    fc.assert(
      fc.property(dim, dim, flags(), (w, h, f) => {
        const params = makeParams(w, h, f);
        const { feature, store, cutX } = holeyLeaf(params);
        const line = createOpenKnifeLine([
          createCoordinate(cutX, -5),
          createCoordinate(cutX, h + 5),
        ]);
        const res = checkSplittable(feature, store, line);
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
        for (const side of [res.sideA, res.sideB]) {
          const saved = JSON.stringify(side.area);
          const loaded = JSON.parse(saved) as GeoMultiPolygon;
          // load(save(x)) == x structurally, and the reloaded value is still valid.
          expect(JSON.stringify(loaded)).toBe(saved);
          expect(isMultiPolygonValid(loaded)).toBe(true);
          expect(everyCoordFinite(loaded)).toBe(true);
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});
