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
//      (FR-31), pinned by tests at two zooms. 縮小した全体図で遠くへ飛ばないよう、半径は
//      `snapRadiusPx` が地図上の度数で頭打ちにする（呼ぶ側が半径を渡す前に通す）。
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
  /** Snap distance in SCREEN pixels（設定の値を {@link snapRadiusPx} に通した半径）. NOT hard-coded. */
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

/**
 * 吸着の半径の上限（地図上の度）。動作保証の上限の窓（3840×2160、表示倍率 100%）で
 * ［全体表示］を押した倍率の実測 6.889 px/度（世界全体が収まる実データ。地図の幅 3472px）で、
 * 設定の既定 50px は 7.26 度にあたる。その窓の全体図で 50px のまま効くよう 7.3 に切り上げた。
 * 地物が世界の一部にしか無いプロジェクトは全体表示の倍率がもっと大きいので、やはり 50px で効く。
 * 動作保証の範囲は要件定義書 FR-114。戻し方は `Infinity` にする（上限なしで設定の px だけになる）。
 */
export const SNAP_MAX_WORLD_DEGREES = 7.3;

/**
 * いまの倍率で効く吸着の半径（CSS px）。設定の px と、上限の度数を px へ直した値の小さいほう。
 * 地図は正距円筒で経度と緯度の倍率が同じなので、画面の円はそのまま地図上の度数の円である。
 * 距離そのものは画面で測るので、経度の継ぎ目の扱いは今までの測り方（候補を同じ周回へ寄せる・
 * ±360 度の複製を見る）をそのまま受け継ぐ。吸着の全経路がこれを通す（頂点のドラッグ・辺から
 * 足す頂点は `mount/hit-test.ts`、作図は `add/snap-ports.ts`）。
 * 設定が 0 以下、または倍率が測れていないときは 0（吸着しない）。
 */
export function snapRadiusPx(distancePx: number, pxPerDegree: number): number {
  if (!(distancePx > 0) || !(pxPerDegree > 0) || !Number.isFinite(pxPerDegree)) return 0;
  return Math.min(distancePx, SNAP_MAX_WORLD_DEGREES * pxPerDegree);
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
