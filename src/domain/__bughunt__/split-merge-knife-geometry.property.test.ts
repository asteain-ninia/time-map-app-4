// split-merge-knife-geometry の検査 1/3。全体の説明と共有の生成器は split-merge-knife-geometry.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createAggregateFeature, createLeafFeature, type LeafFeature } from '../feature';
import { asFeatureId } from '../ids';
import { createShape, createTerritoryRing, isAlternationValid } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { isMultiPolygonValid, type GeoMultiPolygon, union, isOk } from '../geometry/index';
import { createClosedKnifeLine, createOpenKnifeLine } from '../knife/knife-line';
import { SPLIT_CHECK_STATUS, checkSplittable, executeSplit, smallerSide } from '../knife/split-geometry';
import { INHERITANCE_SIDE, assembleSplitProposal, createInheritanceChoice, inheritorFeature } from '../knife/proposal';
import { MERGE_STATUS, buildMergeProposal } from '../merge/proposal';
import { parentNone, parentCreate, parentExisting, propertyNew, propertyInherit } from '../merge/decision';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, isValidSeries } from '../anchor-series';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { asAnchorId } from '../ids';
import { walkToRoot } from '../hierarchy/forest';
import type { Feature } from '../feature';
import { serialize, manifestToProject, projectsEqual } from '../persistence/serialize';
import { parseManifest, isParsed } from '../persistence/boundary';
import { createClosedKnifeLine as createClosedKnifeLine21002 } from '../knife/knife-line';
import { changeStart, setEnd, deleteAnchor, applyPastEdit, type AnchorSeries } from '../anchor-series';
import { MERGE_KIND as MERGE_KIND_21003 } from '../merge/proposal';
import { withParentId as withParentId21003 } from '../feature';
import { MERGE_REJECT, validateMergePreconditions, existsAtTime, isVerticallyRelated } from '../merge/precondition';
import {
  ATTRS,
  COLOR,
  RUNS,
  RUNS_1004,
  RUNS_21001,
  RUNS_21002,
  RUNS_21003,
  RUNS_21004,
  SEED,
  SEED_1004,
  SEED_21001,
  SEED_21002,
  SEED_21003,
  SEED_21004,
  STATEFUL_RUNS,
  STATEFUL_SEED,
  STD_PROP,
  type World,
  anchorCmdArb,
  applyCmd,
  applyForestCmd,
  applyMerge,
  applyMergeInherit,
  applySplit,
  applySplitOriented,
  box,
  checkForestWorldInvariants,
  checkWorldInvariants,
  cmd1004Arb,
  cmd21001Arb,
  cmdArb,
  dim,
  everyCoordFinite,
  featureWorldSnapshot,
  filledArea,
  flags,
  flatLeafWorld,
  forestCmdArb,
  freshRid,
  holeyLeaf,
  idPorts,
  initialForestWorld,
  initialWorld,
  leafFilledArea,
  makeParams,
  mpFilledArea,
  nextCounter,
  saveThenLoad,
  sideArea,
  worldToProject,
  worldToProject21003,
  worldsIdentical,
} from './split-merge-knife-geometry.arbitraries';

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
          const aggId = asFeatureId(`bh-A-${nextCounter()}`);
          aggIds.push(aggId);
          // one child leaf per aggregate.
          const lb = box(i * 100, i * 100 + 50, 0, 50);
          lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
          const childId = asFeatureId(`bh-c-${nextCounter()}`);
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
            const aggId = asFeatureId(`bh4-A-${nextCounter()}`);
            aggIds.push(aggId);
            const lb = box(i * 100, i * 100 + 50, 0, 50);
            lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
            const childId = asFeatureId(`bh4-c-${nextCounter()}`);
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
            createAnchorEntry(createAnchor(asAnchorId(`bh4-an-${nextCounter()}`), snap), timePointYear(y), null),
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
        const existingAggId = asFeatureId(`bh21-existing-${nextCounter()}`);
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
      const existingAggId = asFeatureId(`bh21-reg-existing-${nextCounter()}`);
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
                asFeatureId(`bh2-leaf-${nextCounter()}`),
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
            const aggId = asFeatureId(`bh2-A-${nextCounter()}`);
            aggIds.push(aggId);
            const childIds: ReturnType<typeof asFeatureId>[] = [];
            for (let c = 0; c < 2; c += 1) {
              const lb = box(i * 200 + c * 60, i * 200 + c * 60 + 40, 0, 40);
              lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
              const childId = asFeatureId(`bh2-c-${nextCounter()}`);
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
        const existingTopId = asFeatureId(`bh2-top-${nextCounter()}`);
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
              createAnchor(asAnchorId(`bh2-an-${nextCounter()}`), emptySnap),
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
              () => createAnchor(asAnchorId(`bh2-an-${nextCounter()}`), emptySnap),
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
                createAnchor(asAnchorId(`bh2-mm-${nextCounter()}`), emptySnap),
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
              const a = createAnchor(asAnchorId(`bh2-mm-${nextCounter()}`), emptySnap);
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
          const aggId = asFeatureId(`bh3-A-${nextCounter()}`);
          const childIds: ReturnType<typeof asFeatureId>[] = [];
          for (let c = 0; c < k; c += 1) {
            const lb = box(c * 60, c * 60 + 40, 0, 40);
            lb.ids.forEach((id, i) => verts.push(createVertex(id, lb.coords[i]!)));
            const childId = asFeatureId(`bh3-c-${nextCounter()}`);
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
          const standaloneId = asFeatureId(`bh3-s-${nextCounter()}`);
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

        const existingAggId = asFeatureId(`bh3-exist-${nextCounter()}`);
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
          const ghost = asFeatureId(`bh4r-ghost-${nextCounter()}`); // never in `features`.
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
        const parentAggId = asFeatureId(`bh4r-par-${nextCounter()}`);
        const childId = asFeatureId(`bh4r-chi-${nextCounter()}`);
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

        const parentAggId = asFeatureId(`bh4g-par-${nextCounter()}`);
        const childId = asFeatureId(`bh4g-chi-${nextCounter()}`);
        const otherLeafId = asFeatureId(`bh4g-oth-${nextCounter()}`);
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
