// U14 — SHARED domain validator for the SEMANTIC range/order constraints on the
// persisted settings surface (FR-109 / FR-110). Domain layer: pure, framework-free.
//
// WHY THIS EXISTS (bug-hunt fix): the Zod schema (`./schema`) validates most
// numeric settings as a bare finite number with NO range or ordering refinement.
// The UI's settings form DID enforce these rules (zoom 0.1×..10000× + min ≤ max,
// flattening ∈ [0,1), timelineMinYear < timelineMaxYear, gridOpacity ∈ [0,1],
// renderFps ∈ [1,60], snapDistance ≥ 0, …), but only on the UI confirm path —
// a crafted / corrupted manifest loaded straight through the parse boundary
// (`parseManifest` → Zod) bypassed every one of them. The result was a
// structurally "valid" project carrying timelineMinYear > timelineMaxYear,
// renderFps = 0, zoomMin > zoomMax, flattening ≥ 1 (degenerate geodesy),
// gridOpacity outside [0,1], snapDistance ≤ 0, etc. — values that break timeline
// derivation / rendering / area math, and which the domain consistency layer
// (`./consistency`, feature-graph semantics) does not cover.
//
// SINGLE SOURCE OF TRUTH (教訓 5.19 / 5.36): the range/order RULES now live here
// ONCE, at the domain layer, and are enforced at BOTH ends:
//   - the persistence schema enforces them via `superRefine` (the load boundary),
//   - the UI settings validation imports these SAME predicates/bounds (the
//     confirm boundary), so the form and the file can never disagree.
// The domain layer must not import the UI's setting TYPES (技術方針 2.13 layering),
// so this module declares the rules over plain numeric inputs; the UI passes its
// live values in. Bounds that already have a domain home (year magnitude via
// `../time/validate`, grid spacings via `../basemap/grid`) are NOT re-declared —
// they are referenced from their owning module.

import { isGridSpacing } from '../basemap/grid';

// --- numeric bounds (single place each rule's constant lives, 教訓 5.19) ------

/** Alpha/opacity is a fraction in [0, 1] (grid opacity, fill/selected opacity). */
export const OPACITY_MIN = 0;
export const OPACITY_MAX = 1;

/** Area-label screen-occupancy threshold is a fraction in [0, 1] (FR-109). */
export const OCCUPANCY_MIN = 0;
export const OCCUPANCY_MAX = 1;

/**
 * Snap distance is a non-negative px radius (FR-110); a negative radius is
 * meaningless and a non-positive radius simply disables snapping (so 0 is the
 * inclusive floor).
 */
export const SNAP_DISTANCE_MIN = 0;

/** Vertex-marker display cap is a non-negative integer (FR-110; 0 == show none). */
export const VERTEX_MARKER_CAP_MIN = 0;

/**
 * Undo-stack depth limit is a positive integer (FR-74). At least one unit must be
 * retainable; the history clamps a value < 1 to 1 (withLimit), but a persisted /
 * confirmed value must already be a valid positive integer.
 */
export const UNDO_STACK_SIZE_MIN = 1;

/** Render update rate is clamped to [1, 60] FPS (FR-110). */
export const MIN_RENDER_FPS = 1;
export const MAX_RENDER_FPS = 60;

/**
 * Flattening f is dimensionless and must lie in [0, 1): f = 0 is a true sphere;
 * f → 1 collapses the latitude scale to 0 (degenerate geodesy — every meridian
 * length / latitude-aware area becomes 0), and f ≥ 1 inverts it. Spec §4.3 / U04.
 */
export const FLATTENING_MIN = 0;
/** Exclusive upper bound: flattening must be strictly < 1. */
export const FLATTENING_MAX_EXCLUSIVE = 1;

/** FR-10 user-settable zoom-limit boundary: [0.1×, 10000×]. */
export const ZOOM_LIMIT_FLOOR = 0.1;
export const ZOOM_LIMIT_CEIL = 10000;

// --- pure predicates (the RULES, single source for schema + UI) --------------

function isFiniteNumber(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Equator length must be a finite, strictly-positive km value (FR-109 / U04). */
export function isValidEquatorKm(equatorKm: number): boolean {
  return isFiniteNumber(equatorKm) && equatorKm > 0;
}

/** Flattening must be finite and in [0, 1) (true sphere .. just-shy-of-degenerate). */
export function isValidFlattening(flattening: number): boolean {
  return (
    isFiniteNumber(flattening) &&
    flattening >= FLATTENING_MIN &&
    flattening < FLATTENING_MAX_EXCLUSIVE
  );
}

/** An opacity/occupancy fraction in [0, 1]. */
export function isValidUnitFraction(v: number): boolean {
  return isFiniteNumber(v) && v >= OPACITY_MIN && v <= OPACITY_MAX;
}

/** Grid spacing must be one of the allowed spacings (delegates to U18, 単一真実源). */
export function isValidGridSpacing(spacingDeg: number): boolean {
  return isGridSpacing(spacingDeg);
}

/** Render FPS must be finite and in [1, 60]. */
export function isValidRenderFps(fps: number): boolean {
  return isFiniteNumber(fps) && fps >= MIN_RENDER_FPS && fps <= MAX_RENDER_FPS;
}

/** Snap distance must be finite and ≥ 0. */
export function isValidSnapDistancePx(px: number): boolean {
  return isFiniteNumber(px) && px >= SNAP_DISTANCE_MIN;
}

/** Vertex-marker cap must be a non-negative integer. */
export function isValidVertexMarkerCap(cap: number): boolean {
  return isFiniteNumber(cap) && Number.isInteger(cap) && cap >= VERTEX_MARKER_CAP_MIN;
}

/** Undo-stack depth limit must be a positive integer (FR-74). */
export function isValidUndoStackSize(size: number): boolean {
  return isFiniteNumber(size) && Number.isInteger(size) && size >= UNDO_STACK_SIZE_MIN;
}

/** A single zoom magnitude must be finite and inside the FR-10 boundary [0.1, 10000]. */
export function isWithinZoomBoundary(v: number): boolean {
  return isFiniteNumber(v) && v >= ZOOM_LIMIT_FLOOR && v <= ZOOM_LIMIT_CEIL;
}

// --- order constraints (the cross-field RULES) -------------------------------

/**
 * The timeline range must be NON-EMPTY and correctly ordered: minYear strictly
 * less than maxYear. A reversed or zero-width range breaks every timeline
 * derivation (interval enumeration, slider extent, anchor placement).
 */
export function isValidTimelineOrder(minYear: number, maxYear: number): boolean {
  return isFiniteNumber(minYear) && isFiniteNumber(maxYear) && minYear < maxYear;
}

/**
 * The zoom limits must be correctly ordered (min ≤ max). Order is only meaningful
 * once both ends are individually within the allowed boundary; a caller that
 * wants the full FR-10 rule should also check {@link isWithinZoomBoundary} on each.
 */
export function isValidZoomOrder(zoomMin: number, zoomMax: number): boolean {
  return isFiniteNumber(zoomMin) && isFiniteNumber(zoomMax) && zoomMin <= zoomMax;
}
