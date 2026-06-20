// U23 — add edit-proposal assembly (FR-76 / FR-59 / FR-77 / FR-39 / 教訓 5.15 /
// 5.16 / 5.19).
//
// Pure domain logic that assembles the INDIVISIBLE edit proposal handed to U13
// (spec §追加編集案): the new feature's first anchor as ONE complete-state
// snapshot — shape + attributes + color + parent linkage + the new vertices —
// keyed at the current timeline time as the anchor start. The proposal is built
// as a single value (FR-59 一体性): attributes / shape / parent are NEVER split
// into separate commands.
//
// 教訓 5.15 / 5.16: the anchor start is the UI-context CURRENT TIME (a full
// TimePoint value), NOT the system clock and NOT a decomposed year/month/day —
// the caller passes the complete `TimePoint` straight through.
//
// What this module does NOT do (spec §やらないこと): it does not run U13, detect
// conflicts, or mutate any shared state. It produces a value; the UI hands it to
// U13's `startProcess`. Vertex / feature ID minting is delegated to the injected
// id services so the proposal stays pure and deterministic (NFR 5.8 / 教訓 5.20).

import type { BasicAttributes, ColorInfo } from '../attributes';
import {
  ADD_TOOL_KIND,
  type AddToolKind,
} from './session';
import {
  createEditProposal,
  type EditProposal,
} from '../consistency/types';
import {
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  type Feature,
} from '../feature';
import type { FeatureId, RingId, VertexId } from '../ids';
import { createShape, createTerritoryRing, type Shape } from '../ring';
import type { TimePoint } from '../time/time-point';
import { createVertex, type Vertex } from '../vertex';

import {
  PARENT_SELECTION_KIND,
  type ParentSelection,
} from './session';
import { draftCoordinates, type ShapeDraft } from './shape-draft';

// --- The U23 snapshot (opaque to U13; spec §追加編集案) ----------------------

/**
 * The complete first-anchor snapshot for an added feature (spec §追加編集案,
 * FR-59). It bundles, as ONE value:
 *   - `feature`: the new feature (point / line / leaf) with its attributes,
 *     color, vertex/ring references AND parent linkage already applied,
 *   - `vertices`: every newly-minted vertex the feature references (教訓 5.20:
 *     undo info must capture dependent data; the snapshot is plain data),
 *   - `sharedCandidateIds`: for each new vertex that snapped onto an existing
 *     vertex, the existing feature id to share with (FR-30〜33). Empty when no
 *     placement snapped. This is advisory data the host's U13 port uses to wire
 *     shared vertices in the SAME undo unit; it is opaque to U13's orchestrator.
 *
 * U13 never reads inside this snapshot — it forwards it through its ports
 * (技術方針 / U13 contract). It is the `Snapshot` type parameter of
 * {@link EditProposal}.
 */
export interface AddSnapshot {
  readonly feature: Feature;
  readonly vertices: readonly Vertex[];
  /** New-vertex-id → existing feature id to share with (FR-30〜33). */
  readonly sharedCandidateIds: ReadonlyMap<VertexId, FeatureId>;
}

/** The fully-typed proposal this unit produces for U13. */
export type AddProposal = EditProposal<AddSnapshot>;

// --- ID minting ports (injected; pure & deterministic) ----------------------

/**
 * Minimal ID services the assembly needs. Injected so the proposal is built
 * without hidden global state and is deterministic under test (NFR 5.8 / 教訓
 * 5.37). The host backs these with U03's `nextRawId` + the branded constructors.
 */
export interface AddIdPorts {
  /** Mint a fresh feature id (not colliding with any existing feature). */
  readonly nextFeatureId: () => FeatureId;
  /** Mint a fresh vertex id (not colliding with any existing vertex). */
  readonly nextVertexId: () => VertexId;
}

// --- Property-form input (FR-97) --------------------------------------------

/**
 * The basic-property input captured by the property form (FR-97). The form's
 * save passes this in; it is combined with the shape + parent + current time to
 * build the proposal.
 */
export interface AddProperties {
  readonly attributes: BasicAttributes;
  readonly color: ColorInfo;
  /** Optional free display label (FR-40). */
  readonly kindLabel?: string;
}

// --- Parent linkage (FR-77 / FR-39) -----------------------------------------

/**
 * Resolve the optional `parentId` to attach to the new feature from the parent
 * selection (FR-77). Both 親なし (TopLevel) and Unset map to NO parent =
 * top-level (FR-39 最上位フラグ真 ⇔ 親領域なし同値: a feature with no parentId IS
 * top-level — there is no separate flag, so 親なし is simply the absence of a
 * parent). Only an explicit Parent selection yields a parentId. For point / line
 * the selection is always Unset → no parent.
 */
export function resolveParentId(parent: ParentSelection): FeatureId | undefined {
  return parent.kind === PARENT_SELECTION_KIND.Parent ? parent.parentId : undefined;
}

// --- Feature + vertex construction ------------------------------------------

interface BuiltGeometry {
  readonly vertices: Vertex[];
  readonly vertexIds: VertexId[];
  readonly sharedCandidateIds: Map<VertexId, FeatureId>;
}

/** Mint a vertex per draft coordinate, recording any shared-candidate linkage. */
function buildGeometry(draft: ShapeDraft, ids: AddIdPorts): BuiltGeometry {
  const coords = draftCoordinates(draft);
  const vertices: Vertex[] = [];
  const vertexIds: VertexId[] = [];
  const sharedCandidateIds = new Map<VertexId, FeatureId>();
  draft.vertices.forEach((placed, index) => {
    const coordinate = coords[index];
    // coords is derived 1:1 from draft.vertices, so `coordinate` is always present;
    // guard for noUncheckedIndexedAccess.
    if (coordinate === undefined) return;
    const id = ids.nextVertexId();
    vertices.push(createVertex(id, coordinate));
    vertexIds.push(id);
    const shared = placed.sharedCandidateId;
    if (shared != null) {
      sharedCandidateIds.set(id, shared);
    }
  });
  return { vertices, vertexIds, sharedCandidateIds };
}

function shapeFromRing(ringVertexIds: readonly VertexId[], ringId: RingId): Shape {
  return createShape([createTerritoryRing(ringId, ringVertexIds)]);
}

// --- Public: assemble the proposal ------------------------------------------

export interface AssembleProposalInput {
  readonly draft: ShapeDraft;
  readonly properties: AddProperties;
  readonly parent: ParentSelection;
  /** The current timeline time — the anchor start (教訓 5.15 / 5.16). */
  readonly currentTime: TimePoint;
  readonly ids: AddIdPorts;
  /**
   * Mint a fresh ring id (face only). Injected like the other id ports; omitted
   * for point/line where no ring is needed.
   */
  readonly nextRingId?: () => RingId;
}

/**
 * Assemble the indivisible {@link AddProposal} for U13 (spec §保存・錨確定,
 * FR-59 / FR-76). Steps, all in ONE value:
 *   1. mint vertices for the draft coordinates (recording shared-vertex links),
 *   2. build the new feature of the draft's kind, with attributes / color /
 *      optional kindLabel and the resolved parentId (FR-77 / FR-39),
 *   3. wrap it as the first-anchor snapshot,
 *   4. key the proposal at the current timeline time (教訓 5.15 / 5.16).
 *
 * The returned proposal's `featureId` is the new feature's id, so the host can
 * re-resolve selection from it after commit (教訓 5.11). For a face, `nextRingId`
 * MUST be supplied (a leaf needs a ring id); a missing ring-id port for a face
 * throws an internal error rather than building an invalid shape.
 */
export function assembleAddProposal(input: AssembleProposalInput): AddProposal {
  const { draft, properties, parent, currentTime, ids } = input;
  const geometry = buildGeometry(draft, ids);
  const featureId = ids.nextFeatureId();
  const parentId = resolveParentId(parent);
  const optional =
    properties.kindLabel === undefined
      ? parentId === undefined
        ? {}
        : { parentId }
      : parentId === undefined
        ? { kindLabel: properties.kindLabel }
        : { kindLabel: properties.kindLabel, parentId };

  const feature = buildFeature(
    draft.kind,
    featureId,
    properties,
    geometry.vertexIds,
    optional,
    input.nextRingId,
  );

  const snapshot: AddSnapshot = {
    feature,
    vertices: geometry.vertices,
    sharedCandidateIds: geometry.sharedCandidateIds,
  };
  return createEditProposal(featureId, currentTime, snapshot);
}

interface OptionalCommonFields {
  readonly kindLabel?: string;
  readonly parentId?: FeatureId;
}

function buildFeature(
  kind: AddToolKind,
  featureId: FeatureId,
  properties: AddProperties,
  vertexIds: readonly VertexId[],
  optional: OptionalCommonFields,
  nextRingId: (() => RingId) | undefined,
): Feature {
  switch (kind) {
    case ADD_TOOL_KIND.Point: {
      const vid = vertexIds[0];
      if (vid === undefined) {
        throw new Error('U23: point proposal has no vertex (internal inconsistency)');
      }
      return createPointFeature(featureId, properties.attributes, properties.color, vid, optional);
    }
    case ADD_TOOL_KIND.Line:
      return createLineFeature(
        featureId,
        properties.attributes,
        properties.color,
        vertexIds,
        optional,
      );
    case ADD_TOOL_KIND.Face: {
      if (nextRingId === undefined) {
        throw new Error('U23: face proposal requires a ring-id port (internal inconsistency)');
      }
      const shape = shapeFromRing(vertexIds, nextRingId());
      return createLeafFeature(
        featureId,
        properties.attributes,
        properties.color,
        shape,
        optional,
      );
    }
  }
}
