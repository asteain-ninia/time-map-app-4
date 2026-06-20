// UI layer (U35 / conflict): the PURE minimap-preview build (FR-62 / FR-63).
//
// Turns ONE conflict (the two terminal shapes at the conflict time + the U13
// overlap geometry + the chosen priority) into a render-layer `DrawPrimitive[]`
// for a small preview canvas, reusing U19's feature-drawing rules verbatim
// (穴透過・飛び地独立・サイズ固定 — 教訓 5.29 / 5.30). NO ミニマップ-only fill rule
// is invented here: every area goes through `buildFeaturePrimitives`, so a hole
// stays透過 and a飛び地 stays本土同様 exactly as on the main map (受け入れ基準 3).
//
// This module is PURE (no Canvas, no React): it returns the primitive列 + the
// fitted camera, so the build is Vitest-checkable as a draw-command list
// (教訓 5.41). The actual Canvas paint is a thin委譲 in the React component.
//
// Import direction is ui → domain, ui → render (both inward, lint-enforced).

import type { FeatureId } from '../../domain/ids';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import { difference, isOk } from '../../domain/geometry/boolean-ops';
import type { Conflict } from '../../domain/consistency/index';
import type { Camera, Viewport } from '../../render/camera';
import type { DrawPrimitive } from '../../render/map-renderer';
import {
  type BuildOptions,
  type EvaluatedArea,
  type FeatureStyle,
  type ScreenSizes,
  type LabelThresholds,
  DEFAULT_SCREEN_SIZES,
  buildFeaturePrimitives,
  shapeRect,
  type WorldRect,
} from '../../render/feature-layer';

// --- shapes input (the U13/host adapter, 教訓 5.33) -------------------------
//
// A `Conflict` carries the overlap geometry + participant ids/names. The two
// participants' FULL shapes at the conflict time are looked up by the HOST (from
// domain state via the same evaluation U19 uses) and handed to this module as a
// typed value. Keeping this an explicit adapter input (not a re-derivation here)
// honours 教訓 5.3 (操作対象は供給データに限定) and decouples U35 from how the host
// evaluates feature shapes — the contract is the shared type below.

/** The two terminal shapes that overlap, keyed by participant feature id. */
export interface ConflictShapes {
  readonly aFeatureId: FeatureId;
  readonly aShape: GeoMultiPolygon;
  readonly bFeatureId: FeatureId;
  readonly bShape: GeoMultiPolygon;
}

// --- preview colour roles (描き分け, FR-63 / 教訓 5.30 過剰共有の戒め) --------
//
// The priority / remaining / overlap colouring is a conflict-resolution-SPECIFIC
// concern (not a general feature style), so it lives HERE rather than being
// folded into U19's general style — but it is expressed through U19's
// `FeatureStyle` so the SAME draw path renders it (過少共有も避ける).

/** Default preview colours. Distinct hues for the three roles. */
export const PREVIEW_COLORS = {
  /** The priority (kept-whole) feature. */
  priority: '#2e7d32',
  /** The adjusted feature's remaining area (after the overlap is removed). */
  remaining: '#1565c0',
  /** The overlap area that will be trimmed away. */
  overlap: '#c62828',
  /** Outline colour shared by every preview area. */
  outline: '#333333',
  /** Neutral fill for a feature before a priority is chosen. */
  neutral: '#9e9e9e',
} as const;

function styleOf(fill: string): FeatureStyle {
  return { fill, stroke: PREVIEW_COLORS.outline, selectedColor: fill };
}

// --- camera fit (局所カメラ変換: 競合周辺へフィット) -------------------------

/** Inclusive padding fraction added around the fitted rect so shapes are not flush to the edge. */
export const PREVIEW_PADDING_FRACTION = 0.15;

/**
 * Compute the camera that fits a world rectangle into a viewport with padding.
 * Pure (no renderer state). Whichever axis is the tighter constraint sets the
 * zoom so the rect never overflows (mirrors `fitWorldZoom`'s logic for an
 * arbitrary rect). A degenerate rect (zero span) falls back to a 1° window so a
 * point-like overlap still gets a sensible zoom rather than Infinity.
 */
export function fitCameraToRect(rect: WorldRect, viewport: Viewport): Camera {
  const rawLonSpan = rect.maxLon - rect.minLon;
  const rawLatSpan = rect.maxLat - rect.minLat;
  const lonSpan = rawLonSpan > 0 ? rawLonSpan : 1;
  const latSpan = rawLatSpan > 0 ? rawLatSpan : 1;
  const pad = 1 + 2 * PREVIEW_PADDING_FRACTION;
  const centerLon = (rect.minLon + rect.maxLon) / 2;
  const centerLat = (rect.minLat + rect.maxLat) / 2;

  if (
    !Number.isFinite(viewport.widthCss) ||
    !Number.isFinite(viewport.heightCss) ||
    viewport.widthCss <= 0 ||
    viewport.heightCss <= 0
  ) {
    return { centerLon, centerLat, zoom: 0 };
  }
  const zoomForLon = viewport.widthCss / (lonSpan * pad);
  const zoomForLat = viewport.heightCss / (latSpan * pad);
  return { centerLon, centerLat, zoom: Math.min(zoomForLon, zoomForLat) };
}

/**
 * The union bbox of the two shapes + the overlap, so the fit shows the whole
 * conflict neighbourhood. Returns a 1°-window fallback centred at (0,0) when
 * every input is empty (病的入力の安全性 — never NaN/Infinity downstream).
 */
export function conflictBounds(
  shapes: ConflictShapes,
  overlap: GeoMultiPolygon,
): WorldRect {
  const rects: WorldRect[] = [];
  for (const s of [shapes.aShape, shapes.bShape, overlap]) {
    const r = shapeRect(s);
    if (r !== undefined) rects.push(r);
  }
  if (rects.length === 0) {
    return { minLon: -0.5, minLat: -0.5, maxLon: 0.5, maxLat: 0.5 };
  }
  return rects.reduce((acc, r) => ({
    minLon: Math.min(acc.minLon, r.minLon),
    minLat: Math.min(acc.minLat, r.minLat),
    maxLon: Math.max(acc.maxLon, r.maxLon),
    maxLat: Math.max(acc.maxLat, r.maxLat),
  }));
}

// --- remaining-area computation (差分の見える化, 教訓 5.1 全片を描く) ----------

/**
 * The adjusted feature's REMAINING area = (adjust shape) − (priority shape),
 * computed through U06's `difference` (the single sanctioned boolean window). A
 * difference may yield MULTIPLE pieces — every piece is kept (教訓 5.1 片落とし禁止)
 * because U19 then draws them all. On a boolean rejection (degenerate input) the
 * preview falls back to the original adjust shape so the user still sees the
 * feature rather than a blank — the real difference is computed for-keeps by
 * U06/U13 at apply time, not here (this is a参考プレビュー, FR-63).
 */
export function remainingArea(
  adjustShape: GeoMultiPolygon,
  priorityShape: GeoMultiPolygon,
): GeoMultiPolygon {
  const result = difference(adjustShape, priorityShape);
  return isOk(result) ? result.result : adjustShape;
}

// --- the preview build (the single entry point) -----------------------------

/** A built preview: the fitted camera + the draw-command列 for the canvas. */
export interface ConflictPreview {
  readonly camera: Camera;
  readonly primitives: readonly DrawPrimitive[];
}

/** Per-preview options (sizes/thresholds default to U19's恒常表示 values). */
export interface PreviewOptions {
  readonly viewport: Viewport;
  /** The chosen priority feature id, or undefined when none chosen yet. */
  readonly priorityFeatureId: FeatureId | undefined;
  readonly sizes?: ScreenSizes;
  readonly colors?: typeof PREVIEW_COLORS;
}

// Preview labels are off (a tiny minimap should not crowd with text); the build
// still goes through U19 so the area FILL rules (穴透過・飛び地) are identical.
const PREVIEW_THRESHOLDS: LabelThresholds = {
  pointMinZoom: Number.POSITIVE_INFINITY,
  lineMinVisibleLengthPx: Number.POSITIVE_INFINITY,
  areaMinOccupancy: Number.POSITIVE_INFINITY,
};

/**
 * Build the minimap preview for ONE conflict (受け入れ基準 3). Reuses U19's
 * `buildFeaturePrimitives` for EVERY area so穴透過・飛び地独立 hold with the恒常
 * rule (no minimap-only fill). The描き分け is achieved purely by COLOUR role
 * (priority / remaining / overlap), never by changing ring structure (教訓 5.25 /
 * 5.29). Clipping/LOD are OFF so the tiny fitted view always shows the whole
 * neighbourhood. Pure: same inputs ⇒ same primitive列 + camera (教訓 5.41).
 *
 * Layering of the three roles (back→front):
 *   - before a priority is chosen: both features in neutral, then the overlap on
 *     top so the user sees where they collide;
 *   - after a priority is chosen: the priority feature WHOLE, the adjusted
 *     feature's REMAINING area, then the overlap (削られる領域) on top.
 */
export function buildConflictPreview(
  conflict: Conflict,
  shapes: ConflictShapes,
  options: PreviewOptions,
): ConflictPreview {
  const colors = options.colors ?? PREVIEW_COLORS;
  const sizes = options.sizes ?? DEFAULT_SCREEN_SIZES;
  const bounds = conflictBounds(shapes, conflict.overlap);
  const camera = fitCameraToRect(bounds, options.viewport);
  const buildOpts: BuildOptions = {
    camera,
    viewport: options.viewport,
    sizes,
    thresholds: PREVIEW_THRESHOLDS,
    clip: false,
    lod: false,
  };

  const areas: EvaluatedArea[] = [];
  const { priorityFeatureId } = options;

  if (priorityFeatureId === undefined) {
    // No choice yet: show both features neutral + the overlap highlighted.
    areas.push(area('a', shapes.aShape, colors.neutral));
    areas.push(area('b', shapes.bShape, colors.neutral));
    areas.push(area('overlap', conflict.overlap, colors.overlap));
  } else {
    const priorityShape =
      priorityFeatureId === shapes.aFeatureId ? shapes.aShape : shapes.bShape;
    const adjustShape =
      priorityFeatureId === shapes.aFeatureId ? shapes.bShape : shapes.aShape;
    const remaining = remainingArea(adjustShape, priorityShape);
    // Priority drawn first (kept whole), then the adjusted-remaining, then the
    // overlap (the削られる領域) on top so it reads as "this part is removed".
    areas.push(area('priority', priorityShape, colors.priority));
    areas.push(area('remaining', remaining, colors.remaining));
    areas.push(area('overlap', conflict.overlap, colors.overlap));
  }

  const primitives = buildFeaturePrimitives(areas, buildOpts);
  return { camera, primitives };
}

/** Build one evaluated area draw-item (label off; selected styling unused). */
function area(id: string, shape: GeoMultiPolygon, fill: string): EvaluatedArea {
  return { kind: 'area', id, shape, style: styleOf(fill), label: '', selected: false };
}
