// Survey render-batch builder (U37, FR-14 / FR-15 / FR-16 / FR-17).
//
// UI/operation layer: turns the pure survey state (domain) + project geoParams
// into a declarative list of `DrawPrimitive`s for the MapRenderer (U17). It owns
// NO Canvas API and NO ±360° / world↔screen math — it only describes WHAT to
// draw in WORLD coordinates with SCREEN-fixed sizes; U17 transforms positions,
// wrap-replicates across the seam (FR-07) and keeps marker/label sizes constant
// (FR-17). Distances and the great-circle polyline come from the domain
// (single source of truth: U04 numbers, U37 interpolation).
//
// Import direction: ui -> domain, render (allowed). It depends on the render
// PRIMITIVE TYPES only, never on the concrete Canvas backend (受け入れ基準 6).
//
// 教訓 5.18: an empty survey state (no lines, no draft) yields an EMPTY primitive
// list — a real, valid empty frame, drawn as nothing rather than skipped by a
// falsy short-circuit.

import type { WorldCoordinate } from '../../domain/coordinate';
import type { GeoParams } from '../../domain/geo/geo-params';
import type { CoordinateDisplay } from '../../domain/survey/coords-format';
import { formatCoordinate } from '../../domain/survey/coords-format';
import {
  equirectangularPath,
  greatCirclePath,
} from '../../domain/survey/great-circle-path';
import { measureSurveyPair } from '../../domain/survey/measure';
import type {
  SurveyDraft,
  SurveyLine,
  SurveyState,
} from '../../domain/survey/survey-state';
import type { DrawPrimitive } from '../../render/map-renderer';
import type { WorldPoint } from '../../render/vtransform';

// --- Visual style (the single place survey colours / sizes are declared) ------
//
// FR-17: marker radius, line widths and label fonts are SCREEN-fixed px declared
// once here; U17 keeps them constant under zoom. Confirmed vs preview vs the two
// distance lines are visually distinct (spec §4.2 / §4.3).

export interface SurveyStyle {
  /** Great-circle (FR-15 mandatory) confirmed line stroke. */
  readonly greatCircleStroke: string;
  /** Equirectangular (straight) confirmed line stroke — distinct style. */
  readonly equirectangularStroke: string;
  /** Preview (in-progress) line stroke — distinct from confirmed. */
  readonly previewStroke: string;
  /** Temporary marker fill (FR-16). */
  readonly markerFill: string;
  /** Preview marker fill (the live hover end). */
  readonly previewMarkerFill: string;
  readonly lineWidthPx: number;
  readonly previewWidthPx: number;
  readonly markerRadiusPx: number;
}

/** Default survey style (overridable; e.g. project theme could supply colours). */
export const DEFAULT_SURVEY_STYLE: SurveyStyle = {
  greatCircleStroke: '#1565c0',
  equirectangularStroke: '#90a4ae',
  previewStroke: '#42a5f5',
  markerFill: '#1565c0',
  previewMarkerFill: '#42a5f5',
  lineWidthPx: 2,
  previewWidthPx: 1.5,
  markerRadiusPx: 5,
};

function toWorldPoint(c: WorldCoordinate): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

function toWorldPoints(path: readonly WorldCoordinate[]): WorldPoint[] {
  return path.map(toWorldPoint);
}

// --- One confirmed line's primitives ----------------------------------------

/**
 * Primitives for one confirmed survey line: the equirectangular straight line
 * (distinct style), the great-circle shortest-path curve (FR-15 mandatory), and
 * a temporary marker at each endpoint (FR-16). Drawn back-to-front: straight
 * line under the curve under the markers.
 */
export function confirmedLinePrimitives(
  line: SurveyLine,
  style: SurveyStyle,
): DrawPrimitive[] {
  const gc = greatCirclePath(line.start, line.end);
  const eq = equirectangularPath(line.start, line.end);
  return [
    {
      kind: 'line',
      points: toWorldPoints(eq),
      widthPx: style.lineWidthPx,
      stroke: style.equirectangularStroke,
    },
    {
      kind: 'line',
      points: toWorldPoints(gc),
      widthPx: style.lineWidthPx,
      stroke: style.greatCircleStroke,
    },
    {
      kind: 'point',
      at: toWorldPoint(line.start),
      radiusPx: style.markerRadiusPx,
      fill: style.markerFill,
    },
    {
      kind: 'point',
      at: toWorldPoint(line.end),
      radiusPx: style.markerRadiusPx,
      fill: style.markerFill,
    },
  ];
}

// --- Draft (in-progress) primitives -----------------------------------------

/**
 * Primitives for the in-progress draft: a start marker always, plus — once a
 * hover point exists — a preview great-circle line and a preview end marker
 * (distinct preview style, 教訓 5.2 一時表示). With no hover yet only the start
 * marker is drawn (教訓 5.18: "start placed, no hover" is a true intermediate
 * state, not an error).
 */
export function draftPrimitives(
  draft: SurveyDraft,
  style: SurveyStyle,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  if (draft.hover !== null) {
    const preview = greatCirclePath(draft.start, draft.hover);
    out.push({
      kind: 'line',
      points: toWorldPoints(preview),
      widthPx: style.previewWidthPx,
      stroke: style.previewStroke,
    });
    out.push({
      kind: 'point',
      at: toWorldPoint(draft.hover),
      radiusPx: style.markerRadiusPx,
      fill: style.previewMarkerFill,
    });
  }
  out.push({
    kind: 'point',
    at: toWorldPoint(draft.start),
    radiusPx: style.markerRadiusPx,
    fill: style.markerFill,
  });
  return out;
}

// --- Whole-state batch -------------------------------------------------------

/**
 * Build the full survey primitive list from the survey state: all confirmed
 * lines (which persist regardless of `active`, FR-15) followed by the
 * in-progress draft (only meaningful while a draft exists). The confirmed lines
 * are drawn even when survey mode is OFF (they remain until clear). An empty
 * state yields `[]` (教訓 5.18).
 */
export function buildSurveyPrimitives(
  state: SurveyState,
  style: SurveyStyle = DEFAULT_SURVEY_STYLE,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  for (const line of state.lines) {
    out.push(...confirmedLinePrimitives(line, style));
  }
  if (state.draft !== null) {
    out.push(...draftPrimitives(state.draft, style));
  }
  return out;
}

// --- Live readout (distances + lat/lon) for the side panel -------------------

/**
 * The full readout the U20 panel / overlay consumes for the current subject pair.
 * Besides the two FR-14 distances it carries, for BOTH endpoints, the raw world
 * coordinate AND its FR-16 dual-format display (度分秒 + 十進, via U37's
 * {@link formatCoordinate}). This is the public contract that makes the FR-16
 * "クリック地点の緯度経度を度分秒形式と十進形式の両方で表示する" requirement an
 * actual display path: the pure formatters are CONSUMED here, so the panel reads
 * `startDisplay.latDms / .latDecimal / .lonDms / .lonDecimal` directly rather
 * than the lat/lon math living only as untouched domain functions (AC-4).
 */
export interface SurveyReadout {
  /** Raw subject start coordinate (continuous-scalar longitude, as clicked). */
  readonly start: WorldCoordinate;
  /** Raw subject end coordinate. */
  readonly end: WorldCoordinate;
  /** Start lat/lon in BOTH 度分秒 + 十進 forms (FR-16). */
  readonly startDisplay: CoordinateDisplay;
  /** End lat/lon in BOTH 度分秒 + 十進 forms (FR-16). */
  readonly endDisplay: CoordinateDisplay;
  /** Equirectangular (map-plane) distance, km (FR-14). */
  readonly equirectangularKm: number;
  /** Great-circle (sphere shortest-path) distance, km (FR-14). */
  readonly greatCircleKm: number;
}

/**
 * The readout for the panel: the two distances (FR-14) AND both endpoints'
 * dual-format lat/lon display (FR-16) for the current subject pair. The subject
 * is the in-progress draft (start↔hover) while measuring, else the most recently
 * confirmed line. Returns `null` when there is nothing to measure (no draft with
 * a hover and no confirmed line — 教訓 5.18, an explicit null, not NaN).
 * Distances AND the lat/lon display strings are re-derived here from the live
 * coordinates / geoParams so a settings change reflects immediately
 * (教訓 5.3 / 5.35: derive display from stored truth, never cache).
 */
export function currentMeasurement(
  state: SurveyState,
  geoParams: GeoParams,
): SurveyReadout | null {
  let start: WorldCoordinate | undefined;
  let end: WorldCoordinate | undefined;
  if (state.draft !== null && state.draft.hover !== null) {
    start = state.draft.start;
    end = state.draft.hover;
  } else {
    const last = state.lines[state.lines.length - 1];
    if (last !== undefined) {
      start = last.start;
      end = last.end;
    }
  }
  if (start === undefined || end === undefined) {
    return null;
  }
  const m = measureSurveyPair(start, end, geoParams);
  return {
    start,
    end,
    startDisplay: formatCoordinate(start),
    endDisplay: formatCoordinate(end),
    equirectangularKm: m.equirectangularKm,
    greatCircleKm: m.greatCircleKm,
  };
}
