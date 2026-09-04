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
import { longEdgeStartIndexes, MAX_EDGE_LON_SPAN_DEG } from '../geo/long-edge';
import { ringIsCollinear } from '../geometry/invariants';
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
  /**
   * 面積が無い（増分 3 の手直し D7。バグ狩り #11）。3 点が一直線に並んだ形は
   * **自己交差ではない**。取り違えると「交差しない形にしてください」と案内されて、
   * 何を直せばよいのか分からない。
   */
  NoArea: 'no-area',
  /**
   * 1 辺で経度 180 度以上を渡っている（N-51 / 技術方針 §6.8）。
   *
   * 保存形式は「隣り合う頂点は最短方向で繋がっている」と仮定して経度を連続量へ戻すので、
   * **1 辺で 180 度以上を渡る形は保存して読み直すと必ず別の形になる**。これは不具合では
   * なく保存形式の恒久的な表現限界なので、**書く側で止める以外に手が無い**。途中に点を
   * 打てば（1 辺あたり 180 度未満になれば）同じ形が表現できる。
   */
  LongEdge: 'long-edge',
} as const;

export type ShapeRejectKind = (typeof SHAPE_REJECT)[keyof typeof SHAPE_REJECT];

export interface ShapeRejection {
  readonly kind: ShapeRejectKind;
  /** The minimum the tool needed (for TooFewVertices) — for the message. */
  readonly required?: number;
  /** The actual count placed (for TooFewVertices). */
  readonly actual?: number;
  /** 長すぎる辺の本数（LongEdge のときだけ。文言に出す）。 */
  readonly longEdgeCount?: number;
}

export const CONFIRM_STATUS = {
  Ok: 'ok',
  Rejected: 'rejected',
} as const;

export type ConfirmResult =
  | { readonly status: typeof CONFIRM_STATUS.Ok; readonly draft: ShapeDraft }
  | { readonly status: typeof CONFIRM_STATUS.Rejected; readonly rejection: ShapeRejection };

// --- 1 辺で経度 180 度以上を渡る辺（N-51 / 技術方針 §6.8）--------------------

// 述語そのものは `domain/geo/long-edge.ts` へ移した（増分 3 の手直し A5）。追加だけでなく
// **編集・ナイフ・結合・穴あけ・リング編集の確定**も同じ 1 本を呼ぶ必要が出たためである
// （反証 #4 / GPT #7: 追加では断られる形が、編集では作れてしまっていた）。ここからの
// 再輸出は、既にこの名前で読んでいる呼び出し側（`render/add-batch` ほか）を折らないためで、
// **定義は 1 か所しか無い**（教訓 5.29）。
export { longEdgeStartIndexes, MAX_EDGE_LON_SPAN_DEG };

/** その道具の形が閉じるか（面だけが閉じる）。 */
export function isClosedTool(kind: AddToolKind): boolean {
  return kind === ADD_TOOL_KIND.Face;
}

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
    const ring = toGeoRing(session.vertices);
    // **一直線を先に見分ける**（D7）。一直線に並んだ 3 点は自己交差ではないので、
    // 順番を逆にすると「交差しない形にしてください」という的外れな案内になる
    // （自己交差の判定は一直線も「交差」と答えるため）。
    if (ringIsCollinear(ring)) {
      return {
        status: CONFIRM_STATUS.Rejected,
        rejection: { kind: SHAPE_REJECT.NoArea },
      };
    }
    if (ringSelfIntersects(ring)) {
      return {
        status: CONFIRM_STATUS.Rejected,
        rejection: { kind: SHAPE_REJECT.SelfIntersecting },
      };
    }
  }

  // N-51: 1 辺で経度 180 度以上を渡る形は保存形式が表現できない（技術方針 §6.8）ので、
  // ここで止める。面は閉じる辺も数える。点は辺を持たないので素通りする。
  const longEdges = longEdgeStartIndexes(
    session.vertices.map((v) => v.coordinate),
    isClosedTool(session.tool),
  );
  if (longEdges.length > 0) {
    return {
      status: CONFIRM_STATUS.Rejected,
      rejection: { kind: SHAPE_REJECT.LongEdge, longEdgeCount: longEdges.length },
    };
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
