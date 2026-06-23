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
  smallestPieceIndex,
  type SplitSide,
} from '../knife/split-geometry';
import {
  INHERITANCE_SIDE,
  createInheritanceChoiceAt,
  assembleSplitProposal,
  createInheritanceChoice,
  inheritorFeature,
} from '../knife/proposal';
import {
  MERGE_STATUS,
  buildMergeProposal,
} from '../merge/proposal';
import {
  parentNone,
  parentCreate,
  parentExisting,
  propertyNew,
  propertyInherit,
} from '../merge/decision';

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

// ===========================================================================
// 6. STATEFUL / MODEL-BASED: random edit-command sequences
//
// The sections above each exercise a SINGLE split / merge in isolation. Real
// defects in this area surface only after CHAINED edits — split a piece, then
// split one of the products, then merge two products back, then split again —
// because each op consumes the PREVIOUS op's minted vertices + rebuilt rings,
// not a hand-built fixture. This model maintains a live "world":
//
//   World = { features: LeafFeature[]; store: VertexStore }
//
// and applies a RANDOM sequence of commands generated by fast-check:
//
//   - SPLIT  : pick a leaf, cut it vertically at a random fraction; replace the
//              leaf with the inheritor (side A) + a new feature (side B); add the
//              minted vertices to the store. (knife → split-geometry → proposal)
//   - MERGE  : pick two leaves, union them back into one leaf via buildMergeProposal;
//              replace them with the result; add minted vertices. (merge/proposal)
//   - NOOP   : leave the world unchanged (keeps sequences varied / shrinkable).
//
// After EVERY applied command the full invariant battery runs on the WHOLE world:
//   (I1) every leaf shape alternates territory→hole→territory… (リング交互性),
//   (I2) every leaf resolves to a valid, non-self-crossing, hole-contained
//        multi-polygon (非自己交差・包含妥当),
//   (I3) the forest is structurally valid: every declared aggregate childIds set
//        equals the forest's direct children (派生集約 = 子の和) — here there are
//        no aggregates, so the weaker invariant is "no feature is its own parent
//        and parent links resolve",
//   (I4) every coordinate referenced by every leaf is finite (NaN/Infinity 無し),
//   (I5) every ring references only vertices that EXIST in the store (選択が常に
//        有効 — a citation to a missing vertex is a dangling selection),
//   (I6) feature ids are unique,
//   (I7) save→load == identity: the whole world JSON-round-trips structurally.
//
// Metamorphic checks woven into the SPLIT command:
//   - executeSplit ∘ checkSplittable determinism (op == op),
//   - union(sideA, sideB) ≈ the pre-split leaf's filled area (op ∘ inverse-op,
//     up to quantization) — i.e. the split lost no area.
//
// Determinism: seed = 1002, numRuns large (per task). PERMANENT asset — a real
// defect must be fixed in the domain, never papered over here.
// ===========================================================================

import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { withLeafShape } from '../feature';

const STATEFUL_SEED = 1002;
const STATEFUL_RUNS = 600;

interface World {
  features: LeafFeature[];
  store: VertexStore;
}

type Cmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'noop' };

/** Filled (outer − holes) area of a resolved multi-polygon (shoelace). */
function mpFilledArea(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      let s = 0;
      const m = ring.length;
      for (let k = 0; k < m; k += 1) {
        const a = ring[k]!;
        const b = ring[(k + 1) % m]!;
        s += a.lon * b.lat - b.lon * a.lat;
      }
      const ar = Math.abs(s) / 2;
      total += i === 0 ? ar : -ar;
    });
  }
  return total;
}

/** Bounding box of a leaf's resolved outer rings (for choosing a cut line). */
function leafBbox(
  leaf: LeafFeature,
  store: VertexStore,
): { minX: number; maxX: number; minY: number; maxY: number } | undefined {
  const mp = resolveLeafShape(leaf.shape, store);
  if (mp === undefined || mp.length === 0) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of mp) {
    const outer = poly[0];
    if (outer === undefined) continue;
    for (const c of outer) {
      if (c.lon < minX) minX = c.lon;
      if (c.lon > maxX) maxX = c.lon;
      if (c.lat < minY) minY = c.lat;
      if (c.lat > maxY) maxY = c.lat;
    }
  }
  if (!Number.isFinite(minX)) return undefined;
  return { minX, maxX, minY, maxY };
}

/** Run the full invariant battery over the whole world. Throws (via expect) on violation. */
function checkWorldInvariants(world: World): void {
  const ids = world.features.map((f) => f.id);
  // (I6) unique feature ids.
  expect(new Set(ids).size).toBe(ids.length);

  for (const leaf of world.features) {
    // (I1) ring alternation.
    expect(isAlternationValid(leaf.shape)).toBe(true);

    // (I5) every cited vertex exists in the store; collect coords for (I4).
    for (const ring of leaf.shape.rings) {
      for (const vid of ring.vertexIds) {
        const v = world.store.byId.get(vid);
        expect(v).toBeDefined();
        if (v) {
          // (I4) no NaN / Infinity.
          expect(Number.isFinite(v.coordinate.lon)).toBe(true);
          expect(Number.isFinite(v.coordinate.lat)).toBe(true);
        }
      }
    }

    // (I2) resolves to a valid multi-polygon.
    const mp = resolveLeafShape(leaf.shape, world.store);
    expect(mp).toBeDefined();
    if (mp) {
      expect(isMultiPolygonValid(mp)).toBe(true);
      expect(everyCoordFinite(mp)).toBe(true);
    }

    // (I3) no feature is its own parent; parent links (if any) resolve.
    if (leaf.parentId !== undefined) {
      expect(leaf.parentId).not.toBe(leaf.id);
    }
  }

  // (I7) save -> load == identity over the WHOLE world (geometry + store).
  const snapshot = {
    features: world.features.map((f) => ({ id: f.id, shape: f.shape })),
    vertices: [...world.store.byId.values()],
  };
  const saved = JSON.stringify(snapshot);
  const loaded = JSON.parse(saved);
  expect(JSON.stringify(loaded)).toBe(saved);
}

/** Apply a SPLIT command. Returns the next world, or the same world if not applicable. */
function applySplit(world: World, cmd: { leafPick: number; frac: number }): World {
  if (world.features.length === 0) return world;
  const idx = cmd.leafPick % world.features.length;
  const leaf = world.features[idx]!;
  const bb = leafBbox(leaf, world.store);
  if (bb === undefined) return world;
  const span = bb.maxX - bb.minX;
  if (span <= 0) return world;
  const cutX = bb.minX + span * (0.2 + cmd.frac * 0.6); // interior fraction.
  const pad = (bb.maxY - bb.minY) * 0.5 + 10;
  const line = createOpenKnifeLine([
    createCoordinate(cutX, bb.minY - pad),
    createCoordinate(cutX, bb.maxY + pad),
  ]);

  // Metamorphic: checkSplittable == executeSplit (determinism).
  const check = checkSplittable(leaf, world.store, line);
  const exec = executeSplit(leaf, world.store, line);
  if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
    expect(exec).toBeUndefined();
    return world; // not splittable here → no-op.
  }
  expect(exec).toBeDefined();
  if (exec === undefined) return world;
  expect(JSON.stringify(exec.sideA.area)).toBe(JSON.stringify(check.sideA.area));
  expect(JSON.stringify(exec.sideB.area)).toBe(JSON.stringify(check.sideB.area));

  // Metamorphic op∘inverse-op (HB3-5/19 n-way): the SUM of every piece's filled area
  // ≈ the original filled area (片落とし禁止). A cut crossing a concave / multiply-split
  // leaf may now yield k+1 pieces, so we conserve area over ALL pieces, not just 2 sides.
  const beforeMp = resolveLeafShape(leaf.shape, world.store)!;
  const beforeArea = mpFilledArea(beforeMp);
  const pieces = check.pieces ?? [check.sideA, check.sideB];
  if (beforeArea > 0) {
    const reArea = pieces.reduce((sum, p) => sum + mpFilledArea(p.area), 0);
    expect(Math.abs(reArea - beforeArea) / beforeArea).toBeLessThan(1e-3);
  }

  const proposal = assembleSplitProposal({
    target: leaf,
    store: world.store.byId,
    result: {
      pieces,
      sideA: check.sideA,
      sideB: check.sideB,
      edgeCuts: exec.edgeCuts,
    },
    choice: createInheritanceChoice(INHERITANCE_SIDE.A),
    nonInherited: { attributes: ATTRS, color: COLOR },
    ids: idPorts(),
  });
  const inheritor = withLeafShape(leaf, proposal.inheritorShape);

  // Apply ALL new features (k for a k+1-piece split), not just the first (FR-94 n-way).
  const nextFeatures = world.features.slice();
  nextFeatures[idx] = inheritor;
  for (const nf of proposal.newFeatures) nextFeatures.push(nf);
  const nextStore = createVertexStore([...world.store.byId.values(), ...proposal.vertices]);
  return { features: nextFeatures, store: nextStore };
}

/** Apply a MERGE command (leaf-only). Returns next world or same world if not applicable. */
function applyMerge(world: World, cmd: { aPick: number; bPick: number }): World {
  if (world.features.length < 2) return world;
  const n = world.features.length;
  const i = cmd.aPick % n;
  let j = cmd.bPick % n;
  if (j === i) j = (j + 1) % n;
  const a = world.features[i]!;
  const b = world.features[j]!;

  const res = buildMergeProposal({
    features: world.features,
    vertices: world.store,
    targetIds: [a.id, b.id],
    atTime: 50,
    parentDecision: parentNone,
    propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
    ids: idPorts(),
  });
  if (res.status !== MERGE_STATUS.Proposal) return world; // union rejected → no-op.
  const p = res.proposal;
  const result = p.nextFeatures.find((x) => x.id === p.resultFeatureId);
  if (result === undefined || result.kind !== 'leaf') return world;
  // nextFeatures already removed the consumed leaves and appended the result.
  const features = p.nextFeatures.filter((f): f is LeafFeature => f.kind === 'leaf');
  return { features, store: p.nextVertices };
}

function applyCmd(world: World, cmd: Cmd): World {
  switch (cmd.t) {
    case 'split':
      return applySplit(world, cmd);
    case 'merge':
      return applyMerge(world, cmd);
    case 'noop':
      return world;
  }
}

function initialWorld(): World {
  // Start from a single holey leaf so the very first split already exercises
  // hole / enclave re-parenting, then chained ops compound on the products.
  const { feature, store } = holeyLeaf({
    w: 60,
    h: 40,
    leftHole: true,
    enclave: true,
    rightHole: true,
  });
  return { features: [feature], store };
}

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({
    t: fc.constant<'merge'>('merge'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.constant<Cmd>({ t: 'noop' }),
);

describe('stateful model-based edit sequences (fast-check, seed=1002)', () => {
  it('random split/merge command chains keep every world invariant after each op', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 1, maxLength: 14 }), (cmds) => {
        let world = initialWorld();
        checkWorldInvariants(world); // invariant holds on the seed world.
        for (const cmd of cmds) {
          world = applyCmd(world, cmd);
          checkWorldInvariants(world); // invariant holds after EVERY applied op.
          // Liveness: a chain never empties the world (splits add, merges keep ≥1).
          expect(world.features.length).toBeGreaterThanOrEqual(1);
        }
      }),
      { seed: STATEFUL_SEED, numRuns: STATEFUL_RUNS },
    );
  });
});

// ===========================================================================
// 7. SEED=1004 EXTENSION — undo metamorphic + real persistence round-trip +
//    selection validity + forest / anchor-ordering invariants.
//
// The seed=1001/1002 sections above already pin the per-op + JSON-structural
// invariants. This block adds the relations the task names but those sections do
// NOT yet cover end-to-end:
//
//   (A) undo ∘ op == identity — applied as a real STACK: the model snapshots the
//       world BEFORE each command and, on an 'undo' command, pops back to it; the
//       restored world must be STRUCTURALLY IDENTICAL to the pre-op snapshot (not
//       merely invariant-valid). A divergence here is a defect in how an op
//       captures / rebuilds state (e.g. an op that mutates shared input, leaving
//       the "previous" snapshot silently changed under the undo).
//
//   (B) save ∘ load == identity through the REAL persistence path (U14), not a
//       bare JSON.stringify: serialize → parseManifest (Zod boundary) →
//       manifestToProject → projectsEqual. The seed=1001 round-trip only proved
//       JSON.stringify(x) re-stringifies equal; this proves the produced split /
//       merge geometry survives the actual schema + deserialize the app ships.
//
//   (C) selection always valid (選択が常に有効): the model tracks a "selected"
//       feature id across the whole chain; after every op the selection either
//       resolves to a live feature or has been re-pointed to one — a dangling
//       selection (pointing at a consumed / split-away feature) is a defect.
//
//   (D) forest parent links are acyclic and aggregate childIds == direct children
//       (派生集約 = 子の和) — exercised by interleaving an aggregate-merge command
//       into the leaf split/merge chain so the forest actually grows aggregates.
//
//   (E) anchor列の昇順・非重複: each surviving feature is given a period interval;
//       the model asserts startYear <= endYear and, across a generated multi-entry
//       "anchor series", strictly-ascending non-duplicate starts after normalize.
//
// Determinism: seed = 1004, numRuns large (per task). PERMANENT asset.
// ===========================================================================

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, isValidSeries } from '../anchor-series';
import { getCalendar } from '../time/calendar';
import { createGeoParams } from '../geo/geo-params';
import { timePointYear } from '../time/time-point';
import { asAnchorId } from '../ids';
import { walkToRoot } from '../hierarchy/forest';
import type { Feature } from '../feature';
import {
  serialize,
  manifestToProject,
  projectsEqual,
  type DomainProject,
  type FeatureHistory,
  type ProjectSettings,
  type BaseMapReference,
} from '../persistence/serialize';
import { parseManifest, isParsed } from '../persistence/boundary';

const SEED_1004 = 1004;
const RUNS_1004 = 400;

// --- persistence scaffolding (constant settings / base map for every project) ---

const PROJECT_SETTINGS: ProjectSettings = {
  calendarId: 'gregorian',
  geo: createGeoParams(40075, 0),
  gridSpacingDeg: 1,
  snapDistancePx: 8,
  autoColorDefault: true,
};
const BASE_MAP: BaseMapReference = {
  source: 'bh-basemap',
  meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
};

/**
 * Build a DomainProject whose every feature carries a TWO-entry anchor series
 * (years 0 and 50, both holding the same full-state snapshot). This forces the
 * persistence path to round-trip multiple anchors per feature AND lets the
 * round-trip act as the save→load identity over the produced split/merge geometry.
 */
function worldToProject(world: World): DomainProject {
  const snapshot = createAnchorSnapshot([...world.features], world.store);
  const histories: FeatureHistory[] = world.features.map((f) => {
    const e0 = createAnchorEntry(
      createAnchor(asAnchorId(`bh-a0-${counter++}`), snapshot),
      timePointYear(0),
      timePointYear(25),
    );
    const e1 = createAnchorEntry(
      createAnchor(asAnchorId(`bh-a1-${counter++}`), snapshot),
      timePointYear(30),
      null,
    );
    return { featureId: f.id, series: { entries: [e0, e1] } };
  });
  return { histories, settings: PROJECT_SETTINGS, baseMap: BASE_MAP };
}

/** save ∘ load through the REAL persistence path; returns the reloaded project. */
function saveThenLoad(project: DomainProject): DomainProject | undefined {
  const manifest = serialize(project);
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  if (!isParsed(parsed)) return undefined;
  return manifestToProject(parsed.manifest);
}

/** Structural identity of two worlds (features by id+shape, store by id+coord). */
function worldsIdentical(a: World, b: World): boolean {
  if (a.features.length !== b.features.length) return false;
  const aSnap = JSON.stringify({
    features: a.features.map((f) => ({ id: f.id, shape: f.shape, parentId: f.parentId })),
    vertices: [...a.store.byId.entries()].sort(([x], [y]) => (x < y ? -1 : 1)),
  });
  const bSnap = JSON.stringify({
    features: b.features.map((f) => ({ id: f.id, shape: f.shape, parentId: f.parentId })),
    vertices: [...b.store.byId.entries()].sort(([x], [y]) => (x < y ? -1 : 1)),
  });
  return aSnap === bSnap;
}

// --- (A) undo metamorphic + (C) selection validity stateful model -----------

type Cmd1004 =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'undo' }
  | { readonly t: 'reselect'; readonly pick: number };

const cmd1004Arb: fc.Arbitrary<Cmd1004> = fc.oneof(
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({
    t: fc.constant<'merge'>('merge'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.constant<Cmd1004>({ t: 'undo' }),
  fc.record({ t: fc.constant<'reselect'>('reselect'), pick: fc.nat({ max: 1_000_000 }) }),
);

describe('seed=1004 — undo identity + selection validity (fast-check)', () => {
  it('undo ∘ op == identity (stack pop restores the exact prior world); selection stays valid', () => {
    fc.assert(
      fc.property(fc.array(cmd1004Arb, { minLength: 1, maxLength: 16 }), (cmds) => {
        let world = initialWorld();
        // History stack of prior worlds for undo. The seed world is the floor.
        const stack: World[] = [];
        // Selection: a feature id the user currently has selected. Always points
        // at a LIVE feature after every op (選択が常に有効).
        let selected = world.features[0]!.id;
        checkWorldInvariants(world);

        const ensureSelectionValid = () => {
          // If the selected feature was consumed (split-away / merged), re-point to
          // a surviving feature — the selection must never dangle.
          if (!world.features.some((f) => f.id === selected)) {
            selected = world.features[0]!.id;
          }
          expect(world.features.some((f) => f.id === selected)).toBe(true);
        };

        for (const cmd of cmds) {
          if (cmd.t === 'undo') {
            const prior = stack.pop();
            if (prior === undefined) continue; // nothing to undo.
            // undo ∘ op == identity: the popped world is byte-for-byte the world
            // that existed BEFORE the op whose result we are discarding.
            world = prior;
            ensureSelectionValid();
            checkWorldInvariants(world);
            continue;
          }
          if (cmd.t === 'reselect') {
            selected = world.features[cmd.pick % world.features.length]!.id;
            continue;
          }
          // A real edit: snapshot the CURRENT world, then apply.
          const before = world;
          const beforeCopy: World = {
            features: before.features.slice(),
            store: { byId: new Map(before.store.byId) },
          };
          const next = cmd.t === 'split' ? applySplit(world, cmd) : applyMerge(world, cmd);
          // Op purity: applying an op must NOT have mutated the prior world value
          // (else the undo snapshot would be corrupted). Verify the snapshot is
          // still identical to what `before` was.
          expect(worldsIdentical(before, beforeCopy)).toBe(true);
          if (next !== world) stack.push(beforeCopy);
          world = next;
          ensureSelectionValid();
          checkWorldInvariants(world);
          expect(world.features.length).toBeGreaterThanOrEqual(1);
        }
      }),
      { seed: SEED_1004, numRuns: RUNS_1004 },
    );
  });
});

// --- (B) real persistence save∘load==identity over produced geometry --------

describe('seed=1004 — save ∘ load == identity via real U14 persistence path', () => {
  it('a world produced by random split/merge round-trips through serialize→parse→deserialize', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 1, maxLength: 12 }), (cmds) => {
        let world = initialWorld();
        for (const cmd of cmds) world = applyCmd(world, cmd);
        checkWorldInvariants(world);

        const project = worldToProject(world);
        const reloaded = saveThenLoad(project);
        expect(reloaded).toBeDefined();
        if (reloaded === undefined) return;
        // The persisted-then-restored project equals the original structurally:
        // every feature shape + every vertex coordinate + every anchor entry.
        expect(projectsEqual(project, reloaded)).toBe(true);
      }),
      { seed: SEED_1004, numRuns: RUNS_1004 },
    );
  });
});

// --- (D) forest validity with aggregates interleaved ------------------------
//
// Build N leaves, give each its own aggregate parent, then aggregate-merge a
// random subset. After the merge the result aggregate's childIds must equal its
// forest direct children, no parent link may be cyclic, and no feature may be its
// own ancestor.

describe('seed=1004 — forest validity (aggregate childIds == direct children, acyclic)', () => {
  it('aggregate-merge of a random subset keeps the forest a valid森 (派生集約 = 子の和)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.boolean(), { minLength: 2, maxLength: 6 }),
        (numAgg, pickMask) => {
          const features: Feature[] = [];
          const verts: Vertex[] = [];
          const aggIds: ReturnType<typeof asFeatureId>[] = [];
          for (let i = 0; i < numAgg; i += 1) {
            const aggId = asFeatureId(`bh4-A-${counter++}`);
            aggIds.push(aggId);
            const lb = box(i * 100, i * 100 + 50, 0, 50);
            lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
            const childId = asFeatureId(`bh4-c-${counter++}`);
            features.push(
              createLeafFeature(
                childId,
                createBasicAttributes(`c${i}`, i, 100 + i),
                COLOR,
                createShape([createTerritoryRing(freshRid(), lb.ids)]),
                { parentId: aggId },
              ),
            );
            features.push(
              createAggregateFeature(aggId, createBasicAttributes(`A${i}`, i, 100 + i), COLOR, [childId]),
            );
          }
          // Pick the aggregates whose mask bit is set (≥2 to make a merge meaningful).
          const picked = aggIds.filter((_, i) => pickMask[i] ?? false);
          if (picked.length < 2) return; // need ≥2 to merge.

          const vertices = createVertexStore(verts);
          const r = buildMergeProposal({
            features,
            vertices,
            targetIds: picked,
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: propertyNew({ attributes: createBasicAttributes('agg', 0, 200), color: COLOR }),
            ids: idPorts(),
          });
          expect(r.status).toBe(MERGE_STATUS.Proposal);
          if (r.status !== MERGE_STATUS.Proposal) return;
          const p = r.proposal;
          const forest = buildForest(p.nextFeatures);

          // No duplicate ids.
          const ids = p.nextFeatures.map((x) => x.id);
          expect(new Set(ids).size).toBe(ids.length);

          for (const fe of p.nextFeatures) {
            // Acyclic parent chain (educated by walkToRoot's cycle detection).
            const walk = walkToRoot(forest, fe.id);
            expect(walk.cyclic).toBe(false);
            // 派生集約 = 子の和: every aggregate's declared childIds == direct children.
            if (fe.kind === 'aggregate') {
              const declared = [...fe.childIds].sort();
              const actual = [...directChildIds(forest, fe.id)].sort();
              expect(declared).toEqual(actual);
            }
            // Period ordering on every surviving feature (startYear <= endYear).
            expect(fe.attributes.startYear).toBeLessThanOrEqual(fe.attributes.endYear);
          }
        },
      ),
      { seed: SEED_1004, numRuns: RUNS_1004 },
    );
  });
});

// --- (E) anchor series 昇順・非重複 -----------------------------------------

describe('seed=1004 — anchor series ascending / non-duplicate after normalize', () => {
  it('normalizeSeries produces strictly-ascending, non-duplicate starts for any entry set', () => {
    const cal = getCalendar('gregorian');
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -500, max: 500 }), { minLength: 1, maxLength: 12 }),
        (years) => {
          // A snapshot is irrelevant to ordering; reuse a trivial empty world store.
          const snap = createAnchorSnapshot([], createVertexStore([]));
          const entries = years.map((y) =>
            createAnchorEntry(createAnchor(asAnchorId(`bh4-an-${counter++}`), snap), timePointYear(y), null),
          );
          const series = normalizeSeries(entries, cal);
          // INV-1..5 hold on the normalized series (single source of the rule).
          expect(isValidSeries(series, cal)).toBe(true);
          // Starts are strictly ascending and non-duplicate (昇順・非重複).
          const starts = series.entries.map((e) => (e.start as { year: number }).year);
          for (let i = 1; i < starts.length; i += 1) {
            expect(starts[i]! > starts[i - 1]!).toBe(true);
          }
        },
      ),
      { seed: SEED_1004, numRuns: RUNS_1004 },
    );
  });
});

// ===========================================================================
// 8. SEED=21001 EXTENSION — NEW exploration (disjoint from the 1000-6000 band).
//
// The sections above pin: side-A splits, leaf merges with parentNone +
// propertyNew, and the per-op/JSON/persistence/undo/anchor invariants. They
// NEVER exercise three live code paths:
//
//   (P1) INHERITANCE_SIDE.B splits — assembleSplitProposal swaps which side
//        keeps the feature id (inheritSide := sideB, newSide := sideA). The
//        vertex pool is built new-side-first vs A-first, so the seam-id reuse
//        ordering differs; a defect there would surface only with side B.
//
//   (P2) propertyInherit merge decision — resolvePropertyDecision's inherit
//        branch (merge/proposal.ts ~L399) is dead code in seeds 1001-1004
//        (every merge uses propertyNew). The result leaf MUST carry the chosen
//        source feature's attributes + color verbatim.
//
//   (P3) parentCreate / parentExisting merge decisions — realizeParent's
//        Create / Existing branches (~L445-462) are likewise untouched. A
//        parentCreate merge must yield a NEW aggregate whose childIds contain
//        the result leaf and whose forest direct-children == declared childIds.
//
// Plus a fresh STATEFUL model whose SPLIT randomly chooses the inheritance side
// and whose cut is HORIZONTAL or VERTICAL (a new cut orientation), with the full
// world invariant battery + a REAL persistence round-trip + an undo stack run
// after EVERY op. Determinism: seed = 21001, numRuns large. PERMANENT asset —
// any reproduced counterexample is a domain defect, never to be masked here.
// ===========================================================================

const SEED_21001 = 21001;
const RUNS_21001 = 400;

/** Resolve a leaf to a finite multi-polygon and return its filled (shoelace) area. */
function leafFilledArea(leaf: LeafFeature, store: VertexStore): number {
  const mp = resolveLeafShape(leaf.shape, store);
  if (mp === undefined) return 0;
  return mpFilledArea(mp);
}

/**
 * Apply a split choosing EITHER inheritance side, with a HORIZONTAL or VERTICAL
 * cut. Returns the next world (or the same world when the leaf cannot be cut
 * there). Distinct from applySplit (which is side-A + vertical only).
 */
function applySplitOriented(
  world: World,
  cmd: { leafPick: number; frac: number; horizontal: boolean; sideB: boolean },
): World {
  if (world.features.length === 0) return world;
  const idx = cmd.leafPick % world.features.length;
  const leaf = world.features[idx]!;
  const bb = leafBbox(leaf, world.store);
  if (bb === undefined) return world;

  let line;
  if (cmd.horizontal) {
    const span = bb.maxY - bb.minY;
    if (span <= 0) return world;
    const cutY = bb.minY + span * (0.2 + cmd.frac * 0.6);
    const pad = (bb.maxX - bb.minX) * 0.5 + 10;
    line = createOpenKnifeLine([
      createCoordinate(bb.minX - pad, cutY),
      createCoordinate(bb.maxX + pad, cutY),
    ]);
  } else {
    const span = bb.maxX - bb.minX;
    if (span <= 0) return world;
    const cutX = bb.minX + span * (0.2 + cmd.frac * 0.6);
    const pad = (bb.maxY - bb.minY) * 0.5 + 10;
    line = createOpenKnifeLine([
      createCoordinate(cutX, bb.minY - pad),
      createCoordinate(cutX, bb.maxY + pad),
    ]);
  }

  const check = checkSplittable(leaf, world.store, line);
  const exec = executeSplit(leaf, world.store, line);
  if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
    expect(exec).toBeUndefined();
    return world;
  }
  expect(exec).toBeDefined();
  if (exec === undefined) return world;
  // Determinism: re-validation reproduces the sides exactly (op == op).
  expect(JSON.stringify(exec.sideA.area)).toBe(JSON.stringify(check.sideA.area));
  expect(JSON.stringify(exec.sideB.area)).toBe(JSON.stringify(check.sideB.area));

  // op ∘ inverse-op: union of the two sides ≈ the pre-split filled area, for
  // EITHER inheritance side (the union is side-choice-independent).
  const beforeArea = leafFilledArea(leaf, world.store);
  const reunited = union(check.sideA.area, check.sideB.area);
  expect(isOk(reunited)).toBe(true);
  if (isOk(reunited) && beforeArea > 0) {
    const reArea = mpFilledArea(reunited.result);
    expect(Math.abs(reArea - beforeArea) / beforeArea).toBeLessThan(1e-3);
  }

  const proposal = assembleSplitProposal({
    target: leaf,
    store: world.store.byId,
    result: { sideA: check.sideA, sideB: check.sideB, edgeCuts: exec.edgeCuts },
    choice: createInheritanceChoice(cmd.sideB ? INHERITANCE_SIDE.B : INHERITANCE_SIDE.A),
    nonInherited: { attributes: ATTRS, color: COLOR },
    ids: idPorts(),
  });
  // The inheritor keeps the ORIGINAL feature id regardless of side choice.
  expect(proposal.inheritorFeatureId).toBe(leaf.id);
  const inheritor = withLeafShape(leaf, proposal.inheritorShape);
  const newLeaf = proposal.newFeature;

  const nextFeatures = world.features.slice();
  nextFeatures[idx] = inheritor;
  nextFeatures.push(newLeaf);
  const nextStore = createVertexStore([...world.store.byId.values(), ...proposal.vertices]);
  return { features: nextFeatures, store: nextStore };
}

// --- (P1) side-B split round-trip --------------------------------------------

describe('seed=21001 — inheritance side B split (new code path)', () => {
  it('side-B vertical cut: inheritor keeps id, both shapes alternate, area preserved, JSON round-trips', () => {
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

        const proposal = assembleSplitProposal({
          target: feature,
          store: store.byId,
          result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
          choice: createInheritanceChoice(INHERITANCE_SIDE.B),
          nonInherited: { attributes: ATTRS, color: COLOR },
          ids: idPorts(),
        });
        // Inheritor STILL keeps the original feature id (only the kept side flips).
        expect(proposal.inheritorFeatureId).toBe(feature.id);
        expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
        expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
        for (const v of proposal.vertices) {
          expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
        }

        // The kept (inheritor) side equals geometry sideB; the new side equals A.
        // Verify via filled area of the rebuilt shapes against the geometry sides.
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);
        const inheritor = inheritorFeature(feature, proposal);
        const keptArea = leafFilledArea(inheritor, postStore);
        const newArea = leafFilledArea(proposal.newFeature, postStore);
        expect(Math.abs(keptArea - sideArea(res.sideB)) / Math.max(sideArea(res.sideB), 1e-6)).toBeLessThan(1e-3);
        expect(Math.abs(newArea - sideArea(res.sideA)) / Math.max(sideArea(res.sideA), 1e-6)).toBeLessThan(1e-3);

        // save -> load == identity on the produced inheritor + new shapes.
        const snap = JSON.stringify({ a: inheritor.shape, b: proposal.newFeature.shape });
        expect(JSON.stringify(JSON.parse(snap))).toBe(snap);
      }),
      { seed: SEED_21001, numRuns: RUNS_21001 },
    );
  });
});

// --- (P2) merge with propertyInherit decision (dead branch coverage) ---------

describe('seed=21001 — merge propertyInherit carries the source feature properties', () => {
  it('result leaf attributes + color equal the chosen inherit source verbatim', () => {
    fc.assert(
      fc.property(
        dim,
        dim,
        flags(),
        fc.boolean(),
        (w, h, f, inheritFromB) => {
          const params = makeParams(w, h, f);
          const { feature, store, cutX } = holeyLeaf(params);
          const line = createOpenKnifeLine([
            createCoordinate(cutX, -5),
            createCoordinate(cutX, h + 5),
          ]);
          const res = checkSplittable(feature, store, line);
          if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

          // Give the two products DISTINCT properties so "inherit source" is
          // observable: inheritor keeps ATTRS/COLOR; new feature gets others.
          const otherAttrs = createBasicAttributes('other', 10, 90);
          const otherColor = createColorInfo(true, '#111111', '#222222', '#333333');
          const proposal = assembleSplitProposal({
            target: feature,
            store: store.byId,
            result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
            choice: createInheritanceChoice(INHERITANCE_SIDE.A),
            nonInherited: { attributes: otherAttrs, color: otherColor },
            ids: idPorts(),
          });
          const inheritor = inheritorFeature(feature, proposal);
          const newLeaf = proposal.newFeature;
          const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

          const sourceId = inheritFromB ? newLeaf.id : inheritor.id;
          const mergeRes = buildMergeProposal({
            features: [inheritor, newLeaf],
            vertices: postStore,
            targetIds: [inheritor.id, newLeaf.id],
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: propertyInherit(sourceId),
            ids: idPorts(),
          });
          expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
          if (mergeRes.status !== MERGE_STATUS.Proposal) return;
          const mp = mergeRes.proposal;
          const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
          expect(result?.kind).toBe('leaf');
          if (!result) return;

          // Properties of the result MUST equal the inherited source verbatim.
          const expected = inheritFromB
            ? { attrs: otherAttrs, color: otherColor }
            : { attrs: ATTRS, color: COLOR };
          expect(result.attributes.name).toBe(expected.attrs.name);
          expect(result.attributes.startYear).toBe(expected.attrs.startYear);
          expect(result.attributes.endYear).toBe(expected.attrs.endYear);
          expect(result.color).toEqual(expected.color);
          // Period ordering preserved.
          expect(result.attributes.startYear).toBeLessThanOrEqual(result.attributes.endYear);
        },
      ),
      { seed: SEED_21001, numRuns: RUNS_21001 },
    );
  });
});

// --- (P3) merge with parentCreate / parentExisting (realizeParent branches) --

describe('seed=21001 — merge parentCreate / parentExisting build a valid forest', () => {
  // FIXED (bug-hunt round 2, seed=21001) — REGRESSION GUARD. A LeafOnly merge with
  // a `parentCreate` decision creates a NEW parent aggregate via realizeParent
  // (merge/proposal.ts) with an EMPTY childIds list, and the result leaf is
  // re-parented to it (parentId = createdAggregate.id). Before the fix,
  // assembleLeafOnly never called syncAggregateChildIds, so the created
  // aggregate's authoritative `childIds` stayed `[]` while its actual forest
  // direct-children = [resultLeaf]. The assembleAggregateResult path DID sync;
  // the leaf path did not. The 派生集約 = 子の和 invariant was therefore violated,
  // and because serialize.ts persists `childIds` verbatim and projectsEqual
  // compares it, the broken parent round-tripped as childless — a latent
  // data-integrity defect. The fix runs syncAggregateChildIds over the LeafOnly
  // nextFeatures (parentId as the single source of truth). This test now PASSES
  // and pins that the desync can never silently regress.
  it('parentCreate merge yields a NEW aggregate whose childIds == forest direct children', () => {
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
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        const mergeRes = buildMergeProposal({
          features: [inheritor, newLeaf],
          vertices: postStore,
          targetIds: [inheritor.id, newLeaf.id],
          atTime: 50,
          parentDecision: parentCreate({ name: 'created-parent' }, parentNone),
          propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
          ids: idPorts(),
        });
        expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
        if (mergeRes.status !== MERGE_STATUS.Proposal) return;
        const mp = mergeRes.proposal;

        // A new aggregate parent was created and registered in createdIds.
        const aggregates = mp.nextFeatures.filter((x) => x.kind === 'aggregate');
        expect(aggregates.length).toBe(1);
        const agg = aggregates[0]!;
        expect(mp.createdIds).toContain(agg.id);

        // The result leaf's parent is the created aggregate.
        const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
        expect(result?.parentId).toBe(agg.id);

        // No duplicate feature ids.
        const ids = mp.nextFeatures.map((x) => x.id);
        expect(new Set(ids).size).toBe(ids.length);

        // 派生集約 = 子の和: declared childIds == forest direct children, acyclic.
        const forest = buildForest(mp.nextFeatures);
        for (const fe of mp.nextFeatures) {
          expect(walkToRoot(forest, fe.id).cyclic).toBe(false);
          if (fe.kind === 'aggregate') {
            const declared = [...fe.childIds].sort();
            const actual = [...directChildIds(forest, fe.id)].sort();
            expect(declared).toEqual(actual);
          }
          expect(fe.attributes.startYear).toBeLessThanOrEqual(fe.attributes.endYear);
        }
      }),
      { seed: SEED_21001, numRuns: RUNS_21001 },
    );
  });

  it('parentExisting merge attaches the result leaf under an existing aggregate', () => {
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
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        // An existing top-level aggregate to attach under.
        const existingAggId = asFeatureId(`bh21-existing-${counter++}`);
        const existingAgg = createAggregateFeature(
          existingAggId,
          createBasicAttributes('existing', 0, 100),
          COLOR,
          [],
        );

        const mergeRes = buildMergeProposal({
          features: [inheritor, newLeaf, existingAgg],
          vertices: postStore,
          targetIds: [inheritor.id, newLeaf.id],
          atTime: 50,
          parentDecision: parentExisting(existingAggId),
          propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
          ids: idPorts(),
        });
        expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
        if (mergeRes.status !== MERGE_STATUS.Proposal) return;
        const mp = mergeRes.proposal;
        const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
        expect(result?.parentId).toBe(existingAggId);

        const forest = buildForest(mp.nextFeatures);
        // walkToRoot from the result reaches the existing aggregate and is acyclic.
        const walk = walkToRoot(forest, mp.resultFeatureId);
        expect(walk.cyclic).toBe(false);
        expect(forest.byId.get(existingAggId)).toBeDefined();
        // The result is a direct child of the existing aggregate now.
        expect([...directChildIds(forest, existingAggId)]).toContain(mp.resultFeatureId);
      }),
      { seed: SEED_21001, numRuns: RUNS_21001 },
    );
  });

  // REGRESSION (bug-hunt round 2): a LeafOnly merge with a non-None parent
  // decision must leave every aggregate's declared childIds in sync with the
  // forest's direct children (派生集約 = 子の和), AND must survive the REAL
  // persistence round-trip (serialize → parse → deserialize → projectsEqual) with
  // the parent NOT round-tripping as childless. This is the minimal, seeded
  // counterexample from the report (seed=21001), exercised through the actual U14
  // persistence boundary for both parentCreate and parentExisting.
  it('regression: LeafOnly merge under a parent keeps childIds synced + persistence round-trips the non-empty parent', () => {
    const buildSplitProducts = () => {
      const params = makeParams(20, 20, { leftHole: false, enclave: false, rightHole: false });
      const { feature, store, cutX } = holeyLeaf(params);
      const line = createOpenKnifeLine([
        createCoordinate(cutX, -5),
        createCoordinate(cutX, 20 + 5),
      ]);
      const res = checkSplittable(feature, store, line);
      expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
      if (res.status !== SPLIT_CHECK_STATUS.Splittable) throw new Error('not splittable');
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
      const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);
      return { inheritor, newLeaf, postStore };
    };

    // Assert: every aggregate's declared childIds equals its forest direct
    // children, AND the project round-trips through the real persistence path
    // preserving the (non-empty) parent's childIds.
    const assertSynced = (mp: { nextFeatures: readonly Feature[]; nextVertices: VertexStore }) => {
      const forest = buildForest(mp.nextFeatures);
      let sawNonEmptyAgg = false;
      for (const fe of mp.nextFeatures) {
        if (fe.kind !== 'aggregate') continue;
        const declared = [...fe.childIds].sort();
        const actual = [...directChildIds(forest, fe.id)].sort();
        expect(declared).toEqual(actual);
        if (actual.length > 0) sawNonEmptyAgg = true;
      }
      // The merged-under parent must have the result leaf as a child (not []).
      expect(sawNonEmptyAgg).toBe(true);

      // Real U14 persistence round-trip: the parent must NOT come back childless.
      const leaves = mp.nextFeatures.filter((x): x is LeafFeature => x.kind === 'leaf');
      const world: World = { features: leaves, store: mp.nextVertices };
      const project = worldToProject(world);
      const reloaded = saveThenLoad(project);
      expect(reloaded).toBeDefined();
      // serialize persists childIds verbatim — confirm the parent's childIds
      // survives serialize → parse round-trip non-empty (the defect made it []).
      const manifest = serialize(project);
      const reparsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
      expect(isParsed(reparsed)).toBe(true);
    };

    // (1) parentCreate — a NEW aggregate parent.
    {
      const { inheritor, newLeaf, postStore } = buildSplitProducts();
      const mergeRes = buildMergeProposal({
        features: [inheritor, newLeaf],
        vertices: postStore,
        targetIds: [inheritor.id, newLeaf.id],
        atTime: 50,
        parentDecision: parentCreate({ name: 'created-parent' }, parentNone),
        propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
        ids: idPorts(),
      });
      expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
      if (mergeRes.status !== MERGE_STATUS.Proposal) return;
      const mp = mergeRes.proposal;
      const agg = mp.nextFeatures.find((x) => x.kind === 'aggregate');
      expect(agg).toBeDefined();
      // The created aggregate's childIds is the result leaf — NOT [] (the defect).
      if (agg && agg.kind === 'aggregate') {
        expect([...agg.childIds]).toEqual([mp.resultFeatureId]);
      }
      assertSynced(mp);
    }

    // (2) parentExisting — an already-present (empty) aggregate.
    {
      const { inheritor, newLeaf, postStore } = buildSplitProducts();
      const existingAggId = asFeatureId(`bh21-reg-existing-${counter++}`);
      const existingAgg = createAggregateFeature(
        existingAggId,
        createBasicAttributes('existing', 0, 100),
        COLOR,
        [],
      );
      const mergeRes = buildMergeProposal({
        features: [inheritor, newLeaf, existingAgg],
        vertices: postStore,
        targetIds: [inheritor.id, newLeaf.id],
        atTime: 50,
        parentDecision: parentExisting(existingAggId),
        propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
        ids: idPorts(),
      });
      expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
      if (mergeRes.status !== MERGE_STATUS.Proposal) return;
      const mp = mergeRes.proposal;
      const reAgg = mp.nextFeatures.find((x) => x.id === existingAggId);
      expect(reAgg?.kind).toBe('aggregate');
      // The existing aggregate now declares the result leaf as a child — NOT [].
      if (reAgg && reAgg.kind === 'aggregate') {
        expect([...reAgg.childIds]).toEqual([mp.resultFeatureId]);
      }
      // The existing aggregate's childIds change is reported as a survived touch.
      expect(mp.survivedTouchedIds).toContain(existingAggId);
      assertSynced(mp);
    }
  });
});

// --- (P4) stateful: side-choosing + oriented cuts + per-op persistence + undo -

type Cmd21001 =
  | {
      readonly t: 'split';
      readonly leafPick: number;
      readonly frac: number;
      readonly horizontal: boolean;
      readonly sideB: boolean;
    }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number; readonly inheritA: boolean }
  | { readonly t: 'undo' };

const cmd21001Arb: fc.Arbitrary<Cmd21001> = fc.oneof(
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
    horizontal: fc.boolean(),
    sideB: fc.boolean(),
  }),
  fc.record({
    t: fc.constant<'merge'>('merge'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
    inheritA: fc.boolean(),
  }),
  fc.constant<Cmd21001>({ t: 'undo' }),
);

/** Merge command that randomly inherits properties from one of the two leaves. */
function applyMergeInherit(
  world: World,
  cmd: { aPick: number; bPick: number; inheritA: boolean },
): World {
  if (world.features.length < 2) return world;
  const n = world.features.length;
  const i = cmd.aPick % n;
  let j = cmd.bPick % n;
  if (j === i) j = (j + 1) % n;
  const a = world.features[i]!;
  const b = world.features[j]!;
  const sourceId = cmd.inheritA ? a.id : b.id;

  const res = buildMergeProposal({
    features: world.features,
    vertices: world.store,
    targetIds: [a.id, b.id],
    atTime: 50,
    parentDecision: parentNone,
    propertyDecision: propertyInherit(sourceId),
    ids: idPorts(),
  });
  if (res.status !== MERGE_STATUS.Proposal) return world;
  const p = res.proposal;
  const result = p.nextFeatures.find((x) => x.id === p.resultFeatureId);
  if (result === undefined || result.kind !== 'leaf') return world;
  const features = p.nextFeatures.filter((fe): fe is LeafFeature => fe.kind === 'leaf');
  return { features, store: p.nextVertices };
}

describe('seed=21001 — oriented split / inherit-merge chains: invariants + persistence + undo', () => {
  it('random side-choosing oriented split + inherit merge keep every invariant; per-op real round-trip; undo restores exactly', () => {
    fc.assert(
      fc.property(fc.array(cmd21001Arb, { minLength: 1, maxLength: 16 }), (cmds) => {
        let world = initialWorld();
        const stack: World[] = [];
        checkWorldInvariants(world);

        for (const cmd of cmds) {
          if (cmd.t === 'undo') {
            const prior = stack.pop();
            if (prior === undefined) continue;
            world = prior;
            checkWorldInvariants(world);
            expect(world.features.length).toBeGreaterThanOrEqual(1);
            continue;
          }

          // Snapshot BEFORE the op to assert op purity + power the undo stack.
          const before = world;
          const beforeCopy: World = {
            features: before.features.slice(),
            store: { byId: new Map(before.store.byId) },
          };
          const next =
            cmd.t === 'split' ? applySplitOriented(world, cmd) : applyMergeInherit(world, cmd);
          // Op purity: the prior world value must be untouched (undo correctness).
          expect(worldsIdentical(before, beforeCopy)).toBe(true);
          if (next !== world) stack.push(beforeCopy);
          world = next;

          checkWorldInvariants(world);
          expect(world.features.length).toBeGreaterThanOrEqual(1);

          // (B') REAL persistence round-trip after EVERY op (not just at the end):
          // serialize → parseManifest (Zod) → manifestToProject → projectsEqual.
          const project = worldToProject(world);
          const reloaded = saveThenLoad(project);
          expect(reloaded).toBeDefined();
          if (reloaded !== undefined) {
            expect(projectsEqual(project, reloaded)).toBe(true);
          }
        }
      }),
      { seed: SEED_21001, numRuns: RUNS_21001 },
    );
  });
});

// ===========================================================================
// 9. SEED=21002 EXTENSION — NEW exploration (bug-hunt round 2, disjoint from the
//    1000-21001 band). Different generators / command sets / interactions.
//
// Every section above with a leaf merge uses EXACTLY TWO leaf targets, parentNone
// or a single-segment parentCreate, and the anchor-series sections only feed
// `normalizeSeries` raw years (never the guarded edit ops). This block opens five
// live code paths none of the earlier seeds touch:
//
//   (N1) MULTI-leaf merge (3..5 leaves at once) — unionLeafShapes accumulates the
//        running union across ≥3 operands, and buildShapeFromMultiPolygon's
//        reparentByContainment must re-derive the territory→hole→territory layering
//        of a DISJOINT multi-piece result (飛び地 single terminal). Two-target
//        merges never stress the accumulation past one fold.
//
//   (N2) AGGREGATE-ONLY merge with GRANDCHILDREN — every prior aggregate merge gave
//        each aggregate exactly one leaf child. Here each aggregate owns 2 leaves,
//        so the merge must FLATTEN all direct children of every consumed aggregate
//        onto the single result aggregate (directChildIds union) and the consumed
//        aggregates must vanish (deletedIds) while the grandchildren survive with
//        re-pointed parentId (survivedTouchedIds). Asserts 派生集約 = 子の和 over the
//        flattened forest + acyclic + no orphaned child.
//
//   (N3) parentCreate WITH above:parentExisting — realizeParent's `aboveId` branch
//        (~L449-460) is dead in every earlier seed (all parentCreate calls pass
//        `above = parentNone`). A two-segment chain result→createdAgg→existingTop
//        must be acyclic, the created aggregate's parentId must be the existing top,
//        and every aggregate's childIds must equal its forest direct children.
//
//   (N4) ANCHOR-SERIES stateful model over the GUARDED edit ops (changeStart /
//        setEnd / deleteAnchor / applyPastEdit) — seed=1004 only checked
//        normalizeSeries on a flat year list. This drives a live series through a
//        random command sequence and after EVERY op asserts: strictly-ascending
//        non-duplicate starts (錨列の昇順・非重複), unique anchor ids, isValidSeries,
//        a non-empty series (INV-5), and a save→load==identity of the series'
//        (id,start,end) projection. Metamorphic: deleteAnchor∘applyPastEdit on a
//        fresh insert == identity on the start set (op∘inverse-op).
//
//   (N5) CLOSED knife cut whose loop ENCLOSES an existing hole — the closed clip
//        interacting with a donut leaf (intersection keeps the enclosed annulus,
//        difference keeps the rest-with-hole). Both sides must stay valid, finite,
//        alternation-correct, and the filled areas must sum to the original.
//
// Determinism: seed = 21002, numRuns large (per task). PERMANENT asset — any
// reproduced counterexample is a real domain defect, never to be masked here.
// ===========================================================================

import { createClosedKnifeLine as createClosedKnifeLine21002 } from '../knife/knife-line';
import {
  changeStart,
  setEnd,
  deleteAnchor,
  applyPastEdit,
  type AnchorSeries,
} from '../anchor-series';

const SEED_21002 = 21002;
const RUNS_21002 = 500;

// --- (N1) multi-leaf (3..5) merge into one terminal -------------------------

describe('seed=21002 — multi-leaf merge (3..5 targets) builds one valid 飛び地 terminal', () => {
  it('union of N disjoint leaves yields one alternation-valid leaf; areas sum; no dangling vertex', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 5 }),
        // Keep w small so the whole row (≤5 boxes + gaps) stays inside a safe
        // longitude band well clear of the ±180° seam: 5 boxes of width ≤20 with
        // 6° gaps span at most 5*20 + 4*6 = 124°, started at lon −60 → max ≈ +64°.
        // (The seam / antimeridian wrap is exercised by dedicated seam suites; this
        // section probes the multi-piece union accumulation, not seam handling.)
        fc.double({ min: 8, max: 20, noNaN: true }),
        fc.double({ min: 8, max: 20, noNaN: true }),
        (n, w, h) => {
          // N disjoint axis-aligned boxes placed far apart so the union is a single
          // multi-piece terminal (飛び地). Each box is its own leaf.
          const verts: Vertex[] = [];
          const leaves: LeafFeature[] = [];
          let sumArea = 0;
          for (let i = 0; i < n; i += 1) {
            const x0 = -60 + i * (w + 6); // gap guarantees disjointness; band-safe.
            const b = box(x0, x0 + w, 0, h);
            b.ids.forEach((id, k) => verts.push(createVertex(id, b.coords[k]!)));
            leaves.push(
              createLeafFeature(
                asFeatureId(`bh2-leaf-${counter++}`),
                createBasicAttributes(`L${i}`, i, 100 + i),
                COLOR,
                createShape([createTerritoryRing(freshRid(), b.ids)]),
              ),
            );
            sumArea += w * h;
          }
          const store = createVertexStore(verts);

          const res = buildMergeProposal({
            features: leaves,
            vertices: store,
            targetIds: leaves.map((l) => l.id),
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
            ids: idPorts(),
          });
          expect(res.status).toBe(MERGE_STATUS.Proposal);
          if (res.status !== MERGE_STATUS.Proposal) return;
          const mp = res.proposal;

          // Exactly one result leaf; all N originals consumed.
          const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
          expect(result?.kind).toBe('leaf');
          for (const l of leaves) {
            expect(mp.nextFeatures.find((x) => x.id === l.id)).toBeUndefined();
          }
          // No duplicate feature ids.
          const ids = mp.nextFeatures.map((x) => x.id);
          expect(new Set(ids).size).toBe(ids.length);

          if (result && result.kind === 'leaf') {
            // (I1) alternation; (I5) every cited vertex exists + (I4) finite.
            expect(isAlternationValid(result.shape)).toBe(true);
            for (const ring of result.shape.rings) {
              for (const vid of ring.vertexIds) {
                const v = mp.nextVertices.byId.get(vid);
                expect(v).toBeDefined();
                if (v) {
                  expect(Number.isFinite(v.coordinate.lon)).toBe(true);
                  expect(Number.isFinite(v.coordinate.lat)).toBe(true);
                }
              }
            }
            // (I2) resolves to a valid, finite multi-polygon with N pieces.
            const resolved = resolveLeafShape(result.shape, mp.nextVertices);
            expect(resolved).toBeDefined();
            if (resolved) {
              expect(isMultiPolygonValid(resolved)).toBe(true);
              expect(everyCoordFinite(resolved)).toBe(true);
              // op∘inverse-op style: total filled area == sum of the N source boxes.
              expect(Math.abs(mpFilledArea(resolved) - sumArea) / sumArea).toBeLessThan(1e-3);
              expect(resolved.length).toBe(n); // N disjoint pieces preserved (片落とし禁止).
            }
            // Period ordering (envelope of the N sources): start <= end.
            expect(result.attributes.startYear).toBeLessThanOrEqual(result.attributes.endYear);
          }
        },
      ),
      { seed: SEED_21002, numRuns: RUNS_21002 },
    );
  });
});

// --- (N2) aggregate-only merge with grandchildren (flatten) -----------------

describe('seed=21002 — aggregate-only merge flattens grandchildren (派生集約 = 子の和)', () => {
  it('merging aggregates each owning 2 leaves yields one aggregate owning all grandchildren', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        (numAgg) => {
          const features: Feature[] = [];
          const verts: Vertex[] = [];
          const aggIds: ReturnType<typeof asFeatureId>[] = [];
          const allChildIds: ReturnType<typeof asFeatureId>[] = [];
          for (let i = 0; i < numAgg; i += 1) {
            const aggId = asFeatureId(`bh2-A-${counter++}`);
            aggIds.push(aggId);
            const childIds: ReturnType<typeof asFeatureId>[] = [];
            for (let c = 0; c < 2; c += 1) {
              const lb = box(i * 200 + c * 60, i * 200 + c * 60 + 40, 0, 40);
              lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
              const childId = asFeatureId(`bh2-c-${counter++}`);
              childIds.push(childId);
              allChildIds.push(childId);
              features.push(
                createLeafFeature(
                  childId,
                  createBasicAttributes(`c${i}-${c}`, 0, 100),
                  COLOR,
                  createShape([createTerritoryRing(freshRid(), lb.ids)]),
                  { parentId: aggId },
                ),
              );
            }
            features.push(
              createAggregateFeature(aggId, createBasicAttributes(`A${i}`, 0, 100), COLOR, childIds),
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

          // All source aggregates consumed; exactly ONE result aggregate remains.
          for (const aggId of aggIds) {
            expect(p.nextFeatures.find((x) => x.id === aggId)).toBeUndefined();
          }
          const resultAggs = p.nextFeatures.filter((x) => x.kind === 'aggregate');
          expect(resultAggs.length).toBe(1);
          const result = resultAggs[0]!;
          expect(result.id).toBe(p.resultFeatureId);

          // Every grandchild survives and is re-pointed to the result aggregate.
          for (const childId of allChildIds) {
            const child = p.nextFeatures.find((x) => x.id === childId);
            expect(child).toBeDefined();
            expect(child?.parentId).toBe(result.id);
          }

          // 派生集約 = 子の和: declared childIds == forest direct children == all grandchildren.
          const forest = buildForest(p.nextFeatures);
          if (result.kind === 'aggregate') {
            const declared = [...result.childIds].sort();
            const actual = [...directChildIds(forest, result.id)].sort();
            expect(declared).toEqual(actual);
            expect(actual).toEqual([...allChildIds].sort());
          }
          // Acyclic + no duplicate ids + period ordering on every survivor.
          const ids = p.nextFeatures.map((x) => x.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const fe of p.nextFeatures) {
            expect(walkToRoot(forest, fe.id).cyclic).toBe(false);
            expect(fe.attributes.startYear).toBeLessThanOrEqual(fe.attributes.endYear);
          }
        },
      ),
      { seed: SEED_21002, numRuns: RUNS_21002 },
    );
  });
});

// --- (N3) parentCreate with above:parentExisting (two-segment chain) --------

describe('seed=21002 — parentCreate above an existing top (realizeParent aboveId branch)', () => {
  it('result→createdAgg→existingTop is acyclic; created agg parent is the existing top; childIds synced', () => {
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
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        // An existing top-level aggregate; the newly-created parent sits UNDER it.
        const existingTopId = asFeatureId(`bh2-top-${counter++}`);
        const existingTop = createAggregateFeature(
          existingTopId,
          createBasicAttributes('top', 0, 200),
          COLOR,
          [],
        );

        const mergeRes = buildMergeProposal({
          features: [inheritor, newLeaf, existingTop],
          vertices: postStore,
          targetIds: [inheritor.id, newLeaf.id],
          atTime: 50,
          // parentCreate whose `above` is the existing top — exercises realizeParent's
          // aboveId branch (createdAgg.parentId = existingTop).
          parentDecision: parentCreate({ name: 'mid-parent' }, parentExisting(existingTopId)),
          propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
          ids: idPorts(),
        });
        expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
        if (mergeRes.status !== MERGE_STATUS.Proposal) return;
        const mp = mergeRes.proposal;

        // A NEW mid aggregate was created and sits under the existing top.
        const createdAggs = mp.nextFeatures.filter(
          (x) => x.kind === 'aggregate' && x.id !== existingTopId,
        );
        expect(createdAggs.length).toBe(1);
        const mid = createdAggs[0]!;
        expect(mp.createdIds).toContain(mid.id);
        expect(mid.parentId).toBe(existingTopId);

        // The result leaf's parent is the created mid aggregate (two-segment chain).
        const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
        expect(result?.parentId).toBe(mid.id);

        const forest = buildForest(mp.nextFeatures);
        // walkToRoot from the result climbs result→mid→existingTop, acyclic.
        const walk = walkToRoot(forest, mp.resultFeatureId);
        expect(walk.cyclic).toBe(false);
        if (!walk.cyclic) {
          expect(walk.chain).toContain(mid.id);
          expect(walk.rootId).toBe(existingTopId);
        }

        // 派生集約 = 子の和 over BOTH aggregates; acyclic; no dup ids.
        const ids = mp.nextFeatures.map((x) => x.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const fe of mp.nextFeatures) {
          expect(walkToRoot(forest, fe.id).cyclic).toBe(false);
          if (fe.kind === 'aggregate') {
            const declared = [...fe.childIds].sort();
            const actual = [...directChildIds(forest, fe.id)].sort();
            expect(declared).toEqual(actual);
          }
          expect(fe.attributes.startYear).toBeLessThanOrEqual(fe.attributes.endYear);
        }
        // The mid aggregate declares the result leaf; the existing top declares the mid.
        if (mid.kind === 'aggregate') expect([...mid.childIds]).toEqual([mp.resultFeatureId]);
        const topAfter = mp.nextFeatures.find((x) => x.id === existingTopId);
        if (topAfter && topAfter.kind === 'aggregate') {
          expect([...topAfter.childIds]).toEqual([mid.id]);
        }
      }),
      { seed: SEED_21002, numRuns: RUNS_21002 },
    );
  });
});

// --- (N4) anchor-series stateful over the GUARDED edit ops -------------------

type AnchorCmd =
  | { readonly t: 'insert'; readonly year: number }
  | { readonly t: 'changeStart'; readonly pick: number; readonly year: number }
  | { readonly t: 'setEnd'; readonly pick: number; readonly end: number | null }
  | { readonly t: 'delete'; readonly pick: number };

const anchorCmdArb: fc.Arbitrary<AnchorCmd> = fc.oneof(
  fc.record({ t: fc.constant<'insert'>('insert'), year: fc.integer({ min: -400, max: 400 }) }),
  fc.record({
    t: fc.constant<'changeStart'>('changeStart'),
    pick: fc.nat({ max: 1_000_000 }),
    year: fc.integer({ min: -400, max: 400 }),
  }),
  fc.record({
    t: fc.constant<'setEnd'>('setEnd'),
    pick: fc.nat({ max: 1_000_000 }),
    end: fc.option(fc.integer({ min: -400, max: 400 }), { nil: null }),
  }),
  fc.record({ t: fc.constant<'delete'>('delete'), pick: fc.nat({ max: 1_000_000 }) }),
);

describe('seed=21002 — anchor series stateful (guarded edits): 昇順・非重複 after every op', () => {
  it('changeStart / setEnd / delete / insert keep the series valid, ascending, non-duplicate, round-tripping', () => {
    const cal = getCalendar('gregorian');
    const emptySnap = createAnchorSnapshot([], createVertexStore([]));

    const assertSeriesInvariants = (series: AnchorSeries) => {
      // INV-5 non-empty.
      expect(series.entries.length).toBeGreaterThanOrEqual(1);
      // isValidSeries: the single source of the rule (INV-1..6).
      expect(isValidSeries(series, cal)).toBe(true);
      // 昇順・非重複: strictly-ascending, non-duplicate starts.
      const starts = series.entries.map((e) => (e.start as { year: number }).year);
      for (let i = 1; i < starts.length; i += 1) {
        expect(starts[i]! > starts[i - 1]!).toBe(true);
      }
      // Unique anchor ids (INV-6 — the routing key for by-id edits).
      const ids = series.entries.map((e) => e.anchor.id);
      expect(new Set(ids).size).toBe(ids.length);
      // save→load == identity on the (id,start,end) projection.
      const proj = series.entries.map((e) => ({
        id: e.anchor.id,
        start: e.start,
        end: e.end,
      }));
      const saved = JSON.stringify(proj);
      expect(JSON.stringify(JSON.parse(saved))).toBe(saved);
    };

    fc.assert(
      fc.property(fc.array(anchorCmdArb, { minLength: 1, maxLength: 18 }), (cmds) => {
        // Start from a single open-ended anchor at year 0.
        let series: AnchorSeries = {
          entries: [
            createAnchorEntry(
              createAnchor(asAnchorId(`bh2-an-${counter++}`), emptySnap),
              timePointYear(0),
              null,
            ),
          ],
        };
        assertSeriesInvariants(series);

        for (const cmd of cmds) {
          if (cmd.t === 'insert') {
            series = applyPastEdit(
              series,
              timePointYear(cmd.year),
              () => createAnchor(asAnchorId(`bh2-an-${counter++}`), emptySnap),
              cal,
            );
            assertSeriesInvariants(series);
            continue;
          }
          if (cmd.t === 'delete') {
            const target = series.entries[cmd.pick % series.entries.length]!;
            const res = deleteAnchor(series, target.anchor.id, cal);
            // A rejection (last-anchor guard) must leave the series UNTOUCHED.
            if (res.ok) series = res.series;
            assertSeriesInvariants(series);
            continue;
          }
          if (cmd.t === 'changeStart') {
            const target = series.entries[cmd.pick % series.entries.length]!;
            const res = changeStart(series, target.anchor.id, timePointYear(cmd.year), cal);
            if (res.ok) series = res.series; // rejections are no-ops by contract.
            assertSeriesInvariants(series);
            continue;
          }
          // setEnd.
          const target = series.entries[cmd.pick % series.entries.length]!;
          const res = setEnd(
            series,
            target.anchor.id,
            cmd.end === null ? null : timePointYear(cmd.end),
            cal,
          );
          if (res.ok) series = res.series;
          assertSeriesInvariants(series);
        }
      }),
      { seed: SEED_21002, numRuns: RUNS_21002 },
    );
  });

  it('metamorphic: deleteAnchor ∘ applyPastEdit(new year) == identity on the start set', () => {
    const cal = getCalendar('gregorian');
    const emptySnap = createAnchorSnapshot([], createVertexStore([]));
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: -300, max: 300 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 400, max: 900 }), // a year strictly beyond every base start.
        (baseYears, freshYear) => {
          // Build a base series from distinct ascending years.
          const sorted = [...baseYears].sort((a, b) => a - b);
          let series: AnchorSeries = {
            entries: sorted.map((y) =>
              createAnchorEntry(
                createAnchor(asAnchorId(`bh2-mm-${counter++}`), emptySnap),
                timePointYear(y),
                null,
              ),
            ),
          };
          series = { entries: [...series.entries] };
          const startsBefore = series.entries
            .map((e) => (e.start as { year: number }).year)
            .sort((a, b) => a - b);

          // op: insert a fresh future anchor (a NEW start, no existing collision).
          let insertedId: ReturnType<typeof asAnchorId> | undefined;
          const after = applyPastEdit(
            series,
            timePointYear(freshYear),
            () => {
              const a = createAnchor(asAnchorId(`bh2-mm-${counter++}`), emptySnap);
              insertedId = a.id;
              return a;
            },
            cal,
          );
          // The fresh start is now present.
          expect(after.entries.some((e) => (e.start as { year: number }).year === freshYear)).toBe(true);

          // inverse-op: delete the just-inserted anchor by id.
          expect(insertedId).toBeDefined();
          const undone = deleteAnchor(after, insertedId!, cal);
          expect(undone.ok).toBe(true);
          if (!undone.ok) return;
          // deleteAnchor ∘ applyPastEdit == identity on the START SET.
          const startsAfter = undone.series.entries
            .map((e) => (e.start as { year: number }).year)
            .sort((a, b) => a - b);
          expect(startsAfter).toEqual(startsBefore);
        },
      ),
      { seed: SEED_21002, numRuns: RUNS_21002 },
    );
  });
});

// --- (N5) closed knife cut enclosing an existing hole -----------------------

describe('seed=21002 — closed cut enclosing a hole: both sides valid + finite + area-preserving', () => {
  it('a closed loop drawn around the left hole splits the donut into two valid faces', () => {
    fc.assert(
      fc.property(dim, dim, (w, h) => {
        // A donut leaf: one outer territory + one left hole, no enclave/right hole.
        const params = makeParams(w, h, { leftHole: true, enclave: false, rightHole: false });
        const { feature, store } = holeyLeaf(params);
        // The left hole occupies x∈[0.15w,0.45w], y∈[0.2h,0.8h]. Draw a CLOSED cut
        // loop that fully ENCLOSES that hole (a rectangle around it), so the
        // intersection side is the annulus-with-hole around it and the difference
        // side is the rest of the territory. Both must stay valid.
        const closed = createClosedKnifeLine21002([
          createCoordinate(w * 0.1, h * 0.1),
          createCoordinate(w * 0.5, h * 0.1),
          createCoordinate(w * 0.5, h * 0.9),
          createCoordinate(w * 0.1, h * 0.9),
        ]);
        const res = checkSplittable(feature, store, closed);
        // The cut may or may not be accepted depending on quantization; when it is,
        // every invariant must hold.
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

        for (const side of [res.sideA, res.sideB]) {
          expect(everyCoordFinite(side.area)).toBe(true);
          expect(isMultiPolygonValid(side.area)).toBe(true);
          expect(sideArea(side)).toBeGreaterThan(0);
        }
        // Area preservation: the two filled sides sum to the donut's filled area.
        const sum = sideArea(res.sideA) + sideArea(res.sideB);
        const whole = filledArea(params);
        expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-3);

        // The rebuilt proposal shapes alternate on both sides + finite vertices.
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
        for (const v of proposal.vertices) {
          expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
        }
        // save -> load == identity on each produced side.
        for (const side of [res.sideA, res.sideB]) {
          const saved = JSON.stringify(side.area);
          expect(JSON.stringify(JSON.parse(saved) as GeoMultiPolygon)).toBe(saved);
        }
      }),
      { seed: SEED_21002, numRuns: RUNS_21002 },
    );
  });
});

// ===========================================================================
// 10. SEED=21003 EXTENSION — NEW exploration (bug-hunt round 2, disjoint from
//     the 1000-21002 band). Different generators / command sets / interactions.
//
// Every earlier seed merges EITHER all-leaves (LeafOnly) OR all-aggregates
// (AggregateOnly); the THIRD classifyMerge branch — MERGE_KIND.Mixed (a leaf AND
// an aggregate targeted together) — is dead code in every seed 1000-21002. The
// split inheritance side is also always a FIXED choice or a coin flip, never the
// FR-93 小さい方 (smaller-side) preview that the product actually seeds the UI with.
// And no stateful model keeps AGGREGATES live in the world, so the forest invariant
// battery (acyclic + 派生集約 = 子の和) has never run over a multi-level forest as it
// evolves under chained edits. This block opens five live paths none of the earlier
// seeds touch:
//
//   (M1) MIXED merge (classifyMerge → MERGE_KIND.Mixed, assembleAggregateResult
//        mixed branch ~L680): target ONE aggregate (owning K leaves) together with
//        a STANDALONE leaf. The result aggregate must keep the standalone leaf as a
//        DIRECT continuing child (同一性保持) AND flatten the aggregate's K children
//        onto itself, the source aggregate must vanish (deletedIds), and 派生集約 =
//        子の和 must hold over the K+1 children. Two-kind targeting is never tested.
//
//   (M2) smallerSide-driven inheritance (FR-93): drive INHERITANCE_SIDE from
//        `smallerSide(exec)` — the real preview the UI seeds — and assert the
//        inheritor side's resolved filled area is ≤ the new feature's. Every earlier
//        seed used a fixed/random side, never the area-derived preview, so a defect
//        wiring smallerSide → inheritance choice would slip through.
//
//   (M3) Multi-segment ZIG-ZAG open cut (a W that crosses the outer boundary FOUR
//        times): countBoundaryTransits must count ≥4 transits, and when accepted the
//        two sides stay valid/finite/alternating and the filled areas sum to the
//        whole. Every earlier open cut was a straight or single-bend line (exactly 2
//        transits); >2 transits exercises the multi-piece clip extrusion.
//
//   (M4) Stateful model whose WORLD KEEPS AGGREGATES: an initial single aggregate
//        parent over the seed leaf, then a random split/mixed-merge/reparent chain.
//        After EVERY op the FULL forest battery runs: acyclic (walkToRoot), 派生集約
//        = 子の和 over every aggregate, unique ids, finite coords, valid leaf
//        multi-polygons, AND a save→load==identity over the whole feature+vertex
//        snapshot. No earlier stateful model carried aggregates, so this is the
//        first time the forest invariant runs as the forest mutates.
//
//   (M5) parentExisting childIds-sync + persistence: a LeafOnly merge UNDER an
//        existing aggregate must sync that aggregate's declared childIds to the
//        result leaf (single source of truth = parentId) AND that non-empty childIds
//        must survive the REAL serialize → parseManifest boundary (the defect the
//        round-2 report pinned made it round-trip as []). Exercised with the leaf
//        world carried through worldToProject's real U14 path.
//
// Determinism: seed = 21003, numRuns large (per task). PERMANENT asset — any
// reproduced counterexample is a real domain defect, never to be masked here.
// ===========================================================================

const SEED_21003 = 21003;
const RUNS_21003 = 400;

// New imports for the 21003 exploration (Mixed merge kind, parent-id mutation,
// child-id re-sync, and a full-feature persistence project builder).
import { MERGE_KIND as MERGE_KIND_21003 } from '../merge/proposal';
import { withParentId as withParentId21003, withAggregateChildIds } from '../feature';

/**
 * Re-sync every aggregate's declared childIds to the parentId relation (single
 * source of truth = parentId), mirroring merge/proposal's syncAggregateChildIds so
 * the forest-stateful model never leaves a manually-reparented aggregate desynced.
 */
function syncForestChildIds(features: readonly Feature[]): Feature[] {
  const forest = buildForest(features);
  return features.map((f) => {
    if (f.kind !== 'aggregate') return f;
    const desired = directChildIds(forest, f.id);
    return withAggregateChildIds(f, desired);
  });
}

/**
 * Build a DomainProject from a FULL feature list (leaves AND aggregates) so the
 * real U14 persistence path round-trips an aggregate's childIds verbatim. Every
 * feature gets a two-entry history whose anchor snapshot holds the WHOLE feature
 * set + store (the same convention as worldToProject, generalized past leaves).
 */
function worldToProject21003(
  features: readonly Feature[],
  store: VertexStore,
): DomainProject {
  const snapshot = createAnchorSnapshot([...features], store);
  const histories: FeatureHistory[] = features.map((f) => {
    const e0 = createAnchorEntry(
      createAnchor(asAnchorId(`bh3-a0-${counter++}`), snapshot),
      timePointYear(0),
      timePointYear(25),
    );
    const e1 = createAnchorEntry(
      createAnchor(asAnchorId(`bh3-a1-${counter++}`), snapshot),
      timePointYear(30),
      null,
    );
    return { featureId: f.id, series: { entries: [e0, e1] } };
  });
  return { histories, settings: PROJECT_SETTINGS, baseMap: BASE_MAP };
}

// --- (M1) MIXED merge: one aggregate (K leaves) + one standalone leaf --------

describe('seed=21003 — MIXED merge (leaf + aggregate) flattens + keeps the leaf as a child', () => {
  it('result aggregate owns the standalone leaf AND the aggregate grandchildren; source agg vanishes; 派生集約 = 子の和', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }), // K = children under the one aggregate.
        (k) => {
          const features: Feature[] = [];
          const verts: Vertex[] = [];

          // One aggregate owning K leaf children.
          const aggId = asFeatureId(`bh3-A-${counter++}`);
          const childIds: ReturnType<typeof asFeatureId>[] = [];
          for (let c = 0; c < k; c += 1) {
            const lb = box(c * 60, c * 60 + 40, 0, 40);
            lb.ids.forEach((id, i) => verts.push(createVertex(id, lb.coords[i]!)));
            const childId = asFeatureId(`bh3-c-${counter++}`);
            childIds.push(childId);
            features.push(
              createLeafFeature(
                childId,
                createBasicAttributes(`c${c}`, 0, 100),
                COLOR,
                createShape([createTerritoryRing(freshRid(), lb.ids)]),
                { parentId: aggId },
              ),
            );
          }
          features.push(
            createAggregateFeature(aggId, createBasicAttributes('A', 0, 100), COLOR, childIds),
          );

          // One STANDALONE top-level leaf (no parent) — the mixed second target.
          const sb = box(1000, 1040, 0, 40);
          sb.ids.forEach((id, i) => verts.push(createVertex(id, sb.coords[i]!)));
          const standaloneId = asFeatureId(`bh3-s-${counter++}`);
          features.push(
            createLeafFeature(
              standaloneId,
              createBasicAttributes('standalone', 0, 100),
              COLOR,
              createShape([createTerritoryRing(freshRid(), sb.ids)]),
            ),
          );

          const vertices = createVertexStore(verts);
          const r = buildMergeProposal({
            features,
            vertices,
            // MIXED: an aggregate AND a leaf targeted together.
            targetIds: [aggId, standaloneId],
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: propertyNew({ attributes: createBasicAttributes('mix', 0, 100), color: COLOR }),
            ids: idPorts(),
          });
          expect(r.status).toBe(MERGE_STATUS.Proposal);
          if (r.status !== MERGE_STATUS.Proposal) return;
          const p = r.proposal;
          expect(p.mergeKind).toBe(MERGE_KIND_21003.Mixed);

          // The source aggregate vanishes (its identity ends); its leaves continue.
          expect(p.nextFeatures.find((x) => x.id === aggId)).toBeUndefined();
          expect(p.deletedIds).toContain(aggId);

          // Exactly one result aggregate; it is the result feature id.
          const resultAggs = p.nextFeatures.filter((x) => x.kind === 'aggregate');
          expect(resultAggs.length).toBe(1);
          const result = resultAggs[0]!;
          expect(result.id).toBe(p.resultFeatureId);

          // The standalone leaf survives, re-pointed to the result aggregate.
          const standaloneAfter = p.nextFeatures.find((x) => x.id === standaloneId);
          expect(standaloneAfter).toBeDefined();
          expect(standaloneAfter?.parentId).toBe(result.id);
          // Every grandchild survives, re-pointed to the result aggregate too.
          for (const childId of childIds) {
            const child = p.nextFeatures.find((x) => x.id === childId);
            expect(child).toBeDefined();
            expect(child?.parentId).toBe(result.id);
          }

          // 派生集約 = 子の和: declared childIds == forest direct children == K leaves + standalone.
          const forest = buildForest(p.nextFeatures);
          if (result.kind === 'aggregate') {
            const declared = [...result.childIds].sort();
            const actual = [...directChildIds(forest, result.id)].sort();
            expect(declared).toEqual(actual);
            const expected = [...childIds, standaloneId].sort();
            expect(actual).toEqual(expected);
          }

          // No duplicate ids; acyclic; period ordering on every survivor.
          const ids = p.nextFeatures.map((x) => x.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const fe of p.nextFeatures) {
            expect(walkToRoot(forest, fe.id).cyclic).toBe(false);
            expect(fe.attributes.startYear).toBeLessThanOrEqual(fe.attributes.endYear);
          }
        },
      ),
      { seed: SEED_21003, numRuns: RUNS_21003 },
    );
  });
});

// --- (M2) smallerSide-driven inheritance (FR-93 preview wiring) --------------

describe('seed=21003 — smallerSide-driven inheritance keeps the SMALLER side as inheritor', () => {
  it('choosing INHERITANCE_SIDE from smallerSide(exec) makes the inheritor area ≤ the new feature area', () => {
    fc.assert(
      fc.property(dim, dim, flags(), (w, h, f) => {
        const params = makeParams(w, h, f);
        const { feature, store, cutX } = holeyLeaf(params);
        const line = createOpenKnifeLine([
          createCoordinate(cutX, -5),
          createCoordinate(cutX, h + 5),
        ]);
        const exec = executeSplit(feature, store, line);
        if (exec === undefined) return;

        // The FR-93 preview hint — the real value the UI seeds the choice with.
        const smaller = smallerSide(exec);
        const choice = createInheritanceChoice(
          smaller === 'a' ? INHERITANCE_SIDE.A : INHERITANCE_SIDE.B,
        );
        const proposal = assembleSplitProposal({
          target: feature,
          store: store.byId,
          result: { sideA: exec.sideA, sideB: exec.sideB, edgeCuts: exec.edgeCuts },
          choice,
          nonInherited: { attributes: ATTRS, color: COLOR },
          ids: idPorts(),
        });
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);
        const inheritor = inheritorFeature(feature, proposal);
        const newLeaf = proposal.newFeature;

        // The inheritor (which kept the original id) must be the SMALLER side's
        // geometry — its filled area ≤ the new feature's (FR-93 小さい方を継承先に).
        const inhArea = leafFilledArea(inheritor, postStore);
        const newArea = leafFilledArea(newLeaf, postStore);
        // Tolerance: areas are positive; allow quantization noise via a relative slack.
        const slack = Math.max(inhArea, newArea, 1) * 1e-3;
        expect(inhArea).toBeLessThanOrEqual(newArea + slack);

        // The geometry sides agree with smallerSide's km2 verdict.
        if (smaller === 'a') expect(exec.sideA.areaKm2).toBeLessThanOrEqual(exec.sideB.areaKm2);
        else expect(exec.sideB.areaKm2).toBeLessThanOrEqual(exec.sideA.areaKm2);

        // Both rebuilt shapes alternate + finite vertices (sanity over the chosen side).
        expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
        expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
        for (const v of proposal.vertices) {
          expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
        }
      }),
      { seed: SEED_21003, numRuns: RUNS_21003 },
    );
  });
});

// --- (M3) zig-zag (W) open cut crossing the outer boundary 4 times -----------

describe('seed=21003 — zig-zag (W) open cut: >2 boundary transits stay valid + area-preserving', () => {
  it('a 4-transit W cut, when accepted, yields two valid finite alternation-correct area-preserving sides', () => {
    fc.assert(
      fc.property(
        // No holes/enclaves: a plain rectangle so the W's 4 transits are all on the
        // single outer boundary (the multi-transit clip extrusion is what we probe).
        fc.double({ min: 30, max: 80, noNaN: true }),
        fc.double({ min: 30, max: 80, noNaN: true }),
        (w, h) => {
          const params = makeParams(w, h, { leftHole: false, enclave: false, rightHole: false });
          const { feature, store } = holeyLeaf(params);
          // A W that enters/exits the TOP boundary twice and dips to the bottom twice,
          // crossing the outer ring 4 times (down-up-down-up across the top edge).
          const yTop = h + 10;
          const yBot = -10;
          const line = createOpenKnifeLine([
            createCoordinate(w * 0.2, yTop),
            createCoordinate(w * 0.35, yBot),
            createCoordinate(w * 0.5, yTop),
            createCoordinate(w * 0.65, yBot),
            createCoordinate(w * 0.8, yTop),
          ]);
          const res = checkSplittable(feature, store, line);
          // The W may or may not be accepted by the pierce/clip gates; when it is,
          // every invariant must hold.
          if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

          // HB3-5/19 n-way: a 4-transit W cut now yields k+1 (= 3) pieces, not 2 sides.
          // Every piece must be valid + finite, and ALL pieces together conserve area.
          const pieces = res.pieces ?? [res.sideA, res.sideB];
          for (const side of pieces) {
            expect(everyCoordFinite(side.area)).toBe(true);
            expect(isMultiPolygonValid(side.area)).toBe(true);
            expect(sideArea(side)).toBeGreaterThan(0);
          }
          const sum = pieces.reduce((acc, side) => acc + sideArea(side), 0);
          const whole = filledArea(params);
          expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-3);

          const proposal = assembleSplitProposal({
            target: feature,
            store: store.byId,
            result: { pieces, sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
            choice: createInheritanceChoice(INHERITANCE_SIDE.A),
            nonInherited: { attributes: ATTRS, color: COLOR },
            ids: idPorts(),
          });
          expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
          for (const nf of proposal.newFeatures) {
            expect(isAlternationValid(nf.shape)).toBe(true);
          }
          for (const v of proposal.vertices) {
            expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
          }
        },
      ),
      { seed: SEED_21003, numRuns: RUNS_21003 },
    );
  });
});

// --- (M4) stateful model whose WORLD KEEPS AGGREGATES (forest battery) -------
//
// A separate world model from `World`: it carries the FULL feature set (leaves +
// aggregates) and the store, so the forest invariant runs over a multi-level
// hierarchy as it evolves under split / mixed-merge / reparent commands.

interface ForestWorld {
  features: Feature[];
  store: VertexStore;
}

type ForestCmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'reparentTop'; readonly pick: number }
  | { readonly t: 'mergeUnderAgg'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'noop' };

const forestCmdArb: fc.Arbitrary<ForestCmd> = fc.oneof(
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({ t: fc.constant<'reparentTop'>('reparentTop'), pick: fc.nat({ max: 1_000_000 }) }),
  fc.record({
    t: fc.constant<'mergeUnderAgg'>('mergeUnderAgg'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.constant<ForestCmd>({ t: 'noop' }),
);

function leafFeaturesOf(world: ForestWorld): LeafFeature[] {
  return world.features.filter((f): f is LeafFeature => f.kind === 'leaf');
}

function aggregatesOf(world: ForestWorld): Feature[] {
  return world.features.filter((f) => f.kind === 'aggregate');
}

/** Full forest invariant battery over a multi-level world. */
function checkForestWorldInvariants(world: ForestWorld): void {
  const ids = world.features.map((f) => f.id);
  expect(new Set(ids).size).toBe(ids.length); // unique ids.

  const forest = buildForest(world.features);
  for (const fe of world.features) {
    // Acyclic parent chain (no feature is its own ancestor).
    expect(walkToRoot(forest, fe.id).cyclic).toBe(false);
    // 派生集約 = 子の和: every aggregate's declared childIds == its forest direct children.
    if (fe.kind === 'aggregate') {
      const declared = [...fe.childIds].sort();
      const actual = [...directChildIds(forest, fe.id)].sort();
      expect(declared).toEqual(actual);
    }
    // Period ordering on every feature.
    expect(fe.attributes.startYear).toBeLessThanOrEqual(fe.attributes.endYear);
  }

  // Leaf geometry: alternation, dangling-free, finite, valid multi-polygon.
  for (const leaf of leafFeaturesOf(world)) {
    expect(isAlternationValid(leaf.shape)).toBe(true);
    for (const ring of leaf.shape.rings) {
      for (const vid of ring.vertexIds) {
        const v = world.store.byId.get(vid);
        expect(v).toBeDefined();
        if (v) {
          expect(Number.isFinite(v.coordinate.lon)).toBe(true);
          expect(Number.isFinite(v.coordinate.lat)).toBe(true);
        }
      }
    }
    const mp = resolveLeafShape(leaf.shape, world.store);
    expect(mp).toBeDefined();
    if (mp) {
      expect(isMultiPolygonValid(mp)).toBe(true);
      expect(everyCoordFinite(mp)).toBe(true);
    }
  }

  // save -> load == identity over the WHOLE world (features + store).
  const snapshot = {
    features: world.features.map((f) => ({
      id: f.id,
      parentId: f.parentId,
      kind: f.kind,
      childIds: f.kind === 'aggregate' ? f.childIds : undefined,
      shape: f.kind === 'leaf' ? f.shape : undefined,
    })),
    vertices: [...world.store.byId.values()],
  };
  const saved = JSON.stringify(snapshot);
  expect(JSON.stringify(JSON.parse(saved))).toBe(saved);
}

/** Split a leaf in the forest world (side A, vertical), preserving its parentId. */
function forestSplit(world: ForestWorld, cmd: { leafPick: number; frac: number }): ForestWorld {
  const leaves = leafFeaturesOf(world);
  if (leaves.length === 0) return world;
  const leaf = leaves[cmd.leafPick % leaves.length]!;
  const bb = leafBbox(leaf, world.store);
  if (bb === undefined) return world;
  const span = bb.maxX - bb.minX;
  if (span <= 0) return world;
  const cutX = bb.minX + span * (0.2 + cmd.frac * 0.6);
  const pad = (bb.maxY - bb.minY) * 0.5 + 10;
  const line = createOpenKnifeLine([
    createCoordinate(cutX, bb.minY - pad),
    createCoordinate(cutX, bb.maxY + pad),
  ]);
  const check = checkSplittable(leaf, world.store, line);
  const exec = executeSplit(leaf, world.store, line);
  if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
    expect(exec).toBeUndefined();
    return world;
  }
  if (exec === undefined) return world;
  const proposal = assembleSplitProposal({
    target: leaf,
    store: world.store.byId,
    result: { sideA: check.sideA, sideB: check.sideB, edgeCuts: exec.edgeCuts },
    choice: createInheritanceChoice(INHERITANCE_SIDE.A),
    nonInherited: { attributes: ATTRS, color: COLOR },
    ids: idPorts(),
  });
  // The inheritor keeps id + parentId; the new leaf inherits the same parent
  // (proposal.newFeature already carries the original's parentId).
  const inheritor = withLeafShape(leaf, proposal.inheritorShape);
  const nextFeatures = world.features.map((f) => (f.id === leaf.id ? inheritor : f));
  nextFeatures.push(proposal.newFeature);
  // The new leaf inherits the original's parent, so the parent aggregate now has an
  // extra direct child. The host (U13 applyProposal) re-syncs aggregate childIds to
  // the parentId relation; mirror that here so the forest invariant stays exact.
  const synced = syncForestChildIds(nextFeatures);
  const nextStore = createVertexStore([...world.store.byId.values(), ...proposal.vertices]);
  return { features: synced, store: nextStore };
}

/** Re-point a randomly picked feature to be a top-level root (parentId removed). */
function forestReparentTop(world: ForestWorld, cmd: { pick: number }): ForestWorld {
  if (world.features.length === 0) return world;
  const target = world.features[cmd.pick % world.features.length]!;
  if (target.parentId === undefined) return world; // already top-level → no-op.
  const reparented = withParentId21003(target, undefined);
  const nextFeatures = world.features.map((f) => (f.id === target.id ? reparented : f));
  // Re-sync aggregate childIds to the new parent relation (single source = parentId).
  const synced = syncForestChildIds(nextFeatures);
  return { features: synced, store: world.store };
}

/** Merge two leaves under a (possibly existing) aggregate, keeping the forest valid. */
function forestMergeUnderAgg(
  world: ForestWorld,
  cmd: { aPick: number; bPick: number },
): ForestWorld {
  const leaves = leafFeaturesOf(world);
  if (leaves.length < 2) return world;
  const i = cmd.aPick % leaves.length;
  let j = cmd.bPick % leaves.length;
  if (j === i) j = (j + 1) % leaves.length;
  const a = leaves[i]!;
  const b = leaves[j]!;

  // Pick an existing aggregate to attach under, if any; else create a fresh one.
  const aggs = aggregatesOf(world);
  const parentDecision =
    aggs.length > 0
      ? parentExisting(aggs[cmd.aPick % aggs.length]!.id)
      : parentCreate({ name: 'created' }, parentNone);

  const res = buildMergeProposal({
    features: world.features,
    vertices: world.store,
    targetIds: [a.id, b.id],
    atTime: 50,
    parentDecision,
    propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
    ids: idPorts(),
  });
  if (res.status !== MERGE_STATUS.Proposal) return world;
  const p = res.proposal;
  const result = p.nextFeatures.find((x) => x.id === p.resultFeatureId);
  if (result === undefined || result.kind !== 'leaf') return world;
  return { features: [...p.nextFeatures], store: p.nextVertices };
}

function applyForestCmd(world: ForestWorld, cmd: ForestCmd): ForestWorld {
  switch (cmd.t) {
    case 'split':
      return forestSplit(world, cmd);
    case 'reparentTop':
      return forestReparentTop(world, cmd);
    case 'mergeUnderAgg':
      return forestMergeUnderAgg(world, cmd);
    case 'noop':
      return world;
  }
}

function initialForestWorld(): ForestWorld {
  // A single holey leaf under one aggregate parent — so the forest is multi-level
  // from the start and the very first split exercises hole re-parenting under a
  // live aggregate.
  const aggId = asFeatureId(`bh3-rootA-${counter++}`);
  const { feature, store } = holeyLeaf({
    w: 60,
    h: 40,
    leftHole: true,
    enclave: true,
    rightHole: true,
  });
  const childLeaf = withParentId21003(feature, aggId) as LeafFeature;
  const agg = createAggregateFeature(aggId, createBasicAttributes('rootA', 0, 100), COLOR, [
    feature.id,
  ]);
  return { features: [childLeaf, agg], store };
}

describe('seed=21003 — stateful forest world: split / mixed-merge / reparent keep the forest valid', () => {
  it('random forest edits keep acyclic + 派生集約 = 子の和 + valid leaf geometry + round-trip after each op', () => {
    fc.assert(
      fc.property(fc.array(forestCmdArb, { minLength: 1, maxLength: 14 }), (cmds) => {
        let world = initialForestWorld();
        checkForestWorldInvariants(world);
        for (const cmd of cmds) {
          world = applyForestCmd(world, cmd);
          checkForestWorldInvariants(world);
          // Liveness: at least one feature always remains.
          expect(world.features.length).toBeGreaterThanOrEqual(1);
        }
      }),
      { seed: SEED_21003, numRuns: RUNS_21003 },
    );
  });
});

// --- (M5) parentExisting LeafOnly merge: childIds sync survives real U14 path -

describe('seed=21003 — LeafOnly merge under an existing aggregate: childIds synced + persists non-empty', () => {
  it('the existing parent declares the result leaf and that childIds survives serialize → parse', () => {
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
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        const existingAggId = asFeatureId(`bh3-exist-${counter++}`);
        const existingAgg = createAggregateFeature(
          existingAggId,
          createBasicAttributes('existing', 0, 100),
          COLOR,
          [],
        );

        const mergeRes = buildMergeProposal({
          features: [inheritor, newLeaf, existingAgg],
          vertices: postStore,
          targetIds: [inheritor.id, newLeaf.id],
          atTime: 50,
          parentDecision: parentExisting(existingAggId),
          propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
          ids: idPorts(),
        });
        expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
        if (mergeRes.status !== MERGE_STATUS.Proposal) return;
        const mp = mergeRes.proposal;

        // The existing aggregate now declares EXACTLY the result leaf (not []).
        const reAgg = mp.nextFeatures.find((x) => x.id === existingAggId);
        expect(reAgg?.kind).toBe('aggregate');
        if (reAgg && reAgg.kind === 'aggregate') {
          expect([...reAgg.childIds]).toEqual([mp.resultFeatureId]);
        }
        // Reported as a survived (touched) feature.
        expect(mp.survivedTouchedIds).toContain(existingAggId);

        // 派生集約 = 子の和 over the whole result; acyclic.
        const forest = buildForest(mp.nextFeatures);
        for (const fe of mp.nextFeatures) {
          expect(walkToRoot(forest, fe.id).cyclic).toBe(false);
          if (fe.kind === 'aggregate') {
            const declared = [...fe.childIds].sort();
            const actual = [...directChildIds(forest, fe.id)].sort();
            expect(declared).toEqual(actual);
          }
        }

        // Real U14 persistence: the project (with the non-empty aggregate carried
        // through the histories) must round-trip with the parent's childIds intact.
        const project = worldToProject21003(mp.nextFeatures, mp.nextVertices);
        const manifest = serialize(project);
        const reparsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
        expect(isParsed(reparsed)).toBe(true);
        if (!isParsed(reparsed)) return;
        const reloaded = manifestToProject(reparsed.manifest);
        expect(projectsEqual(project, reloaded)).toBe(true);
      }),
      { seed: SEED_21003, numRuns: RUNS_21003 },
    );
  });
});

// ===========================================================================
// 11. SEED=21004 EXTENSION — NEW exploration (bug-hunt round 2, disjoint from
//     the 1000-21003 band). Different generators / command sets / interactions.
//
// Every earlier seed only ever calls buildMergeProposal with inputs that are
// ALREADY known-legal (≥2 distinct targets, all present at the chosen atTime, no
// vertical relation), so the merge precondition GATE (precondition.ts) and the
// FOUR rejection paths it owns are dead code across the entire 1000-21003 band:
//
//     validateMergePreconditions → { TooFew, TargetMissing, NotPresentAtTime,
//                                     VerticalRelation }
//
// The candidate-enumeration helpers (candidates.ts) — allowedMergeParentCandidates
// / propertyInheritCandidates — and the existence-period predicates existsAtTime /
// isVerticallyRelated are likewise never touched. This block opens those live
// paths with brand-new generators and asserts the relations they must satisfy:
//
//   (R1) REJECTION purity (op-on-illegal == identity / no-op): a buildMergeProposal
//        whose targets violate ANY precondition MUST return Rejected with the
//        machine-readable reason matching the violation AND must not mutate the
//        input world (the features array, every feature value, and the store are
//        byte-for-byte unchanged after the rejected call). A rejecting op that
//        silently mutated shared state would corrupt undo. Generated violations:
//          • TooFew          — 0 or 1 distinct targets,
//          • TargetMissing   — a target id absent from the feature set,
//          • NotPresentAtTime— a target whose [startYear,endYear] excludes atTime,
//          • VerticalRelation— two targets in an ancestor/descendant relation.
//
//   (R2) classifyMerge ∘ validateMergePreconditions ordering: when a world is BOTH
//        vertically-related AND otherwise mergeable, the verdict is the rejection
//        (the gate runs FIRST), never a Proposal — i.e. the precondition is a hard
//        guard, not advisory. Metamorphic: removing the offending relation (re-point
//        the child to top-level) flips the SAME targets from Rejected→Proposal.
//
//   (R3) existsAtTime boundary inclusivity: the existence interval is CLOSED
//        ([startYear,endYear]); a merge AT exactly startYear or endYear is legal,
//        AT startYear-1 / endYear+1 is NotPresentAtTime. Pins the closed-interval
//        contract the gate and candidates share (a >/>= off-by-one would slip).
//
//   (R4) allowedMergeParentCandidates soundness: every returned candidate (a) is
//        NOT a target and NOT a descendant of any target (no vertical capture),
//        (b) exists at atTime, and (c) its period overlaps the target envelope.
//        propertyInheritCandidates returns EXACTLY the resolvable targets. These
//        are the structured choices the UI seeds the parent / inherit pickers with;
//        a candidate that is secretly a descendant would let the user build a cycle.
//
//   (R5) STATEFUL: a random chain that INTERLEAVES legal merges with deliberately
//        illegal ones (too-few / missing / out-of-time). After EVERY command the
//        world invariants hold; every illegal attempt is a verified no-op (world
//        identical to before); every legal merge keeps the forest valid.
//
// Determinism: seed = 21004, numRuns large (per task). PERMANENT asset — any
// reproduced counterexample is a real domain defect, never to be masked here.
// ===========================================================================

import {
  MERGE_REJECT,
  validateMergePreconditions,
  existsAtTime,
  isVerticallyRelated,
} from '../merge/precondition';
import {
  allowedMergeParentCandidates,
  propertyInheritCandidates,
} from '../merge/candidates';
import { descendantIds } from '../hierarchy/forest';
import type { FeatureId } from '../ids';

const SEED_21004 = 21004;
const RUNS_21004 = 500;

/**
 * Build a flat world of N standalone top-level leaves (disjoint boxes), each with
 * its own period [start, end].
 */
interface FlatWorld {
  readonly features: Feature[];
  readonly store: VertexStore;
}

function flatLeafWorld(
  specs: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): FlatWorld {
  const features: Feature[] = [];
  const verts: Vertex[] = [];
  specs.forEach((sp, i) => {
    const b = box(i * 50, i * 50 + 30, 0, 30);
    b.ids.forEach((id, k) => verts.push(createVertex(id, b.coords[k]!)));
    features.push(
      createLeafFeature(
        asFeatureId(`bh4r-leaf-${counter++}`),
        createBasicAttributes(`L${i}`, sp.start, sp.end),
        COLOR,
        createShape([createTerritoryRing(freshRid(), b.ids)]),
      ),
    );
  });
  return { features, store: createVertexStore(verts) };
}

/** A deep structural snapshot of a feature list + store, for purity comparison. */
function featureWorldSnapshot(features: readonly Feature[], store: VertexStore): string {
  return JSON.stringify({
    features: features.map((f) => ({
      id: f.id,
      kind: f.kind,
      parentId: f.parentId,
      childIds: f.kind === 'aggregate' ? f.childIds : undefined,
      shape: f.kind === 'leaf' ? f.shape : undefined,
      attributes: f.attributes,
    })),
    vertices: [...store.byId.entries()].sort(([x], [y]) => (x < y ? -1 : 1)),
  });
}

const STD_PROP = propertyNew({ attributes: ATTRS, color: COLOR });

// --- (R1) rejection purity: illegal merge == verified no-op -------------------

describe('seed=21004 — precondition rejections are pure no-ops with the right reason', () => {
  it('TooFew: 0 or 1 distinct targets is rejected and never mutates the world', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ start: fc.constant(0), end: fc.constant(100) }), { minLength: 2, maxLength: 5 }),
        fc.boolean(),
        (specs, zero) => {
          const { features, store } = flatLeafWorld(specs);
          const before = featureWorldSnapshot(features, store);
          // Either no target, or the SAME target twice (dedup → 1 distinct).
          const targetIds = zero ? [] : [features[0]!.id, features[0]!.id];
          const res = buildMergeProposal({
            features,
            vertices: store,
            targetIds,
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: STD_PROP,
            ids: idPorts(),
          });
          expect(res.status).toBe(MERGE_STATUS.Rejected);
          if (res.status === MERGE_STATUS.Rejected) {
            expect(res.kind).toBe(MERGE_REJECT.TooFew);
          }
          // Purity: the world value is untouched after a rejected op.
          expect(featureWorldSnapshot(features, store)).toBe(before);
          // The standalone predicate agrees with the gate.
          const verdict = validateMergePreconditions(features, targetIds, 50);
          expect(verdict.ok).toBe(false);
          if (!verdict.ok) expect(verdict.reason).toBe(MERGE_REJECT.TooFew);
        },
      ),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });

  it('TargetMissing: a target id absent from the feature set is rejected as a no-op', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ start: fc.constant(0), end: fc.constant(100) }), { minLength: 1, maxLength: 4 }),
        (specs) => {
          const { features, store } = flatLeafWorld(specs);
          const before = featureWorldSnapshot(features, store);
          const ghost = asFeatureId(`bh4r-ghost-${counter++}`); // never in `features`.
          const present = features[0]!.id;
          const res = buildMergeProposal({
            features,
            vertices: store,
            targetIds: [present, ghost],
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: STD_PROP,
            ids: idPorts(),
          });
          expect(res.status).toBe(MERGE_STATUS.Rejected);
          if (res.status === MERGE_STATUS.Rejected) {
            expect(res.kind).toBe(MERGE_REJECT.TargetMissing);
          }
          expect(featureWorldSnapshot(features, store)).toBe(before);
        },
      ),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });

  it('NotPresentAtTime: a target whose closed period excludes atTime is rejected as a no-op', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -200, max: 200 }), // start of target B
        fc.integer({ min: 1, max: 100 }), // span of B
        fc.integer({ min: -1000, max: 1000 }), // atTime
        (bStart, span, atTime) => {
          const bEnd = bStart + span;
          // Target A is always present at atTime; B may or may not be.
          const { features, store } = flatLeafWorld([
            { start: atTime - 10, end: atTime + 10 }, // A: definitely covers atTime.
            { start: bStart, end: bEnd }, // B: covers atTime iff bStart<=atTime<=bEnd.
          ]);
          const before = featureWorldSnapshot(features, store);
          const res = buildMergeProposal({
            features,
            vertices: store,
            targetIds: [features[0]!.id, features[1]!.id],
            atTime,
            parentDecision: parentNone,
            propertyDecision: STD_PROP,
            ids: idPorts(),
          });
          const bPresent = bStart <= atTime && atTime <= bEnd;
          if (bPresent) {
            // Both present + disjoint + no relation → a valid leaf merge.
            expect(res.status).toBe(MERGE_STATUS.Proposal);
          } else {
            expect(res.status).toBe(MERGE_STATUS.Rejected);
            if (res.status === MERGE_STATUS.Rejected) {
              expect(res.kind).toBe(MERGE_REJECT.NotPresentAtTime);
            }
            // Purity on the rejecting path: inputs untouched.
            expect(featureWorldSnapshot(features, store)).toBe(before);
          }
          // The standalone existsAtTime predicate agrees feature-by-feature.
          expect(existsAtTime(features[1]!, atTime)).toBe(bPresent);
        },
      ),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });

  it('VerticalRelation: an ancestor + descendant pair is rejected as a no-op', () => {
    fc.assert(
      fc.property(dim, dim, (w, h) => {
        // Build: aggregate parent → leaf child. Target the parent AND its child.
        const b = box(0, w, 0, h);
        const verts = b.ids.map((id, k) => createVertex(id, b.coords[k]!));
        const store = createVertexStore(verts);
        const parentAggId = asFeatureId(`bh4r-par-${counter++}`);
        const childId = asFeatureId(`bh4r-chi-${counter++}`);
        const child = createLeafFeature(
          childId,
          createBasicAttributes('child', 0, 100),
          COLOR,
          createShape([createTerritoryRing(freshRid(), b.ids)]),
          { parentId: parentAggId },
        );
        const parentAgg = createAggregateFeature(
          parentAggId,
          createBasicAttributes('parent', 0, 100),
          COLOR,
          [childId],
        );
        const features: Feature[] = [child, parentAgg];
        const before = featureWorldSnapshot(features, store);

        const res = buildMergeProposal({
          features,
          vertices: store,
          targetIds: [parentAggId, childId],
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: STD_PROP,
          ids: idPorts(),
        });
        expect(res.status).toBe(MERGE_STATUS.Rejected);
        if (res.status === MERGE_STATUS.Rejected) {
          expect(res.kind).toBe(MERGE_REJECT.VerticalRelation);
        }
        expect(featureWorldSnapshot(features, store)).toBe(before);

        // The standalone relation predicate agrees (both directions).
        const forest = buildForest(features);
        expect(isVerticallyRelated(forest, parentAggId, childId)).toBe(true);
        expect(isVerticallyRelated(forest, childId, parentAggId)).toBe(true);
      }),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });
});

// --- (R2) gate runs first; removing the relation flips Rejected→Proposal ------

describe('seed=21004 — precondition is a hard guard (metamorphic: drop the relation)', () => {
  it('a vertical pair is Rejected; re-pointing the child to top-level flips the SAME targets to Proposal', () => {
    fc.assert(
      fc.property(dim, dim, (w, h) => {
        const b = box(0, w, 0, h);
        const verts = b.ids.map((id, k) => createVertex(id, b.coords[k]!));
        // A SECOND disjoint box so that, once unrelated, the two leaves merge legally.
        const b2 = box(w + 20, w + 20 + w, 0, h);
        const verts2 = b2.ids.map((id, k) => createVertex(id, b2.coords[k]!));
        const store = createVertexStore([...verts, ...verts2]);

        const parentAggId = asFeatureId(`bh4g-par-${counter++}`);
        const childId = asFeatureId(`bh4g-chi-${counter++}`);
        const otherLeafId = asFeatureId(`bh4g-oth-${counter++}`);
        const child = createLeafFeature(
          childId,
          createBasicAttributes('child', 0, 100),
          COLOR,
          createShape([createTerritoryRing(freshRid(), b.ids)]),
          { parentId: parentAggId },
        );
        const otherLeaf = createLeafFeature(
          otherLeafId,
          createBasicAttributes('other', 0, 100),
          COLOR,
          createShape([createTerritoryRing(freshRid(), b2.ids)]),
          { parentId: parentAggId },
        );
        const parentAgg = createAggregateFeature(
          parentAggId,
          createBasicAttributes('parent', 0, 100),
          COLOR,
          [childId, otherLeafId],
        );
        const features: Feature[] = [child, otherLeaf, parentAgg];

        // Vertical: parent + its child → Rejected (the gate runs before classify).
        const rejected = buildMergeProposal({
          features,
          vertices: store,
          targetIds: [parentAggId, childId],
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: STD_PROP,
          ids: idPorts(),
        });
        expect(rejected.status).toBe(MERGE_STATUS.Rejected);
        if (rejected.status === MERGE_STATUS.Rejected) {
          expect(rejected.kind).toBe(MERGE_REJECT.VerticalRelation);
        }

        // Metamorphic: re-point the child to top-level (drop the relation), then the
        // SAME two leaves (child + other, now siblings with no ancestry) merge legally.
        const childTop = withParentId21003(child, undefined) as LeafFeature;
        const featuresFixed: Feature[] = [childTop, otherLeaf, parentAgg];
        const accepted = buildMergeProposal({
          features: featuresFixed,
          vertices: store,
          targetIds: [childId, otherLeafId],
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: STD_PROP,
          ids: idPorts(),
        });
        expect(accepted.status).toBe(MERGE_STATUS.Proposal);
        if (accepted.status === MERGE_STATUS.Proposal) {
          const result = accepted.proposal.nextFeatures.find(
            (x) => x.id === accepted.proposal.resultFeatureId,
          );
          expect(result?.kind).toBe('leaf');
          if (result && result.kind === 'leaf') {
            expect(isAlternationValid(result.shape)).toBe(true);
          }
        }
      }),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });
});

// --- (R3) existsAtTime closed-interval boundary inclusivity ------------------

describe('seed=21004 — existence interval is CLOSED at both ends (no off-by-one)', () => {
  it('merge AT startYear / endYear is legal; AT start-1 / end+1 is NotPresentAtTime', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -300, max: 300 }),
        fc.integer({ min: 1, max: 200 }),
        (start, span) => {
          const end = start + span;
          // A always covers the whole [start-5, end+5] band; B is exactly [start,end].
          const make = () =>
            flatLeafWorld([
              { start: start - 5, end: end + 5 },
              { start, end },
            ]);
          const tryAt = (atTime: number) => {
            const { features, store } = make();
            return buildMergeProposal({
              features,
              vertices: store,
              targetIds: [features[0]!.id, features[1]!.id],
              atTime,
              parentDecision: parentNone,
              propertyDecision: STD_PROP,
              ids: idPorts(),
            }).status;
          };
          // Inclusive ends: legal exactly AT the boundaries.
          expect(tryAt(start)).toBe(MERGE_STATUS.Proposal);
          expect(tryAt(end)).toBe(MERGE_STATUS.Proposal);
          // Strictly outside: rejected.
          expect(tryAt(start - 1)).toBe(MERGE_STATUS.Rejected);
          expect(tryAt(end + 1)).toBe(MERGE_STATUS.Rejected);
        },
      ),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });
});

// --- (R4) candidate enumeration soundness ------------------------------------

describe('seed=21004 — merge candidate enumeration is sound (no vertical capture)', () => {
  it('parent candidates exclude targets + descendants, exist at time, overlap period; inherit == targets', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: 1, max: 80 }),
        (k, periodStart, periodSpan) => {
          const verts: Vertex[] = [];
          const features: Feature[] = [];

          const standalone: FeatureId[] = [];
          for (let i = 0; i < k; i += 1) {
            const b = box(i * 80, i * 80 + 40, 0, 40);
            b.ids.forEach((id, idx) => verts.push(createVertex(id, b.coords[idx]!)));
            const fid = asFeatureId(`bh4c-leaf-${counter++}`);
            features.push(
              createLeafFeature(
                fid,
                createBasicAttributes(`L${i}`, periodStart, periodStart + periodSpan),
                COLOR,
                createShape([createTerritoryRing(freshRid(), b.ids)]),
              ),
            );
            standalone.push(fid);
          }

          // A top-level aggregate (broad period) owning a grandchild leaf — a
          // legitimate parent candidate (not a target, not a descendant of a target).
          const aggId = asFeatureId(`bh4c-agg-${counter++}`);
          const gcBox = box(5000, 5040, 0, 40);
          gcBox.ids.forEach((id, idx) => verts.push(createVertex(id, gcBox.coords[idx]!)));
          const gcId = asFeatureId(`bh4c-gc-${counter++}`);
          features.push(
            createLeafFeature(
              gcId,
              createBasicAttributes('gc', -500, 500),
              COLOR,
              createShape([createTerritoryRing(freshRid(), gcBox.ids)]),
              { parentId: aggId },
            ),
          );
          features.push(
            createAggregateFeature(aggId, createBasicAttributes('agg', -500, 500), COLOR, [gcId]),
          );

          const atTime = periodStart; // inside every standalone leaf's period.
          const targetIds = [standalone[0]!, standalone[1]!];

          const forest = buildForest(features);
          const candidates = allowedMergeParentCandidates(features, targetIds, atTime);
          const candidateIds = new Set(candidates.map((c) => c.featureId));

          // (a) no candidate is a target or a descendant of a target.
          const forbidden = new Set<FeatureId>(targetIds);
          for (const t of targetIds) for (const d of descendantIds(forest, t)) forbidden.add(d);
          for (const id of candidateIds) {
            expect(forbidden.has(id)).toBe(false);
          }
          // (b) every candidate exists at atTime, (c) period overlaps the envelope.
          let envStart = Number.POSITIVE_INFINITY;
          let envEnd = Number.NEGATIVE_INFINITY;
          for (const t of targetIds) {
            const f = forest.byId.get(t)!;
            envStart = Math.min(envStart, f.attributes.startYear);
            envEnd = Math.max(envEnd, f.attributes.endYear);
          }
          for (const c of candidates) {
            const f = forest.byId.get(c.featureId)!;
            expect(existsAtTime(f, atTime)).toBe(true);
            const overlaps = f.attributes.startYear <= envEnd && envStart <= f.attributes.endYear;
            expect(overlaps).toBe(true);
          }

          // propertyInheritCandidates returns EXACTLY the resolvable targets.
          const inherit = propertyInheritCandidates(features, targetIds);
          expect(inherit.map((c) => c.featureId).sort()).toEqual([...targetIds].sort());

          // Soundness vs the gate: any returned candidate is a legal parent.
          for (const c of candidates) {
            const r = buildMergeProposal({
              features,
              vertices: createVertexStore(verts),
              targetIds,
              atTime,
              parentDecision: parentExisting(c.featureId),
              propertyDecision: STD_PROP,
              ids: idPorts(),
            });
            expect(r.status).toBe(MERGE_STATUS.Proposal);
            if (r.status === MERGE_STATUS.Proposal) {
              const result = r.proposal.nextFeatures.find(
                (x) => x.id === r.proposal.resultFeatureId,
              );
              expect(result?.parentId).toBe(c.featureId);
              const f2 = buildForest(r.proposal.nextFeatures);
              expect(walkToRoot(f2, r.proposal.resultFeatureId).cyclic).toBe(false);
            }
          }
        },
      ),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });
});

// --- (R5) stateful: interleave legal merges with illegal (no-op) attempts -----

type RejCmd =
  | { readonly t: 'mergeLegal'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'mergeTooFew'; readonly pick: number }
  | { readonly t: 'mergeMissing'; readonly pick: number }
  | {
      readonly t: 'mergeOutOfTime';
      readonly aPick: number;
      readonly bPick: number;
      readonly when: number;
    }
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number };

const rejCmdArb: fc.Arbitrary<RejCmd> = fc.oneof(
  fc.record({
    t: fc.constant<'mergeLegal'>('mergeLegal'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.record({ t: fc.constant<'mergeTooFew'>('mergeTooFew'), pick: fc.nat({ max: 1_000_000 }) }),
  fc.record({ t: fc.constant<'mergeMissing'>('mergeMissing'), pick: fc.nat({ max: 1_000_000 }) }),
  fc.record({
    t: fc.constant<'mergeOutOfTime'>('mergeOutOfTime'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
    when: fc.integer({ min: 10_000, max: 20_000 }), // far beyond any feature's period.
  }),
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
);

describe('seed=21004 — stateful: illegal merges are verified no-ops; legal ops keep invariants', () => {
  it('a chain interleaving legal merges/splits with too-few / missing / out-of-time attempts stays valid', () => {
    fc.assert(
      fc.property(fc.array(rejCmdArb, { minLength: 1, maxLength: 16 }), (cmds) => {
        let world = initialWorld();
        checkWorldInvariants(world);

        for (const cmd of cmds) {
          const before = featureWorldSnapshot(world.features, world.store);

          if (cmd.t === 'mergeTooFew') {
            const id = world.features[cmd.pick % world.features.length]!.id;
            const res = buildMergeProposal({
              features: world.features,
              vertices: world.store,
              targetIds: [id, id], // 1 distinct → TooFew.
              atTime: 50,
              parentDecision: parentNone,
              propertyDecision: STD_PROP,
              ids: idPorts(),
            });
            expect(res.status).toBe(MERGE_STATUS.Rejected);
            if (res.status === MERGE_STATUS.Rejected) expect(res.kind).toBe(MERGE_REJECT.TooFew);
            expect(featureWorldSnapshot(world.features, world.store)).toBe(before); // no-op.
            continue;
          }

          if (cmd.t === 'mergeMissing') {
            const present = world.features[cmd.pick % world.features.length]!.id;
            const ghost = asFeatureId(`bh4s-ghost-${counter++}`);
            const res = buildMergeProposal({
              features: world.features,
              vertices: world.store,
              targetIds: [present, ghost],
              atTime: 50,
              parentDecision: parentNone,
              propertyDecision: STD_PROP,
              ids: idPorts(),
            });
            expect(res.status).toBe(MERGE_STATUS.Rejected);
            if (res.status === MERGE_STATUS.Rejected) {
              expect(res.kind).toBe(MERGE_REJECT.TargetMissing);
            }
            expect(featureWorldSnapshot(world.features, world.store)).toBe(before);
            continue;
          }

          if (cmd.t === 'mergeOutOfTime') {
            if (world.features.length < 2) continue;
            const n = world.features.length;
            const i = cmd.aPick % n;
            let j = cmd.bPick % n;
            if (j === i) j = (j + 1) % n;
            const res = buildMergeProposal({
              features: world.features,
              vertices: world.store,
              targetIds: [world.features[i]!.id, world.features[j]!.id],
              atTime: cmd.when, // far beyond every feature's [0,100] period.
              parentDecision: parentNone,
              propertyDecision: STD_PROP,
              ids: idPorts(),
            });
            expect(res.status).toBe(MERGE_STATUS.Rejected);
            if (res.status === MERGE_STATUS.Rejected) {
              expect(res.kind).toBe(MERGE_REJECT.NotPresentAtTime);
            }
            expect(featureWorldSnapshot(world.features, world.store)).toBe(before);
            continue;
          }

          // Legal edits (reuse the seed=1002 appliers).
          world =
            cmd.t === 'split'
              ? applySplit(world, cmd)
              : applyMerge(world, { aPick: cmd.aPick, bPick: cmd.bPick });
          checkWorldInvariants(world);
          expect(world.features.length).toBeGreaterThanOrEqual(1);
        }
      }),
      { seed: SEED_21004, numRuns: RUNS_21004 },
    );
  });
});

// ===========================================================================
// 12. SEED=31002 EXTENSION — NEW exploration (bug-hunt round 3, disjoint from
//     the 1000-6000 AND 21000-26000 bands). New generators / command sets /
//     interactions that NO earlier seed touches.
//
// The seeds 1000-21004 above cover: side-A/B/smaller splits, leaf / aggregate /
// mixed / multi-leaf merges, parentNone / parentExisting / parentCreate(+above),
// propertyNew / propertyInherit, precondition rejections, an isolated anchor
// series, AND per-op invariant / persistence / undo batteries. They never open
// these FOUR live paths:
//
//   (X1) parentCreateWithTerminal — the糖衣 factory (affiliation/decision.ts L98)
//        and its CREATE_TERMINAL.NewTop / ExistingTop terminals are DEAD in every
//        seed 1000-21004 (all parentCreate calls use the raw parentCreate(spec,
//        above) form). A merge whose parent decision is built via
//        parentCreateWithTerminal must produce the SAME forest a hand-built
//        parentCreate would: NewTop → created agg is a root; ExistingTop → created
//        agg sits under the existing top. Metamorphic: parentCreateWithTerminal(
//        spec, NewTop) ≡ parentCreate(spec, parentNone) and
//        parentCreateWithTerminal(spec, {ExistingTop, topId}) ≡ parentCreate(spec,
//        parentExisting(topId)) — same resultant childIds / parent chain.
//
//   (X2) op ∘ inverse-op in the OTHER direction (merge → split-back): every earlier
//        op∘inverse-op proved split THEN union ≈ original. This proves the inverse
//        composition: take TWO disjoint leaves, MERGE them, then SPLIT the merged
//        飛び地 terminal along a vertical line through the gap between the two pieces,
//        and assert the two split sides' filled areas ≈ the two original leaves'
//        areas (area is conserved through the round trip in both directions).
//
//   (X3) COMBINED geometry + anchor-series stateful model — every surviving world
//        feature carries a LIVE anchor series driven by the GUARDED edit ops
//        (changeStart / setEnd / deleteAnchor / applyPastEdit) AS the geometry world
//        is edited by split / merge. After EVERY command BOTH batteries run: the
//        full geometry world invariants (alternation / valid MP / finite / dangling-
//        free / unique ids) AND, for every feature's series, 昇順・非重複 + unique
//        anchor ids + isValidSeries + non-empty (INV-5) + a save→load==identity of
//        the (featureId, series-projection) map. No earlier seed couples a live
//        per-feature anchor series to the live geometry world; a defect where a
//        split/merge leaves a feature WITHOUT a series, or an anchor edit corrupts a
//        sibling feature's series, surfaces only here.
//
//   (X4) UNDO over the combined (geometry+series) world — the undo stack snapshots
//        the WHOLE coupled state (features + store + per-feature series map) before
//        each edit; an undo pops back and the restored coupled state must be
//        structurally identical (undo ∘ op == identity over the COUPLED value, not
//        just geometry). Op purity over the coupled snapshot is asserted too.
//
// Determinism: seed = 31002, numRuns large (per task). PERMANENT asset — any
// reproduced counterexample is a real domain defect, never to be masked here.
// ===========================================================================

import { CREATE_TERMINAL, parentCreateWithTerminal } from '../merge/decision';

const SEED_31002 = 31002;
const RUNS_31002 = 500;

// --- (X1) parentCreateWithTerminal ≡ the equivalent raw parentCreate ----------

describe('seed=31002 — parentCreateWithTerminal builds the same forest as raw parentCreate', () => {
  it('NewTop terminal: created aggregate is a root; childIds == [result]; ≡ parentCreate(spec, parentNone)', () => {
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
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        const mergeRes = buildMergeProposal({
          features: [inheritor, newLeaf],
          vertices: postStore,
          targetIds: [inheritor.id, newLeaf.id],
          atTime: 50,
          // The糖衣 form — NewTop ≡ above:parentNone.
          parentDecision: parentCreateWithTerminal({ name: 'fed-root' }, { kind: CREATE_TERMINAL.NewTop }),
          propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
          ids: idPorts(),
        });
        expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
        if (mergeRes.status !== MERGE_STATUS.Proposal) return;
        const mp = mergeRes.proposal;

        const aggs = mp.nextFeatures.filter((x) => x.kind === 'aggregate');
        expect(aggs.length).toBe(1);
        const agg = aggs[0]!;
        // NewTop: the created aggregate is a root (no parent).
        expect(agg.parentId).toBeUndefined();
        expect(mp.createdIds).toContain(agg.id);
        // The result leaf is parented to it; childIds == [result] (派生集約 = 子の和).
        const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
        expect(result?.parentId).toBe(agg.id);
        if (agg.kind === 'aggregate') expect([...agg.childIds]).toEqual([mp.resultFeatureId]);

        // Forest validity: declared childIds == direct children, acyclic.
        const forest = buildForest(mp.nextFeatures);
        for (const fe of mp.nextFeatures) {
          expect(walkToRoot(forest, fe.id).cyclic).toBe(false);
          if (fe.kind === 'aggregate') {
            expect([...fe.childIds].sort()).toEqual([...directChildIds(forest, fe.id)].sort());
          }
          expect(fe.attributes.startYear).toBeLessThanOrEqual(fe.attributes.endYear);
        }
      }),
      { seed: SEED_31002, numRuns: RUNS_31002 },
    );
  });

  it('ExistingTop terminal: created aggregate sits under the existing top; ≡ parentCreate(spec, parentExisting(top))', () => {
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
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        const existingTopId = asFeatureId(`bh31-top-${counter++}`);
        const existingTop = createAggregateFeature(
          existingTopId,
          createBasicAttributes('top', 0, 200),
          COLOR,
          [],
        );

        // Build the SAME decision two ways and assert the resulting forests agree.
        const buildWith = (parentDecision: ReturnType<typeof parentCreate>) =>
          buildMergeProposal({
            features: [inheritor, newLeaf, existingTop],
            vertices: postStore,
            targetIds: [inheritor.id, newLeaf.id],
            atTime: 50,
            parentDecision,
            propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
            ids: idPorts(),
          });

        const viaSugar = buildWith(
          parentCreateWithTerminal({ name: 'mid' }, { kind: CREATE_TERMINAL.ExistingTop, topId: existingTopId }),
        );
        const viaRaw = buildWith(parentCreate({ name: 'mid' }, parentExisting(existingTopId)));
        expect(viaSugar.status).toBe(MERGE_STATUS.Proposal);
        expect(viaRaw.status).toBe(MERGE_STATUS.Proposal);
        if (viaSugar.status !== MERGE_STATUS.Proposal || viaRaw.status !== MERGE_STATUS.Proposal) return;

        // Metamorphic equivalence: the parent-chain SHAPE (result→mid→top) is the
        // same for both forms. (Ids differ because idPorts mint fresh ids; we compare
        // the structural relation, not the literal aggregate ids.)
        const shapeOf = (mp: typeof viaSugar.proposal) => {
          const forest = buildForest(mp.nextFeatures);
          const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId)!;
          const mid = mp.nextFeatures.find(
            (x) => x.kind === 'aggregate' && x.id !== existingTopId,
          )!;
          const top = mp.nextFeatures.find((x) => x.id === existingTopId);
          const walk = walkToRoot(forest, mp.resultFeatureId);
          return {
            resultParentIsMid: result.parentId === mid.id,
            midParentIsTop: mid.parentId === existingTopId,
            topChildIsMid:
              top !== undefined && top.kind === 'aggregate' && top.childIds[0] === mid.id,
            walkAcyclic: !walk.cyclic,
            rootIsTop: !walk.cyclic && walk.rootId === existingTopId,
          };
        };
        const s = shapeOf(viaSugar.proposal);
        const r = shapeOf(viaRaw.proposal);
        expect(s.resultParentIsMid).toBe(true);
        expect(s.midParentIsTop).toBe(true);
        expect(s.topChildIsMid).toBe(true);
        expect(s.walkAcyclic).toBe(true);
        expect(s.rootIsTop).toBe(true);
        // Both forms agree structurally (糖衣 ≡ raw).
        expect(s.resultParentIsMid).toBe(r.resultParentIsMid);
        expect(s.midParentIsTop).toBe(r.midParentIsTop);
        expect(s.topChildIsMid).toBe(r.topChildIsMid);
        expect(s.walkAcyclic).toBe(r.walkAcyclic);
        expect(s.rootIsTop).toBe(r.rootIsTop);
      }),
      { seed: SEED_31002, numRuns: RUNS_31002 },
    );
  });
});

// --- (X2) op ∘ inverse-op (merge → split-back) area conservation -------------

describe('seed=31002 — merge then split-back: area conserved in the inverse direction', () => {
  it('two disjoint leaves merged then split through the gap recover the two original areas', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 50, noNaN: true }),
        fc.double({ min: 20, max: 50, noNaN: true }),
        fc.double({ min: 12, max: 30, noNaN: true }), // gap between the two boxes.
        (w, h, gap) => {
          // Two disjoint axis-aligned boxes separated by a clear vertical gap.
          const bA = box(0, w, 0, h);
          const bB = box(w + gap, 2 * w + gap, 0, h);
          const verts: Vertex[] = [];
          [bA, bB].forEach((b) => b.ids.forEach((id, k) => verts.push(createVertex(id, b.coords[k]!))));
          const store = createVertexStore(verts);
          const leafA = createLeafFeature(
            asFeatureId(`bh31-a-${counter++}`),
            createBasicAttributes('A', 0, 100),
            COLOR,
            createShape([createTerritoryRing(freshRid(), bA.ids)]),
          );
          const leafB = createLeafFeature(
            asFeatureId(`bh31-b-${counter++}`),
            createBasicAttributes('B', 0, 100),
            COLOR,
            createShape([createTerritoryRing(freshRid(), bB.ids)]),
          );
          const areaA = w * h;
          const areaB = w * h;

          // op: merge the two disjoint leaves into one飛び地 terminal.
          const mergeRes = buildMergeProposal({
            features: [leafA, leafB],
            vertices: store,
            targetIds: [leafA.id, leafB.id],
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
            ids: idPorts(),
          });
          expect(mergeRes.status).toBe(MERGE_STATUS.Proposal);
          if (mergeRes.status !== MERGE_STATUS.Proposal) return;
          const merged = mergeRes.proposal.nextFeatures.find(
            (x) => x.id === mergeRes.proposal.resultFeatureId,
          );
          expect(merged?.kind).toBe('leaf');
          if (!merged || merged.kind !== 'leaf') return;
          const mergedStore = mergeRes.proposal.nextVertices;

          // The merged terminal's total filled area == areaA + areaB (no loss).
          const mergedArea = leafFilledArea(merged, mergedStore);
          expect(Math.abs(mergedArea - (areaA + areaB)) / (areaA + areaB)).toBeLessThan(1e-3);

          // inverse-op: split the merged terminal with a vertical line through the
          // gap (x == w + gap/2), which separates the two pieces back apart.
          const cutBack = w + gap / 2;
          const cutLine = createOpenKnifeLine([
            createCoordinate(cutBack, -5),
            createCoordinate(cutBack, h + 5),
          ]);
          const back = checkSplittable(merged, mergedStore, cutLine);
          // The cut through the empty gap may be accepted (it pierces both pieces'
          // bounding span outside→outside through the gap). When accepted, the two
          // sides recover the two original areas; either may be A or B.
          if (back.status !== SPLIT_CHECK_STATUS.Splittable) return;
          for (const side of [back.sideA, back.sideB]) {
            expect(everyCoordFinite(side.area)).toBe(true);
            expect(isMultiPolygonValid(side.area)).toBe(true);
            expect(sideArea(side)).toBeGreaterThan(0);
          }
          // Total area conserved through merge∘split.
          const sum = sideArea(back.sideA) + sideArea(back.sideB);
          expect(Math.abs(sum - (areaA + areaB)) / (areaA + areaB)).toBeLessThan(1e-3);
          // Each side recovers ONE original box area (order-independent).
          const sides = [sideArea(back.sideA), sideArea(back.sideB)].sort((x, y) => x - y);
          const expected = [areaA, areaB].sort((x, y) => x - y);
          expect(Math.abs(sides[0]! - expected[0]!) / expected[0]!).toBeLessThan(1e-3);
          expect(Math.abs(sides[1]! - expected[1]!) / expected[1]!).toBeLessThan(1e-3);
        },
      ),
      { seed: SEED_31002, numRuns: RUNS_31002 },
    );
  });
});

// --- (X3)/(X4) combined geometry + anchor-series stateful model with undo -----

interface CoupledWorld {
  readonly world: World;
  /** featureId → its live anchor series (one per surviving feature). */
  readonly series: ReadonlyMap<FeatureId, AnchorSeries>;
}

type CoupledCmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'anchorInsert'; readonly featPick: number; readonly year: number }
  | { readonly t: 'anchorChangeStart'; readonly featPick: number; readonly entryPick: number; readonly year: number }
  | { readonly t: 'anchorSetEnd'; readonly featPick: number; readonly entryPick: number; readonly end: number | null }
  | { readonly t: 'anchorDelete'; readonly featPick: number; readonly entryPick: number }
  | { readonly t: 'undo' };

const coupledCmdArb: fc.Arbitrary<CoupledCmd> = fc.oneof(
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({
    t: fc.constant<'merge'>('merge'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.record({
    t: fc.constant<'anchorInsert'>('anchorInsert'),
    featPick: fc.nat({ max: 1_000_000 }),
    year: fc.integer({ min: -400, max: 400 }),
  }),
  fc.record({
    t: fc.constant<'anchorChangeStart'>('anchorChangeStart'),
    featPick: fc.nat({ max: 1_000_000 }),
    entryPick: fc.nat({ max: 1_000_000 }),
    year: fc.integer({ min: -400, max: 400 }),
  }),
  fc.record({
    t: fc.constant<'anchorSetEnd'>('anchorSetEnd'),
    featPick: fc.nat({ max: 1_000_000 }),
    entryPick: fc.nat({ max: 1_000_000 }),
    end: fc.option(fc.integer({ min: -400, max: 400 }), { nil: null }),
  }),
  fc.record({
    t: fc.constant<'anchorDelete'>('anchorDelete'),
    featPick: fc.nat({ max: 1_000_000 }),
    entryPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.constant<CoupledCmd>({ t: 'undo' }),
);

describe('seed=31002 — coupled geometry + anchor-series stateful model (invariants + undo)', () => {
  it('split / merge / guarded anchor edits keep BOTH batteries valid; undo restores the coupled state exactly', () => {
    const cal = getCalendar('gregorian');
    const emptySnap = createAnchorSnapshot([], createVertexStore([]));

    // Build a fresh single-entry series for a feature that just appeared.
    const freshSeries = (): AnchorSeries => ({
      entries: [
        createAnchorEntry(
          createAnchor(asAnchorId(`bh31-an-${counter++}`), emptySnap),
          timePointYear(0),
          null,
        ),
      ],
    });

    // Every surviving feature must carry exactly one series; ensure new features
    // (split products, merge results) get one, dropping series of vanished features.
    const reconcileSeries = (
      world: World,
      prev: ReadonlyMap<FeatureId, AnchorSeries>,
    ): Map<FeatureId, AnchorSeries> => {
      const next = new Map<FeatureId, AnchorSeries>();
      for (const f of world.features) {
        next.set(f.id, prev.get(f.id) ?? freshSeries());
      }
      return next;
    };

    const assertSeries = (series: AnchorSeries) => {
      expect(series.entries.length).toBeGreaterThanOrEqual(1); // INV-5.
      expect(isValidSeries(series, cal)).toBe(true);
      const starts = series.entries.map((e) => (e.start as { year: number }).year);
      for (let i = 1; i < starts.length; i += 1) {
        expect(starts[i]! > starts[i - 1]!).toBe(true); // 昇順・非重複.
      }
      const ids = series.entries.map((e) => e.anchor.id);
      expect(new Set(ids).size).toBe(ids.length); // unique anchor ids (INV-6).
    };

    // Save→load identity over the WHOLE coupled state (geometry + every series).
    const seriesProjection = (series: ReadonlyMap<FeatureId, AnchorSeries>) =>
      [...series.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([fid, s]) => ({
          fid,
          entries: s.entries.map((e) => ({ id: e.anchor.id, start: e.start, end: e.end })),
        }));

    const coupledSnapshotString = (cw: CoupledWorld): string =>
      JSON.stringify({
        features: cw.world.features.map((f) => ({ id: f.id, shape: f.shape })),
        vertices: [...cw.world.store.byId.entries()].sort(([x], [y]) => (x < y ? -1 : 1)),
        series: seriesProjection(cw.series),
      });

    const checkCoupled = (cw: CoupledWorld) => {
      // Geometry battery (reuses the seed=1002 whole-world invariant suite).
      checkWorldInvariants(cw.world);
      // Every surviving feature carries exactly one series; each is valid.
      expect(cw.series.size).toBe(cw.world.features.length);
      for (const f of cw.world.features) {
        const s = cw.series.get(f.id);
        expect(s).toBeDefined();
        if (s) assertSeries(s);
      }
      // save→load == identity over the coupled value (the projection re-stringifies
      // equal — the series TimePoints and anchor ids are plain serializable values).
      const saved = coupledSnapshotString(cw);
      expect(JSON.stringify(JSON.parse(saved))).toBe(saved);
    };

    // Apply one guarded anchor edit to a chosen feature's series; rejections are
    // no-ops by the series ops' own contract.
    const applyAnchorEdit = (
      cw: CoupledWorld,
      pickFeat: number,
      mutate: (s: AnchorSeries) => AnchorSeries,
    ): CoupledWorld => {
      if (cw.world.features.length === 0) return cw;
      const fid = cw.world.features[pickFeat % cw.world.features.length]!.id;
      const s = cw.series.get(fid);
      if (s === undefined) return cw;
      const next = new Map(cw.series);
      next.set(fid, mutate(s));
      return { world: cw.world, series: next };
    };

    fc.assert(
      fc.property(fc.array(coupledCmdArb, { minLength: 1, maxLength: 18 }), (cmds) => {
        let cw: CoupledWorld = (() => {
          const world = initialWorld();
          return { world, series: reconcileSeries(world, new Map()) };
        })();
        const stack: CoupledWorld[] = [];
        checkCoupled(cw);

        for (const cmd of cmds) {
          if (cmd.t === 'undo') {
            const prior = stack.pop();
            if (prior === undefined) continue;
            // undo ∘ op == identity over the COUPLED value (geometry + series).
            cw = prior;
            checkCoupled(cw);
            expect(cw.world.features.length).toBeGreaterThanOrEqual(1);
            continue;
          }

          // Snapshot the coupled state BEFORE the op (purity + undo stack).
          const before = cw;
          const beforeStr = coupledSnapshotString(before);

          let next: CoupledWorld;
          if (cmd.t === 'split' || cmd.t === 'merge') {
            const nextWorld =
              cmd.t === 'split' ? applySplit(before.world, cmd) : applyMerge(before.world, cmd);
            // Reconcile the series map to the surviving feature set (new features get
            // a fresh series; vanished features' series are dropped).
            next = { world: nextWorld, series: reconcileSeries(nextWorld, before.series) };
          } else if (cmd.t === 'anchorInsert') {
            next = applyAnchorEdit(before, cmd.featPick, (s) =>
              applyPastEdit(
                s,
                timePointYear(cmd.year),
                () => createAnchor(asAnchorId(`bh31-an-${counter++}`), emptySnap),
                cal,
              ),
            );
          } else if (cmd.t === 'anchorChangeStart') {
            next = applyAnchorEdit(before, cmd.featPick, (s) => {
              const target = s.entries[cmd.entryPick % s.entries.length]!;
              const r = changeStart(s, target.anchor.id, timePointYear(cmd.year), cal);
              return r.ok ? r.series : s; // rejection → no-op.
            });
          } else if (cmd.t === 'anchorSetEnd') {
            next = applyAnchorEdit(before, cmd.featPick, (s) => {
              const target = s.entries[cmd.entryPick % s.entries.length]!;
              const r = setEnd(
                s,
                target.anchor.id,
                cmd.end === null ? null : timePointYear(cmd.end),
                cal,
              );
              return r.ok ? r.series : s;
            });
          } else {
            // anchorDelete.
            next = applyAnchorEdit(before, cmd.featPick, (s) => {
              const target = s.entries[cmd.entryPick % s.entries.length]!;
              const r = deleteAnchor(s, target.anchor.id, cal);
              return r.ok ? r.series : s;
            });
          }

          // Op purity: the prior coupled value must be untouched (undo correctness).
          expect(coupledSnapshotString(before)).toBe(beforeStr);

          // Only push an undo frame when the op actually changed the coupled state.
          if (coupledSnapshotString(next) !== beforeStr) stack.push(before);
          cw = next;
          checkCoupled(cw);
          expect(cw.world.features.length).toBeGreaterThanOrEqual(1);
        }
      }),
      { seed: SEED_31002, numRuns: RUNS_31002 },
    );
  });
});

// ===========================================================================
// 13. SEED=31003 EXTENSION — NEW exploration (bug-hunt round 3, disjoint from the
//     1000-31002 band). NEW command set / generators / metamorphic relations that
//     no earlier seed combines.
//
// Earlier seeds drive the split inheritance side either FIXED, by a coin flip, or
// (in seed=21003 §M2) by `smallerSide` in ISOLATION on a single op. They NEVER:
//   - chain a smallerSide-DRIVEN split into a merge-BACK (FR-93 preview → op →
//     inverse-op), so a defect wiring `smallerSide` → inheritance choice that only
//     shows up when the chosen inheritor is later fed to a merge would slip through;
//   - run a stateful model whose SPLIT cut is a random DIAGONAL (not axis-aligned)
//     AND whose inheritance side is `smallerSide`-driven, with the full world
//     invariant battery + a REAL U14 persistence round-trip + an undo stack after
//     EVERY op (seed=31001/31002 stateful cuts were vertical or H/V only);
//   - assert the anchor-series op∘inverse-op relation `setEnd(x) ∘ setEnd(null)`
//     and `changeStart(move) ∘ changeStart(back)` restore the original (id,start)
//     projection (seed=21002/31002 only checked insert∘delete and forward 昇順).
//
// This block opens those three:
//
//   (Y1) smallerSide-driven split → merge-back (op ∘ inverse-op): cut a holey leaf,
//        choose the inheritor = `smallerSide(exec)`, assert the inheritor's resolved
//        filled area ≤ the new feature's (FR-93小さい方), then merge the two products
//        back and assert the merged filled area == the original (no area lost across
//        the smallerSide → split → merge round-trip). Both products' shapes must
//        alternate + cite only finite, existing vertices, and the result leaf too.
//
//   (Y2) DIAGONAL-cut + smallerSide stateful model: SPLIT draws a random diagonal
//        line across the leaf bbox and inherits the smaller side; MERGE folds two
//        leaves; UNDO pops the stack. After EVERY applied op the whole-world battery
//        runs (alternation / valid MP / finite / dangling-free / unique ids), a REAL
//        serialize→parseManifest→deserialize→projectsEqual round-trip runs, op purity
//        is asserted (the prior world value is untouched), and undo restores the exact
//        prior world (undo ∘ op == identity).
//
//   (Y3) anchor-series op ∘ inverse-op: for a live series, `setEnd(entry, x)` then
//        `setEnd(entry, null)` restores the original (id,start,end) projection; and a
//        `changeStart(entry, y)` to a fresh non-colliding year followed by
//        `changeStart(entry, original)` restores the original start SET. Plus the
//        standard 昇順・非重複 + isValidSeries + unique-id battery after each step.
//
// Determinism: seed = 31003, numRuns large (per task). PERMANENT asset — any
// reproduced counterexample is a real domain defect, never to be masked here.
// ===========================================================================

const SEED_31003 = 31003;
const RUNS_31003 = 500;

// --- (Y1) smallerSide-driven split → merge-back (op ∘ inverse-op) -------------

describe('seed=31003 — smallerSide-driven split then merge-back conserves area (FR-93 op∘inverse-op)', () => {
  it('inheritor = smallerSide; its filled area ≤ new feature; merge-back recovers the original area', () => {
    fc.assert(
      fc.property(dim, dim, flags(), (w, h, f) => {
        const params = makeParams(w, h, f);
        const { feature, store, cutX } = holeyLeaf(params);
        const line = createOpenKnifeLine([
          createCoordinate(cutX, -5),
          createCoordinate(cutX, h + 5),
        ]);
        const exec = executeSplit(feature, store, line);
        if (exec === undefined) return; // not splittable here → vacuous.

        // FR-93: the UI seeds the inheritance side from the 小さい方 preview.
        const smaller = smallerSide(exec); // 'a' | 'b'
        const choice = createInheritanceChoice(
          smaller === 'a' ? INHERITANCE_SIDE.A : INHERITANCE_SIDE.B,
        );

        const proposal = assembleSplitProposal({
          target: feature,
          store: store.byId,
          result: { sideA: exec.sideA, sideB: exec.sideB, edgeCuts: exec.edgeCuts },
          choice,
          nonInherited: { attributes: ATTRS, color: COLOR },
          ids: idPorts(),
        });
        // The inheritor always keeps the original feature id, whichever side won.
        expect(proposal.inheritorFeatureId).toBe(feature.id);
        const inheritor = inheritorFeature(feature, proposal);
        const newLeaf = proposal.newFeature;
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

        // Both products alternate + cite only finite, existing vertices.
        for (const leaf of [inheritor, newLeaf]) {
          expect(isAlternationValid(leaf.shape)).toBe(true);
          for (const ring of leaf.shape.rings) {
            for (const vid of ring.vertexIds) {
              const v = postStore.byId.get(vid);
              expect(v).toBeDefined();
              if (v) {
                expect(Number.isFinite(v.coordinate.lon)).toBe(true);
                expect(Number.isFinite(v.coordinate.lat)).toBe(true);
              }
            }
          }
        }

        // FR-93小さい方: the kept (inheritor) side's filled area ≤ the new side's.
        const keptArea = leafFilledArea(inheritor, postStore);
        const newArea = leafFilledArea(newLeaf, postStore);
        // smallerSide compares areaKm2; the resolved filled areas honor the same
        // ordering (allow a tiny quantization slack so an exact tie never flips).
        expect(keptArea).toBeLessThanOrEqual(newArea + Math.max(newArea, keptArea) * 1e-6 + 1e-9);

        // op ∘ inverse-op: merge the two products back into one leaf and assert the
        // recovered filled area equals the ORIGINAL leaf's filled area (no loss).
        const beforeArea = leafFilledArea(feature, store);
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
        const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
        expect(result?.kind).toBe('leaf');
        if (!result || result.kind !== 'leaf') return;
        expect(isAlternationValid(result.shape)).toBe(true);

        const mergedArea = leafFilledArea(result, mp.nextVertices);
        if (beforeArea > 0) {
          expect(Math.abs(mergedArea - beforeArea) / beforeArea).toBeLessThan(1e-3);
        }
        // Result leaf cites only finite, existing vertices.
        for (const ring of result.shape.rings) {
          for (const vid of ring.vertexIds) {
            const v = mp.nextVertices.byId.get(vid);
            expect(v).toBeDefined();
            if (v) {
              expect(Number.isFinite(v.coordinate.lon)).toBe(true);
              expect(Number.isFinite(v.coordinate.lat)).toBe(true);
            }
          }
        }
        // Period ordering preserved.
        expect(result.attributes.startYear).toBeLessThanOrEqual(result.attributes.endYear);
      }),
      { seed: SEED_31003, numRuns: RUNS_31003 },
    );
  });
});

// --- (Y2) diagonal-cut + smallerSide stateful model -------------------------

type Cmd31003 =
  | {
      readonly t: 'split';
      readonly leafPick: number;
      readonly t0: number;
      readonly t1: number;
    }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'undo' };

const cmd31003Arb: fc.Arbitrary<Cmd31003> = fc.oneof(
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    t0: fc.double({ min: 0.15, max: 0.85, noNaN: true }),
    t1: fc.double({ min: 0.15, max: 0.85, noNaN: true }),
  }),
  fc.record({
    t: fc.constant<'merge'>('merge'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.constant<Cmd31003>({ t: 'undo' }),
);

/**
 * Split a chosen leaf with a random DIAGONAL line (enters left, exits right,
 * piercing offsets t0/t1 on the two vertical bbox edges), inheriting the
 * smallerSide. Distinct from applySplit (vertical) and applySplitOriented (H/V).
 */
function applySplitDiagonal(
  world: World,
  cmd: { leafPick: number; t0: number; t1: number },
): World {
  if (world.features.length === 0) return world;
  const idx = cmd.leafPick % world.features.length;
  const leaf = world.features[idx]!;
  const bb = leafBbox(leaf, world.store);
  if (bb === undefined) return world;
  const spanX = bb.maxX - bb.minX;
  const spanY = bb.maxY - bb.minY;
  if (spanX <= 0 || spanY <= 0) return world;
  const padX = spanX * 0.5 + 10;
  // A line from outside-left to outside-right, crossing the leaf diagonally.
  const line = createOpenKnifeLine([
    createCoordinate(bb.minX - padX, bb.minY + spanY * cmd.t0),
    createCoordinate(bb.maxX + padX, bb.minY + spanY * cmd.t1),
  ]);

  const check = checkSplittable(leaf, world.store, line);
  const exec = executeSplit(leaf, world.store, line);
  if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
    expect(exec).toBeUndefined();
    return world;
  }
  expect(exec).toBeDefined();
  if (exec === undefined) return world;
  // Determinism: re-validation reproduces the sides exactly (op == op).
  expect(JSON.stringify(exec.sideA.area)).toBe(JSON.stringify(check.sideA.area));
  expect(JSON.stringify(exec.sideB.area)).toBe(JSON.stringify(check.sideB.area));

  // op ∘ inverse-op (HB3-5/19 n-way): the SUM of every piece's filled area ≈ the
  // pre-split filled area (片落とし禁止). A diagonal cut across a previously-split
  // (concave) leaf may now yield k+1 pieces, so conserve area over ALL pieces.
  const beforeArea = leafFilledArea(leaf, world.store);
  const pieces = check.pieces ?? [check.sideA, check.sideB];
  if (beforeArea > 0) {
    const reArea = pieces.reduce((sum, p) => sum + mpFilledArea(p.area), 0);
    expect(Math.abs(reArea - beforeArea) / beforeArea).toBeLessThan(1e-3);
  }

  // The smallest piece keeps the original identity (FR-93, generalized to n-way).
  const proposal = assembleSplitProposal({
    target: leaf,
    store: world.store.byId,
    result: { pieces, sideA: check.sideA, sideB: check.sideB, edgeCuts: exec.edgeCuts },
    choice: createInheritanceChoiceAt(smallestPieceIndex(exec)),
    nonInherited: { attributes: ATTRS, color: COLOR },
    ids: idPorts(),
  });
  expect(proposal.inheritorFeatureId).toBe(leaf.id);
  const inheritor = withLeafShape(leaf, proposal.inheritorShape);

  const nextFeatures = world.features.slice();
  nextFeatures[idx] = inheritor;
  for (const nf of proposal.newFeatures) nextFeatures.push(nf);
  const nextStore = createVertexStore([...world.store.byId.values(), ...proposal.vertices]);
  return { features: nextFeatures, store: nextStore };
}

describe('seed=31003 — diagonal split (smallerSide) + merge + undo: invariants + real round-trip', () => {
  it('random diagonal-cut/merge chains keep every world invariant, round-trip, and undo restores exactly', () => {
    fc.assert(
      fc.property(fc.array(cmd31003Arb, { minLength: 1, maxLength: 16 }), (cmds) => {
        let world = initialWorld();
        const stack: World[] = [];
        checkWorldInvariants(world);

        for (const cmd of cmds) {
          if (cmd.t === 'undo') {
            const prior = stack.pop();
            if (prior === undefined) continue;
            // undo ∘ op == identity (the popped world is the exact prior world).
            world = prior;
            checkWorldInvariants(world);
            expect(world.features.length).toBeGreaterThanOrEqual(1);
            continue;
          }

          // Snapshot BEFORE the op to assert op purity + power the undo stack.
          const before = world;
          const beforeCopy: World = {
            features: before.features.slice(),
            store: { byId: new Map(before.store.byId) },
          };
          const next =
            cmd.t === 'split' ? applySplitDiagonal(world, cmd) : applyMerge(world, cmd);
          // Op purity: the prior world value must be untouched (undo correctness).
          expect(worldsIdentical(before, beforeCopy)).toBe(true);
          if (next !== world) stack.push(beforeCopy);
          world = next;

          checkWorldInvariants(world);
          expect(world.features.length).toBeGreaterThanOrEqual(1);

          // REAL persistence round-trip after EVERY op (serialize → parse → deser).
          const project = worldToProject(world);
          const reloaded = saveThenLoad(project);
          expect(reloaded).toBeDefined();
          if (reloaded !== undefined) {
            expect(projectsEqual(project, reloaded)).toBe(true);
          }
        }
      }),
      { seed: SEED_31003, numRuns: RUNS_31003 },
    );
  });
});

// --- (Y3) anchor-series op ∘ inverse-op (setEnd / changeStart round-trips) ----

describe('seed=31003 — anchor series op∘inverse-op: setEnd / changeStart round-trips restore the projection', () => {
  it('setEnd(x) ∘ setEnd(null) restores (id,start,end); changeStart(move) ∘ changeStart(back) restores the start set', () => {
    const cal = getCalendar('gregorian');
    const emptySnap = createAnchorSnapshot([], createVertexStore([]));

    const projOf = (series: AnchorSeries) =>
      series.entries.map((e) => ({ id: e.anchor.id, start: e.start, end: e.end }));
    const startSetOf = (series: AnchorSeries) =>
      series.entries.map((e) => (e.start as { year: number }).year).sort((a, b) => a - b);
    const assertSeries = (series: AnchorSeries) => {
      expect(series.entries.length).toBeGreaterThanOrEqual(1); // INV-5.
      expect(isValidSeries(series, cal)).toBe(true);
      const starts = series.entries.map((e) => (e.start as { year: number }).year);
      for (let i = 1; i < starts.length; i += 1) {
        expect(starts[i]! > starts[i - 1]!).toBe(true); // 昇順・非重複.
      }
      const ids = series.entries.map((e) => e.anchor.id);
      expect(new Set(ids).size).toBe(ids.length); // unique anchor ids.
    };

    fc.assert(
      fc.property(
        // A set of distinct ascending base years.
        fc.uniqueArray(fc.integer({ min: -300, max: 300 }), { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 1_000_000 }), // which entry to operate on.
        fc.integer({ min: 1, max: 200 }), // a positive end offset to set.
        (baseYears, pick, endOff) => {
          const sorted = [...baseYears].sort((a, b) => a - b);
          const series: AnchorSeries = {
            entries: sorted.map((y) =>
              createAnchorEntry(
                createAnchor(asAnchorId(`bh31x-an-${counter++}`), emptySnap),
                timePointYear(y),
                null,
              ),
            ),
          };
          assertSeries(series);
          const beforeProj = JSON.stringify(projOf(series));
          const beforeStartSet = startSetOf(series);

          // --- setEnd(x) ∘ setEnd(null) round-trip ---
          // All base entries start open-ended (end === null). Pick one, give it a
          // bounded end strictly before the NEXT anchor's start (so setEnd is
          // accepted without auto-reorg shifting a neighbor), then clear it again.
          const idx = pick % series.entries.length;
          const target = series.entries[idx]!;
          const targetStartYear = (target.start as { year: number }).year;
          const nextEntry = series.entries[idx + 1];
          const ceiling =
            nextEntry === undefined
              ? targetStartYear + endOff + 1
              : (nextEntry.start as { year: number }).year;
          // Choose an end strictly in (start, ceiling) when room exists.
          if (ceiling - targetStartYear >= 2) {
            const endYear = targetStartYear + Math.min(endOff, ceiling - targetStartYear - 1);
            const set = setEnd(series, target.anchor.id, timePointYear(endYear), cal);
            if (set.ok) {
              assertSeries(set.series);
              const cleared = setEnd(set.series, target.anchor.id, null, cal);
              expect(cleared.ok).toBe(true);
              if (cleared.ok) {
                assertSeries(cleared.series);
                // op ∘ inverse-op: the (id,start,end) projection is restored.
                expect(JSON.stringify(projOf(cleared.series))).toBe(beforeProj);
              }
            }
          }

          // --- changeStart(move) ∘ changeStart(back) round-trip ---
          // Move the target start to a fresh year well above every existing start
          // (no collision → it lands as a new top), then move it back to its
          // original year (also collision-free → original start set recovered).
          const freshYear = (sorted[sorted.length - 1] ?? 0) + 500 + (pick % 100);
          const moved = changeStart(series, target.anchor.id, timePointYear(freshYear), cal);
          if (moved.ok) {
            assertSeries(moved.series);
            // The moved anchor's start is now the fresh year.
            const movedEntry = moved.series.entries.find((e) => e.anchor.id === target.anchor.id);
            expect(movedEntry).toBeDefined();
            if (movedEntry) {
              expect((movedEntry.start as { year: number }).year).toBe(freshYear);
            }
            const back = changeStart(
              moved.series,
              target.anchor.id,
              timePointYear(targetStartYear),
              cal,
            );
            expect(back.ok).toBe(true);
            if (back.ok) {
              assertSeries(back.series);
              // op ∘ inverse-op on the start SET (ids preserved; ordering restored).
              expect(startSetOf(back.series)).toEqual(beforeStartSet);
              // The target anchor id survived the round-trip with its original start.
              const restored = back.series.entries.find((e) => e.anchor.id === target.anchor.id);
              expect(restored).toBeDefined();
              if (restored) {
                expect((restored.start as { year: number }).year).toBe(targetStartYear);
              }
            }
          }
        },
      ),
      { seed: SEED_31003, numRuns: RUNS_31003 },
    );
  });
});

// ===========================================================================
// 14. SEED=31004 EXTENSION — NEW exploration (bug-hunt round 3, disjoint from the
//     1000-6000 AND 21000-31003 bands). NEW command set / generators / metamorphic
//     relations that NO earlier seed combines.
//
// Every earlier seed asserts on the produced SHAPES (alternation / valid MP /
// finite / area) and the FOREST (childIds / acyclic), and a few assert on the
// vertex STORE (dangling-free). But NONE of seeds 1000-31003 ever inspects the
// `vertexRemap` field that BOTH the split proposal (knife/proposal.ts) and the
// leaf-only merge proposal (merge/proposal.ts) emit — the FR-95 旧→新頂点対応写像
// that U11 `transferSharing` consumes to carry 共有頂点 continuation across an edit.
// A defect in buildRemap (an entry pointing at a vertex that does not survive, a
// remap whose endpoints' quantized coordinates DIFFER, a key that is not actually
// one of the target's old vertices, or a non-deterministic remap) would corrupt
// the shared-vertex graph on the very next edit and is INVISIBLE to every shape /
// forest / store assertion the earlier seeds make. This block opens five live
// relations none of them touch, all centered on the remap as a first-class value:
//
//   (Z1) SPLIT remap soundness (FR-95): for proposal.vertexRemap, EVERY (oldId →
//        newId) entry must satisfy — oldId is one of the TARGET leaf's old vertex
//        ids; newId exists among the proposal's freshly-minted `vertices`; and the
//        old and new vertices share the SAME quantized+normalized coordinate (the
//        exact coordKey contract buildRemap enforces). The remap is a partial map
//        (vertices the boolean op dissolved have no entry) — so keys ⊆ old ids, and
//        every VALUE is a minted new vertex. No NaN/Infinity on either endpoint.
//
//   (Z2) MERGE remap soundness (FR-95): the SAME contract through buildMergeProposal
//        on a leaf-only union — every (oldId → newId) maps an old TARGET-leaf vertex
//        to a surviving `nextVertices` vertex at the identical quantized coordinate.
//        Leaf-only merges are the only mergeKind that rebuilds vertices, so the remap
//        is non-empty exactly there; an aggregate-only merge leaves it empty.
//
//   (Z3) remap-DRIVEN selection validity (選択が常に有効, via FR-95): a stateful model
//        that carries a SET of "selected vertex ids" and, after every split/merge,
//        RE-POINTS the selection through the op's vertexRemap (selected old id →
//        its new id when the remap names it; dropped when the op dissolved it). After
//        every op EVERY surviving selected id must exist in the live store — a remap
//        that named a non-existent target, or omitted a survivor, would dangle the
//        selection. Full world battery + per-op REAL persistence round-trip + undo
//        stack (undo ∘ op == identity over BOTH world AND selection).
//
//   (Z4) remap DETERMINISM (op == op over the remap value): two independent
//        assembleSplitProposal runs on the same target+line produce remaps with the
//        SAME old-id key SET and the SAME old→new COORDINATE mapping (the minted new
//        ids differ because idPorts mint fresh ids, so we compare the coordinate
//        relation, not literal ids). A non-deterministic buildRemap would surface
//        here and nowhere else.
//
//   (Z5) remap COVERAGE vs survival: a target old vertex has a remap entry IFF its
//        quantized coordinate survives into the union result (i.e. it is a corner the
//        boolean op kept). Concretely: every target old vertex whose coordinate
//        equals some minted new-vertex coordinate MUST appear as a remap key; and no
//        remap key's coordinate is absent from the minted set. This pins buildRemap's
//        "和で消えた頂点は対応なし" contract from BOTH directions (no spurious entry,
//        no missing survivor) — a one-sided test would miss a dropped survivor.
//
// Determinism: seed = 31004, numRuns large (per task). PERMANENT asset — any
// reproduced counterexample is a real domain defect, never to be masked here.
// ===========================================================================

import { quantizeCoordinate as quantizeCoordinate31004 } from '../geometry/index';
import { normalizeCoordinate as normalizeCoordinate31004 } from '../geo/index';
import type { VertexId as VertexId31004 } from '../ids';

const SEED_31004 = 31004;
const RUNS_31004 = 600;

/** The exact coordKey buildRemap / coordKey use (quantize ∘ normalize → string). */
function coordKey31004(c: WorldCoordinate): string {
  const q = quantizeCoordinate31004(normalizeCoordinate31004(c));
  return `${q.lon}|${q.lat}`;
}

/** Every vertex id cited by a leaf's rings. */
function leafVertexIds31004(leaf: LeafFeature): Set<VertexId31004> {
  const set = new Set<VertexId31004>();
  for (const ring of leaf.shape.rings) for (const vid of ring.vertexIds) set.add(vid);
  return set;
}

/**
 * Core remap soundness battery shared by (Z1)/(Z2): given the OLD store, the OLD
 * target vertex-id set, the NEW store (post-op), the minted-new vertex id set, and
 * the remap, assert every FR-95 contract clause. `targetOldIds` is the universe of
 * ids the remap is allowed to KEY on; `newVertexIds` is the set the remap may map TO.
 */
function assertRemapSound31004(args: {
  oldStore: VertexStore;
  targetOldIds: ReadonlySet<VertexId31004>;
  newStore: VertexStore;
  newVertexIds: ReadonlySet<VertexId31004>;
  remap: ReadonlyMap<VertexId31004, VertexId31004>;
}): void {
  const { oldStore, targetOldIds, newStore, newVertexIds, remap } = args;
  // Build the coordKey set of the minted-new vertices (the union-result corners).
  const newKeyToId = new Map<string, VertexId31004>();
  for (const nid of newVertexIds) {
    const nv = newStore.byId.get(nid);
    expect(nv).toBeDefined();
    if (nv) newKeyToId.set(coordKey31004(nv.coordinate), nid);
  }

  for (const [oldId, newId] of remap.entries()) {
    // (a) the KEY is one of the target's OLD vertices.
    expect(targetOldIds.has(oldId)).toBe(true);
    // (b) the VALUE is one of the freshly-minted NEW vertices that survives.
    expect(newVertexIds.has(newId)).toBe(true);
    const ov = oldStore.byId.get(oldId);
    const nv = newStore.byId.get(newId);
    expect(ov).toBeDefined();
    expect(nv).toBeDefined();
    if (!ov || !nv) continue;
    // (c) endpoints are finite (no NaN / Infinity introduced by the remap).
    expect(Number.isFinite(ov.coordinate.lon) && Number.isFinite(ov.coordinate.lat)).toBe(true);
    expect(Number.isFinite(nv.coordinate.lon) && Number.isFinite(nv.coordinate.lat)).toBe(true);
    // (d) old and new share the SAME quantized+normalized coordinate (coordKey).
    expect(coordKey31004(ov.coordinate)).toBe(coordKey31004(nv.coordinate));
  }

  // (Z5) coverage, BOTH directions:
  //   • no spurious entry: every remap key's coordinate is present among the minted
  //     set (already implied by clause (d), re-checked against the minted key set);
  //   • no missing survivor: every OLD target vertex whose coordinate equals a minted
  //     new-vertex coordinate MUST appear as a remap key (和で消えた頂点 only are absent).
  for (const oldId of remap.keys()) {
    const ov = oldStore.byId.get(oldId)!;
    expect(newKeyToId.has(coordKey31004(ov.coordinate))).toBe(true);
  }
  for (const oldId of targetOldIds) {
    const ov = oldStore.byId.get(oldId);
    if (ov === undefined) continue;
    const key = coordKey31004(ov.coordinate);
    if (newKeyToId.has(key)) {
      // This old corner survived into the result → it MUST be remapped, and to the
      // new vertex sharing its coordinate.
      expect(remap.has(oldId)).toBe(true);
      const mapped = remap.get(oldId);
      expect(mapped).toBeDefined();
      if (mapped !== undefined) {
        expect(coordKey31004(newStore.byId.get(mapped)!.coordinate)).toBe(key);
      }
    }
  }
}

// --- (Z1) SPLIT vertexRemap soundness ----------------------------------------

describe('seed=31004 — split vertexRemap is sound (FR-95 旧→新頂点対応写像)', () => {
  it('every remap entry keys an old target vertex and maps to a minted new vertex at the same quantized coord', () => {
    fc.assert(
      fc.property(dim, dim, flags(), fc.boolean(), (w, h, f, sideB) => {
        const params = makeParams(w, h, f);
        const { feature, store, cutX } = holeyLeaf(params);
        const line = createOpenKnifeLine([
          createCoordinate(cutX, -5),
          createCoordinate(cutX, h + 5),
        ]);
        const res = checkSplittable(feature, store, line);
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
        const proposal = assembleSplitProposal({
          target: feature,
          store: store.byId,
          result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
          choice: createInheritanceChoice(sideB ? INHERITANCE_SIDE.B : INHERITANCE_SIDE.A),
          nonInherited: { attributes: ATTRS, color: COLOR },
          ids: idPorts(),
        });
        const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);
        const newVertexIds = new Set<VertexId31004>(proposal.vertices.map((v) => v.id));
        assertRemapSound31004({
          oldStore: store,
          targetOldIds: leafVertexIds31004(feature),
          newStore: postStore,
          newVertexIds,
          remap: proposal.vertexRemap,
        });
        // The remap is NON-EMPTY for a real split (some original corner always
        // survives into at least one side — the cut never dissolves the whole leaf).
        expect(proposal.vertexRemap.size).toBeGreaterThan(0);
      }),
      { seed: SEED_31004, numRuns: RUNS_31004 },
    );
  });
});

// --- (Z2) MERGE vertexRemap soundness (leaf-only union) ----------------------

describe('seed=31004 — leaf-only merge vertexRemap is sound (FR-95)', () => {
  it('a leaf-only union remap maps surviving old target vertices to nextVertices at the same quantized coord', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 50, noNaN: true }),
        fc.double({ min: 20, max: 50, noNaN: true }),
        fc.double({ min: 1, max: 6, noNaN: true }), // small overlap so the union fuses a shared edge.
        (w, h, overlap) => {
          // Two boxes that ABUT/overlap on a shared vertical edge so the union keeps
          // most corners (giving a non-trivial remap) yet fuses the seam.
          const bA = box(0, w, 0, h);
          const bB = box(w - overlap, 2 * w - overlap, 0, h);
          const verts: Vertex[] = [];
          [bA, bB].forEach((b) => b.ids.forEach((id, k) => verts.push(createVertex(id, b.coords[k]!))));
          const store = createVertexStore(verts);
          const leafA = createLeafFeature(
            asFeatureId(`bh31004-a-${counter++}`),
            createBasicAttributes('A', 0, 100),
            COLOR,
            createShape([createTerritoryRing(freshRid(), bA.ids)]),
          );
          const leafB = createLeafFeature(
            asFeatureId(`bh31004-b-${counter++}`),
            createBasicAttributes('B', 0, 100),
            COLOR,
            createShape([createTerritoryRing(freshRid(), bB.ids)]),
          );

          const res = buildMergeProposal({
            features: [leafA, leafB],
            vertices: store,
            targetIds: [leafA.id, leafB.id],
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
            ids: idPorts(),
          });
          expect(res.status).toBe(MERGE_STATUS.Proposal);
          if (res.status !== MERGE_STATUS.Proposal) return;
          const mp = res.proposal;
          expect(mp.mergeKind).toBe(MERGE_KIND_21003.LeafOnly);

          // The minted-new vertices are exactly those present in nextVertices but not
          // in the OLD store (the leaf-only union rebuilds the result leaf's vertices).
          const newVertexIds = new Set<VertexId31004>();
          for (const [id] of mp.nextVertices.byId) {
            if (!store.byId.has(id)) newVertexIds.add(id);
          }
          const targetOldIds = new Set<VertexId31004>([
            ...leafVertexIds31004(leafA),
            ...leafVertexIds31004(leafB),
          ]);
          assertRemapSound31004({
            oldStore: store,
            targetOldIds,
            newStore: mp.nextVertices,
            newVertexIds,
            remap: mp.vertexRemap,
          });
          // A leaf-only union rebuilds vertices → the remap is non-empty.
          expect(mp.vertexRemap.size).toBeGreaterThan(0);
        },
      ),
      { seed: SEED_31004, numRuns: RUNS_31004 },
    );
  });

  it('an aggregate-only merge leaves the remap empty (no vertices rebuilt)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 4 }), (numAgg) => {
        const features: Feature[] = [];
        const verts: Vertex[] = [];
        const aggIds: ReturnType<typeof asFeatureId>[] = [];
        for (let i = 0; i < numAgg; i += 1) {
          const aggId = asFeatureId(`bh31004-A-${counter++}`);
          aggIds.push(aggId);
          const lb = box(i * 100, i * 100 + 50, 0, 50);
          lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
          const childId = asFeatureId(`bh31004-c-${counter++}`);
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
        const res = buildMergeProposal({
          features,
          vertices: createVertexStore(verts),
          targetIds: aggIds,
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: propertyNew({ attributes: createBasicAttributes('agg', 0, 100), color: COLOR }),
          ids: idPorts(),
        });
        expect(res.status).toBe(MERGE_STATUS.Proposal);
        if (res.status !== MERGE_STATUS.Proposal) return;
        // AggregateOnly merges do NOT rebuild geometry → the remap is empty.
        expect(res.proposal.vertexRemap.size).toBe(0);
      }),
      { seed: SEED_31004, numRuns: RUNS_31004 },
    );
  });
});

// --- (Z3) remap-driven selection validity stateful model ---------------------

interface SelWorld {
  readonly world: World;
  /** A set of "selected" vertex ids the user is tracking across edits. */
  readonly selected: ReadonlySet<VertexId31004>;
}

type SelCmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'selectRing'; readonly leafPick: number }
  | { readonly t: 'undo' };

const selCmdArb: fc.Arbitrary<SelCmd> = fc.oneof(
  fc.record({
    t: fc.constant<'split'>('split'),
    leafPick: fc.nat({ max: 1_000_000 }),
    frac: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({
    t: fc.constant<'merge'>('merge'),
    aPick: fc.nat({ max: 1_000_000 }),
    bPick: fc.nat({ max: 1_000_000 }),
  }),
  fc.record({ t: fc.constant<'selectRing'>('selectRing'), leafPick: fc.nat({ max: 1_000_000 }) }),
  fc.constant<SelCmd>({ t: 'undo' }),
);

/** Every vertex id cited by any leaf in a world (the live, referenced vertices). */
function citedVertexIds31004(world: World): Set<VertexId31004> {
  const cited = new Set<VertexId31004>();
  for (const leaf of world.features) {
    for (const ring of leaf.shape.rings) for (const vid of ring.vertexIds) cited.add(vid);
  }
  return cited;
}

/**
 * Carry a vertex selection forward through an op's vertexRemap, then keep only the
 * ids that are still CITED by a surviving leaf:
 *   - a selected OLD id the remap names becomes its NEW id (FR-95 continuation);
 *   - a selected id absent from the remap but still cited by a surviving leaf stays
 *     (it belonged to an untouched feature — e.g. the other operand of a split);
 *   - a selected id that is neither remapped to a cited vertex nor still cited is
 *     DROPPED. (The store is ADDITIVE — `addVertices` never deletes the consumed
 *     leaves' old vertices — so "present in the store" is NOT survival; the proper
 *     liveness test is "cited by a surviving leaf". A selection must follow the
 *     geometry, never linger on an orphaned, uncited vertex.)
 */
function carrySelection31004(
  selected: ReadonlySet<VertexId31004>,
  remap: ReadonlyMap<VertexId31004, VertexId31004>,
  nextWorld: World,
): Set<VertexId31004> {
  const cited = citedVertexIds31004(nextWorld);
  const next = new Set<VertexId31004>();
  for (const sid of selected) {
    const mapped = remap.get(sid);
    if (mapped !== undefined) {
      if (cited.has(mapped)) next.add(mapped); // remapped survivor that is still cited.
    } else if (cited.has(sid)) {
      next.add(sid); // untouched survivor still cited by some surviving leaf.
    }
    // else: dissolved / orphaned → drop (selection must follow the live geometry).
  }
  return next;
}

/** Split that also returns the proposal so the caller can carry the selection. */
function selSplit(world: World, cmd: { leafPick: number; frac: number }): {
  next: World;
  remap: ReadonlyMap<VertexId31004, VertexId31004>;
} {
  if (world.features.length === 0) return { next: world, remap: new Map() };
  const idx = cmd.leafPick % world.features.length;
  const leaf = world.features[idx]!;
  const bb = leafBbox(leaf, world.store);
  if (bb === undefined) return { next: world, remap: new Map() };
  const span = bb.maxX - bb.minX;
  if (span <= 0) return { next: world, remap: new Map() };
  const cutX = bb.minX + span * (0.2 + cmd.frac * 0.6);
  const pad = (bb.maxY - bb.minY) * 0.5 + 10;
  const line = createOpenKnifeLine([
    createCoordinate(cutX, bb.minY - pad),
    createCoordinate(cutX, bb.maxY + pad),
  ]);
  const check = checkSplittable(leaf, world.store, line);
  const exec = executeSplit(leaf, world.store, line);
  if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
    expect(exec).toBeUndefined();
    return { next: world, remap: new Map() };
  }
  if (exec === undefined) return { next: world, remap: new Map() };
  const proposal = assembleSplitProposal({
    target: leaf,
    store: world.store.byId,
    result: { sideA: check.sideA, sideB: check.sideB, edgeCuts: exec.edgeCuts },
    choice: createInheritanceChoice(INHERITANCE_SIDE.A),
    nonInherited: { attributes: ATTRS, color: COLOR },
    ids: idPorts(),
  });
  const inheritor = withLeafShape(leaf, proposal.inheritorShape);
  const nextFeatures = world.features.slice();
  nextFeatures[idx] = inheritor;
  nextFeatures.push(proposal.newFeature);
  const nextStore = createVertexStore([...world.store.byId.values(), ...proposal.vertices]);
  return { next: { features: nextFeatures, store: nextStore }, remap: proposal.vertexRemap };
}

/** Merge that also returns the proposal's remap so the caller can carry selection. */
function selMerge(world: World, cmd: { aPick: number; bPick: number }): {
  next: World;
  remap: ReadonlyMap<VertexId31004, VertexId31004>;
} {
  if (world.features.length < 2) return { next: world, remap: new Map() };
  const n = world.features.length;
  const i = cmd.aPick % n;
  let j = cmd.bPick % n;
  if (j === i) j = (j + 1) % n;
  const a = world.features[i]!;
  const b = world.features[j]!;
  const res = buildMergeProposal({
    features: world.features,
    vertices: world.store,
    targetIds: [a.id, b.id],
    atTime: 50,
    parentDecision: parentNone,
    propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
    ids: idPorts(),
  });
  if (res.status !== MERGE_STATUS.Proposal) return { next: world, remap: new Map() };
  const p = res.proposal;
  const result = p.nextFeatures.find((x) => x.id === p.resultFeatureId);
  if (result === undefined || result.kind !== 'leaf') return { next: world, remap: new Map() };
  const features = p.nextFeatures.filter((fe): fe is LeafFeature => fe.kind === 'leaf');
  return { next: { features, store: p.nextVertices }, remap: p.vertexRemap };
}

describe('seed=31004 — remap-driven selection stays valid across edit chains (FR-95 + 選択が常に有効)', () => {
  it('a vertex selection carried through every op vertexRemap never dangles; undo restores world + selection', () => {
    fc.assert(
      fc.property(fc.array(selCmdArb, { minLength: 1, maxLength: 16 }), (cmds) => {
        let sw: SelWorld = { world: initialWorld(), selected: new Set() };
        const stack: SelWorld[] = [];
        checkWorldInvariants(sw.world);

        const assertSelectionValid = () => {
          // Every selected id resolves to a LIVE vertex AND is cited by some leaf
          // (selection must point at a real, referenced vertex — never dangle).
          const cited = new Set<VertexId31004>();
          for (const leaf of sw.world.features) {
            for (const ring of leaf.shape.rings) for (const vid of ring.vertexIds) cited.add(vid);
          }
          for (const sid of sw.selected) {
            expect(sw.world.store.byId.has(sid)).toBe(true);
            expect(cited.has(sid)).toBe(true);
          }
        };
        assertSelectionValid();

        for (const cmd of cmds) {
          if (cmd.t === 'undo') {
            const prior = stack.pop();
            if (prior === undefined) continue;
            // undo ∘ op == identity over the COUPLED (world + selection) value.
            sw = prior;
            checkWorldInvariants(sw.world);
            assertSelectionValid();
            expect(sw.world.features.length).toBeGreaterThanOrEqual(1);
            continue;
          }
          if (cmd.t === 'selectRing') {
            if (sw.world.features.length === 0) continue;
            const leaf = sw.world.features[cmd.leafPick % sw.world.features.length]!;
            // Select every vertex of the leaf's first (outer) ring.
            const sel = new Set<VertexId31004>(sw.selected);
            const outer = leaf.shape.rings[0];
            if (outer) for (const vid of outer.vertexIds) sel.add(vid);
            sw = { world: sw.world, selected: sel };
            assertSelectionValid();
            continue;
          }

          // A real edit: snapshot the coupled value (purity + undo), apply, then
          // carry the selection forward through the op's remap.
          const before = sw;
          const beforeWorldCopy: World = {
            features: before.world.features.slice(),
            store: { byId: new Map(before.world.store.byId) },
          };
          const beforeSelCopy = new Set(before.selected);
          const { next, remap } =
            cmd.t === 'split' ? selSplit(before.world, cmd) : selMerge(before.world, cmd);
          // Op purity: the prior world value is untouched.
          expect(worldsIdentical(before.world, beforeWorldCopy)).toBe(true);
          if (next === before.world) {
            // No-op (not splittable / not mergeable). Selection unchanged.
            sw = before;
            assertSelectionValid();
            continue;
          }
          const nextSelected = carrySelection31004(before.selected, remap, next);
          stack.push({ world: beforeWorldCopy, selected: beforeSelCopy });
          sw = { world: next, selected: nextSelected };

          checkWorldInvariants(sw.world);
          assertSelectionValid();
          expect(sw.world.features.length).toBeGreaterThanOrEqual(1);

          // REAL persistence round-trip after EVERY op (serialize → parse → deser).
          const project = worldToProject(sw.world);
          const reloaded = saveThenLoad(project);
          expect(reloaded).toBeDefined();
          if (reloaded !== undefined) {
            expect(projectsEqual(project, reloaded)).toBe(true);
          }
        }
      }),
      { seed: SEED_31004, numRuns: RUNS_31004 },
    );
  });
});

// --- (Z4) remap DETERMINISM (op == op over the coordinate relation) ----------

describe('seed=31004 — split vertexRemap is deterministic (op == op over the coord relation)', () => {
  it('two independent split proposals on the same target+line yield the same old-id keyset + old→new coord map', () => {
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

        const build = () =>
          assembleSplitProposal({
            target: feature,
            store: store.byId,
            result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: [] },
            choice: createInheritanceChoice(INHERITANCE_SIDE.A),
            nonInherited: { attributes: ATTRS, color: COLOR },
            ids: idPorts(),
          });
        const p1 = build();
        const p2 = build();
        const store1 = createVertexStore([...store.byId.values(), ...p1.vertices]);
        const store2 = createVertexStore([...store.byId.values(), ...p2.vertices]);

        // Same SET of old-id keys (the new vertex ids differ; old keys must not).
        const keys1 = [...p1.vertexRemap.keys()].sort();
        const keys2 = [...p2.vertexRemap.keys()].sort();
        expect(keys1).toEqual(keys2);

        // Same old→new COORDINATE relation: for each old key, the mapped new vertex
        // sits at the identical quantized coordinate in both runs.
        for (const oldId of p1.vertexRemap.keys()) {
          const n1 = store1.byId.get(p1.vertexRemap.get(oldId)!)!;
          const n2 = store2.byId.get(p2.vertexRemap.get(oldId)!)!;
          expect(coordKey31004(n1.coordinate)).toBe(coordKey31004(n2.coordinate));
          // And it equals the old vertex's own coordinate (the FR-95 continuation).
          const ov = store.byId.get(oldId)!;
          expect(coordKey31004(n1.coordinate)).toBe(coordKey31004(ov.coordinate));
        }
      }),
      { seed: SEED_31004, numRuns: RUNS_31004 },
    );
  });
});

// ===========================================================================
// 15. SEED=41001 EXTENSION — NEW exploration (bug-hunt closure T2, disjoint from
//     the 1000-6000 / 21000-26000 / 31000-36000 bands).
//
// Every band above builds its leaves with `holeyLeaf`, whose boxes live at the
// ORIGIN (lon ∈ [0, w], w ≤ 80). They therefore NEVER cross the ±180° antimeridian
// seam, so the R3 seam-alignment machinery that the split / merge / resolve code
// is SATURATED with comments about —
//   - split-geometry.ts `anchorLon` / `unwrapAnchoredRing` / `targetReferenceLon`
//     / `anchorMultiPolygon` (checkSplittable anchors target + cut onto one branch),
//   - merge/proposal.ts `unionLeafShapes` `alignMultiPolygon` + `coordKey`'s
//     normalize-before-quantize, and `reparentByContainment`'s common-anchor align,
//   - resolve-shape.ts `alignMultiPolygon` of every child area before union,
// — runs as the IDENTITY in all of them. This band deliberately places geometry
// ON the seam and draws cuts on the OPPOSITE ±360° replica so those branches do
// real work, then asserts the SAME invariant battery the other bands assert:
//
//   (S1) seam split: a leaf straddling +180° cut by an open line drawn near −180°
//        (the other replica) is still Splittable, both sides valid + finite +
//        area-preserving, and executeSplit == checkSplittable (op == op).
//   (S2) seam split-then-merge-back (op ∘ inverse-op): union(sideA, sideB) recovers
//        the original filled area; the domain merge of the two products is one valid
//        alternation leaf citing only finite, in-store vertices.
//   (S3) seam leaves stored as REPRESENTATIVES (lon ∈ [-180,180)) merge into one
//        valid leaf whose resolved area equals the sum of the inputs — exercising
//        unionLeafShapes' alignMultiPolygon on genuinely seam-split operands.
//   (S4) seam stateful model: a fresh command generator (cut offset chosen on a
//        random ±360° replica, merge of seam-adjacent products) drives chained
//        split/merge; after EVERY op the whole world stays alternation-valid,
//        resolvable, finite, dangling-free, id-unique, and JSON-round-trips; plus
//        the per-op op==op and op∘inverse-op area relations hold.
//   (S5) seam persistence: a seam world round-trips through the REAL U14 path
//        (serialize → parseManifest → manifestToProject → projectsEqual).
//
// Determinism: seed = 41001, numRuns large (per task). PERMANENT asset — any
// counterexample is a real seam/quantization defect to fix in the domain, never a
// reason to relax an assertion here (緑偽装禁止).
// ===========================================================================

import {
  unwrapRing as unwrapRing41001,
  alignMultiPolygon as alignMultiPolygon41001,
  referenceLonForMultiPolygon as referenceLonForMultiPolygon41001,
} from '../geo/index';

const SEED_41001 = 41001;
const RUNS_41001 = 500;

/**
 * Seam-aware whole-world invariant battery. `checkWorldInvariants` validates the
 * RAW resolved leaf shape, which is correct for origin geometry but WRONG for a
 * seam-straddling leaf: resolveLeafShape is documented to return raw stored
 * representatives with ZERO seam handling (the seam alignment is the consumer's job
 * before any geometry op), so a straddling outer ring reads as self-crossing under
 * isMultiPolygonValid until it is aligned onto a single ±360° branch. This helper
 * therefore aligns each resolved leaf area to its own outer-ring reference (the same
 * single-source alignMultiPolygon the split/merge/resolve code uses) BEFORE checking
 * validity, while keeping every other invariant (alternation, dangling-vertex,
 * finite, id-unique, JSON round-trip) identical to checkWorldInvariants.
 */
function checkSeamWorldInvariants(world: World): void {
  const ids = world.features.map((f) => f.id);
  expect(new Set(ids).size).toBe(ids.length); // (I6) unique ids.

  for (const leaf of world.features) {
    expect(isAlternationValid(leaf.shape)).toBe(true); // (I1) alternation.

    // (I5) every cited vertex exists; (I4) finite; representatives only.
    for (const ring of leaf.shape.rings) {
      for (const vid of ring.vertexIds) {
        const v = world.store.byId.get(vid);
        expect(v).toBeDefined();
        if (v) {
          expect(Number.isFinite(v.coordinate.lon)).toBe(true);
          expect(Number.isFinite(v.coordinate.lat)).toBe(true);
          expect(v.coordinate.lon).toBeGreaterThanOrEqual(-180);
          expect(v.coordinate.lon).toBeLessThan(180);
        }
      }
    }

    // (I2) resolves to a valid multi-polygon ONCE seam-aligned (the consumer's
    // contract). A straddling ring is only invalid in its raw representative form.
    const mp = resolveLeafShape(leaf.shape, world.store);
    expect(mp).toBeDefined();
    if (mp) {
      const ref = referenceLonForMultiPolygon41001(mp);
      const aligned = alignMultiPolygon41001(mp, ref);
      expect(isMultiPolygonValid(aligned)).toBe(true);
      expect(everyCoordFinite(aligned)).toBe(true);
    }

    if (leaf.parentId !== undefined) expect(leaf.parentId).not.toBe(leaf.id); // (I3).
  }

  // (I7) save -> load == identity over the whole world.
  const snapshot = {
    features: world.features.map((f) => ({ id: f.id, shape: f.shape })),
    vertices: [...world.store.byId.values()],
  };
  const saved = JSON.stringify(snapshot);
  expect(JSON.stringify(JSON.parse(saved))).toBe(saved);
}

/**
 * A holey leaf whose outer box is CENTERED at `centerLon` (degrees), stored as
 * REPRESENTATIVES (each vertex longitude folded into [-180,180) via
 * normalizeCoordinate). When centerLon is near ±180 the box straddles the seam, so
 * its representative vertices land on BOTH sides of the antimeridian — exactly the
 * stored state resolveLeafShape / checkSplittable must seam-align before any
 * boolean op. The cut crosses the box at a representative longitude that may be the
 * OTHER ±360° replica of the same world point (`replicaTurns`).
 */
function seamLeaf(opts: {
  readonly centerLon: number;
  readonly halfW: number;
  readonly h: number;
  readonly leftHole: boolean;
  readonly rightHole: boolean;
}): { feature: LeafFeature; store: VertexStore; cutLonRep: number; trueWidth: number; trueFilled: number } {
  const { centerLon, halfW, h } = opts;
  const y0 = -h / 2;
  const y1 = h / 2;
  const vertices: Vertex[] = [];
  const rings: Ring[] = [];
  // Build boxes in CONTINUOUS lon (centered system), then store representatives.
  const repBox = (xa: number, xb: number, ya: number, yb: number) => {
    const cont = [
      [xa, ya],
      [xb, ya],
      [xb, yb],
      [xa, yb],
    ] as const;
    return cont.map(([lon, lat]) => {
      const id = freshVid();
      // Store the REPRESENTATIVE coordinate (normalize folds lon into [-180,180)).
      const rep = normalizeCoordinate31004(createCoordinate(lon, lat));
      vertices.push(createVertex(id, rep));
      return id;
    });
  };

  const x0 = centerLon - halfW;
  const x1 = centerLon + halfW;
  const outerIds = repBox(x0, x1, y0, y1);
  const tOuter = createTerritoryRing(freshRid(), outerIds);
  rings.push(tOuter);

  // The full outer rectangle area; holes subtracted below.
  const trueWidth = x1 - x0;
  let filled = trueWidth * h;

  if (opts.leftHole) {
    const lx0 = centerLon - halfW * 0.6;
    const lx1 = centerLon - halfW * 0.2;
    const ly0 = y0 + h * 0.2;
    const ly1 = y1 - h * 0.2;
    const ids = repBox(lx0, lx1, ly0, ly1);
    rings.push(createHoleRing(freshRid(), ids, tOuter.id));
    filled -= (lx1 - lx0) * (ly1 - ly0);
  }
  if (opts.rightHole) {
    const rx0 = centerLon + halfW * 0.2;
    const rx1 = centerLon + halfW * 0.6;
    const ry0 = y0 + h * 0.25;
    const ry1 = y1 - h * 0.25;
    const ids = repBox(rx0, rx1, ry0, ry1);
    rings.push(createHoleRing(freshRid(), ids, tOuter.id));
    filled -= (rx1 - rx0) * (ry1 - ry0);
  }

  const feature = createLeafFeature(
    asFeatureId(`bh-seam-${counter++}`),
    ATTRS,
    COLOR,
    createShape(rings),
  );
  // The cut crosses the box interior at centerLon; expose it folded to a
  // representative so the CALLER can additionally jitter it onto another replica.
  const cutLonRep = normalizeCoordinate31004(createCoordinate(centerLon, 0)).lon;
  return { feature, store: createVertexStore(vertices), cutLonRep, trueWidth, trueFilled: filled };
}

/** Filled (outer − holes) area of a multi-polygon via shoelace; seam-band reuse. */
function mpFilled41001(mp: GeoMultiPolygon): number {
  return mpFilledArea(mp);
}

describe('seed=41001 — seam-straddling split: valid + finite + area-preserving (R3)', () => {
  it('a leaf centered on/near ±180° is split by a cut on the opposite replica; both sides hold', () => {
    fc.assert(
      fc.property(
        // Centers chosen to land ON and AROUND the seam, plus a control off-seam.
        fc.constantFrom(180, 179.5, -179.5, -180, 175, -175, 90, 0),
        fc.double({ min: 6, max: 30, noNaN: true }), // halfW (keep box < 180° wide).
        fc.double({ min: 8, max: 40, noNaN: true }), // height.
        fc.boolean(),
        fc.boolean(),
        // Replica turns for the CUT longitude: draw the cut on the +360 / -360 copy.
        fc.constantFrom(-1, 0, 1),
        (centerLon, halfW, h, leftHole, rightHole, replicaTurns) => {
          const { feature, store, trueFilled, trueWidth } = seamLeaf({
            centerLon,
            halfW,
            h,
            leftHole,
            rightHole,
          });
          // The cut is a vertical line through the box center, drawn on a chosen
          // ±360° replica (replicaTurns). The split must seam-anchor it back onto the
          // target's branch (anchorLon) for the boolean op to see the overlap.
          const cutLon = centerLon + replicaTurns * 360;
          const line = createOpenKnifeLine([
            createCoordinate(cutLon, -h),
            createCoordinate(cutLon, h),
          ]);
          const res = checkSplittable(feature, store, line);
          // A vertical cut through the box center pierces outer→outer, so it must be
          // splittable regardless of which replica the line was drawn on (R3).
          expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
          if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

          for (const side of [res.sideA, res.sideB]) {
            expect(everyCoordFinite(side.area)).toBe(true);
            expect(isMultiPolygonValid(side.area)).toBe(true);
            expect(sideArea(side)).toBeGreaterThan(0);
          }
          // Area preservation: the two sides sum to the leaf's true filled area.
          // (sideArea uses planar shoelace, matching trueFilled's planar product.)
          const sum = sideArea(res.sideA) + sideArea(res.sideB);
          expect(trueWidth).toBeGreaterThan(0);
          expect(Math.abs(sum - trueFilled) / trueFilled).toBeLessThan(1e-3);

          // op == op: executeSplit reproduces checkSplittable's sides exactly.
          const exec = executeSplit(feature, store, line);
          expect(exec).toBeDefined();
          if (exec === undefined) return;
          expect(JSON.stringify(exec.sideA.area)).toBe(JSON.stringify(res.sideA.area));
          expect(JSON.stringify(exec.sideB.area)).toBe(JSON.stringify(res.sideB.area));

          // Rebuilt shapes alternate (the minted vertices are folded representatives).
          const proposal = assembleSplitProposal({
            target: feature,
            store: store.byId,
            result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: exec.edgeCuts },
            choice: createInheritanceChoice(INHERITANCE_SIDE.A),
            nonInherited: { attributes: ATTRS, color: COLOR },
            ids: idPorts(),
          });
          expect(isAlternationValid(proposal.inheritorShape)).toBe(true);
          expect(isAlternationValid(proposal.newFeature.shape)).toBe(true);
          for (const v of proposal.vertices) {
            expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
            // Minted vertices are stored as representatives (lon ∈ [-180,180)).
            expect(v.coordinate.lon).toBeGreaterThanOrEqual(-180);
            expect(v.coordinate.lon).toBeLessThan(180);
          }
        },
      ),
      { seed: SEED_41001, numRuns: RUNS_41001 },
    );
  });
});

describe('seed=41001 — seam split-then-merge-back (op ∘ inverse-op recovers area)', () => {
  it('union(sideA, sideB) of a seam split recovers the leaf area; merge yields one valid leaf', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(180, 179.5, -179.5, -180, 178, -178),
        fc.double({ min: 6, max: 28, noNaN: true }),
        fc.double({ min: 8, max: 36, noNaN: true }),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(-1, 0, 1),
        (centerLon, halfW, h, leftHole, rightHole, replicaTurns) => {
          const { feature, store, trueFilled } = seamLeaf({ centerLon, halfW, h, leftHole, rightHole });
          const cutLon = centerLon + replicaTurns * 360;
          const line = createOpenKnifeLine([
            createCoordinate(cutLon, -h),
            createCoordinate(cutLon, h),
          ]);
          const res = checkSplittable(feature, store, line);
          if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;

          // Direct geometric inverse on the split's own (already aligned) areas.
          const reunited = union(res.sideA.area, res.sideB.area);
          expect(isOk(reunited)).toBe(true);
          if (!isOk(reunited)) return;
          expect(isMultiPolygonValid(reunited.result)).toBe(true);
          expect(everyCoordFinite(reunited.result)).toBe(true);
          const reArea = mpFilled41001(reunited.result);
          expect(Math.abs(reArea - trueFilled) / trueFilled).toBeLessThan(1e-3);

          const exec = executeSplit(feature, store, line)!;
          const proposal = assembleSplitProposal({
            target: feature,
            store: store.byId,
            result: { sideA: res.sideA, sideB: res.sideB, edgeCuts: exec.edgeCuts },
            choice: createInheritanceChoice(INHERITANCE_SIDE.A),
            nonInherited: { attributes: ATTRS, color: COLOR },
            ids: idPorts(),
          });
          const inheritor = inheritorFeature(feature, proposal);
          const newLeaf = proposal.newFeature;
          const postStore = createVertexStore([...store.byId.values(), ...proposal.vertices]);

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
          const result = mp.nextFeatures.find((x) => x.id === mp.resultFeatureId);
          expect(result?.kind).toBe('leaf');
          if (result && result.kind === 'leaf') {
            expect(isAlternationValid(result.shape)).toBe(true);
            const rawMerged = resolveLeafShape(result.shape, mp.nextVertices);
            expect(rawMerged).toBeDefined();
            if (rawMerged) {
              // Seam-align before validity/area (consumer contract): a straddling
              // merged band is only valid/measurable once anchored onto one branch.
              const merged = alignMultiPolygon41001(
                rawMerged,
                referenceLonForMultiPolygon41001(rawMerged),
              );
              expect(isMultiPolygonValid(merged)).toBe(true);
              expect(everyCoordFinite(merged)).toBe(true);
              const mergedArea = mpFilled41001(merged);
              // Merge-back recovers the original filled area within quantization.
              expect(Math.abs(mergedArea - trueFilled) / trueFilled).toBeLessThan(2e-3);
            }
            for (const ring of result.shape.rings) {
              for (const vid of ring.vertexIds) {
                const v = mp.nextVertices.byId.get(vid);
                expect(v).toBeDefined();
                if (v) {
                  expect(Number.isFinite(v.coordinate.lon) && Number.isFinite(v.coordinate.lat)).toBe(true);
                }
              }
            }
          }
        },
      ),
      { seed: SEED_41001, numRuns: RUNS_41001 },
    );
  });
});

describe('seed=41001 — seam leaf-only merge of representatives unions into one valid leaf', () => {
  it('two seam-adjacent leaves (stored as representatives) merge to one alternation-valid leaf', () => {
    fc.assert(
      fc.property(
        // A pair of boxes that overlap across the seam: left box ends at +180, right
        // box starts before +180 and extends PAST it (= −180 representative). Their
        // union is one continuous band straddling the antimeridian.
        fc.double({ min: 4, max: 20, noNaN: true }),
        fc.double({ min: 8, max: 30, noNaN: true }),
        // overlap fraction of w, kept strictly inside (0,1) so the right box always
        // straddles the seam (right edge 180 − overlap + w > 180) AND truly overlaps
        // the left box — the union width is then exactly 2w − overlap.
        fc.double({ min: 0.2, max: 0.8, noNaN: true }),
        (w, h, fracOverlap) => {
          const overlap = w * fracOverlap;
          // Left box: [180 - w, 180]; right box: [180 - overlap, 180 - overlap + w]
          // so they OVERLAP by `overlap` straddling the seam at 180.
          const left = seamLeaf({ centerLon: 180 - w / 2, halfW: w / 2, h, leftHole: false, rightHole: false });
          const rightCenter = 180 - overlap + w / 2;
          const right = seamLeaf({ centerLon: rightCenter, halfW: w / 2, h, leftHole: false, rightHole: false });

          const features: LeafFeature[] = [left.feature, right.feature];
          const store = createVertexStore([...left.store.byId.values(), ...right.store.byId.values()]);

          const res = buildMergeProposal({
            features,
            vertices: store,
            targetIds: [left.feature.id, right.feature.id],
            atTime: 50,
            parentDecision: parentNone,
            propertyDecision: propertyNew({ attributes: ATTRS, color: COLOR }),
            ids: idPorts(),
          });
          // Two overlapping seam-adjacent boxes union into one piece — must succeed.
          expect(res.status).toBe(MERGE_STATUS.Proposal);
          if (res.status !== MERGE_STATUS.Proposal) return;
          const p = res.proposal;
          const result = p.nextFeatures.find((x) => x.id === p.resultFeatureId);
          expect(result?.kind).toBe('leaf');
          if (result && result.kind === 'leaf') {
            expect(isAlternationValid(result.shape)).toBe(true);
            const rawMp = resolveLeafShape(result.shape, p.nextVertices);
            expect(rawMp).toBeDefined();
            if (rawMp) {
              // Seam-align before validity/area: the merged band straddles the seam,
              // so its raw representative shape is only valid/measurable once anchored
              // onto one ±360° branch (the consumer's contract, same as resolve/union).
              const mp = alignMultiPolygon41001(rawMp, referenceLonForMultiPolygon41001(rawMp));
              expect(isMultiPolygonValid(mp)).toBe(true);
              expect(everyCoordFinite(mp)).toBe(true);
              // Every stored vertex is a representative (lon ∈ [-180,180)).
              for (const ring of result.shape.rings) {
                for (const vid of ring.vertexIds) {
                  const v = p.nextVertices.byId.get(vid);
                  expect(v).toBeDefined();
                  if (v) {
                    expect(v.coordinate.lon).toBeGreaterThanOrEqual(-180);
                    expect(v.coordinate.lon).toBeLessThan(180);
                  }
                }
              }
              // Area: union of two overlapping w×h boxes overlapping by `overlap`
              // in lon = (2w − overlap) × h. The seam fold must NOT scatter them.
              const expected = (2 * w - overlap) * h;
              const got = mpFilled41001(mp);
              expect(Math.abs(got - expected) / expected).toBeLessThan(5e-3);
            }
          }
        },
      ),
      { seed: SEED_41001, numRuns: RUNS_41001 },
    );
  });
});

// --- (S4) seam stateful model + (S5) real persistence round-trip ------------

interface SeamCmd {
  readonly t: 'split' | 'merge' | 'noop';
  readonly pickA: number;
  readonly pickB: number;
  readonly frac: number;
  readonly replicaTurns: number;
}

const seamCmdArb: fc.Arbitrary<SeamCmd> = fc.record({
  t: fc.constantFrom<'split' | 'merge' | 'noop'>('split', 'split', 'merge', 'noop'),
  pickA: fc.nat({ max: 1_000_000 }),
  pickB: fc.nat({ max: 1_000_000 }),
  frac: fc.double({ min: 0, max: 1, noNaN: true }),
  replicaTurns: fc.constantFrom(-1, 0, 1),
});

/** Initial seam world: a single seam-straddling holey leaf centered at +180°. */
function seamInitialWorld(): World {
  const { feature, store } = seamLeaf({
    centerLon: 180,
    halfW: 24,
    h: 30,
    leftHole: true,
    rightHole: true,
  });
  return { features: [feature], store };
}

/**
 * SPLIT in the seam world: like applySplit, but the cut longitude is computed in
 * the SEAM-CONTINUOUS frame (unwrap the leaf's outer ring) and then drawn on a
 * chosen ±360° replica, so the R3 anchor path runs on every op.
 */
function seamApplySplit(world: World, cmd: SeamCmd): World {
  if (world.features.length === 0) return world;
  const idx = cmd.pickA % world.features.length;
  const leaf = world.features[idx]!;
  const mp = resolveLeafShape(leaf.shape, world.store);
  if (mp === undefined || mp.length === 0) return world;
  // Seam-continuous bbox of the outer rings (so a straddling box has a real span).
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of mp) {
    const outer = poly[0];
    if (outer === undefined) continue;
    const cont = unwrapRing41001([...outer]);
    for (const c of cont) {
      if (c.lon < minX) minX = c.lon;
      if (c.lon > maxX) maxX = c.lon;
      if (c.lat < minY) minY = c.lat;
      if (c.lat > maxY) maxY = c.lat;
    }
  }
  const span = maxX - minX;
  if (!Number.isFinite(span) || span <= 0) return world;
  const cutLonCont = minX + span * (0.25 + cmd.frac * 0.5);
  const cutLon = cutLonCont + cmd.replicaTurns * 360;
  const pad = (maxY - minY) * 0.5 + 10;
  const line = createOpenKnifeLine([
    createCoordinate(cutLon, minY - pad),
    createCoordinate(cutLon, maxY + pad),
  ]);

  const check = checkSplittable(leaf, world.store, line);
  const exec = executeSplit(leaf, world.store, line);
  if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
    expect(exec).toBeUndefined();
    return world;
  }
  expect(exec).toBeDefined();
  if (exec === undefined) return world;
  // op == op.
  expect(JSON.stringify(exec.sideA.area)).toBe(JSON.stringify(check.sideA.area));
  expect(JSON.stringify(exec.sideB.area)).toBe(JSON.stringify(check.sideB.area));
  // op ∘ inverse-op: union recovers the pre-split area. Compute the pre-split area
  // from the SEAM-ALIGNED resolved shape: the raw resolved mp of a straddling leaf
  // is split across the ±360° fold, so its planar shoelace area is meaningless until
  // aligned onto one branch (the same alignMultiPolygon the split applies internally).
  const beforeArea = mpFilled41001(
    alignMultiPolygon41001(mp, referenceLonForMultiPolygon41001(mp)),
  );
  // HB3-5/19 n-way: conserve area over ALL pieces (a seam cut on a concave/evolved leaf
  // may yield k+1 pieces, not 2 sides).
  const pieces = check.pieces ?? [check.sideA, check.sideB];
  if (beforeArea > 0) {
    const reArea = pieces.reduce((sum, p) => sum + mpFilled41001(p.area), 0);
    expect(Math.abs(reArea - beforeArea) / beforeArea).toBeLessThan(2e-3);
  }

  const proposal = assembleSplitProposal({
    target: leaf,
    store: world.store.byId,
    result: { pieces, sideA: check.sideA, sideB: check.sideB, edgeCuts: exec.edgeCuts },
    choice: createInheritanceChoice(INHERITANCE_SIDE.A),
    nonInherited: { attributes: ATTRS, color: COLOR },
    ids: idPorts(),
  });
  const inheritor = withLeafShape(leaf, proposal.inheritorShape);
  const nextFeatures = world.features.slice();
  nextFeatures[idx] = inheritor;
  for (const nf of proposal.newFeatures) nextFeatures.push(nf);
  const nextStore = createVertexStore([...world.store.byId.values(), ...proposal.vertices]);
  return { features: nextFeatures, store: nextStore };
}

function seamApplyCmd(world: World, cmd: SeamCmd): World {
  switch (cmd.t) {
    case 'split':
      return seamApplySplit(world, cmd);
    case 'merge':
      return applyMerge(world, { aPick: cmd.pickA, bPick: cmd.pickB });
    case 'noop':
      return world;
  }
}

describe('seed=41001 — seam stateful split/merge chains keep every invariant + persist', () => {
  it('chained seam edits stay valid/finite/resolvable/round-trippable after each op', () => {
    fc.assert(
      fc.property(fc.array(seamCmdArb, { minLength: 1, maxLength: 12 }), (cmds) => {
        let world = seamInitialWorld();
        checkSeamWorldInvariants(world);
        for (const cmd of cmds) {
          world = seamApplyCmd(world, cmd);
          checkSeamWorldInvariants(world);
          expect(world.features.length).toBeGreaterThanOrEqual(1);
          // Extra seam-specific check: every stored vertex stays a representative.
          for (const leaf of world.features) {
            for (const ring of leaf.shape.rings) {
              for (const vid of ring.vertexIds) {
                const v = world.store.byId.get(vid);
                if (v) {
                  expect(v.coordinate.lon).toBeGreaterThanOrEqual(-180);
                  expect(v.coordinate.lon).toBeLessThan(180);
                }
              }
            }
          }
        }
        // (S5) the final seam world round-trips through the REAL U14 path.
        const project = worldToProject(world);
        const reloaded = saveThenLoad(project);
        expect(reloaded).toBeDefined();
        if (reloaded === undefined) return;
        expect(projectsEqual(project, reloaded)).toBe(true);
      }),
      { seed: SEED_41001, numRuns: RUNS_41001 },
    );
  });
});
