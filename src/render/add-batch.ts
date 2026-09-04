// U23 — add-session render-batch builder (FR-78 仮表示 / クロージング線半透明 /
// FR-17 一定サイズ, 教訓 5.18 / 5.25 / 5.29).
//
// Render layer: turns the pure add-session state (domain) into a declarative
// list of `DrawPrimitive`s for the MapRenderer (U17). It owns NO Canvas API and
// NO ±360° / world↔screen math — it only describes WHAT to draw in WORLD
// coordinates with SCREEN-fixed sizes (FR-17); U17 transforms positions,
// wrap-replicates across the seam (FR-07) and keeps marker / line sizes constant.
//
// The provisional add visuals are drawn in a style VISUALLY DISTINCT from
// confirmed features (spec §仮スタイル, FR-78): a dashed/accent stroke and accent
// markers declared once here. For a FACE add, the CLOSING line (last vertex back
// to the start) is drawn TRANSLUCENT (spec §クロージング線半透明) and only once a
// ring is closable (≥3 vertices) — 教訓 5.18 (drawn only when the closing edge is
// a real edge, not a degenerate self-loop). The render layer subscribes to the
// session state directly so the 60FPS draw path never rides a React re-render
// (技術方針 2.3 / 2.5).
//
// 教訓 5.25: the provisional preview edge (cursor-follow) is drawn for line / face
// only — a point has no edge — and a face's closing line is NOT widened to lines
// / points (a line has no closing edge by definition).

import {
  ADD_TOOL_KIND,
  canConfirm,
  isClosedTool,
  longEdgeStartIndexes,
  type AddSession,
  type PlacedVertex,
} from '../domain/add/index';
import type { WorldCoordinate } from '../domain/coordinate';

import type { DrawPrimitive } from './map-renderer';
import type { WorldPoint } from './vtransform';

// --- Provisional visual style (the single place add colours / sizes live) ----
//
// FR-17: marker radius and stroke widths are SCREEN-fixed px declared once here;
// U17 keeps them constant under zoom. The provisional style is deliberately
// distinct from confirmed features (FR-78 仮スタイル). The closing line uses a
// translucent stroke (spec §クロージング線半透明).

export interface AddStyle {
  /** Provisional edge stroke (placed edges + cursor preview), distinct accent. */
  readonly edgeStroke: string;
  /** Provisional vertex marker fill. */
  readonly markerFill: string;
  /** Cursor-follow preview marker fill (the live hover point). */
  readonly previewMarkerFill: string;
  /** Translucent closing-line stroke for a face (spec §クロージング線半透明). */
  readonly closingStroke: string;
  readonly edgeWidthPx: number;
  readonly previewWidthPx: number;
  readonly closingWidthPx: number;
  readonly markerRadiusPx: number;
  /**
   * N-15: 描いている最中の面の**塗り**（半透明）。「閉じたらどんな形になるか」が
   * 線だけでは読めなかったので、確定前から面として見えるようにする。
   */
  readonly draftFill: string;
  /** 閉じる辺の破線パターン（CSS px）。実線の placed edge と見分けるため。 */
  readonly closingDashPx: readonly number[];
  /**
   * 吸着の予告（琥珀の輪）。**置かれる場所**（吸着後の座標）に描く同心円で、
   * 「押した場所」ではないことが目で分かるようにする（設計書 §E.1 の V2）。
   */
  readonly snapRingStroke: string;
  readonly snapRingRadiusPx: number;
  readonly snapRingWidthPx: number;
  /**
   * N-51: 1 辺で経度 180 度以上を渡る辺を**赤く**する（技術方針 §6.8 の表現限界）。
   * 確定も止まるが、止まる前に見えていなければ直しようがない。
   */
  readonly longEdgeStroke: string;
  readonly longEdgeWidthPx: number;
}

/** Default provisional add style (overridable; e.g. project theme). */
export const DEFAULT_ADD_STYLE: AddStyle = {
  edgeStroke: '#e65100',
  markerFill: '#e65100',
  previewMarkerFill: '#ff9800',
  // rgba alpha < 1 ⇒ the closing line is半透明 (spec §FR-78).
  closingStroke: 'rgba(230, 81, 0, 0.55)',
  edgeWidthPx: 2,
  previewWidthPx: 1.5,
  closingWidthPx: 1.5,
  markerRadiusPx: 5,
  // N-15: 確定前の面を薄く塗る。確定後の地物より薄くして「まだ仮」であることを保つ。
  draftFill: 'rgba(230, 81, 0, 0.16)',
  closingDashPx: [6, 4],
  // 琥珀（amber 500 相当）。設計書 §E.1 の V2「琥珀の輪」。
  snapRingStroke: '#ffb300',
  snapRingRadiusPx: 9,
  snapRingWidthPx: 2,
  longEdgeStroke: '#d32f2f',
  longEdgeWidthPx: 3,
};

function toWorldPoint(c: WorldCoordinate): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

function placedToWorldPoints(vertices: readonly PlacedVertex[]): WorldPoint[] {
  return vertices.map((v) => toWorldPoint(v.coordinate));
}

// --- Per-part builders ------------------------------------------------------

/** Markers for every placed vertex (provisional style). */
function markerPrimitives(
  vertices: readonly PlacedVertex[],
  style: AddStyle,
): DrawPrimitive[] {
  return vertices.map((v) => ({
    kind: 'point',
    at: toWorldPoint(v.coordinate),
    radiusPx: style.markerRadiusPx,
    fill: style.markerFill,
  }));
}

/** The polyline through the placed vertices in order (≥2 vertices). */
function placedEdgePrimitives(
  vertices: readonly PlacedVertex[],
  style: AddStyle,
): DrawPrimitive[] {
  if (vertices.length < 2) return [];
  return [
    {
      kind: 'line',
      points: placedToWorldPoints(vertices),
      widthPx: style.edgeWidthPx,
      stroke: style.edgeStroke,
    },
  ];
}

/**
 * The cursor-follow preview edge from the last placed vertex to the current
 * preview point + a preview marker (line / face only; 教訓 5.25 point has no
 * edge). Drawn only when there is at least one placed vertex AND a preview point
 * (教訓 5.18: "placed, no hover yet" is a valid intermediate that draws no edge).
 */
function previewPrimitives(session: AddSession, style: AddStyle): DrawPrimitive[] {
  if (session.tool === ADD_TOOL_KIND.Point) return [];
  if (session.preview === null) return [];
  const last = session.vertices[session.vertices.length - 1];
  const out: DrawPrimitive[] = [];
  if (last !== undefined) {
    out.push({
      kind: 'line',
      points: [toWorldPoint(last.coordinate), toWorldPoint(session.preview)],
      widthPx: style.previewWidthPx,
      stroke: style.edgeStroke,
    });
  }
  out.push({
    kind: 'point',
    at: toWorldPoint(session.preview),
    radiusPx: style.markerRadiusPx,
    fill: style.previewMarkerFill,
  });
  return out;
}

/**
 * The TRANSLUCENT closing line from the last placed vertex back to the first
 * (face only; spec §クロージング線半透明). Drawn only once the ring is closable
 * (≥3 vertices via {@link canConfirm}) so the closing edge is a real edge, not a
 * degenerate loop on 1–2 points (教訓 5.18).
 */
function closingPrimitives(session: AddSession, style: AddStyle): DrawPrimitive[] {
  if (session.tool !== ADD_TOOL_KIND.Face) return [];
  if (!canConfirm(session)) return [];
  const first = session.vertices[0];
  const last = session.vertices[session.vertices.length - 1];
  if (first === undefined || last === undefined) return [];
  return [
    {
      kind: 'line',
      points: [toWorldPoint(last.coordinate), toWorldPoint(first.coordinate)],
      widthPx: style.closingWidthPx,
      stroke: style.closingStroke,
      dashPx: style.closingDashPx,
    },
  ];
}

/**
 * N-15: 描いている最中の面の**塗り**（半透明）。3 頂点そろって初めて面になるので
 * {@link canConfirm} と同じ判定で出す。カーソルが動いている間は preview の点も
 * 輪郭に含めるので、「いま確定したらこの形になる」が塗りで読める。
 */
function draftFillPrimitives(session: AddSession, style: AddStyle): DrawPrimitive[] {
  if (session.tool !== ADD_TOOL_KIND.Face) return [];
  const ring = placedToWorldPoints(session.vertices);
  if (session.preview !== null) ring.push(toWorldPoint(session.preview));
  if (ring.length < 3) return [];
  return [{ kind: 'polygon', ring, fill: style.draftFill }];
}

/**
 * N-51: 1 辺で経度 180 度以上を渡る辺を赤く塗り直す（技術方針 §6.8）。判定は
 * ドメインの {@link longEdgeStartIndexes} 1 本だけを呼ぶ（教訓 5.29 単一真実源）ので、
 * 「確定は止まるのに赤くならない」食い違いが起きない。**確定と同じ列**（打った頂点＋
 * 面なら閉じる辺）を見る。カーソル追従の preview 辺は確定の対象ではないので、
 * 別に下の {@link previewPrimitives} が見る。
 */
function longEdgePrimitives(session: AddSession, style: AddStyle): DrawPrimitive[] {
  const coords = session.vertices.map((v) => v.coordinate);
  const closed = isClosedTool(session.tool);
  const indexes = longEdgeStartIndexes(coords, closed);
  const n = coords.length;
  return indexes.map((i) => ({
    kind: 'line',
    points: [toWorldPoint(coords[i]!), toWorldPoint(coords[(i + 1) % n]!)],
    widthPx: style.longEdgeWidthPx,
    stroke: style.longEdgeStroke,
  }));
}

/**
 * 吸着の予告（琥珀の輪）。**置かれる場所**（＝吸着後の座標）に描く。共有相手が居るとき
 * ―― 既存の頂点へ吸い付いているとき ―― だけ出す。グリッド吸着や素の座標では輪を出さない
 * （予告したい事実は「共有になる」ことそのものだから）。
 *
 * 部品は既存の {@link HandlePrimitive}（`handleKind: 'vertex'`）を **塗り透明**で使う。
 * 透明な円を塗ってから縁を描くので、結果は純粋な輪になる。新しい primitive 種別を足さずに
 * 済み、しかも半径・線幅が画面固定（FR-17）という性質をそのまま受け取れる。
 * 追加の道具を構えている間しか出ないので、編集モードのハンドル数を数える E2E とは
 * そもそも同じ画面に並ばない。
 */
function snapRingPrimitives(session: AddSession, style: AddStyle): DrawPrimitive[] {
  const snap = session.previewSnap;
  if (snap === null) return [];
  if (snap.sharedCandidateId === null) return [];
  return [
    {
      kind: 'handle',
      at: toWorldPoint(snap.coordinate),
      radiusPx: style.snapRingRadiusPx,
      fill: 'rgba(0, 0, 0, 0)',
      stroke: style.snapRingStroke,
      strokeWidthPx: style.snapRingWidthPx,
      handleKind: 'vertex',
    },
  ];
}

// --- Whole-session batch ----------------------------------------------------

/**
 * Build the full provisional add primitive list from the session, back-to-front:
 * placed edges, then the translucent closing line (face), then the cursor preview
 * edge/marker, then the placed-vertex markers on top. A `null` session (no add in
 * progress) yields `[]` — a real, valid empty frame (教訓 5.18), never skipped by
 * a falsy short-circuit. All sizes are screen-fixed (FR-17); U17 transforms /
 * seam-replicates (FR-07).
 */
export function buildAddPrimitives(
  session: AddSession | null,
  style: AddStyle = DEFAULT_ADD_STYLE,
): DrawPrimitive[] {
  if (session === null) return [];
  return [
    // N-15: いちばん下に「いま確定したらこうなる」塗り。線だけでは形が読めなかった。
    ...draftFillPrimitives(session, style),
    ...placedEdgePrimitives(session.vertices, style),
    ...closingPrimitives(session, style),
    ...previewPrimitives(session, style),
    // N-51: 半周以上を渡る辺は、上から赤で描き直して目立たせる（確定も止まる）。
    ...longEdgePrimitives(session, style),
    ...markerPrimitives(session.vertices, style),
    // 吸着の予告は最前面（置かれる場所を隠さない）。
    ...snapRingPrimitives(session, style),
  ];
}
