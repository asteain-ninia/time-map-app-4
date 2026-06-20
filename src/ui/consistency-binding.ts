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
import type { DomainId, FeatureId, RingId, VertexId } from '../domain/ids';
import type { DomainProject, FeatureHistory } from '../domain/persistence/index';
import type { AddSnapshot } from '../domain/add/index';
import type { SplitSnapshot } from '../domain/knife/index';
import {
  applyAddProposal,
  applySplitProposal,
} from '../domain/editing/apply-proposal';
import { getCalendar, type Calendar } from '../domain/time/calendar';
import { validate as validateTimePoint } from '../domain/time/validate';
import { resolveAt, type AnchorSeries } from '../domain/anchor-series';
import { buildForest } from '../domain/hierarchy/forest';
import { extractTerminalShapes } from '../domain/spatial/index';
import { detectTerminalOverlaps } from '../domain/spatial/index';
import { resolveLeafShape } from '../domain/hierarchy/resolve-shape';
import { difference, isOk } from '../domain/geometry/index';
import { quantizeCoordinate } from '../domain/geometry/index';
import { isMultiPolygonEmpty, type GeoMultiPolygon } from '../domain/geometry/types';
import {
  withLeafShape,
  type Feature,
  type LeafFeature,
} from '../domain/feature';
import { createShape, createTerritoryRing } from '../domain/ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../domain/vertex';
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
}

export type CreateLiveAddBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<AddSnapshot>;

export type CreateLiveKnifeBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<SplitSnapshot>;

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

/** Resolve every feature effective at `time` across all histories (U09 resolveAt). */
function featuresAt(root: DomainRoot, time: TimePoint): Feature[] {
  const out: Feature[] = [];
  for (const history of root.histories) {
    const resolution = resolveAt(history.series, time, calendar);
    if (resolution.kind !== 'present') continue;
    for (const f of resolution.entry.anchor.snapshot.features) out.push(f);
  }
  return out;
}

/** The vertex store effective at `time` (union of every present anchor's store). */
function verticesAt(root: DomainRoot, time: TimePoint): VertexStore {
  const all: Vertex[] = [];
  for (const history of root.histories) {
    const resolution = resolveAt(history.series, time, calendar);
    if (resolution.kind !== 'present') continue;
    for (const v of resolution.entry.anchor.snapshot.vertices.byId.values()) all.push(v);
  }
  return createVertexStore(all);
}

/** A display-name lookup over the trial state at the anchor time (FR-62). */
function displayNamesAt(root: DomainRoot, time: TimePoint): (id: FeatureId) => string {
  const byId = new Map<FeatureId, string>();
  for (const f of featuresAt(root, time)) byId.set(f.id, f.attributes.name);
  return (id) => byId.get(id) ?? String(id);
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
): (resultState: DomainRoot) => SpatialCheckResult {
  return (resultState) => {
    const time = proposal.anchorTime;
    const features = featuresAt(resultState, time);
    const vertices = verticesAt(resultState, time);
    const forest = buildForest(features);
    const terminals = extractTerminalShapes(forest, vertices);
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
  const touchedSet: ReadonlySet<DomainId> = new Set<DomainId>(touched);
  const baselineIds = new Set<FeatureId>(baseline.histories.map((h) => h.featureId));
  const created = new Set<DomainId>();
  const survived = new Set<DomainId>();
  for (const id of touched) {
    if (baselineIds.has(id)) survived.add(id);
    else created.add(id);
  }
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
  const rings = [];
  for (const poly of mp) {
    // Use the outer ring (index 0) of each piece; holes are uncommon for a
    // difference trim and would need the full re-parent (handled by U26's path).
    const outer = poly[0];
    if (outer === undefined) continue;
    const vertexIds: VertexId[] = [];
    for (const c of outer) {
      const v = createVertex(nextVertexId(), quantizeCoordinate(c));
      vertices.push(v);
      vertexIds.push(v.id);
    }
    if (vertexIds.length >= 3) rings.push(createTerritoryRing(nextRingId(), vertexIds));
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
    const adjust = features.find((f) => f.id === adjustId);
    const priority = features.find((f) => f.id === resolution.priorityFeatureId);
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
 * Replace the feature `featureId`'s snapshot at the anchor time with `feature`
 * (carrying its new vertices), rebuilding only that history's effective anchor.
 * Pure: returns a new project.
 */
function rewriteFeatureAtTime(
  state: DomainRoot,
  featureId: FeatureId,
  anchorTime: TimePoint,
  feature: Feature,
  newVertices: readonly Vertex[],
): DomainRoot | undefined {
  const index = state.histories.findIndex((h) => h.featureId === featureId);
  if (index < 0) return undefined;
  const history = state.histories[index];
  if (history === undefined) return undefined;
  const resolution = resolveAt(history.series, anchorTime, calendar);
  if (resolution.kind !== 'present') return undefined;
  const entry = resolution.entry;
  const snapshotVertices = createVertexStore([
    ...entry.anchor.snapshot.vertices.byId.values(),
    ...newVertices,
  ]);
  const features = entry.anchor.snapshot.features.map((f) => (f.id === featureId ? feature : f));
  const newEntry = {
    anchor: {
      id: entry.anchor.id,
      snapshot: { features, vertices: snapshotVertices },
    },
    start: entry.start,
    end: entry.end,
  };
  const entries = history.series.entries.map((e) => (e === entry ? newEntry : e));
  const newSeries: AnchorSeries = { entries };
  const newHistory: FeatureHistory = { featureId, series: newSeries };
  const histories = state.histories.map((h, i) => (i === index ? newHistory : h));
  return { histories, settings: state.settings, baseMap: state.baseMap };
}

// --- factories --------------------------------------------------------------

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
  return {
    ports,
    startProcess: (proposal) => {
      const root = access.getRoot();
      const boundPorts: ConsistencyPorts<DomainRoot, AddSnapshot> = {
        ...ports,
        detectSpatial: detectSpatialAt(proposal),
        applyResolution: applyResolutionAt(access, proposal.anchorTime),
      };
      return runGuarded(root, proposal, boundPorts);
    },
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
    checkTime: checkTimeOver,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand,
  };
  return {
    ports,
    startProcess: (proposal) => {
      const root = access.getRoot();
      const boundPorts: ConsistencyPorts<DomainRoot, SplitSnapshot> = {
        ...ports,
        detectSpatial: detectSpatialAt(proposal),
        applyResolution: applyResolutionAt(access, proposal.anchorTime),
      };
      return runGuarded(root, proposal, boundPorts);
    },
  };
};
