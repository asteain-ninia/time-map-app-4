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

/**
 * 起動直後のカメラに写っている「世界そのもの」の帯（px）。この外側の余りは
 * **日付変更線の向こう側が回り込んで描かれている**ので、そこへ図形を置くと
 * 反対の端に置いた図形と world 座標で重なり、追加が conflict で止まる。
 *
 * WHY 箱から解けるのか: 起動時のカメラは世界 (経度 360° × 緯度 180°) 全体を地図セルに
 * 収めるので、1 度あたりの px は `min(幅/360, 高さ/180)`。世界はセルの中央に置かれる。
 * 実測 (増分 1 の箱 940×415.6) では高さ側が効いて世界の横幅は 831.2px、
 * 経度 0° はセルの横中央 — この式どおりだった。
 *
 * WHY これが要るようになったか: 増分 1 でシェルに行が増えて地図セルが縦に約 74px 縮み、
 * 「高さ/180」が効くようになった。つまり**世界の横幅がセルの幅より狭くなり**、
 * セルの左右端が回り込み領域になった。以前は幅いっぱいが世界だったので問題にならず、
 * 右端レーンに置いていた図形が増分 1 で左端の図形と衝突するようになった。
 *
 * ⚠️ **前提: カメラが起動直後のまま（世界全体が収まる視点）であること。** この式は
 * ズーム 1 段ぶんの倍率も、パンの原点も見ていない。パンやズームをしたあと、あるいは
 * 「全体表示」(Ctrl+Home) を押したあとの帯はこれとは違う（全体表示は起動直後より
 * 引きになる＝BH1-15）。**カメラを動かす spec でこの関数を使ってはいけない。**
 * 動かした状態で図形を置く必要が出たら、`data-zoom` / `data-pan-x` / `data-pan-y` から
 * 実際の変換を読んで解くこと（属性は `map-input-layer` に付いている）。
 */
export function worldBand(b: SceneBox): Band {
  const perDeg = Math.min(b.width / 360, b.height / 180);
  const halfW = (perDeg * 360) / 2;
  const halfH = (perDeg * 180) / 2;
  const xc = b.x + b.width / 2;
  const yc = b.y + b.height / 2;
  return { left: xc - halfW, right: xc + halfW, top: yc - halfH, bottom: yc + halfH };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * `v` を [lo, hi] に収めたうえで **整数に丸めても [lo, hi] からはみ出さない**値にする。
 *
 * WHY: クリック座標は最後に整数へ丸めている。素直に `Math.round(clamp(v, lo, hi))` にすると、
 * 上限へ張り付いた値が丸めで最大 0.5px だけ外へ押し出され、四隅がクロムの帯へ食い込む
 * （増分 1 で地図セルが縦に約 74px 縮み、cy が帯の上限ぎりぎりに張り付くようになったため
 * 実際に 460.8 → 461 で 0.2px 食い込んで落ちた）。丸めたあとの整数レンジ側で clamp する。
 */
function snapInside(v: number, lo: number, hi: number): number {
  const loI = Math.ceil(lo);
  const hiI = Math.floor(hi);
  // 帯の幅が 1px 未満で整数が 1 つも入らないときだけ、丸めるしかない。
  if (loI > hiI) return Math.round(clamp(v, lo, hi));
  return clamp(Math.round(v), loI, hiI);
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

  // 余白の内側 **かつ** 世界の帯の内側（日付変更線をまたがない）。またぐと反対側の
  // 図形と world 座標で重なり、追加が conflict で止まる（増分 1 で地図セルが縦に縮み、
  // 世界の横幅がセルの幅より狭くなって初めて起きるようになった）。
  const world = worldBand(b);
  const cxMin = Math.max(b.x + m, world.left + m) + half;
  const cxMax = Math.min(b.x + b.width - m, world.right - m) - half;
  if (cxMin > cxMax) {
    throw new Error(
      `scene-layout: "${name}" half=${half} exceeds the world band inside the box ` +
        `(world x∈[${Math.round(world.left)}, ${Math.round(world.right)}], box=${JSON.stringify(b)})`,
    );
  }
  // 先に整数へ確定させる（レーンがクロムの帯を外れるかの判定を、実際にクリックする
  // 整数座標そのもので行うため。丸めで判定が裏返るのを防ぐ）。
  const cx = snapInside(b.x + spec.fx * b.width, cxMin, cxMax);

  const bottom = bottomChromeBand(b);
  const top = topChromeBand(b);

  // Base vertical band: the farthest click (pierce or corner) stays inside margins
  // （縦も世界の帯の内側に留める。今の箱では世界の高さ＝セルの高さなので実質は素通しだが、
  //  セルが横長に戻れば極の外側が見えるようになるので、式のほうで先に塞いでおく）。
  let cyMin = Math.max(b.y + m, world.top + m) + reach;
  let cyMax = Math.min(b.y + b.height - m, world.bottom - m) - reach;

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
  // 整数へ丸めても feasible な帯 [cyMin, cyMax] の中に残す。
  // 丸めてから外へ 0.2px 押し出されると四隅がクロムの帯に食い込み、クリックが飲まれる
  // （増分 1 で地図セルが縦に約 74px 縮み、cy が帯の上限に張り付くようになったため顕在化）。
  const cy = snapInside(b.y + spec.fy * b.height, cyMin, cyMax);

  return {
    cx,
    cy,
    // 端点も「内側へ」丸める（reach が整数なら恒等、そうでなくても帯からはみ出さない）。
    cutTopY: Math.ceil(cy - reach),
    cutBottomY: Math.floor(cy + reach),
  };
}

/**
 * その箱で成り立つ **いちばん大きい half**（クロムの帯を避けたうえで、四隅も pierce の
 * 端点も余白の内側に入る最大値）。収まらなければ 0 以下を返す。
 *
 * WHY: シェルの行が増減するたびに地図セルの高さは変わる（UI 再設計では毎増分に変わる）。
 * `placeSquareScene` は「収まらないなら黙って縮めずに落ちる」契約なので、**呼び出し側が
 * その箱で成り立つ大きさを決められる**手段が要る。ここが無いと、シェルを 40px 動かすたびに
 * 13 本の探索 spec の数値を手で当て直すことになる。
 */
export function maxFeasibleHalf(
  b: SceneBox,
  opts: { readonly avoidTopChrome: boolean; readonly pierceExtra?: number },
): number {
  const m = SCENE_MARGIN;
  const extra = opts.pierceExtra ?? 0;
  const bottomTop = bottomChromeBand(b).top;
  const topBottom = topChromeBand(b).bottom;
  // 上端: 余白（top クロムを避けるならその下端）から。下端: bottom クロムの上。
  const upper = opts.avoidTopChrome ? Math.max(b.y + m, topBottom + m) : b.y + m;
  const lower = bottomTop - m;
  // reach = half + extra が上下に収まる最大の half。
  return Math.floor((lower - upper) / 2) - extra;
}

/**
 * 要求した half と、その箱で成り立つ最大の half の小さいほう。**下限を割ったら落とす**
 * （黙って潰れた図形で探索を続けても意味が無い ＝ scene-layout の「静かに縮めない」方針）。
 */
export function fitHalf(
  b: SceneBox,
  requested: number,
  opts: {
    readonly avoidTopChrome: boolean;
    readonly pierceExtra?: number;
    readonly min: number;
    readonly name: string;
  },
): number {
  const feasible = maxFeasibleHalf(b, opts);
  const half = Math.min(requested, feasible);
  if (half < opts.min) {
    throw new Error(
      `scene-layout: "${opts.name}" は最小の half=${opts.min} すら入らない ` +
        `(要求 ${requested}, 成立する最大 ${feasible}, box=${JSON.stringify(b)}) — ` +
        `地図セルが小さくなりすぎている`,
    );
  }
  return half;
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
