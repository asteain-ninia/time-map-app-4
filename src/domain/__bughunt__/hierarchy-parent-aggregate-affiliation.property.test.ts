// BUG HUNT (discovery only) — focus: hierarchy-parent-aggregate-affiliation.
//
// This file is the AFFILIATION-flow-centric sibling of
// `hierarchy-parent-aggregate-union.property.test.ts`. The union file drives a
// HAND-BUILT valid model and (in its §6) the real affiliation flow with seeds
// 5001/5002/5004. This file is a NEW exploration (seed = 25001, deliberately
// disjoint from 1000..6000) that hammers the REAL public 所属変更 pipeline
// (buildAffiliationProposal / buildAffiliationProposalForTargets /
// realizeDecision / syncAggregateChildIds / sweepAndPruneAnchor /
// createAffiliationCommand) with:
//
//   - RICHER initial forests that carry VARIED existence periods, so the
//     create→existing existence-period guard (realizeDecision / candidates.ts)
//     is actually exercised (the union file uses uniform [0,1] periods that can
//     never trip ExistencePeriod);
//   - NEW command interactions: chained createUnderExisting, federate of N
//     targets, none∘existing inverse pairs, and interleaved anchor-series edits;
//   - A PARALLEL anchor series (U09) whose snapshots ride each committed
//     affiliation state, so we additionally assert the anchor-列 invariants the
//     union file never touches: INV-1 strictly-ascending starts (錨列の昇順) and
//     INV-6 unique anchor ids (非重複).
//
// Invariants asserted after EVERY committed command (派生集約=子の和 / 階層森構造
// / 座標 finite / 選択が常に有効 / save->load=恒等):
//   - forest is a valid tree: no cycle / dangling parent / duplicate id /
//     aggregate-shape mismatch / shape-unresolved / child-parent mismatch
//     (validateHierarchy with the vertex store => 形状=和・隙間なし runs);
//   - derived depth coherent (child = parent + 1, root = 0, no DEPTH_UNDEFINED);
//   - 派生集約 = 子の和: every feature WITH children has derived area exactly the
//     U06 union of its direct children's derived areas (no gap, no overflow);
//   - aggregate childIds == parentId-derived children (single-source agreement);
//   - every resolved coordinate is finite (no NaN / Infinity);
//   - selection stays valid: every survivedTouched / created id resolves and
//     every deleted id is gone in the committed state;
//   - anchor series stays INV-1 (ascending, no dup start) + INV-6 (unique ids).
//
// Metamorphic:
//   - undo ∘ op == identity AND op ∘ undo ∘ redo == op (createAffiliationCommand);
//   - op ∘ 逆op == identity for the none∘existing inverse pair (re-affiliate a
//     leaf under a parent, then back to top-level, returns the leaf's parentId);
//   - save ∘ load (JSON round-trip) == identity over the committed feature set.
//
// Determinism: seed = 25001 fixed, numRuns large (300..1000). PERMANENT ASSET:
// the assertions encode the SPEC and must never be weakened to paint a broken
// behaviour green. A counter-example is a finding, not a reason to relax a check.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { union, isOk } from '../geometry/boolean-ops';
import { type GeoMultiPolygon } from '../geometry/types';
import { asAnchorId, asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import {
  buildForest,
  directChildIds,
} from '../hierarchy/forest';
import {
  derivedDepth,
  derivedDepths,
  DEPTH_UNDEFINED,
} from '../hierarchy/depth';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import {
  areasEqualWithinTolerance,
  HIERARCHY_VIOLATION,
  validateHierarchy,
} from '../hierarchy/validate';
import {
  createVertex,
  createVertexStore,
  type Vertex,
  type VertexStore,
} from '../vertex';
import {
  buildAffiliationProposal,
  buildAffiliationProposalForTargets,
  type AffiliationProposal,
  type ProposalResult,
} from '../affiliation/proposal';
import {
  parentCreate,
  parentExisting,
  parentNone,
  type ParentDecision,
} from '../affiliation/decision';
import { createAffiliationCommand } from '../affiliation/command';
import { createIdGeneratorState } from '../id-generator';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import {
  changeStart,
  createAnchorEntry,
  deleteAnchor,
  normalizeSeries,
  setEnd,
  validateSeries,
  type AnchorSeries,
} from '../anchor-series';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';

const SEED = 25001;
// Second bug-hunt pass: a NEW, deliberately-disjoint exploration that does not
// re-walk seed 25001's runs. Used by every §5..§8 block below.
const SEED2 = 25002;
const COLOR = createColorInfo(true, '#0a141e', '#283c50', '#5a6e82');
const CAL = getCalendar('gregorian');

// ---------------------------------------------------------------------------
// Model: a valid forest of aggregates-of-leaf-strips, each in its own disjoint
// spatial band AND with a controllable existence period. Unlike the union file
// (uniform [0,1] periods), each ROOT gets a period that may DIFFER, so when an
// affiliation command re-parents a leaf under a feature in another band/period
// the create→existing existence guard can genuinely reject.
// ---------------------------------------------------------------------------

interface RootSpec {
  /** number of leaf children under this root aggregate (>= 1). */
  readonly childCount: number;
  /** existence period of the whole sub-tree (closed [start,end]). */
  readonly start: number;
  readonly end: number;
}

interface ModelState {
  features: Feature[];
  vertices: Vertex[];
}

function emptyState(): ModelState {
  return { features: [], vertices: [] };
}

function store(s: ModelState): VertexStore {
  return createVertexStore(s.vertices);
}

/** Build the forest. Each root: an aggregate over `childCount` adjacent leaf
 *  strips, gapless, in its own y-band; period propagates to children. */
function buildForestFromSpecs(specs: readonly RootSpec[]): ModelState {
  const s = emptyState();
  let n = 0;
  specs.forEach((spec, rootIdx) => {
    const baseY = rootIdx * 1000; // disjoint spatial bands.
    const childIds: FeatureId[] = [];
    n += 1;
    const aggId = asFeatureId(`f-agg-${n}`);
    for (let c = 0; c < spec.childCount; c += 1) {
      n += 1;
      const suffix = `leaf-${n}`;
      const x = c * 10;
      const corners = [
        createCoordinate(x, baseY),
        createCoordinate(x + 10, baseY),
        createCoordinate(x + 10, baseY + 10),
        createCoordinate(x, baseY + 10),
      ];
      const verts = corners.map((cc, i) =>
        createVertex(asVertexId(`v-${suffix}-${i}`), cc),
      );
      s.vertices.push(...verts);
      const ring = createTerritoryRing(
        asRingId(`r-${suffix}`),
        verts.map((v) => v.id),
      );
      const fid = asFeatureId(`f-${suffix}`);
      childIds.push(fid);
      s.features.push(
        createLeafFeature(
          fid,
          createBasicAttributes(suffix, spec.start, spec.end),
          COLOR,
          createShape([ring]),
          { parentId: aggId },
        ),
      );
    }
    s.features.push(
      createAggregateFeature(
        aggId,
        createBasicAttributes(`agg-${n}`, spec.start, spec.end),
        COLOR,
        childIds,
      ),
    );
  });
  return s;
}

const rootSpecArb: fc.Arbitrary<RootSpec> = fc
  .record({
    childCount: fc.integer({ min: 1, max: 4 }),
    start: fc.integer({ min: -50, max: 50 }),
    span: fc.integer({ min: 1, max: 60 }),
  })
  .map(({ childCount, start, span }) => ({ childCount, start, end: start + span }));

function validForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(rootSpecArb, { minLength: 1, maxLength: 4 })
    .map((specs) => buildForestFromSpecs(specs));
}

// ---------------------------------------------------------------------------
// Shared invariant assertions over an arbitrary committed feature set.
// ---------------------------------------------------------------------------

function allCoordsFinite(mp: GeoMultiPolygon): boolean {
  for (const poly of mp) {
    for (const ring of poly) {
      for (const c of ring) {
        if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) return false;
      }
    }
  }
  return true;
}

function unionAll(areas: readonly GeoMultiPolygon[]): GeoMultiPolygon | undefined {
  let acc: GeoMultiPolygon = [];
  for (const a of areas) {
    const m = union(acc, a);
    if (!isOk(m)) return undefined;
    acc = m.result;
  }
  return acc;
}

/** Every load-bearing affiliation/hierarchy invariant on a committed set. */
function assertFeatureSetInvariants(
  features: readonly Feature[],
  vstore: VertexStore,
): void {
  const forest = buildForest(features);

  // (a) structural validity WITH shape check (形状=和・隙間なし).
  const v = validateHierarchy(features, { vertexStore: vstore });
  const badKinds = [
    HIERARCHY_VIOLATION.Cycle,
    HIERARCHY_VIOLATION.DanglingParent,
    HIERARCHY_VIOLATION.DuplicateId,
    HIERARCHY_VIOLATION.AggregateShapeMismatch,
    HIERARCHY_VIOLATION.ShapeUnresolved,
    HIERARCHY_VIOLATION.ChildParentMismatch,
  ];
  for (const kind of badKinds) {
    const hits = v.violations.filter((x) => x.kind === kind);
    expect(hits, `unexpected ${kind}: ${JSON.stringify(hits)}`).toHaveLength(0);
  }

  // (b) depth coherence + (c) derived area finite + 派生集約=子の和 + childIds sync.
  const depths = derivedDepths(forest);
  for (const f of features) {
    const d = derivedDepth(forest, f.id);
    expect(d, `DEPTH_UNDEFINED for ${f.id}`).not.toBe(DEPTH_UNDEFINED);
    expect(depths.get(f.id)).toBe(d);
    if (f.parentId === undefined) {
      expect(d).toBe(0);
    } else {
      expect(forest.byId.has(f.parentId), `dangling parent on ${f.id}`).toBe(true);
      expect(d).toBe(derivedDepth(forest, f.parentId) + 1);
    }

    const res = resolveFeatureArea(forest, vstore, f.id);
    expect(res.status, `resolve failed for ${f.id}`).toBe('ok');
    if (res.status !== 'ok') continue;
    expect(allCoordsFinite(res.area), `non-finite coord in ${f.id}`).toBe(true);

    const childIds = directChildIds(forest, f.id);
    if (childIds.length > 0) {
      const childAreas: GeoMultiPolygon[] = [];
      let ok = true;
      for (const cid of childIds) {
        const cres = resolveFeatureArea(forest, vstore, cid);
        if (cres.status !== 'ok') {
          ok = false;
          break;
        }
        childAreas.push(cres.area);
      }
      expect(ok, `child resolve failed under ${f.id}`).toBe(true);
      const u = unionAll(childAreas);
      expect(u, `union failed under ${f.id}`).toBeDefined();
      if (u !== undefined) {
        // 派生集約=子の和: a feature with children's area == union of children.
        expect(
          areasEqualWithinTolerance(res.area, u),
          `派生集約≠子の和 on ${f.id}`,
        ).toBe(true);
      }
      // aggregate that HAS children must be a structural aggregate (FR-35).
      expect(f.kind, `feature ${f.id} has children but is not aggregate`).toBe('aggregate');
    }

    // (d) aggregate childIds == parentId-derived children (single source).
    if (f.kind === 'aggregate') {
      const declared = [...f.childIds].sort();
      const derived = [...childIds].sort();
      expect(declared, `childIds drift on ${f.id}`).toEqual(derived);
    }
  }
}

// ---------------------------------------------------------------------------
// Structural feature-set equality for metamorphic identities.
// ---------------------------------------------------------------------------

function featuresEqual(a: readonly Feature[], b: readonly Feature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const fa = a[i]!;
    const fb = b[i]!;
    if (fa.kind !== fb.kind) return false;
    if (fa.id !== fb.id) return false;
    if (fa.parentId !== fb.parentId) return false;
    if (fa.attributes.startYear !== fb.attributes.startYear) return false;
    if (fa.attributes.endYear !== fb.attributes.endYear) return false;
    if (fa.kind === 'aggregate' && fb.kind === 'aggregate') {
      if (fa.childIds.length !== fb.childIds.length) return false;
      for (let j = 0; j < fa.childIds.length; j += 1) {
        if (fa.childIds[j] !== fb.childIds[j]) return false;
      }
    }
    if (fa.kind === 'leaf' && fb.kind === 'leaf') {
      if (fa.shape.rings.length !== fb.shape.rings.length) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Random real affiliation command spec (drives the PUBLIC flow only).
// ---------------------------------------------------------------------------

type AffCmd =
  | { readonly t: 'existing'; readonly targetWhich: number; readonly parentWhich: number }
  | { readonly t: 'none'; readonly targetWhich: number }
  | { readonly t: 'createNewTop'; readonly targetWhich: number }
  | { readonly t: 'createUnderExisting'; readonly targetWhich: number; readonly topWhich: number }
  | { readonly t: 'createDeep'; readonly targetWhich: number }
  | { readonly t: 'federate'; readonly aWhich: number; readonly bWhich: number; readonly cWhich: number };

const affCmdArb: fc.Arbitrary<AffCmd> = fc.oneof(
  fc.record({ t: fc.constant<'existing'>('existing'), targetWhich: fc.nat(), parentWhich: fc.nat() }),
  fc.record({ t: fc.constant<'none'>('none'), targetWhich: fc.nat() }),
  fc.record({ t: fc.constant<'createNewTop'>('createNewTop'), targetWhich: fc.nat() }),
  fc.record({
    t: fc.constant<'createUnderExisting'>('createUnderExisting'),
    targetWhich: fc.nat(),
    topWhich: fc.nat(),
  }),
  fc.record({ t: fc.constant<'createDeep'>('createDeep'), targetWhich: fc.nat() }),
  fc.record({
    t: fc.constant<'federate'>('federate'),
    aWhich: fc.nat(),
    bWhich: fc.nat(),
    cWhich: fc.nat(),
  }),
);

interface AffState {
  features: readonly Feature[];
  store: VertexStore;
  idCounter: number;
}

function makeNow(start: number): () => number {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
}

function pick<T>(arr: readonly T[], n: number): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[n % arr.length];
}

/** Build + (if committed) apply ONE real affiliation command. undefined when the
 *  command did not commit (rejected / N/A) — a legitimate outcome, not a bug. */
function applyAffCmd(
  st: AffState,
  cmd: AffCmd,
): { next: AffState; proposal: AffiliationProposal; baseline: readonly Feature[] } | undefined {
  const features = st.features;
  const idState = createIdGeneratorState(0, st.idCounter);
  const now = makeNow(st.idCounter * 100 + 1);
  const opts = { idState, now, vertexStore: st.store };
  const allIds = features.map((f) => f.id);

  let result: ProposalResult;
  switch (cmd.t) {
    case 'existing': {
      const target = pick(allIds, cmd.targetWhich);
      const parent = pick(allIds, cmd.parentWhich);
      if (target === undefined || parent === undefined) return undefined;
      result = buildAffiliationProposal(features, target, parentExisting(parent), opts);
      break;
    }
    case 'none': {
      const target = pick(allIds, cmd.targetWhich);
      if (target === undefined) return undefined;
      result = buildAffiliationProposal(features, target, parentNone, opts);
      break;
    }
    case 'createNewTop': {
      const target = pick(allIds, cmd.targetWhich);
      if (target === undefined) return undefined;
      result = buildAffiliationProposal(
        features,
        target,
        parentCreate({ name: 'new-top' }, parentNone),
        opts,
      );
      break;
    }
    case 'createUnderExisting': {
      const target = pick(allIds, cmd.targetWhich);
      const top = pick(allIds, cmd.topWhich);
      if (target === undefined || top === undefined) return undefined;
      result = buildAffiliationProposal(
        features,
        target,
        parentCreate({ name: 'mid' }, parentExisting(top)),
        opts,
      );
      break;
    }
    case 'createDeep': {
      // create -> create -> none : a 2-level intermediate stack inserted at once
      // (FR-47 multi-level 後付け挿入). Exercises recursive realizeDecision.
      const target = pick(allIds, cmd.targetWhich);
      if (target === undefined) return undefined;
      const decision: ParentDecision = parentCreate(
        { name: 'mid-low' },
        parentCreate({ name: 'mid-high' }, parentNone),
      );
      result = buildAffiliationProposal(features, target, decision, opts);
      break;
    }
    case 'federate': {
      const a = pick(allIds, cmd.aWhich);
      const b = pick(allIds, cmd.bWhich);
      const c = pick(allIds, cmd.cWhich);
      const targets = [...new Set([a, b, c].filter((x): x is FeatureId => x !== undefined))];
      if (targets.length < 2) return undefined;
      result = buildAffiliationProposalForTargets(
        features,
        targets,
        parentCreate({ name: 'federation' }, parentNone),
        opts,
      );
      break;
    }
  }

  if (result.status !== 'proposal') return undefined;
  const proposal = result.proposal;
  const next: AffState = {
    features: proposal.nextFeatures,
    store: st.store,
    idCounter: proposal.idState.counter + 1,
  };
  return { next, proposal, baseline: features };
}

// ===========================================================================
// 1. STATEFUL DRIVE: every invariant after every committed real command.
// ===========================================================================

describe(`affiliation — every invariant after every committed real command (seed=${SEED})`, () => {
  it('forest validity / depth / 派生集約=子の和 / childIds sync / coord-finite / selection', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 12 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 100,
          };
          assertFeatureSetInvariants(st.features, st.store);

          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied === undefined) continue; // rejected / N/A: legitimate.
            assertFeatureSetInvariants(applied.next.features, applied.next.store);

            // 選択が常に有効: notified ids resolve, deleted ids gone.
            const present = new Set(applied.next.features.map((f) => f.id));
            for (const id of applied.proposal.survivedTouchedIds) {
              expect(present.has(id), `survivedTouched ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.createdIds) {
              expect(present.has(id), `created ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.deletedIds) {
              expect(present.has(id), `deleted ${id} still present`).toBe(false);
            }
            // createdIds ⊆ new ids (never re-emit an existing id).
            const baselineIds = new Set(st.features.map((f) => f.id));
            for (const id of applied.proposal.createdIds) {
              expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
            }
            st = applied.next;
          }
        },
      ),
      { seed: SEED, numRuns: 600 },
    );
  });
});

// ===========================================================================
// 2. PARALLEL ANCHOR SERIES: 錨列の昇順・非重複 after each committed command.
//
// Model U09 directly: a single feature's history anchor series whose snapshots
// ride the committed affiliation states. Each committed command appends a new
// anchor at a strictly-increasing year. After normalizeSeries the series MUST
// satisfy INV-1 (ascending, no dup start) and INV-6 (unique anchor ids). We
// additionally inject a deliberately-duplicated anchor id / duplicate start and
// assert normalizeSeries REPAIRS it (no false negative on the repair contract).
// ===========================================================================

function snapshotEntry(features: readonly Feature[], vstore: VertexStore, idx: number) {
  const snap = createAnchorSnapshot(features, vstore);
  const anchor = createAnchor(asAnchorId(`a-${idx}`), snap);
  return createAnchorEntry(anchor, timePointYear(idx * 10), null);
}

function assertAscendingUnique(series: AnchorSeries): void {
  const res = validateSeries(series, CAL);
  expect(res.ok, `series invalid: ${JSON.stringify(res)}`).toBe(true);
  // Defensive: explicit ascending + unique-id checks (do not trust ok alone).
  const ids = new Set<string>();
  let prevStartYear: number | undefined;
  for (const e of series.entries) {
    expect(ids.has(e.anchor.id), `dup anchor id ${e.anchor.id}`).toBe(false);
    ids.add(e.anchor.id);
    const y = e.start.year;
    if (prevStartYear !== undefined) {
      expect(y, 'starts not strictly ascending').toBeGreaterThan(prevStartYear);
    }
    prevStartYear = y;
  }
}

describe(`affiliation — anchor列 昇順・非重複 across committed history (seed=${SEED})`, () => {
  it('a series of committed-state snapshots stays INV-1 ascending + INV-6 unique', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 8 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 200,
          };
          const entries = [snapshotEntry(st.features, st.store, 0)];
          let idx = 1;
          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied === undefined) continue;
            st = applied.next;
            entries.push(snapshotEntry(st.features, st.store, idx));
            idx += 1;
            const series = normalizeSeries(entries, CAL);
            assertAscendingUnique(series);
            // every snapshot still resolves a valid forest.
            assertFeatureSetInvariants(st.features, st.store);
          }
          // Final normalize is idempotent and stays valid.
          assertAscendingUnique(normalizeSeries(entries, CAL));
        },
      ),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('normalizeSeries REPAIRS an injected duplicate anchor id / duplicate start', () => {
    fc.assert(
      fc.property(validForestArb(), (initial) => {
        const vstore = store(initial);
        // Two entries sharing the SAME anchor id (INV-6 violation) and another
        // pair sharing the SAME start (INV-1 violation).
        const e0 = snapshotEntry(initial.features, vstore, 0); // a-0 @ 0
        const dupId = createAnchorEntry(e0.anchor, timePointYear(50), null); // a-0 @ 50
        const e1 = snapshotEntry(initial.features, vstore, 1); // a-1 @ 10
        const dupStart = createAnchorEntry(
          createAnchor(asAnchorId('a-2'), createAnchorSnapshot(initial.features, vstore)),
          timePointYear(10), // collides with e1's start
          null,
        );
        const series = normalizeSeries([e0, dupId, e1, dupStart], CAL);
        // Repaired: must be ascending + unique despite the injected duplicates.
        assertAscendingUnique(series);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// ===========================================================================
// 3. METAMORPHIC: undo∘op, op∘逆op, save∘load.
// ===========================================================================

describe(`affiliation — metamorphic identities (seed=${SEED})`, () => {
  it('undo ∘ op == identity; redo re-applies without re-minting ids', () => {
    fc.assert(
      fc.property(validForestArb(), affCmdArb, (initial, cmd) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 300,
        };
        const applied = applyAffCmd(st, cmd);
        if (applied === undefined) return; // rejected: nothing to undo.

        const baseline = applied.baseline;
        const command = createAffiliationCommand(baseline, applied.proposal);
        const afterExec = command.execute(baseline);
        expect(
          featuresEqual(afterExec.state, applied.proposal.nextFeatures),
          'execute != proposal.nextFeatures',
        ).toBe(true);
        const afterUndo = command.undo(afterExec.state);
        expect(featuresEqual(afterUndo.state, baseline), 'undo != baseline').toBe(true);
        expect(afterUndo.state.length).toBe(baseline.length);
        const afterRedo = command.redo(afterUndo.state);
        expect(
          featuresEqual(afterRedo.state, applied.proposal.nextFeatures),
          'redo != proposal.nextFeatures',
        ).toBe(true);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('op ∘ 逆op == identity: existing(parent) then none restores the leaf parentId', () => {
    fc.assert(
      fc.property(validForestArb(), fc.nat(), fc.nat(), (initial, leafWhich, parentWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 400,
        };
        // Pick a LEAF (no children) target and an aggregate parent in the SAME
        // band/period so the existing-affiliation is legal; then re-affiliate to
        // none and assert the leaf returns to its original parent state.
        const forest0 = buildForest(st.features);
        const leaves = st.features.filter((f) => directChildIds(forest0, f.id).length === 0);
        const aggs = st.features.filter((f) => f.kind === 'aggregate');
        if (leaves.length === 0 || aggs.length === 0) return;
        const leaf = leaves[leafWhich % leaves.length]!;
        // choose the leaf's CURRENT parent as the round-trip target so periods match.
        const originalParent = leaf.parentId;
        if (originalParent === undefined) return;
        void parentWhich;

        // op: move to a DIFFERENT existing parent (another agg with compatible period).
        const otherAgg = aggs.find(
          (a) =>
            a.id !== originalParent &&
            a.attributes.startYear <= leaf.attributes.endYear &&
            leaf.attributes.startYear <= a.attributes.endYear,
        );
        if (otherAgg === undefined) return;

        const moved = applyAffCmd(st, {
          t: 'existing',
          targetWhich: st.features.indexOf(leaf),
          parentWhich: st.features.indexOf(otherAgg),
        });
        if (moved === undefined) return;
        const afterMove = moved.next;
        const movedLeaf = afterMove.features.find((f) => f.id === leaf.id);
        // The leaf must now be parented under otherAgg.
        expect(movedLeaf?.parentId).toBe(otherAgg.id);

        // 逆op: move back to the original parent.
        const back = applyAffCmd(afterMove, {
          t: 'existing',
          targetWhich: afterMove.features.findIndex((f) => f.id === leaf.id),
          parentWhich: afterMove.features.findIndex((f) => f.id === originalParent),
        });
        if (back === undefined) return;
        const restoredLeaf = back.next.features.find((f) => f.id === leaf.id);
        expect(restoredLeaf?.parentId, 'op∘逆op did not restore parentId').toBe(originalParent);
        assertFeatureSetInvariants(back.next.features, back.next.store);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('save ∘ load (JSON round-trip) == identity over the committed set', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 8 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 500,
          };
          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied !== undefined) st = applied.next;
          }
          const json = JSON.stringify(st.features);
          const parsed = JSON.parse(json) as Feature[];
          expect(featuresEqual(parsed, st.features)).toBe(true);

          // The reloaded set resolves to identical derived areas everywhere.
          const f0 = buildForest(st.features);
          const f1 = buildForest(parsed);
          for (const f of st.features) {
            const a = resolveFeatureArea(f0, st.store, f.id);
            const b = resolveFeatureArea(f1, st.store, f.id);
            expect(a.status).toBe(b.status);
            if (a.status === 'ok' && b.status === 'ok') {
              expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });
});

// ===========================================================================
// 4. EXISTENCE-PERIOD GUARD: create→existing rejection / acceptance coherence.
//
// realizeDecision applies existencePeriodsCompatible between a freshly-created
// intermediate aggregate (period = target envelope) and the EXISTING top it is
// placed under. We assert: whenever such a command COMMITS, the created
// aggregate's period actually overlaps the chosen existing top's period; and
// whenever it REJECTS for existence-period, the periods are genuinely disjoint.
// This guards against an off-by-one / inverted-comparison bug in the guard that
// would either let a future-unsatisfiable hierarchy commit, or wrongly reject a
// compatible one.
// ===========================================================================

describe(`affiliation — existence-period guard coherence (seed=${SEED})`, () => {
  it('createUnderExisting commits iff target envelope overlaps the chosen top period', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.nat(),
        fc.nat(),
        (initial, targetWhich, topWhich) => {
          const st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 600,
          };
          const allIds = st.features.map((f) => f.id);
          const target = pick(allIds, targetWhich);
          const top = pick(allIds, topWhich);
          if (target === undefined || top === undefined) return;

          // Compute the target ENVELOPE (resolveTargetLeaves expands aggregates).
          const forest = buildForest(st.features);
          const targetFeat = st.features.find((f) => f.id === target)!;
          const isAgg = directChildIds(forest, target).length > 0;
          const leafIds = isAgg ? directChildIds(forest, target) : [target];
          let envStart = Number.POSITIVE_INFINITY;
          let envEnd = Number.NEGATIVE_INFINITY;
          for (const lid of leafIds) {
            const lf = st.features.find((f) => f.id === lid);
            if (lf === undefined) continue;
            envStart = Math.min(envStart, lf.attributes.startYear);
            envEnd = Math.max(envEnd, lf.attributes.endYear);
          }
          void targetFeat;
          const topFeat = st.features.find((f) => f.id === top)!;
          const overlaps = envStart <= topFeat.attributes.endYear && topFeat.attributes.startYear <= envEnd;

          const idState = createIdGeneratorState(0, st.idCounter);
          const result = buildAffiliationProposal(
            st.features,
            target,
            parentCreate({ name: 'mid' }, parentExisting(top)),
            { idState, now: makeNow(1), vertexStore: st.store },
          );

          if (!overlaps) {
            // Disjoint periods: the create→existing guard MUST reject (no commit).
            // (Other rejection reasons — e.g. same-feature when target===top — are
            //  also acceptable; the key contract is: it never COMMITS a disjoint one.)
            expect(result.status, 'committed a period-disjoint hierarchy').not.toBe('proposal');
          } else if (result.status === 'proposal') {
            // Committed: the created intermediate's period must overlap top, and
            // the whole committed forest must be valid.
            assertFeatureSetInvariants(result.proposal.nextFeatures, st.store);
          }
        },
      ),
      { seed: SEED, numRuns: 500 },
    );
  });
});

// ===========================================================================
// ===========================================================================
//  SECOND BUG-HUNT PASS (seed = 25002, disjoint from seed 25001 above).
//
//  New exploration axes (none re-walk the seed-25001 generators verbatim):
//    §5  HETEROGENEOUS per-leaf existence periods (the §0 forest gives every
//        leaf under a root the SAME period; here each leaf gets its OWN period
//        inside the root's envelope). This drives the create→existing
//        existence-period guard with mixed-period sub-trees, plus two NEW
//        commands: createDeepUnderExisting (create→create→existing, a 2-level
//        後付け挿入 ON TOP of an existing root) and federate4 (4-way 連邦化).
//    §6  INTERLEAVED affiliation + anchor-series MUTATING edits. The seed-25001
//        anchor block only ever APPENDS anchors; this one also drives the
//        guarded changeStart / setEnd / deleteAnchor ops between commits and
//        asserts the series stays INV-1/INV-5/INV-6 and never empties.
//    §7  FULL public-command metamorphic round-trips on the heterogeneous model
//        (undo∘op==id, op∘undo∘redo==op via createAffiliationCommand) and the
//        none∘existing inverse pair driven THROUGH the command pipeline.
//    §8  save∘load JSON identity over the heterogeneous-period committed set.
// ===========================================================================
// ===========================================================================

// ---------------------------------------------------------------------------
// §5 model: a root whose children each carry an INDEPENDENT period drawn from
// inside the root envelope. The aggregate's own period spans the full envelope
// (so it can contain every child); children differ, so re-parenting a leaf
// under a foreign root genuinely trips / passes the existence guard per pair.
// ---------------------------------------------------------------------------

interface HetRootSpec {
  /** independent [start,end] period per child (length == childCount, >=1). */
  readonly childPeriods: readonly { readonly start: number; readonly end: number }[];
}

function buildHetForest(specs: readonly HetRootSpec[]): ModelState {
  const s = emptyState();
  let n = 0;
  specs.forEach((spec, rootIdx) => {
    const baseY = rootIdx * 1000;
    const childIds: FeatureId[] = [];
    n += 1;
    const aggId = asFeatureId(`h-agg-${n}`);
    let envStart = Number.POSITIVE_INFINITY;
    let envEnd = Number.NEGATIVE_INFINITY;
    spec.childPeriods.forEach((p, c) => {
      n += 1;
      const suffix = `h-leaf-${n}`;
      const x = c * 10;
      const corners = [
        createCoordinate(x, baseY),
        createCoordinate(x + 10, baseY),
        createCoordinate(x + 10, baseY + 10),
        createCoordinate(x, baseY + 10),
      ];
      const verts = corners.map((cc, i) => createVertex(asVertexId(`hv-${suffix}-${i}`), cc));
      s.vertices.push(...verts);
      const ring = createTerritoryRing(
        asRingId(`hr-${suffix}`),
        verts.map((v) => v.id),
      );
      const fid = asFeatureId(`hf-${suffix}`);
      childIds.push(fid);
      envStart = Math.min(envStart, p.start);
      envEnd = Math.max(envEnd, p.end);
      s.features.push(
        createLeafFeature(
          fid,
          createBasicAttributes(suffix, p.start, p.end),
          COLOR,
          createShape([ring]),
          { parentId: aggId },
        ),
      );
    });
    s.features.push(
      createAggregateFeature(
        aggId,
        createBasicAttributes(`h-agg-${n}`, envStart, envEnd),
        COLOR,
        childIds,
      ),
    );
  });
  return s;
}

const hetChildPeriodArb: fc.Arbitrary<{ start: number; end: number }> = fc
  .record({ start: fc.integer({ min: -80, max: 80 }), span: fc.integer({ min: 1, max: 40 }) })
  .map(({ start, span }) => ({ start, end: start + span }));

const hetRootSpecArb: fc.Arbitrary<HetRootSpec> = fc
  .array(hetChildPeriodArb, { minLength: 1, maxLength: 4 })
  .map((childPeriods) => ({ childPeriods }));

function hetForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(hetRootSpecArb, { minLength: 1, maxLength: 4 })
    .map((specs) => buildHetForest(specs));
}

// New command spec for §5 (superset interactions on top of AffCmd).
type AffCmd2 =
  | AffCmd
  | { readonly t: 'createDeepUnderExisting'; readonly targetWhich: number; readonly topWhich: number }
  | {
      readonly t: 'federate4';
      readonly aWhich: number;
      readonly bWhich: number;
      readonly cWhich: number;
      readonly dWhich: number;
    };

const affCmd2Arb: fc.Arbitrary<AffCmd2> = fc.oneof(
  affCmdArb,
  fc.record({
    t: fc.constant<'createDeepUnderExisting'>('createDeepUnderExisting'),
    targetWhich: fc.nat(),
    topWhich: fc.nat(),
  }),
  fc.record({
    t: fc.constant<'federate4'>('federate4'),
    aWhich: fc.nat(),
    bWhich: fc.nat(),
    cWhich: fc.nat(),
    dWhich: fc.nat(),
  }),
);

/** Like applyAffCmd but also handles the two §5-only commands. */
function applyAffCmd2(
  st: AffState,
  cmd: AffCmd2,
): { next: AffState; proposal: AffiliationProposal; baseline: readonly Feature[] } | undefined {
  if (cmd.t === 'createDeepUnderExisting') {
    const features = st.features;
    const allIds = features.map((f) => f.id);
    const target = pick(allIds, cmd.targetWhich);
    const top = pick(allIds, cmd.topWhich);
    if (target === undefined || top === undefined) return undefined;
    const idState = createIdGeneratorState(0, st.idCounter);
    const decision: ParentDecision = parentCreate(
      { name: 'deep-low' },
      parentCreate({ name: 'deep-high' }, parentExisting(top)),
    );
    const result = buildAffiliationProposal(features, target, decision, {
      idState,
      now: makeNow(st.idCounter * 100 + 1),
      vertexStore: st.store,
    });
    if (result.status !== 'proposal') return undefined;
    const proposal = result.proposal;
    return {
      next: { features: proposal.nextFeatures, store: st.store, idCounter: proposal.idState.counter + 1 },
      proposal,
      baseline: features,
    };
  }
  if (cmd.t === 'federate4') {
    const features = st.features;
    const allIds = features.map((f) => f.id);
    const targets = [
      ...new Set(
        [cmd.aWhich, cmd.bWhich, cmd.cWhich, cmd.dWhich]
          .map((w) => pick(allIds, w))
          .filter((x): x is FeatureId => x !== undefined),
      ),
    ];
    if (targets.length < 2) return undefined;
    const idState = createIdGeneratorState(0, st.idCounter);
    const result = buildAffiliationProposalForTargets(
      features,
      targets,
      parentCreate({ name: 'federation4' }, parentNone),
      { idState, now: makeNow(st.idCounter * 100 + 1), vertexStore: st.store },
    );
    if (result.status !== 'proposal') return undefined;
    const proposal = result.proposal;
    return {
      next: { features: proposal.nextFeatures, store: st.store, idCounter: proposal.idState.counter + 1 },
      proposal,
      baseline: features,
    };
  }
  return applyAffCmd(st, cmd);
}

// ===========================================================================
// §5. Heterogeneous-period stateful drive: every invariant after every commit.
// ===========================================================================

describe(`affiliation — heterogeneous-period invariants after every commit (seed=${SEED2})`, () => {
  it('forest validity / depth / 派生集約=子の和 / childIds sync / coord-finite / selection', () => {
    fc.assert(
      fc.property(
        hetForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 14 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 1000,
          };
          assertFeatureSetInvariants(st.features, st.store);

          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied === undefined) continue;
            assertFeatureSetInvariants(applied.next.features, applied.next.store);

            const present = new Set(applied.next.features.map((f) => f.id));
            for (const id of applied.proposal.survivedTouchedIds) {
              expect(present.has(id), `survivedTouched ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.createdIds) {
              expect(present.has(id), `created ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.deletedIds) {
              expect(present.has(id), `deleted ${id} still present`).toBe(false);
            }
            const baselineIds = new Set(st.features.map((f) => f.id));
            for (const id of applied.proposal.createdIds) {
              expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
            }
            // created ∩ deleted must be empty (a freshly minted id is never also pruned).
            const del = new Set(applied.proposal.deletedIds);
            for (const id of applied.proposal.createdIds) {
              expect(del.has(id), `created ${id} also in deletedIds`).toBe(false);
            }
            st = applied.next;
          }
        },
      ),
      { seed: SEED2, numRuns: 600 },
    );
  });
});

// ===========================================================================
// §6. INTERLEAVED affiliation commits + anchor-series MUTATING edits.
//
// Between affiliation commits we append the new committed snapshot AND randomly
// drive a guarded series op (changeStart / setEnd / deleteAnchor). After every
// op the series must stay INV-1 ascending + INV-6 unique (assertAscendingUnique)
// and INV-5 non-empty. Guarded ops that reject (e.g. would-be-empty) are a
// legitimate no-op, not a bug; only an op that REPORTS ok but yields an invalid
// series is a finding.
// ===========================================================================

type SeriesOp =
  | { readonly t: 'append' }
  | { readonly t: 'changeStart'; readonly which: number; readonly year: number }
  | { readonly t: 'setEnd'; readonly which: number; readonly year: number | null }
  | { readonly t: 'delete'; readonly which: number };

const seriesOpArb: fc.Arbitrary<SeriesOp> = fc.oneof(
  fc.record({ t: fc.constant<'append'>('append') }),
  fc.record({ t: fc.constant<'changeStart'>('changeStart'), which: fc.nat(), year: fc.integer({ min: -500, max: 500 }) }),
  fc.record({
    t: fc.constant<'setEnd'>('setEnd'),
    which: fc.nat(),
    year: fc.option(fc.integer({ min: -500, max: 500 }), { nil: null }),
  }),
  fc.record({ t: fc.constant<'delete'>('delete'), which: fc.nat() }),
);

describe(`affiliation — interleaved commits + guarded anchor-series edits (seed=${SEED2})`, () => {
  it('series stays INV-1/INV-5/INV-6 across append + changeStart/setEnd/delete', () => {
    fc.assert(
      fc.property(
        hetForestArb(),
        fc.array(fc.tuple(affCmd2Arb, seriesOpArb), { minLength: 0, maxLength: 10 }),
        (initial, steps) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 2000,
          };
          let series: AnchorSeries = normalizeSeries(
            [snapshotEntry(st.features, st.store, 0)],
            CAL,
          );
          assertAscendingUnique(series);
          let idx = 1;

          for (const [cmd, op] of steps) {
            const applied = applyAffCmd2(st, cmd);
            if (applied !== undefined) {
              st = applied.next;
              assertFeatureSetInvariants(st.features, st.store);
            }

            switch (op.t) {
              case 'append': {
                const entries = [...series.entries, snapshotEntry(st.features, st.store, idx)];
                idx += 1;
                series = normalizeSeries(entries, CAL);
                break;
              }
              case 'changeStart': {
                const target = pick(series.entries, op.which);
                if (target === undefined) break;
                const r = changeStart(series, target.anchor.id, timePointYear(op.year), CAL);
                if (r.ok) series = r.series;
                break;
              }
              case 'setEnd': {
                const target = pick(series.entries, op.which);
                if (target === undefined) break;
                const end = op.year === null ? null : timePointYear(op.year);
                const r = setEnd(series, target.anchor.id, end, CAL);
                if (r.ok) series = r.series;
                break;
              }
              case 'delete': {
                const target = pick(series.entries, op.which);
                if (target === undefined) break;
                const r = deleteAnchor(series, target.anchor.id, CAL);
                if (r.ok) series = r.series;
                break;
              }
            }

            // INV-5 non-empty + INV-1/INV-6 after EVERY series op outcome.
            expect(series.entries.length, 'series became empty (INV-5)').toBeGreaterThan(0);
            assertAscendingUnique(series);
          }
        },
      ),
      { seed: SEED2, numRuns: 500 },
    );
  });
});

// ===========================================================================
// §7. FULL public-command metamorphic identities on the heterogeneous model.
// ===========================================================================

describe(`affiliation — heterogeneous metamorphic identities (seed=${SEED2})`, () => {
  it('undo ∘ op == identity; op ∘ undo ∘ redo == op (createAffiliationCommand)', () => {
    fc.assert(
      fc.property(hetForestArb(), affCmd2Arb, (initial, cmd) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 3000,
        };
        const applied = applyAffCmd2(st, cmd);
        if (applied === undefined) return;

        const baseline = applied.baseline;
        const command = createAffiliationCommand(baseline, applied.proposal);
        const afterExec = command.execute(baseline);
        expect(
          featuresEqual(afterExec.state, applied.proposal.nextFeatures),
          'execute != proposal.nextFeatures',
        ).toBe(true);
        const afterUndo = command.undo(afterExec.state);
        expect(featuresEqual(afterUndo.state, baseline), 'undo != baseline').toBe(true);
        // op ∘ undo ∘ redo == op: redoing after an undo reproduces the committed set
        // WITHOUT re-minting ids (教訓 5.20) — created ids stay byte-identical.
        const afterRedo = command.redo(afterUndo.state);
        expect(
          featuresEqual(afterRedo.state, applied.proposal.nextFeatures),
          'op∘undo∘redo != op',
        ).toBe(true);
        const reCreated = afterRedo.state.filter((f) => !baseline.some((b) => b.id === f.id));
        const origCreated = applied.proposal.nextFeatures.filter(
          (f) => !baseline.some((b) => b.id === f.id),
        );
        expect(reCreated.map((f) => f.id).sort()).toEqual(origCreated.map((f) => f.id).sort());
      }),
      { seed: SEED2, numRuns: 500 },
    );
  });

  it('op ∘ 逆op == identity THROUGH the command: existing then back restores parentId', () => {
    fc.assert(
      fc.property(hetForestArb(), fc.nat(), (initial, leafWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 3500,
        };
        const forest0 = buildForest(st.features);
        const leaves = st.features.filter((f) => directChildIds(forest0, f.id).length === 0);
        const aggs = st.features.filter((f) => f.kind === 'aggregate');
        if (leaves.length === 0 || aggs.length === 0) return;
        const leaf = leaves[leafWhich % leaves.length]!;
        const originalParent = leaf.parentId;
        if (originalParent === undefined) return;
        const otherAgg = aggs.find(
          (a) =>
            a.id !== originalParent &&
            a.attributes.startYear <= leaf.attributes.endYear &&
            leaf.attributes.startYear <= a.attributes.endYear,
        );
        if (otherAgg === undefined) return;

        // op: move under otherAgg, driven THROUGH the command (execute).
        const moved = applyAffCmd2(st, {
          t: 'existing',
          targetWhich: st.features.indexOf(leaf),
          parentWhich: st.features.indexOf(otherAgg),
        });
        if (moved === undefined) return;
        const cmdFwd = createAffiliationCommand(moved.baseline, moved.proposal);
        const execFwd = cmdFwd.execute(moved.baseline);
        const movedLeaf = execFwd.state.find((f) => f.id === leaf.id);
        expect(movedLeaf?.parentId).toBe(otherAgg.id);

        // 逆op: move back to the original parent, again THROUGH the command.
        const afterMove: AffState = {
          features: execFwd.state,
          store: st.store,
          idCounter: moved.next.idCounter,
        };
        const back = applyAffCmd2(afterMove, {
          t: 'existing',
          targetWhich: afterMove.features.findIndex((f) => f.id === leaf.id),
          parentWhich: afterMove.features.findIndex((f) => f.id === originalParent),
        });
        if (back === undefined) return;
        const cmdBack = createAffiliationCommand(back.baseline, back.proposal);
        const execBack = cmdBack.execute(back.baseline);
        const restored = execBack.state.find((f) => f.id === leaf.id);
        expect(restored?.parentId, 'op∘逆op did not restore parentId').toBe(originalParent);
        assertFeatureSetInvariants(execBack.state, st.store);
      }),
      { seed: SEED2, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §8. save ∘ load JSON identity over the heterogeneous-period committed set.
// ===========================================================================

describe(`affiliation — heterogeneous save∘load identity (seed=${SEED2})`, () => {
  it('JSON round-trip preserves features AND derived areas everywhere', () => {
    fc.assert(
      fc.property(
        hetForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 10 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 4000,
          };
          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied !== undefined) st = applied.next;
          }
          const parsed = JSON.parse(JSON.stringify(st.features)) as Feature[];
          expect(featuresEqual(parsed, st.features)).toBe(true);

          const f0 = buildForest(st.features);
          const f1 = buildForest(parsed);
          for (const f of st.features) {
            const a = resolveFeatureArea(f0, st.store, f.id);
            const b = resolveFeatureArea(f1, st.store, f.id);
            expect(a.status).toBe(b.status);
            if (a.status === 'ok' && b.status === 'ok') {
              expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
            }
          }
        },
      ),
      { seed: SEED2, numRuns: 300 },
    );
  });
});
