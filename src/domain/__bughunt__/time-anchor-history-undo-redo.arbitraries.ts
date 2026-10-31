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
//
// 検査の本体は time-anchor-history-undo-redo.property.test.ts と time-anchor-history-undo-redo-N.property.test.ts に割ってある。
// vitest はファイル単位でしか並列に分配しないので、1 本に詰めると全件の待ち時間がその 1 本で決まる。
// ここには各ファイルが共有する生成器・補助だけを置く。

import { expect } from '../../test-support/fast-expect';
import fc from 'fast-check';
import { createAnchor, type Anchor, type AnchorSnapshot } from '../anchor';
import { changeStart, createAnchorEntry, deleteAnchor, normalizeSeries, resolveAt, setEnd, validateSeries, type AnchorEntry, type AnchorSeries, type SeriesResult } from '../anchor-series';
import { applyPastEdit } from '../anchor-series';
import { makeAnchor } from '../anchor-series.arbitraries';
import { type Command, type CommandOutcome, defineCommandKind } from '../command/command';
import { createCommandResult } from '../command/result';
import { canRedo, canUndo, clearRedo, execute, executeIfChanged, redo, undo, withLimit, type History } from '../command/history';
import { createCompositeCommand } from '../command/command';
import { getCalendar } from '../time/calendar';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { timePointYear, timePointYearMonth, timePointYearMonthDay, type TimePoint } from '../time/time-point';
import { compare } from '../time/normalized';
import { createAggregateFeature, createLeafFeature, type Feature } from '../feature';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createVertex, createVertexStore } from '../vertex';
import { createHoleRing, createShape, createTerritoryRing, type Ring, type Shape } from '../ring';
import { validateAlternation } from '../ring-hierarchy';
import { createAnchorSnapshot } from '../anchor';

export const cal = getCalendar('gregorian');

export const SEED = 4001;
export const NUM_RUNS = 500;

// --- invariant checks -------------------------------------------------------

/** All of INV-1, INV-2, INV-3, INV-5 via the single source of truth. */
export function expectAllInvariants(s: AnchorSeries): void {
  expect(s.entries.length).toBeGreaterThanOrEqual(1); // INV-5
  const v = validateSeries(s, cal);
  if (!v.ok) {
    throw new Error(
      `series invariants violated: ${JSON.stringify(v.violations)} | series=${JSON.stringify(serializeSeries(s))}`,
    );
  }
}

export function isFiniteNumber(n: number): boolean {
  return Number.isFinite(n);
}

/** No NaN / Infinity anywhere in the snapshot's coordinates / scalar attrs. */
export function expectNoBadNumbers(s: AnchorSeries): void {
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

export function checkTimePointFinite(t: TimePoint): void {
  expect(isFiniteNumber(t.year)).toBe(true);
  if (t.granularity === 'yearMonth' || t.granularity === 'yearMonthDay') {
    expect(isFiniteNumber(t.month)).toBe(true);
  }
  if (t.granularity === 'yearMonthDay') {
    expect(isFiniteNumber(t.day)).toBe(true);
  }
}

/** Parent references in each snapshot point at a present feature (forest). */
export function expectForestValid(s: AnchorSeries): void {
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
export function expectSelectionValid(s: AnchorSeries): void {
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

export interface SerializedEntry {
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

export interface SerializedSeries {
  readonly entries: readonly SerializedEntry[];
}

export function serializeSeries(s: AnchorSeries): SerializedSeries {
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

export function deserializeSeries(data: SerializedSeries): AnchorSeries {
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
export function expectSaveLoadIdentity(s: AnchorSeries): void {
  const saved = JSON.stringify(serializeSeries(s));
  const reloaded = deserializeSeries(JSON.parse(saved) as SerializedSeries);
  expect(serializeSeries(reloaded)).toEqual(serializeSeries(s));
}

// --- comparable view of a series (ignores object identity) ------------------

export function viewSeries(s: AnchorSeries): unknown {
  return serializeSeries(s);
}

// --- reversible command wrapping an anchor-series operation ------------------
//
// Lesson 5.20: a command captures the data it needs for undo/redo at execute
// time. Here the whole pre- and post-series are captured as plain immutable
// values (the series is small), so undo/redo are deterministic replays that do
// not depend on re-deriving anything.

export const SERIES_EDIT = defineCommandKind('bughunt/series-edit');

export function makeSeriesCommand(
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

export type EditOp =
  | { readonly kind: 'changeStart'; readonly target: number; readonly year: number }
  | { readonly kind: 'setEnd'; readonly target: number; readonly end: number | null }
  | { readonly kind: 'delete'; readonly target: number }
  | { readonly kind: 'pastEdit'; readonly year: number; readonly seed: number };

export const editOpArb: fc.Arbitrary<EditOp> = fc.oneof(
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
export function applyEdit(s: AnchorSeries, op: EditOp): AnchorSeries | undefined {
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

export interface HistoryAction {
  readonly t: 'edit' | 'undo' | 'redo';
  readonly op?: EditOp;
}

export const actionArb: fc.Arbitrary<HistoryAction> = fc.oneof(
  editOpArb.map((op) => ({ t: 'edit' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'redo' as const }),
);

export function assertStepInvariants(s: AnchorSeries): void {
  expectAllInvariants(s);
  expectNoBadNumbers(s);
  expectForestValid(s);
  expectSelectionValid(s);
  expectSaveLoadIdentity(s);
}

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

export const SEED_4002 = 4002;
export const NUM_RUNS_4002 = 600;

/**
 * True when every entry OTHER than `excludeId` is byte-identical (by start/end)
 * between two series. Used to detect whether a changeStart auto-reorganization
 * mutated a neighbor (overrun-shortening) or dropped an entry, which makes the
 * move non-reversible by spec.
 */
export function nonTargetEntriesEqual(
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

export const SEED_24002 = 24002;
export const NUM_RUNS_24002 = 500;

// --- reference model of a bounded dual-stack history ------------------------
//
// The model mirrors execute/undo/redo/withLimit/clearRedo over PLAIN state
// VALUES (the serialized series view), independent of the production History
// implementation, so a divergence between the two is a real bug. The model
// stores the undo stack as the sequence of (before -> after) state pairs and the
// current pointer, trimming the oldest pair when the undo depth exceeds `limit`.

export interface ModelEntry {
  readonly before: unknown; // viewSeries(before)
  readonly after: unknown; //  viewSeries(after)
}

export interface Model {
  readonly current: unknown; // viewSeries(currentState)
  readonly undo: readonly ModelEntry[]; // oldest -> newest applied
  readonly redo: readonly ModelEntry[]; // newest-undone at the END (top)
  readonly limit: number;
}

export function modelExecute(m: Model, before: unknown, after: unknown): Model {
  const undo = [...m.undo, { before, after }];
  // FR-74: trim oldest undo entries past the limit.
  const trimmed = undo.length > m.limit ? undo.slice(undo.length - m.limit) : undo;
  return { current: after, undo: trimmed, redo: [], limit: m.limit };
}

export function modelUndo(m: Model): Model {
  const top = m.undo[m.undo.length - 1];
  if (top === undefined) return m; // no-op
  return {
    current: top.before,
    undo: m.undo.slice(0, -1),
    redo: [...m.redo, top],
    limit: m.limit,
  };
}

export function modelRedo(m: Model): Model {
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

export function modelWithLimit(m: Model, limit: number): Model {
  const clamped = Math.max(1, Math.floor(limit));
  const undo =
    m.undo.length > clamped ? m.undo.slice(m.undo.length - clamped) : m.undo;
  return { ...m, limit: clamped, undo };
}

export function modelClearRedo(m: Model): Model {
  return { ...m, redo: [] };
}

/** Assert the production history agrees with the model on the observable state,
 * the undo/redo depths, and the canUndo/canRedo gates. */
export function expectHistoryMatchesModel(h: History<AnchorSeries>, m: Model): void {
  expect(viewSeries(h.state)).toEqual(m.current);
  expect(h.undoStack.length).toBe(m.undo.length);
  expect(h.redoStack.length).toBe(m.redo.length);
  expect(canUndo(h)).toBe(m.undo.length > 0);
  expect(canRedo(h)).toBe(m.redo.length > 0);
  expect(h.limit).toBe(m.limit);
}

// Action space for the bounded-history stateful driver.
export type BoundedAction =
  | { readonly t: 'edit'; readonly op: EditOp }
  | { readonly t: 'editIfChanged'; readonly op: EditOp }
  | { readonly t: 'undo' }
  | { readonly t: 'redo' }
  | { readonly t: 'clearRedo' }
  | { readonly t: 'setLimit'; readonly limit: number };

export const boundedActionArb: fc.Arbitrary<BoundedAction> = fc.oneof(
  editOpArb.map((op) => ({ t: 'edit' as const, op })),
  editOpArb.map((op) => ({ t: 'editIfChanged' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'undo' as const }), // weight undo/redo higher to drain stacks
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'clearRedo' as const }),
  fc.record({ t: fc.constant('setLimit' as const), limit: fc.integer({ min: 1, max: 5 }) }),
);

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

export const SEED_4004 = 4004;
export const NUM_RUNS_4004 = 400;

// --- rich snapshot generator (real factories; 教訓 5.39) --------------------

/** A small alternation-valid ring forest: 1-2 top territories, each with an
 * optional hole, each hole with an optional nested (enclave) territory. Built
 * through the REAL U06 ring factories so it is structurally valid by
 * construction; geometry coordinates are placeholders (this targets the
 * STRUCTURAL alternation + parent-link invariants under undo/redo/persist). */
export function ringForestArb(tag: string): fc.Arbitrary<Shape> {
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
export function richSnapshotArb(idTag: string): fc.Arbitrary<AnchorSnapshot> {
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
export function richAnchorSeriesArb(): fc.Arbitrary<AnchorSeries> {
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
export function expectRingHierarchyValid(s: AnchorSeries): void {
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
export function expectAggregateForestValid(s: AnchorSeries): void {
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
export function expectRichSaveLoadIdentity(s: AnchorSeries): void {
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

export function assertRichStepInvariants(s: AnchorSeries): void {
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
export function applyRichEdit(s: AnchorSeries, op: EditOp): AnchorSeries | undefined {
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

export const SEED_24001 = 24001;
export const NUM_RUNS_24001 = 500;

/**
 * A mixed-granularity TimePoint generator that always yields a calendar-VALID
 * point (routed implicitly through the same day-counts `validate` enforces): a
 * year in a tight band so anchors can land in the same year, plus an optional
 * month (1..12) and an optional day (1..28 — always valid in every Gregorian
 * month, including February, leap or not). Sub-year resolution lets the suite
 * generate same-year-different-month anchors that year-only points cannot.
 */
export const mixedTimePointArb: fc.Arbitrary<TimePoint> = fc.oneof(
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
export function mixedAnchorSeriesArb(): fc.Arbitrary<AnchorSeries> {
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
export function compareMixedForUnique(a: TimePoint, b: TimePoint): boolean {
  return compareTP(a, b) === 0;
}

/** Calendar comparison shorthand for the local generators. */
export function compareTP(a: TimePoint, b: TimePoint): number {
  return compare(a, b, cal);
}

/** A probe-time generator spanning the timeline (well before the earliest start
 * to well after the latest), at mixed granularity, for off-anchor resolveAt. */
export const probeTimeArb: fc.Arbitrary<TimePoint> = mixedTimePointArb;

/** resolveAt at an ARBITRARY probe must yield either `absent` or a `present`
 * entry that is a REAL member of the series (never a phantom anchor id), and a
 * present resolution's interval must actually contain the probe (start<=probe,
 * and probe<end when bounded). This strengthens selection-validity to
 * off-anchor probe times (mid-interval / gap / post-end). */
export function expectProbeSelectionValid(s: AnchorSeries, probe: TimePoint): void {
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
export type MixedEditOp =
  | { readonly kind: 'changeStart'; readonly target: number; readonly start: TimePoint }
  | { readonly kind: 'setEnd'; readonly target: number; readonly end: TimePoint | null }
  | { readonly kind: 'delete'; readonly target: number }
  | { readonly kind: 'pastEdit'; readonly at: TimePoint; readonly seed: number };

export const mixedEditOpArb: fc.Arbitrary<MixedEditOp> = fc.oneof(
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

export function applyMixedEdit(s: AnchorSeries, op: MixedEditOp): AnchorSeries | undefined {
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

export interface MixedAction {
  readonly t: 'edit' | 'undo' | 'redo';
  readonly op?: MixedEditOp;
}

export const mixedActionArb: fc.Arbitrary<MixedAction> = fc.oneof(
  mixedEditOpArb.map((op) => ({ t: 'edit' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'redo' as const }),
);

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

export const SEED_24003 = 24003;
export const NUM_RUNS_24003 = 500;

/** Structural-view equality of two series (object-identity-independent). */
export function seriesViewEqual(a: AnchorSeries, b: AnchorSeries): boolean {
  return JSON.stringify(viewSeries(a)) === JSON.stringify(viewSeries(b));
}

/** The serialized snapshot of one entry (features + vertices), for "only the
 * snapshot changed" comparisons that ignore start/end. */
export function entrySnapshotView(e: AnchorEntry): unknown {
  return {
    features: e.anchor.snapshot.features,
    vertices: [...e.anchor.snapshot.vertices.byId.values()].map((v) => ({
      id: v.id,
      lon: v.coordinate.lon,
      lat: v.coordinate.lat,
    })),
  };
}

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

export const SEED_24004 = 24004;
export const NUM_RUNS_24004 = 500;

// --- multi-feature (pair) history state -------------------------------------
//
// The history root is a PAIR of independent anchor series (two features sharing
// one undo/redo stack, as the real document does). A reversible command wraps a
// whole before/after PAIR, exactly like makeSeriesCommand but over the pair, so
// undo/redo must restore BOTH halves with no cross-talk.

export interface SeriesPair {
  readonly a: AnchorSeries;
  readonly b: AnchorSeries;
}

export const PAIR_EDIT = defineCommandKind('bughunt/pair-edit');

export function makePairCommand(
  label: string,
  before: SeriesPair,
  after: SeriesPair,
): Command<SeriesPair> {
  const result = createCommandResult({});
  const toAfter = (): CommandOutcome<SeriesPair> => ({ state: after, result });
  const toBefore = (): CommandOutcome<SeriesPair> => ({ state: before, result });
  return { kind: PAIR_EDIT, label, execute: toAfter, undo: toBefore, redo: toAfter };
}

export function viewPair(p: SeriesPair): unknown {
  return { a: viewSeries(p.a), b: viewSeries(p.b) };
}

export function assertPairInvariants(p: SeriesPair): void {
  assertStepInvariants(p.a);
  assertStepInvariants(p.b);
}

// An edit targeting one of the two series in the pair.
export interface PairAction {
  readonly t: 'edit' | 'undo' | 'redo';
  readonly which?: 'a' | 'b';
  readonly op?: EditOp;
}

export const pairActionArb: fc.Arbitrary<PairAction> = fc.oneof(
  fc.record({
    t: fc.constant('edit' as const),
    which: fc.constantFrom('a' as const, 'b' as const),
    op: editOpArb,
  }),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'redo' as const }),
);

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

export const SEED_34002 = 34002;
export const NUM_RUNS_34002 = 700;

// A bounded-history action space over MIXED-granularity edits, including the
// ghost-suppressing editIfChanged path, undo/redo, clearRedo, and setLimit —
// the full command surface driven against the reference model with a small,
// constantly-trimming limit.
export type MixedBoundedAction =
  | { readonly t: 'edit'; readonly op: MixedEditOp }
  | { readonly t: 'editIfChanged'; readonly op: MixedEditOp }
  | { readonly t: 'undo' }
  | { readonly t: 'redo' }
  | { readonly t: 'clearRedo' }
  | { readonly t: 'setLimit'; readonly limit: number };

export const mixedBoundedActionArb: fc.Arbitrary<MixedBoundedAction> = fc.oneof(
  mixedEditOpArb.map((op) => ({ t: 'edit' as const, op })),
  mixedEditOpArb.map((op) => ({ t: 'editIfChanged' as const, op })),
  fc.constant({ t: 'undo' as const }),
  fc.constant({ t: 'undo' as const }), // weight drain ops higher to churn stacks
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'redo' as const }),
  fc.constant({ t: 'clearRedo' as const }),
  fc.record({ t: fc.constant('setLimit' as const), limit: fc.integer({ min: 1, max: 6 }) }),
);

// ===========================================================================
// SEED 34003 expansion suite — fc.commands STATEFUL model over a BOUNDED-LIMIT
// history carrying RICH snapshots (ring forest + hierarchy forest), with
// OFF-ANCHOR probe-selection re-checked on every reachable state.
//
// This is a NEW exploration distinct from every prior pass in this file. The
// prior suites either:
//   - drive a manual `fc.array(actionArb)` loop (4001/4002/4004/24001/34002), or
//   - check the bounded reference model on POINT-ONLY snapshots (24002/34002), or
//   - check rich ring/hierarchy invariants on an UNBOUNDED history (4004).
// NONE of them combine all three at once:
//   (a) a real fast-check STATEFUL run (fc.commands + fc.modelRun) — the proper
//       model-based generator, which interleaves edit/undo/redo/clearRedo/
//       setLimit/composite in dependency order and SHRINKS the failing command
//       sequence (fc.array cannot shrink an interdependent stream as tightly);
//   (b) a SMALL undo-limit (1..3) so FR-74 trimming is the common case, with the
//       production History checked against the same reference Model used by the
//       24002/34002 suites — but now under RICH snapshots, so a trim/undo/redo
//       bug that drops or reorders shape rings / aggregate childIds / parent
//       links would surface as a model divergence AND a structural-invariant
//       failure simultaneously; and
//   (c) OFF-ANCHOR resolveAt probe-selection validity (expectProbeSelectionValid)
//       re-asserted on every reachable state — selection must stay valid not just
//       at anchor starts but at mid-interval / gap / post-end probe times, across
//       the trimming history regime.
//
// Plus a composite command bundling a CHAIN of rich edits driven as ONE undo
// unit through the SMALL-limit history (FR-73/FR-94) and reconciled with the
// model (a composite is exactly one modelExecute step).
//
// Invariants re-asserted after EVERY reachable state (assertRichStepInvariants):
//   INV-1..3,5,6 (validateSeries), ring alternation + parent-ring links,
//   aggregate child/parent forest, no NaN/Infinity, rich save∘load == identity.
// Metamorphic laws (history level): model agreement at every step ⇒ undo∘execute
//   == identity, redo restores post-execute, full retained-undo == oldest
//   retained pre-state, composite undo/redo are single steps.
//
// Determinism: pinned seed 34003, large run budget. Permanent asset; must NOT be
// relaxed to paint a broken existing behavior green.
// ===========================================================================

export const SEED_34003 = 34003;
export const NUM_RUNS_34003 = 500;

// --- the stateful "real" system under test ----------------------------------
//
// The real system is a bounded-limit History<AnchorSeries> carrying RICH
// snapshots. The fc-model is the plain-value reference Model (already defined
// above for the 24002 suite). Each fc.Command mutates BOTH and then asserts:
//   - production history agrees with the reference model (state + stack depths +
//     canUndo/canRedo gates + limit), and
//   - the reachable rich series satisfies every structural invariant, and
//   - off-anchor probe selection is valid.

export interface RichSut {
  history: History<AnchorSeries>;
}

// fc.commands mutates a model object in-place; we keep the reference Model and a
// fixed probe time inside it so commands can reconcile against both.
export interface RichModelState {
  model: Model;
  readonly probe: TimePoint;
}

export type RichFcCommand = fc.Command<RichModelState, RichSut>;

export function reconcile(m: RichModelState, sut: RichSut): void {
  expectHistoryMatchesModel(sut.history, m.model);
  assertRichStepInvariants(sut.history.state);
  expectProbeSelectionValid(sut.history.state, m.probe);
}

export class RichEditCommand implements RichFcCommand {
  constructor(private readonly op: EditOp) {}
  check(): boolean {
    return true; // an edit is always attempted; a no-op simply pushes nothing.
  }
  run(m: RichModelState, sut: RichSut): void {
    const before = sut.history.state;
    const after = applyRichEdit(before, this.op);
    if (after === undefined) {
      // Rejected / no-op rich edit: neither history nor model may change.
      reconcile(m, sut);
      return;
    }
    sut.history = execute(
      sut.history,
      makeSeriesCommand(this.op.kind, before, after),
    ).history;
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(after));
    reconcile(m, sut);
  }
  toString(): string {
    return `richEdit(${JSON.stringify(this.op)})`;
  }
}

export class RichEditIfChangedCommand implements RichFcCommand {
  constructor(private readonly op: EditOp) {}
  check(): boolean {
    return true;
  }
  run(m: RichModelState, sut: RichSut): void {
    const before = sut.history.state;
    const after = applyRichEdit(before, this.op);
    if (after === undefined) {
      // Exercise the ghost-suppression path (教訓 5.24): an always-true isNoOp
      // must leave BOTH history and model untouched, never pushing an entry.
      sut.history = executeIfChanged(
        sut.history,
        makeSeriesCommand(this.op.kind, before, before),
        () => true,
      ).history;
      reconcile(m, sut);
      return;
    }
    // Real change ⇒ isNoOp false ⇒ behaves exactly like execute.
    sut.history = executeIfChanged(
      sut.history,
      makeSeriesCommand(this.op.kind, before, after),
      () => false,
    ).history;
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(after));
    reconcile(m, sut);
  }
  toString(): string {
    return `richEditIfChanged(${JSON.stringify(this.op)})`;
  }
}

export class RichCompositeCommand implements RichFcCommand {
  constructor(private readonly ops: readonly EditOp[]) {}
  check(): boolean {
    return true;
  }
  run(m: RichModelState, sut: RichSut): void {
    // Fold the ops into a chain of real sub-commands, skipping rejected/no-ops.
    const subCommands: Command<AnchorSeries>[] = [];
    let cursor = sut.history.state;
    const before = cursor;
    for (const op of this.ops) {
      const after = applyRichEdit(cursor, op);
      if (after === undefined) continue;
      subCommands.push(makeSeriesCommand(op.kind, cursor, after));
      cursor = after;
    }
    if (subCommands.length === 0) {
      reconcile(m, sut); // nothing to bundle: no change
      return;
    }
    const postChain = cursor;
    const composite = createCompositeCommand('bughunt/rich-edit-chain', subCommands);
    sut.history = execute(sut.history, composite).history;
    // A composite is exactly ONE model step: before -> post-chain.
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(postChain));
    // The composite must have landed exactly on the post-chain state.
    expect(viewSeries(sut.history.state)).toEqual(viewSeries(postChain));
    reconcile(m, sut);
  }
  toString(): string {
    return `richComposite(${this.ops.length} ops)`;
  }
}

export class UndoCommand implements RichFcCommand {
  check(): boolean {
    return true; // undo on an empty stack is a defined no-op.
  }
  run(m: RichModelState, sut: RichSut): void {
    sut.history = undo(sut.history).history;
    m.model = modelUndo(m.model);
    reconcile(m, sut);
  }
  toString(): string {
    return 'undo';
  }
}

export class RedoCommand implements RichFcCommand {
  check(): boolean {
    return true; // redo on an empty stack is a defined no-op.
  }
  run(m: RichModelState, sut: RichSut): void {
    sut.history = redo(sut.history).history;
    m.model = modelRedo(m.model);
    reconcile(m, sut);
  }
  toString(): string {
    return 'redo';
  }
}

export class ClearRedoCommand implements RichFcCommand {
  check(): boolean {
    return true;
  }
  run(m: RichModelState, sut: RichSut): void {
    sut.history = clearRedo(sut.history);
    m.model = modelClearRedo(m.model);
    reconcile(m, sut);
  }
  toString(): string {
    return 'clearRedo';
  }
}

export class SetLimitCommand implements RichFcCommand {
  constructor(private readonly limit: number) {}
  check(): boolean {
    return true;
  }
  run(m: RichModelState, sut: RichSut): void {
    sut.history = withLimit(sut.history, this.limit);
    m.model = modelWithLimit(m.model, this.limit);
    reconcile(m, sut);
  }
  toString(): string {
    return `setLimit(${this.limit})`;
  }
}

export const richCommandsArb: fc.Arbitrary<Iterable<RichFcCommand>> = fc.commands(
  [
    editOpArb.map((op): RichFcCommand => new RichEditCommand(op)),
    editOpArb.map((op): RichFcCommand => new RichEditIfChangedCommand(op)),
    fc
      .array(editOpArb, { minLength: 1, maxLength: 4 })
      .map((ops): RichFcCommand => new RichCompositeCommand(ops)),
    fc.constant(new UndoCommand() as RichFcCommand),
    fc.constant(new UndoCommand() as RichFcCommand), // weight undo to drain stacks
    fc.constant(new RedoCommand() as RichFcCommand),
    fc.constant(new RedoCommand() as RichFcCommand),
    fc.constant(new ClearRedoCommand() as RichFcCommand),
    fc
      .integer({ min: 1, max: 4 })
      .map((n): RichFcCommand => new SetLimitCommand(n)),
  ],
  { maxCommands: 40 },
);

// ===========================================================================
// SEED 34004 expansion suite — fc.commands STATEFUL model over a BOUNDED-LIMIT
// history driven by MIXED-GRANULARITY edits, reconciled against the reference
// Model, with OFF-ANCHOR probe-selection re-checked on every reachable state.
//
// A NEW exploration distinct from every prior pass in this file (seeds 4001 /
// 4002 / 4004 / 24001 / 24002 / 24003 / 24004 / 34002 / 34003) and from the
// earlier 1000-6000 / 21000-26000 sweep. Seed 34004 is fresh. The novelty is the
// THREE-WAY CROSS of axes that prior suites cover only pairwise, plus two
// temporal-axis algebraic laws no prior suite states under MIXED granularity:
//
//   1. CROSS that no suite makes: a real fast-check STATEFUL run (fc.commands +
//      fc.modelRun) AND mixed-granularity (year / yearMonth / yearMonthDay)
//      edits AND a SMALL trimming undo-limit (1..3) AND the explicit reference
//      Model. The closest prior suites each drop one axis:
//        - 24001 drives mixed granularity but with a generous never-trimming
//          limit, no reference model, and a MANUAL fc.array loop (no fc.commands
//          shrinking of an interdependent stream).
//        - 34002 drives mixed granularity + reference model + small trimming
//          limit, but via a MANUAL fc.array loop — NOT fc.commands, so an
//          interdependent failing stream cannot be shrunk as tightly.
//        - 34003 is a true fc.commands run against the model under a small limit,
//          but uses POINT-ONLY / rich snapshots built from YEAR-ONLY EditOps, so
//          the calendar's day-level normalize (same-year dedup, sub-year
//          overrun-shortening) is never on the trimming/undo/redo path.
//      Here the fc.commands generator interleaves mixed-granularity edit /
//      editIfChanged / undo / redo / clearRedo / setLimit / composite in
//      dependency order over a constantly-trimming 1..3-limit history, and the
//      production History is reconciled with an independent Model at every step.
//      A trim/undo/redo bug whose dropped undo unit carried a SUB-YEAR start/end
//      change (a mis-keyed same-year dedup inside the replayed command, or an
//      off-by-one window when the trimmed unit's normalize differs at day
//      resolution) would surface ONLY in this cross — and fc.commands would
//      shrink it to the minimal interdependent sequence.
//
//   2. OFF-ANCHOR probe-selection validity (expectProbeSelectionValid) re-checked
//      on EVERY reachable state of the stateful run, not just at anchor starts:
//      across the trimming history, undo/redo, and composite branches, resolveAt
//      at a fixed mid-interval / gap / post-end probe must always resolve to a
//      REAL present member (never a phantom) whose interval truly contains the
//      probe. 34002 (mixed + model) never probes off-anchor; 34003 probes but on
//      year-only EditOps. This is the first off-anchor probe over the mixed
//      trimming-history regime driven statefully.
//
//   3. Two temporal-axis algebraic laws under MIXED granularity that no prior
//      suite states at this granularity:
//        - setEnd INVERSE: from a cleared (open-ended) baseline, setEnd(end)
//          then setEnd(null) must restore the open-ended baseline structurally
//          (op∘inverse-op == identity on the end axis) — the 4001 suite states
//          this only for YEAR-ONLY ends; here `end` is a mixed-granularity point
//          so a same-year / sub-year end that ties a neighbor's start exercises
//          the day-level INV-2 shorten on the set and its clean removal on the
//          clear.
//        - delete NO-RESURRECTION under mixed granularity: deleting an id then
//          deleting it again must REJECT with anchorNotFound (a deleted mixed-
//          granularity anchor is gone, never silently re-resolving onto a
//          same-year neighbor). 24003 states this for year-only series only.
//
// All series invariants (validateSeries — INV-1..3,5,6), no NaN/Infinity, forest
// validity, selection validity, and save∘load==identity are re-asserted after
// every reachable state (assertStepInvariants), plus the model agreement
// (state + stack depths + canUndo/canRedo gates + limit) at every fc.command.
//
// Determinism: pinned seed 34004, large run budget. Permanent asset; must NOT be
// relaxed to paint a broken existing behavior green.
// ===========================================================================

export const SEED_34004 = 34004;
export const NUM_RUNS_34004 = 600;

// --- the stateful "real" system under test (mixed-granularity, bounded) ------
//
// The real system is a bounded-limit History<AnchorSeries> carrying POINT-ONLY
// snapshots but driven by MIXED-granularity edits. The fc-model is the plain-
// value reference Model (defined for the 24002 suite). Each fc.Command mutates
// BOTH and then reconciles: production history agrees with the reference model
// (state + stack depths + gates + limit), the reachable series satisfies every
// structural invariant, AND off-anchor probe selection is valid.

export interface MixedSut {
  history: History<AnchorSeries>;
}

export interface MixedModelState {
  model: Model;
  readonly probe: TimePoint;
}

export type MixedFcCommand = fc.Command<MixedModelState, MixedSut>;

export function reconcileMixed(m: MixedModelState, sut: MixedSut): void {
  expectHistoryMatchesModel(sut.history, m.model);
  assertStepInvariants(sut.history.state);
  expectProbeSelectionValid(sut.history.state, m.probe);
}

export class MixedEditCommand implements MixedFcCommand {
  constructor(private readonly op: MixedEditOp) {}
  check(): boolean {
    return true; // an edit is always attempted; a no-op simply pushes nothing.
  }
  run(m: MixedModelState, sut: MixedSut): void {
    const before = sut.history.state;
    const after = applyMixedEdit(before, this.op);
    if (after === undefined) {
      reconcileMixed(m, sut); // rejected / no-op: neither side changes.
      return;
    }
    sut.history = execute(
      sut.history,
      makeSeriesCommand(this.op.kind, before, after),
    ).history;
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(after));
    reconcileMixed(m, sut);
  }
  toString(): string {
    return `mixedEdit(${JSON.stringify(this.op)})`;
  }
}

export class MixedEditIfChangedCommand implements MixedFcCommand {
  constructor(private readonly op: MixedEditOp) {}
  check(): boolean {
    return true;
  }
  run(m: MixedModelState, sut: MixedSut): void {
    const before = sut.history.state;
    const after = applyMixedEdit(before, this.op);
    if (after === undefined) {
      // Ghost-suppression path (教訓 5.24): an always-true isNoOp must leave
      // BOTH history and model untouched and push nothing.
      sut.history = executeIfChanged(
        sut.history,
        makeSeriesCommand(this.op.kind, before, before),
        () => true,
      ).history;
      reconcileMixed(m, sut);
      return;
    }
    sut.history = executeIfChanged(
      sut.history,
      makeSeriesCommand(this.op.kind, before, after),
      () => false,
    ).history;
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(after));
    reconcileMixed(m, sut);
  }
  toString(): string {
    return `mixedEditIfChanged(${JSON.stringify(this.op)})`;
  }
}

export class MixedCompositeCommand implements MixedFcCommand {
  constructor(private readonly ops: readonly MixedEditOp[]) {}
  check(): boolean {
    return true;
  }
  run(m: MixedModelState, sut: MixedSut): void {
    const subCommands: Command<AnchorSeries>[] = [];
    let cursor = sut.history.state;
    const before = cursor;
    for (const op of this.ops) {
      const after = applyMixedEdit(cursor, op);
      if (after === undefined) continue;
      subCommands.push(makeSeriesCommand(op.kind, cursor, after));
      cursor = after;
    }
    if (subCommands.length === 0) {
      reconcileMixed(m, sut); // nothing to bundle.
      return;
    }
    const postChain = cursor;
    const composite = createCompositeCommand('bughunt/mixed-edit-chain', subCommands);
    sut.history = execute(sut.history, composite).history;
    // A composite is exactly ONE model step: before -> post-chain.
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(postChain));
    // The composite must have landed exactly on the post-chain state.
    expect(viewSeries(sut.history.state)).toEqual(viewSeries(postChain));
    reconcileMixed(m, sut);
  }
  toString(): string {
    return `mixedComposite(${this.ops.length} ops)`;
  }
}

export class MixedUndoCommand implements MixedFcCommand {
  check(): boolean {
    return true; // undo on an empty stack is a defined no-op.
  }
  run(m: MixedModelState, sut: MixedSut): void {
    sut.history = undo(sut.history).history;
    m.model = modelUndo(m.model);
    reconcileMixed(m, sut);
  }
  toString(): string {
    return 'undo';
  }
}

export class MixedRedoCommand implements MixedFcCommand {
  check(): boolean {
    return true; // redo on an empty stack is a defined no-op.
  }
  run(m: MixedModelState, sut: MixedSut): void {
    sut.history = redo(sut.history).history;
    m.model = modelRedo(m.model);
    reconcileMixed(m, sut);
  }
  toString(): string {
    return 'redo';
  }
}

export class MixedClearRedoCommand implements MixedFcCommand {
  check(): boolean {
    return true;
  }
  run(m: MixedModelState, sut: MixedSut): void {
    sut.history = clearRedo(sut.history);
    m.model = modelClearRedo(m.model);
    reconcileMixed(m, sut);
  }
  toString(): string {
    return 'clearRedo';
  }
}

export class MixedSetLimitCommand implements MixedFcCommand {
  constructor(private readonly limit: number) {}
  check(): boolean {
    return true;
  }
  run(m: MixedModelState, sut: MixedSut): void {
    sut.history = withLimit(sut.history, this.limit);
    m.model = modelWithLimit(m.model, this.limit);
    reconcileMixed(m, sut);
  }
  toString(): string {
    return `setLimit(${this.limit})`;
  }
}

export const mixedCommandsArb: fc.Arbitrary<Iterable<MixedFcCommand>> = fc.commands(
  [
    mixedEditOpArb.map((op): MixedFcCommand => new MixedEditCommand(op)),
    mixedEditOpArb.map((op): MixedFcCommand => new MixedEditIfChangedCommand(op)),
    fc
      .array(mixedEditOpArb, { minLength: 1, maxLength: 4 })
      .map((ops): MixedFcCommand => new MixedCompositeCommand(ops)),
    fc.constant(new MixedUndoCommand() as MixedFcCommand),
    fc.constant(new MixedUndoCommand() as MixedFcCommand), // weight drain ops higher
    fc.constant(new MixedRedoCommand() as MixedFcCommand),
    fc.constant(new MixedRedoCommand() as MixedFcCommand),
    fc.constant(new MixedClearRedoCommand() as MixedFcCommand),
    fc.integer({ min: 1, max: 4 }).map((n): MixedFcCommand => new MixedSetLimitCommand(n)),
  ],
  { maxCommands: 44 },
);

// ===========================================================================
// SEED 44001 expansion suite — fc.commands STATEFUL model over a BOUNDED-LIMIT
// history that combines, for the FIRST time in this file, RICH snapshots (ring
// forest + hierarchy/aggregate forest) WITH MIXED-granularity time edits, plus
// a brand-new SAVE→LOAD CHECKPOINT command driven THROUGH the dual-stack
// history, and a changeStart∘changeStart-back inverse law over the rich+mixed
// axis. This is a genuinely distinct exploration from every prior pass:
//
//   - 34003 = rich snapshots BUT year-only EditOp (changeStart/setEnd use
//     timePointYear; no month/day starts ever reach the rich series).
//   - 34004 = mixed-granularity edits BUT point-only snapshots (no rings, no
//     aggregate forest, so a trim/undo bug that drops a ring or childId at a
//     sub-year start cannot surface there).
//   - NONE combine rich snapshots + mixed-granularity starts in ONE stateful
//     run, and NONE drive a save→load round-trip as a real HISTORY edit (so an
//     undo/redo that does not survive a persistence checkpoint mid-stream is
//     untested everywhere else).
//
// New commands in the action space (interleaved/shrunk by fc.commands):
//   (a) RichMixedEdit / RichMixedEditIfChanged — changeStart/setEnd/delete/
//       pastEdit where every time is drawn from mixedTimePointArb and every
//       inserted/replaced snapshot is a RICH ring+aggregate forest.
//   (b) RichMixedComposite — a CHAIN of rich+mixed edits as ONE undo unit.
//   (c) CheckpointCommand — serialize the current rich series to JSON, reload
//       it verbatim (NO re-normalize), assert structural identity, and push the
//       reloaded series as a real history edit. A reloaded-but-identical series
//       is a no-op (pushes nothing); a reloaded series that DIFFERS would be a
//       persistence bug AND would diverge from the model. This exercises
//       save∘load==identity AS A HISTORY TRANSITION (undo of a checkpoint that
//       changed nothing is still a defined no-op against the model).
//   (d) undo / redo / clearRedo / setLimit (small limit ⇒ FR-74 trimming common).
//
// Reconciled after EVERY reachable state: production history == reference Model
// (state + stack depths + canUndo/canRedo gates + limit); rich structural
// invariants (INV-1..3,5,6, ring alternation + parent-ring links, aggregate
// child/parent forest, no NaN/Infinity, rich save∘load == identity); AND
// off-anchor probe-selection validity.
//
// Extra metamorphic law (separate property): changeStart(t) then changeStart
// back to the ORIGINAL start is an identity ON THE TARGET ENTRY when the
// re-move is accepted and nothing collided away (asserted against the single
// source of truth + structural view), driven THROUGH execute/undo so a history
// round-trip is folded in.
//
// Determinism: pinned seed 44001, large run budget. Permanent asset; must NOT
// be relaxed to paint a broken existing behavior green.
// ===========================================================================

export const SEED_44001 = 44001;
export const NUM_RUNS_44001 = 600;

// --- rich + mixed-granularity series generator ------------------------------
//
// Distinct mixed-granularity start points (year / year-month / year-month-day),
// each anchor carrying a RICH ring+aggregate snapshot, funneled through the real
// normalizeSeries so the result is guaranteed valid even where two generated
// points share a year.
export function richMixedAnchorSeriesArb(): fc.Arbitrary<AnchorSeries> {
  return fc
    .uniqueArray(mixedTimePointArb, {
      minLength: 1,
      maxLength: 5,
      comparator: (a, b) => compareMixedForUnique(a, b),
    })
    .chain((points) => {
      const sorted = [...points].sort((a, b) => compareTP(a, b));
      return fc
        .tuple(...sorted.map((_, i) => richSnapshotArb(`rm${i}`)))
        .map((snaps) => {
          const entries: AnchorEntry[] = sorted.map((start, i) => {
            const anchor = createAnchor(asAnchorId(`a-rm${i}`), snaps[i]!);
            return createAnchorEntry(anchor, start, null);
          });
          return normalizeSeries(entries, cal);
        });
    });
}

/** Apply one MIXED-granularity edit that, for pastEdit, inserts a RICH snapshot
 * (ring forest + aggregate forest). Mirrors applyMixedEdit's time handling and
 * applyRichEdit's snapshot construction, combining both for the first time. */
export function applyRichMixedEdit(s: AnchorSeries, op: MixedEditOp): AnchorSeries | undefined {
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
    // pastEdit at a mixed-granularity time, inserting a RICH snapshot built
    // deterministically from the seed (territory + hole + leaf + aggregate).
    const tag = `rmpe${op.seed}`;
    const leafId = asFeatureId(`${tag}-leaf`);
    const aggId = asFeatureId(`${tag}-agg`);
    const attrs = createBasicAttributes(tag, op.seed % 90, op.seed % 180);
    const color = createColorInfo(true, '#0a0b0c', '#1a1b1c', '#2a2b2c');
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
      op.at,
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

/** Save→JSON→load the FULL rich series verbatim (no re-normalize), returning the
 * reloaded series. The faithful reload must reproduce the saved structure (rings,
 * parentRingId, aggregate childIds, parentId, vertices) exactly, so this is the
 * persistence round-trip exercised as a value transformation. */
export function checkpointReload(s: AnchorSeries): AnchorSeries {
  const toPlain = (series: AnchorSeries) =>
    series.entries.map((e) => ({
      anchorId: e.anchor.id,
      start: e.start,
      end: e.end,
      features: e.anchor.snapshot.features,
      vertices: [...e.anchor.snapshot.vertices.byId.entries()].map(([id, v]) => ({
        id,
        lon: v.coordinate.lon,
        lat: v.coordinate.lat,
      })),
    }));
  const reloaded = JSON.parse(JSON.stringify(toPlain(s))) as ReturnType<typeof toPlain>;
  return {
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
}

// --- the stateful "real" system: bounded rich+mixed history -----------------

export interface RichMixedSut {
  history: History<AnchorSeries>;
}

export interface RichMixedModelState {
  model: Model;
  readonly probe: TimePoint;
}

export type RichMixedFcCommand = fc.Command<RichMixedModelState, RichMixedSut>;

export function reconcileRichMixed(m: RichMixedModelState, sut: RichMixedSut): void {
  expectHistoryMatchesModel(sut.history, m.model);
  assertRichStepInvariants(sut.history.state);
  expectProbeSelectionValid(sut.history.state, m.probe);
}

export class RichMixedEditCommand implements RichMixedFcCommand {
  constructor(private readonly op: MixedEditOp) {}
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    const before = sut.history.state;
    const after = applyRichMixedEdit(before, this.op);
    if (after === undefined) {
      reconcileRichMixed(m, sut); // rejected / no-op
      return;
    }
    sut.history = execute(
      sut.history,
      makeSeriesCommand(this.op.kind, before, after),
    ).history;
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(after));
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return `richMixedEdit(${JSON.stringify(this.op)})`;
  }
}

export class RichMixedEditIfChangedCommand implements RichMixedFcCommand {
  constructor(private readonly op: MixedEditOp) {}
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    const before = sut.history.state;
    const after = applyRichMixedEdit(before, this.op);
    if (after === undefined) {
      sut.history = executeIfChanged(
        sut.history,
        makeSeriesCommand(this.op.kind, before, before),
        () => true,
      ).history;
      reconcileRichMixed(m, sut);
      return;
    }
    sut.history = executeIfChanged(
      sut.history,
      makeSeriesCommand(this.op.kind, before, after),
      () => false,
    ).history;
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(after));
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return `richMixedEditIfChanged(${JSON.stringify(this.op)})`;
  }
}

export class RichMixedCompositeCommand implements RichMixedFcCommand {
  constructor(private readonly ops: readonly MixedEditOp[]) {}
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    const subCommands: Command<AnchorSeries>[] = [];
    let cursor = sut.history.state;
    const before = cursor;
    for (const op of this.ops) {
      const after = applyRichMixedEdit(cursor, op);
      if (after === undefined) continue;
      subCommands.push(makeSeriesCommand(op.kind, cursor, after));
      cursor = after;
    }
    if (subCommands.length === 0) {
      reconcileRichMixed(m, sut);
      return;
    }
    const postChain = cursor;
    const composite = createCompositeCommand('bughunt/rich-mixed-edit-chain', subCommands);
    sut.history = execute(sut.history, composite).history;
    m.model = modelExecute(m.model, viewSeries(before), viewSeries(postChain));
    expect(viewSeries(sut.history.state)).toEqual(viewSeries(postChain));
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return `richMixedComposite(${this.ops.length} ops)`;
  }
}

export class CheckpointCommand implements RichMixedFcCommand {
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    const before = sut.history.state;
    const reloaded = checkpointReload(before);
    // save∘load == identity: the reload MUST be structurally identical. If it is
    // not, this expectation fails loudly (a persistence bug). When identical the
    // checkpoint is a no-op against the history (no entry pushed) but we still
    // push it through the real execute path with a content-derived no-op guard so
    // the ghost-suppression contract (教訓 5.24) is exercised on a save→load step.
    expect(viewSeries(reloaded)).toEqual(viewSeries(before));
    const isNoOp = (cur: AnchorSeries) =>
      JSON.stringify(viewSeries(reloaded)) === JSON.stringify(viewSeries(cur));
    sut.history = executeIfChanged(
      sut.history,
      makeSeriesCommand('checkpoint', before, reloaded),
      isNoOp,
    ).history;
    // The reloaded series is identical, so isNoOp is true and NOTHING is pushed:
    // history and model are both unchanged.
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return 'checkpoint';
  }
}

export class RichMixedUndoCommand implements RichMixedFcCommand {
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    sut.history = undo(sut.history).history;
    m.model = modelUndo(m.model);
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return 'undo';
  }
}

export class RichMixedRedoCommand implements RichMixedFcCommand {
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    sut.history = redo(sut.history).history;
    m.model = modelRedo(m.model);
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return 'redo';
  }
}

export class RichMixedClearRedoCommand implements RichMixedFcCommand {
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    sut.history = clearRedo(sut.history);
    m.model = modelClearRedo(m.model);
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return 'clearRedo';
  }
}

export class RichMixedSetLimitCommand implements RichMixedFcCommand {
  constructor(private readonly limit: number) {}
  check(): boolean {
    return true;
  }
  run(m: RichMixedModelState, sut: RichMixedSut): void {
    sut.history = withLimit(sut.history, this.limit);
    m.model = modelWithLimit(m.model, this.limit);
    reconcileRichMixed(m, sut);
  }
  toString(): string {
    return `setLimit(${this.limit})`;
  }
}

export const richMixedCommandsArb: fc.Arbitrary<Iterable<RichMixedFcCommand>> = fc.commands(
  [
    mixedEditOpArb.map((op): RichMixedFcCommand => new RichMixedEditCommand(op)),
    mixedEditOpArb.map((op): RichMixedFcCommand => new RichMixedEditIfChangedCommand(op)),
    fc
      .array(mixedEditOpArb, { minLength: 1, maxLength: 4 })
      .map((ops): RichMixedFcCommand => new RichMixedCompositeCommand(ops)),
    fc.constant(new CheckpointCommand() as RichMixedFcCommand),
    fc.constant(new RichMixedUndoCommand() as RichMixedFcCommand),
    fc.constant(new RichMixedUndoCommand() as RichMixedFcCommand), // weight drains
    fc.constant(new RichMixedRedoCommand() as RichMixedFcCommand),
    fc.constant(new RichMixedRedoCommand() as RichMixedFcCommand),
    fc.constant(new RichMixedClearRedoCommand() as RichMixedFcCommand),
    fc.integer({ min: 1, max: 4 }).map((n): RichMixedFcCommand => new RichMixedSetLimitCommand(n)),
  ],
  { maxCommands: 44 },
);
