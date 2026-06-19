// Survey two-point measurement adapter (U37, FR-14). Pure domain logic.
//
// This is the boundary the survey mode uses to obtain the two distances FR-14
// requires for a pair of clicked points: the EQUIRECTANGULAR (map-plane) and the
// GREAT-CIRCLE (sphere) distance, both in km. The actual distance formulas, and
// the ±360° shortest-seam normalization, are U04's — this unit only forwards the
// two points + the project's geoParams to U04 and bundles the two results
// (単一真実源, spec §2.2: do not re-implement haversine / plate-carrée / wrap).
//
// Degenerate-input discipline (spec §4.6): identical points -> both distances 0
// (U04 already returns 0); no exception is thrown.

import type { WorldCoordinate } from '../coordinate';
import {
  equirectangularDistanceKm,
  greatCircleDistanceKm,
} from '../geo/geodesy';
import type { GeoParams } from '../geo/geo-params';

/** The two distances FR-14 displays for a survey pair, both in km. */
export interface SurveyMeasurement {
  /** Equirectangular (map-plane / plate-carrée) distance, km. */
  readonly equirectangularKm: number;
  /** Great-circle (spherical shortest-path) distance, km. */
  readonly greatCircleKm: number;
}

/**
 * Measure both distances between two clicked points (FR-14), delegating every
 * numeric step to U04. The longitude difference is taken on the shortest seam
 * side inside U04, so an east-edge↔west-edge pair is the short way round, not the
 * naive 359° detour (spec §2.1 / 受け入れ基準 2).
 */
export function measureSurveyPair(
  start: WorldCoordinate,
  end: WorldCoordinate,
  geoParams: GeoParams,
): SurveyMeasurement {
  return {
    equirectangularKm: equirectangularDistanceKm(start, end, geoParams),
    greatCircleKm: greatCircleDistanceKm(start, end, geoParams),
  };
}
