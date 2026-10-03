// U26 — knife-tool render-batch builder (FR-90 / FR-92 / FR-17, 教訓 5.2 / 5.18 /
// 5.25 / 5.29).
//
// Render layer: turns the pure knife session state (domain) into a declarative
// list of `DrawPrimitive`s for the MapRenderer (U17). It owns NO Canvas API and
// NO ±360° / world↔screen math beyond the ONE screen-fixed radius conversion the
// 固定円 needs (FR-17): it describes WHAT to draw in WORLD coordinates with
// SCREEN-fixed sizes; U17 transforms positions and wrap-replicates across the seam
// (FR-07) and keeps marker / line / stroke sizes constant under zoom.
//
// What it draws, back-to-front (spec §実装方針 3):
//   1. the map-wide 薄オーバーレイ — a translucent fill over the whole world while
//      the tool is active (FR-90). Drawn as a polygon spanning the world extent so
//      U17 fills it like any region; its translucency dims the base map / features.
//   2. the対象面強調 — the selected target leaf's resolved shape, drawn with an
//      emphasis fill + a thick screen-fixed outline ON TOP of the overlay (FR-90).
//      穴は透過 / 飛び地は独立領域 fall out of the even-odd `shape` primitive (FR-21).
//   3. the分断線プレビュー — the placed cut-line points + connecting polyline in a
//      style distinct from confirmed features (FR-78 仮表示); a CLOSED line also
//      draws its closing edge back to the first point.
//   4. the固定円 — a screen-fixed-size circle centred on the FIRST cut point
//      (FR-92 / FR-17). Its WORLD radius is `radiusPx / zoom` so its ON-SCREEN
//      radius is constant regardless of zoom (ズーム非依存). It is the「閉じてよい」
//      視覚ガイド + ヒット領域, NOT the closed shape itself (FR-92 円形に限定しない).
//   5. the cut-point markers on top.
//
// 教訓 5.18: a null / inactive state yields a real, valid EMPTY frame (`[]`), never
// skipped by a falsy short-circuit. 教訓 5.2: when the session is reset the next
// build naturally produces `[]`, so the overlay / preview / circle disappear on
// every exit path with no extra clearing code.

import type { WorldCoordinate } from '../domain/coordinate';
import type { GeoMultiPolygon } from '../domain/geometry/types';
import {
  KNIFE_LINE_KIND,
  KNIFE_PHASE,
  isFixedCircleVisible,
  isOverlayVisible,
  summarizePieces,
  type KnifeState,
} from '../domain/knife/index';

import type { DrawPrimitive, PolygonShapePrimitive } from './map-renderer';
import type { WorldPoint } from './vtransform';

// --- Style (the single place knife colours / sizes live; FR-17 screen-fixed) --

export interface KnifeStyle {
  /** Map-wide overlay fill (translucent; FR-90 薄オーバーレイ). */
  readonly overlayFill: string;
  /** Selected target emphasis fill (over the overlay; FR-90). */
  readonly targetFill: string;
  /** Selected target emphasis outline (screen-fixed width). */
  readonly targetStroke: string;
  readonly targetStrokeWidthPx: number;
  /** Cut-line provisional stroke (distinct from confirmed features; FR-78). */
  readonly cutStroke: string;
  readonly cutWidthPx: number;
  /** Closing-edge stroke for a CLOSED cut line (translucent). */
  readonly closingStroke: string;
  readonly closingWidthPx: number;
  /** Cut-point marker fill + screen-fixed radius. */
  readonly markerFill: string;
  readonly markerRadiusPx: number;
  /** Fixed-circle outline (FR-92 / FR-17). */
  readonly circleStroke: string;
  readonly circleWidthPx: number;
  /** Fixed-circle ON-SCREEN radius in CSS px (constant under zoom; FR-17). */
  readonly circleRadiusPx: number;
  /**
   * 閉じた分断線の囲みの塗り（N-10「閉じても画面が何も変わらない」）。閉じた瞬間に
   * 囲みが塗られ、閉じる辺も実線になり、固定円が消える。
   */
  readonly closedFill: string;
  /**
   * 分割の下見（V10 / N-09）: 片ごとの塗り。継承先に選んでいる片は {@link inheritFill}、
   * ほかの片はこの並びを順に使う（隣り合う片が同じ色にならないよう 4 色で回す）。
   */
  readonly pieceFills: readonly string[];
  /** 継承先（元の地物として残る片）の塗り。 */
  readonly inheritFill: string;
  readonly pieceStroke: string;
  readonly pieceStrokeWidthPx: number;
  /** 番号札（画面固定の文字の大きさ）。板の下見と同じ番号を地図にも出す。 */
  readonly tagFontPx: number;
  readonly tagFill: string;
  readonly tagHalo: string;
}

/** Default knife visual style (overridable; e.g. project theme). */
export const DEFAULT_KNIFE_STYLE: KnifeStyle = {
  // alpha < 1 ⇒ the whole-map overlay is translucent (spec §実装方針3 薄オーバーレイ).
  overlayFill: 'rgba(20, 24, 33, 0.35)',
  targetFill: 'rgba(255, 193, 7, 0.30)',
  targetStroke: '#ffc107',
  targetStrokeWidthPx: 2.5,
  cutStroke: '#d50000',
  cutWidthPx: 2,
  closingStroke: 'rgba(213, 0, 0, 0.45)',
  closingWidthPx: 1.5,
  markerFill: '#d50000',
  markerRadiusPx: 5,
  circleStroke: 'rgba(213, 0, 0, 0.7)',
  circleWidthPx: 1.5,
  circleRadiusPx: 28,
  closedFill: 'rgba(213, 0, 0, 0.18)',
  pieceFills: [
    'rgba(66, 165, 245, 0.45)',
    'rgba(102, 187, 106, 0.45)',
    'rgba(171, 71, 188, 0.45)',
    'rgba(38, 198, 218, 0.45)',
  ],
  inheritFill: 'rgba(255, 193, 7, 0.55)',
  pieceStroke: '#263238',
  pieceStrokeWidthPx: 1.5,
  tagFontPx: 18,
  tagFill: '#102027',
  tagHalo: '#ffffff',
};

/** The world extent the map-wide overlay covers (whole world; U17 seam-replicates). */
const WORLD_OVERLAY_RING: readonly WorldPoint[] = [
  { lon: -180, lat: -90 },
  { lon: 180, lat: -90 },
  { lon: 180, lat: 90 },
  { lon: -180, lat: 90 },
];

function toWorldPoint(c: WorldCoordinate): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

// --- Per-part builders ------------------------------------------------------

/** The map-wide translucent overlay (FR-90). Shown while selecting / drawing. */
function overlayPrimitive(style: KnifeStyle): DrawPrimitive {
  return {
    kind: 'polygon',
    ring: WORLD_OVERLAY_RING,
    fill: style.overlayFill,
  };
}

/**
 * The target-emphasis primitive: the selected leaf's resolved shape drawn over the
 * overlay with an emphasis fill + thick outline (FR-90). 穴透過 / 飛び地独立 are the
 * even-odd `shape` primitive's job (FR-21). `undefined` target shape ⇒ no emphasis
 * (still selecting; 教訓 5.18 a missing shape is a real "nothing to emphasize" state).
 */
function targetPrimitive(
  shape: GeoMultiPolygon | undefined,
  style: KnifeStyle,
): DrawPrimitive | undefined {
  if (shape === undefined || shape.length === 0) return undefined;
  const pieces: PolygonShapePrimitive['pieces'] = shape.map((poly) =>
    poly.map((ring) => ring.map(toWorldPoint)),
  );
  return {
    kind: 'shape',
    pieces,
    fill: style.targetFill,
    stroke: style.targetStroke,
    strokeWidthPx: style.targetStrokeWidthPx,
  };
}

/** The placed cut-line polyline (≥2 points) in provisional style (FR-78). */
function cutLinePrimitives(
  points: readonly WorldCoordinate[],
  closed: boolean,
  style: KnifeStyle,
): DrawPrimitive[] {
  if (points.length < 2) return [];
  const out: DrawPrimitive[] = [
    {
      kind: 'line',
      points: points.map(toWorldPoint),
      widthPx: style.cutWidthPx,
      stroke: style.cutStroke,
    },
  ];
  // A CLOSED cut: the enclosed region is filled UNDER the line and the closing edge is
  // drawn in the SAME solid cut stroke (N-10: closing must visibly change the picture —
  // the old translucent thin edge was easy to miss). An OPEN line draws no closing edge.
  if (closed) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && last !== undefined) {
      out.unshift({
        kind: 'polygon',
        ring: points.map(toWorldPoint),
        fill: style.closedFill,
      });
      out.push({
        kind: 'line',
        points: [toWorldPoint(last), toWorldPoint(first)],
        widthPx: style.cutWidthPx,
        stroke: style.cutStroke,
      });
    }
  }
  return out;
}

/** A marker per placed cut point (provisional style). */
function markerPrimitives(
  points: readonly WorldCoordinate[],
  style: KnifeStyle,
): DrawPrimitive[] {
  return points.map((p) => ({
    kind: 'point',
    at: toWorldPoint(p),
    radiusPx: style.markerRadiusPx,
    fill: style.markerFill,
  }));
}

/** Number of segments approximating the fixed circle (smooth enough at 28px). */
const CIRCLE_SEGMENTS = 32;

/**
 * The 固定円 centred on the FIRST cut point (FR-92). FR-17 / ズーム非依存: the circle's
 * ON-SCREEN radius is constant, so its WORLD radius is `circleRadiusPx / zoom` —
 * as zoom (CSS px per degree) grows the world radius shrinks, keeping the screen
 * radius fixed. Latitude scaling matches the equirectangular transform (same `zoom`
 * for lon-x and lat-y), so the ring is a screen-space circle. Emitted as a closed
 * polyline so U17 strokes it at a screen-fixed width without filling.
 */
function fixedCirclePrimitive(
  center: WorldCoordinate,
  zoom: number,
  style: KnifeStyle,
): DrawPrimitive | undefined {
  if (!(zoom > 0)) return undefined;
  const worldRadius = style.circleRadiusPx / zoom;
  const ring: WorldPoint[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i += 1) {
    const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    ring.push({
      lon: center.lon + Math.cos(t) * worldRadius,
      lat: center.lat + Math.sin(t) * worldRadius,
    });
  }
  return {
    kind: 'line',
    points: ring,
    widthPx: style.circleWidthPx,
    stroke: style.circleStroke,
  };
}

/**
 * 分割の下見（V10 / N-09）: 継承先を選んでいる間と素性を入れている間、地図の上に
 * **片ごとに別の色**で切った結果を描き、各片に **番号札**を立てる。穴は `shape` の
 * 偶奇規則でそのまま穴になる（FR-21）。番号と札の位置は板の下見と同じ 1 本
 * （`summarizePieces`）から取る（教訓 5.29）。
 */
function piecePreviewPrimitives(
  pieces: readonly GeoMultiPolygon[],
  inheritIndex: number,
  style: KnifeStyle,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  let other = 0;
  pieces.forEach((mp, i) => {
    let fill = style.inheritFill;
    if (i !== inheritIndex) {
      fill =
        style.pieceFills[other % Math.max(style.pieceFills.length, 1)] ??
        style.inheritFill;
      other += 1;
    }
    out.push({
      kind: 'shape',
      pieces: mp.map((poly) => poly.map((ring) => ring.map(toWorldPoint))),
      fill,
      stroke: style.pieceStroke,
      strokeWidthPx: style.pieceStrokeWidthPx,
    });
  });
  for (const s of summarizePieces(pieces)) {
    out.push({
      kind: 'label',
      at: toWorldPoint(s.labelPoint),
      text: String(s.number),
      fontPx: style.tagFontPx,
      fill: style.tagFill,
      halo: style.tagHalo,
      align: 'center',
      baseline: 'middle',
    });
  }
  return out;
}

// --- Whole-state batch ------------------------------------------------------

/** Inputs the builder needs beyond the session state (host-resolved; render→domain). */
export interface KnifeBatchInput {
  /** The current knife session state (domain truth lives in the UI store). */
  readonly state: KnifeState;
  /**
   * The selected target leaf's resolved geometry (host resolves it via U08 from the
   * domain; render→domain import is allowed). `undefined` while no target is chosen.
   */
  readonly targetShape: GeoMultiPolygon | undefined;
  /** The camera zoom (CSS px per degree) — the ONLY transform input the circle needs. */
  readonly zoom: number;
}

/**
 * Build the full knife provisional batch from the session state, back-to-front:
 * map-wide overlay, target emphasis, cut-line polyline (+ closing edge), the
 * screen-fixed circle, then the cut-point markers on top. An inactive / idle state
 * yields `[]` — a real, valid empty frame (教訓 5.18), so the overlay / circle /
 * preview vanish on every reset path (教訓 5.2) with no clearing code. All sizes are
 * screen-fixed (FR-17); U17 transforms / seam-replicates (FR-07).
 */
export function buildKnifePrimitives(
  input: KnifeBatchInput,
  style: KnifeStyle = DEFAULT_KNIFE_STYLE,
): DrawPrimitive[] {
  const { state, targetShape, zoom } = input;
  if (state.phase === KNIFE_PHASE.Inactive) return [];

  const out: DrawPrimitive[] = [];

  // 1. Map-wide overlay (while selecting / drawing — FR-90 — and, since N-13, while the
  //    new piece is being named: the map behind stays visible but reads as "not now").
  if (
    isOverlayVisible(state) ||
    state.phase === KNIFE_PHASE.EnteringProperties
  ) {
    out.push(overlayPrimitive(style));
  }

  // 2. After the cut is confirmed: the split preview (pieces in distinct colours, holes
  //    as holes, number tags) REPLACES the single-colour target emphasis (V10 / N-09).
  if (
    state.phase === KNIFE_PHASE.ChoosingInheritor ||
    state.phase === KNIFE_PHASE.EnteringProperties
  ) {
    const pieces = (
      state.result.pieces ?? [state.result.sideA, state.result.sideB]
    ).map((p) => p.area);
    const inherit =
      state.phase === KNIFE_PHASE.ChoosingInheritor
        ? state.selectedIndex
        : state.inheritIndex;
    out.push(...piecePreviewPrimitives(pieces, inherit, style));
    return out;
  }

  // 2'. Target emphasis (over the overlay).
  const target = targetPrimitive(targetShape, style);
  if (target !== undefined) out.push(target);

  // 3/4/5. Cut-line preview + fixed circle + markers (only while drawing).
  if (state.phase === KNIFE_PHASE.DrawingCut) {
    const points = state.line.points;
    out.push(
      ...cutLinePrimitives(points, state.line.kind === KNIFE_LINE_KIND.Closed, style),
    );
    // 閉じたら固定円は役目を終える（N-10: 閉じたことが絵で分かるよう、円を消して
    // 囲みを塗る）。
    if (
      isFixedCircleVisible(state) &&
      state.line.kind !== KNIFE_LINE_KIND.Closed
    ) {
      const center = points[0];
      if (center !== undefined) {
        const circle = fixedCirclePrimitive(center, zoom, style);
        if (circle !== undefined) out.push(circle);
      }
    }
    out.push(...markerPrimitives(points, style));
  }

  return out;
}
