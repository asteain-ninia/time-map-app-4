// Realistic country-outline fixtures — diverse, non-square base shapes for the
// property / E2E suites.
//
// WHY: the existing fixtures (e2e/helpers.ts `commitOneFace`, the unit tests'
// `SQUARE_*`) draw nothing but axis-aligned rectangles, so concave geometry,
// many-vertex rings, multi-polygon bodies, separated islands and holes (enclaves)
// were never exercised by realistic shapes. These literals give callers a shared,
// typed catalogue of "looks like a real country" outlines to draw on the map or
// feed to the boolean / consistency layer.
//
// SCOPE / FIDELITY: the coordinates are *simplified* — geographically inspired,
// not survey-accurate. The goal is topological + shape DIVERSITY (concave,
// multi-vertex, multi-polygon, disjoint pieces, holes), NOT cartographic truth.
// Every value is a literal embedded here so the fixture is NETWORK-INDEPENDENT
// (no GeoJSON fetch at test time); a public simplified GeoJSON could refresh these
// later but is deliberately not a runtime dependency.
//
// (Coordinates are typed but carry no runtime validation — they are plain data.)
//
// TYPING: shapes are declared as the domain `GeoMultiPolygon` (a type-only import,
// no runtime coupling to src). Ring index 0 of each polygon is the outer
// (territory) ring; later rings in the same polygon are holes. Rings are
// implicitly closed (first vertex NOT repeated), matching src/domain/geometry.

import type { GeoMultiPolygon, GeoRing } from '../../src/domain/geometry/types';
import type { WorldCoordinate } from '../../src/domain/coordinate';

/** Build a [lon, lat] world coordinate literal (no runtime validation needed). */
function c(lon: number, lat: number): WorldCoordinate {
  return { lon, lat };
}

// ── Italy — the classic concave "boot" (single polygon, reflex vertices). ──────
// Exercises: concavity. The instep/heel create reflex (>180°) interior angles, so
// a renderer/clipper that assumes convex rings will mis-handle it.
const ITALY: GeoMultiPolygon = [
  [
    [
      c(7.0, 45.9), // Alpine north-west
      c(13.6, 46.5), // north-east
      c(13.1, 45.6), // Adriatic coast
      c(16.2, 41.9), // heel start (Gargano spur)
      c(18.5, 40.1), // heel tip (Salento)
      c(17.9, 40.5), // up the inside of the heel  ← reflex
      c(16.5, 39.8), // instep (Gulf of Taranto)   ← reflex
      c(15.9, 38.0), // toe (Calabria)
      c(15.6, 38.2), // up the shin (Tyrrhenian)   ← reflex
      c(13.0, 40.9), // west coast
      c(10.3, 43.5), // Tuscany
      c(8.8, 44.4), // Ligurian coast
    ],
  ],
];

// ── Chile — extremely elongated, many-vertex single polygon. ───────────────────
// Exercises: a long thin ring with many vertices and a high aspect ratio (bbox is
// tall and narrow), which stresses culling / bbox / simplification code paths.
const CHILE: GeoMultiPolygon = [
  [
    [
      c(-70.4, -18.3), // far north (Arica)
      c(-69.5, -24.0),
      c(-68.4, -27.0),
      c(-70.0, -30.0),
      c(-71.5, -33.4), // Santiago latitude
      c(-72.9, -38.0),
      c(-73.6, -41.5), // Los Lagos
      c(-74.6, -44.0),
      c(-73.5, -48.0),
      c(-72.0, -51.0),
      c(-70.0, -53.2), // Magallanes (far south)
      c(-69.0, -52.0), // back up the Atlantic-ish side
      c(-71.0, -47.0),
      c(-72.0, -42.0),
      c(-71.0, -36.0), // Andean spine (east edge)
      c(-69.8, -30.0),
      c(-68.5, -24.0),
      c(-68.9, -19.0),
    ],
  ],
];

// ── Japan — a multi-polygon body (four main islands as disjoint pieces). ───────
// Exercises: 教訓5.1 (results are multi-polygon; never collapse to the first
// piece). Hokkaido / Honshu / Shikoku / Kyushu are four separate polygons.
const JAPAN: GeoMultiPolygon = [
  // Hokkaido (north)
  [
    [c(140.0, 45.5), c(145.8, 44.3), c(145.3, 42.9), c(141.0, 41.4), c(139.8, 43.2)],
  ],
  // Honshu (main, gently bent — slight concavity at the Sea-of-Japan side)
  [
    [
      c(140.9, 41.2),
      c(141.6, 39.0),
      c(140.9, 35.0), // Pacific side, Tokyo-ish
      c(136.9, 34.6),
      c(135.0, 33.5), // Kii peninsula
      c(132.0, 34.0),
      c(131.0, 34.6), // western tip (Yamaguchi)
      c(135.5, 35.6), // Sea-of-Japan coast (bend back) ← concave
      c(139.0, 38.0),
      c(140.5, 40.0),
    ],
  ],
  // Shikoku (small)
  [
    [c(132.6, 34.3), c(134.7, 34.3), c(134.3, 33.4), c(132.7, 33.0)],
  ],
  // Kyushu (south-west)
  [
    [c(130.9, 33.9), c(131.9, 32.7), c(131.4, 31.0), c(130.2, 31.0), c(129.6, 33.2)],
  ],
];

// ── United Kingdom + Ireland — two separated outer polygons in one shape. ──────
// Exercises: disjoint territory pieces that are NOT each other's holes (Great
// Britain and the island of Ireland are two distinct outer rings).
const UK_AND_IRELAND: GeoMultiPolygon = [
  // Great Britain (concave — the Bristol-Channel / Wales indent + Scottish taper)
  [
    [
      c(-3.0, 58.6), // northern Scotland
      c(-2.0, 57.5),
      c(-1.3, 54.8), // NE England
      c(0.6, 52.9), // East Anglia bulge
      c(1.4, 51.4), // SE (Kent)
      c(-1.1, 50.7), // south coast
      c(-3.6, 50.2), // SW (Devon)
      c(-5.7, 50.1), // Cornwall tip
      c(-4.2, 51.6), // up into the Bristol Channel ← concave indent
      c(-3.0, 53.4), // Wales / NW
      c(-4.8, 54.9), // Solway
      c(-5.6, 56.8), // western Highlands
    ],
  ],
  // Ireland (separate island, roughly oval)
  [
    [
      c(-6.0, 55.2),
      c(-6.2, 53.4),
      c(-6.9, 52.1), // SE
      c(-9.4, 51.5), // SW
      c(-10.3, 53.4), // W
      c(-9.0, 54.5), // NW
      c(-7.5, 55.3), // N
    ],
  ],
];

// ── Norway — many-vertex, fjord-jagged coastline (single concave polygon). ─────
// Exercises: a high vertex-count ring with deep concave inlets (fjords), stressing
// any per-edge / per-vertex work and concave fill rules.
const NORWAY: GeoMultiPolygon = [
  [
    [
      c(5.0, 58.1), // SW (Stavanger)
      c(5.7, 58.9),
      c(4.9, 59.6), // fjord mouth
      c(6.0, 60.4), // inland (Hardanger)        ← concave inlet
      c(5.2, 61.2),
      c(7.0, 62.0), // inland (Geiranger-ish)     ← concave inlet
      c(6.6, 62.6),
      c(9.5, 63.5), // Trondheim fjord            ← concave inlet
      c(11.0, 64.5),
      c(13.0, 66.0),
      c(15.5, 68.3), // Lofoten / north
      c(18.9, 69.6),
      c(23.0, 70.4), // Finnmark
      c(28.2, 70.9), // NE tip
      c(30.0, 69.7), // Russian border
      c(24.0, 68.6), // back down the inland border
      c(20.0, 68.4),
      c(15.0, 66.1),
      c(12.2, 63.0),
      c(12.0, 61.0),
      c(11.4, 59.3), // Oslo fjord region
      c(10.6, 59.0),
    ],
  ],
];

// ── Enclave example — a country fully surrounding an inner enclave (a hole). ───
// Exercises: a polygon with a hole (ring index 1) plus a SECOND polygon that is
// the enclave itself (a separate state sitting inside the hole). Inspired by
// South Africa ⊃ Lesotho. Proves outer+hole AND a disjoint enclave piece coexist.
const ENCLAVE_EXAMPLE: GeoMultiPolygon = [
  // Surrounding country: outer ring + a hole punched out for the enclave.
  [
    // outer (simplified, concave on the NE)
    [
      c(16.5, -28.5),
      c(20.0, -34.8), // south coast
      c(25.5, -34.0),
      c(31.0, -29.7),
      c(32.0, -26.5), // NE
      c(29.0, -22.1), // N (concave step) ← reflex
      c(25.0, -25.7),
      c(20.0, -25.0),
      c(17.5, -25.0),
    ],
    // hole (the territory removed for the enclave)
    [c(27.0, -28.6), c(29.3, -28.6), c(29.3, -30.6), c(27.0, -30.6)],
  ],
  // The enclave country itself, sitting inside (but disjoint from) the hole.
  [
    [c(27.3, -28.9), c(29.0, -28.9), c(29.0, -30.3), c(27.3, -30.3)],
  ],
];

/** A named entry in the country catalogue. */
export interface CountryShape {
  /** Stable key for table-driven tests / snapshot ids. */
  readonly key: string;
  /** Human label (English). */
  readonly name: string;
  /** Short note on which topological trait this shape exercises. */
  readonly trait: string;
  /** The simplified outline as a domain multi-polygon. */
  readonly shape: GeoMultiPolygon;
}

/** Individual exports for direct, intention-revealing use. */
export { ITALY, CHILE, JAPAN, UK_AND_IRELAND, NORWAY, ENCLAVE_EXAMPLE };

/**
 * The full catalogue, suitable for `it.each` / table-driven property + E2E tests.
 * Covers: concave (Italy), elongated many-vertex (Chile, Norway), multi-polygon
 * (Japan), disjoint outer pieces (UK + Ireland) and a hole + enclave piece.
 */
export const COUNTRY_SHAPES: readonly CountryShape[] = [
  { key: 'italy', name: 'Italy', trait: 'concave (boot) single polygon', shape: ITALY },
  { key: 'chile', name: 'Chile', trait: 'elongated, many-vertex single polygon', shape: CHILE },
  { key: 'japan', name: 'Japan', trait: 'multi-polygon (four disjoint islands)', shape: JAPAN },
  {
    key: 'uk-ireland',
    name: 'United Kingdom & Ireland',
    trait: 'two separated outer polygons',
    shape: UK_AND_IRELAND,
  },
  { key: 'norway', name: 'Norway', trait: 'many-vertex concave (fjord) coastline', shape: NORWAY },
  {
    key: 'enclave',
    name: 'Enclave example',
    trait: 'outer + hole, plus a disjoint enclave piece',
    shape: ENCLAVE_EXAMPLE,
  },
];

/**
 * The first outer ring of a country, as a screen-pixel polygon fitted into a
 * bounding box — convenience for E2E add-flows that click pixel corners (cf.
 * `commitOneFace`, which draws a plain square). Maps the ring's lon/lat extent
 * into [x..x+w] × [y..y+h], FLIPPING latitude so north renders up. Holes and
 * extra polygon pieces are dropped (the live area tool draws one outer ring).
 */
export function outerRingToPixels(
  shape: GeoMultiPolygon,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): ReadonlyArray<readonly [number, number]> {
  const firstPoly = shape[0];
  const ring: GeoRing | undefined = firstPoly?.[0];
  if (ring === undefined || ring.length === 0) return [];
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const lonSpan = maxLon - minLon || 1;
  const latSpan = maxLat - minLat || 1;
  return ring.map((p): readonly [number, number] => {
    const fx = (p.lon - minLon) / lonSpan;
    const fy = (p.lat - minLat) / latSpan;
    const px = box.x + fx * box.width;
    const py = box.y + (1 - fy) * box.height; // flip: north = up
    return [px, py];
  });
}
