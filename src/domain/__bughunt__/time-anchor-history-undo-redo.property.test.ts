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
import { asAnchorId } from '../ids';
import { timePointYear, type TimePoint } from '../time/time-point';
import type { Feature } from '../feature';

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

/**
 * Normalize signed zero to +0. A JSON-based persistence layer collapses -0 to 0
 * (`JSON.stringify(-0) === '0'`); since a coordinate of -0 and +0 denote the
 * identical geographic point (`-0 === 0`), the save/load model treats them as
 * equal. (See the bug-hunt note: the arbitrary fixture can mint a -0 longitude/
 * latitude, which a strict `Object.is`-based comparison would otherwise flag.)
 */
function nz(n: number): number {
  return n === 0 ? 0 : n;
}

function serializeSeries(s: AnchorSeries): SerializedSeries {
  return {
    entries: s.entries.map((e) => ({
      anchorId: e.anchor.id,
      start: e.start,
      end: e.end,
      features: e.anchor.snapshot.features,
      vertices: [...e.anchor.snapshot.vertices.byId.values()].map((v) => ({
        id: v.id,
        lon: nz(v.coordinate.lon),
        lat: nz(v.coordinate.lat),
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

// keep normalizeSeries import used even if a branch above is pruned
void normalizeSeries;
