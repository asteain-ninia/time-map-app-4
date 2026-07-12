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
import {
  AFFILIATION_REJECT,
  allowedParentCandidates,
  isLegalNewParent,
} from '../affiliation/candidates';
import { createIdGeneratorState } from '../id-generator';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import {
  applyPastEdit,
  changeStart,
  createAnchorEntry,
  deleteAnchor,
  normalizeSeries,
  resolveAt,
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
// SECOND BUG-HUNT SESSION (this pass): a THIRD, deliberately-disjoint seed for
// §9..§12 below. These sections add NEW interactions never exercised by §1..§8:
//   §9  picker⇔confirm agreement (allowedParentCandidates vs the REAL commit /
//       isLegalNewParent single-source predicate, 教訓 5.26);
//   §10 resolveAt temporal-resolution coherence over committed-state snapshots
//       AND applyPastEdit insert/replace idempotence (neither resolveAt nor
//       applyPastEdit is touched anywhere in §1..§8);
//   §11 multi-target federate → de-federate(none each) inverse: a federation's
//       leaves all return to top-level (parentId undefined) and the federation
//       root auto-disappears (FR-35 sweep) — a 連邦化∘逆 round-trip §1..§8 omit;
//   §12 candidate-set ⊇ every committed `existing` target/parent pair: any pair
//       the picker would HIDE must never commit (no back-door illegal parent).
const SEED3 = 25003;
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

/**
 * FR-37: a committed affiliation may mint NEW vertices for an auto-generated 直轄領 末端地物
 * (when a 形状持ち末端 gains children). Merge them into the running store so the committed
 * state (including the direct domain) resolves; a plain reparent carries none (identity).
 */
function storeWithProposalVertices(
  base: VertexStore,
  proposal: AffiliationProposal,
): VertexStore {
  if (proposal.newVertices.length === 0) return base;
  return createVertexStore([...base.byId.values(), ...proposal.newVertices]);
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
    store: storeWithProposalVertices(st.store, proposal),
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
            assertFeatureSetInvariants(
              result.proposal.nextFeatures,
              storeWithProposalVertices(st.store, result.proposal),
            );
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
      next: {
        features: proposal.nextFeatures,
        store: storeWithProposalVertices(st.store, proposal),
        idCounter: proposal.idState.counter + 1,
      },
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
      next: {
        features: proposal.nextFeatures,
        store: storeWithProposalVertices(st.store, proposal),
        idCounter: proposal.idState.counter + 1,
      },
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
        // Carry the forward move's result store (moved.next.store), which already includes
        // any FR-37 直轄領 vertices minted forward, so the reverse resolves them.
        const afterMove: AffState = {
          features: execFwd.state,
          store: moved.next.store,
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
        assertFeatureSetInvariants(execBack.state, back.next.store);
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

// ===========================================================================
// ===========================================================================
//  THIRD BUG-HUNT SECTION (seed = 25003) — picker⇔confirm single-source,
//  temporal resolution, and the multi-target federate inverse.
//
//  None of §9..§12 re-walks the §1..§8 generators verbatim:
//    §9  drives the UI PICKER (allowedParentCandidates) and asserts it agrees
//        with the REAL commit pipeline for EVERY existing candidate — a listed
//        candidate must never be rejected by the candidate predicate at commit,
//        and a hidden one must never commit (教訓 5.26 single-source).
//    §10 drives resolveAt + applyPastEdit (untouched by §1..§8): resolveAt must
//        agree with the strictly-ascending series order, and applyPastEdit's
//        insert-then-resolve / replace-is-idempotent contracts must hold.
//    §11 a federate(create→NewTop) over N leaves, then de-federate every leaf to
//        `none`: all leaves return to top-level AND the federation root auto-
//        disappears (FR-35), a 連邦化∘逆 round-trip §1..§8 never close.
//    §12 a stronger picker⇔commit direction over the heterogeneous-period model.
// ===========================================================================
// ===========================================================================

// ---------------------------------------------------------------------------
// §9. PICKER ⇔ CONFIRM single-source (教訓 5.26).
//
// allowedParentCandidates(forest, target) is the SAME predicate
// (isLegalNewParent) the confirm-time guard funnels through. We assert the two
// never disagree on EXISTING features:
//   (a) every listed candidate, used as a real `existing` parent, never trips a
//       CANDIDATE-predicate rejection (same-feature / cycle / existence-period).
//       It MAY still fail post-commit hierarchy validation (a separate concern),
//       but the picker promised the *candidate predicate* passes — so the commit
//       must not come back with one of those three reasons.
//   (b) every NON-listed existing feature, used as a real `existing` parent,
//       is rejected (it can never silently commit through a back door).
// A disagreement in either direction is a single-source violation (a bug).
// ---------------------------------------------------------------------------

const CANDIDATE_REJECTS = new Set<string>([
  AFFILIATION_REJECT.SameFeature,
  AFFILIATION_REJECT.Cycle,
  AFFILIATION_REJECT.ExistencePeriod,
  // Codex fix 1: point/line parents are now a CANDIDATE-predicate reason too
  // (isLegalNewParent rejects them; the picker hides them via the same predicate).
  // The models here generate only leaf/aggregate features, so this never fires —
  // listed for set-faithfulness to the predicate.
  AFFILIATION_REJECT.ParentKind,
]);

describe(`affiliation — picker ⇔ confirm single-source (seed=${SEED3})`, () => {
  it('listed candidates never trip a candidate-predicate rejection; hidden ones never commit', () => {
    fc.assert(
      fc.property(validForestArb(), fc.nat(), (initial, targetWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 700,
        };
        const forest = buildForest(st.features);
        const allIds = st.features.map((f) => f.id);
        const target = pick(allIds, targetWhich);
        if (target === undefined) return;

        // resolveTargetLeaves expands an aggregate target to its leaves; the
        // picker is contracted on the target ID itself (its own candidate set),
        // so we compare against a LEAF target to keep the picker contract exact.
        const isAggTarget = directChildIds(forest, target).length > 0;
        if (isAggTarget) return; // picker is single-target; skip aggregate expansion.

        const candidates = allowedParentCandidates(forest, target);
        const listed = new Set(candidates.map((c) => c.featureId));

        for (const cand of st.features.map((f) => f.id)) {
          // The single-source predicate verdict (what the picker used).
          const verdict = isLegalNewParent(forest, target, cand);
          expect(listed.has(cand), `picker/predicate disagree for ${cand}`).toBe(verdict.ok);

          const idState = createIdGeneratorState(0, st.idCounter);
          const result = buildAffiliationProposal(
            st.features,
            target,
            parentExisting(cand),
            { idState, now: makeNow(1), vertexStore: st.store },
          );

          if (verdict.ok) {
            // (a) listed: must not be rejected for a CANDIDATE-predicate reason.
            if (result.status !== 'proposal') {
              expect(
                CANDIDATE_REJECTS.has(result.kind),
                `listed candidate ${cand} rejected by candidate predicate: ${result.kind}`,
              ).toBe(false);
            } else {
              assertFeatureSetInvariants(
              result.proposal.nextFeatures,
              storeWithProposalVertices(st.store, result.proposal),
            );
            }
          } else {
            // (b) hidden: must NOT commit (the back-door is closed).
            expect(
              result.status,
              `hidden candidate ${cand} committed (back-door)`,
            ).not.toBe('proposal');
          }
        }
      }),
      { seed: SEED3, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §10. TEMPORAL RESOLUTION: resolveAt order-coherence + applyPastEdit identity.
//
// resolveAt and applyPastEdit are NOT exercised by §1..§8. Here a parallel
// anchor series rides committed affiliation states, and we assert:
//   (a) resolveAt at each entry's OWN start returns that very entry (start is
//       inclusive; INV-1 ascending guarantees uniqueness) — unless the entry's
//       own bounded end makes it instantly absent, which our snapshots never set;
//   (b) resolveAt strictly BEFORE the first start is `absent` (existence not yet
//       begun);
//   (c) applyPastEdit at an EXISTING start REPLACES (count unchanged) and a
//       second identical applyPastEdit is idempotent in count;
//   (d) applyPastEdit at a NEW (later) start INSERTS exactly one anchor and the
//       new start resolves to the freshly-inserted anchor.
// ===========================================================================

describe(`affiliation — resolveAt coherence + applyPastEdit identity (seed=${SEED3})`, () => {
  it('resolveAt agrees with ascending order; applyPastEdit replace/insert behave', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 6 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 800,
          };
          const entries = [snapshotEntry(st.features, st.store, 0)];
          let idx = 1;
          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied === undefined) continue;
            st = applied.next;
            entries.push(snapshotEntry(st.features, st.store, idx));
            idx += 1;
          }
          const series = normalizeSeries(entries, CAL);
          assertAscendingUnique(series);

          // (a) each entry's own start resolves to that entry.
          for (const e of series.entries) {
            const r = resolveAt(series, e.start, CAL);
            expect(r.kind, `resolveAt absent at own start ${e.start.year}`).toBe('present');
            if (r.kind === 'present') {
              expect(r.entry.anchor.id, 'resolveAt returned wrong entry').toBe(e.anchor.id);
            }
          }

          // (b) before the first start: absent.
          const firstStart = series.entries[0]!.start.year;
          const before = resolveAt(series, timePointYear(firstStart - 1), CAL);
          expect(before.kind, 'resolveAt before first start not absent').toBe('absent');

          // (c) applyPastEdit at an EXISTING start: replace, count unchanged + idempotent.
          const targetEntry = series.entries[0]!;
          const replSnap = createAnchorSnapshot(st.features, st.store);
          const makeRepl = () => createAnchor(targetEntry.anchor.id, replSnap);
          const afterReplace = applyPastEdit(series, targetEntry.start, makeRepl, CAL);
          expect(afterReplace.entries.length, 'applyPastEdit replace changed count').toBe(
            series.entries.length,
          );
          assertAscendingUnique(afterReplace);
          const afterReplace2 = applyPastEdit(afterReplace, targetEntry.start, makeRepl, CAL);
          expect(afterReplace2.entries.length, 'applyPastEdit replace not idempotent').toBe(
            afterReplace.entries.length,
          );

          // (d) applyPastEdit at a NEW (strictly later) start: insert exactly one.
          const lastStart = series.entries[series.entries.length - 1]!.start.year;
          const newStart = timePointYear(lastStart + 100);
          const newAnchorId = asAnchorId(`a-new-${idx}`);
          const insSnap = createAnchorSnapshot(st.features, st.store);
          const afterInsert = applyPastEdit(
            series,
            newStart,
            () => createAnchor(newAnchorId, insSnap),
            CAL,
          );
          expect(afterInsert.entries.length, 'applyPastEdit insert did not add one').toBe(
            series.entries.length + 1,
          );
          assertAscendingUnique(afterInsert);
          const resolvedNew = resolveAt(afterInsert, newStart, CAL);
          expect(resolvedNew.kind).toBe('present');
          if (resolvedNew.kind === 'present') {
            expect(resolvedNew.entry.anchor.id, 'inserted anchor not effective at its start').toBe(
              newAnchorId,
            );
          }
        },
      ),
      { seed: SEED3, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §11. MULTI-TARGET FEDERATE ∘ DE-FEDERATE inverse (連邦化∘逆 round-trip).
//
// Federate >=2 existing top-level roots under a NEW common top (create→NewTop),
// then de-federate every original target back to `none`. After the round-trip:
//   - every original target is top-level again (parentId === undefined);
//   - the federation root auto-disappears once it loses all sub-regions (FR-35
//     sweep+prune); it must NOT linger as an empty aggregate;
//   - the surviving feature set is structurally valid throughout.
// §1..§8 federate but never de-federate, so this closes a NEW inverse pair.
// ===========================================================================

describe(`affiliation — federate ∘ de-federate inverse (seed=${SEED3})`, () => {
  it('federating N roots then de-federating each to none restores all to top-level', () => {
    fc.assert(
      fc.property(validForestArb(), fc.nat(), fc.nat(), (initial, aWhich, bWhich) => {
        let st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 900,
        };
        // Pick two DISTINCT top-level roots (aggregates) with compatible periods
        // so the federation's existence guard never rejects the setup.
        const roots = st.features.filter((f) => f.parentId === undefined);
        if (roots.length < 2) return;
        const a = roots[aWhich % roots.length]!;
        const bCandidates = roots.filter(
          (r) =>
            r.id !== a.id &&
            r.attributes.startYear <= a.attributes.endYear &&
            a.attributes.startYear <= r.attributes.endYear,
        );
        if (bCandidates.length === 0) return;
        const b = bCandidates[bWhich % bCandidates.length]!;

        // Remember the leaves under each root (federate expands aggregates to leaves).
        const forest0 = buildForest(st.features);
        const targetLeaves = [
          ...directChildIds(forest0, a.id),
          ...directChildIds(forest0, b.id),
        ];
        if (targetLeaves.length < 2) return;
        const originalParents = new Map(
          targetLeaves.map((id) => [id, st.features.find((f) => f.id === id)!.parentId] as const),
        );

        // op: federate a + b under a fresh NewTop.
        const fed = applyAffCmd(st, {
          t: 'federate',
          aWhich: st.features.indexOf(a),
          bWhich: st.features.indexOf(b),
          cWhich: st.features.indexOf(a), // dedup collapses to {a,b}.
        });
        if (fed === undefined) return;
        st = fed.next;
        assertFeatureSetInvariants(st.features, st.store);
        expect(fed.proposal.createdIds.length, 'federate minted no root').toBeGreaterThan(0);
        const fedRoot = fed.proposal.createdIds[fed.proposal.createdIds.length - 1]!;
        // Every original leaf now sits (transitively) under the federation root.
        for (const lid of targetLeaves) {
          const lf = st.features.find((f) => f.id === lid);
          expect(lf, `leaf ${lid} vanished after federate`).toBeDefined();
        }

        // 逆op: de-federate every original leaf back to `none` (top-level).
        for (const lid of targetLeaves) {
          const idx = st.features.findIndex((f) => f.id === lid);
          if (idx < 0) continue;
          const back = applyAffCmd(st, { t: 'none', targetWhich: idx });
          if (back === undefined) continue;
          st = back.next;
          assertFeatureSetInvariants(st.features, st.store);
        }

        // After the round-trip: every original leaf is top-level again.
        for (const lid of targetLeaves) {
          const lf = st.features.find((f) => f.id === lid);
          expect(lf, `leaf ${lid} missing after de-federate`).toBeDefined();
          expect(lf?.parentId, `leaf ${lid} still parented after de-federate`).toBe(undefined);
        }
        void originalParents;
        // The federation root must have auto-disappeared (it lost all sub-regions).
        const rootStillThere = st.features.some((f) => f.id === fedRoot);
        expect(rootStillThere, 'federation root lingered as empty aggregate').toBe(false);
      }),
      { seed: SEED3, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §12. PICKER ⊇ COMMIT over the heterogeneous-period model.
//
// On the het model (per-leaf independent periods), drive a real `existing`
// command for a random leaf/parent pair and assert: whenever it COMMITS, the
// chosen parent was a LISTED candidate (the picker would never have hidden a
// parent the commit accepts). A commit through a hidden parent is a back-door
// single-source violation distinct from §9 (different model + commit-first).
// ===========================================================================

describe(`affiliation — committed parent was always a listed candidate (seed=${SEED3})`, () => {
  it('het model: every committed existing-parent was a picker candidate', () => {
    fc.assert(
      fc.property(hetForestArb(), fc.nat(), fc.nat(), (initial, targetWhich, parentWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 5000,
        };
        const forest = buildForest(st.features);
        const allIds = st.features.map((f) => f.id);
        const target = pick(allIds, targetWhich);
        const parent = pick(allIds, parentWhich);
        if (target === undefined || parent === undefined) return;
        // Keep the picker contract exact: single-target (skip aggregate targets).
        if (directChildIds(forest, target).length > 0) return;

        const listed = new Set(
          allowedParentCandidates(forest, target).map((c) => c.featureId),
        );

        const idState = createIdGeneratorState(0, st.idCounter);
        const result = buildAffiliationProposal(
          st.features,
          target,
          parentExisting(parent),
          { idState, now: makeNow(1), vertexStore: st.store },
        );

        if (result.status === 'proposal') {
          expect(
            listed.has(parent),
            `committed existing-parent ${parent} was NOT a listed candidate (back-door)`,
          ).toBe(true);
          assertFeatureSetInvariants(
              result.proposal.nextFeatures,
              storeWithProposalVertices(st.store, result.proposal),
            );
        }
      }),
      { seed: SEED3, numRuns: 500 },
    );
  });
});

// ===========================================================================
// ===========================================================================
//  FOURTH BUG-HUNT SECTION (seed = 25004) — SECOND-PASS new exploration.
//
//  Every §1..§12 above either drives a SHALLOW forest (root aggregate → leaves)
//  or a heterogeneous-period SHALLOW forest. None of them ever:
//    - starts from a THREE-level pre-existing forest (grandparent aggregate →
//      sub-aggregates → leaves), so re-parenting an aggregate that ALREADY owns
//      descendants (subtree move) is never exercised;
//    - re-affiliates an INTERMEDIATE aggregate to `none` (de-nesting a whole
//      sub-tree to top-level) and checks the sub-tree travels intact;
//    - drives a WHOLE SEQUENCE of commands and then rewinds the ENTIRE undo
//      stack (undo ∘ undo ∘ … ∘ op ∘ op ∘ … == identity) — §3/§7 only ever undo
//      ONE op;
//    - attempts a deliberate CYCLE (re-parent an ancestor under its own
//      descendant) and asserts it is ALWAYS rejected (never commits a cycle).
//
//  §13 deep stateful drive: every invariant after every committed command on the
//      3-level model, PLUS subtree-integrity (an aggregate target's whole leaf
//      set re-parents coherently; childIds order is preserved through commits).
//  §14 full undo-stack rewind metamorphic over a command SEQUENCE.
//  §15 de-nest-to-top (`none` on an intermediate aggregate) round-trip: the
//      sub-tree's leaves stay under the (now top-level) intermediate, and a
//      following `existing` back under the grandparent restores the structure.
//  §16 cycle-attempt guard: re-parenting any feature under one of its OWN
//      descendants is rejected (AFFILIATION_REJECT.Cycle or never a proposal).
//  §17 save∘load JSON identity over the 3-level committed set (childIds order,
//      derived areas, depths all preserved).
// ===========================================================================
// ===========================================================================

const SEED4 = 25004;

// ---------------------------------------------------------------------------
// §13 model: a THREE-level forest. Each root is a grandparent aggregate whose
// children are sub-aggregates; each sub-aggregate owns `leafCount` gapless leaf
// strips. The whole sub-tree shares one period (so re-parenting within a band is
// legal), but each root band is spatially disjoint. This is the first model in
// the file with an aggregate that has aggregate children — the substrate for
// subtree-move and de-nest interactions.
// ---------------------------------------------------------------------------

interface DeepRootSpec {
  /** number of sub-aggregates under the grandparent (>= 1). */
  readonly subAggCount: number;
  /** leaves under EACH sub-aggregate (>= 1). */
  readonly leafCount: number;
  readonly start: number;
  readonly end: number;
}

function buildDeepForest(specs: readonly DeepRootSpec[]): ModelState {
  const s = emptyState();
  let n = 0;
  specs.forEach((spec, rootIdx) => {
    const baseY = rootIdx * 1000;
    n += 1;
    const grandId = asFeatureId(`d-grand-${n}`);
    const subIds: FeatureId[] = [];
    for (let sa = 0; sa < spec.subAggCount; sa += 1) {
      n += 1;
      const subId = asFeatureId(`d-sub-${n}`);
      subIds.push(subId);
      const leafIds: FeatureId[] = [];
      // each sub-aggregate occupies its own x-band so sub-aggregate footprints
      // are disjoint (gapless within, disjoint between) — keeps 派生集約=子の和
      // unambiguous at the grandparent.
      const subBaseX = sa * 1000;
      for (let c = 0; c < spec.leafCount; c += 1) {
        n += 1;
        const suffix = `d-leaf-${n}`;
        const x = subBaseX + c * 10;
        const corners = [
          createCoordinate(x, baseY),
          createCoordinate(x + 10, baseY),
          createCoordinate(x + 10, baseY + 10),
          createCoordinate(x, baseY + 10),
        ];
        const verts = corners.map((cc, i) => createVertex(asVertexId(`dv-${suffix}-${i}`), cc));
        s.vertices.push(...verts);
        const ring = createTerritoryRing(
          asRingId(`dr-${suffix}`),
          verts.map((v) => v.id),
        );
        const fid = asFeatureId(`df-${suffix}`);
        leafIds.push(fid);
        s.features.push(
          createLeafFeature(
            fid,
            createBasicAttributes(suffix, spec.start, spec.end),
            COLOR,
            createShape([ring]),
            { parentId: subId },
          ),
        );
      }
      s.features.push(
        createAggregateFeature(
          subId,
          createBasicAttributes(`d-sub-${n}`, spec.start, spec.end),
          COLOR,
          leafIds,
          { parentId: grandId },
        ),
      );
    }
    s.features.push(
      createAggregateFeature(
        grandId,
        createBasicAttributes(`d-grand-${n}`, spec.start, spec.end),
        COLOR,
        subIds,
      ),
    );
  });
  return s;
}

const deepRootSpecArb: fc.Arbitrary<DeepRootSpec> = fc
  .record({
    subAggCount: fc.integer({ min: 1, max: 3 }),
    leafCount: fc.integer({ min: 1, max: 3 }),
    start: fc.integer({ min: -40, max: 40 }),
    span: fc.integer({ min: 1, max: 50 }),
  })
  .map(({ subAggCount, leafCount, start, span }) => ({
    subAggCount,
    leafCount,
    start,
    end: start + span,
  }));

function deepForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(deepRootSpecArb, { minLength: 1, maxLength: 3 })
    .map((specs) => buildDeepForest(specs));
}

/** The full set of leaves transitively under `id` in `features`. */
function descendantLeaves(features: readonly Feature[], id: FeatureId): Set<FeatureId> {
  const forest = buildForest(features);
  const out = new Set<FeatureId>();
  const walk = (cur: FeatureId): void => {
    const kids = directChildIds(forest, cur);
    if (kids.length === 0) {
      out.add(cur);
      return;
    }
    for (const k of kids) walk(k);
  };
  walk(id);
  return out;
}

/** All transitive descendant ids (leaves AND intermediates) of `id`. */
function descendantIds(features: readonly Feature[], id: FeatureId): Set<FeatureId> {
  const forest = buildForest(features);
  const out = new Set<FeatureId>();
  const walk = (cur: FeatureId): void => {
    for (const k of directChildIds(forest, cur)) {
      out.add(k);
      walk(k);
    }
  };
  walk(id);
  return out;
}

// ===========================================================================
// §13. DEEP (3-level) stateful drive + subtree integrity.
// ===========================================================================

describe(`affiliation — deep 3-level invariants + subtree integrity (seed=${SEED4})`, () => {
  it('every invariant after every committed command; aggregate targets re-parent whole subtree', () => {
    fc.assert(
      fc.property(
        deepForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 12 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 6000,
          };
          assertFeatureSetInvariants(st.features, st.store);

          for (const cmd of cmds) {
            // Capture the would-be target's descendant leaves BEFORE the command so
            // we can assert subtree integrity after an aggregate-target re-parent.
            const allIds = st.features.map((f) => f.id);
            let targetLeavesBefore: Set<FeatureId> | undefined;
            let targetId: FeatureId | undefined;
            if (cmd.t === 'existing' || cmd.t === 'none') {
              targetId = pick(allIds, cmd.targetWhich);
              if (targetId !== undefined) {
                targetLeavesBefore = descendantLeaves(st.features, targetId);
              }
            }

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

            // Subtree integrity: when an aggregate target with leaves was
            // re-parented, EVERY leaf that was under it survives and is reachable
            // (FR-48 expands the aggregate to all its sub-regions; no leaf is
            // dropped or duplicated). They need not share a single parent (each
            // moved independently), but the full leaf SET is conserved.
            if (
              targetId !== undefined &&
              targetLeavesBefore !== undefined &&
              targetLeavesBefore.size > 0 &&
              // only meaningful when the target was a genuine aggregate (≥1 leaf
              // that is not itself the target).
              !(targetLeavesBefore.size === 1 && targetLeavesBefore.has(targetId))
            ) {
              for (const lid of targetLeavesBefore) {
                expect(
                  present.has(lid),
                  `subtree leaf ${lid} vanished after re-parenting aggregate ${targetId}`,
                ).toBe(true);
              }
            }

            st = applied.next;
          }
        },
      ),
      { seed: SEED4, numRuns: 500 },
    );
  });
});

// ===========================================================================
// §14. FULL UNDO-STACK REWIND: undo∘…∘op∘…  == identity over a SEQUENCE.
//
// §3/§7 undo exactly ONE op. Here we build a stack of committed commands, then
// pop them in reverse with command.undo and assert we land EXACTLY on the
// original baseline (every intermediate undo lands on its own pre-state too).
// This catches an undo that is individually-correct but not composable (e.g.
// baseline captured by reference and mutated, or id-state leakage across ops).
// ===========================================================================

interface StackFrame {
  readonly command: ReturnType<typeof createAffiliationCommand>;
  readonly preState: readonly Feature[];
  readonly postState: readonly Feature[];
}

describe(`affiliation — full undo-stack rewind == identity (seed=${SEED4})`, () => {
  it('a sequence of commands rewinds exactly to the original baseline', () => {
    fc.assert(
      fc.property(
        deepForestArb(),
        fc.array(affCmd2Arb, { minLength: 1, maxLength: 8 }),
        (initial, cmds) => {
          const original: readonly Feature[] = [...initial.features];
          let st: AffState = {
            features: original,
            store: store(initial),
            idCounter: 7000,
          };
          const stack: StackFrame[] = [];

          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied === undefined) continue;
            const preState = st.features;
            const command = createAffiliationCommand(preState, applied.proposal);
            const exec = command.execute(preState);
            // execute must reproduce the proposal's nextFeatures exactly.
            expect(
              featuresEqual(exec.state, applied.proposal.nextFeatures),
              'execute != proposal.nextFeatures',
            ).toBe(true);
            stack.push({ command, preState, postState: exec.state });
            st = { ...applied.next, features: exec.state };
          }

          if (stack.length === 0) return; // nothing committed: trivially identity.

          // Rewind: pop in reverse. Each undo must land on that frame's preState.
          let cur: readonly Feature[] = stack[stack.length - 1]!.postState;
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            const frame = stack[i]!;
            // The current state must equal this frame's postState before undo.
            expect(
              featuresEqual(cur, frame.postState),
              `pre-undo state drift at frame ${i}`,
            ).toBe(true);
            const undone = frame.command.undo(cur);
            expect(
              featuresEqual(undone.state, frame.preState),
              `undo at frame ${i} != its preState`,
            ).toBe(true);
            cur = undone.state;
          }

          // After rewinding the whole stack we are byte-identical to the original.
          expect(featuresEqual(cur, original), 'full rewind != original baseline').toBe(true);
          expect(cur.length).toBe(original.length);

          // And redoing the whole stack forward reproduces the final committed set
          // WITHOUT re-minting ids (教訓 5.20).
          const finalPost = stack[stack.length - 1]!.postState;
          let fwd: readonly Feature[] = cur;
          for (const frame of stack) {
            fwd = frame.command.redo(fwd).state;
          }
          expect(featuresEqual(fwd, finalPost), 'full redo != final committed set').toBe(true);
        },
      ),
      { seed: SEED4, numRuns: 500 },
    );
  });
});

// ===========================================================================
// §15. DE-NEST-TO-TOP: `none` on an INTERMEDIATE aggregate, then back.
//
// Take a sub-aggregate (has a grandparent AND owns leaves). Re-affiliate it to
// `none`. FR-48 expands the aggregate target to its leaves and applies the SAME
// decision (none) to each, so every leaf becomes top-level and the now-empty
// sub-aggregate AND (if it loses all children) the grandparent auto-disappear.
// Then re-affiliate one of those freed leaves back under the grandparent (if it
// survived) — the structure must stay valid throughout. The key contracts:
//   - after `none`, none of the freed leaves is parented under the OLD sub-agg;
//   - the old sub-aggregate (now child-less) does not linger as an empty agg;
//   - the committed forest is valid at every step (派生集約=子の和 included).
// ===========================================================================

describe(`affiliation — de-nest intermediate aggregate to top-level (seed=${SEED4})`, () => {
  it('none on a sub-aggregate frees its leaves to top-level and prunes the empty agg', () => {
    fc.assert(
      fc.property(deepForestArb(), fc.nat(), (initial, subWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 8000,
        };
        const forest0 = buildForest(st.features);
        // sub-aggregates: have a parent (grandparent) AND have children (leaves).
        const subAggs = st.features.filter(
          (f) =>
            f.parentId !== undefined &&
            f.kind === 'aggregate' &&
            directChildIds(forest0, f.id).length > 0,
        );
        if (subAggs.length === 0) return;
        const sub = subAggs[subWhich % subAggs.length]!;
        const freedLeaves = descendantLeaves(st.features, sub.id);
        if (freedLeaves.size === 0) return;

        const applied = applyAffCmd(st, {
          t: 'none',
          targetWhich: st.features.indexOf(sub),
        });
        if (applied === undefined) return; // a legitimate rejection (rare); skip.
        const next = applied.next;
        assertFeatureSetInvariants(next.features, next.store);

        // Every freed leaf survives and is now top-level (parentId undefined),
        // because `none` applied to each expanded leaf re-parents it to top.
        for (const lid of freedLeaves) {
          const lf = next.features.find((f) => f.id === lid);
          expect(lf, `freed leaf ${lid} vanished`).toBeDefined();
          expect(lf?.parentId, `freed leaf ${lid} not top-level after none`).toBe(undefined);
        }

        // The old sub-aggregate, having lost every child, must NOT linger as an
        // empty aggregate (FR-35 sweep+prune).
        const subStill = next.features.find((f) => f.id === sub.id);
        if (subStill !== undefined) {
          // If it somehow survives, it must still be a valid non-empty aggregate.
          const childIds = directChildIds(buildForest(next.features), sub.id);
          expect(
            childIds.length,
            `sub-aggregate ${sub.id} lingered empty after de-nest`,
          ).toBeGreaterThan(0);
        }
      }),
      { seed: SEED4, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §16. CYCLE-ATTEMPT GUARD: re-parenting a feature under its own descendant.
//
// For any feature X with at least one descendant D, an `existing` command that
// makes D the new parent of X would create a cycle. The guard (教訓 5.22 /
// isLegalNewParent) MUST reject this — it must never produce a proposal. We try
// EVERY (ancestor, descendant) pair and assert no commit; when it rejects with a
// machine-readable kind it must be the Cycle reason (or SameFeature when the
// expansion collapses), never a silent acceptance.
// ===========================================================================

describe(`affiliation — cycle attempts are always rejected (seed=${SEED4})`, () => {
  it('re-parenting a feature under any of its descendants never commits', () => {
    fc.assert(
      fc.property(deepForestArb(), fc.nat(), fc.nat(), (initial, xWhich, dWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 9000,
        };
        // Pick an ancestor X that actually has descendants.
        const withDesc = st.features.filter(
          (f) => descendantIds(st.features, f.id).size > 0,
        );
        if (withDesc.length === 0) return;
        const x = withDesc[xWhich % withDesc.length]!;
        const descs = [...descendantIds(st.features, x.id)];
        const d = descs[dWhich % descs.length]!;

        const idState = createIdGeneratorState(0, st.idCounter);
        const result = buildAffiliationProposal(
          st.features,
          x.id,
          parentExisting(d),
          { idState, now: makeNow(1), vertexStore: st.store },
        );

        // The cycle-forming command must NEVER commit.
        expect(
          result.status,
          `cycle commit: re-parented ${x.id} under its descendant ${d}`,
        ).not.toBe('proposal');

        // When X is a genuine aggregate, FR-48 expands X to its leaves and applies
        // the decision to EACH leaf. Making a leaf's own ancestor-side descendant
        // the parent can collapse to SameFeature; either way it must be one of the
        // candidate-predicate rejections, never anything that leaked through.
        if (result.status === 'rejected') {
          expect(
            [
              AFFILIATION_REJECT.Cycle,
              AFFILIATION_REJECT.SameFeature,
              AFFILIATION_REJECT.ExistencePeriod,
              AFFILIATION_REJECT.TargetKind,
              'hierarchy',
              'internal',
            ].includes(result.kind as never),
            `unexpected rejection kind for cycle attempt: ${result.kind}`,
          ).toBe(true);
        }
      }),
      { seed: SEED4, numRuns: 600 },
    );
  });
});

// ===========================================================================
// §17. save∘load JSON identity over the 3-level committed set.
//
// Distinct from §8 (shallow het model): here a 3-level model with nested
// aggregates is driven, then JSON round-tripped. childIds ORDER, derived areas,
// and derived DEPTHS must all survive the round-trip byte-for-byte / value-for-
// value. Nested aggregates exercise the round-trip of an aggregate whose own
// children are aggregates (the depth-2 case §8 cannot reach).
// ===========================================================================

describe(`affiliation — deep save∘load identity (childIds order + depths) (seed=${SEED4})`, () => {
  it('JSON round-trip preserves features, childIds order, derived areas AND depths', () => {
    fc.assert(
      fc.property(
        deepForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 10 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 10000,
          };
          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied !== undefined) st = applied.next;
          }
          const parsed = JSON.parse(JSON.stringify(st.features)) as Feature[];
          expect(featuresEqual(parsed, st.features)).toBe(true);

          const f0 = buildForest(st.features);
          const f1 = buildForest(parsed);
          const d0 = derivedDepths(f0);
          const d1 = derivedDepths(f1);
          for (const f of st.features) {
            // childIds order preserved for aggregates (featuresEqual checks set/
            // length; here we additionally pin ORDER explicitly).
            if (f.kind === 'aggregate') {
              const reF = parsed.find((g) => g.id === f.id);
              expect(reF?.kind).toBe('aggregate');
              if (reF?.kind === 'aggregate') {
                expect(reF.childIds, `childIds order drift on ${f.id}`).toEqual(f.childIds);
              }
            }
            // derived depth preserved.
            expect(d1.get(f.id), `depth drift on ${f.id}`).toBe(d0.get(f.id));
            // derived area preserved.
            const a = resolveFeatureArea(f0, st.store, f.id);
            const b = resolveFeatureArea(f1, st.store, f.id);
            expect(a.status).toBe(b.status);
            if (a.status === 'ok' && b.status === 'ok') {
              expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
            }
          }
        },
      ),
      { seed: SEED4, numRuns: 300 },
    );
  });
});

// ===========================================================================
// ===========================================================================
//  FIFTH BUG-HUNT SECTION (seed = 35002) — TRUE fast-check STATEFUL model.
//
//  Every §1..§17 above uses `fc.property` with a HAND-ROLLED command-array fold
//  (we `pick` indices, fold a loop, and assert inline). None of them uses the
//  fast-check STATEFUL machinery (`fc.commands` + `fc.modelRun`). This section
//  is a deliberately-disjoint NEW exploration (seed 35002, outside the prior
//  1000..6000 / 21000..26000 seed ranges) that drives the REAL 所属変更 pipeline
//  through fast-check's stateful command generator. The stateful generator
//  produces command SEQUENCES with fast-check's own length/shrinking strategy
//  (different distribution from `fc.array(affCmdArb)`), so it walks interaction
//  orderings the hand-rolled folds never reach, and shrinks counter-examples to
//  a minimal failing command list automatically.
//
//  The SUT (system under test) is the live affiliation state PLUS a parallel
//  anchor series (U09) that snapshots every committed state, so a SINGLE command
//  run checks the full invariant battery after EVERY committed command:
//    - リング交互性・非自己交差・包含妥当 / 階層森構造妥当 (validateHierarchy with
//      the vertexStore runs 形状=和・隙間なし, i.e. ring inclusion/union validity);
//    - 派生集約=子の和 (assertFeatureSetInvariants);
//    - 錨列の昇順・非重複 (assertAscendingUnique on the riding series);
//    - 座標に NaN/Infinity 無し (allCoordsFinite inside assertFeatureSetInvariants);
//    - 選択が常に有効 (survivedTouched/created resolve, deleted gone);
//    - save->load=恒等 (JSON round-trip equality, checked every Nth command).
//  Metamorphic identities are folded into the commands themselves:
//    - undo∘op==id and op∘undo∘redo==op are checked inside EVERY committed
//      ExistingCommand/NoneCommand/CreateCommand/FederateCommand `run`;
//    - op∘逆op==id is a dedicated stateful command (ReaffiliateRoundTrip).
//
//  Determinism: seed = 35002, numRuns large. PERMANENT ASSET — assertions encode
//  the SPEC; a counter-example is a finding, never a reason to weaken a check.
// ===========================================================================
// ===========================================================================

const SEED5 = 35002;

// ---------------------------------------------------------------------------
// §18 model: a VARIABLE-DEPTH, MIXED-PERIOD forest distinct from every prior
// generator. Some roots are flat (agg→leaves like §0), some are deep (grand→
// sub→leaves like §13), and per-root periods vary so the existence guard is
// genuinely exercised. This is the substrate the stateful commands mutate.
// ---------------------------------------------------------------------------

interface MixedRootSpec {
  readonly deep: boolean; // true => grand→sub→leaves; false => agg→leaves.
  readonly subCount: number; // sub-aggregates (deep) — ignored when flat.
  readonly leafCount: number; // leaves per (sub-)aggregate.
  readonly start: number;
  readonly end: number;
}

function buildMixedForest(specs: readonly MixedRootSpec[]): ModelState {
  const s = emptyState();
  let n = 0;
  const pushLeaf = (
    parentId: FeatureId,
    baseY: number,
    baseX: number,
    c: number,
    start: number,
    end: number,
  ): FeatureId => {
    n += 1;
    const suffix = `m-leaf-${n}`;
    const x = baseX + c * 10;
    const corners = [
      createCoordinate(x, baseY),
      createCoordinate(x + 10, baseY),
      createCoordinate(x + 10, baseY + 10),
      createCoordinate(x, baseY + 10),
    ];
    const verts = corners.map((cc, i) => createVertex(asVertexId(`mv-${suffix}-${i}`), cc));
    s.vertices.push(...verts);
    const ring = createTerritoryRing(asRingId(`mr-${suffix}`), verts.map((v) => v.id));
    const fid = asFeatureId(`mf-${suffix}`);
    s.features.push(
      createLeafFeature(
        fid,
        createBasicAttributes(suffix, start, end),
        COLOR,
        createShape([ring]),
        { parentId },
      ),
    );
    return fid;
  };

  specs.forEach((spec, rootIdx) => {
    const baseY = rootIdx * 1000;
    n += 1;
    const rootId = asFeatureId(`m-root-${n}`);
    if (!spec.deep) {
      const childIds: FeatureId[] = [];
      for (let c = 0; c < spec.leafCount; c += 1) {
        childIds.push(pushLeaf(rootId, baseY, 0, c, spec.start, spec.end));
      }
      s.features.push(
        createAggregateFeature(
          rootId,
          createBasicAttributes(`m-root-${n}`, spec.start, spec.end),
          COLOR,
          childIds,
        ),
      );
      return;
    }
    // deep: grand(rootId) -> sub-aggregates -> leaves.
    const subIds: FeatureId[] = [];
    for (let sa = 0; sa < spec.subCount; sa += 1) {
      n += 1;
      const subId = asFeatureId(`m-sub-${n}`);
      subIds.push(subId);
      const leafIds: FeatureId[] = [];
      for (let c = 0; c < spec.leafCount; c += 1) {
        leafIds.push(pushLeaf(subId, baseY, sa * 1000, c, spec.start, spec.end));
      }
      s.features.push(
        createAggregateFeature(
          subId,
          createBasicAttributes(`m-sub-${n}`, spec.start, spec.end),
          COLOR,
          leafIds,
          { parentId: rootId },
        ),
      );
    }
    s.features.push(
      createAggregateFeature(
        rootId,
        createBasicAttributes(`m-root-${n}`, spec.start, spec.end),
        COLOR,
        subIds,
      ),
    );
  });
  return s;
}

const mixedRootSpecArb: fc.Arbitrary<MixedRootSpec> = fc
  .record({
    deep: fc.boolean(),
    subCount: fc.integer({ min: 1, max: 3 }),
    leafCount: fc.integer({ min: 1, max: 3 }),
    start: fc.integer({ min: -60, max: 60 }),
    span: fc.integer({ min: 1, max: 45 }),
  })
  .map(({ deep, subCount, leafCount, start, span }) => ({
    deep,
    subCount,
    leafCount,
    start,
    end: start + span,
  }));

function mixedForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(mixedRootSpecArb, { minLength: 1, maxLength: 4 })
    .map((specs) => buildMixedForest(specs));
}

// ---------------------------------------------------------------------------
// §18 SUT: the live affiliation state + a parallel committed-snapshot series +
// a redo-able command journal. `model` is the lightweight fast-check model
// (feature count + an opaque tick); the SUT carries the heavy real state.
// ---------------------------------------------------------------------------

interface StatefulModel {
  /** ticks committed so far (for picker/index modulo determinism only). */
  commits: number;
}

class StatefulSut {
  state: AffState;
  series: AnchorSeries;
  private snapIdx = 1;
  /** committed commands count — used to throttle the (expensive) save∘load. */
  committed = 0;

  constructor(initial: ModelState) {
    this.state = {
      features: [...initial.features],
      store: store(initial),
      idCounter: 50000,
    };
    this.series = normalizeSeries([snapshotEntry(this.state.features, this.state.store, 0)], CAL);
  }

  /** Apply one real proposal-producing command, then check the full battery. */
  commitAndCheck(
    applied: { next: AffState; proposal: AffiliationProposal; baseline: readonly Feature[] } | undefined,
  ): void {
    if (applied === undefined) return; // rejected / N/A: legitimate, no state change.

    // (1) full forest/area/coord/childIds battery on the committed set.
    assertFeatureSetInvariants(applied.next.features, applied.next.store);

    // (2) 選択が常に有効: notified ids resolve, deleted gone, created fresh.
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
    const baselineIds = new Set(applied.baseline.map((f) => f.id));
    const del = new Set(applied.proposal.deletedIds);
    for (const id of applied.proposal.createdIds) {
      expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
      expect(del.has(id), `created ${id} also in deletedIds`).toBe(false);
    }

    // (3) METAMORPHIC undo∘op==id and op∘undo∘redo==op THROUGH the real command.
    const command = createAffiliationCommand(applied.baseline, applied.proposal);
    const exec = command.execute(applied.baseline);
    expect(
      featuresEqual(exec.state, applied.proposal.nextFeatures),
      'execute != proposal.nextFeatures',
    ).toBe(true);
    const undone = command.undo(exec.state);
    expect(featuresEqual(undone.state, applied.baseline), 'undo∘op != identity').toBe(true);
    const redone = command.redo(undone.state);
    expect(featuresEqual(redone.state, applied.proposal.nextFeatures), 'op∘undo∘redo != op').toBe(
      true,
    );
    // redo must not re-mint ids (教訓 5.20).
    const reCreated = redone.state
      .filter((f) => !baselineIds.has(f.id))
      .map((f) => f.id)
      .sort();
    const origCreated = [...applied.proposal.createdIds].sort();
    expect(reCreated).toEqual(origCreated);

    // commit the SUT state.
    this.state = applied.next;
    this.committed += 1;

    // (4) anchor列 昇順・非重複: append the new committed snapshot.
    const entries = [...this.series.entries, snapshotEntry(this.state.features, this.state.store, this.snapIdx)];
    this.snapIdx += 1;
    this.series = normalizeSeries(entries, CAL);
    assertAscendingUnique(this.series);
    expect(this.series.entries.length, 'series became empty (INV-5)').toBeGreaterThan(0);

    // (5) save∘load=恒等 every 3rd commit (full check is O(features); throttle).
    if (this.committed % 3 === 0) {
      const parsed = JSON.parse(JSON.stringify(this.state.features)) as Feature[];
      expect(featuresEqual(parsed, this.state.features), 'save∘load != identity').toBe(true);
      const f0 = buildForest(this.state.features);
      const f1 = buildForest(parsed);
      for (const f of this.state.features) {
        const a = resolveFeatureArea(f0, this.state.store, f.id);
        const b = resolveFeatureArea(f1, this.state.store, f.id);
        expect(a.status).toBe(b.status);
        if (a.status === 'ok' && b.status === 'ok') {
          expect(areasEqualWithinTolerance(a.area, b.area), 'save∘load area drift').toBe(true);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// §18 stateful Commands (fast-check `Command<StatefulModel, StatefulSut>`).
// Each `check` is permissive (the real pipeline decides legality at run time);
// `run` builds + applies the real proposal and runs the SUT battery. A `run`
// that did not commit (rejected) leaves both model and SUT unchanged.
// ---------------------------------------------------------------------------

type SCmd = fc.Command<StatefulModel, StatefulSut>;

class ExistingCmd implements SCmd {
  constructor(
    readonly targetWhich: number,
    readonly parentWhich: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel, s: StatefulSut): void {
    const applied = applyAffCmd(s.state, {
      t: 'existing',
      targetWhich: this.targetWhich,
      parentWhich: this.parentWhich,
    });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `existing(t=${this.targetWhich},p=${this.parentWhich})`;
  }
}

class NoneCmd implements SCmd {
  constructor(readonly targetWhich: number) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel, s: StatefulSut): void {
    const applied = applyAffCmd(s.state, { t: 'none', targetWhich: this.targetWhich });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `none(t=${this.targetWhich})`;
  }
}

class CreateUnderCmd implements SCmd {
  constructor(
    readonly targetWhich: number,
    readonly topWhich: number,
    readonly deep: boolean,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel, s: StatefulSut): void {
    const applied = applyAffCmd2(s.state, {
      t: this.deep ? 'createDeepUnderExisting' : 'createUnderExisting',
      targetWhich: this.targetWhich,
      topWhich: this.topWhich,
    });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `${this.deep ? 'createDeepUnder' : 'createUnder'}(t=${this.targetWhich},top=${this.topWhich})`;
  }
}

class CreateTopCmd implements SCmd {
  constructor(
    readonly targetWhich: number,
    readonly deep: boolean,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel, s: StatefulSut): void {
    const applied = applyAffCmd(s.state, {
      t: this.deep ? 'createDeep' : 'createNewTop',
      targetWhich: this.targetWhich,
    });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `${this.deep ? 'createDeep' : 'createTop'}(t=${this.targetWhich})`;
  }
}

class FederateCmd implements SCmd {
  constructor(
    readonly a: number,
    readonly b: number,
    readonly c: number,
    readonly d: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel, s: StatefulSut): void {
    const applied = applyAffCmd2(s.state, {
      t: 'federate4',
      aWhich: this.a,
      bWhich: this.b,
      cWhich: this.c,
      dWhich: this.d,
    });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `federate4(${this.a},${this.b},${this.c},${this.d})`;
  }
}

/**
 * op∘逆op==identity AS A STATEFUL COMMAND: pick a leaf with a current parent,
 * move it under a different compatible aggregate, then move it back, and assert
 * the parentId is restored — all against the LIVE SUT state mid-sequence (so the
 * round-trip is exercised on states the other commands have already mutated, a
 * stronger setting than §3/§7 which only round-trip the pristine initial forest).
 * On either leg failing to commit the command is a no-op (legitimate).
 */
class ReaffiliateRoundTripCmd implements SCmd {
  constructor(
    readonly leafWhich: number,
    readonly aggWhich: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(_m: StatefulModel, s: StatefulSut): void {
    const features = s.state.features;
    const forest = buildForest(features);
    const leaves = features.filter((f) => directChildIds(forest, f.id).length === 0);
    const aggs = features.filter((f) => f.kind === 'aggregate');
    if (leaves.length === 0 || aggs.length === 0) return;
    const leaf = leaves[this.leafWhich % leaves.length]!;
    const originalParent = leaf.parentId;
    if (originalParent === undefined) return;
    const compatible = aggs.filter(
      (a) =>
        a.id !== originalParent &&
        a.id !== leaf.id &&
        a.attributes.startYear <= leaf.attributes.endYear &&
        leaf.attributes.startYear <= a.attributes.endYear,
    );
    if (compatible.length === 0) return;
    const otherAgg = compatible[this.aggWhich % compatible.length]!;

    const moved = applyAffCmd(s.state, {
      t: 'existing',
      targetWhich: features.indexOf(leaf),
      parentWhich: features.indexOf(otherAgg),
    });
    if (moved === undefined) return;
    const movedLeaf = moved.next.features.find((f) => f.id === leaf.id);
    expect(movedLeaf?.parentId, 'op did not move leaf').toBe(otherAgg.id);
    s.commitAndCheck(moved); // commits the move + full battery.

    const back = applyAffCmd(s.state, {
      t: 'existing',
      targetWhich: s.state.features.findIndex((f) => f.id === leaf.id),
      parentWhich: s.state.features.findIndex((f) => f.id === originalParent),
    });
    if (back === undefined) {
      // Could not move back (e.g. original parent auto-disappeared when it lost
      // its last child). That is a legitimate FR-35 outcome, not a violation of
      // op∘逆op: the precondition (original parent still exists) no longer holds.
      const origStillThere = s.state.features.some((f) => f.id === originalParent);
      // If the original parent survived, moving back MUST have been possible.
      expect(
        origStillThere,
        'op∘逆op: back-move rejected though original parent still exists',
      ).toBe(false);
      return;
    }
    const restored = back.next.features.find((f) => f.id === leaf.id);
    expect(restored?.parentId, 'op∘逆op did not restore parentId').toBe(originalParent);
    s.commitAndCheck(back);
  }
  toString(): string {
    return `roundTrip(leaf=${this.leafWhich},agg=${this.aggWhich})`;
  }
}

const statefulCommandsArb: fc.Arbitrary<Iterable<SCmd>> = fc.commands(
  [
    fc.tuple(fc.nat(), fc.nat()).map(([t, p]) => new ExistingCmd(t, p)),
    fc.nat().map((t) => new NoneCmd(t)),
    fc.tuple(fc.nat(), fc.nat(), fc.boolean()).map(([t, top, d]) => new CreateUnderCmd(t, top, d)),
    fc.tuple(fc.nat(), fc.boolean()).map(([t, d]) => new CreateTopCmd(t, d)),
    fc
      .tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat())
      .map(([a, b, c, d]) => new FederateCmd(a, b, c, d)),
    fc.tuple(fc.nat(), fc.nat()).map(([l, a]) => new ReaffiliateRoundTripCmd(l, a)),
  ],
  { maxCommands: 16 },
);

describe(`affiliation — STATEFUL model: full invariant battery per command (seed=${SEED5})`, () => {
  it('fc.commands drives the real pipeline; every invariant + metamorphic id holds', () => {
    fc.assert(
      fc.property(mixedForestArb(), statefulCommandsArb, (initial, cmds) => {
        const setup: fc.ModelRunSetup<StatefulModel, StatefulSut> = () => ({
          model: { commits: 0 },
          real: new StatefulSut(initial),
        });
        fc.modelRun(setup, cmds);
      }),
      { seed: SEED5, numRuns: 700 },
    );
  });
});

// ===========================================================================
// ===========================================================================
//  SIXTH BUG-HUNT SECTION (seed = 35003) — SECOND fast-check STATEFUL model,
//  deliberately disjoint from the §18 stateful run (seed 35002) and from every
//  prior seed range (1000..6000 / 21000..26000 / 35002).
//
//  §18 is the FIRST stateful model, but its per-command checks omit FOUR things
//  this section adds, all evaluated on the LIVE, ALREADY-MUTATED mid-sequence
//  state (a strictly stronger setting than §9/§12/§16, which only ever probe the
//  PRISTINE initial forest):
//
//    (A) PICKER ⇔ COMMIT single-source on the LIVE state. After every committed
//        command we pick a random surviving leaf and assert, for EVERY existing
//        feature, that allowedParentCandidates / isLegalNewParent agree exactly
//        with what the REAL commit pipeline does for a candidate-predicate
//        reason (listed ⇒ never a SameFeature/Cycle/ExistencePeriod rejection;
//        hidden ⇒ never commits). §9/§12 only do this on the initial forest; a
//        single-source drift that only manifests AFTER auto-disappear / subtree
//        moves (教訓 5.26) would slip past §18.
//
//    (B) CYCLE-ATTEMPT guard on the LIVE state, as a stateful command: pick any
//        surviving feature X with descendants and try to parent X under one of
//        its OWN descendants. It must NEVER commit (§16 only tries this on the
//        pristine deep forest; here the ancestry graph has been reshaped by the
//        preceding commands).
//
//    (C) DE-NEST an INTERMEDIATE aggregate to `none` as a stateful command, with
//        the freed-leaf / empty-parent-prune contract enforced live mid-sequence
//        (§15 only de-nests on the pristine deep forest, never interleaved).
//
//    (D) A FULL UNDO-STACK REWIND at the END of every run: each committed command
//        is journaled, and at teardown we pop the entire stack with command.undo
//        and assert we land byte-identical on the ORIGINAL initial forest, then
//        redo the whole stack forward without re-minting ids. §18 checks undo∘op
//        for ONE op at a time but never rewinds the composed sequence; §14 does a
//        full rewind but NOT through the fast-check stateful generator's orderings.
//
//  Determinism: seed = 35003, numRuns large. PERMANENT ASSET — assertions encode
//  the SPEC; a counter-example is a finding, never a reason to weaken a check.
// ===========================================================================
// ===========================================================================

const SEED6 = 35003;

// ---------------------------------------------------------------------------
// §19 model: a NEW variable-shape forest distinct from mixedForestArb. Roots are
// flat OR deep (like §18) BUT periods are drawn from a WIDER, partly-disjoint
// spread so more re-parent attempts genuinely straddle the existence guard, and
// every root may independently start its period anywhere in a wide band. This is
// the substrate the §19 stateful commands mutate.
// ---------------------------------------------------------------------------

const wideRootSpecArb: fc.Arbitrary<MixedRootSpec> = fc
  .record({
    deep: fc.boolean(),
    subCount: fc.integer({ min: 1, max: 3 }),
    leafCount: fc.integer({ min: 1, max: 3 }),
    // Wider, more-disjoint period band than mixedRootSpecArb (-60..60 / span 1..45).
    start: fc.integer({ min: -200, max: 200 }),
    span: fc.integer({ min: 1, max: 30 }),
  })
  .map(({ deep, subCount, leafCount, start, span }) => ({
    deep,
    subCount,
    leafCount,
    start,
    end: start + span,
  }));

function wideForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(wideRootSpecArb, { minLength: 1, maxLength: 4 })
    .map((specs) => buildMixedForest(specs));
}

// ---------------------------------------------------------------------------
// §19 SUT: live affiliation state + parallel committed-snapshot series + a
// command JOURNAL (for the end-of-run full rewind, contract (D)). Each commit
// also runs the live picker⇔commit single-source probe (contract (A)).
// ---------------------------------------------------------------------------

interface StatefulModel6 {
  commits: number;
}

interface JournalFrame {
  readonly command: ReturnType<typeof createAffiliationCommand>;
  readonly preState: readonly Feature[];
  readonly postState: readonly Feature[];
  readonly createdIds: readonly FeatureId[];
}

class StatefulSut6 {
  state: AffState;
  series: AnchorSeries;
  private snapIdx = 1;
  committed = 0;
  /** the ORIGINAL initial forest — the rewind target (contract (D)). */
  readonly original: readonly Feature[];
  /** committed-command journal for the end-of-run full rewind. */
  readonly journal: JournalFrame[] = [];
  /** a deterministic counter to vary the live picker probe target per commit. */
  private probeTick = 0;

  constructor(initial: ModelState) {
    this.original = [...initial.features];
    this.state = {
      features: [...initial.features],
      store: store(initial),
      idCounter: 60000,
    };
    this.series = normalizeSeries([snapshotEntry(this.state.features, this.state.store, 0)], CAL);
  }

  /** Apply one real proposal, run the per-commit battery, journal it. */
  commitAndCheck(
    applied:
      | { next: AffState; proposal: AffiliationProposal; baseline: readonly Feature[] }
      | undefined,
  ): void {
    if (applied === undefined) return; // rejected / N/A: legitimate, no state change.

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
    const baselineIds = new Set(applied.baseline.map((f) => f.id));
    const del = new Set(applied.proposal.deletedIds);
    for (const id of applied.proposal.createdIds) {
      expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
      expect(del.has(id), `created ${id} also in deletedIds`).toBe(false);
    }

    // METAMORPHIC undo∘op==id and op∘undo∘redo==op THROUGH the real command +
    // journal the frame for the end-of-run full rewind (contract (D)).
    const command = createAffiliationCommand(applied.baseline, applied.proposal);
    const exec = command.execute(applied.baseline);
    expect(
      featuresEqual(exec.state, applied.proposal.nextFeatures),
      'execute != proposal.nextFeatures',
    ).toBe(true);
    const undone = command.undo(exec.state);
    expect(featuresEqual(undone.state, applied.baseline), 'undo∘op != identity').toBe(true);
    const redone = command.redo(undone.state);
    expect(featuresEqual(redone.state, applied.proposal.nextFeatures), 'op∘undo∘redo != op').toBe(
      true,
    );

    this.journal.push({
      command,
      preState: applied.baseline,
      postState: exec.state,
      createdIds: applied.proposal.createdIds,
    });

    this.state = applied.next;
    this.committed += 1;

    // anchor列 昇順・非重複: append the new committed snapshot.
    const entries = [
      ...this.series.entries,
      snapshotEntry(this.state.features, this.state.store, this.snapIdx),
    ];
    this.snapIdx += 1;
    this.series = normalizeSeries(entries, CAL);
    assertAscendingUnique(this.series);
    expect(this.series.entries.length, 'series became empty (INV-5)').toBeGreaterThan(0);

    // save∘load=恒等 every 3rd commit.
    if (this.committed % 3 === 0) {
      const parsed = JSON.parse(JSON.stringify(this.state.features)) as Feature[];
      expect(featuresEqual(parsed, this.state.features), 'save∘load != identity').toBe(true);
    }

    // (A) LIVE picker ⇔ commit single-source probe on the mutated state.
    this.probePickerCommitAgreement();
  }

  /**
   * Contract (A): on the LIVE committed state, pick one surviving LEAF target and
   * assert allowedParentCandidates / isLegalNewParent agree with the real commit
   * pipeline for every existing feature (教訓 5.26 single-source) — listed never
   * trips a candidate-predicate rejection; hidden never commits.
   */
  private probePickerCommitAgreement(): void {
    const features = this.state.features;
    const forest = buildForest(features);
    // single-target picker contract: probe a LEAF (no children) target only.
    const leaves = features.filter((f) => directChildIds(forest, f.id).length === 0);
    if (leaves.length === 0) return;
    this.probeTick += 1;
    const target = leaves[this.probeTick % leaves.length]!.id;

    const listed = new Set(allowedParentCandidates(forest, target).map((c) => c.featureId));

    for (const f of features) {
      const cand = f.id;
      const verdict = isLegalNewParent(forest, target, cand);
      expect(
        listed.has(cand),
        `LIVE picker/predicate disagree: target=${target} cand=${cand}`,
      ).toBe(verdict.ok);

      const idState = createIdGeneratorState(0, this.state.idCounter);
      const result = buildAffiliationProposal(features, target, parentExisting(cand), {
        idState,
        now: makeNow(1),
        vertexStore: this.state.store,
      });

      if (verdict.ok) {
        if (result.status !== 'proposal') {
          expect(
            CANDIDATE_REJECTS.has(result.kind),
            `LIVE listed candidate ${cand} rejected by candidate predicate: ${result.kind}`,
          ).toBe(false);
        }
      } else {
        expect(
          result.status,
          `LIVE hidden candidate ${cand} committed (back-door)`,
        ).not.toBe('proposal');
      }
    }
  }

  /**
   * Contract (D): pop the whole journal with command.undo; assert we land exactly
   * on the original initial forest, then redo forward without re-minting ids.
   */
  rewindAll(): void {
    if (this.journal.length === 0) {
      // nothing committed: SUT state must equal the original.
      expect(featuresEqual(this.state.features, this.original), 'no-op run drifted').toBe(true);
      return;
    }
    let cur: readonly Feature[] = this.journal[this.journal.length - 1]!.postState;
    for (let i = this.journal.length - 1; i >= 0; i -= 1) {
      const frame = this.journal[i]!;
      expect(featuresEqual(cur, frame.postState), `pre-undo drift at frame ${i}`).toBe(true);
      const undone = frame.command.undo(cur);
      expect(featuresEqual(undone.state, frame.preState), `undo at frame ${i} != preState`).toBe(
        true,
      );
      cur = undone.state;
    }
    expect(featuresEqual(cur, this.original), 'full rewind != original baseline').toBe(true);
    expect(cur.length).toBe(this.original.length);

    // redo the whole stack forward; the final state must match and ids stay put.
    const finalPost = this.journal[this.journal.length - 1]!.postState;
    let fwd: readonly Feature[] = cur;
    for (const frame of this.journal) {
      fwd = frame.command.redo(fwd).state;
    }
    expect(featuresEqual(fwd, finalPost), 'full redo != final committed set').toBe(true);
  }
}

type SCmd6 = fc.Command<StatefulModel6, StatefulSut6>;

class ExistingCmd6 implements SCmd6 {
  constructor(
    readonly targetWhich: number,
    readonly parentWhich: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel6, s: StatefulSut6): void {
    const applied = applyAffCmd(s.state, {
      t: 'existing',
      targetWhich: this.targetWhich,
      parentWhich: this.parentWhich,
    });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `existing(t=${this.targetWhich},p=${this.parentWhich})`;
  }
}

class NoneCmd6 implements SCmd6 {
  constructor(readonly targetWhich: number) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel6, s: StatefulSut6): void {
    const applied = applyAffCmd(s.state, { t: 'none', targetWhich: this.targetWhich });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `none(t=${this.targetWhich})`;
  }
}

class CreateUnderCmd6 implements SCmd6 {
  constructor(
    readonly targetWhich: number,
    readonly topWhich: number,
    readonly deep: boolean,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel6, s: StatefulSut6): void {
    const applied = applyAffCmd2(s.state, {
      t: this.deep ? 'createDeepUnderExisting' : 'createUnderExisting',
      targetWhich: this.targetWhich,
      topWhich: this.topWhich,
    });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `${this.deep ? 'createDeepUnder' : 'createUnder'}(t=${this.targetWhich},top=${this.topWhich})`;
  }
}

class FederateCmd6 implements SCmd6 {
  constructor(
    readonly a: number,
    readonly b: number,
    readonly c: number,
    readonly d: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel6, s: StatefulSut6): void {
    const applied = applyAffCmd2(s.state, {
      t: 'federate4',
      aWhich: this.a,
      bWhich: this.b,
      cWhich: this.c,
      dWhich: this.d,
    });
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `federate4(${this.a},${this.b},${this.c},${this.d})`;
  }
}

/**
 * Contract (C): de-nest an INTERMEDIATE aggregate (has a parent AND owns
 * children) to `none`, LIVE mid-sequence. The freed descendant leaves must all
 * survive and become top-level; the emptied intermediate must not linger as an
 * empty aggregate (FR-35). On a non-committing pick this is a no-op.
 */
class DenestSubtreeCmd6 implements SCmd6 {
  constructor(readonly subWhich: number) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel6, s: StatefulSut6): void {
    const features = s.state.features;
    const forest = buildForest(features);
    const subAggs = features.filter(
      (f) =>
        f.parentId !== undefined &&
        f.kind === 'aggregate' &&
        directChildIds(forest, f.id).length > 0,
    );
    if (subAggs.length === 0) return;
    const sub = subAggs[this.subWhich % subAggs.length]!;
    // resolveTargetLeaves expands an aggregate to its DIRECT children only
    // (直接の子のみ — proposal.ts resolveTargetLeaves), each of which receives the
    // SAME `none` decision => each becomes top-level. Transitive descendant leaves
    // deeper than the direct children stay under their own (now top-level) parent;
    // the contract is (i) every direct child becomes top-level, (ii) NO descendant
    // leaf vanishes (subtree integrity), (iii) the emptied target does not linger.
    const directChildrenBefore = [...directChildIds(forest, sub.id)];
    const descLeavesBefore = descendantLeaves(features, sub.id);
    if (directChildrenBefore.length === 0) return;

    const applied = applyAffCmd(s.state, {
      t: 'none',
      targetWhich: features.indexOf(sub),
    });
    if (applied === undefined) return; // legitimate rejection: no-op.
    s.commitAndCheck(applied);
    m.commits += 1;

    const next = applied.next.features;
    const present = new Set(next.map((f) => f.id));
    // (i) each DIRECT child of the de-nested aggregate is now top-level.
    for (const cid of directChildrenBefore) {
      expect(present.has(cid), `de-nest: direct child ${cid} vanished`).toBe(true);
      const cf = next.find((f) => f.id === cid);
      expect(cf?.parentId, `de-nest: direct child ${cid} not top-level`).toBe(undefined);
    }
    // (ii) subtree integrity: no transitive descendant leaf is dropped.
    for (const lid of descLeavesBefore) {
      expect(present.has(lid), `de-nest: descendant leaf ${lid} vanished`).toBe(true);
    }
    const subStill = next.find((f) => f.id === sub.id);
    if (subStill !== undefined) {
      const kids = directChildIds(buildForest(next), sub.id);
      expect(kids.length, `de-nest: intermediate ${sub.id} lingered empty`).toBeGreaterThan(0);
    }
  }
  toString(): string {
    return `denest(sub=${this.subWhich})`;
  }
}

/**
 * Contract (B): try to re-parent a feature X under one of its OWN descendants,
 * LIVE mid-sequence. This forms a cycle and MUST never commit; a machine-readable
 * rejection must be a candidate-predicate / hierarchy reason, never silent
 * acceptance. State is never mutated by this command (it asserts the rejection).
 */
class CycleAttemptCmd6 implements SCmd6 {
  constructor(
    readonly xWhich: number,
    readonly dWhich: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(_m: StatefulModel6, s: StatefulSut6): void {
    const features = s.state.features;
    // Local descendantIds takes (features, id) and returns a Set<FeatureId>.
    const withDesc = features.filter((f) => descendantIds(features, f.id).size > 0);
    if (withDesc.length === 0) return;
    const x = withDesc[this.xWhich % withDesc.length]!;
    const descs = [...descendantIds(features, x.id)];
    if (descs.length === 0) return;
    const d = descs[this.dWhich % descs.length]!;

    const idState = createIdGeneratorState(0, s.state.idCounter);
    const result = buildAffiliationProposal(features, x.id, parentExisting(d), {
      idState,
      now: makeNow(1),
      vertexStore: s.state.store,
    });

    expect(
      result.status,
      `LIVE cycle commit: re-parented ${x.id} under its descendant ${d}`,
    ).not.toBe('proposal');
    if (result.status === 'rejected') {
      expect(
        [
          AFFILIATION_REJECT.Cycle,
          AFFILIATION_REJECT.SameFeature,
          AFFILIATION_REJECT.ExistencePeriod,
          AFFILIATION_REJECT.TargetKind,
          'hierarchy',
          'internal',
        ].includes(result.kind as never),
        `unexpected rejection kind for LIVE cycle attempt: ${result.kind}`,
      ).toBe(true);
    }
    // X's ancestry is unchanged (no state mutation by a cycle attempt).
  }
  toString(): string {
    return `cycleAttempt(x=${this.xWhich},d=${this.dWhich})`;
  }
}

const statefulCommands6Arb: fc.Arbitrary<Iterable<SCmd6>> = fc.commands(
  [
    fc.tuple(fc.nat(), fc.nat()).map(([t, p]) => new ExistingCmd6(t, p)),
    fc.nat().map((t) => new NoneCmd6(t)),
    fc.tuple(fc.nat(), fc.nat(), fc.boolean()).map(([t, top, d]) => new CreateUnderCmd6(t, top, d)),
    fc
      .tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat())
      .map(([a, b, c, d]) => new FederateCmd6(a, b, c, d)),
    fc.nat().map((w) => new DenestSubtreeCmd6(w)),
    fc.tuple(fc.nat(), fc.nat()).map(([x, d]) => new CycleAttemptCmd6(x, d)),
  ],
  { maxCommands: 18 },
);

describe(`affiliation — STATEFUL model #2: live picker/cycle/de-nest + full rewind (seed=${SEED6})`, () => {
  it('fc.commands drives the real pipeline; live single-source + cycle guard + end-of-run rewind hold', () => {
    fc.assert(
      fc.property(wideForestArb(), statefulCommands6Arb, (initial, cmds) => {
        let sut: StatefulSut6 | undefined;
        const setup: fc.ModelRunSetup<StatefulModel6, StatefulSut6> = () => {
          const real = new StatefulSut6(initial);
          sut = real;
          return { model: { commits: 0 }, real };
        };
        fc.modelRun(setup, cmds);
        // Contract (D): full undo-stack rewind == identity over the whole sequence.
        sut?.rewindAll();
      }),
      { seed: SEED6, numRuns: 700 },
    );
  });
});

// ===========================================================================
// ===========================================================================
//  SEVENTH BUG-HUNT SECTION (seed = 35004) — THIRD fast-check STATEFUL model,
//  deliberately disjoint from §18 (35002) / §19 (35003) AND from every prior
//  seed range (1000..6000 / 21000..26000 / 35002 / 35003).
//
//  NEW exploration axis no prior section reaches: a LIVE, INTERLEAVED undo/redo
//  MANAGER plus LIVE guarded anchor-series MUTATING edits, both driven THROUGH
//  the fast-check stateful command stream and intermixed with real commits.
//
//  Why this is genuinely new (not a re-walk of §18/§19):
//    - §18 checks undo∘op==id and op∘undo∘redo==op for ONE op in isolation and
//      never keeps a live undo stack between commits;
//    - §19 journals every commit and rewinds the WHOLE stack only ONCE at
//      teardown (a pure linear rewind);
//    - NEITHER ever performs a PARTIAL undo, then a NEW commit on top of the
//      partially-undone state, then a redo. That sequence is exactly where a
//      real editor's undo/redo stack management breaks (教訓 5.11/5.20/5.23):
//        * a new commit after a partial undo must TRUNCATE the redo stack (the
//          redone-away future is unreachable) — a stale redo entry replayed onto
//          a divergent state would corrupt the forest or resurrect a pruned id;
//        * undo/redo must be byte-stable and id-stable across these transitions
//          (no re-mint, no drift) even when the live state was reshaped by
//          auto-disappear (FR-35) between the undo and the next commit.
//    - The anchor series here is not append-only (§18/§19 only append committed
//      snapshots): it also rides LIVE guarded changeStart/setEnd/deleteAnchor
//      ops INSIDE the stateful stream and must hold INV-1/INV-5/INV-6 after
//      every outcome, including across affiliation undo/redo transitions.
//
//  The §20 SUT maintains a genuine UNDO STACK and REDO STACK. Stateful commands:
//    AffiliationStep   — build+apply a real proposal; push onto undo stack;
//                        TRUNCATE the redo stack (new edit invalidates futures);
//                        run the full per-commit invariant battery; append a
//                        committed-state anchor snapshot.
//    UndoStep          — pop the undo stack, apply command.undo to the LIVE state,
//                        assert it lands on that frame's recorded preState, push
//                        the frame onto the redo stack; re-validate the forest.
//    RedoStep          — pop the redo stack, apply command.redo, assert it lands
//                        on that frame's recorded postState WITHOUT re-minting
//                        ids, push back onto the undo stack; re-validate.
//    SeriesEditStep    — a guarded changeStart/setEnd/deleteAnchor on the live
//                        riding series; INV-1/INV-5/INV-6 must hold after.
//
//  Invariants asserted (every committed/undone/redone state): 階層森構造妥当 /
//  派生集約=子の和 / 座標 finite / 選択が常に有効 / リング交互性・包含妥当
//  (validateHierarchy 形状=和) / 錨列 昇順・非重複 / save->load=恒等 (throttled).
//  Metamorphic: undo∘op==id, op∘undo∘redo==op, AND the redo-stack-truncation
//  law (no stale future is ever replayed). Determinism: seed 35004, numRuns
//  large. PERMANENT ASSET — a counter-example is a finding, never a reason to
//  weaken a check.
// ===========================================================================
// ===========================================================================

const SEED7 = 35004;

// ---------------------------------------------------------------------------
// §20 model: a NEW asymmetric forest generator. Each root independently chooses
// flat-vs-deep (reusing buildMixedForest) BUT periods are drawn from a narrow,
// HEAVILY-OVERLAPPING band so MOST re-parent attempts are legal (the existence
// guard rarely vetoes). Dense legality maximises the number of commits that
// actually land — which is what stresses the undo/redo STACK interactions this
// section targets (more frames => deeper partial-undo-then-new-commit chains).
// This distribution is disjoint from mixedForestArb (−60..60) and wideForestArb
// (−200..200, sparse): here −10..10 with span 20..50 => near-total overlap.
// ---------------------------------------------------------------------------

const denseRootSpecArb: fc.Arbitrary<MixedRootSpec> = fc
  .record({
    deep: fc.boolean(),
    subCount: fc.integer({ min: 1, max: 3 }),
    leafCount: fc.integer({ min: 1, max: 3 }),
    start: fc.integer({ min: -10, max: 10 }),
    span: fc.integer({ min: 20, max: 50 }),
  })
  .map(({ deep, subCount, leafCount, start, span }) => ({
    deep,
    subCount,
    leafCount,
    start,
    end: start + span,
  }));

function denseForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(denseRootSpecArb, { minLength: 1, maxLength: 4 })
    .map((specs) => buildMixedForest(specs));
}

// ---------------------------------------------------------------------------
// §20 SUT: live affiliation state + a genuine undo/redo stack + a live riding
// anchor series (append on commit, mutate on SeriesEditStep). idCounter is the
// SINGLE source of fresh ids; it only ever advances on a real commit (undo/redo
// replay the recorded proposal and never re-mint, 教訓 5.20).
// ---------------------------------------------------------------------------

interface StatefulModel7 {
  commits: number;
}

interface UndoFrame7 {
  readonly command: ReturnType<typeof createAffiliationCommand>;
  readonly preState: readonly Feature[];
  readonly postState: readonly Feature[];
  readonly createdIds: readonly FeatureId[];
  /** the idCounter value AFTER this commit (so undo/redo restore it exactly). */
  readonly idCounterAfter: number;
}

class StatefulSut7 {
  state: AffState;
  series: AnchorSeries;
  private snapIdx = 1;
  committed = 0;
  readonly original: readonly Feature[];
  /** live undo stack (most-recent on top). */
  readonly undoStack: UndoFrame7[] = [];
  /** live redo stack (most-recently-undone on top). */
  readonly redoStack: UndoFrame7[] = [];

  constructor(initial: ModelState) {
    this.original = [...initial.features];
    this.state = {
      features: [...initial.features],
      store: store(initial),
      idCounter: 70000,
    };
    this.series = normalizeSeries(
      [snapshotEntry(this.state.features, this.state.store, 0)],
      CAL,
    );
  }

  /** Shared per-state battery (forest/area/coord/childIds/series/save-load). */
  private checkState(features: readonly Feature[], vstore: VertexStore): void {
    assertFeatureSetInvariants(features, vstore);
    assertAscendingUnique(this.series);
    expect(this.series.entries.length, 'series empty (INV-5)').toBeGreaterThan(0);
  }

  /** AffiliationStep: build+apply a real proposal, push undo, TRUNCATE redo. */
  commitAndCheck(
    applied:
      | { next: AffState; proposal: AffiliationProposal; baseline: readonly Feature[] }
      | undefined,
  ): void {
    if (applied === undefined) return; // rejected / N/A: legitimate no-op.

    // (1) full forest/area/coord/childIds battery on the committed set.
    assertFeatureSetInvariants(applied.next.features, applied.next.store);

    // (2) 選択が常に有効 + created/deleted disjointness.
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
    const baselineIds = new Set(applied.baseline.map((f) => f.id));
    const del = new Set(applied.proposal.deletedIds);
    for (const id of applied.proposal.createdIds) {
      expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
      expect(del.has(id), `created ${id} also in deletedIds`).toBe(false);
    }

    // (3) METAMORPHIC undo∘op==id and op∘undo∘redo==op THROUGH the real command.
    const command = createAffiliationCommand(applied.baseline, applied.proposal);
    const exec = command.execute(applied.baseline);
    expect(
      featuresEqual(exec.state, applied.proposal.nextFeatures),
      'execute != proposal.nextFeatures',
    ).toBe(true);
    const undone = command.undo(exec.state);
    expect(featuresEqual(undone.state, applied.baseline), 'undo∘op != identity').toBe(true);
    const redone = command.redo(undone.state);
    expect(
      featuresEqual(redone.state, applied.proposal.nextFeatures),
      'op∘undo∘redo != op',
    ).toBe(true);
    const reCreated = redone.state
      .filter((f) => !baselineIds.has(f.id))
      .map((f) => f.id)
      .sort();
    expect(reCreated).toEqual([...applied.proposal.createdIds].sort());

    // Commit the live state. Push the frame; TRUNCATE the redo stack: a NEW edit
    // after any undo makes the redone-away future unreachable (教訓 5.11). A stale
    // redo entry must never be replayable onto this divergent timeline.
    this.undoStack.push({
      command,
      preState: applied.baseline,
      postState: exec.state,
      createdIds: applied.proposal.createdIds,
      idCounterAfter: applied.next.idCounter,
    });
    this.redoStack.length = 0; // redo-stack-truncation law.

    this.state = applied.next;
    this.committed += 1;

    // (4) anchor列 昇順・非重複: append the new committed snapshot.
    this.series = normalizeSeries(
      [...this.series.entries, snapshotEntry(this.state.features, this.state.store, this.snapIdx)],
      CAL,
    );
    this.snapIdx += 1;
    this.checkState(this.state.features, this.state.store);

    // (5) save∘load=恒等 every 3rd commit.
    if (this.committed % 3 === 0) {
      const parsed = JSON.parse(JSON.stringify(this.state.features)) as Feature[];
      expect(featuresEqual(parsed, this.state.features), 'save∘load != identity').toBe(true);
      const f0 = buildForest(this.state.features);
      const f1 = buildForest(parsed);
      for (const f of this.state.features) {
        const a = resolveFeatureArea(f0, this.state.store, f.id);
        const b = resolveFeatureArea(f1, this.state.store, f.id);
        expect(a.status).toBe(b.status);
        if (a.status === 'ok' && b.status === 'ok') {
          expect(areasEqualWithinTolerance(a.area, b.area), 'save∘load area drift').toBe(true);
        }
      }
    }
  }

  /** UndoStep: pop undo stack, apply command.undo to the LIVE state. */
  doUndo(): void {
    const frame = this.undoStack.pop();
    if (frame === undefined) return; // empty undo stack: legitimate no-op.
    // The LIVE state must currently equal this frame's postState (it is the top
    // of the timeline). If not, an earlier commit corrupted the stack ordering.
    expect(
      featuresEqual(this.state.features, frame.postState),
      'undo: live state != top-frame postState',
    ).toBe(true);
    const undone = frame.command.undo(this.state.features);
    expect(
      featuresEqual(undone.state, frame.preState),
      'undo: result != frame.preState',
    ).toBe(true);
    // Restore the live state AND the idCounter to the pre-commit value (undo must
    // not leave id-state ahead, else a later commit could collide, 教訓 5.20).
    const prevIdCounter =
      this.undoStack.length === 0
        ? 70000
        : this.undoStack[this.undoStack.length - 1]!.idCounterAfter;
    this.state = { features: undone.state, store: this.state.store, idCounter: prevIdCounter };
    this.redoStack.push(frame);
    // The undone forest must itself be fully valid (FR-35 集約復活 included).
    this.checkState(this.state.features, this.state.store);
  }

  /** RedoStep: pop redo stack, apply command.redo, assert id-stable. */
  doRedo(): void {
    const frame = this.redoStack.pop();
    if (frame === undefined) return; // empty redo stack: legitimate no-op.
    expect(
      featuresEqual(this.state.features, frame.preState),
      'redo: live state != frame.preState',
    ).toBe(true);
    const redone = frame.command.redo(this.state.features);
    expect(
      featuresEqual(redone.state, frame.postState),
      'redo: result != frame.postState',
    ).toBe(true);
    // redo must not re-mint ids: the created set on the redone state matches the
    // frame's recorded createdIds exactly (教訓 5.20).
    const preIds = new Set(frame.preState.map((f) => f.id));
    const reCreated = redone.state
      .filter((f) => !preIds.has(f.id))
      .map((f) => f.id)
      .sort();
    expect(reCreated, 'redo re-minted / dropped created ids').toEqual(
      [...frame.createdIds].sort(),
    );
    this.state = {
      features: redone.state,
      store: this.state.store,
      idCounter: frame.idCounterAfter,
    };
    this.undoStack.push(frame);
    this.checkState(this.state.features, this.state.store);
  }

  /** SeriesEditStep: a guarded live series mutation; INV-1/INV-5/INV-6 after. */
  editSeries(op: SeriesOp): void {
    switch (op.t) {
      case 'append': {
        this.series = normalizeSeries(
          [...this.series.entries, snapshotEntry(this.state.features, this.state.store, this.snapIdx)],
          CAL,
        );
        this.snapIdx += 1;
        break;
      }
      case 'changeStart': {
        const target = pick(this.series.entries, op.which);
        if (target !== undefined) {
          const r = changeStart(this.series, target.anchor.id, timePointYear(op.year), CAL);
          if (r.ok) this.series = r.series;
        }
        break;
      }
      case 'setEnd': {
        const target = pick(this.series.entries, op.which);
        if (target !== undefined) {
          const end = op.year === null ? null : timePointYear(op.year);
          const r = setEnd(this.series, target.anchor.id, end, CAL);
          if (r.ok) this.series = r.series;
        }
        break;
      }
      case 'delete': {
        const target = pick(this.series.entries, op.which);
        if (target !== undefined) {
          const r = deleteAnchor(this.series, target.anchor.id, CAL);
          if (r.ok) this.series = r.series;
        }
        break;
      }
    }
    expect(this.series.entries.length, 'series empty after edit (INV-5)').toBeGreaterThan(0);
    assertAscendingUnique(this.series);
  }

  /** End-of-run: the live state must be reconstructible by replaying the undo
   *  stack forward from the original baseline (timeline consistency). */
  verifyTimeline(): void {
    let cur: readonly Feature[] = this.original;
    for (const frame of this.undoStack) {
      expect(
        featuresEqual(cur, frame.preState),
        'timeline: frame.preState != replayed state',
      ).toBe(true);
      cur = frame.command.redo(cur).state;
      expect(featuresEqual(cur, frame.postState), 'timeline: redo != frame.postState').toBe(true);
    }
    expect(
      featuresEqual(cur, this.state.features),
      'timeline replay != live committed state',
    ).toBe(true);
  }
}

type SCmd7 = fc.Command<StatefulModel7, StatefulSut7>;

class AffiliationStep7 implements SCmd7 {
  constructor(
    readonly cmd: AffCmd2,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel7, s: StatefulSut7): void {
    const applied = applyAffCmd2(s.state, this.cmd);
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `aff(${JSON.stringify(this.cmd)})`;
  }
}

class UndoStep7 implements SCmd7 {
  check(): boolean {
    return true;
  }
  run(_m: StatefulModel7, s: StatefulSut7): void {
    s.doUndo();
  }
  toString(): string {
    return 'undo';
  }
}

class RedoStep7 implements SCmd7 {
  check(): boolean {
    return true;
  }
  run(_m: StatefulModel7, s: StatefulSut7): void {
    s.doRedo();
  }
  toString(): string {
    return 'redo';
  }
}

class SeriesEditStep7 implements SCmd7 {
  constructor(readonly op: SeriesOp) {}
  check(): boolean {
    return true;
  }
  run(_m: StatefulModel7, s: StatefulSut7): void {
    s.editSeries(this.op);
  }
  toString(): string {
    return `series(${this.op.t})`;
  }
}

const statefulCommands7Arb: fc.Arbitrary<Iterable<SCmd7>> = fc.commands(
  [
    affCmd2Arb.map((c) => new AffiliationStep7(c)),
    // bias toward undo/redo so partial-undo-then-new-commit chains form often.
    fc.constant(new UndoStep7()),
    fc.constant(new UndoStep7()),
    fc.constant(new RedoStep7()),
    fc.constant(new RedoStep7()),
    seriesOpArb.map((op) => new SeriesEditStep7(op)),
  ],
  { maxCommands: 22 },
);

describe(`affiliation — STATEFUL model #3: live undo/redo stack + series edits (seed=${SEED7})`, () => {
  it('fc.commands interleaves commit/undo/redo/series; stacks stay consistent + redo truncated', () => {
    fc.assert(
      fc.property(denseForestArb(), statefulCommands7Arb, (initial, cmds) => {
        let sut: StatefulSut7 | undefined;
        const setup: fc.ModelRunSetup<StatefulModel7, StatefulSut7> = () => {
          const real = new StatefulSut7(initial);
          sut = real;
          return { model: { commits: 0 }, real };
        };
        fc.modelRun(setup, cmds);
        // End-of-run: the live state is exactly the forward replay of the undo
        // stack from the original baseline (no stale-redo corruption ever leaked).
        sut?.verifyTimeline();
      }),
      { seed: SEED7, numRuns: 700 },
    );
  });
});

// ===========================================================================
// ===========================================================================
//  EIGHTH BUG-HUNT SECTION (seed = 45001) — FOURTH fast-check STATEFUL model,
//  a NEW exploration deliberately disjoint from the §18 (35002) / §19 (35003) /
//  §20 (35004) stateful runs AND from every prior seed range used in this repo's
//  affiliation bug-hunts (1000..6000 / 21000..26000 / 31000..36000). seed=45001
//  sits in a fresh band so its fast-check command stream + initial-forest draws
//  walk interaction orderings none of the earlier runs reached.
//
//  WHY THIS IS GENUINELY NEW (not a re-walk of §18/§19/§20):
//    All three prior stateful SUTs keep the parallel anchor series as an
//    APPEND-or-guarded-MUTATE history but NONE of them ever:
//      (i)  drives the TEMPORAL-RESOLUTION reader (`resolveAt`) on the LIVE
//           riding series after every committed affiliation command and asserts
//           it stays coherent with the strictly-ascending order (each entry's own
//           start resolves to that entry; strictly-before-first is absent) WHILE
//           the underlying committed forest keeps mutating under auto-disappear /
//           subtree moves. §10 checks resolveAt but only on a PRISTINE folded
//           array, never live inside a fast-check stateful stream where prior
//           commands have reshaped the series AND the forest;
//      (ii) interleaves `applyPastEdit` HISTORY edits (insert-at-new-start /
//           replace-at-existing-start) THROUGH the stateful generator between
//           real affiliation commits, asserting the insert/replace count law and
//           that the edited series stays INV-1/INV-5/INV-6 AND that the freshly
//           inserted anchor is immediately effective at its own start via
//           resolveAt. §10 does insert/replace once on a pristine series; here it
//           rides a continuously-mutated live series;
//      (iii) drives a NEW affiliation command — `createNewTop` immediately
//           followed by its `none` inverse on the SAME leaf, as ONE stateful
//           command (CreateThenIsolate) — and asserts op∘逆op restores the leaf
//           to top-level (parentId undefined) AND the freshly-created top auto-
//           disappears (FR-35 sweep) once its only child leaves. §11 closes a
//           federate∘de-federate inverse but never the create-top∘isolate inverse,
//           and never inside a live stateful stream.
//
//  Per committed/edited state the FULL invariant battery still runs (the SPEC,
//  never weakened to paint green):
//    - 階層森構造妥当 + リング交互性・包含妥当 (validateHierarchy 形状=和・隙間なし
//      via assertFeatureSetInvariants with the vertexStore);
//    - 派生集約=子の和 / aggregate childIds single-source agreement;
//    - 座標に NaN/Infinity 無し (allCoordsFinite);
//    - 選択が常に有効 (survivedTouched/created resolve, deleted gone, created fresh);
//    - 錨列の昇順・非重複 (assertAscendingUnique) + INV-5 non-empty;
//    - save->load=恒等 (JSON round-trip, throttled every 3rd commit).
//  Metamorphic, folded into the commands:
//    - undo∘op==id and op∘undo∘redo==op THROUGH createAffiliationCommand on EVERY
//      committed affiliation command (id-stable redo, 教訓 5.20);
//    - op∘逆op==id for CreateThenIsolate (create-top then isolate restores top);
//    - applyPastEdit insert/replace count law + resolveAt coherence (save∘load of
//      the temporal reader against the ascending order).
//
//  Determinism: seed = 45001 fixed, numRuns large. PERMANENT ASSET — a counter-
//  example is a finding, never a reason to relax a check.
// ===========================================================================
// ===========================================================================

const SEED8 = 45001;

// ---------------------------------------------------------------------------
// §21 model: a NEW per-leaf-period generator distinct from every prior one. It
// reuses the structural shape of buildMixedForest (flat OR deep roots) but draws
// periods from a MEDIUM band (−120..120, span 5..35) — disjoint from
// mixedForestArb (−60..60 / 1..45), wideForestArb (−200..200 / 1..30) and
// denseForestArb (−10..10 / 20..50). This sits between "dense overlap" and
// "sparse disjoint", so the existence guard accepts ~half of re-parent attempts:
// the regime where picker⇔commit single-source AND existence-guard coherence are
// BOTH exercised heavily in one run, on states the prior commands have mutated.
// ---------------------------------------------------------------------------

const mediumRootSpecArb: fc.Arbitrary<MixedRootSpec> = fc
  .record({
    deep: fc.boolean(),
    subCount: fc.integer({ min: 1, max: 3 }),
    leafCount: fc.integer({ min: 1, max: 3 }),
    start: fc.integer({ min: -120, max: 120 }),
    span: fc.integer({ min: 5, max: 35 }),
  })
  .map(({ deep, subCount, leafCount, start, span }) => ({
    deep,
    subCount,
    leafCount,
    start,
    end: start + span,
  }));

function mediumForestArb(): fc.Arbitrary<ModelState> {
  return fc
    .array(mediumRootSpecArb, { minLength: 1, maxLength: 4 })
    .map((specs) => buildMixedForest(specs));
}

// ---------------------------------------------------------------------------
// §21 SUT: live affiliation state + a CONTINUOUSLY-MUTATED riding anchor series
// on which resolveAt / applyPastEdit are exercised live, plus an undo journal
// for the end-of-run full rewind. snapStartYear advances strictly so every
// snapshot anchor has a unique strictly-increasing start (INV-1) and the
// applyPastEdit insert target (lastStart + gap) is always genuinely new.
// ---------------------------------------------------------------------------

interface StatefulModel8 {
  commits: number;
}

interface Journal8 {
  readonly command: ReturnType<typeof createAffiliationCommand>;
  readonly preState: readonly Feature[];
  readonly postState: readonly Feature[];
  readonly createdIds: readonly FeatureId[];
}

class StatefulSut8 {
  state: AffState;
  series: AnchorSeries;
  private snapIdx = 1;
  /** strictly-increasing year used as the next snapshot anchor's start. */
  private nextStartYear = 1000;
  committed = 0;
  readonly original: readonly Feature[];
  readonly journal: Journal8[] = [];
  /** monotone source of unique inserted-anchor ids for applyPastEdit. */
  private pastEditTick = 0;

  constructor(initial: ModelState) {
    this.original = [...initial.features];
    this.state = {
      features: [...initial.features],
      store: store(initial),
      idCounter: 80000,
    };
    this.series = normalizeSeries(
      [this.freshSnapshotEntry()],
      CAL,
    );
    assertAscendingUnique(this.series);
  }

  /** A committed-state snapshot entry at the next strictly-increasing start. */
  private freshSnapshotEntry() {
    const snap = createAnchorSnapshot(this.state.features, this.state.store);
    const anchor = createAnchor(asAnchorId(`s8-${this.snapIdx}`), snap);
    const entry = createAnchorEntry(anchor, timePointYear(this.nextStartYear), null);
    this.snapIdx += 1;
    this.nextStartYear += 10;
    return entry;
  }

  /** The full per-state invariant battery (forest/area/coord/childIds + series). */
  private checkState(): void {
    assertFeatureSetInvariants(this.state.features, this.state.store);
    assertAscendingUnique(this.series);
    expect(this.series.entries.length, 'series empty (INV-5)').toBeGreaterThan(0);
  }

  /**
   * Contract: resolveAt agrees with the strictly-ascending order on the LIVE
   * series — every entry's own start resolves to itself; strictly before the
   * first start is `absent`. Exercised after every mutation of the live series.
   */
  private checkResolveCoherence(): void {
    for (const e of this.series.entries) {
      const r = resolveAt(this.series, e.start, CAL);
      expect(r.kind, `resolveAt absent at own start ${e.start.year}`).toBe('present');
      if (r.kind === 'present') {
        expect(r.entry.anchor.id, 'resolveAt returned wrong entry').toBe(e.anchor.id);
      }
    }
    const firstStart = this.series.entries[0]!.start.year;
    const before = resolveAt(this.series, timePointYear(firstStart - 1), CAL);
    expect(before.kind, 'resolveAt before first start not absent').toBe('absent');
  }

  /** Apply one real proposal, run the per-commit battery, journal it, append snap. */
  commitAndCheck(
    applied:
      | { next: AffState; proposal: AffiliationProposal; baseline: readonly Feature[] }
      | undefined,
  ): void {
    if (applied === undefined) return; // rejected / N/A: legitimate no-op.

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
    const baselineIds = new Set(applied.baseline.map((f) => f.id));
    const del = new Set(applied.proposal.deletedIds);
    for (const id of applied.proposal.createdIds) {
      expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
      expect(del.has(id), `created ${id} also in deletedIds`).toBe(false);
    }

    // METAMORPHIC undo∘op==id and op∘undo∘redo==op THROUGH the real command.
    const command = createAffiliationCommand(applied.baseline, applied.proposal);
    const exec = command.execute(applied.baseline);
    expect(
      featuresEqual(exec.state, applied.proposal.nextFeatures),
      'execute != proposal.nextFeatures',
    ).toBe(true);
    const undone = command.undo(exec.state);
    expect(featuresEqual(undone.state, applied.baseline), 'undo∘op != identity').toBe(true);
    const redone = command.redo(undone.state);
    expect(
      featuresEqual(redone.state, applied.proposal.nextFeatures),
      'op∘undo∘redo != op',
    ).toBe(true);
    const reCreated = redone.state
      .filter((f) => !baselineIds.has(f.id))
      .map((f) => f.id)
      .sort();
    expect(reCreated).toEqual([...applied.proposal.createdIds].sort());

    this.journal.push({
      command,
      preState: applied.baseline,
      postState: exec.state,
      createdIds: applied.proposal.createdIds,
    });

    this.state = applied.next;
    this.committed += 1;

    // anchor列 昇順・非重複: append a fresh committed snapshot, then check resolveAt.
    this.series = normalizeSeries([...this.series.entries, this.freshSnapshotEntry()], CAL);
    this.checkState();
    this.checkResolveCoherence();

    // save∘load=恒等 every 3rd commit.
    if (this.committed % 3 === 0) {
      const parsed = JSON.parse(JSON.stringify(this.state.features)) as Feature[];
      expect(featuresEqual(parsed, this.state.features), 'save∘load != identity').toBe(true);
      const f0 = buildForest(this.state.features);
      const f1 = buildForest(parsed);
      for (const f of this.state.features) {
        const a = resolveFeatureArea(f0, this.state.store, f.id);
        const b = resolveFeatureArea(f1, this.state.store, f.id);
        expect(a.status).toBe(b.status);
        if (a.status === 'ok' && b.status === 'ok') {
          expect(areasEqualWithinTolerance(a.area, b.area), 'save∘load area drift').toBe(true);
        }
      }
    }
  }

  /**
   * Contract (ii): a LIVE applyPastEdit on the riding series.
   *   - REPLACE at an existing entry's start: count unchanged, idempotent.
   *   - INSERT at a strictly-later new start: count + 1, inserted anchor is
   *     immediately effective at its own start (resolveAt), series stays
   *     INV-1/INV-5/INV-6.
   */
  pastEdit(insert: boolean, which: number): void {
    if (insert) {
      const lastStart = this.series.entries[this.series.entries.length - 1]!.start.year;
      this.pastEditTick += 1;
      const newStart = timePointYear(lastStart + 50 + this.pastEditTick);
      const newId = asAnchorId(`s8-past-${this.pastEditTick}`);
      const snap = createAnchorSnapshot(this.state.features, this.state.store);
      const before = this.series.entries.length;
      const after = applyPastEdit(this.series, newStart, () => createAnchor(newId, snap), CAL);
      expect(after.entries.length, 'applyPastEdit insert did not add one').toBe(before + 1);
      this.series = after;
      assertAscendingUnique(this.series);
      const resolved = resolveAt(this.series, newStart, CAL);
      expect(resolved.kind, 'inserted anchor absent at its start').toBe('present');
      if (resolved.kind === 'present') {
        expect(resolved.entry.anchor.id, 'inserted anchor not effective').toBe(newId);
      }
      return;
    }
    // REPLACE at an existing start: pick a live entry, replace its snapshot.
    const target = pick(this.series.entries, which);
    if (target === undefined) return;
    const snap = createAnchorSnapshot(this.state.features, this.state.store);
    const makeRepl = () => createAnchor(target.anchor.id, snap);
    const before = this.series.entries.length;
    const replaced = applyPastEdit(this.series, target.start, makeRepl, CAL);
    expect(replaced.entries.length, 'applyPastEdit replace changed count').toBe(before);
    // idempotent in count.
    const replaced2 = applyPastEdit(replaced, target.start, makeRepl, CAL);
    expect(replaced2.entries.length, 'applyPastEdit replace not idempotent').toBe(before);
    this.series = replaced2;
    assertAscendingUnique(this.series);
    this.checkResolveCoherence();
  }

  /** End-of-run: replaying the journal forward from the original reproduces live. */
  verifyTimeline(): void {
    let cur: readonly Feature[] = this.original;
    for (const frame of this.journal) {
      expect(featuresEqual(cur, frame.preState), 'timeline preState drift').toBe(true);
      cur = frame.command.redo(cur).state;
      expect(featuresEqual(cur, frame.postState), 'timeline redo != postState').toBe(true);
    }
    expect(featuresEqual(cur, this.state.features), 'timeline replay != live state').toBe(true);
    // And the full reverse rewind lands byte-identical on the original baseline.
    let back: readonly Feature[] = this.state.features;
    for (let i = this.journal.length - 1; i >= 0; i -= 1) {
      back = this.journal[i]!.command.undo(back).state;
    }
    expect(featuresEqual(back, this.original), 'full rewind != original').toBe(true);
    expect(back.length).toBe(this.original.length);
  }
}

type SCmd8 = fc.Command<StatefulModel8, StatefulSut8>;

class AffStep8 implements SCmd8 {
  constructor(readonly cmd: AffCmd2) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel8, s: StatefulSut8): void {
    const applied = applyAffCmd2(s.state, this.cmd);
    s.commitAndCheck(applied);
    if (applied !== undefined) m.commits += 1;
  }
  toString(): string {
    return `aff(${JSON.stringify(this.cmd)})`;
  }
}

/**
 * Contract (iii): create a fresh new-top over a chosen LEAF, then immediately
 * isolate that same leaf back to `none`. op∘逆op==id: the leaf returns to
 * top-level (parentId undefined) and the just-created top auto-disappears once it
 * loses its only child (FR-35 sweep+prune). Both legs run the full SUT battery.
 * A non-committing first leg is a legitimate no-op.
 */
class CreateThenIsolate8 implements SCmd8 {
  constructor(readonly leafWhich: number) {}
  check(): boolean {
    return true;
  }
  run(m: StatefulModel8, s: StatefulSut8): void {
    const features = s.state.features;
    const forest = buildForest(features);
    const leaves = features.filter((f) => directChildIds(forest, f.id).length === 0);
    if (leaves.length === 0) return;
    const leaf = leaves[this.leafWhich % leaves.length]!;
    const leafIdx = features.indexOf(leaf);

    // op: createNewTop over the leaf (mints a fresh top aggregate as its parent).
    const created = applyAffCmd2(s.state, { t: 'createNewTop', targetWhich: leafIdx });
    if (created === undefined) return; // legitimate rejection: no-op.
    s.commitAndCheck(created);
    m.commits += 1;

    const newTops = created.proposal.createdIds;
    expect(newTops.length, 'createNewTop minted no top').toBeGreaterThan(0);
    const newTop = newTops[newTops.length - 1]!;
    const movedLeaf = s.state.features.find((f) => f.id === leaf.id);
    expect(movedLeaf, 'leaf vanished after createNewTop').toBeDefined();
    expect(movedLeaf?.parentId, 'leaf not under created top').toBe(newTop);

    // 逆op: isolate the leaf back to `none`.
    const leafIdx2 = s.state.features.findIndex((f) => f.id === leaf.id);
    const isolated = applyAffCmd2(s.state, { t: 'none', targetWhich: leafIdx2 });
    if (isolated === undefined) {
      // Could only fail if the leaf vanished — it did not. Treat a non-commit as a
      // finding-worthy surprise: a top-level isolate of a surviving leaf must work.
      expect(
        s.state.features.some((f) => f.id === leaf.id),
        'isolate(none) rejected though leaf survives',
      ).toBe(false);
      return;
    }
    s.commitAndCheck(isolated);
    m.commits += 1;

    // op∘逆op: the leaf is top-level again.
    const restored = s.state.features.find((f) => f.id === leaf.id);
    expect(restored, 'leaf vanished after isolate').toBeDefined();
    expect(restored?.parentId, 'createNewTop∘isolate did not restore top-level').toBe(undefined);
    // The just-created top, having lost its only child, must have auto-disappeared.
    const topStill = s.state.features.some((f) => f.id === newTop);
    expect(topStill, 'created top lingered as empty aggregate after isolate').toBe(false);
  }
  toString(): string {
    return `createThenIsolate(leaf=${this.leafWhich})`;
  }
}

/** Contract (ii) as a stateful command: a live applyPastEdit insert OR replace. */
class PastEditStep8 implements SCmd8 {
  constructor(
    readonly insert: boolean,
    readonly which: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(_m: StatefulModel8, s: StatefulSut8): void {
    s.pastEdit(this.insert, this.which);
  }
  toString(): string {
    return `pastEdit(${this.insert ? 'insert' : 'replace'},${this.which})`;
  }
}

const statefulCommands8Arb: fc.Arbitrary<Iterable<SCmd8>> = fc.commands(
  [
    affCmd2Arb.map((c) => new AffStep8(c)),
    fc.nat().map((l) => new CreateThenIsolate8(l)),
    fc.tuple(fc.boolean(), fc.nat()).map(([ins, w]) => new PastEditStep8(ins, w)),
  ],
  { maxCommands: 20 },
);

describe(`affiliation — STATEFUL model #4: live resolveAt/applyPastEdit + create∘isolate (seed=${SEED8})`, () => {
  it('fc.commands drives the real pipeline; temporal reader + history edits + inverse hold', () => {
    fc.assert(
      fc.property(mediumForestArb(), statefulCommands8Arb, (initial, cmds) => {
        let sut: StatefulSut8 | undefined;
        const setup: fc.ModelRunSetup<StatefulModel8, StatefulSut8> = () => {
          const real = new StatefulSut8(initial);
          sut = real;
          return { model: { commits: 0 }, real };
        };
        fc.modelRun(setup, cmds);
        // End-of-run: forward replay == live state, and full reverse rewind ==
        // original baseline (no journal drift across the whole interleaved run).
        sut?.verifyTimeline();
      }),
      { seed: SEED8, numRuns: 800 },
    );
  });
});
