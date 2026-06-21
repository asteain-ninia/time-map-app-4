// U10 acceptance tests — terminal-pair exclusion detection (FR-26 / FR-27) and
// the spatial-index candidate narrowing it rides on (NFR 5.1 / 5.2). Each
// `describe` maps to a numbered acceptance criterion in specs/U10.md.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { asFeatureId, type FeatureId } from '../ids';
import type { GeoMultiPolygon, GeoRing } from '../geometry/types';
import {
  detectTerminalOverlaps,
  detectTerminalOverlapsNaive,
  type OverlapPair,
  type PredicateCounter,
  type TerminalShape,
} from './overlap';

// --- helpers ----------------------------------------------------------------

function id(s: string): FeatureId {
  return asFeatureId(s);
}

/** Axis-aligned square as a single-piece multi-polygon (no holes). */
function square(x: number, y: number, size: number): GeoMultiPolygon {
  const ring: GeoRing = [
    createCoordinate(x, y),
    createCoordinate(x + size, y),
    createCoordinate(x + size, y + size),
    createCoordinate(x, y + size),
  ];
  return [[ring]];
}

/** Arbitrary rectangle multi-polygon from explicit corners. */
function rect(x0: number, y0: number, x1: number, y1: number): GeoMultiPolygon {
  const ring: GeoRing = [
    createCoordinate(x0, y0),
    createCoordinate(x1, y0),
    createCoordinate(x1, y1),
    createCoordinate(x0, y1),
  ];
  return [[ring]];
}

function term(name: string, shape: GeoMultiPolygon): TerminalShape {
  return { id: id(name), shape };
}

/** Set of normalised "a|b" pair keys from a result list, for order-free compare. */
function pairKeys(pairs: readonly OverlapPair[]): Set<string> {
  return new Set(pairs.map((p) => `${p.a}|${p.b}`));
}

// Single-turn options isolate non-seam behaviour from the ±360° machinery.
const NO_SEAM = { seamTurns: [0] as const };

// --- criterion 1: only terminals are indexed / tested -----------------------
//
// FR-27 / 教訓5.25. The detector's input is the TERMINAL list by construction —
// aggregates are excluded upstream (terminals.ts). These tests fix that an
// aggregate-shaped area placed among terminals, when NOT in the list, never
// appears in a pair, and is covered more fully by terminals.test.ts.

describe('criterion 1: aggregate areas are not exclusion targets', () => {
  it('a shape identical to an aggregate area does not appear when absent from the input', () => {
    // Two terminals that overlap each other; a third "aggregate-like" area that
    // would overlap both is simply not provided as a terminal.
    const terminals = [term('A', square(0, 0, 10)), term('B', square(5, 5, 10))];
    const pairs = detectTerminalOverlaps(terminals, NO_SEAM);
    expect(pairKeys(pairs)).toEqual(new Set(['A|B']));
    // No id other than A / B can appear.
    for (const p of pairs) {
      expect([p.a, p.b]).toEqual(expect.arrayContaining([id('A'), id('B')]));
    }
  });

  it('empty-shape terminals (points/lines resolved to no area) are ignored', () => {
    const terminals = [term('A', square(0, 0, 10)), term('EMPTY', [])];
    const pairs = detectTerminalOverlaps(terminals, NO_SEAM);
    expect(pairs).toHaveLength(0);
  });
});

// --- criterion 2: overlap detected, boundary contact excluded ---------------

describe('criterion 2: positive-area overlap vs boundary contact (FR-26)', () => {
  it('reports a positive-area overlap', () => {
    const pairs = detectTerminalOverlaps(
      [term('A', square(0, 0, 10)), term('B', square(5, 0, 10))],
      NO_SEAM,
    );
    expect(pairKeys(pairs)).toEqual(new Set(['A|B']));
    expect(pairs[0]!.overlap.length).toBeGreaterThan(0);
  });

  it('does NOT report two squares sharing only an edge', () => {
    // B sits exactly to the right of A; they share the x=10 edge, zero overlap area.
    const pairs = detectTerminalOverlaps(
      [term('A', square(0, 0, 10)), term('B', square(10, 0, 10))],
      NO_SEAM,
    );
    expect(pairs).toHaveLength(0);
  });

  it('does NOT report two squares sharing only a single corner vertex', () => {
    // B touches A only at the corner (10,10).
    const pairs = detectTerminalOverlaps(
      [term('A', square(0, 0, 10)), term('B', square(10, 10, 10))],
      NO_SEAM,
    );
    expect(pairs).toHaveLength(0);
  });

  it('does NOT report neighbours that share a full boundary segment (linked edge)', () => {
    // A = left half, B = right half of a 20-wide strip; shared boundary at x=10.
    const pairs = detectTerminalOverlaps(
      [term('A', rect(0, 0, 10, 10)), term('B', rect(10, 0, 20, 10))],
      NO_SEAM,
    );
    expect(pairs).toHaveLength(0);
  });
});

// --- criterion 3: O(n²) avoided / narrowing is lossless ---------------------

describe('criterion 3: candidate narrowing avoids O(n^2) and loses nothing', () => {
  it('predicate calls stay well below N(N-1)/2 for spread-out non-overlapping terminals', () => {
    const n = 40;
    const terminals: TerminalShape[] = [];
    // Grid of far-apart unit squares: none overlap, none are near neighbours.
    for (let i = 0; i < n; i += 1) {
      terminals.push(term(`F${i}`, square(i * 1000, 0, 1)));
    }
    const counter: PredicateCounter = { count: 0 };
    const pairs = detectTerminalOverlaps(terminals, { ...NO_SEAM, counter });
    expect(pairs).toHaveLength(0);
    const allPairs = (n * (n - 1)) / 2;
    // Narrowing must keep predicate calls far below the all-pairs count.
    expect(counter.count).toBeLessThan(allPairs);
    expect(counter.count).toBeLessThanOrEqual(n); // O(n)-ish for a sparse layout.
  });

  it('indexed result matches the naive all-pairs reference (property)', () => {
    const coord = fc.record({
      x: fc.integer({ min: 0, max: 60 }),
      y: fc.integer({ min: 0, max: 60 }),
      s: fc.integer({ min: 1, max: 20 }),
    });
    fc.assert(
      fc.property(fc.array(coord, { minLength: 0, maxLength: 8 }), (boxes) => {
        const terminals = boxes.map((b, i) => term(`T${i}`, square(b.x, b.y, b.s)));
        const indexed = pairKeys(detectTerminalOverlaps(terminals, NO_SEAM));
        const naive = pairKeys(detectTerminalOverlapsNaive(terminals, NO_SEAM));
        expect(indexed).toEqual(naive);
      }),
      { numRuns: 200 },
    );
  });

  // Stronger invariant (bughunt2): the indexed detector must match the naïve
  // reference in OVERLAP GEOMETRY, not merely in which pairs exist — and it must
  // hold WITH the ±360° seam machinery on, where a pair can overlap at more than
  // one turn. Multi-piece features scattered around the globe (incl. both seams)
  // generate exactly the multi-turn-per-pair case the per-pair short-circuit used
  // to drop. We compare total overlap vertex counts per pair (a piece dropped =>
  // fewer vertices), the property the old pairKeys/NO_SEAM test could not see.
  it('indexed overlap GEOMETRY matches the naive reference with seams on (property)', () => {
    // Sum of all ring vertex counts across a multi-polygon.
    const vtx = (mp: GeoMultiPolygon): number => {
      let n = 0;
      for (const poly of mp) for (const ring of poly) n += ring.length;
      return n;
    };
    const piece = fc.record({
      x: fc.integer({ min: -200, max: 200 }),
      y: fc.integer({ min: 0, max: 40 }),
      w: fc.integer({ min: 1, max: 40 }),
      h: fc.integer({ min: 1, max: 40 }),
    });
    const feature = fc.array(piece, { minLength: 1, maxLength: 3 });
    fc.assert(
      fc.property(fc.array(feature, { minLength: 0, maxLength: 5 }), (feats) => {
        const terminals = feats.map((pcs, i) =>
          term(
            `T${i}`,
            // One feature = several rectangle pieces (one multi-polygon).
            pcs.map((p) => rect(p.x, p.y, p.x + p.w, p.y + p.h)[0]!),
          ),
        );
        // Default seam turns ({-1,0,+1}) — exercise the ±360° replica path.
        const indexed = detectTerminalOverlaps(terminals);
        const naive = detectTerminalOverlapsNaive(terminals);
        const indexedByKey = new Map(indexed.map((p) => [`${p.a}|${p.b}`, p]));
        const naiveByKey = new Map(naive.map((p) => [`${p.a}|${p.b}`, p]));
        // Same set of pairs.
        expect([...indexedByKey.keys()].sort()).toEqual([...naiveByKey.keys()].sort());
        // Same overlap area per pair (every seam-turn piece present, no 片落とし).
        for (const [key, naivePair] of naiveByKey) {
          const indexedPair = indexedByKey.get(key)!;
          expect(vtx(indexedPair.overlap)).toBe(vtx(naivePair.overlap));
        }
      }),
      { numRuns: 400 },
    );
  });
});

// --- criterion 4: world-seam crossing pairs ---------------------------------

describe('criterion 4: seam-crossing overlap (U05)', () => {
  it('detects an east-edge terminal overlapping a west-edge terminal across the seam', () => {
    // A spans [175, 185) in continuous longitude (crosses +180). B sits near
    // −180 at [-183, -177). One world turn (+360) maps B to [177, 183), which
    // overlaps A. Without seam replication this pair would be missed.
    const a = rect(175, 0, 185, 10);
    const b = rect(-183, 0, -177, 10);
    const pairs = detectTerminalOverlaps([term('EAST', a), term('WEST', b)]);
    expect(pairKeys(pairs)).toEqual(new Set(['EAST|WEST']));
  });

  it('does NOT report seam-near terminals that stay apart after wrapping', () => {
    // A near +180 at [170, 175]; B near −180 at [-175, -170] => wraps to
    // [185, 190], which does not reach A. No false positive.
    const a = rect(170, 0, 175, 10);
    const b = rect(-175, 0, -170, 10);
    const pairs = detectTerminalOverlaps([term('EAST', a), term('WEST', b)]);
    expect(pairs).toHaveLength(0);
  });

  it('never reports a feature as overlapping its own ±360° replica', () => {
    // A single wide terminal whose replicas are tested but must not self-report.
    const a = rect(-10, 0, 10, 10);
    const pairs = detectTerminalOverlaps([term('ONLY', a)]);
    expect(pairs).toHaveLength(0);
  });

  // M6 root fix: a SINGLE seam-crossing leaf stored in FOLDED representative form —
  // its ring jumps 179 → −179 INSIDE the ring. Read verbatim its bbox spans the
  // wrong way round the world (~358°, [−179, 179]); a far-away Greenwich terminal
  // then falls inside that phantom box and the boolean op on the backwards ring can
  // report a spurious overlap. With seam-continuity normalization the folded ring
  // becomes its true ~2°-wide self near the antimeridian and the two are disjoint.
  it('does NOT report a folded seam-crossing leaf as overlapping a distant Greenwich terminal (no phantom 358° bbox)', () => {
    // Folded representative of a ~2°-wide quad straddling +180: 179 → −179 inside.
    const folded: GeoMultiPolygon = [
      [
        [
          createCoordinate(179, 0),
          createCoordinate(-179, 0),
          createCoordinate(-179, 10),
          createCoordinate(179, 10),
        ],
      ],
    ];
    const greenwich = rect(-1, 2, 1, 8); // small quad at the prime meridian.
    const pairs = detectTerminalOverlaps([term('SEAM', folded), term('GREENWICH', greenwich)]);
    expect(pairs).toHaveLength(0);
    // The naive reference must agree (narrowing correctness holds on this input too).
    const naive = detectTerminalOverlapsNaive([term('SEAM', folded), term('GREENWICH', greenwich)]);
    expect(naive).toHaveLength(0);
  });

  it('DOES detect two folded seam-crossing leaves that genuinely overlap near the antimeridian', () => {
    // Both stored folded near +180; geometrically they overlap at the seam.
    const a: GeoMultiPolygon = [
      [
        [
          createCoordinate(178, 0),
          createCoordinate(-179, 0),
          createCoordinate(-179, 10),
          createCoordinate(178, 10),
        ],
      ],
    ];
    const b: GeoMultiPolygon = [
      [
        [
          createCoordinate(179, 2),
          createCoordinate(-178, 2),
          createCoordinate(-178, 8),
          createCoordinate(179, 8),
        ],
      ],
    ];
    const pairs = detectTerminalOverlaps([term('A', a), term('B', b)]);
    expect(pairKeys(pairs)).toEqual(new Set(['A|B']));
  });
});

// --- criterion 7: multiple pairs / multiple pieces, nothing dropped ---------

describe('criterion 7: multiple overlaps and multiple pieces (教訓5.1)', () => {
  it('reports every pair when one terminal overlaps several others', () => {
    // Center C overlaps L, R and T; L/R/T are mutually disjoint.
    const c = square(0, 0, 10);
    const l = square(-5, 0, 10); // overlaps C on the left
    const r = square(5, 0, 10); // overlaps C on the right
    const t = square(0, 5, 10); // overlaps C on the top
    const pairs = detectTerminalOverlaps(
      [term('C', c), term('L', l), term('R', r), term('T', t)],
      NO_SEAM,
    );
    const keys = pairKeys(pairs);
    expect(keys.has('C|L')).toBe(true);
    expect(keys.has('C|R')).toBe(true);
    expect(keys.has('C|T')).toBe(true);
  });

  it('keeps all pieces when an overlap splits into disjoint regions', () => {
    // A is a big rectangle. B is a "bridge" shaped as TWO separate squares that
    // each poke into A from outside, so A∩B is two disjoint pieces.
    const a = rect(0, 0, 30, 10);
    // B: two squares as two polygon pieces of one multi-polygon.
    const pieceLeft: GeoRing = [
      createCoordinate(5, -5),
      createCoordinate(10, -5),
      createCoordinate(10, 5),
      createCoordinate(5, 5),
    ];
    const pieceRight: GeoRing = [
      createCoordinate(20, -5),
      createCoordinate(25, -5),
      createCoordinate(25, 5),
      createCoordinate(20, 5),
    ];
    const b: GeoMultiPolygon = [[pieceLeft], [pieceRight]];
    const pairs = detectTerminalOverlaps([term('A', a), term('B', b)], NO_SEAM);
    expect(pairKeys(pairs)).toEqual(new Set(['A|B']));
    // The overlap must carry BOTH pieces, not just the first (片落とし禁止).
    expect(pairs[0]!.overlap.length).toBe(2);
  });
});

// --- criterion 3 (geometry): seam multi-turn overlap accumulates every piece -
//
// Regression (bughunt2): a single unordered pair (A,B) can genuinely overlap at
// TWO DIFFERENT seam turns at once when each feature owns several pieces scattered
// across the globe — e.g. A's piece near lon 0 overlaps B's piece near lon 0 at
// turn 0, while A's piece near lon −90 overlaps a far-east piece of B at turn +1
// (−90 + 360 = 270). Seam-continuity alignment keeps those pieces a full world
// turn apart, so BOTH turns produce positive area for the same pair.
//
// The indexed detector previously short-circuited per pair on the FIRST found
// piece (`if (reported.has(key)) continue;` then `reported.set(...)` once) and
// never revisited the pair, dropping the other turn's piece (片落とし). Its
// OverlapPair.overlap was therefore MISSING area relative to the naïve reference,
// which loops every seamTurn and ACCUMULATES all pieces (受け入れ基準3「取りこぼさ
// ない」/ 教訓5.1, and the documented contract overlap.ts:50-58 that a reported
// pair carries the FULL overlap area). The fix accumulates pieces across all
// placements of the pair, so indexed geometry now equals the naïve reference —
// not just the same pair KEY, the same area.

describe('criterion 3 (geometry): a pair overlapping at two seam turns keeps both pieces', () => {
  // Sum of all ring vertex counts (a stable proxy for "all pieces are present":
  // dropping a seam piece drops its ring's vertices).
  function totalVertices(mp: GeoMultiPolygon): number {
    let n = 0;
    for (const poly of mp) for (const ring of poly) n += ring.length;
    return n;
  }

  /** Multi-polygon from explicit pieces, each a [x0,y0,x1,y1] rectangle. */
  function pieces(...boxes: readonly [number, number, number, number][]): GeoMultiPolygon {
    return boxes.map(([x0, y0, x1, y1]) => rect(x0, y0, x1, y1)[0]!);
  }

  it('indexed overlap geometry equals the naive reference when a pair overlaps at two turns', () => {
    // Minimal counterexample (shrunk from the seam geometry property below) that
    // reliably defeated the pre-fix per-pair short-circuit:
    //   A: a piece near lon −90 and a piece near the prime meridian.
    //   B: a wide piece near lon 70..86, a piece near the prime meridian, and a
    //      piece near lon −115..−89.
    // A's [0,1] piece overlaps B's [0,1] piece at turn 0; A's [−90,−89] piece
    // overlaps B's [−115,−89] piece one world turn over (the seam-replica path).
    // Two distinct turns => two distinct overlap pieces for the single pair (A,B).
    const a = pieces([-90, 0, -89, 1], [0, 0, 1, 1]);
    const b = pieces([70, 0, 86, 1], [0, 0, 1, 1], [-115, 0, -89, 1]);
    const terminals = [term('A', a), term('B', b)];

    const indexed = detectTerminalOverlaps(terminals);
    const naive = detectTerminalOverlapsNaive(terminals);

    // Both detect the single unordered pair.
    expect(pairKeys(indexed)).toEqual(new Set(['A|B']));
    expect(pairKeys(naive)).toEqual(pairKeys(indexed));

    const indexedPair = indexed[0]!;
    const naivePair = naive[0]!;

    // Guard: the naïve reference must actually produce TWO pieces here, proving
    // this input exercises the multi-turn path. If alignment ever collapses it to
    // one piece, this test would otherwise pass vacuously.
    expect(naivePair.overlap.length).toBe(2);

    // The fix: the indexed detector carries the SAME pieces and the SAME total
    // geometry as the naïve accumulation — no 片落とし. (Pre-fix this was 1 piece /
    // 4 vertices vs the naïve 2 pieces / 8 vertices.)
    expect(indexedPair.overlap.length).toBe(naivePair.overlap.length);
    expect(totalVertices(indexedPair.overlap)).toBe(totalVertices(naivePair.overlap));
    expect(totalVertices(indexedPair.overlap)).toBe(8);
  });
});

// --- pair de-duplication ----------------------------------------------------

describe('pair de-duplication: A,B reported once in normalised order', () => {
  it('reports a single normalised pair regardless of input order', () => {
    const forward = detectTerminalOverlaps(
      [term('B', square(5, 0, 10)), term('A', square(0, 0, 10))],
      NO_SEAM,
    );
    expect(forward).toHaveLength(1);
    const p = forward[0]!;
    // Normalised: smaller id string first.
    expect(p.a).toBe(id('A'));
    expect(p.b).toBe(id('B'));
  });
});

// --- determinism ------------------------------------------------------------

describe('purity: same input yields same output', () => {
  it('is deterministic across repeated calls', () => {
    const terminals = [
      term('A', square(0, 0, 10)),
      term('B', square(5, 0, 10)),
      term('C', square(100, 100, 10)),
    ];
    const first = pairKeys(detectTerminalOverlaps(terminals, NO_SEAM));
    const second = pairKeys(detectTerminalOverlaps(terminals, NO_SEAM));
    expect(first).toEqual(second);
  });
});

// Reference: confirm helpers compile-use WorldCoordinate (silences unused import
// drift if helpers change shape).
const _coordTypeCheck: WorldCoordinate = createCoordinate(0, 0);
void _coordTypeCheck;
