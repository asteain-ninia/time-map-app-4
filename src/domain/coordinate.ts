// World coordinate value object (equirectangular projection, tech policy R3).
//
// Longitude is a *continuous* scalar: it may exceed [-180, 180) so that a path
// crossing the antimeridian is representable as a monotonically increasing
// value rather than wrapping (the periodic-seam normalization is a separate
// unit's concern). The coordinate type therefore deliberately allows any finite
// scalar and does not normalize on construction.
//
// Immutable value object: equality is by attribute value, mutation returns a
// new instance via `withXxx` (lesson 5.17). Plain shape so it maps directly
// to/from persisted data (lesson 5.20 / 5.31).

export interface WorldCoordinate {
  /** Continuous longitude scalar (degrees); may lie outside [-180, 180). */
  readonly lon: number;
  /** Latitude (degrees). */
  readonly lat: number;
}

export function createCoordinate(lon: number, lat: number): WorldCoordinate {
  return { lon, lat };
}

/** Attribute-value equality (lon and lat both equal). */
export function coordinatesEqual(a: WorldCoordinate, b: WorldCoordinate): boolean {
  return a.lon === b.lon && a.lat === b.lat;
}

// --- withXxx (every attribute covered: lon, lat) ----------------------------

export function withLon(coord: WorldCoordinate, lon: number): WorldCoordinate {
  return { lon, lat: coord.lat };
}

export function withLat(coord: WorldCoordinate, lat: number): WorldCoordinate {
  return { lon: coord.lon, lat };
}
