// U23 — shape-draft validation & construction (FR-76, 教訓 5.18 / 5.19 / 5.25).
//
// Pure domain logic that turns the placed vertices of an {@link AddSession} into
// a validated, immutable {@link ShapeDraft} — or a structured rejection. This is
// the SINGLE place the "line ≥2 / face ≥3 / no self-intersection" rule is
// applied (spec §実装方針「層分離」: 形状の妥当性検証を domain 純粋関数に置く),
// so the UI, the property-form gate and the proposal assembly all agree.
//
// A `ShapeDraft` is constructed ONLY by passing validation (it cannot represent
// an under-vertex or self-intersecting shape), so downstream code that holds a
// `ShapeDraft` need not re-check the minimums (不正状態を表現不能, 技術方針 2.1).

import type { WorldCoordinate } from '../coordinate';
import { ringSelfIntersects } from '../geometry/predicates';
import type { GeoRing } from '../geometry/types';

import {
  ADD_TOOL_KIND,
  minVerticesFor,
  type AddSession,
  type AddToolKind,
  type PlacedVertex,
} from './session';

// --- The validated draft (型経由; 教訓 5.19) --------------------------------

/**
 * A validated shape draft (spec §ShapeDraft 相当). The discriminant is the
 * add-tool `kind`; each variant carries exactly the coordinates its shape needs:
 *   - point: a single coordinate,
 *   - line: an ordered path of ≥2 coordinates,
 *   - face: a ring of ≥3 coordinates (the closing edge back to index 0 is
 *     implicit — the ring is NOT stored with a duplicate closing point).
 *
 * Shared-candidate ids (from snapping onto existing vertices) ride alongside per
 * coordinate so confirmation can build shared-vertex links (FR-30〜33).
 */
export type ShapeDraft =
  | {
      readonly kind: typeof ADD_TOOL_KIND.Point;
      readonly vertices: readonly PlacedVertex[]; // length 1
    }
  | {
      readonly kind: typeof ADD_TOOL_KIND.Line;
      readonly vertices: readonly PlacedVertex[]; // length ≥2
    }
  | {
      readonly kind: typeof ADD_TOOL_KIND.Face;
      readonly vertices: readonly PlacedVertex[]; // length ≥3
    };

/** The plain coordinate path of a draft (no closing duplicate for faces). */
export function draftCoordinates(draft: ShapeDraft): readonly WorldCoordinate[] {
  return draft.vertices.map((v) => v.coordinate);
}

// --- Rejection (machine code + Japanese message handled at UI; 教訓 5.26) ----

/**
 * Why a confirm was rejected (spec §エラー処理 FR-115 / FR-117). A machine code
 * the UI maps to a Japanese message; never a raw thrown error for an expected
 * user mistake (under-vertex / self-intersection).
 */
export const SHAPE_REJECT = {
  /** Fewer vertices than the tool's minimum (line <2 / face <3). */
  TooFewVertices: 'too-few-vertices',
  /** The face ring self-intersects (FR-25 / 受け入れ基準 1). */
  SelfIntersecting: 'self-intersecting',
} as const;

export type ShapeRejectKind = (typeof SHAPE_REJECT)[keyof typeof SHAPE_REJECT];

export interface ShapeRejection {
  readonly kind: ShapeRejectKind;
  /** The minimum the tool needed (for TooFewVertices) — for the message. */
  readonly required?: number;
  /** The actual count placed (for TooFewVertices). */
  readonly actual?: number;
}

export const CONFIRM_STATUS = {
  Ok: 'ok',
  Rejected: 'rejected',
} as const;

export type ConfirmResult =
  | { readonly status: typeof CONFIRM_STATUS.Ok; readonly draft: ShapeDraft }
  | { readonly status: typeof CONFIRM_STATUS.Rejected; readonly rejection: ShapeRejection };

// --- Validation -------------------------------------------------------------

function toGeoRing(vertices: readonly PlacedVertex[]): GeoRing {
  // U06's GeoRing is a list of WorldCoordinate (continuous-longitude), implicitly
  // closed (no duplicate first point appended). We forward the placed coordinates
  // verbatim so the self-intersection predicate runs on the exact ring.
  return vertices.map((v) => v.coordinate);
}

/**
 * Validate & construct a {@link ShapeDraft} from a session's placed vertices
 * (spec §形状確定). Rules (FR-76 / FR-25):
 *   - point: exactly the (single) placed vertex; a point can never be "too few"
 *     once a vertex exists (a 0-vertex point confirm is rejected as too few),
 *   - line: ≥2 vertices,
 *   - face: ≥3 vertices AND the ring must not self-intersect (delegated to U06's
 *     `ringSelfIntersects`, 教訓 5.30 — the algorithm is not re-implemented here).
 *
 * Returns a discriminated {@link ConfirmResult}; never throws for an expected
 * user mistake. The minimum is read from {@link minVerticesFor} so the gate and
 * the message share one source (単一の真実源).
 */
export function confirmShape(session: AddSession): ConfirmResult {
  const required = minVerticesFor(session.tool);
  const actual = session.vertices.length;
  if (actual < required) {
    return {
      status: CONFIRM_STATUS.Rejected,
      rejection: { kind: SHAPE_REJECT.TooFewVertices, required, actual },
    };
  }

  if (session.tool === ADD_TOOL_KIND.Face) {
    if (ringSelfIntersects(toGeoRing(session.vertices))) {
      return {
        status: CONFIRM_STATUS.Rejected,
        rejection: { kind: SHAPE_REJECT.SelfIntersecting },
      };
    }
  }

  return {
    status: CONFIRM_STATUS.Ok,
    draft: buildDraft(session.tool, session.vertices),
  };
}

function buildDraft(
  kind: AddToolKind,
  vertices: readonly PlacedVertex[],
): ShapeDraft {
  switch (kind) {
    case ADD_TOOL_KIND.Point:
      // Keep only the single (last) vertex; placeVertex already enforces ≤1.
      return { kind: ADD_TOOL_KIND.Point, vertices: vertices.slice(0, 1) };
    case ADD_TOOL_KIND.Line:
      return { kind: ADD_TOOL_KIND.Line, vertices };
    case ADD_TOOL_KIND.Face:
      return { kind: ADD_TOOL_KIND.Face, vertices };
  }
}
