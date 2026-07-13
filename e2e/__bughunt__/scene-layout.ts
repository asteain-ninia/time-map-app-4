// __bughunt__ 共有 — LIVE-BOX RATIO scene placement for the exploration harnesses
// (第7工程).
//
// WHY THIS EXISTS: the harnesses used to place their scenes at FIXED pixel offsets
// from the map centre, silently assuming the map cell's historical size. The 第6工程
// layout fix made the map cell SHORTER (the fixed-occupancy 上部バー holds two lines)
// and moved the tool chrome INSIDE the map cell (map-anchored overlays) — so old
// offsets dropped corner clicks below the map (timeline band) or ONTO the floating
// tool chrome (the bottom-centre add/knife controls strip eats pointer input), and
// the harness scenes degraded (add-vertex-drop → add-complete disabled → hard fail).
//
// THE CONTRACT here:
//   • Scenes are anchored by FRACTIONS of the live input-layer box (never absolute
//     pixels), so any future map-cell resize re-solves automatically.
//   • The solver keeps every CLICK POINT (square corners + optional vertical pierce
//     endpoints) inside the box margins AND clear of the two floating chrome bands:
//       - bottom-centre: the add/knife/merge/… controls strip (shell.css
//         .add-tool__controls bottom:16px + the per-tool __controls) — modelled as a
//         conservative superset band;
//       - top-centre: the per-tool guide/message strip (knife-tool__guide top:12 /
//         __message top:48) — only relevant while an edit tool is armed on the scene
//         (`avoidTopChrome`), pure-add scenes may use the top band.
//   • INFEASIBLE geometry THROWS with the numbers in the message — a future layout
//     change fails loudly at placement time, never as a mysterious dropped click
//     (教訓 5.7 / 5.26 honest failure).
//   • The helper never shrinks a requested scene silently: the caller states the
//     half/pierce it needs; only the CENTRE is solved.

export interface SceneBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Clearance kept between any click point and a box edge / chrome band (px). */
export const SCENE_MARGIN = 10;

interface Band {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The bottom-centre floating controls strip (add: 完了/戻す/キャンセル/グリッド ≈
 * 470×66 at bottom:16px; knife/merge/…: 確定/取消 ≈ 360×56). Modelled as the
 * conservative SUPERSET of every tool's strip so one model serves all phases.
 */
export function bottomChromeBand(b: SceneBox): Band {
  const xc = b.x + b.width / 2;
  return {
    left: xc - 270,
    right: xc + 270,
    top: b.y + b.height - 100,
    bottom: b.y + b.height,
  };
}

/** The top-centre tool guide/message strip (knife-tool__guide top:12 etc.). */
export function topChromeBand(b: SceneBox): Band {
  const xc = b.x + b.width / 2;
  return { left: xc - 250, right: xc + 250, top: b.y, bottom: b.y + 48 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface SquareSceneSpec {
  /** Horizontal anchor as a fraction of the box width (0..1). */
  readonly fx: number;
  /** Vertical anchor as a fraction of the box height (0..1). */
  readonly fy: number;
  /** The square's half-size in px (the four corners are clicked at centre±half). */
  readonly half: number;
  /**
   * Optional vertical PIERCE reach: the knife cut endpoints are clicked at
   * (≈centre.x, centre.y±pierce). Supplying it makes the solver keep BOTH cut
   * endpoints on hittable canvas too (clear of the bottom strip when the cut
   * column runs through it).
   */
  readonly pierce?: number;
  /**
   * Keep the square (and pierce top) clear of the TOP-centre tool-guide strip.
   * true for scenes an armed edit tool operates on (knife / vertex-drag / merge —
   * their guides float top-centre); false for pure-add scenes (no guide mounts).
   */
  readonly avoidTopChrome: boolean;
  /** Name used in the loud infeasibility error. */
  readonly name: string;
}

export interface PlacedSquareScene {
  readonly cx: number;
  readonly cy: number;
  /** Convenience pierce endpoints (== cy±pierce; cy±half when no pierce given). */
  readonly cutTopY: number;
  readonly cutBottomY: number;
}

/**
 * Solve a square scene's centre from a fractional anchor such that every click
 * point stays inside the margin-inset box and clear of the floating chrome bands.
 * Throws (loudly, with the numbers) when the requested half/pierce cannot fit —
 * the caller must choose a feasible scene size, never a silent shrink.
 */
export function placeSquareScene(b: SceneBox, spec: SquareSceneSpec): PlacedSquareScene {
  const m = SCENE_MARGIN;
  const { half, name } = spec;
  const reach = spec.pierce ?? half;

  const cxMin = b.x + m + half;
  const cxMax = b.x + b.width - m - half;
  if (cxMin > cxMax) {
    throw new Error(
      `scene-layout: "${name}" half=${half} exceeds the box width (${JSON.stringify(b)})`,
    );
  }
  const cx = clamp(b.x + spec.fx * b.width, cxMin, cxMax);

  const bottom = bottomChromeBand(b);
  const top = topChromeBand(b);

  // Base vertical band: the farthest click (pierce or corner) stays inside margins.
  let cyMin = b.y + m + reach;
  let cyMax = b.y + b.height - m - reach;

  // Bottom strip: corners must clear it unless the whole x-lane misses the strip.
  const laneClearOfBottom = cx + half < bottom.left - m || cx - half > bottom.right + m;
  if (!laneClearOfBottom) {
    cyMax = Math.min(cyMax, bottom.top - m - half);
  }
  // Pierce column through the bottom strip: the lower cut endpoint must stop above it.
  if (spec.pierce !== undefined && cx > bottom.left - m && cx < bottom.right + m) {
    cyMax = Math.min(cyMax, bottom.top - m - spec.pierce);
  }

  if (spec.avoidTopChrome) {
    const laneClearOfTop = cx + half < top.left - m || cx - half > top.right + m;
    if (!laneClearOfTop) {
      cyMin = Math.max(cyMin, top.bottom + m + half);
    }
    if (spec.pierce !== undefined && cx > top.left - m && cx < top.right + m) {
      cyMin = Math.max(cyMin, top.bottom + m + spec.pierce);
    }
  }

  if (cyMin > cyMax) {
    throw new Error(
      `scene-layout: "${name}" infeasible (half=${half}, pierce=${spec.pierce ?? '-'}, ` +
        `avoidTop=${spec.avoidTopChrome}): cy∈[${Math.round(cyMin)}, ${Math.round(cyMax)}] ` +
        `is empty for box=${JSON.stringify(b)} — shrink the scene or move its lane`,
    );
  }
  const cy = clamp(b.y + spec.fy * b.height, cyMin, cyMax);

  return {
    cx: Math.round(cx),
    cy: Math.round(cy),
    cutTopY: Math.round(cy - reach),
    cutBottomY: Math.round(cy + reach),
  };
}

/**
 * Assert that a set of ADDITIONAL click points (relative interactions a harness
 * performs around a placed scene) all land on hittable canvas: inside the margin-
 * inset box and clear of the bottom strip (+ the top strip when requested).
 * Throws loudly with the offending point — a placement-time guard, so a future
 * layout change surfaces HERE instead of as a silently-dropped click.
 */
export function assertClickable(
  b: SceneBox,
  points: ReadonlyArray<readonly [number, number]>,
  opts: { readonly avoidTopChrome: boolean; readonly name: string },
): void {
  const m = SCENE_MARGIN;
  const bottom = bottomChromeBand(b);
  const top = topChromeBand(b);
  for (const [x, y] of points) {
    const insideBox =
      x >= b.x + m && x <= b.x + b.width - m && y >= b.y + m && y <= b.y + b.height - m;
    const inBottom =
      x > bottom.left - m && x < bottom.right + m && y > bottom.top - m;
    const inTop =
      opts.avoidTopChrome && x > top.left - m && x < top.right + m && y < top.bottom + m;
    if (!insideBox || inBottom || inTop) {
      throw new Error(
        `scene-layout: "${opts.name}" click (${Math.round(x)}, ${Math.round(y)}) is not ` +
          `clear (insideBox=${insideBox} inBottomChrome=${inBottom} inTopChrome=${inTop}) ` +
          `for box=${JSON.stringify(b)}`,
      );
    }
  }
}
