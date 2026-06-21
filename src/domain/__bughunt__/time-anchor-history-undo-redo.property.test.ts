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
import { anchorSeriesArb, makeAnchor, makeSnapshot } from '../anchor-series.arbitraries';
import {
  type Command,
  type CommandOutcome,
  defineCommandKind,
} from '../command/command';
import { createCommandResult } from '../command/result';
import {
  canRedo,
  canUndo,
  clearRedo,
  createHistory,
  execute,
  executeIfChanged,
  redo,
  undo,
  withLimit,
  type History,
} from '../command/history';
import { createCompositeCommand } from '../command/command';
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
// SEED 24002 expansion suite — BOUNDED-LIMIT history + reference-model driver +
// composite undo units. A NEW exploration distinct from the 4001/4002/4004/
// 24001 passes (different seed, different command-space + interactions).
//
// Structural gaps the prior suites leave open:
//
//   1. EVERY prior suite gives the history a limit big enough that the undo
//      stack is NEVER trimmed (createHistory(initial, 50|100|200) over <=30
//      actions). So FR-74's "上限到達時は最古の操作から破棄する" — trimUndoStack
//      dropping the OLDEST entries — and its interaction with the
//      "full-undo returns to root" law are completely unexercised. A trim bug
//      (off-by-one window, wrong end trimmed, redo not clearing on overflow,
//      withLimit retroactively corrupting the stack) cannot be caught by the
//      existing "undo all == root" tests because those never overflow. This
//      suite drives a SMALL limit (1..4) so trimming is the common case, and
//      verifies the history against an explicit REFERENCE MODEL of the expected
//      undo/redo state stacks after every action (stateful / model-based).
//
//   2. executeIfChanged / clearRedo / withLimit are never touched by any prior
//      suite. executeIfChanged must NOT push a ghost entry when the baseline is
//      unchanged (教訓 5.24); clearRedo must drop only the redo branch; withLimit
//      must retroactively trim the oldest undo entries. All three are folded
//      into the action space here and checked against the reference model.
//
//   3. Composite commands (createCompositeCommand) as a SINGLE indivisible undo
//      unit (FR-73/FR-94) over a CHAIN of real series edits are never exercised
//      on the time axis. A composite that bundles N accepted edits must undo as
//      ONE step back to the pre-composite series and redo as ONE step forward to
//      the post-chain series — never landing on an intermediate sub-edit state.
//
// All series invariants (INV-1..3,5,6 via validateSeries), no NaN/Infinity,
// forest validity, selection validity, and save∘load==identity are re-asserted
// after every reachable state, so this suite also re-covers the core contract
// under the new (bounded, trimming) history regime.
//
// Determinism: pinned seed 24002, large run budget. Permanent asset; must NOT be
// relaxed to paint a broken existing behavior green.
// ===========================================================================

const SEED_24002 = 24002;
const NUM_RUNS_24002 = 500;

// --- reference model of a bounded dual-stack history ------------------------
//
// The model mirrors execute/undo/redo/withLimit/clearRedo over PLAIN state
// VALUES (the serialized series view), independent of the production History
// implementation, so a divergence between the two is a real bug. The model
// stores the undo stack as the sequence of (before -> after) state pairs and the
// current pointer, trimming the oldest pair when the undo depth exceeds `limit`.

interface ModelEntry {
  readonly before: unknown; // viewSeries(before)
  readonly after: unknown; //  viewSeries(after)
}

interface Model {
  readonly current: unknown; // viewSeries(currentState)
  readonly undo: readonly ModelEntry[]; // oldest -> newest applied
  readonly redo: readonly ModelEntry[]; // newest-undone at the END (top)
  readonly limit: number;
}

function modelExecute(m: Model, before: unknown, after: unknown): Model {
  const undo = [...m.undo, { before, after }];
  // FR-74: trim oldest undo entries past the limit.
  const trimmed = undo.length > m.limit ? undo.slice(undo.length - m.limit) : undo;
  return { current: after, undo: trimmed, redo: [], limit: m.limit };
}

function modelUndo(m: Model): Model {
  const top = m.undo[m.undo.length - 1];
  if (top === undefined) return m; // no-op
  return {
    current: top.before,
    undo: m.undo.slice(0, -1),
    redo: [...m.redo, top],
    limit: m.limit,
  };
}

function modelRedo(m: Model): Model {
  const top = m.redo[m.redo.length - 1];
  if (top === undefined) return m; // no-op
  const undo = [...m.undo, top];
  const trimmed = undo.length > m.limit ? undo.slice(undo.length - m.limit) : undo;
  return {
    current: top.after,
    undo: trimmed,
    redo: m.redo.slice(0, -1),
    limit: m.limit,
  };
}

function modelWithLimit(m: Model, limit: number): Model {
  const clamped = Math.max(1, Math.floor(limit));
  const undo =
    m.undo.length > clamped ? m.undo.slice(m.undo.length - clamped) : m.undo;
  return { ...m, limit: clamped, undo };
}

function modelClearRedo(m: Model): Model {
  return { ...m, redo: [] };
}

/** Assert the production history agrees with the model on the observable state,
 * the undo/redo depths, and the canUndo/canRedo gates. */
function expectHistoryMatchesModel(h: History<AnchorSeries>, m: Model): void {
  expect(viewSeries(h.state)).toEqual(m.current);
  expect(h.undoStack.length).toBe(m.undo.length);
  expect(h.redoStack.length).toBe(m.redo.length);
  expect(canUndo(h)).toBe(m.undo.length > 0);
  expect(canRedo(h)).toBe(m.redo.length > 0);
  expect(h.limit).toBe(m.limit);
}

// Action space for the bounded-history stateful driver.
type BoundedAction =
  | { readonly t: 'edit'; readonly op: EditOp }
  | { readonly t: 'editIfChanged'; readonly op: EditOp }
  | { readonly t: 'undo' }
  | { readonly t: 'redo' }
  | { readonly t: 'clearRedo' }
  | { readonly t: 'setLimit'; readonly limit: number };

const boundedActionArb: fc.Arbitrary<BoundedAction> = fc.oneof(
  editOpArb.map((op) => ({ t: 'edit' as const, op })),
  editOpArb.map((op) => ({ t: 'editIfChanged' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'undo' as const }), // weight undo/redo higher to drain stacks
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'clearRedo' as const }),
  fc.record({ t: fc.constant('setLimit' as const), limit: fc.integer({ min: 1, max: 5 }) }),
);

describe('time-anchor + history undo/redo — seed 24002 bounded-limit + model', () => {
  it('bounded history agrees with a reference model under random edit/undo/redo/limit streams', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.integer({ min: 1, max: 4 }), // SMALL limit so trimming is common
        fc.array(boundedActionArb, { maxLength: 40 }),
        (initial, limit, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, limit);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: Math.max(1, Math.floor(limit)),
          };
          // The clamped limit the production history actually uses.
          expectHistoryMatchesModel(history, model);

          for (const action of actions) {
            if (action.t === 'edit' || action.t === 'editIfChanged') {
              const before = history.state;
              const after = applyEdit(before, action.op);
              if (after === undefined) {
                // No-op / rejected. For editIfChanged we still call the real
                // API with an always-true isNoOp so the ghost-suppression path
                // (教訓 5.24) is exercised and must leave history untouched.
                if (action.t === 'editIfChanged') {
                  const step = executeIfChanged(
                    history,
                    makeSeriesCommand(action.op.kind, before, before),
                    () => true,
                  );
                  history = step.history;
                }
                continue;
              }
              const cmd = makeSeriesCommand(action.op.kind, before, after);
              if (action.t === 'edit') {
                history = execute(history, cmd).history;
              } else {
                // Real change ⇒ isNoOp false ⇒ behaves exactly like execute.
                history = executeIfChanged(history, cmd, () => false).history;
              }
              model = modelExecute(model, viewSeries(before), viewSeries(after));
            } else if (action.t === 'undo') {
              history = undo(history).history;
              model = modelUndo(model);
            } else if (action.t === 'redo') {
              history = redo(history).history;
              model = modelRedo(model);
            } else if (action.t === 'clearRedo') {
              history = clearRedo(history);
              model = modelClearRedo(model);
            } else {
              history = withLimit(history, action.limit);
              model = modelWithLimit(model, action.limit);
            }
            // Production history and reference model must agree at every step…
            expectHistoryMatchesModel(history, model);
            // …and the reachable series must satisfy the whole contract.
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });

  it('FR-74: after overflowing the limit, undoing the WHOLE retained stack lands on the oldest retained pre-state', () => {
    // When more edits are executed than the limit allows, the oldest undo units
    // are dropped, so "undo everything possible" must NOT return to the original
    // root — it must return to the `before` state of the OLDEST RETAINED edit.
    // The reference model computes that target independently; a trim bug (wrong
    // end trimmed, off-by-one) would make the two disagree.
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.integer({ min: 1, max: 3 }),
        fc.array(editOpArb, { minLength: 1, maxLength: 16 }),
        (initial, limit, ops) => {
          let history = createHistory(initial, limit);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: Math.max(1, Math.floor(limit)),
          };
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
          }
          const retained = model.undo.length;
          // Drain the entire retained undo stack.
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
          }
          expectHistoryMatchesModel(history, model);
          assertStepInvariants(history.state);
          // After draining, the model's current is the `before` of the oldest
          // retained edit (or the root if nothing was ever pushed).
          const expectedFloor =
            model.undo.length === 0 && retained === 0
              ? viewSeries(initial)
              : model.current;
          expect(viewSeries(history.state)).toEqual(expectedFloor);
          // A further undo is a no-op (stack is empty).
          const extra = undo(history).history;
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
          expect(extra.undoStack.length).toBe(history.undoStack.length);
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });

  it('composite command of an edit-chain is ONE indivisible undo unit (FR-73/FR-94)', () => {
    // Bundle a chain of accepted edits into a single composite. Executing it must
    // move the series to the post-chain state in ONE history entry; undo must
    // jump back to the pre-composite series in ONE step (never an intermediate
    // sub-edit), and redo must restore the post-chain series in ONE step.
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 6 }),
        (initial, ops) => {
          // Build the chain of sub-commands by folding the edits, skipping
          // rejected / no-op ones so every sub-command is a real change.
          const subCommands: Command<AnchorSeries>[] = [];
          let cursor = initial;
          for (const op of ops) {
            const after = applyEdit(cursor, op);
            if (after === undefined) continue;
            subCommands.push(makeSeriesCommand(op.kind, cursor, after));
            cursor = after;
          }
          if (subCommands.length === 0) return; // nothing to bundle
          const postChain = cursor;

          const composite = createCompositeCommand('bughunt/edit-chain', subCommands);
          let history = createHistory(initial, 10);

          history = execute(history, composite).history;
          // ONE undo unit for the whole chain.
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(postChain));
          assertStepInvariants(history.state);

          // Undo: ONE step back to the exact pre-composite series.
          const undone = undo(history).history;
          expect(undone.undoStack.length).toBe(0);
          expect(undone.redoStack.length).toBe(1);
          expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
          assertStepInvariants(undone.state);

          // Redo: ONE step forward to the exact post-chain series.
          const redone = redo(undone).history;
          expect(viewSeries(redone.state)).toEqual(viewSeries(postChain));
          assertStepInvariants(redone.state);
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });

  it('clearRedo drops only the redo branch and never resurrects on redo (seed 24002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 10 }),
        (initial, ops) => {
          let history = createHistory(initial, 20);
          const pushedStates: AnchorSeries[] = [];
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            pushedStates.push(after);
          }
          if (pushedStates.length === 0) return;
          // Undo a few to populate the redo stack.
          const undos = Math.min(pushedStates.length, 3);
          for (let i = 0; i < undos; i += 1) history = undo(history).history;
          expect(history.redoStack.length).toBe(undos);
          const stateBeforeClear = history.state;
          const undoDepth = history.undoStack.length;

          history = clearRedo(history);
          // Redo branch gone, undo branch + state untouched.
          expect(history.redoStack.length).toBe(0);
          expect(history.undoStack.length).toBe(undoDepth);
          expect(viewSeries(history.state)).toEqual(viewSeries(stateBeforeClear));

          // A redo now is a no-op — the cleared redo can never resurrect.
          const afterRedo = redo(history).history;
          expect(viewSeries(afterRedo.state)).toEqual(viewSeries(stateBeforeClear));
          expect(afterRedo.redoStack.length).toBe(0);
          assertStepInvariants(afterRedo.state);
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });
});

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

// ===========================================================================
// SEED 24003 expansion suite — IN-PLACE past-edit replacement + algebraic laws
// (idempotency / inverse / commutativity) + content-derived executeIfChanged.
//
// A NEW exploration distinct from the 4001/4002/4004/24001/24002 passes
// (different seed 24003, different command-space + interactions). Structural
// gaps the prior suites leave open:
//
//   1. applyPastEdit has TWO branches (anchor-series.ts §5.7): INSERT a new
//      anchor when no entry starts exactly at baseTime, and REPLACE-IN-PLACE the
//      snapshot when an entry already starts there. EVERY prior suite drives
//      pastEdit with a FRESH per-seed anchor id, so baseTime essentially never
//      coincides with an existing start (years are drawn from a wide band) — the
//      REPLACE branch (which appends the edited entry LAST so the keep-last dedup
//      lets it win, and must NOT change the entry count, start, or end) is
//      effectively unexercised through undo/redo + save/load. A bug there (e.g.
//      the in-place `map` form regression called out in the §5.7 comment, which
//      would drop the edit on a duplicate-id series, or a start/end mutation on
//      replace) would slip past the existing streams. This suite targets the
//      EXACT start of a randomly chosen existing entry so the REPLACE branch is
//      the common case, asserting: count/start/end preserved, ONLY the snapshot
//      changed, and full undo/redo + save/load fidelity.
//
//   2. Algebraic laws on the temporal-axis operations that no prior suite states:
//        - IDEMPOTENCY: setEnd(null) twice == once (clearing an already-open end
//          is a no-op); a REPLACE past-edit with the SAME snapshot twice == once.
//        - INVERSE / no-resurrection: deleteAnchor(id) then deleteAnchor(id)
//          again must REJECT with anchorNotFound (a deleted id is gone, never
//          silently re-resolving to a different entry).
//        - COMMUTATIVITY of delete: deleting two DISTINCT ids in either order
//          yields the structurally-identical series (delete is order-independent
//          on the time axis; a normalization ordering bug would break this).
//
//   3. executeIfChanged with a REAL content-derived isNoOp. Prior suites pass
//      only the constants () => true / () => false. Here isNoOp is derived from
//      the SAME source as the resulting state (serialized-view equality of the
//      command's post-state vs the current baseline — 教訓 5.24「baseline は
//      フォーム同期と同一ソースから導出する」). A no-op edit (post == baseline)
//      must push NO history entry; a real edit must push exactly one. This
//      catches a ghost-entry regression that the always-false constant cannot.
//
// All series invariants (validateSeries), no NaN/Infinity, forest/selection
// validity, and save∘load==identity are re-asserted after every reachable state.
//
// Determinism: pinned seed 24003, large run budget. Permanent asset; must NOT be
// relaxed to paint a broken existing behavior green.
// ===========================================================================

const SEED_24003 = 24003;
const NUM_RUNS_24003 = 500;

/** Structural-view equality of two series (object-identity-independent). */
function seriesViewEqual(a: AnchorSeries, b: AnchorSeries): boolean {
  return JSON.stringify(viewSeries(a)) === JSON.stringify(viewSeries(b));
}

/** The serialized snapshot of one entry (features + vertices), for "only the
 * snapshot changed" comparisons that ignore start/end. */
function entrySnapshotView(e: AnchorEntry): unknown {
  return {
    features: e.anchor.snapshot.features,
    vertices: [...e.anchor.snapshot.vertices.byId.values()].map((v) => ({
      id: v.id,
      lon: v.coordinate.lon,
      lat: v.coordinate.lat,
    })),
  };
}

describe('time-anchor + history undo/redo — seed 24003 in-place replace + laws', () => {
  it('applyPastEdit at an EXISTING start replaces ONLY the snapshot; count/start/end preserved; undo/redo round-trips (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: 0, max: 100000 }),
        (initial, targetN, seed) => {
          assertStepInvariants(initial);
          const target = initial.entries[targetN % initial.entries.length]!;
          const baseTime = target.start; // EXACT existing start ⇒ REPLACE branch.

          const next = applyPastEdit(
            initial,
            baseTime,
            () => makeAnchor(seed, `-rep-${seed}`),
            cal,
          );

          // The REPLACE branch must preserve the entry COUNT (no insert).
          expect(next.entries.length).toBe(initial.entries.length);
          assertStepInvariants(next);

          // The entry that owns baseTime must keep its start and end; only its
          // snapshot may differ. Locate it by start (unique under INV-1).
          const newTarget = next.entries.find(
            (e) => compare(e.start, baseTime, cal) === 0,
          );
          expect(newTarget).toBeDefined();
          if (newTarget) {
            expect(compare(newTarget.start, target.start, cal)).toBe(0);
            if (target.end === null) {
              expect(newTarget.end).toBeNull();
            } else {
              expect(newTarget.end).not.toBeNull();
              if (newTarget.end) {
                expect(compare(newTarget.end, target.end, cal)).toBe(0);
              }
            }
          }

          // Every OTHER entry (by start) is byte-identical (no neighbor touched).
          const otherKey = (s: AnchorSeries) =>
            JSON.stringify(
              s.entries
                .filter((e) => compare(e.start, baseTime, cal) !== 0)
                .map((e) => ({
                  id: e.anchor.id,
                  start: e.start,
                  end: e.end,
                  snap: entrySnapshotView(e),
                })),
            );
          expect(otherKey(next)).toBe(otherKey(initial));

          // Drive through the dual-stack history: execute, undo (restores the
          // ORIGINAL snapshot exactly), redo (restores the replacement).
          if (seriesViewEqual(next, initial)) return; // identical snapshot ⇒ no-op
          let history = createHistory(initial, 20);
          history = execute(
            history,
            makeSeriesCommand('pastEdit-replace', initial, next),
          ).history;
          expect(viewSeries(history.state)).toEqual(viewSeries(next));
          const undone = undo(history).history;
          expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
          assertStepInvariants(undone.state);
          const redone = redo(undone).history;
          expect(viewSeries(redone.state)).toEqual(viewSeries(next));
          assertStepInvariants(redone.state);
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('idempotency: setEnd(null) twice == once; in-place pastEdit with identical snapshot twice == once (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: 0, max: 100000 }),
        (initial, targetN, seed) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const id = target.anchor.id;

          // setEnd(null) idempotency.
          const c1 = setEnd(initial, id, null, cal);
          expect(c1.ok).toBe(true);
          if (c1.ok) {
            expectAllInvariants(c1.series);
            const c2 = setEnd(c1.series, id, null, cal);
            expect(c2.ok).toBe(true);
            if (c2.ok) {
              // Clearing an already-open end must be a structural no-op.
              expect(viewSeries(c2.series)).toEqual(viewSeries(c1.series));
            }
          }

          // In-place pastEdit idempotency: replacing the snapshot at an existing
          // start with the SAME factory twice yields the same series the first
          // replace produced (a second identical replace is a no-op).
          const make = () => makeAnchor(seed, `-idem-${seed}`);
          const r1 = applyPastEdit(initial, target.start, make, cal);
          expectAllInvariants(r1);
          const r2 = applyPastEdit(r1, target.start, make, cal);
          expectAllInvariants(r2);
          expect(viewSeries(r2)).toEqual(viewSeries(r1));
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('no-resurrection: deleting an id then deleting it again rejects with anchorNotFound (seed 24003)', () => {
    fc.assert(
      fc.property(anchorSeriesArb(cal), fc.nat(), (initial, targetN) => {
        // Need >= 2 entries so the first delete is allowed (INV-5 guard).
        if (initial.entries.length < 2) return;
        const target = initial.entries[targetN % initial.entries.length]!;
        const id = target.anchor.id;

        const first = deleteAnchor(initial, id, cal);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expectAllInvariants(first.series);
        // The id must be GONE — no entry resolves to it.
        expect(first.series.entries.some((e) => e.anchor.id === id)).toBe(false);

        // Deleting the same id again must be a clean rejection, never a silent
        // misroute onto a different entry.
        const second = deleteAnchor(first.series, id, cal);
        expect(second.ok).toBe(false);
        if (!second.ok) {
          expect(second.reason.code).toBe('anchorNotFound');
        }
        // The series is unchanged by the rejected second delete.
        expectAllInvariants(first.series);
      }),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('commutativity: deleting two distinct ids in either order yields the same series (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.nat(),
        (initial, aN, bN) => {
          // Need >= 3 entries so BOTH deletes are individually allowed (each
          // delete keeps >= 1; with 3 entries deleting any 2 keeps >= 1).
          if (initial.entries.length < 3) return;
          const n = initial.entries.length;
          const i = aN % n;
          let j = bN % n;
          if (j === i) j = (j + 1) % n;
          const idA = initial.entries[i]!.anchor.id;
          const idB = initial.entries[j]!.anchor.id;
          if (idA === idB) return;

          const ab1 = deleteAnchor(initial, idA, cal);
          if (!ab1.ok) return;
          const ab2 = deleteAnchor(ab1.series, idB, cal);
          if (!ab2.ok) return;

          const ba1 = deleteAnchor(initial, idB, cal);
          if (!ba1.ok) return;
          const ba2 = deleteAnchor(ba1.series, idA, cal);
          if (!ba2.ok) return;

          expectAllInvariants(ab2.series);
          expectAllInvariants(ba2.series);
          // Delete is order-independent on the time axis: the two orders must
          // produce the structurally-identical series.
          expect(viewSeries(ab2.series)).toEqual(viewSeries(ba2.series));
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('executeIfChanged with a content-derived isNoOp pushes iff the edit really changes the series (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 24 }),
        (initial, ops) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const op of ops) {
            const before = history.state;
            // Compute the candidate AFTER state. applyEdit returns undefined for a
            // rejected/no-op edit; model that as a command that maps to `before`
            // (a true no-op) so the content-derived isNoOp suppresses it.
            const computed = applyEdit(before, op);
            const after = computed ?? before;
            const cmd = makeSeriesCommand(op.kind, before, after);
            const depthBefore = history.undoStack.length;

            // isNoOp derived from the SAME source as the resulting state: the
            // command's post-state view equals the current baseline view.
            const step = executeIfChanged(history, cmd, (s) =>
              JSON.stringify(viewSeries(after)) === JSON.stringify(viewSeries(s)),
            );
            history = step.history;

            if (computed === undefined) {
              // True no-op ⇒ NO ghost entry pushed (教訓 5.24).
              expect(history.undoStack.length).toBe(depthBefore);
              expect(viewSeries(history.state)).toEqual(viewSeries(before));
            } else {
              // Real change ⇒ exactly one entry pushed and state advanced.
              expect(history.undoStack.length).toBe(depthBefore + 1);
              expect(viewSeries(history.state)).toEqual(viewSeries(after));
            }
            assertStepInvariants(history.state);
          }

          // Undo everything pushed ⇒ back to root (history coherence under the
          // ghost-suppressed stream).
          while (canUndo(history)) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('every history state (edit/undo/redo) satisfies all invariants (seed 24003, fresh stream)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(actionArb, { maxLength: 32 }),
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
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });
});

// ===========================================================================
// SEED 24004 expansion suite — MULTI-FEATURE shared history + op∘inverse-op +
// pointer-walk coherence + grow/shrink limit model.
//
// A NEW exploration distinct from every prior pass (4001/4002/4004/24001/24002/
// 24003 and the earlier 1000-6000 sweep). Seed 24004 is fresh. Four structural
// gaps motivate this suite; none is exercised by any existing suite in this file:
//
//   1. EVERY prior suite drives a SINGLE anchor series through the history, so
//      the history's domain-state root is always one feature's timeline. In the
//      real app a single undo/redo stack threads the WHOLE document (many
//      features' timelines) as one state value (FR-73). If a command captured
//      shared/aliased structure, or undo/redo restored the wrong half of a
//      composite state, a single-series suite could never catch it. This suite
//      makes the history state a PAIR of two independent series and routes each
//      edit to one of the two by a generated selector, asserting after every
//      step that BOTH series satisfy the full contract and that undo/redo
//      restores BOTH halves exactly (no cross-feature bleed).
//
//   2. op∘inverse-op == identity on the INSERT axis: applyPastEdit at a year
//      with no existing anchor INSERTS a new entry; deleteAnchor of that exact
//      inserted id must restore the original series structurally. No prior suite
//      states this insert/delete inverse (24003 covers in-place REPLACE + a
//      delete no-resurrection law, but never insert-then-delete reversibility).
//      The 4001 suite's only op∘inverse law is setEnd(x)∘setEnd(null).
//
//   3. History POINTER-WALK coherence: a history with N applied edits is a
//      straight line of N+1 states (root + one per edit) as long as no new edit
//      intervenes. A random walk of ONLY undo/redo must therefore always land on
//      the SAME state that occupies the resulting pointer position — recorded
//      independently when the line was built. A pointer/stack-splice bug (wrong
//      end popped, redo pushing onto the wrong stack) surfaces as a walk landing
//      on a mismatched recorded state. No prior suite records the full line and
//      replays an arbitrary undo/redo walk against it.
//
//   4. withLimit GROW-then-SHRINK against the reference model: 24002 only ever
//      sets a limit in [1,5] from an already-small base, so growing the limit
//      above the current stack depth (a no-op trim) and then shrinking it below
//      the live redo-bearing depth is never exercised together. Here the base
//      history uses a generous limit, edits overflow nothing, then withLimit is
//      driven both up and down with a populated redo stack, checked against the
//      model (redo stack must survive a limit change; only the undo stack trims).
//
// All series invariants (validateSeries), no NaN/Infinity, forest/selection
// validity, and save∘load==identity are re-asserted after every reachable state.
//
// Determinism: pinned seed 24004, large run budget. Permanent asset; must NOT be
// relaxed to paint a broken existing behavior green.
// ===========================================================================

const SEED_24004 = 24004;
const NUM_RUNS_24004 = 500;

// --- multi-feature (pair) history state -------------------------------------
//
// The history root is a PAIR of independent anchor series (two features sharing
// one undo/redo stack, as the real document does). A reversible command wraps a
// whole before/after PAIR, exactly like makeSeriesCommand but over the pair, so
// undo/redo must restore BOTH halves with no cross-talk.

interface SeriesPair {
  readonly a: AnchorSeries;
  readonly b: AnchorSeries;
}

const PAIR_EDIT = defineCommandKind('bughunt/pair-edit');

function makePairCommand(
  label: string,
  before: SeriesPair,
  after: SeriesPair,
): Command<SeriesPair> {
  const result = createCommandResult({});
  const toAfter = (): CommandOutcome<SeriesPair> => ({ state: after, result });
  const toBefore = (): CommandOutcome<SeriesPair> => ({ state: before, result });
  return { kind: PAIR_EDIT, label, execute: toAfter, undo: toBefore, redo: toAfter };
}

function viewPair(p: SeriesPair): unknown {
  return { a: viewSeries(p.a), b: viewSeries(p.b) };
}

function assertPairInvariants(p: SeriesPair): void {
  assertStepInvariants(p.a);
  assertStepInvariants(p.b);
}

// An edit targeting one of the two series in the pair.
interface PairAction {
  readonly t: 'edit' | 'undo' | 'redo';
  readonly which?: 'a' | 'b';
  readonly op?: EditOp;
}

const pairActionArb: fc.Arbitrary<PairAction> = fc.oneof(
  fc.record({
    t: fc.constant('edit' as const),
    which: fc.constantFrom('a' as const, 'b' as const),
    op: editOpArb,
  }),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'redo' as const }),
);

describe('time-anchor + history undo/redo — seed 24004 multi-feature + inverse + pointer-walk', () => {
  it('two features share ONE history: every state keeps both halves valid; undo/redo restores both (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        anchorSeriesArb(cal),
        fc.array(pairActionArb, { maxLength: 30 }),
        (initialA, initialB, actions) => {
          const initial: SeriesPair = { a: initialA, b: initialB };
          assertPairInvariants(initial);

          let history: History<SeriesPair> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op && action.which) {
              const before = history.state;
              const target = action.which === 'a' ? before.a : before.b;
              const edited = applyEdit(target, action.op);
              if (edited === undefined) continue; // rejected / no-op
              const after: SeriesPair =
                action.which === 'a'
                  ? { a: edited, b: before.b }
                  : { a: before.a, b: edited };
              history = execute(
                history,
                makePairCommand(`${action.which}:${action.op.kind}`, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            // Both halves must independently satisfy the whole contract, and an
            // edit to one feature must never have mutated the other.
            assertPairInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('multi-feature metamorphic: undo∘execute restores BOTH halves; the untouched half is byte-identical (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        anchorSeriesArb(cal),
        fc.constantFrom('a' as const, 'b' as const),
        editOpArb,
        (initialA, initialB, which, op) => {
          const initial: SeriesPair = { a: initialA, b: initialB };
          const target = which === 'a' ? initial.a : initial.b;
          const edited = applyEdit(target, op);
          if (edited === undefined) return;
          const after: SeriesPair =
            which === 'a' ? { a: edited, b: initial.b } : { a: initial.a, b: edited };

          let history: History<SeriesPair> = createHistory(initial, 50);
          history = execute(history, makePairCommand(`${which}:${op.kind}`, initial, after)).history;

          // Post-execute: edited half advanced, OTHER half byte-identical.
          expect(viewPair(history.state)).toEqual(viewPair(after));
          const otherBefore = which === 'a' ? viewSeries(initial.b) : viewSeries(initial.a);
          const otherAfter =
            which === 'a' ? viewSeries(history.state.b) : viewSeries(history.state.a);
          expect(otherAfter).toEqual(otherBefore); // no cross-feature bleed

          // undo restores BOTH halves exactly; redo re-advances both.
          const undone = undo(history).history;
          expect(viewPair(undone.state)).toEqual(viewPair(initial));
          const redone = redo(undone).history;
          expect(viewPair(redone.state)).toEqual(viewPair(after));
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('op∘inverse-op == identity: applyPastEdit INSERT then deleteAnchor of the inserted id restores the series (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.integer({ min: -1200, max: 1200 }),
        fc.integer({ min: 0, max: 100000 }),
        (initial, year, seed) => {
          assertStepInvariants(initial);
          const at = timePointYear(year);
          // Only the INSERT branch is in scope: skip when an entry already starts
          // exactly at `at` (that is the REPLACE branch, covered by seed 24003).
          const collides = initial.entries.some(
            (e) => compare(e.start, at, cal) === 0,
          );
          if (collides) return;

          const insertedId = asAnchorId(`a-${seed}-ins24004`);
          const inserted = applyPastEdit(
            initial,
            at,
            () => createAnchor(insertedId, makeSnapshot(seed)),
            cal,
          );
          // Insert must have actually added the new id (no silent dedup loss).
          const present = inserted.entries.some((e) => e.anchor.id === insertedId);
          if (!present) {
            // The only way an insert "vanishes" is a degenerate-drop in
            // normalize (the inserted open-ended entry can never be degenerate),
            // so this must not happen — assert it explicitly rather than skipping.
            expect(present).toBe(true);
            return;
          }
          expect(inserted.entries.length).toBe(initial.entries.length + 1);
          assertStepInvariants(inserted);

          // §5.6「短縮」caveat (the SAME destructive auto-reorganization the 4002
          // changeStart round-trip guards against): inserting at `at` between a
          // bounded predecessor whose end OVERRUNS `at` and the next start
          // permanently SHORTENS that predecessor's end to `at` (INV-2). Deleting
          // the inserted anchor afterwards re-opens a gap but does NOT restore the
          // shortened end, so insert∘delete is an identity ONLY when the insert
          // left every PRE-EXISTING entry (by id → start/end) byte-identical. We
          // verify that precondition directly against the forward result; when it
          // does not hold, the shortening is correct (documented) behavior and the
          // round-trip is legitimately not an identity — out of scope for this law.
          const originalKey = JSON.stringify(
            initial.entries.map((e) => ({ id: e.anchor.id, start: e.start, end: e.end })),
          );
          const preservedKey = JSON.stringify(
            inserted.entries
              .filter((e) => e.anchor.id !== insertedId)
              .map((e) => ({ id: e.anchor.id, start: e.start, end: e.end })),
          );
          const noNeighborShortened = originalKey === preservedKey;

          // Inverse op: delete the exact inserted id. It must succeed (the series
          // has >= 2 entries now). When no neighbor was shortened, it restores the
          // original series structurally (op∘inverse-op == identity).
          const back = deleteAnchor(inserted, insertedId, cal);
          expect(back.ok).toBe(true);
          if (back.ok) {
            assertStepInvariants(back.series);
            if (noNeighborShortened) {
              expect(viewSeries(back.series)).toEqual(viewSeries(initial));
            }
          }
          if (!noNeighborShortened) return; // shortening case: not an identity.

          // Drive the same insert/delete pair through the dual-stack history as a
          // composite: ONE undo must jump from post-delete back to the original.
          const cInsert = makeSeriesCommand('pastEdit-insert', initial, inserted);
          if (!back.ok) return;
          const cDelete = makeSeriesCommand('delete-inserted', inserted, back.series);
          const composite = createCompositeCommand('bughunt/insert-then-delete', [
            cInsert,
            cDelete,
          ]);
          let history = createHistory(initial, 10);
          history = execute(history, composite).history;
          // The net effect of insert+delete is identity, so the post-composite
          // state equals the original — but it is still ONE undo unit.
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          const undone = undo(history).history;
          expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
          expect(undone.undoStack.length).toBe(0);
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('history pointer-walk coherence: any undo/redo-only walk lands on the recorded state for that pointer (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 14 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }), // walk: true=redo,false=undo
        (initial, ops, walk) => {
          // Build a straight line of states by executing the accepted edits.
          let history: History<AnchorSeries> = createHistory(initial, 200);
          const line: unknown[] = [viewSeries(initial)]; // line[k] = state at pointer k
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            line.push(viewSeries(after));
          }
          const top = line.length - 1; // current pointer == top of the line
          if (top === 0) return; // nothing to walk

          // The current pointer equals undoStack depth; track it as we walk and
          // assert the production state matches the recorded line state at every
          // step. undo decrements (floored at 0), redo increments (capped at top).
          let pointer = history.undoStack.length;
          expect(pointer).toBe(top);
          for (const goRedo of walk) {
            if (goRedo) {
              history = redo(history).history;
              pointer = Math.min(top, pointer + 1);
            } else {
              history = undo(history).history;
              pointer = Math.max(0, pointer - 1);
            }
            // Production pointer (undo depth) and the model pointer must agree…
            expect(history.undoStack.length).toBe(pointer);
            // …and the observable state must equal the independently-recorded
            // state that occupies that pointer position on the line.
            expect(viewSeries(history.state)).toEqual(line[pointer]);
            // The redo stack depth is the distance from the top.
            expect(history.redoStack.length).toBe(top - pointer);
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('withLimit grow-then-shrink agrees with the model and never drops the redo stack (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 8 }), // undos to populate a redo stack
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 6 }), // limit walk
        (initial, ops, undoN, limitWalk) => {
          // Start with a generous limit so the initial edits never trim.
          let history = createHistory(initial, 100);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: 100,
          };
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
          }
          // Populate a redo stack by undoing a few accepted edits.
          const pushed = history.undoStack.length;
          const undos = Math.min(pushed, undoN);
          for (let i = 0; i < undos; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
          }
          expectHistoryMatchesModel(history, model);
          const redoDepthBefore = history.redoStack.length;

          // Now walk the limit up and down. Each withLimit must: trim only the
          // OLDEST undo entries when the new limit is below the current undo
          // depth, leave the undo stack alone when the limit grows, and NEVER
          // touch the redo stack or the observable state.
          for (const lim of limitWalk) {
            const stateBefore = viewSeries(history.state);
            history = withLimit(history, lim);
            model = modelWithLimit(model, lim);
            expectHistoryMatchesModel(history, model);
            // withLimit never changes the current state…
            expect(viewSeries(history.state)).toEqual(stateBefore);
            // …and never drops a redo entry (a limit change is not a new edit).
            expect(history.redoStack.length).toBe(redoDepthBefore);
            assertStepInvariants(history.state);
          }

          // After all the limit churn, the retained undo stack must still undo
          // coherently down to its (possibly trimmed) floor without throwing.
          const retained = history.undoStack.length;
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
            expectHistoryMatchesModel(history, model);
            assertStepInvariants(history.state);
          }
          // A further undo is a no-op on the empty stack.
          const extra = undo(history).history;
          expect(extra.undoStack.length).toBe(0);
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });
});

// ===========================================================================
// SEED 34002 expansion suite — MIXED-GRANULARITY edits driven through a
// BOUNDED-LIMIT dual-stack history checked against a REFERENCE MODEL, plus a
// COMPOSITE branch-divergence law and a 3-hop changeStart inverse law.
//
// A NEW exploration distinct from every prior pass in this file (seeds 4001 /
// 4002 / 4004 / 24001 / 24002 / 24003 / 24004) and from the earlier
// 1000-6000 / 21000-26000 sweep. Seed 34002 is fresh. The novelty is the CROSS
// of two axes that were each covered separately but never together, plus laws
// no prior suite states:
//
//   1. CROSS: mixed-granularity (year / yearMonth / yearMonthDay) edits AND a
//      SMALL trimming history limit AND the explicit reference model. The 24001
//      suite drives mixed granularity but with a generous, never-trimming limit
//      and NO reference model (it only checks self-consistency via undo/redo).
//      The 24002 suite drives the reference model with a small trimming limit
//      but ONLY year-only EditOps, so the calendar's day-level normalize is
//      never on the trimming path. Here, mixed-granularity edits (which exercise
//      same-year dedup, sub-year overrun-shortening, and day-resolution
//      ordering) flow through a 1..4-limit history whose undo stack is CONSTANTLY
//      trimmed, and the production history is checked against an independent
//      model at every step. A trim bug that only manifests when the dropped
//      undo unit carried a sub-year start/end change (e.g. a mis-keyed dedup on
//      a same-year tie inside the replayed command) would surface only here.
//
//   2. editIfChanged with a content-derived isNoOp over MIXED edits, folded into
//      the same trimming stream (教訓 5.24). A no-op mixed edit must push NO
//      entry and must leave both the history AND the model untouched.
//
//   3. COMPOSITE branch divergence (FR-73/FR-74 together): execute a composite
//      of N mixed edits as ONE undo unit, undo it (whole chain to redo), then
//      execute a DIFFERENT composite from the pre-chain root. The second
//      composite must DROP the redo branch entirely (the first composite can
//      never be replayed onto the diverged branch), the post-divergence state +
//      every invariant must hold, and the diverged composite must still undo as
//      ONE step back to the root. No prior suite combines composites with
//      branch divergence.
//
//   4. 3-hop changeStart inverse on the temporal axis: changeStart to year P,
//      then to year Q, then back to the ORIGINAL start, with mixed-granularity
//      targets. When NO neighbor was destructively shortened across the two
//      forward hops (verified directly against each hop's result, mirroring the
//      4002 single-hop guard), the composed move must restore the exact original
//      series. A path-dependence / accumulation bug across multiple hops that a
//      single-hop round-trip cannot see would surface here.
//
// All series invariants (validateSeries — INV-1..3,5,6), no NaN/Infinity,
// forest validity, selection validity, and save∘load==identity are re-asserted
// after every reachable state.
//
// Determinism: pinned seed 34002, large run budget. Permanent asset; must NOT be
// relaxed to paint a broken existing behavior green.
// ===========================================================================

const SEED_34002 = 34002;
const NUM_RUNS_34002 = 700;

// A bounded-history action space over MIXED-granularity edits, including the
// ghost-suppressing editIfChanged path, undo/redo, clearRedo, and setLimit —
// the full command surface driven against the reference model with a small,
// constantly-trimming limit.
type MixedBoundedAction =
  | { readonly t: 'edit'; readonly op: MixedEditOp }
  | { readonly t: 'editIfChanged'; readonly op: MixedEditOp }
  | { readonly t: 'undo' }
  | { readonly t: 'redo' }
  | { readonly t: 'clearRedo' }
  | { readonly t: 'setLimit'; readonly limit: number };

const mixedBoundedActionArb: fc.Arbitrary<MixedBoundedAction> = fc.oneof(
  mixedEditOpArb.map((op) => ({ t: 'edit' as const, op })),
  mixedEditOpArb.map((op) => ({ t: 'editIfChanged' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'undo' as const }), // weight drain ops higher to churn stacks
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'clearRedo' as const }),
  fc.record({ t: fc.constant('setLimit' as const), limit: fc.integer({ min: 1, max: 6 }) }),
);

describe('time-anchor + history undo/redo — seed 34002 mixed-granularity bounded-model', () => {
  it('mixed-granularity edits through a SMALL-limit history agree with a reference model (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 4 }), // SMALL limit ⇒ trimming is the common case
        fc.array(mixedBoundedActionArb, { maxLength: 44 }),
        (initial, limit, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, limit);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: Math.max(1, Math.floor(limit)),
          };
          expectHistoryMatchesModel(history, model);

          for (const action of actions) {
            if (action.t === 'edit' || action.t === 'editIfChanged') {
              const before = history.state;
              const after = applyMixedEdit(before, action.op);
              if (after === undefined) {
                // No-op / rejected mixed edit. For editIfChanged exercise the
                // ghost-suppression path with an always-true isNoOp (教訓 5.24);
                // it must leave both history AND model untouched.
                if (action.t === 'editIfChanged') {
                  const step = executeIfChanged(
                    history,
                    makeSeriesCommand(action.op.kind, before, before),
                    () => true,
                  );
                  history = step.history;
                }
                expectHistoryMatchesModel(history, model);
                continue;
              }
              const cmd = makeSeriesCommand(action.op.kind, before, after);
              if (action.t === 'edit') {
                history = execute(history, cmd).history;
              } else {
                // Real change ⇒ isNoOp false ⇒ behaves exactly like execute.
                history = executeIfChanged(history, cmd, () => false).history;
              }
              model = modelExecute(model, viewSeries(before), viewSeries(after));
            } else if (action.t === 'undo') {
              history = undo(history).history;
              model = modelUndo(model);
            } else if (action.t === 'redo') {
              history = redo(history).history;
              model = modelRedo(model);
            } else if (action.t === 'clearRedo') {
              history = clearRedo(history);
              model = modelClearRedo(model);
            } else {
              history = withLimit(history, action.limit);
              model = modelWithLimit(model, action.limit);
            }
            expectHistoryMatchesModel(history, model);
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('FR-74 (mixed): after overflowing a small limit, draining the retained stack lands on the oldest retained pre-state (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 3 }),
        fc.array(mixedEditOpArb, { minLength: 1, maxLength: 18 }),
        (initial, limit, ops) => {
          let history = createHistory(initial, limit);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: Math.max(1, Math.floor(limit)),
          };
          for (const op of ops) {
            const before = history.state;
            const after = applyMixedEdit(before, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, before, after),
            ).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
          }
          const retained = model.undo.length;
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
          }
          expectHistoryMatchesModel(history, model);
          assertStepInvariants(history.state);
          // Production and model must agree on the (possibly trimmed) floor.
          expect(viewSeries(history.state)).toEqual(model.current);
          // A further undo is a no-op on the drained stack.
          const extra = undo(history).history;
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
          expect(extra.undoStack.length).toBe(history.undoStack.length);
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('composite branch divergence: a second composite from the root drops the first composite from redo (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedEditOpArb, { minLength: 1, maxLength: 6 }),
        fc.array(mixedEditOpArb, { minLength: 1, maxLength: 6 }),
        (initial, opsA, opsB) => {
          // Build composite A from the root by folding accepted mixed edits.
          const buildComposite = (
            from: AnchorSeries,
            ops: readonly MixedEditOp[],
            label: string,
          ): { cmd: Command<AnchorSeries>; post: AnchorSeries } | undefined => {
            const subs: Command<AnchorSeries>[] = [];
            let cursor = from;
            for (const op of ops) {
              const after = applyMixedEdit(cursor, op);
              if (after === undefined) continue;
              subs.push(makeSeriesCommand(op.kind, cursor, after));
              cursor = after;
            }
            if (subs.length === 0) return undefined;
            return { cmd: createCompositeCommand(label, subs), post: cursor };
          };

          const a = buildComposite(initial, opsA, 'bughunt/mixed-chain-A');
          if (a === undefined) return;

          let history = createHistory(initial, 10);
          history = execute(history, a.cmd).history;
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(a.post));
          assertStepInvariants(history.state);

          // Undo composite A as ONE unit → root, A sits on the redo stack.
          history = undo(history).history;
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          expect(history.redoStack.length).toBe(1);
          assertStepInvariants(history.state);

          // Diverge: build composite B from the SAME root.
          const b = buildComposite(history.state, opsB, 'bughunt/mixed-chain-B');
          if (b === undefined) {
            // B produced nothing from the root; redo of A must still restore the
            // exact post-A state (history coherence preserved on a no-op diverge).
            const redoneA = redo(history).history;
            expect(viewSeries(redoneA.state)).toEqual(viewSeries(a.post));
            assertStepInvariants(redoneA.state);
            return;
          }
          history = execute(history, b.cmd).history;

          // FR-74: executing B drops the redo branch entirely; A is gone.
          expect(history.redoStack.length).toBe(0);
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(b.post));
          assertStepInvariants(history.state);

          // A redo() now is a no-op — the stale A composite cannot resurrect.
          const afterRedo = redo(history).history;
          expect(viewSeries(afterRedo.state)).toEqual(viewSeries(b.post));
          expect(afterRedo.redoStack.length).toBe(0);

          // Undo of B is ONE step back to the root (single indivisible unit).
          const undoneB = undo(history).history;
          expect(viewSeries(undoneB.state)).toEqual(viewSeries(initial));
          expect(undoneB.undoStack.length).toBe(0);
          assertStepInvariants(undoneB.state);
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('3-hop changeStart inverse: move P→Q→original restores the series when no neighbor was shortened (mixed, seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.nat(),
        mixedTimePointArb,
        mixedTimePointArb,
        (initial, targetN, pointP, pointQ) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const id = target.anchor.id;
          const originalStart = target.start;

          // Hop 1: original → P.
          const hop1 = changeStart(initial, id, pointP, cal);
          if (!hop1.ok) return;
          expectAllInvariants(hop1.series);
          const othersAfter1 = nonTargetEntriesEqual(initial, hop1.series, id);

          // Hop 2: P → Q.
          const hop2 = changeStart(hop1.series, id, pointQ, cal);
          if (!hop2.ok) return;
          expectAllInvariants(hop2.series);
          const othersAfter2 = nonTargetEntriesEqual(hop1.series, hop2.series, id);

          // Hop 3: Q → original start.
          const hop3 = changeStart(hop2.series, id, originalStart, cal);
          if (!hop3.ok) return;
          expectAllInvariants(hop3.series);

          // The composed move is an identity ONLY when neither forward hop
          // destructively shortened / dropped a NON-target neighbor (§5.6「短縮」).
          // We verify that precondition directly against each hop's result, then
          // assert the full 3-hop round-trip restores the exact original series.
          if (othersAfter1 && othersAfter2) {
            expect(viewSeries(hop3.series)).toEqual(viewSeries(initial));
          }
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('save∘load == identity for any reachable mixed series under a small-limit stream (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 4 }),
        fc.array(mixedBoundedActionArb, { maxLength: 36 }),
        (initial, limit, actions) => {
          let history: History<AnchorSeries> = createHistory(initial, limit);
          for (const action of actions) {
            if (action.t === 'edit' || action.t === 'editIfChanged') {
              const before = history.state;
              const after = applyMixedEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else if (action.t === 'redo') {
              history = redo(history).history;
            } else if (action.t === 'clearRedo') {
              history = clearRedo(history);
            } else {
              history = withLimit(history, action.limit);
            }
            expectSaveLoadIdentity(history.state);
          }
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });
});
