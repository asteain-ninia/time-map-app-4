// U24 — shared-vertex screen-space proximity snap (FR-31).
//
// This unit OWNS the body of the screen-space proximity snap judgement (spec
// §スコープ「共有頂点化のスクリーン座標近接スナップ判定本体」). The pipeline:
//   1. The near-candidate vertices come from U10's spatial-index query over a
//      world rectangle (the caller passes the candidate vertex set, narrowed by
//      U10 — this unit does NOT scan all vertices, 教訓5.3 / 5.4).
//   2. The snap distance (既定 50px, FR-110) is read from U16's app settings and
//      passed IN; it is NEVER hard-coded here (single source of truth, 受け入れ基準12).
//   3. The dragged vertex's world position AND each candidate's world position are
//      projected to SCREEN space via the injected world→screen function (the
//      render-layer transform, supplied by the caller because `domain` must not
//      import `render`). The nearest candidate within the snap distance (in screen
//      pixels) is the snap candidate.
//   4. Because the comparison is in SCREEN pixels, the same 50px corresponds to a
//      DIFFERENT world distance at different zooms — zoom-dependent proximity
//      (FR-31), pinned by tests at two zooms.
//
// LAYER: pure `domain` logic. The world→screen projection is an injected pure
// function so this module stays renderer-agnostic and Vitest-runnable; the caller
// (UI/render wiring) binds the actual camera transform.
//
// IMPORTANT (受け入れ基準12「スナップされただけで離すと共有頂点化されない」): this
// module only DECIDES a candidate per frame; the drag session decides at RELEASE
// whether a candidate that is still standing becomes a share. A candidate that the
// drag left is dropped — see drag-session. This module never executes the share
// (that is U11); it produces the decided pair for the session to forward.

import type { WorldCoordinate } from '../coordinate';
import type { VertexId } from '../ids';

/** A point in screen (CSS-pixel) space — mirrors the render layer's ScreenPoint. */
export interface ScreenXY {
  readonly x: number;
  readonly y: number;
}

/**
 * Injected pure world→screen projection (the render layer's transform). `domain`
 * cannot import `render`, so the caller binds the camera-aware function here
 * (单一真实源: the SAME transform drawing uses, so "snaps where it looks like it
 * snaps"). Returns CSS-pixel coordinates.
 */
export type WorldToScreen = (world: WorldCoordinate) => ScreenXY;

/** A near-candidate vertex (world position + id), from U10's spatial query. */
export interface SnapCandidate {
  readonly vertexId: VertexId;
  readonly position: WorldCoordinate;
}

/**
 * The decided snap candidate for one frame: the vertex the dragged point would
 * share with, plus its measured screen distance (for diagnostics / closest-wins).
 * Absent (`null`) when no candidate is within the snap distance.
 */
export interface SnapDecision {
  readonly vertexId: VertexId;
  readonly screenDistance: number;
}

export interface SnapInput {
  /** The dragged (or edge-handle-generated) vertex's CURRENT world position. */
  readonly draggedPosition: WorldCoordinate;
  /** Near-candidate vertices (U10-narrowed). Empty ⇒ no snap (教訓5.18). */
  readonly candidates: readonly SnapCandidate[];
  /** Snap distance in SCREEN pixels (from U16 settings, FR-110). NOT hard-coded. */
  readonly snapDistancePx: number;
  /** The world→screen projection (injected render transform). */
  readonly toScreen: WorldToScreen;
  /**
   * Vertex ids to EXCLUDE as snap targets (e.g. the dragged vertex itself, and any
   * vertex already sharing the dragged vertex's container — the session supplies
   * these; this module does not re-derive participation, that is U11's FR-32).
   */
  readonly exclude?: ReadonlySet<VertexId>;
}

function screenDistance(a: ScreenXY, b: ScreenXY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Decide the snap candidate for the dragged vertex: the nearest candidate whose
 * SCREEN distance is ≤ `snapDistancePx`, or `null` when none qualifies. The
 * comparison is purely screen-space (FR-31 zoom-dependent). Pure.
 */
export function decideSnap(input: SnapInput): SnapDecision | null {
  if (input.candidates.length === 0) return null; // 教訓5.18: length-decided.
  if (!(input.snapDistancePx > 0)) return null; // a non-positive distance never snaps.
  const exclude = input.exclude ?? new Set<VertexId>();
  const draggedScreen = input.toScreen(input.draggedPosition);

  let best: SnapDecision | null = null;
  for (const cand of input.candidates) {
    if (exclude.has(cand.vertexId)) continue;
    const d = screenDistance(draggedScreen, input.toScreen(cand.position));
    if (d > input.snapDistancePx) continue;
    if (best === null || d < best.screenDistance) {
      best = { vertexId: cand.vertexId, screenDistance: d };
    }
  }
  return best;
}
