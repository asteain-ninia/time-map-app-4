// Geodesic parameters injected from project settings (FR-109, 技術方針 §2.9).
//
// Every public geo function takes its scale from this object — the module holds
// NO hidden constants for the planet's size or shape (AC-5). Bundling the two
// values into one parameter object (like the calendar settings object) prevents
// argument-order mix-ups at the call site (spec §2.1, 教訓 5.33/5.34).

export interface GeoParams {
  /** Length of the equator (latitude 0) once around the map, in km. */
  readonly equatorKm: number;
  /**
   * Flattening f (dimensionless): how much shorter the meridian circumference
   * is than the equatorial one. f = 0 is a true sphere; the latitude scale is
   * multiplied by (1 - f) per spec §4.3.
   */
  readonly flattening: number;
}

export function createGeoParams(equatorKm: number, flattening: number): GeoParams {
  return { equatorKm, flattening };
}

// --- Derived base scalars (single helper — every function shares these) ------
//
// 教訓 5.30 / "single source of truth": the km-per-degree scalars and the
// sphere radius are derived in exactly one place so distance / length / area
// cannot drift apart. Spec §4.3 fixes the formulas; do not recompute them ad hoc
// in the consumers.

const DEGREES_PER_TURN = 360;
const TWO_PI = 2 * Math.PI;

export interface GeoScalars {
  /** km per degree of longitude along the equator: equatorKm / 360. */
  readonly kmPerLonDegAtEquator: number;
  /** km per degree of latitude: (equatorKm / 360) * (1 - flattening). */
  readonly kmPerLatDeg: number;
  /** Sphere radius used by the great-circle metric: equatorKm / (2π). */
  readonly sphereRadiusKm: number;
}

export function deriveScalars(geoParams: GeoParams): GeoScalars {
  const kmPerLonDegAtEquator = geoParams.equatorKm / DEGREES_PER_TURN;
  return {
    kmPerLonDegAtEquator,
    kmPerLatDeg: kmPerLonDegAtEquator * (1 - geoParams.flattening),
    sphereRadiusKm: geoParams.equatorKm / TWO_PI,
  };
}
