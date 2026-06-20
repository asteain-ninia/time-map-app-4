// U23 — click-position snap resolution (FR-78 グリッドスナップ / FR-31 近接スナップ,
// spec §注意点「スナップ優先順位の明確化」, 教訓 5.18 / 5.29).
//
// Pure domain logic that resolves the FINAL world coordinate (and any shared-
// vertex candidate) for a click, combining two snap sources with a SINGLE,
// explicitly-defined priority (spec §注意点):
//
//   1. shared-vertex (proximity) snap — FR-31 既定 50px screen distance — takes
//      PRECEDENCE. Its candidate search / screen-distance test is delegated to
//      U10 / U24 (spec §やらないこと); the caller passes the already-resolved
//      nearest candidate (snapped coordinate + existing vertex id) in here.
//   2. grid snap — FR-78 / FR-13 — applies ONLY when grid-snap is on AND there is
//      no shared-vertex candidate, snapping the raw click to the nearest lat/lon
//      graticule point at the project grid spacing.
//   3. otherwise the raw click coordinate is used unchanged.
//
// This is the single source of truth for that priority (spec §注意点「単一の真実源
// として 1 箇所に決める」): the UI never re-decides it. The terminal-exclusion
// gate (FR-29: a face vertex may not land inside a terminal) is also surfaced
// here as an input the caller has already evaluated (U10), so this module decides
// allow/deny from the result rather than re-implementing the predicate (教訓 5.25
// — exclusion applies to faces only; line/point are not gated).

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import type { GridSpacingDeg } from '../basemap/grid';
import type { FeatureId } from '../ids';

// --- The caller-supplied proximity candidate (FR-31, from U10/U24) ----------

/**
 * A nearest existing-vertex candidate the caller resolved by SCREEN-distance
 * (FR-31, 既定 50px — the distance test lives in U24, not here). When present it
 * carries the existing vertex's snapped world coordinate AND its owning feature
 * id, so a snap onto it both relocates the click and marks a shared-vertex
 * candidate (FR-30〜33).
 */
export interface ProximityCandidate {
  readonly coordinate: WorldCoordinate;
  readonly featureId: FeatureId;
}

// --- Grid snap (FR-78 / FR-13) ----------------------------------------------

/**
 * Snap a single scalar to the nearest multiple of `spacing`. Pure rounding; the
 * graticule is the global multiples-of-spacing grid (consistent with U18's
 * `graticuleLatitudes` / `graticuleLongitudes`), so a snapped point lands on a
 * drawn grid intersection.
 */
function snapScalar(value: number, spacing: number): number {
  return Math.round(value / spacing) * spacing;
}

/**
 * Snap a world coordinate to the nearest lat/lon graticule point at `spacing`
 * (FR-78). Longitude is a continuous scalar (R3): rounding to the nearest grid
 * multiple keeps it continuous across the seam (no private ±360° folding here —
 * the multiples simply continue past ±180, matching U18's enumeration). Latitude
 * is snapped the same way; the caller is responsible for any ±90 clamping if it
 * matters (grid spacings divide 90, so multiples stay in range).
 */
export function snapToGrid(
  coordinate: WorldCoordinate,
  spacing: GridSpacingDeg,
): WorldCoordinate {
  return createCoordinate(
    snapScalar(coordinate.lon, spacing),
    snapScalar(coordinate.lat, spacing),
  );
}

// --- The resolved snap (single priority source; spec §注意点) ---------------

/**
 * The resolved click position after applying the snap priority. `coordinate` is
 * the final world point to place; `sharedCandidateId` is the existing vertex id
 * to share with (FR-30〜33) when a proximity snap won, else null. The
 * discriminated `source` records WHICH rule applied (for tests / overlays).
 */
export const SNAP_SOURCE = {
  /** Snapped onto an existing vertex (FR-31, highest priority). */
  Shared: 'shared',
  /** Snapped to a grid graticule point (FR-78). */
  Grid: 'grid',
  /** No snap applied; the raw click was used. */
  None: 'none',
} as const;

export type SnapSource = (typeof SNAP_SOURCE)[keyof typeof SNAP_SOURCE];

export interface ResolvedSnap {
  readonly coordinate: WorldCoordinate;
  readonly sharedCandidateId: FeatureId | null;
  readonly source: SnapSource;
}

export interface SnapInput {
  /** The raw clicked world coordinate (continuous-scalar longitude, R3). */
  readonly raw: WorldCoordinate;
  /** Whether grid snap is on (FR-78). */
  readonly gridSnap: boolean;
  /** The project grid spacing (FR-13) — used only when grid snap applies. */
  readonly gridSpacing: GridSpacingDeg;
  /**
   * The nearest existing-vertex candidate the caller resolved within the snap
   * distance (FR-31), or null when none is within range. PRECEDENCE over grid.
   */
  readonly proximity: ProximityCandidate | null;
}

/**
 * Resolve the final click position with the SINGLE defined priority
 * (spec §注意点): shared-vertex proximity snap first, then grid snap (only if on
 * and no proximity candidate), else the raw click. This is the one place the
 * priority is decided; callers never re-order it. `proximity` is decided by
 * explicit null check, not a falsy short-circuit (教訓 5.18).
 */
export function resolveSnap(input: SnapInput): ResolvedSnap {
  // 1. Shared-vertex proximity snap wins outright (FR-31 > FR-78).
  if (input.proximity !== null) {
    return {
      coordinate: input.proximity.coordinate,
      sharedCandidateId: input.proximity.featureId,
      source: SNAP_SOURCE.Shared,
    };
  }
  // 2. Grid snap when enabled and nothing to share with.
  if (input.gridSnap) {
    return {
      coordinate: snapToGrid(input.raw, input.gridSpacing),
      sharedCandidateId: null,
      source: SNAP_SOURCE.Grid,
    };
  }
  // 3. Raw click.
  return { coordinate: input.raw, sharedCandidateId: null, source: SNAP_SOURCE.None };
}

// --- Terminal-exclusion gate (FR-29; 教訓 5.25) -----------------------------

/**
 * Decide whether a placement is ALLOWED, given (a) the add-tool's exclusivity and
 * (b) whether the caller's terminal-internal test (U10, delegated) said the
 * resolved point is inside a terminal feature. FR-29: a FACE vertex may not be
 * placed inside a terminal feature; LINE and POINT have NO such exclusion and are
 * always allowed to overlap (教訓 5.25 — do NOT widen exclusion to line/point for
 * symmetry). `isFaceTool` and `insideTerminal` are both caller-evaluated facts;
 * this function only combines them into the single allow/deny decision.
 */
export function isPlacementAllowed(
  isFaceTool: boolean,
  insideTerminal: boolean,
): boolean {
  if (!isFaceTool) return true; // line / point: no terminal exclusion (FR-29).
  return !insideTerminal; // face: blocked inside a terminal (FR-29).
}
