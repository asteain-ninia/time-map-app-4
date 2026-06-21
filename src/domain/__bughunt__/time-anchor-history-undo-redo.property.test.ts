// Bug-hunt property/model-based tests — focus: time-anchor-history-undo-redo.
//
// These tests drive the REAL anchor-series temporal-axis operations
// (changeStart / setEnd / deleteAnchor / applyPastEdit) through the REAL
// dual-stack history (execute / undo / redo) and assert, after every step:
//
//   - INV-1 strictly ascending, non-duplicate starts
//   - INV-2 no overlap (each end <= next start)
//   - INV-3 positive span (end strictly after start)
//   - INV-5 non-empty series
//   - no NaN / Infinity in any persisted coordinate / year scalar
//   - parent references in each snapshot are valid (forest validity, trivially
//     satisfied for the point-only snapshots used here)
//   - save -> load == identity (JSON round-trip of the series)
//
// Metamorphic laws:
//   - undo ∘ execute  == identity  (state restored to the pre-execute value)
//   - redo restores the post-execute value exactly
//   - full undo back to the root == the root state
//   - save ∘ load == identity
//
// Determinism: pinned seed 4001, numRuns >= 300 (overriding the global seed in
// src/test-setup.ts so this file is self-contained and reproducible).
//
// This file is a permanent asset. It exercises behavior through the public
// command / history / series API; it must NOT be relaxed to paint a broken
// existing behavior green.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createAnchor, type Anchor, type AnchorSnapshot } from '../anchor';
import {
  changeStart,
  createAnchorEntry,
  deleteAnchor,
  normalizeSeries,
  resolveAt,
  setEnd,
  validateSeries,
  type AnchorEntry,
  type AnchorSeries,
  type SeriesResult,
} from '../anchor-series';
import { applyPastEdit } from '../anchor-series';
import { anchorSeriesArb, makeAnchor } from '../anchor-series.arbitraries';
import {
  type Command,
  type CommandOutcome,
  defineCommandKind,
} from '../command/command';
import { createCommandResult } from '../command/result';
import {
  createHistory,
  execute,
  redo,
  undo,
  type History,
} from '../command/history';
import { getCalendar } from '../time/calendar';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { timePointYear, type TimePoint } from '../time/time-point';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createVertex, createVertexStore } from '../vertex';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  type Ring,
  type Shape,
} from '../ring';
import { validateAlternation } from '../ring-hierarchy';
import { createAnchorSnapshot } from '../anchor';

const cal = getCalendar('gregorian');

const SEED = 4001;
const NUM_RUNS = 500;

// --- invariant checks -------------------------------------------------------

/** All of INV-1, INV-2, INV-3, INV-5 via the single source of truth. */
function expectAllInvariants(s: AnchorSeries): void {
  expect(s.entries.length).toBeGreaterThanOrEqual(1); // INV-5
  const v = validateSeries(s, cal);
  if (!v.ok) {
    throw new Error(
      `series invariants violated: ${JSON.stringify(v.violations)} | series=${JSON.stringify(serializeSeries(s))}`,
    );
  }
}

function isFiniteNumber(n: number): boolean {
  return Number.isFinite(n);
}

/** No NaN / Infinity anywhere in the snapshot's coordinates / scalar attrs. */
function expectNoBadNumbers(s: AnchorSeries): void {
  for (const e of s.entries) {
    checkTimePointFinite(e.start);
    if (e.end !== null) checkTimePointFinite(e.end);
    for (const v of e.anchor.snapshot.vertices.byId.values()) {
      expect(isFiniteNumber(v.coordinate.lon)).toBe(true);
      expect(isFiniteNumber(v.coordinate.lat)).toBe(true);
    }
    for (const f of e.anchor.snapshot.features) {
      expect(isFiniteNumber(f.attributes.startYear)).toBe(true);
      expect(isFiniteNumber(f.attributes.endYear)).toBe(true);
    }
  }
}

function checkTimePointFinite(t: TimePoint): void {
  expect(isFiniteNumber(t.year)).toBe(true);
  if (t.granularity === 'yearMonth' || t.granularity === 'yearMonthDay') {
    expect(isFiniteNumber(t.month)).toBe(true);
  }
  if (t.granularity === 'yearMonthDay') {
    expect(isFiniteNumber(t.day)).toBe(true);
  }
}

/** Parent references in each snapshot point at a present feature (forest). */
function expectForestValid(s: AnchorSeries): void {
  for (const e of s.entries) {
    const ids = new Set<string>(e.anchor.snapshot.features.map((f) => f.id));
    for (const f of e.anchor.snapshot.features) {
      if (f.parentId !== undefined) {
        expect(ids.has(f.parentId)).toBe(true);
        expect(f.parentId).not.toBe(f.id); // no self-parent
      }
    }
  }
}

/** resolveAt over any entry's start resolves to a present, valid entry. */
function expectSelectionValid(s: AnchorSeries): void {
  // "selection is always valid": the anchor effective at each entry's own
  // start must be present and must be a real entry of the series.
  const ids = new Set(s.entries.map((e) => e.anchor.id));
  for (const e of s.entries) {
    const r = resolveAt(s, e.start, cal);
    expect(r.kind).toBe('present');
    if (r.kind === 'present') {
      expect(ids.has(r.entry.anchor.id)).toBe(true);
    }
  }
}

// --- save / load (JSON round-trip) ------------------------------------------

interface SerializedEntry {
  readonly anchorId: string;
  readonly start: TimePoint;
  readonly end: TimePoint | null;
  readonly features: readonly Feature[];
  readonly vertices: ReadonlyArray<{
    readonly id: string;
    readonly lon: number;
    readonly lat: number;
  }>;
}

interface SerializedSeries {
  readonly entries: readonly SerializedEntry[];
}

function serializeSeries(s: AnchorSeries): SerializedSeries {
  // No signed-zero workaround here: `createCoordinate` (the single construction
  // seam) now normalizes -0 -> +0, so the in-memory form is already byte-
  // identical to the JSON-persisted form and a strict structural round-trip
  // (Object.is on zeros) holds. The serialized coordinates are emitted verbatim.
  return {
    entries: s.entries.map((e) => ({
      anchorId: e.anchor.id,
      start: e.start,
      end: e.end,
      features: e.anchor.snapshot.features,
      vertices: [...e.anchor.snapshot.vertices.byId.values()].map((v) => ({
        id: v.id,
        lon: v.coordinate.lon,
        lat: v.coordinate.lat,
      })),
    })),
  };
}

function deserializeSeries(data: SerializedSeries): AnchorSeries {
  const entries: AnchorEntry[] = data.entries.map((se) => {
    const byId = new Map(
      se.vertices.map((v) => [
        v.id as never,
        { id: v.id as never, coordinate: { lon: v.lon, lat: v.lat } },
      ]),
    );
    const snapshot: AnchorSnapshot = {
      features: se.features,
      vertices: { byId },
    };
    const anchor: Anchor = createAnchor(asAnchorId(se.anchorId), snapshot);
    return createAnchorEntry(anchor, se.start, se.end);
  });
  // IMPORTANT: do NOT re-normalize — a faithful load must reproduce the saved
  // order/structure verbatim. Re-sorting here would mask a persistence bug.
  return { entries };
}

/** save -> JSON string -> parse -> load, then structural compare. */
function expectSaveLoadIdentity(s: AnchorSeries): void {
  const saved = JSON.stringify(serializeSeries(s));
  const reloaded = deserializeSeries(JSON.parse(saved) as SerializedSeries);
  expect(serializeSeries(reloaded)).toEqual(serializeSeries(s));
}

// --- comparable view of a series (ignores object identity) ------------------

function viewSeries(s: AnchorSeries): unknown {
  return serializeSeries(s);
}

// --- reversible command wrapping an anchor-series operation ------------------
//
// Lesson 5.20: a command captures the data it needs for undo/redo at execute
// time. Here the whole pre- and post-series are captured as plain immutable
// values (the series is small), so undo/redo are deterministic replays that do
// not depend on re-deriving anything.

const SERIES_EDIT = defineCommandKind('bughunt/series-edit');

function makeSeriesCommand(
  label: string,
  before: AnchorSeries,
  after: AnchorSeries,
): Command<AnchorSeries> {
  const result = createCommandResult({});
  const toAfter = (): CommandOutcome<AnchorSeries> => ({ state: after, result });
  const toBefore = (): CommandOutcome<AnchorSeries> => ({ state: before, result });
  return {
    kind: SERIES_EDIT,
    label,
    execute: toAfter,
    undo: toBefore,
    redo: toAfter,
  };
}

// --- abstract edit operations generated by fast-check -----------------------

type EditOp =
  | { readonly kind: 'changeStart'; readonly target: number; readonly year: number }
  | { readonly kind: 'setEnd'; readonly target: number; readonly end: number | null }
  | { readonly kind: 'delete'; readonly target: number }
  | { readonly kind: 'pastEdit'; readonly year: number; readonly seed: number };

const editOpArb: fc.Arbitrary<EditOp> = fc.oneof(
  fc.record({
    kind: fc.constant('changeStart' as const),
    target: fc.nat(),
    year: fc.integer({ min: -600, max: 600 }),
  }),
  fc.record({
    kind: fc.constant('setEnd' as const),
    target: fc.nat(),
    end: fc.option(fc.integer({ min: -600, max: 600 }), { nil: null }),
  }),
  fc.record({ kind: fc.constant('delete' as const), target: fc.nat() }),
  fc.record({
    kind: fc.constant('pastEdit' as const),
    year: fc.integer({ min: -600, max: 600 }),
    seed: fc.integer({ min: 0, max: 100000 }),
  }),
);

/**
 * Apply one abstract edit to a series, returning the new series ONLY when the
 * operation succeeds and actually changes the series. Returns undefined for a
 * rejected / no-op edit (so the harness does not push a ghost history entry).
 */
function applyEdit(s: AnchorSeries, op: EditOp): AnchorSeries | undefined {
  const idAt = (i: number) => s.entries[i % s.entries.length]!.anchor.id;

  let next: AnchorSeries | undefined;
  if (op.kind === 'changeStart') {
    const r: SeriesResult = changeStart(s, idAt(op.target), timePointYear(op.year), cal);
    next = r.ok ? r.series : undefined;
  } else if (op.kind === 'setEnd') {
    const r: SeriesResult = setEnd(
      s,
      idAt(op.target),
      op.end === null ? null : timePointYear(op.end),
      cal,
    );
    next = r.ok ? r.series : undefined;
  } else if (op.kind === 'delete') {
    const r: SeriesResult = deleteAnchor(s, idAt(op.target), cal);
    next = r.ok ? r.series : undefined;
  } else {
    next = applyPastEdit(
      s,
      timePointYear(op.year),
      () => makeAnchor(op.seed, `-pe-${op.seed}`),
      cal,
    );
  }
  if (next === undefined) return undefined;
  // Treat a structurally-identical result as a no-op (no history entry).
  if (JSON.stringify(viewSeries(next)) === JSON.stringify(viewSeries(s))) {
    return undefined;
  }
  return next;
}

// --- the model-based driver -------------------------------------------------

interface HistoryAction {
  readonly t: 'edit' | 'undo' | 'redo';
  readonly op?: EditOp;
}

const actionArb: fc.Arbitrary<HistoryAction> = fc.oneof(
  editOpArb.map((op) => ({ t: 'edit' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'redo' as const }),
);

function assertStepInvariants(s: AnchorSeries): void {
  expectAllInvariants(s);
  expectNoBadNumbers(s);
  expectForestValid(s);
  expectSelectionValid(s);
  expectSaveLoadIdentity(s);
}

describe('time-anchor + history undo/redo — invariants under random edit streams', () => {
  it('every history state (after edit/undo/redo) satisfies all invariants', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(actionArb, { maxLength: 24 }),
        (initial, actions) => {
          // Sanity: the generator itself must produce a valid series.
          assertStepInvariants(initial);

          let history: History<AnchorSeries> = createHistory(initial, 50);
          // A reference stack of the states we expect undo to walk back through.
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyEdit(before, action.op);
              if (after === undefined) continue; // rejected / no-op
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('metamorphic: undo ∘ execute restores the exact pre-execute state', () => {
    fc.assert(
      fc.property(anchorSeriesArb(cal), editOpArb, (initial, op) => {
        const history0 = createHistory(initial, 50);
        const after = applyEdit(history0.state, op);
        if (after === undefined) return; // nothing to test for a rejected/no-op
        const executed = execute(
          history0,
          makeSeriesCommand(op.kind, history0.state, after),
        ).history;
        // post-execute state must equal the computed `after`.
        expect(viewSeries(executed.state)).toEqual(viewSeries(after));
        const undone = undo(executed).history;
        // undo ∘ execute == identity
        expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
        // redo restores the post-execute state exactly.
        const redone = redo(undone).history;
        expect(viewSeries(redone.state)).toEqual(viewSeries(after));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('metamorphic: undoing every executed edit returns to the root state', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let history = createHistory(initial, 100);
          let pushed = 0;
          for (const op of ops) {
            const after = applyEdit(history.state, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, history.state, after),
            ).history;
            pushed += 1;
          }
          for (let i = 0; i < pushed; i += 1) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('metamorphic: save ∘ load == identity for any reachable series', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectSaveLoadIdentity(s);
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('op ∘ inverse-op == identity: setEnd(end) then setEnd(null) round-trips through normalize', () => {
    // A targeted metamorphic law on the temporal axis: setting then clearing an
    // end is a round-trip ONLY when the set is accepted and the normalized
    // result preserves the original (no overrun-shortening side effect). We
    // verify against the SINGLE source of truth (validateSeries) and structural
    // equality of the cleared form vs the original entry's open-ended form.
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: -600, max: 600 }),
        (initial, targetN, endYear) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          // Establish a clean open-ended baseline for the target first.
          const cleared = setEnd(initial, target.anchor.id, null, cal);
          if (!cleared.ok) return;
          const base = cleared.series;
          const set = setEnd(base, target.anchor.id, timePointYear(endYear), cal);
          if (!set.ok) return; // rejected end is out of scope for this law
          expectAllInvariants(set.series);
          const recleared = setEnd(set.series, target.anchor.id, null, cal);
          expect(recleared.ok).toBe(true);
          if (recleared.ok) {
            expectAllInvariants(recleared.series);
            // Clearing the end must yield a series structurally equal to the
            // open-ended baseline (the set+clear pair is reversible).
            expect(viewSeries(recleared.series)).toEqual(viewSeries(base));
          }
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

// ===========================================================================
// SEED 4002 expansion suite.
//
// A second, independently-pinned pass over the SAME real operations with a
// different deterministic seed (4002) and a larger run budget, plus extra
// metamorphic laws not covered by the 4001 suite:
//   - changeStart followed by changeStart-back is an identity ONLY when the
//     re-move is accepted and nothing collided away (we assert against the
//     single source of truth + structural view).
//   - a full random edit stream driven THROUGH the dual-stack history, then
//     fully undone, returns to the root (re-checked here at 4002 so a seed-
//     specific ordering bug would surface independently).
//   - redo after a single undo restores the exact post-execute state across a
//     random stream (history-level op∘undo∘redo coherence).
// ===========================================================================

const SEED_4002 = 4002;
const NUM_RUNS_4002 = 600;

/**
 * True when every entry OTHER than `excludeId` is byte-identical (by start/end)
 * between two series. Used to detect whether a changeStart auto-reorganization
 * mutated a neighbor (overrun-shortening) or dropped an entry, which makes the
 * move non-reversible by spec.
 */
function nonTargetEntriesEqual(
  a: AnchorSeries,
  b: AnchorSeries,
  excludeId: string,
): boolean {
  const key = (s: AnchorSeries) =>
    JSON.stringify(
      s.entries
        .filter((e) => e.anchor.id !== excludeId)
        .map((e) => ({ id: e.anchor.id, start: e.start, end: e.end })),
    );
  return key(a) === key(b);
}

describe('time-anchor + history undo/redo — seed 4002 expansion', () => {
  it('every history state (edit/undo/redo) satisfies all invariants (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(actionArb, { maxLength: 30 }),
        (initial, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('metamorphic: changeStart then changeStart-back round-trips (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: -600, max: 600 }),
        (initial, targetN, newYear) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const originalStart = target.start;
          const id = target.anchor.id;

          const moved = changeStart(initial, id, timePointYear(newYear), cal);
          if (!moved.ok) return; // rejected move is out of scope
          expectAllInvariants(moved.series);

          // Move the SAME anchor back to its original start.
          const back = changeStart(moved.series, id, originalStart, cal);
          if (!back.ok) return;
          expectAllInvariants(back.series);

          // changeStart auto-reorganizes via normalization (§5.6 「短縮」):
          // moving the target THROUGH a bounded neighbor permanently shortens
          // that neighbor's end, and a keep-last collision can drop an entry.
          // Both are destructive and NOT undone by moving the target back, so
          // the round-trip is an identity ONLY when the forward move left every
          // OTHER entry (by id → start/end) byte-identical. We verify that
          // precondition directly against the forward result rather than via a
          // coarse count check (a count-preserving move can still shorten a
          // neighbor — see the 4002 counterexample that motivated this guard).
          const othersUnchanged = nonTargetEntriesEqual(initial, moved.series, id);
          if (othersUnchanged) {
            // Target untouched elsewhere ⇒ moving it back must restore the
            // exact original series (full reversibility on the temporal axis).
            expect(viewSeries(back.series)).toEqual(viewSeries(initial));
          }
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('metamorphic: undoing every executed edit returns to the root (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 20 }),
        (initial, ops) => {
          let history = createHistory(initial, 200);
          let pushed = 0;
          for (const op of ops) {
            const after = applyEdit(history.state, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, history.state, after),
            ).history;
            pushed += 1;
          }
          for (let i = 0; i < pushed; i += 1) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('metamorphic: execute∘undo∘redo restores post-execute state across a stream (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 20 }),
        (initial, ops) => {
          let history = createHistory(initial, 200);
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            const executed = execute(
              history,
              makeSeriesCommand(op.kind, before, after),
            ).history;
            const postExecute = executed.state;
            // undo then redo must reproduce the exact post-execute state, and
            // the intermediate undo must reproduce the exact pre-execute state.
            const undone = undo(executed).history;
            expect(viewSeries(undone.state)).toEqual(viewSeries(before));
            const redone = redo(undone).history;
            expect(viewSeries(redone.state)).toEqual(viewSeries(postExecute));
            // continue the stream from the redone (== post-execute) history.
            history = redone;
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('save ∘ load == identity for any reachable series (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 20 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectSaveLoadIdentity(s);
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });
});

// keep normalizeSeries import used even if a branch above is pruned
void normalizeSeries;

// ===========================================================================
// SEED 4004 expansion suite — RICH snapshots (rings + hierarchy forest).
//
// The 4001/4002 suites drive POINT-ONLY anchor snapshots, so the spec's
// ring-alternation / non-self-intersection / containment and hierarchy-forest
// (derived-aggregate = children) invariants are never exercised across the
// undo/redo + save/load cycle. The anchor-series unit holds the snapshot
// OPAQUELY (it never interprets shapes/hierarchy), so if undo/redo or the
// JSON save→load boundary silently dropped or reordered shape rings, child
// references, parent-ring links, or aliased vertex IDs, the point-only suites
// would not catch it. This suite drives anchors whose snapshots carry:
//   - LEAF features with a real, alternation-valid ring forest (territory →
//     hole → territory …), and
//   - AGGREGATE features whose childIds reference present features (the
//     "derived aggregate = the set of its children" forest invariant),
// through the SAME real history operations, asserting after every step:
//   - INV-1..INV-3, INV-5 on the series (single source of truth),
//   - ring alternation valid on every leaf shape (validateAlternation),
//   - every ring's parentRingId resolves to a present ring (no dangling),
//   - every aggregate childId resolves to a present feature in the same
//     snapshot, and no feature is its own parent / own child,
//   - no NaN / Infinity in any coordinate / year scalar,
//   - a FULL-FIDELITY save → JSON → load round-trip reproduces the rich
//     snapshot verbatim (shapes, ring parents, childIds, vertices included).
// Metamorphic: undo∘execute == identity, full-undo == root, redo restores the
// post-execute state — all over the rich snapshots.
//
// Determinism: pinned seed 4004, large run budget. Permanent asset; must not be
// relaxed to paint a broken behavior green.
// ===========================================================================

const SEED_4004 = 4004;
const NUM_RUNS_4004 = 400;

// --- rich snapshot generator (real factories; 教訓 5.39) --------------------

/** A small alternation-valid ring forest: 1-2 top territories, each with an
 * optional hole, each hole with an optional nested (enclave) territory. Built
 * through the REAL U06 ring factories so it is structurally valid by
 * construction; geometry coordinates are placeholders (this targets the
 * STRUCTURAL alternation + parent-link invariants under undo/redo/persist). */
function ringForestArb(tag: string): fc.Arbitrary<Shape> {
  return fc
    .array(
      fc.record({
        hole: fc.boolean(),
        enclave: fc.boolean(),
      }),
      { minLength: 1, maxLength: 2 },
    )
    .map((plans) => {
      const rings: Ring[] = [];
      let n = 0;
      const rid = () => asRingId(`${tag}-r${n++}`);
      const vids = (id: string) => [
        asVertexId(`${id}-a`),
        asVertexId(`${id}-b`),
        asVertexId(`${id}-c`),
      ];
      for (const plan of plans) {
        const tId = rid();
        rings.push(createTerritoryRing(tId, vids(tId)));
        if (plan.hole) {
          const hId = rid();
          rings.push(createHoleRing(hId, vids(hId), tId));
          if (plan.enclave) {
            const eId = rid();
            rings.push(createTerritoryRing(eId, vids(eId), hId));
          }
        }
      }
      return createShape(rings);
    });
}

/** Build a rich snapshot: a leaf feature with a ring forest, plus an aggregate
 * feature whose childIds reference the leaf (derived-aggregate = children). All
 * vertices referenced by the rings are present in the vertex store. */
function richSnapshotArb(idTag: string): fc.Arbitrary<AnchorSnapshot> {
  return fc
    .tuple(
      ringForestArb(idTag),
      fc.integer({ min: -90, max: 90 }),
      fc.integer({ min: -180, max: 180 }),
    )
    .map(([shape, lat, lon]) => {
      const attrs = createBasicAttributes(`name-${idTag}`, lat, lon);
      const color = createColorInfo(true, '#102030', '#405060', '#708090');
      const leafId = asFeatureId(`${idTag}-leaf`);
      const aggId = asFeatureId(`${idTag}-agg`);
      const leaf = createLeafFeature(leafId, attrs, color, shape);
      // Aggregate's childIds reference the present leaf — the forest invariant
      // (derived aggregate == the set of its children) is satisfiable.
      const agg = createAggregateFeature(aggId, attrs, color, [leafId]);
      // One vertex per ring-vertex id so every ring reference resolves.
      const verts = shape.rings.flatMap((r) =>
        r.vertexIds.map((vid, i) =>
          createVertex(vid, createCoordinate((lon + i) % 180, (lat + i) % 90)),
        ),
      );
      return createAnchorSnapshot([leaf, agg], createVertexStore(verts));
    });
}

/** A valid, non-empty anchor series whose anchors carry RICH snapshots. */
function richAnchorSeriesArb(): fc.Arbitrary<AnchorSeries> {
  return fc
    .uniqueArray(fc.integer({ min: -300, max: 300 }), {
      minLength: 1,
      maxLength: 5,
    })
    .chain((years) => {
      const sorted = [...years].sort((a, b) => a - b);
      return fc
        .tuple(...sorted.map((y) => richSnapshotArb(`y${y}`)))
        .map((snaps) => {
          const entries: AnchorEntry[] = sorted.map((y, i) => {
            const anchor = createAnchor(asAnchorId(`a-${y}`), snaps[i]!);
            return createAnchorEntry(anchor, timePointYear(y), null);
          });
          return normalizeSeries(entries, cal);
        });
    });
}

// --- rich-snapshot invariant checks ----------------------------------------

/** Ring alternation valid + every parentRingId resolves (no dangling parent)
 * for every leaf shape in every snapshot of the series. */
function expectRingHierarchyValid(s: AnchorSeries): void {
  for (const e of s.entries) {
    for (const f of e.anchor.snapshot.features) {
      if (f.kind !== 'leaf') continue;
      const shape = f.shape;
      const res = validateAlternation(shape);
      if (!res.valid) {
        throw new Error(
          `ring alternation violated in leaf ${f.id}: ${JSON.stringify(res.violations)}`,
        );
      }
      const ringIds = new Set(shape.rings.map((r) => r.id));
      for (const r of shape.rings) {
        if (r.parentRingId !== undefined) {
          expect(ringIds.has(r.parentRingId)).toBe(true);
          expect(r.parentRingId).not.toBe(r.id); // no self-parent ring
        }
      }
    }
  }
}

/** Hierarchy forest: every aggregate childId resolves to a present feature in
 * the same snapshot, no aggregate lists itself as a child, and the feature
 * parent forest (parentId) has no dangling / self links. */
function expectAggregateForestValid(s: AnchorSeries): void {
  for (const e of s.entries) {
    const features = e.anchor.snapshot.features;
    const featureIds = new Set<string>(features.map((f) => f.id));
    for (const f of features) {
      if (f.parentId !== undefined) {
        expect(featureIds.has(f.parentId)).toBe(true);
        expect(f.parentId).not.toBe(f.id);
      }
      if (f.kind === 'aggregate') {
        for (const childId of f.childIds) {
          // Derived aggregate = the set of its children: each child must exist.
          expect(featureIds.has(childId)).toBe(true);
          expect(childId).not.toBe(f.id); // an aggregate is never its own child
        }
        // childIds carry no duplicates (a child counted twice would
        // double-count in any derived aggregate area).
        expect(new Set(f.childIds).size).toBe(f.childIds.length);
      }
    }
  }
}

// --- full-fidelity save / load (rings + childIds + vertices) ----------------

/** A faithful save→JSON→load that preserves the FULL feature objects (shape
 * rings, parentRingId, aggregate childIds, parentId) and the vertex store.
 * Unlike the point-only serializer above, this round-trips the whole snapshot,
 * so a dropped/reordered ring or childId or a lost parent link would surface as
 * a structural inequality rather than passing silently. */
function expectRichSaveLoadIdentity(s: AnchorSeries): void {
  const toPlain = (series: AnchorSeries) =>
    series.entries.map((e) => ({
      anchorId: e.anchor.id,
      start: e.start,
      end: e.end,
      features: e.anchor.snapshot.features,
      vertices: [...e.anchor.snapshot.vertices.byId.entries()].map(
        ([id, v]) => ({ id, lon: v.coordinate.lon, lat: v.coordinate.lat }),
      ),
    }));
  const plain = toPlain(s);
  const reloaded = JSON.parse(JSON.stringify(plain)) as typeof plain;
  // Rebuild a series from the reloaded plain data WITHOUT re-normalizing (a
  // faithful load must reproduce the saved structure verbatim).
  const rebuilt: AnchorSeries = {
    entries: reloaded.map((pe) => {
      const verts = pe.vertices.map((pv) =>
        createVertex(asVertexId(pv.id), createCoordinate(pv.lon, pv.lat)),
      );
      const snapshot = createAnchorSnapshot(
        pe.features as readonly Feature[],
        createVertexStore(verts),
      );
      return createAnchorEntry(
        createAnchor(asAnchorId(pe.anchorId), snapshot),
        pe.start,
        pe.end,
      );
    }),
  };
  expect(toPlain(rebuilt)).toEqual(plain);
  // The reload must still satisfy every structural invariant.
  expectRingHierarchyValid(rebuilt);
  expectAggregateForestValid(rebuilt);
}

function assertRichStepInvariants(s: AnchorSeries): void {
  expectAllInvariants(s);
  expectNoBadNumbers(s);
  expectRingHierarchyValid(s);
  expectAggregateForestValid(s);
  expectSelectionValid(s);
  expectRichSaveLoadIdentity(s);
}

/** Apply an abstract edit (reusing the 4001 EditOp space) to a rich series,
 * returning a changed series or undefined for a rejected / no-op edit. pastEdit
 * inserts a RICH snapshot so inserted anchors keep the rich shape. */
function applyRichEdit(s: AnchorSeries, op: EditOp): AnchorSeries | undefined {
  const idAt = (i: number) => s.entries[i % s.entries.length]!.anchor.id;
  let next: AnchorSeries | undefined;
  if (op.kind === 'changeStart') {
    const r = changeStart(s, idAt(op.target), timePointYear(op.year), cal);
    next = r.ok ? r.series : undefined;
  } else if (op.kind === 'setEnd') {
    const r = setEnd(
      s,
      idAt(op.target),
      op.end === null ? null : timePointYear(op.end),
      cal,
    );
    next = r.ok ? r.series : undefined;
  } else if (op.kind === 'delete') {
    const r = deleteAnchor(s, idAt(op.target), cal);
    next = r.ok ? r.series : undefined;
  } else {
    // pastEdit: build a fresh rich snapshot deterministically from the seed.
    const tag = `pe${op.seed}`;
    const leafId = asFeatureId(`${tag}-leaf`);
    const aggId = asFeatureId(`${tag}-agg`);
    const attrs = createBasicAttributes(tag, op.seed % 90, op.seed % 180);
    const color = createColorInfo(true, '#111', '#222', '#333');
    const tRid = asRingId(`${tag}-t`);
    const hRid = asRingId(`${tag}-h`);
    const tV = [asVertexId(`${tag}-ta`), asVertexId(`${tag}-tb`), asVertexId(`${tag}-tc`)];
    const hV = [asVertexId(`${tag}-ha`), asVertexId(`${tag}-hb`), asVertexId(`${tag}-hc`)];
    const shape = createShape([
      createTerritoryRing(tRid, tV),
      createHoleRing(hRid, hV, tRid),
    ]);
    const leaf = createLeafFeature(leafId, attrs, color, shape);
    const agg = createAggregateFeature(aggId, attrs, color, [leafId]);
    const verts = [...tV, ...hV].map((vid, i) =>
      createVertex(vid, createCoordinate((op.seed + i) % 180, (op.seed + i) % 90)),
    );
    const snap = createAnchorSnapshot([leaf, agg], createVertexStore(verts));
    next = applyPastEdit(
      s,
      timePointYear(op.year),
      () => createAnchor(asAnchorId(`${tag}-anchor`), snap),
      cal,
    );
  }
  if (next === undefined) return undefined;
  if (JSON.stringify(viewSeries(next)) === JSON.stringify(viewSeries(s))) {
    return undefined;
  }
  return next;
}

describe('time-anchor + history undo/redo — seed 4004 rich-snapshot expansion', () => {
  it('rich snapshots keep ring-alternation + hierarchy-forest + save/load through edit/undo/redo', () => {
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.array(actionArb, { maxLength: 24 }),
        (initial, actions) => {
          assertRichStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyRichEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertRichStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });

  it('metamorphic: undo∘execute == identity and redo restores post-execute (rich, seed 4004)', () => {
    fc.assert(
      fc.property(richAnchorSeriesArb(), editOpArb, (initial, op) => {
        const history0 = createHistory(initial, 50);
        const after = applyRichEdit(history0.state, op);
        if (after === undefined) return;
        const executed = execute(
          history0,
          makeSeriesCommand(op.kind, history0.state, after),
        ).history;
        expect(viewSeries(executed.state)).toEqual(viewSeries(after));
        expectRingHierarchyValid(executed.state);
        expectAggregateForestValid(executed.state);
        const undone = undo(executed).history;
        expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
        expectRingHierarchyValid(undone.state);
        expectAggregateForestValid(undone.state);
        const redone = redo(undone).history;
        expect(viewSeries(redone.state)).toEqual(viewSeries(after));
        expectRingHierarchyValid(redone.state);
        expectAggregateForestValid(redone.state);
      }),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });

  it('metamorphic: undoing every executed edit returns to the root (rich, seed 4004)', () => {
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let history = createHistory(initial, 100);
          let pushed = 0;
          for (const op of ops) {
            const after = applyRichEdit(history.state, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, history.state, after),
            ).history;
            pushed += 1;
          }
          for (let i = 0; i < pushed; i += 1) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          expectRingHierarchyValid(history.state);
          expectAggregateForestValid(history.state);
        },
      ),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });

  it('full-fidelity save∘load == identity for any reachable rich series (seed 4004)', () => {
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyRichEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectRichSaveLoadIdentity(s);
        },
      ),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });
});
