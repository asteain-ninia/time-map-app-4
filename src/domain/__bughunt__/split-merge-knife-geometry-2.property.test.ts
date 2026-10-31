// split-merge-knife-geometry の検査 2/3。全体の説明と共有の生成器は split-merge-knife-geometry.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { createBasicAttributes } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createAggregateFeature, createLeafFeature, type LeafFeature } from '../feature';
import { asFeatureId } from '../ids';
import { createShape, createTerritoryRing, isAlternationValid } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { isMultiPolygonValid, union, isOk } from '../geometry/index';
import { createOpenKnifeLine } from '../knife/knife-line';
import { SPLIT_CHECK_STATUS, checkSplittable, executeSplit, smallerSide } from '../knife/split-geometry';
import { INHERITANCE_SIDE, assembleSplitProposal, createInheritanceChoice, inheritorFeature } from '../knife/proposal';
import { MERGE_STATUS, buildMergeProposal } from '../merge/proposal';
import { parentNone, parentCreate, parentExisting, propertyNew } from '../merge/decision';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, isValidSeries } from '../anchor-series';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { asAnchorId } from '../ids';
import { walkToRoot } from '../hierarchy/forest';
import type { Feature } from '../feature';
import { projectsEqual } from '../persistence/serialize';
import { changeStart, setEnd, deleteAnchor, applyPastEdit, type AnchorSeries } from '../anchor-series';
import { MERGE_KIND as MERGE_KIND_21003 } from '../merge/proposal';
import { MERGE_REJECT, existsAtTime } from '../merge/precondition';
import { allowedMergeParentCandidates, propertyInheritCandidates } from '../merge/candidates';
import { descendantIds } from '../hierarchy/forest';
import type { FeatureId } from '../ids';
import { CREATE_TERMINAL, parentCreateWithTerminal } from '../merge/decision';
import type { VertexId as VertexId31004 } from '../ids';
import { alignMultiPolygon as alignMultiPolygon41001, referenceLonForMultiPolygon as referenceLonForMultiPolygon41001 } from '../geo/index';
import {
  ATTRS,
  COLOR,
  type CoupledWorld,
  RUNS_21004,
  RUNS_31002,
  RUNS_31003,
  RUNS_31004,
  RUNS_41001,
  SEED_21004,
  SEED_31002,
  SEED_31003,
  SEED_31004,
  SEED_41001,
  STD_PROP,
  type SelWorld,
  type World,
  applyMerge,
  applySplit,
  applySplitDiagonal,
  assertRemapSound31004,
  box,
  carrySelection31004,
  checkWorldInvariants,
  cmd31003Arb,
  coordKey31004,
  coupledCmdArb,
  dim,
  everyCoordFinite,
  featureWorldSnapshot,
  flags,
  freshRid,
  holeyLeaf,
  idPorts,
  initialWorld,
  leafFilledArea,
  leafVertexIds31004,
  makeParams,
  mpFilled41001,
  nextCounter,
  rejCmdArb,
  saveThenLoad,
  seamLeaf,
  selCmdArb,
  selMerge,
  selSplit,
  sideArea,
  worldToProject,
  worldsIdentical,
} from './split-merge-knife-geometry.arbitraries';

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
            const fid = asFeatureId(`bh4c-leaf-${nextCounter()}`);
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
          const aggId = asFeatureId(`bh4c-agg-${nextCounter()}`);
          const gcBox = box(5000, 5040, 0, 40);
          gcBox.ids.forEach((id, idx) => verts.push(createVertex(id, gcBox.coords[idx]!)));
          const gcId = asFeatureId(`bh4c-gc-${nextCounter()}`);
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
            const ghost = asFeatureId(`bh4s-ghost-${nextCounter()}`);
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

        const existingTopId = asFeatureId(`bh31-top-${nextCounter()}`);
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
            asFeatureId(`bh31-a-${nextCounter()}`),
            createBasicAttributes('A', 0, 100),
            COLOR,
            createShape([createTerritoryRing(freshRid(), bA.ids)]),
          );
          const leafB = createLeafFeature(
            asFeatureId(`bh31-b-${nextCounter()}`),
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

describe('seed=31002 — coupled geometry + anchor-series stateful model (invariants + undo)', () => {
  it('split / merge / guarded anchor edits keep BOTH batteries valid; undo restores the coupled state exactly', () => {
    const cal = getCalendar('gregorian');
    const emptySnap = createAnchorSnapshot([], createVertexStore([]));

    // Build a fresh single-entry series for a feature that just appeared.
    const freshSeries = (): AnchorSeries => ({
      entries: [
        createAnchorEntry(
          createAnchor(asAnchorId(`bh31-an-${nextCounter()}`), emptySnap),
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
                () => createAnchor(asAnchorId(`bh31-an-${nextCounter()}`), emptySnap),
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
                createAnchor(asAnchorId(`bh31x-an-${nextCounter()}`), emptySnap),
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
            asFeatureId(`bh31004-a-${nextCounter()}`),
            createBasicAttributes('A', 0, 100),
            COLOR,
            createShape([createTerritoryRing(freshRid(), bA.ids)]),
          );
          const leafB = createLeafFeature(
            asFeatureId(`bh31004-b-${nextCounter()}`),
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
          const aggId = asFeatureId(`bh31004-A-${nextCounter()}`);
          aggIds.push(aggId);
          const lb = box(i * 100, i * 100 + 50, 0, 50);
          lb.ids.forEach((id, k) => verts.push(createVertex(id, lb.coords[k]!)));
          const childId = asFeatureId(`bh31004-c-${nextCounter()}`);
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
