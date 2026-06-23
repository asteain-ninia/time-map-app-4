// U44 — the LIVE U13 binding (was a type骨格; now the real adapter).
//
// WHY THIS FILE EXISTS (integration-lens honesty, 教訓 5.33):
// The composition root (App.tsx) hands each edit tool a `startProcess` closure.
// Binding the LIVE U13 orchestrator is NOT a「契約越し1行差し替え」: it requires a
// full `ConsistencyPorts<DomainRoot, Snapshot>` adapter that binds U09 (time) /
// U10 (spatial) / U06 (difference) / U12 (single-undo) over the LIVE domain root,
// plus an `applyProposal` that materialises an edit snapshot into that root. The
// snapshot→history domain op is U44's pure {@link applyAddProposal} /
// {@link applySplitProposal} (src/domain/editing/apply-proposal.ts); this module
// is the thin UI adapter that wires those + the four dependency ports so the
// orchestrator's fixed-order pipeline runs over the live project.
//
// The binding READS the current root via getRoot at process-start (not a stale
// capture) and RETURNS a ProcessResult — it never writes the store itself
// (教訓 5.6 / 5.22). The controller's onCommitted performs the single store write.

import {
  startProcess as orchestratorStart,
  applyResolutions as orchestratorApplyResolutions,
  PROCESS_STATUS,
  REJECTION_KIND,
  MSG_INTERNAL_ERROR,
  type ConsistencyPorts,
  type EditProposal,
  type ProcessResult,
  type RejectedResult,
  type Conflict,
  type Resolution,
  type TimeCheckResult,
  type SpatialCheckResult,
  conflictsFromOverlapPairs,
} from '../domain/consistency/index';
import {
  createCompositeCommand,
  defineCommandKind,
  type Command,
  type CommandOutcome,
} from '../domain/command/index';
import { createCommandResult, type CommandResult } from '../domain/command/result';
import type { AnchorId, DomainId, FeatureId, RingId, VertexId } from '../domain/ids';
import type { DomainProject, FeatureHistory } from '../domain/persistence/index';
import type { AddSnapshot } from '../domain/add/index';
import type { SplitSnapshot } from '../domain/knife/index';
import type { MergeSnapshot } from '../domain/merge/index';
import type { FeatureSnapshot } from '../domain/editing/index';
import {
  applyAddProposal,
  applyAffiliationProposal,
  applyEditProposal,
  applyMergeProposal,
  applySplitProposal,
  deriveAnchorId,
  findHistoryContaining,
  type AffiliationSnapshot,
} from '../domain/editing/apply-proposal';
import { createAnchor, createAnchorSnapshot, type Anchor } from '../domain/anchor';
import {
  applyPastEdit,
  changeStart,
  setEnd,
  deleteAnchor,
  type AnchorSeries,
  type RejectReason,
} from '../domain/anchor-series';
import type { AnchorIntervalEditIntent } from './property/index';
import { ANCHOR_INTERVAL_OP } from './property/index';
import {
  createDeletionState,
  createDeleteFeatureCommand,
  isNoOpDeletion,
} from '../domain/deletion/index';
import { getCalendar, type Calendar } from '../domain/time/calendar';
import { validate as validateTimePoint } from '../domain/time/validate';
import { featuresAt, verticesAt } from './live-lookup';
import { buildForest } from '../domain/hierarchy/forest';
import {
  extractTerminalShapes,
  createTerminalShapeCache,
  type TerminalShapeCache,
} from '../domain/spatial/index';
import { detectTerminalOverlaps } from '../domain/spatial/index';
import { resolveLeafShape } from '../domain/hierarchy/resolve-shape';
import { difference, isOk } from '../domain/geometry/index';
import { quantizeCoordinate } from '../domain/geometry/index';
import { isMultiPolygonEmpty, type GeoMultiPolygon } from '../domain/geometry/types';
import {
  featureDisplayName,
  withLeafShape,
  type Feature,
  type LeafFeature,
} from '../domain/feature';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../domain/ring';
import { createVertex, createVertexStore, type Vertex } from '../domain/vertex';
import type { TimePoint } from '../domain/time/time-point';

/** The live domain truth root the binding threads through every port (U14). */
export type DomainRoot = DomainProject;

/**
 * A reference to the live domain root the composition root owns plus the id ports
 * the conflict-resolution write-back needs. The binding reads the CURRENT root at
 * process-start time (not a stale capture) and never writes it back (教訓 5.6 /
 * 5.22); the host's onCommitted owns the single store-write path.
 */
export interface DomainRootAccess {
  /** Read the current committed domain root (single truth source, 技術方針 2.3). */
  readonly getRoot: () => DomainRoot;
  /** Mint a fresh vertex id (for U06 difference write-back rings). */
  readonly nextVertexId?: () => VertexId;
  /** Mint a fresh ring id (for U06 difference write-back rings). */
  readonly nextRingId?: () => RingId;
}

/** The per-tool live binding the composition root injects as `startProcess`. */
export interface LiveConsistencyBinding<Snapshot> {
  readonly ports: ConsistencyPorts<DomainRoot, Snapshot>;
  readonly startProcess: (proposal: EditProposal<Snapshot>) => ProcessResult<DomainRoot>;
  /**
   * Build the U35 `applyResolutions` adapter for ONE paused proposal (FR-62 /
   * 受け入れ基準 5). The conflict-resolution modal collects policies and calls the
   * returned closure ONCE with all of them; it re-runs U13's fixed-order pipeline
   * + U06 differences over the LIVE root (read at call time, never a stale
   * capture — 教訓 5.6) bound to the SAME per-process ports `startProcess` uses
   * (detectSpatial / applyResolution rebound to the proposal time), so the public
   * no-op ports are never exercised. Returns a {@link ProcessResult}; it never
   * writes the store (the modal's onCommitted owns the single write).
   */
  readonly applyResolutionsFor: (
    proposal: EditProposal<Snapshot>,
  ) => (resolutions: readonly Resolution[]) => ProcessResult<DomainRoot>;
}

export type CreateLiveAddBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<AddSnapshot>;

export type CreateLiveKnifeBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<SplitSnapshot>;

export type CreateLiveEditBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<FeatureSnapshot>;

export type CreateLiveMergeBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<MergeSnapshot>;

export type CreateLiveAffiliationBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<AffiliationSnapshot>;

export type MakeSingleUndoCommand = (
  baseline: DomainRoot,
  finalState: DomainRoot,
  touched: readonly FeatureId[],
) => Command<DomainRoot>;

// --- shared port implementations (U09 / U10 / U06 / U12) --------------------

const calendar: Calendar = getCalendar('gregorian');

/**
 * Run the orchestrator over the live ports, converting an UNEXPECTED port throw
 * into a typed `Rejected`/internal-error {@link ProcessResult} (教訓 5.26 / 5.22).
 *
 * WHY (error-path honesty, integration-lens): the U13 orchestrator is pure and
 * does NOT wrap its ports in try/catch — by contract a port returns a value, it
 * never throws (types.ts §Dependency ports). U44's `applyProposal` adapter
 * (apply-proposal.ts) is the one place that can still THROW on a degenerate
 * domain root (a split inheritor that is absent / not a leaf / missing from its
 * effective snapshot — only reachable from stale or repaired data, never from a
 * clean knife assembly). If that throw escaped `startProcess` it would unwind
 * through the controller's `save` (useAddTool.ts) BEFORE the discriminated-result
 * switch, so NO Japanese rejection would show and the transient session/draft
 * would not be cleaned up. We pin the contract here at the live seam: any
 * unexpected throw becomes the documented internal-error rejection the UI already
 * handles, carrying the original error as machine-readable `detail`.
 */
function runGuarded<S, Snapshot>(
  root: S,
  proposal: EditProposal<Snapshot>,
  ports: ConsistencyPorts<S, Snapshot>,
): ProcessResult<S> {
  try {
    return orchestratorStart(root, proposal, ports);
  } catch (error) {
    const rejection: RejectedResult = {
      status: PROCESS_STATUS.Rejected,
      kind: REJECTION_KIND.Internal,
      message: MSG_INTERNAL_ERROR,
      detail: error instanceof Error ? error.message : String(error),
    };
    return rejection;
  }
}

const LIVE_COMMIT_KIND = defineCommandKind('u44-live-commit');
const DELETE_COMMIT_KIND = defineCommandKind('u44-delete-commit');
const INTERVAL_COMMIT_KIND = defineCommandKind('u44-interval-commit');

/**
 * U09 — temporal-consistency check. For an add the feature is new (no existing
 * series), so the only temporal validity is that the anchor time is a valid
 * TimePoint on the calendar; for an edit on an existing feature the proposal time
 * must also be resolvable. We delegate to U02 `validate` (single source of the
 * time rule) and never decompose year/month/day here (教訓 5.16).
 */
function checkTimeOver<Snapshot>(
  _current: DomainRoot,
  proposal: EditProposal<Snapshot>,
): TimeCheckResult {
  const v = validateTimePoint(proposal.anchorTime, calendar);
  return v.ok ? { ok: true } : { ok: false, reason: v.error };
}

/**
 * Like {@link checkTimeOver} but ALSO requires the proposal's existing feature to be
 * EFFECTIVE at the anchor time (for an edit/split on a feature that already exists).
 *
 * WHY (error-path honesty, Codex U44 true-positive): editing / splitting a feature
 * at a time where it is not effective (before its first anchor, past a set end, or
 * inside a temporal enclave) passes the calendar-validity check, then U44's
 * `applyProposal` cannot find the inheritor in the effective snapshot. Without this
 * gate that surfaced as a generic Internal-error rejection; here we reject it as a
 * typed TIME violation so the user sees a time-domain reason. The feature may live
 * inside a multi-feature snapshot (an aggregate's child), so we test the union of
 * features effective at the time, not just same-id histories.
 */
function checkTimeOverExisting<Snapshot>(
  current: DomainRoot,
  proposal: EditProposal<Snapshot>,
): TimeCheckResult {
  const base = checkTimeOver(current, proposal);
  if (!base.ok) return base;
  const effective = featuresAt(current, proposal.anchorTime).some(
    (f) => f.id === proposal.featureId,
  );
  if (effective) return { ok: true };
  return {
    ok: false,
    reason: { code: 'featureNotEffectiveAtTime', featureId: String(proposal.featureId) },
  };
}

/**
 * A display-name lookup over the trial state at the anchor time (FR-62).
 *
 * Falls back to the feature id whenever the name is missing OR blank
 * (unnamed faces are the default — the add form commits an empty name), so the
 * conflict modal's priority radios and overlap rows always carry an identifier
 * the user can disambiguate by. This mirrors the 地物一覧 label rule in
 * SidebarContent (name → id fallback): a `??` alone is insufficient because an
 * empty string is present-but-blank, not absent.
 */
function displayNamesAt(root: DomainRoot, time: TimePoint): (id: FeatureId) => string {
  const byId = new Map<FeatureId, Feature>();
  for (const f of featuresAt(root, time)) byId.set(f.id, f);
  return (id) => {
    const f = byId.get(id);
    return f !== undefined ? featureDisplayName(f) : String(id);
  };
}

/**
 * U10 — terminal-vs-terminal spatial overlap detection over the trial result
 * state at the proposal's anchor time. Builds the forest from the features
 * effective at that time, extracts terminal shapes (aggregates excluded by
 * U10's adapter), runs the exclusion detector, and maps the raw overlap pairs to
 * structured U13 {@link Conflict}s with the conflict time pinned to the anchor.
 */
function detectSpatialAt<Snapshot>(
  proposal: EditProposal<Snapshot>,
  cache?: TerminalShapeCache,
): (resultState: DomainRoot) => SpatialCheckResult {
  return (resultState) => {
    const time = proposal.anchorTime;
    const features = featuresAt(resultState, time);
    const vertices = verticesAt(resultState, time);
    const forest = buildForest(features);
    // bughunt3: thread the binding's long-lived cache so an edit confirm re-resolves
    // ONLY the touched terminal(s); the other 5,000-scale terminals reuse their prior
    // shape (immutable features/vertices ⇒ reference identity proves no change).
    const terminals = extractTerminalShapes(forest, vertices, cache);
    const pairs = detectTerminalOverlaps(terminals);
    const names = displayNamesAt(resultState, time);
    return conflictsFromOverlapPairs(pairs, names, () => ({ kind: 'point', at: time }));
  };
}

/**
 * Editing-constraint re-validation over the trial result state. The add / split
 * snapshot constructors already enforce shape validity (ring alternation,
 * positive area) at assembly time (U23 / U26), so there is no separate
 * constraint to re-evaluate here beyond the spatial detection that follows. We
 * return no violations (an empty list ⇒ ok, 教訓 5.18) rather than re-deriving a
 * second constraint source (過少共有 / 二重真実源 を避ける).
 */
function checkConstraints(resultState: DomainRoot): readonly unknown[] {
  void resultState;
  return [];
}

/**
 * U12 — wrap the net change (baseline → finalState) as ONE indivisible command
 * (single undo unit, FR-73 / FR-94). The orchestrator hands the baseline and
 * final state plus the touched feature ids; the command is a whole-state swap
 * (the domain root is immutable, so execute returns the captured final and undo
 * restores the captured baseline — a deterministic replay, 教訓 5.20).
 */
function makeCommand(
  baseline: DomainRoot,
  finalState: DomainRoot,
  touched: readonly FeatureId[],
): Command<DomainRoot> {
  const baselineIds = new Set<FeatureId>(baseline.histories.map((h) => h.featureId));
  const finalIds = new Set<FeatureId>(finalState.histories.map((h) => h.featureId));
  const created = new Set<DomainId>();
  const survived = new Set<DomainId>();
  // finding5 — derive created/survived from the ACTUAL history-id delta, not only
  // the orchestrator-supplied `touched`. For a split, the inheritor is the
  // proposal.featureId (in `touched`) but the NON-inherited new feature is born
  // INSIDE applyProposal and never appears in `touched` (touchedFeatureIds only
  // unions the proposal id + resolution participants). Diffing baseline↔final
  // histories captures that new feature as `created`, so undo/redo's selection
  // re-resolution promotes / drops it correctly (教訓 5.11 / FR-94). The supplied
  // `touched` is unioned in so resolution-participant edits stay accounted for.
  for (const id of finalIds) {
    if (baselineIds.has(id)) survived.add(id);
    else created.add(id);
  }
  for (const id of touched) {
    if (!created.has(id) && finalIds.has(id)) survived.add(id);
  }
  // The full touched set = every id that participated (the delta + the supplied).
  const touchedSet: ReadonlySet<DomainId> = new Set<DomainId>([
    ...created,
    ...survived,
  ]);
  const forward: CommandResult = createCommandResult({ created, survived, touched: touchedSet });
  const backward: CommandResult = createCommandResult({
    deleted: created,
    survived,
    touched: touchedSet,
  });
  // A whole-state-swap command: the domain root is immutable, so execute/redo
  // return the captured final state and undo restores the captured baseline,
  // ignoring the live `state` argument (a deterministic replay, 教訓 5.20). The
  // `state` arg is part of the U12 Command contract; we reference it via `void`
  // so the swap intent is explicit and the contract signature stays exact.
  const cmd: Command<DomainRoot> = {
    kind: LIVE_COMMIT_KIND,
    label: 'edit',
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: baseline, result: backward };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // Wrap in a composite so it is recorded as ONE undo unit consistently with the
  // rest of the system (isCompositeCommand-friendly; FR-94).
  return createCompositeCommand('edit', [cmd]);
}

// --- U06 difference write-back (applyResolution) ----------------------------

/** Rebuild a leaf shape from a GeoMultiPolygon, minting ids via the access ports. */
function shapeFromMultiPolygon(
  mp: GeoMultiPolygon,
  nextVertexId: () => VertexId,
  nextRingId: () => RingId,
): { shape: ReturnType<typeof createShape>; vertices: Vertex[] } | undefined {
  const vertices: Vertex[] = [];
  const rings: Ring[] = [];

  // Materialise ONE GeoJSON ring into a fresh vertex run + its ids. Returns
  // undefined for a degenerate ring (<3 vertices) so the caller can skip it.
  const buildRing = (coords: GeoMultiPolygon[number][number]): VertexId[] | undefined => {
    const vertexIds: VertexId[] = [];
    for (const c of coords) {
      const v = createVertex(nextVertexId(), quantizeCoordinate(c));
      vertices.push(v);
      vertexIds.push(v.id);
    }
    return vertexIds.length >= 3 ? vertexIds : undefined;
  };

  for (const poly of mp) {
    // poly[0] is the outer ring; poly[1..] are HOLES (a difference can carve a
    // priority feature out of the interior of the adjust feature, yielding an
    // outer ring + hole). Dropping the holes would re-create the very overlap the
    // resolution removed, so U13 would re-detect it and never converge — carry
    // every hole, parented to this piece's outer ring (FR-26 / 教訓 5.20).
    const outer = poly[0];
    if (outer === undefined) continue;
    const outerIds = buildRing(outer);
    if (outerIds === undefined) continue;
    const outerRingId = nextRingId();
    rings.push(createTerritoryRing(outerRingId, outerIds));
    for (let h = 1; h < poly.length; h += 1) {
      const holeCoords = poly[h];
      if (holeCoords === undefined) continue;
      const holeIds = buildRing(holeCoords);
      if (holeIds === undefined) continue;
      rings.push(createHoleRing(nextRingId(), holeIds, outerRingId));
    }
  }
  if (rings.length === 0) return undefined;
  return { shape: createShape(rings), vertices };
}

/**
 * U06 — apply one resolution: subtract the priority feature's overlap from the
 * adjust feature, writing the trimmed shape back into the trial state. Returns
 * the new state, or `undefined` when the boolean op was rejected / the adjust
 * feature is not a resolvable leaf (so the orchestrator refuses rather than
 * commit a broken shape, 教訓 5.22 + R2). The adjust feature's history anchor at
 * the anchor time is rebuilt with the trimmed shape.
 */
function applyResolutionAt(
  access: DomainRootAccess,
  anchorTime: TimePoint,
): (state: DomainRoot, conflict: Conflict, resolution: Resolution) => DomainRoot | undefined {
  const nextVertexId = access.nextVertexId;
  const nextRingId = access.nextRingId;
  return (state, _conflict, resolution) => {
    if (nextVertexId === undefined || nextRingId === undefined) return undefined;
    const adjustId = resolution.adjustFeatureId;
    const features = featuresAt(state, anchorTime);
    const vertices = verticesAt(state, anchorTime);
    // Index the effective-feature list ONCE into a Map for O(1) lookups: this
    // closure is invoked up to maxRounds × #conflicts times in the convergence
    // loop (orchestrator U06), and the previous two Array.find scans were each
    // O(n) over the full (5,000-scale) feature list — O(rounds × conflicts × n)
    // redundant work. Mirrors the displayNamesAt byId pattern (bughunt-t2).
    const byId = new Map<FeatureId, Feature>();
    for (const f of features) byId.set(f.id, f);
    const adjust = byId.get(adjustId);
    const priority = byId.get(resolution.priorityFeatureId);
    if (adjust === undefined || priority === undefined) return undefined;
    if (adjust.kind !== 'leaf' || priority.kind !== 'leaf') return undefined;

    const adjustArea = resolveLeafShape(adjust.shape, vertices);
    const priorityArea = resolveLeafShape(priority.shape, vertices);
    if (adjustArea === undefined || priorityArea === undefined) return undefined;

    const diff = difference(adjustArea, priorityArea);
    if (!isOk(diff)) return undefined;
    if (isMultiPolygonEmpty(diff.result)) {
      // The adjust feature is fully covered — there is nothing left; refuse so the
      // user picks a different priority rather than silently deleting a feature.
      return undefined;
    }
    const built = shapeFromMultiPolygon(diff.result, nextVertexId, nextRingId);
    if (built === undefined) return undefined;

    const trimmed: LeafFeature = withLeafShape(adjust, built.shape);
    return rewriteFeatureAtTime(state, adjustId, anchorTime, trimmed, built.vertices);
  };
}

/**
 * Write the trimmed `feature` (carrying its new vertices) into `featureId`'s
 * history AT the resolution `anchorTime`, returning a new project.
 *
 * WHY applyPastEdit, NOT an in-place effective-entry swap (temporal-correctness
 * fix): a resolution at year 200 must change the adjust feature only FROM year
 * 200 onward. The previous in-place rewrite replaced the entry effective at the
 * conflict time, so a feature anchored at year 100 (still effective at 200) had
 * its year-100 anchor overwritten — silently mutating its shape for years
 * 100–199 too. `applyPastEdit` instead UPDATES the anchor when one already starts
 * exactly at `anchorTime`, or INSERTS a new anchor at `anchorTime` inheriting the
 * effective state otherwise (U09 §5.7), so earlier slots are untouched (FR-55).
 * The anchor id is derived deterministically (deriveAnchorId) so a redo replays
 * the same identity (教訓 5.20), consistent with apply-proposal.ts.
 */
function rewriteFeatureAtTime(
  state: DomainRoot,
  featureId: FeatureId,
  anchorTime: TimePoint,
  feature: Feature,
  newVertices: readonly Vertex[],
): DomainRoot | undefined {
  // The adjust feature may live INSIDE a multi-feature snapshot (e.g. an
  // aggregate's child leaf), so resolve by snapshot containment, not only by
  // history.featureId — otherwise a resolvable spatial conflict on such a leaf
  // would fall through to an internal rejection instead of being trimmed (shares
  // the U44 containment lookup so apply-proposal and the U06 write-back agree).
  const found = findHistoryContaining(state, featureId, anchorTime, calendar);
  if (found === undefined) return undefined;
  const { index, history } = found;

  const newSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      // Base the new anchor on the state effective at anchorTime: swap only the
      // adjust feature for its trimmed form and carry the difference's new
      // vertices alongside the inherited ones (the whole snapshot is one unit).
      const base =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : { features: [feature] as readonly Feature[], vertices: createVertexStore([]) };
      const features = base.features.some((f) => f.id === featureId)
        ? base.features.map((f) => (f.id === featureId ? feature : f))
        : [...base.features, feature];
      const vertices = createVertexStore([...base.vertices.byId.values(), ...newVertices]);
      return createAnchor(
        deriveAnchorId(featureId, anchorTime),
        createAnchorSnapshot(features, vertices),
      );
    },
    calendar,
  );

  // Preserve the OWNING history's id (it may be an aggregate that carries the
  // adjust leaf as a child); only the feature inside the snapshot was trimmed.
  const newHistory: FeatureHistory = { featureId: history.featureId, series: newSeries };
  const histories = state.histories.map((h, i) => (i === index ? newHistory : h));
  return { histories, settings: state.settings, baseMap: state.baseMap };
}

// --- factories --------------------------------------------------------------

/**
 * Rebind the base ports to ONE proposal: detectSpatial / applyResolution need the
 * proposal's anchor time, which the orchestrator does not thread through (it only
 * passes the result state). Every confirm path (startProcess) AND every resolution
 * path (applyResolutionsFor) uses the SAME bound set so a confirm and a later
 * apply-resolutions over the same proposal see identical spatial detection (no
 * 二重真実源). The public `applyResolution` no-op is thus never reached.
 */
function bindPortsToProposal<Snapshot>(
  access: DomainRootAccess,
  base: ConsistencyPorts<DomainRoot, Snapshot>,
  proposal: EditProposal<Snapshot>,
  spatialCache?: TerminalShapeCache,
): ConsistencyPorts<DomainRoot, Snapshot> {
  return {
    ...base,
    detectSpatial: detectSpatialAt(proposal, spatialCache),
    applyResolution: applyResolutionAt(access, proposal.anchorTime),
  };
}

/**
 * Run U13's `applyResolutions` over the live root + the proposal-bound ports,
 * converting an unexpected port throw into a typed internal-error rejection
 * (same guard discipline as {@link runGuarded}; 教訓 5.26).
 */
function runResolutionsGuarded<Snapshot>(
  access: DomainRootAccess,
  base: ConsistencyPorts<DomainRoot, Snapshot>,
  proposal: EditProposal<Snapshot>,
  resolutions: readonly Resolution[],
  spatialCache?: TerminalShapeCache,
): ProcessResult<DomainRoot> {
  try {
    return orchestratorApplyResolutions(
      access.getRoot(),
      proposal,
      resolutions,
      bindPortsToProposal(access, base, proposal, spatialCache),
    );
  } catch (error) {
    const rejection: RejectedResult = {
      status: PROCESS_STATUS.Rejected,
      kind: REJECTION_KIND.Internal,
      message: MSG_INTERNAL_ERROR,
      detail: error instanceof Error ? error.message : String(error),
    };
    return rejection;
  }
}

/**
 * Build the per-proposal `applyResolutions` closure that ACCUMULATES policies by
 * conflict id across successive modal rounds (the stopping-property fix, 教訓 5.2 /
 * 5.5 / 受け入れ基準 7).
 *
 * WHY (re-競合 oscillation): the U13 orchestrator re-runs the WHOLE fixed-order
 * pipeline from the LIVE baseline on every `applyResolutions` call (nothing is
 * committed mid-flow — 教訓 5.22). If resolving c1 introduces a new conflict c2,
 * the modal's next apply sends ONLY c2's policy; the orchestrator re-applies the
 * proposal to the baseline, re-detects c1 (unchanged baseline geometry), and —
 * with no policy for c1 — returns c1 as still-unresolved AGAIN. The two rounds
 * would then oscillate (c1 ⇄ c2) without ever converging.
 *
 * The fix is to remember every policy the user has chosen for THIS paused
 * proposal and pass the CUMULATIVE set on each retry, so an earlier-resolved
 * conflict stays resolved while the new round adds the fresh policy. A later
 * choice for the same conflict id replaces the earlier one (選び直し, FR-63). The
 * accumulator is private to one paused proposal and is dropped with the closure
 * when the modal commits / cancels (no cross-edit leak).
 */
function createAccumulatingApply<Snapshot>(
  access: DomainRootAccess,
  ports: ConsistencyPorts<DomainRoot, Snapshot>,
  proposal: EditProposal<Snapshot>,
  spatialCache?: TerminalShapeCache,
): (resolutions: readonly Resolution[]) => ProcessResult<DomainRoot> {
  const accumulated = new Map<string, Resolution>();
  return (resolutions) => {
    for (const r of resolutions) accumulated.set(r.conflictId, r);
    return runResolutionsGuarded(access, ports, proposal, [...accumulated.values()], spatialCache);
  };
}

/**
 * Build the live add binding (U23 → U13). The `applyProposal` port is U44's pure
 * {@link applyAddProposal}; the other ports are the shared U09/U10/U06/U12
 * adapters above bound over the live root read at process-start.
 */
export const createLiveAddBinding: CreateLiveAddBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, AddSnapshot> = {
    applyProposal: (current, proposal) => applyAddProposal(current, proposal),
    checkTime: checkTimeOver,
    checkConstraints,
    detectSpatial: (resultState) => {
      // detectSpatial needs the proposal time; the orchestrator only passes the
      // result state, so we re-derive the time from the latest add (the only
      // committed time is the anchor). We bind per-process below instead.
      void resultState;
      return [];
    },
    applyResolution: () => undefined,
    makeCommand,
  };
  // bughunt3: one incremental terminal-shape cache per binding, threaded through
  // every confirm / apply-resolutions over this binding so an edit re-resolves
  // only the touched terminals (NFR 5.x — 5,000-terminal scale stays O(touched)).
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live EDIT binding (U24 vertex-move / feature-move → U13). This is the
 * binding the composition root hands the {@link createEditSessionPort} adapter so a
 * real edit-mode handle drag's `confirmRelease` reaches the SAME fixed-order U13
 * pipeline an add / split goes through (受け入れ基準9 / 教訓5.7「ロジックがあっても UI
 * から呼ばれず機能しない状態を作らない」).
 *
 * `applyProposal` is U44's pure {@link applyEditProposal} (in-place anchor rewrite /
 * deletion over the live root); the temporal gate is {@link checkTimeOverExisting}
 * (the edited feature must be EFFECTIVE at the anchor time — editing it where it does
 * not exist is a typed TIME rejection, never a generic internal error); the spatial
 * detection / U06 difference write-back / U12 single-undo ports are the SAME shared
 * adapters the add / split bindings use, bound per-proposal so a confirm and any
 * later apply-resolutions over the same proposal see identical detection (no 二重
 * 真実源). The binding reads the current root via getRoot at process-start (never a
 * stale capture, 教訓 5.6) and never writes the store — the host's onCommitted owns
 * the single store-write path.
 */
export const createLiveEditBinding: CreateLiveEditBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, FeatureSnapshot> = {
    applyProposal: (current, proposal) => applyEditProposal(current, proposal, calendar),
    checkTime: checkTimeOverExisting,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand,
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live knife/split binding (U26 → U13). `applyProposal` is U44's
 * {@link applySplitProposal} (inheritor update + new feature) bound to the active
 * calendar; the other ports mirror the add binding.
 */
export const createLiveKnifeBinding: CreateLiveKnifeBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, SplitSnapshot> = {
    applyProposal: (current, proposal) => applySplitProposal(current, proposal, calendar),
    checkTime: checkTimeOverExisting,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand,
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live MERGE binding (U30 → U13). `applyProposal` is U44's
 * {@link applyMergeProposal} (fold targets into one result feature over the project's
 * histories at the anchor time) bound to the active calendar; the other ports mirror
 * the add / knife bindings (temporal validity, spatial detection over the trial state,
 * U06 difference write-back, U12 single-undo). The merge proposal's preconditions
 * (≥2 targets / 対象時間に存在 / 非縦方向) are validated INSIDE the domain
 * `buildMergeProposal` the controller calls before this binding runs, so the result
 * feature handed here is already a valid assembly (教訓 5.26). The binding reads the
 * current root via getRoot at process-start (never a stale capture, 教訓 5.6) and never
 * writes the store — the host's onCommitted owns the single store-write path.
 */
export const createLiveMergeBinding: CreateLiveMergeBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, MergeSnapshot> = {
    applyProposal: (current, proposal) => applyMergeProposal(current, proposal, calendar),
    // The proposal anchors on the NEW result feature (createdIds), which is not yet
    // effective at the anchor time — so the time gate is calendar-validity only (like
    // the add binding), NOT checkTimeOverExisting (which would reject the not-yet-born
    // result as featureNotEffectiveAtTime). The targets' presence at the time is already
    // enforced by buildMergeProposal's validateMergePreconditions (教訓 5.26).
    checkTime: checkTimeOver,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand,
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live 所属変更 (reparent / affiliation-change) binding (U28 → U13).
 * `applyProposal` is U44's {@link applyAffiliationProposal} (reparent the targets +
 * create新上位領域 + auto-prune emptied aggregates over the project's histories at the
 * anchor time) bound to the active calendar; the other ports mirror the merge binding
 * (calendar-validity time gate, spatial detection over the trial state, U06 difference
 * write-back, U12 single-undo). The reparent's preconditions (循環 / 存在期間 / 対象
 * 種別 / 確定後階層整合) are validated INSIDE the domain {@link buildAffiliationProposal}
 * the controller calls before this binding runs, so the after-state handed here is
 * already a valid assembly (教訓 5.26).
 *
 * WHY checkTime (not checkTimeOverExisting): the proposal anchors on a continuing leaf
 * target that IS effective at the time, but a `create`-decision may also introduce a
 * not-yet-born aggregate; the targets' presence at the time is already enforced by
 * buildAffiliationProposal, so the live gate is calendar-validity only (like merge),
 * avoiding a spurious featureNotEffectiveAtTime on the new aggregate. The binding reads
 * the current root via getRoot at process-start (never a stale capture, 教訓 5.6) and
 * never writes the store — the host's onCommitted owns the single store-write path.
 */
export const createLiveAffiliationBinding: CreateLiveAffiliationBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, AffiliationSnapshot> = {
    applyProposal: (current, proposal) => applyAffiliationProposal(current, proposal, calendar),
    checkTime: checkTimeOver,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand,
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

// --- U31 全錨削除 → DomainRoot whole-state-swap (FR-41 / FR-73 / FR-85) -------
//
// WHY THIS FILE (integration honesty, 教訓 5.7「ロジックがあっても UI から呼ばれず
// 機能しない状態を作らない」): U31 (src/domain/deletion) implements the indivisible
// 全錨 delete (sweep 全時間軸 + 双方向参照掃除 + 空集約の連鎖剪定, FR-41 / FR-35) as a
// pure {@link createDeleteFeatureCommand} over a flat {@link DeletionState} (an ordered
// anchor list). The LIVE truth root is U14's {@link DomainProject} (per-feature
// histories, each its own anchor series). This adapter is the ONE place that maps
// between the two so the 編集→削除 menu / Delete キー / (future) プロパティ削除ボタン all
// drive the SAME pure U31 logic — a single truth source for deletion (§4 / 教訓 5.30),
// never a second hand-rolled removal path.
//
// The map is positional: every anchor across every history is flattened in a stable
// (history, entry) order into the DeletionState; U31 rewrites each anchor in place
// (same id, same order) and may PRUNE features out of a snapshot; the swept anchors
// are folded back into their originating entries (start/end preserved), and a history
// whose every anchor snapshot is left empty is dropped wholesale (its feature ceased
// to exist across the whole timeline — 教訓 5.6 集約の連鎖消滅 / no幽霊 history).

/**
 * Build the indivisible 全錨 delete command for `targetId` over the live root, or
 * `null` when the feature is absent everywhere (a no-op the caller must NOT push —
 * 教訓 5.24 no幽霊 undo entry). The returned command is the SAME whole-state-swap
 * shape add / knife / edit commits use (via {@link makeCommand}), so it records as
 * ONE undo unit and its CommandResult drives selection re-resolution identically
 * (教訓 5.11 / 5.23): the deleted ids drop out of selection, undo brings them back.
 */
export function createDeleteFeatureCommandForRoot(
  root: DomainRoot,
  targetId: FeatureId,
): Command<DomainRoot> | null {
  // Flatten every history's anchors into the U31 view, remembering each anchor's
  // (history index, entry index) origin so the swept result folds back exactly.
  interface Origin {
    readonly historyIndex: number;
    readonly entryIndex: number;
  }
  const origins: Origin[] = [];
  const anchors: Anchor[] = [];
  root.histories.forEach((history, historyIndex) => {
    history.series.entries.forEach((entry, entryIndex) => {
      origins.push({ historyIndex, entryIndex });
      anchors.push(entry.anchor);
    });
  });

  const before = createDeletionState(anchors);
  if (isNoOpDeletion(before, targetId)) return null;

  // Run the pure U31 command once to obtain the swept after-anchors + the change
  // set. execute is a whole-state swap that ignores its input, so calling it on
  // `before` yields the planned after-state exactly.
  const command = createDeleteFeatureCommand(before, targetId);
  const outcome = command.execute(before);
  const afterAnchors = outcome.state.anchors;

  // Fold the swept anchors back into their originating histories, preserving each
  // entry's start/end (U31 only rewrites the snapshot, never the interval).
  const rebuiltEntries = root.histories.map((h) => h.series.entries.map((e) => e));
  afterAnchors.forEach((anchor, flatIndex) => {
    const origin = origins[flatIndex];
    if (origin === undefined) return;
    const slot = rebuiltEntries[origin.historyIndex];
    if (slot === undefined) return;
    const entry = slot[origin.entryIndex];
    if (entry === undefined) return;
    slot[origin.entryIndex] = { anchor, start: entry.start, end: entry.end };
  });

  const histories: FeatureHistory[] = [];
  root.histories.forEach((history, historyIndex) => {
    const entries = rebuiltEntries[historyIndex];
    if (entries === undefined) return;
    // Drop a history whose every anchor snapshot is now empty: its feature (and
    // any chain-pruned aggregate) ceased to exist across the whole timeline, so a
    // kept empty series would be a幽霊 orphan (教訓 5.6 / load-time consistency).
    const allEmpty = entries.every((e) => e.anchor.snapshot.features.length === 0);
    if (allEmpty) return;
    histories.push({ featureId: history.featureId, series: { entries } });
  });

  const finalState: DomainRoot = {
    histories,
    settings: root.settings,
    baseMap: root.baseMap,
  };

  // The lifecycle delta drives selection re-resolution (教訓 5.11): a feature
  // present in the baseline histories but absent from the final ones was DELETED
  // (the target plus any 連鎖-pruned aggregate, FR-35); everything still present
  // SURVIVED. NOTE: the shared {@link makeCommand} cannot be reused here — it only
  // ever reports `created` in the forward result (its lifecycle model is add/split,
  // where nothing disappears), so a deletion would silently report no `deleted`
  // ids and selection would keep the gone feature. We build the swap command with
  // the correct delete result directly (教訓 5.23 symmetric execute/undo).
  const baselineIds = new Set<FeatureId>(root.histories.map((h) => h.featureId));
  const finalIds = new Set<FeatureId>(histories.map((h) => h.featureId));
  const deleted = new Set<DomainId>();
  const survived = new Set<DomainId>();
  for (const id of baselineIds) {
    if (finalIds.has(id)) survived.add(id);
    else deleted.add(id);
  }
  const forward: CommandResult = createCommandResult({ deleted, survived });
  // Undo brings the deleted features back: report them as created so selection
  // re-resolution can promote them again, mirroring the forward touched set.
  const backward: CommandResult = createCommandResult({
    created: deleted,
    survived,
    touched: forward.touched,
  });

  const swap: Command<DomainRoot> = {
    kind: DELETE_COMMIT_KIND,
    label: 'delete',
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: root, result: backward };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // Wrap in a composite so it records as ONE indivisible undo unit, consistent with
  // every other commit (isCompositeCommand-friendly; FR-73 / FR-94).
  return createCompositeCommand('delete', [swap]);
}

// --- HB3-12 存続期間編集 → DomainRoot whole-state-swap (FR-54〜FR-59 / FR-73) -----
//
// WHY THIS EXISTS (integration honesty, 教訓 5.7「ロジックがあっても UI から呼ばれず
// 機能しない状態を作らない」): U09 (src/domain/anchor-series) implements changeStart /
// setEnd / deleteAnchor — moving WHEN a feature appears / disappears on the time axis —
// as pure, unit-tested ops, but NOTHING called them. The property panel showed存続期間
// bars (FR-84) read-only; editing 開始年/終了年 in 基本情報 only stored cosmetic
// attributes and never drove the actual anchor interval (the BasicAttributes are part of
// the SNAPSHOT, which applyEditProposal rewrites; the existence interval is the
// AnchorEntry start/end, which only these three U09 ops touch). This adapter is the ONE
// place that maps a UI {@link AnchorIntervalEditIntent} onto the right U09 op over the
// LIVE root, mirroring {@link createDeleteFeatureCommandForRoot}: a whole-state-swap
// command recorded as ONE undo unit whose CommandResult drives selection re-resolution.

/** The outcome of building an存続期間 command: a swap command, or a typed rejection. */
export type AnchorIntervalCommandResult =
  | { readonly ok: true; readonly command: Command<DomainRoot> }
  | { readonly ok: false; readonly reason: RejectReason };

/**
 * Run the U09 op named by `intent` against `series`, returning the new series or the
 * U09 rejection reason verbatim (so the UI surfaces the domain's own testable reason —
 * 教訓 5.26 — rather than a generic failure). The anchor id is the routing key; an
 * unknown id yields U09's `anchorNotFound`.
 */
function runIntervalOp(
  series: AnchorSeries,
  intent: AnchorIntervalEditIntent,
  anchorId: AnchorId,
): { ok: true; series: AnchorSeries } | { ok: false; reason: RejectReason } {
  const result =
    intent.op === ANCHOR_INTERVAL_OP.ChangeStart
      ? changeStart(series, anchorId, intent.newStart, calendar)
      : intent.op === ANCHOR_INTERVAL_OP.SetEnd
        ? setEnd(series, anchorId, intent.newEnd, calendar)
        : deleteAnchor(series, anchorId, calendar);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, series: result.series };
}

/**
 * Build the存続期間編集 command for `intent` over the live root, or a typed rejection
 * (HB3-12). The target feature's OWN {@link FeatureHistory} carries its anchor series
 * (U09); we run the matching U09 op (changeStart / setEnd / deleteAnchor) on it and swap
 * the project's histories with the updated series. The feature SURVIVES (its identity is
 * unchanged — only its existence interval moved), so the command reports it as survived,
 * which re-resolves selection without dropping it (教訓 5.11). Recorded as ONE undo unit
 * via the SAME whole-state-swap shape add / knife / edit / delete commits use.
 *
 * A feature whose own history is not found, or whose U09 op is rejected (the sole-anchor
 * delete guard INV-5, start≥end, out-of-range time, …) returns `{ ok: false, reason }`
 * so the host surfaces an honest message and pushes NO command (no幽霊 undo entry,
 * 教訓 5.24). Pure with respect to the root (returns a NEW project).
 */
export function createAnchorIntervalCommandForRoot(
  root: DomainRoot,
  intent: AnchorIntervalEditIntent,
): AnchorIntervalCommandResult {
  const index = root.histories.findIndex((h) => h.featureId === intent.featureId);
  const history = index >= 0 ? root.histories[index] : undefined;
  if (history === undefined) {
    return { ok: false, reason: { code: 'anchorNotFound', id: intent.anchorId } };
  }

  const run = runIntervalOp(history.series, intent, intent.anchorId);
  if (!run.ok) return { ok: false, reason: run.reason };

  const updatedHistory: FeatureHistory = { featureId: history.featureId, series: run.series };
  const histories = root.histories.map((h, i) => (i === index ? updatedHistory : h));
  const finalState: DomainRoot = { ...root, histories };

  // The feature's identity is unchanged — only its existence interval moved — so it
  // SURVIVES; report it touched so selection re-resolves against the new interval (a
  // feature whose start moved past the current time will be dropped by the existence
  // re-validation funnel, exactly as a time move would, 教訓 5.11). Symmetric execute /
  // undo (教訓 5.23): the root is immutable so the swap replays deterministically.
  const survived: ReadonlySet<DomainId> = new Set<DomainId>([intent.featureId]);
  const forward: CommandResult = createCommandResult({ survived });
  const backward: CommandResult = createCommandResult({ survived });

  const swap: Command<DomainRoot> = {
    kind: INTERVAL_COMMIT_KIND,
    label: 'interval',
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: root, result: backward };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // Wrap in a composite so it records as ONE indivisible undo unit (FR-73 / FR-94).
  return { ok: true, command: createCompositeCommand('interval', [swap]) };
}
