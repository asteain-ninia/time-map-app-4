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
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  type TimePoint,
} from '../time/time-point';
import { compare } from '../time/normalized';
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

// ===========================================================================
// SEED 24001 expansion suite — MIXED-GRANULARITY time points + new interactions.
//
// Independently-pinned (seed 24001), a NEW exploration distinct from the
// 4001/4002/4004 passes. Two structural gaps motivate this suite:
//
//   1. EVERY existing suite builds anchor starts/ends with `timePointYear`
//      only. The calendar comparison contract (compare → normalize over WHOLE
//      DAYS) treats a year-only point as Jan-1 of that year, so two anchors a
//      year apart are always >= 365 days apart and a sub-year ordering can
//      never be generated. This suite drives anchors whose starts AND ends are
//      year / yearMonth / yearMonthDay points, so changeStart / setEnd /
//      applyPastEdit must order, dedup-by-start, and shorten-overrun using the
//      day-level normalized comparison — e.g. two distinct entries whose starts
//      share a year but differ by month, an end set to the same MONTH as the
//      next start, or a changeStart that crosses a neighbor by a single day.
//      A bug that compared by year scalar (rather than via normalize) or that
//      mishandled a same-year tie under dedup would surface only here.
//
//   2. NEW interaction patterns the 4001/4002 streams do not cover:
//        - resolveAt over ARBITRARY probe times spanning the whole timeline
//          (not only entry starts): the resolved anchor must always be a real
//          present entry, never a phantom (selection-always-valid, strengthened
//          to off-anchor probes including mid-interval, gap, and post-end).
//        - history BRANCH DIVERGENCE: execute → undo → execute. The second
//          execute must DROP the redo stack (FR-74), and the post-divergence
//          state + every invariant must hold; a stale redo entry must not be
//          replayable onto the diverged branch.
//
// Determinism: pinned seed 24001, large run budget. Permanent asset; must NOT
// be relaxed to paint a broken existing behavior green.
// ===========================================================================

const SEED_24001 = 24001;
const NUM_RUNS_24001 = 500;

/**
 * A mixed-granularity TimePoint generator that always yields a calendar-VALID
 * point (routed implicitly through the same day-counts `validate` enforces): a
 * year in a tight band so anchors can land in the same year, plus an optional
 * month (1..12) and an optional day (1..28 — always valid in every Gregorian
 * month, including February, leap or not). Sub-year resolution lets the suite
 * generate same-year-different-month anchors that year-only points cannot.
 */
const mixedTimePointArb: fc.Arbitrary<TimePoint> = fc.oneof(
  fc.record({ year: fc.integer({ min: -30, max: 30 }) }).map((r) => timePointYear(r.year)),
  fc
    .record({
      year: fc.integer({ min: -30, max: 30 }),
      month: fc.integer({ min: 1, max: 12 }),
    })
    .map((r) => timePointYearMonth(r.year, r.month)),
  fc
    .record({
      year: fc.integer({ min: -30, max: 30 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
    })
    .map((r) => timePointYearMonthDay(r.year, r.month, r.day)),
);

/**
 * A valid, non-empty anchor series whose entry STARTS span mixed granularity.
 * Distinct points are generated, sorted by the real calendar comparison, and a
 * subset get a bounded end placed at the next entry's start (gapless adjacency
 * at day resolution) — then funneled through the real normalizeSeries so the
 * result is guaranteed valid even where two generated points share a year.
 */
function mixedAnchorSeriesArb(): fc.Arbitrary<AnchorSeries> {
  return fc
    .uniqueArray(mixedTimePointArb, {
      minLength: 1,
      maxLength: 6,
      comparator: (a, b) => compareMixedForUnique(a, b),
    })
    .chain((points) => {
      const sorted = [...points].sort((a, b) => compareTP(a, b));
      const endChoice = fc.array(fc.boolean(), {
        minLength: sorted.length,
        maxLength: sorted.length,
      });
      return endChoice.map((wantEnd) => {
        const entries: AnchorEntry[] = sorted.map((start, i) => {
          const anchor = makeAnchor(i + 1, `-mx${i}`);
          const next = sorted[i + 1];
          // Bounded end == next start (INV-2 boundary) when chosen and a next
          // exists; otherwise open-ended. normalizeSeries repairs any residual.
          const end = wantEnd[i] && next !== undefined ? next : null;
          return createAnchorEntry(anchor, start, end);
        });
        return normalizeSeries(entries, cal);
      });
    });
}

/** Strict structural comparison used only to dedupe generated points so the
 * uniqueArray comparator removes calendar-equal points (same normalized day),
 * which would otherwise be collapsed by normalizeSeries and shrink the series. */
function compareMixedForUnique(a: TimePoint, b: TimePoint): boolean {
  return compareTP(a, b) === 0;
}

/** Calendar comparison shorthand for the local generators. */
function compareTP(a: TimePoint, b: TimePoint): number {
  return compare(a, b, cal);
}

/** A probe-time generator spanning the timeline (well before the earliest start
 * to well after the latest), at mixed granularity, for off-anchor resolveAt. */
const probeTimeArb: fc.Arbitrary<TimePoint> = mixedTimePointArb;

/** resolveAt at an ARBITRARY probe must yield either `absent` or a `present`
 * entry that is a REAL member of the series (never a phantom anchor id), and a
 * present resolution's interval must actually contain the probe (start<=probe,
 * and probe<end when bounded). This strengthens selection-validity to
 * off-anchor probe times (mid-interval / gap / post-end). */
function expectProbeSelectionValid(s: AnchorSeries, probe: TimePoint): void {
  const ids = new Set(s.entries.map((e) => e.anchor.id));
  const r = resolveAt(s, probe, cal);
  if (r.kind === 'present') {
    expect(ids.has(r.entry.anchor.id)).toBe(true);
    // start is inclusive: probe must be at or after the resolved start.
    expect(compare(r.entry.start, probe, cal)).toBeLessThanOrEqual(0);
    // end is exclusive: a bounded resolved entry must end strictly after probe.
    if (r.entry.end !== null) {
      expect(compare(probe, r.entry.end, cal)).toBeLessThan(0);
    }
    // The resolved entry must be the one with the GREATEST start <= probe.
    for (const e of s.entries) {
      if (compare(e.start, probe, cal) <= 0) {
        expect(compare(e.start, r.entry.start, cal)).toBeLessThanOrEqual(0);
      }
    }
  }
}

/** Apply one abstract edit using MIXED-granularity time points. Mirrors
 * applyEdit but draws start/end from the mixed arbitrary's value space (passed
 * in pre-resolved on the EditOp). */
type MixedEditOp =
  | { readonly kind: 'changeStart'; readonly target: number; readonly start: TimePoint }
  | { readonly kind: 'setEnd'; readonly target: number; readonly end: TimePoint | null }
  | { readonly kind: 'delete'; readonly target: number }
  | { readonly kind: 'pastEdit'; readonly at: TimePoint; readonly seed: number };

const mixedEditOpArb: fc.Arbitrary<MixedEditOp> = fc.oneof(
  fc.record({
    kind: fc.constant('changeStart' as const),
    target: fc.nat(),
    start: mixedTimePointArb,
  }),
  fc.record({
    kind: fc.constant('setEnd' as const),
    target: fc.nat(),
    end: fc.option(mixedTimePointArb, { nil: null }),
  }),
  fc.record({ kind: fc.constant('delete' as const), target: fc.nat() }),
  fc.record({
    kind: fc.constant('pastEdit' as const),
    at: mixedTimePointArb,
    seed: fc.integer({ min: 0, max: 100000 }),
  }),
);

function applyMixedEdit(s: AnchorSeries, op: MixedEditOp): AnchorSeries | undefined {
  const idAt = (i: number) => s.entries[i % s.entries.length]!.anchor.id;
  let next: AnchorSeries | undefined;
  if (op.kind === 'changeStart') {
    const r = changeStart(s, idAt(op.target), op.start, cal);
    next = r.ok ? r.series : undefined;
  } else if (op.kind === 'setEnd') {
    const r = setEnd(s, idAt(op.target), op.end, cal);
    next = r.ok ? r.series : undefined;
  } else if (op.kind === 'delete') {
    const r = deleteAnchor(s, idAt(op.target), cal);
    next = r.ok ? r.series : undefined;
  } else {
    next = applyPastEdit(s, op.at, () => makeAnchor(op.seed, `-mpe-${op.seed}`), cal);
  }
  if (next === undefined) return undefined;
  if (JSON.stringify(viewSeries(next)) === JSON.stringify(viewSeries(s))) {
    return undefined;
  }
  return next;
}

interface MixedAction {
  readonly t: 'edit' | 'undo' | 'redo';
  readonly op?: MixedEditOp;
}

const mixedActionArb: fc.Arbitrary<MixedAction> = fc.oneof(
  mixedEditOpArb.map((op) => ({ t: 'edit' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'redo' as const }),
);

describe('time-anchor + history undo/redo — seed 24001 mixed-granularity expansion', () => {
  it('mixed-granularity series keep every invariant through edit/undo/redo (seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedActionArb, { maxLength: 28 }),
        (initial, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyMixedEdit(before, action.op);
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
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('resolveAt over arbitrary probe times is always selection-valid (mixed, seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedEditOpArb, { maxLength: 14 }),
        fc.array(probeTimeArb, { minLength: 1, maxLength: 8 }),
        (initial, ops, probes) => {
          let s = initial;
          for (const op of ops) {
            const after = applyMixedEdit(s, op);
            if (after !== undefined) s = after;
          }
          // Series invariants hold on the reachable state…
          expectAllInvariants(s);
          // …and resolveAt is selection-valid at every probe (incl. off-anchor).
          for (const probe of probes) {
            expectProbeSelectionValid(s, probe);
          }
          // Plus the standard at-start selection-validity.
          expectSelectionValid(s);
        },
      ),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('metamorphic: undo∘execute == identity over mixed-granularity edits (seed 24001)', () => {
    fc.assert(
      fc.property(mixedAnchorSeriesArb(), mixedEditOpArb, (initial, op) => {
        const history0 = createHistory(initial, 50);
        const after = applyMixedEdit(history0.state, op);
        if (after === undefined) return;
        const executed = execute(
          history0,
          makeSeriesCommand(op.kind, history0.state, after),
        ).history;
        expect(viewSeries(executed.state)).toEqual(viewSeries(after));
        const undone = undo(executed).history;
        expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
        const redone = redo(undone).history;
        expect(viewSeries(redone.state)).toEqual(viewSeries(after));
      }),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('history branch divergence: execute after undo drops the redo branch (seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        mixedEditOpArb,
        mixedEditOpArb,
        (initial, opA, opB) => {
          let history: History<AnchorSeries> = createHistory(initial, 50);

          // First edit (A): need a real change to have something to undo.
          const afterA = applyMixedEdit(history.state, opA);
          if (afterA === undefined) return;
          history = execute(
            history,
            makeSeriesCommand(opA.kind, history.state, afterA),
          ).history;
          const stateAfterA = history.state;

          // Undo A → back to root, A now sits on the redo stack.
          history = undo(history).history;
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          expect(history.redoStack.length).toBe(1);

          // Diverge: execute a DIFFERENT edit (B) from the root. Per FR-74 this
          // must clear the redo stack entirely so the undone A can never be
          // replayed onto the B branch.
          const afterB = applyMixedEdit(history.state, opB);
          if (afterB === undefined) {
            // B was a no-op/rejected from root; redo of A must still be possible
            // and must restore exactly the post-A state (history still coherent).
            const redoneA = redo(history).history;
            expect(viewSeries(redoneA.state)).toEqual(viewSeries(stateAfterA));
            assertStepInvariants(redoneA.state);
            return;
          }
          history = execute(
            history,
            makeSeriesCommand(opB.kind, history.state, afterB),
          ).history;

          // Redo stack dropped; state is the B branch and every invariant holds.
          expect(history.redoStack.length).toBe(0);
          expect(viewSeries(history.state)).toEqual(viewSeries(afterB));
          assertStepInvariants(history.state);

          // A redo() now is a no-op (nothing to redo) — the stale A is gone.
          const afterRedoAttempt = redo(history).history;
          expect(viewSeries(afterRedoAttempt.state)).toEqual(viewSeries(afterB));
          assertStepInvariants(afterRedoAttempt.state);

          // Undo of B returns to the root (single-step branch is coherent).
          const undoneB = undo(history).history;
          expect(viewSeries(undoneB.state)).toEqual(viewSeries(initial));
          assertStepInvariants(undoneB.state);
        },
      ),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('save∘load == identity for any reachable mixed-granularity series (seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedEditOpArb, { maxLength: 18 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyMixedEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectSaveLoadIdentity(s);
        },
      ),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });
});
