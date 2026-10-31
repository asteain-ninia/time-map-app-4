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
//
// 検査の本体は split-merge-knife-geometry.property.test.ts と split-merge-knife-geometry-N.property.test.ts に割ってある。
// vitest はファイル単位でしか並列に分配しないので、1 本に詰めると全件の待ち時間がその 1 本で決まる。
// ここには各ファイルが共有する生成器・補助だけを置く。

import fc from 'fast-check';
import { expect } from '../../test-support/fast-expect';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createAggregateFeature, createLeafFeature, type LeafFeature } from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, isAlternationValid, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { isMultiPolygonValid, type GeoMultiPolygon, union, isOk } from '../geometry/index';
import { createOpenKnifeLine } from '../knife/knife-line';
import { SPLIT_CHECK_STATUS, checkSplittable, executeSplit, smallestPieceIndex, type SplitSide } from '../knife/split-geometry';
import { INHERITANCE_SIDE, createInheritanceChoiceAt, assembleSplitProposal, createInheritanceChoice } from '../knife/proposal';
import { MERGE_STATUS, buildMergeProposal } from '../merge/proposal';
import { parentNone, parentCreate, parentExisting, propertyNew, propertyInherit } from '../merge/decision';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { withLeafShape } from '../feature';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry } from '../anchor-series';
import { createGeoParams } from '../geo/geo-params';
import { timePointYear } from '../time/time-point';
import { asAnchorId } from '../ids';
import { walkToRoot } from '../hierarchy/forest';
import type { Feature } from '../feature';
import { serialize, manifestToProject, type DomainProject, type FeatureHistory, type ProjectSettings, type BaseMapReference } from '../persistence/serialize';
import { parseManifest, isParsed } from '../persistence/boundary';
import { type AnchorSeries } from '../anchor-series';
import { withParentId as withParentId21003, withAggregateChildIds } from '../feature';
import type { FeatureId } from '../ids';
import { quantizeCoordinate as quantizeCoordinate31004 } from '../geometry/index';
import { normalizeCoordinate as normalizeCoordinate31004 } from '../geo/index';
import type { VertexId as VertexId31004 } from '../ids';
import { unwrapRing as unwrapRing41001, alignMultiPolygon as alignMultiPolygon41001, referenceLonForMultiPolygon as referenceLonForMultiPolygon41001 } from '../geo/index';

export const SEED = 1001;
export const RUNS = 400;

export const ATTRS = createBasicAttributes('p', 0, 100);
export const COLOR = createColorInfo(true, '#ffffff', '#00ff00', '#000000');

// Unique-id minting across the whole file (ids only need to be distinct).
export let counter = 0;
export const nextCounter = (): number => counter++;
export const freshVid = () => asVertexId(`bh-v-${nextCounter()}`);
export const freshRid = () => asRingId(`bh-r-${nextCounter()}`);
export const idPorts = () => ({
  nextFeatureId: () => asFeatureId(`bh-f-${nextCounter()}`),
  nextVertexId: () => asVertexId(`bh-nv-${nextCounter()}`),
  nextRingId: () => asRingId(`bh-nr-${nextCounter()}`),
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export interface LeafParams {
  readonly w: number;
  readonly h: number;
  readonly leftHole: boolean;
  readonly enclave: boolean;
  readonly rightHole: boolean;
}

export function box(
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
export function holeyLeaf(p: LeafParams): { feature: LeafFeature; store: VertexStore; cutX: number } {
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

  const feature = createLeafFeature(asFeatureId(`bh-leaf-${nextCounter()}`), ATTRS, COLOR, createShape(rings));
  return { feature, store: createVertexStore(vertices), cutX };
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

export function everyCoordFinite(mp: GeoMultiPolygon): boolean {
  for (const poly of mp) {
    for (const ring of poly) {
      for (const c of ring) {
        if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) return false;
      }
    }
  }
  return true;
}

export function sideArea(side: SplitSide): number {
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

export function filledArea(p: LeafParams): number {
  const outer = p.w * p.h;
  let holes = 0;
  if (p.leftHole) {
    holes += p.w * 0.3 * (p.h * 0.6);
    if (p.enclave) holes -= p.w * 0.16 * (p.h * 0.3);
  }
  if (p.rightHole) holes += p.w * 0.25 * (p.h * 0.4);
  return outer - holes;
}

export const dim = fc.double({ min: 20, max: 80, noNaN: true });
export const flags = () => fc.record({
  leftHole: fc.boolean(),
  enclave: fc.boolean(),
  rightHole: fc.boolean(),
});

export function makeParams(w: number, h: number, f: { leftHole: boolean; enclave: boolean; rightHole: boolean }): LeafParams {
  return { w, h, leftHole: f.leftHole, enclave: f.leftHole && f.enclave, rightHole: f.rightHole };
}

export const STATEFUL_SEED = 1002;
export const STATEFUL_RUNS = 600;

export interface World {
  features: LeafFeature[];
  store: VertexStore;
}

export type Cmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'noop' };

/** Filled (outer − holes) area of a resolved multi-polygon (shoelace). */
export function mpFilledArea(mp: GeoMultiPolygon): number {
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
export function leafBbox(
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
export function checkWorldInvariants(world: World): void {
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
export function applySplit(world: World, cmd: { leafPick: number; frac: number }): World {
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
export function applyMerge(world: World, cmd: { aPick: number; bPick: number }): World {
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

export function applyCmd(world: World, cmd: Cmd): World {
  switch (cmd.t) {
    case 'split':
      return applySplit(world, cmd);
    case 'merge':
      return applyMerge(world, cmd);
    case 'noop':
      return world;
  }
}

export function initialWorld(): World {
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

export const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
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

export const SEED_1004 = 1004;
export const RUNS_1004 = 400;

// --- persistence scaffolding (constant settings / base map for every project) ---

export const PROJECT_SETTINGS: ProjectSettings = {
  calendarId: 'gregorian',
  geo: createGeoParams(40075, 0),
  gridSpacingDeg: 1,
  snapDistancePx: 8,
  autoColorDefault: true,
};
export const BASE_MAP: BaseMapReference = {
  source: 'bh-basemap',
  meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
};

/**
 * Build a DomainProject whose every feature carries a TWO-entry anchor series
 * (years 0 and 50, both holding the same full-state snapshot). This forces the
 * persistence path to round-trip multiple anchors per feature AND lets the
 * round-trip act as the save→load identity over the produced split/merge geometry.
 */
export function worldToProject(world: World): DomainProject {
  const snapshot = createAnchorSnapshot([...world.features], world.store);
  const histories: FeatureHistory[] = world.features.map((f) => {
    const e0 = createAnchorEntry(
      createAnchor(asAnchorId(`bh-a0-${nextCounter()}`), snapshot),
      timePointYear(0),
      timePointYear(25),
    );
    const e1 = createAnchorEntry(
      createAnchor(asAnchorId(`bh-a1-${nextCounter()}`), snapshot),
      timePointYear(30),
      null,
    );
    return { featureId: f.id, series: { entries: [e0, e1] } };
  });
  return { histories, settings: PROJECT_SETTINGS, baseMap: BASE_MAP };
}

/** save ∘ load through the REAL persistence path; returns the reloaded project. */
export function saveThenLoad(project: DomainProject): DomainProject | undefined {
  const manifest = serialize(project);
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  if (!isParsed(parsed)) return undefined;
  return manifestToProject(parsed.manifest);
}

/** Structural identity of two worlds (features by id+shape, store by id+coord). */
export function worldsIdentical(a: World, b: World): boolean {
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

export type Cmd1004 =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'undo' }
  | { readonly t: 'reselect'; readonly pick: number };

export const cmd1004Arb: fc.Arbitrary<Cmd1004> = fc.oneof(
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

export const SEED_21001 = 21001;
export const RUNS_21001 = 400;

/** Resolve a leaf to a finite multi-polygon and return its filled (shoelace) area. */
export function leafFilledArea(leaf: LeafFeature, store: VertexStore): number {
  const mp = resolveLeafShape(leaf.shape, store);
  if (mp === undefined) return 0;
  return mpFilledArea(mp);
}

/**
 * Apply a split choosing EITHER inheritance side, with a HORIZONTAL or VERTICAL
 * cut. Returns the next world (or the same world when the leaf cannot be cut
 * there). Distinct from applySplit (which is side-A + vertical only).
 */
export function applySplitOriented(
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

// --- (P4) stateful: side-choosing + oriented cuts + per-op persistence + undo -

export type Cmd21001 =
  | {
      readonly t: 'split';
      readonly leafPick: number;
      readonly frac: number;
      readonly horizontal: boolean;
      readonly sideB: boolean;
    }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number; readonly inheritA: boolean }
  | { readonly t: 'undo' };

export const cmd21001Arb: fc.Arbitrary<Cmd21001> = fc.oneof(
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
export function applyMergeInherit(
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

export const SEED_21002 = 21002;
export const RUNS_21002 = 500;

// --- (N4) anchor-series stateful over the GUARDED edit ops -------------------

export type AnchorCmd =
  | { readonly t: 'insert'; readonly year: number }
  | { readonly t: 'changeStart'; readonly pick: number; readonly year: number }
  | { readonly t: 'setEnd'; readonly pick: number; readonly end: number | null }
  | { readonly t: 'delete'; readonly pick: number };

export const anchorCmdArb: fc.Arbitrary<AnchorCmd> = fc.oneof(
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

export const SEED_21003 = 21003;
export const RUNS_21003 = 400;

/**
 * Re-sync every aggregate's declared childIds to the parentId relation (single
 * source of truth = parentId), mirroring merge/proposal's syncAggregateChildIds so
 * the forest-stateful model never leaves a manually-reparented aggregate desynced.
 */
export function syncForestChildIds(features: readonly Feature[]): Feature[] {
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
export function worldToProject21003(
  features: readonly Feature[],
  store: VertexStore,
): DomainProject {
  const snapshot = createAnchorSnapshot([...features], store);
  const histories: FeatureHistory[] = features.map((f) => {
    const e0 = createAnchorEntry(
      createAnchor(asAnchorId(`bh3-a0-${nextCounter()}`), snapshot),
      timePointYear(0),
      timePointYear(25),
    );
    const e1 = createAnchorEntry(
      createAnchor(asAnchorId(`bh3-a1-${nextCounter()}`), snapshot),
      timePointYear(30),
      null,
    );
    return { featureId: f.id, series: { entries: [e0, e1] } };
  });
  return { histories, settings: PROJECT_SETTINGS, baseMap: BASE_MAP };
}

// --- (M4) stateful model whose WORLD KEEPS AGGREGATES (forest battery) -------
//
// A separate world model from `World`: it carries the FULL feature set (leaves +
// aggregates) and the store, so the forest invariant runs over a multi-level
// hierarchy as it evolves under split / mixed-merge / reparent commands.

export interface ForestWorld {
  features: Feature[];
  store: VertexStore;
}

export type ForestCmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'reparentTop'; readonly pick: number }
  | { readonly t: 'mergeUnderAgg'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'noop' };

export const forestCmdArb: fc.Arbitrary<ForestCmd> = fc.oneof(
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

export function leafFeaturesOf(world: ForestWorld): LeafFeature[] {
  return world.features.filter((f): f is LeafFeature => f.kind === 'leaf');
}

export function aggregatesOf(world: ForestWorld): Feature[] {
  return world.features.filter((f) => f.kind === 'aggregate');
}

/** Full forest invariant battery over a multi-level world. */
export function checkForestWorldInvariants(world: ForestWorld): void {
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
export function forestSplit(world: ForestWorld, cmd: { leafPick: number; frac: number }): ForestWorld {
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
export function forestReparentTop(world: ForestWorld, cmd: { pick: number }): ForestWorld {
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
export function forestMergeUnderAgg(
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

export function applyForestCmd(world: ForestWorld, cmd: ForestCmd): ForestWorld {
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

export function initialForestWorld(): ForestWorld {
  // A single holey leaf under one aggregate parent — so the forest is multi-level
  // from the start and the very first split exercises hole re-parenting under a
  // live aggregate.
  const aggId = asFeatureId(`bh3-rootA-${nextCounter()}`);
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

export const SEED_21004 = 21004;
export const RUNS_21004 = 500;

/**
 * Build a flat world of N standalone top-level leaves (disjoint boxes), each with
 * its own period [start, end].
 */
export interface FlatWorld {
  readonly features: Feature[];
  readonly store: VertexStore;
}

export function flatLeafWorld(
  specs: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): FlatWorld {
  const features: Feature[] = [];
  const verts: Vertex[] = [];
  specs.forEach((sp, i) => {
    const b = box(i * 50, i * 50 + 30, 0, 30);
    b.ids.forEach((id, k) => verts.push(createVertex(id, b.coords[k]!)));
    features.push(
      createLeafFeature(
        asFeatureId(`bh4r-leaf-${nextCounter()}`),
        createBasicAttributes(`L${i}`, sp.start, sp.end),
        COLOR,
        createShape([createTerritoryRing(freshRid(), b.ids)]),
      ),
    );
  });
  return { features, store: createVertexStore(verts) };
}

/** A deep structural snapshot of a feature list + store, for purity comparison. */
export function featureWorldSnapshot(features: readonly Feature[], store: VertexStore): string {
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

export const STD_PROP = propertyNew({ attributes: ATTRS, color: COLOR });

// --- (R5) stateful: interleave legal merges with illegal (no-op) attempts -----

export type RejCmd =
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

export const rejCmdArb: fc.Arbitrary<RejCmd> = fc.oneof(
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

export const SEED_31002 = 31002;
export const RUNS_31002 = 500;

// --- (X3)/(X4) combined geometry + anchor-series stateful model with undo -----

export interface CoupledWorld {
  readonly world: World;
  /** featureId → its live anchor series (one per surviving feature). */
  readonly series: ReadonlyMap<FeatureId, AnchorSeries>;
}

export type CoupledCmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'anchorInsert'; readonly featPick: number; readonly year: number }
  | { readonly t: 'anchorChangeStart'; readonly featPick: number; readonly entryPick: number; readonly year: number }
  | { readonly t: 'anchorSetEnd'; readonly featPick: number; readonly entryPick: number; readonly end: number | null }
  | { readonly t: 'anchorDelete'; readonly featPick: number; readonly entryPick: number }
  | { readonly t: 'undo' };

export const coupledCmdArb: fc.Arbitrary<CoupledCmd> = fc.oneof(
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

export const SEED_31003 = 31003;
export const RUNS_31003 = 500;

// --- (Y2) diagonal-cut + smallerSide stateful model -------------------------

export type Cmd31003 =
  | {
      readonly t: 'split';
      readonly leafPick: number;
      readonly t0: number;
      readonly t1: number;
    }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'undo' };

export const cmd31003Arb: fc.Arbitrary<Cmd31003> = fc.oneof(
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
export function applySplitDiagonal(
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

export const SEED_31004 = 31004;
export const RUNS_31004 = 600;

/** The exact coordKey buildRemap / coordKey use (quantize ∘ normalize → string). */
export function coordKey31004(c: WorldCoordinate): string {
  const q = quantizeCoordinate31004(normalizeCoordinate31004(c));
  return `${q.lon}|${q.lat}`;
}

/** Every vertex id cited by a leaf's rings. */
export function leafVertexIds31004(leaf: LeafFeature): Set<VertexId31004> {
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
export function assertRemapSound31004(args: {
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

// --- (Z3) remap-driven selection validity stateful model ---------------------

export interface SelWorld {
  readonly world: World;
  /** A set of "selected" vertex ids the user is tracking across edits. */
  readonly selected: ReadonlySet<VertexId31004>;
}

export type SelCmd =
  | { readonly t: 'split'; readonly leafPick: number; readonly frac: number }
  | { readonly t: 'merge'; readonly aPick: number; readonly bPick: number }
  | { readonly t: 'selectRing'; readonly leafPick: number }
  | { readonly t: 'undo' };

export const selCmdArb: fc.Arbitrary<SelCmd> = fc.oneof(
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
export function citedVertexIds31004(world: World): Set<VertexId31004> {
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
export function carrySelection31004(
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
export function selSplit(world: World, cmd: { leafPick: number; frac: number }): {
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
export function selMerge(world: World, cmd: { aPick: number; bPick: number }): {
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

export const SEED_41001 = 41001;
export const RUNS_41001 = 500;

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
export function checkSeamWorldInvariants(world: World): void {
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
export function seamLeaf(opts: {
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
    asFeatureId(`bh-seam-${nextCounter()}`),
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
export function mpFilled41001(mp: GeoMultiPolygon): number {
  return mpFilledArea(mp);
}

// --- (S4) seam stateful model + (S5) real persistence round-trip ------------

export interface SeamCmd {
  readonly t: 'split' | 'merge' | 'noop';
  readonly pickA: number;
  readonly pickB: number;
  readonly frac: number;
  readonly replicaTurns: number;
}

export const seamCmdArb: fc.Arbitrary<SeamCmd> = fc.record({
  t: fc.constantFrom<'split' | 'merge' | 'noop'>('split', 'split', 'merge', 'noop'),
  pickA: fc.nat({ max: 1_000_000 }),
  pickB: fc.nat({ max: 1_000_000 }),
  frac: fc.double({ min: 0, max: 1, noNaN: true }),
  replicaTurns: fc.constantFrom(-1, 0, 1),
});

/** Initial seam world: a single seam-straddling holey leaf centered at +180°. */
export function seamInitialWorld(): World {
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
export function seamApplySplit(world: World, cmd: SeamCmd): World {
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

export function seamApplyCmd(world: World, cmd: SeamCmd): World {
  switch (cmd.t) {
    case 'split':
      return seamApplySplit(world, cmd);
    case 'merge':
      return applyMerge(world, { aPick: cmd.pickA, bPick: cmd.pickB });
    case 'noop':
      return world;
  }
}
