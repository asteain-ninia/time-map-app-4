// Focused unit test for `unwrapClosedLonSequence` (U04) — added alongside the O(n²)→
// O(n) rotation-search optimisation (the derle 99k-vertex world's cold display
// resolution was ~15 s, dominated by this per-ring closed unwrap; it is now ~120 ms).
//
// The closed unwrap previously had NO direct test (only indirect coverage through the
// seam property suite). This file LOCKS the optimisation two ways:
//   1. BEHAVIOUR IS UNCHANGED — the fast path is byte-for-byte identical to a
//      brute-force reference that re-implements the original O(n²) "unwrap every
//      rotation, keep the smallest-span one" search. A deterministic fuzz battery
//      reaching the pathological seam inputs (multi-turn, near-antipodal, crossings)
//      proves the two agree on every ring, so the speed-up cannot have changed any
//      drawn / hit-tested geometry.
//   2. COMPLEXITY IS LINEAR — a 20,000-vertex ring resolves near-instantly; the old
//      O(n²) search would take multiple seconds. A very generous wall-clock bound is
//      a coarse regression tripwire for an accidental return to the quadratic search,
//      not a perf benchmark (the repo does not CI-assert wall-clock — see
//      derle-benchmark.test.ts — so the bound is 100× the observed cost).
//
// The continuity / minimal-span INVARIANTS the closed unwrap must satisfy are already
// pinned by src/domain/__seam__/seam.property.test.ts (unwrapRingClosed); we add the
// direct behaviour + complexity locks here.
//
// ADVERSARIAL-REVIEW ADDITIONS (Codex, post-optimisation): (i) an EXTREME-longitude
// fallback lock — beyond CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD (far outside the
// persisted-coordinate contract ±MAX_COORDINATE_MAGNITUDE ≈ 9.0072e8°) the O(n)
// prefix-sum span search can select a different rotation than the old search, whose
// spans were measured AFTER unwrapping at a huge absolute value (large-magnitude
// rounding + clampGapToStep included) — production therefore routes such input to the
// exhaustive search and must match the reference byte-for-byte (the 1e18
// counterexample); (ii) a CONTRACT-INTERIOR large-base fuzz asserting INVARIANTS
// (whole-turn congruence / continuity / span minimality within epsilon) rather than
// byte equality, because at |lon| ~ 9e8 the two span measurements can differ by
// accumulated ULPs and a near-tie could in theory flip to a whole-turn-equivalent
// rotation; (iii) exact ±180-delta rings pinning the shortest-delta tie-break
// convention (the (-180, 180] canonical +180 sign) against the reference.

import { describe, expect, it } from 'vitest';

import { MAX_COORDINATE_MAGNITUDE } from '../coordinate';
import {
  CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD,
  shortestLonDeltaDeg,
  unwrapClosedLonSequence,
  unwrapLonSequence,
} from './longitude';

// Span improvements below this keep the earliest rotation — must match longitude.ts.
const SPAN_EPSILON = 1e-6;

/**
 * Brute-force reference: a verbatim re-implementation of the ORIGINAL O(n²) closed
 * unwrap (run `unwrapLonSequence` for every rotation, keep the smallest-span one, then
 * un-rotate). The optimised production function must equal this byte-for-byte.
 */
function referenceClosed(lons: readonly number[]): number[] {
  const n = lons.length;
  if (n < 3) return unwrapLonSequence(lons);
  let bestStart = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  let bestRun: number[] | undefined;
  for (let start = 0; start < n; start += 1) {
    const rotated: number[] = [];
    for (let k = 0; k < n; k += 1) rotated.push(lons[(start + k) % n]!);
    const run = unwrapLonSequence(rotated);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const v of run) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min;
    if (span < bestSpan - SPAN_EPSILON) {
      bestSpan = span;
      bestStart = start;
      bestRun = run;
    }
  }
  if (bestRun === undefined) return unwrapLonSequence(lons);
  const out: number[] = new Array<number>(n);
  for (let k = 0; k < n; k += 1) out[(bestStart + k) % n] = bestRun[k]!;
  return out;
}

/** Deterministic LCG (no Math.random) so the fuzz battery is reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Max adjacent longitude gap over ALL edges, the closing edge (last→first) included. */
function maxClosedGap(run: readonly number[]): number {
  const n = run.length;
  if (n < 2) return 0;
  let max = 0;
  for (let i = 0; i < n; i += 1) {
    const gap = Math.abs(run[(i + 1) % n]! - run[i]!);
    if (gap > max) max = gap;
  }
  return max;
}

describe('unwrapClosedLonSequence (O(n) rotation search)', () => {
  it('short rings (< 3) delegate to the open unwrap', () => {
    expect(unwrapClosedLonSequence([])).toEqual([]);
    expect(unwrapClosedLonSequence([170])).toEqual([170]);
    expect(unwrapClosedLonSequence([170, -170])).toEqual(unwrapLonSequence([170, -170]));
  });

  it('is byte-for-byte identical to the O(n²) reference on hand-picked seam rings', () => {
    const cases: number[][] = [
      [0, 120, -120], // simple, no crossing (rotation 0 wins)
      [179, -179, -179, 179], // straddles the seam
      [-179, 179, 179, -179], // same, opposite start side
      [170, 179, -175, -170], // crosses once
      [0, 90, 180, -90], // antipodal step present
      [10, -10, 10, -10, 10], // oscillating near 0
      [150, 210 - 360, 210 - 360, 150], // wide (>60°) straddle stored as reps
      [0, 179.999999, -179.999999, 0], // near-antipodal float spill
    ];
    for (const ring of cases) {
      expect(arraysEqual(unwrapClosedLonSequence(ring), referenceClosed(ring))).toBe(true);
    }
  });

  it('matches the O(n²) reference on 30,000 fuzzed rings (multi-turn / antipodal / crossing)', () => {
    const rng = makeRng(0x0c105ed);
    let mismatches = 0;
    let firstBad = '';
    for (let t = 0; t < 30000; t += 1) {
      const n = 3 + Math.floor(rng() * 48);
      const ring: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const style = Math.floor(rng() * 4);
        if (style === 0) ring.push(rng() * 360 - 180); // representative fold
        else if (style === 1) ring.push(rng() * 1440 - 720); // multi-turn continuous
        else if (style === 2) ring.push((rng() < 0.5 ? 179 : -179) + (rng() - 0.5)); // near seam
        else ring.push(rng() * 40 - 20); // tight cluster near 0
      }
      if (!arraysEqual(unwrapClosedLonSequence(ring), referenceClosed(ring))) {
        mismatches += 1;
        if (firstBad === '') firstBad = JSON.stringify(ring);
      }
    }
    expect({ mismatches, firstBad }).toEqual({ mismatches: 0, firstBad: '' });
  });

  it('pins the exact ±180 shortest-delta tie-break against the reference', () => {
    // An exact ±180° step is genuinely ambiguous (either unwinding direction is 180°
    // apart); `shortestLonDeltaDeg` fixes ONE convention — the (-180, 180] range maps
    // both +180 and -180 raw differences to a canonical +180 step. These rings make
    // that tie-break load-bearing for the rotation search (every rotation's span is
    // built from ±180 steps), so old and new must agree byte-for-byte on them.
    const cases: number[][] = [
      [0, 180, 0],
      [0, -180, 0],
      [180, 0, -180], // both seam representatives present
      [0, 180, 0, -180], // alternating exact-antipodal steps
    ];
    for (const ring of cases) {
      expect(unwrapClosedLonSequence(ring)).toEqual(referenceClosed(ring));
    }
  });

  it('makes a seam-crossing ring continuous across every edge (closing edge included)', () => {
    // A quad straddling the antimeridian, stored as representatives with an unlucky
    // start vertex: the closed unwrap must bound EVERY edge (incl. last→first) by 180°.
    const ring = [-179, 179, 179, -179];
    const run = unwrapClosedLonSequence(ring);
    expect(maxClosedGap(run)).toBeLessThanOrEqual(180 + 1e-6);
  });

  it('keeps the input step magnitudes (no spurious ~360° edge) for a wide straddle', () => {
    const ring = [150, -150, -150, 150]; // 60°-wide straddle stored as representatives
    const run = unwrapClosedLonSequence(ring);
    for (let i = 0; i < run.length; i += 1) {
      const step = Math.abs(shortestLonDeltaDeg(ring[i]!, ring[(i + 1) % run.length]!));
      const gap = Math.abs(run[(i + 1) % run.length]! - run[i]!);
      expect(gap).toBeLessThanOrEqual(step + 1e-6);
    }
  });

  it('resolves a 20,000-vertex ring in linear time (O(n²) regression tripwire)', () => {
    // Build a large simple ring near the seam. The old O(n²) rotation search takes tens
    // of seconds at 20k vertices; the O(n) search is a few ms. The bound is very
    // generous (~500× the observed cost) so a slow CI machine never flakes it, while an
    // accidental return to the quadratic search still trips it by an order of
    // magnitude — a coarse tripwire, NOT a wall-clock perf gate (repo convention).
    const n = 20000;
    const ring: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const ang = (i / n) * 2 * Math.PI;
      ring.push(((180 + 5 * Math.cos(ang) + 180) % 360) - 180); // small loop centred on the seam
    }
    const t0 = performance.now();
    const run = unwrapClosedLonSequence(ring);
    const elapsed = performance.now() - t0;
    expect(run).toHaveLength(n);
    expect(maxClosedGap(run)).toBeLessThanOrEqual(180 + 1e-6);
    expect(elapsed).toBeLessThan(2500);
  });
});

// ---------------------------------------------------------------------------
// Extreme-longitude fallback (Codex adversarial review, HIGH finding).
// ---------------------------------------------------------------------------

describe('unwrapClosedLonSequence extreme-longitude fallback', () => {
  it('the fallback threshold is a named constant beyond 2× the persisted-coordinate bound', () => {
    // The persistence contract (coordinateSchema / createCoordinate) bounds every
    // stored scalar to ±MAX_COORDINATE_MAGNITUDE ≈ 9.0072e8°. The fallback threshold
    // sits comfortably ABOVE that (2^31 ≈ 2.147e9 > 2× the bound), so every
    // contract-interior ring stays on the O(n) fast path — the fallback only ever
    // fires for pathological, contract-exterior input.
    expect(CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD).toBe(2 ** 31);
    expect(CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD).toBeGreaterThan(2 * MAX_COORDINATE_MAGNITUDE);
  });

  it('matches the exhaustive reference beyond the threshold (the 1e18 counterexample)', () => {
    // Codex counterexample: at 1e18 the double ULP is 128, so this ring is stored as
    // [1e18, 1e18+128, 1e18+384]. The OLD search measured each rotation's span AFTER
    // unwrapping at that huge absolute value (accumulation rounding + clampGapToStep
    // included) and picked bestStart=1 (span 0); the O(n) prefix-sum search measures
    // exact small step sums and picks bestStart=0 — different output. Production must
    // detect the extreme magnitude and route to the exhaustive search, reproducing the
    // reference byte-for-byte (契約外は正確性=旧挙動 優先).
    const ring = [1e18, 1e18 + 100, 1e18 + 400];
    expect(unwrapClosedLonSequence(ring)).toEqual(referenceClosed(ring));
  });

  it('matches the reference just above the threshold; agrees with it just below (fast path)', () => {
    // Just ABOVE: the fallback path must equal the reference (it IS the reference
    // algorithm). Just BELOW: the fast path must also equal it — at ~2e9 the prefix-sum
    // vs large-value span measurements still agree far within SPAN_EPSILON.
    const above = CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD * 1.5;
    const ringAbove = [above, above + 40, above + 80, above + 40 - 360];
    expect(unwrapClosedLonSequence(ringAbove)).toEqual(referenceClosed(ringAbove));

    const below = CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD / 2;
    const ringBelow = [below, below + 40, below + 80, below + 40 - 360];
    expect(unwrapClosedLonSequence(ringBelow)).toEqual(referenceClosed(ringBelow));
  });

  it('routes non-finite longitudes to the fallback (same garbage-in behaviour as the old code)', () => {
    // NaN / ±Infinity are contract-exterior garbage; both paths produce meaningless
    // output for them, but the fallback keeps it EXACTLY the old implementation's
    // meaningless output (no new behaviour surface). NaN never satisfies the ≤-guard,
    // so it routes to the fallback; assert agreement structurally (NaN-safe compare).
    const ring = [0, Number.POSITIVE_INFINITY, 0];
    const got = unwrapClosedLonSequence(ring);
    const want = referenceClosed(ring);
    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i += 1) {
      expect(Object.is(got[i], want[i])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract-interior large-base fuzz (Codex adversarial review, LOW finding):
// at |lon| ~ 9e8 the old span measurement accumulates ULP rounding, so a near-tie
// could in theory pick a different (whole-turn-equivalent) rotation than the new
// exact prefix-sum measurement. Byte equality is therefore the WRONG lock here;
// the geometric invariants below are what every consumer actually relies on.
// ---------------------------------------------------------------------------

describe('unwrapClosedLonSequence large-base (contract-interior) invariants', () => {
  it('simple quads at |base| up to the persisted bound keep congruence, continuity and near-minimal span', () => {
    const rng = makeRng(0xb16ba5e);
    const spanOf = (r: readonly number[]): number => {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const v of r) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return hi - lo;
    };
    for (let t = 0; t < 2000; t += 1) {
      // A geometrically simple quad (span < 180°) at a large continuous base, each
      // vertex then INDEPENDENTLY shifted by a whole world turn (the stored-form
      // scatter that makes the rotation search load-bearing at this magnitude).
      const base = (rng() * 2 - 1) * MAX_COORDINATE_MAGNITUDE;
      const halfW = 0.5 + rng() * 80;
      const jitter = (): number => (rng() - 0.5) * 10;
      const corners = [
        base - halfW + jitter(),
        base + halfW + jitter(),
        base + halfW + jitter(),
        base - halfW + jitter(),
      ];
      const start = Math.floor(rng() * 4);
      const ring = corners.map(
        (_, i) => corners[(i + start) % 4]! + (Math.floor(rng() * 3) - 1) * 360,
      );

      const run = unwrapClosedLonSequence(ring);

      // (1) Whole-turn equivalence class: each output is its input shifted by an
      // integral number of ±360° turns (within magnitude-scaled float tolerance —
      // at 9e8 one accumulation ULP is ~2.4e-7°, i.e. ~7e-10 turns).
      for (let i = 0; i < ring.length; i += 1) {
        const turns = (run[i]! - ring[i]!) / 360;
        expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-6);
      }

      // (2) Continuity across EVERY edge, closing edge included (the quad is simple:
      // its true span is < 180°, so no edge of the minimal-span run may jump the seam).
      // Tolerance is magnitude-scaled: a few accumulation ULPs at 9e8.
      expect(maxClosedGap(run)).toBeLessThanOrEqual(180 + 1e-3);

      // (3) Span minimality within epsilon of the exhaustive reference (the two span
      // measurements may differ by accumulated ULPs, never by a ~360° rotation miss).
      expect(spanOf(run)).toBeLessThanOrEqual(spanOf(referenceClosed(ring)) + 1e-3);
    }
  });
});
