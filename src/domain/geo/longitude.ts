// World-seam (±360°) longitude handling — the single source of truth for this
// unit (U04). Tech policy R3 / FR-07 / FR-14: an infinite horizontal scroll and
// longitude shifts must never split a measurement that crosses the antimeridian.
//
// U03's WorldCoordinate deliberately keeps longitude as a *continuous* scalar
// and does NOT normalize on construction (see coordinate.ts). U03 ships no
// periodic-seam normalization helper (verified by source inspection: only a
// comment in coordinate.ts references 360, no function). Per spec §3 / §4.4 we
// therefore implement the normalization here, fix it with tests, and make it the
// single source consumed by every distance / length / area function below.
//
// Two operations are provided and kept distinct:
//   - wrapLonDeg: fold an arbitrary scalar longitude into the base range
//     [-180, 180). Used to make inputs consistent regardless of how many turns
//     they carry (e.g. +540 -> +180-fold).
//   - shortestLonDeltaDeg: the signed minimal longitude difference in (-180,
//     180]. Used for 2-point / segment distance so an east-edge <-> west-edge
//     pair takes the short way round, never the naive 359° detour.
//
// Pure: no side effects, no globals, no Math.random / clock.

const FULL_TURN = 360;
const HALF_TURN = 180;

/**
 * Fold an arbitrary (continuous) longitude scalar into the base range
 * [-180, 180). The boundary convention is fixed once here: exactly +180 folds to
 * -180, and -180 stays -180, so the half-open range [-180, 180) is consistent
 * across every consumer.
 */
export function wrapLonDeg(lon: number): number {
  // ((lon + 180) mod 360) - 180, with a positive modulo so negatives fold
  // correctly. Math's % keeps the sign of the dividend, hence the extra fold.
  const shifted = ((lon + HALF_TURN) % FULL_TURN + FULL_TURN) % FULL_TURN;
  return shifted - HALF_TURN;
}

/**
 * Signed minimal longitude difference `b - a`, normalized to (-180, 180].
 *
 * This is the short-way-round difference: two points either side of the seam
 * (e.g. +179 and -179) yield ±2°, never ∓358°. The result range is half-open at
 * the negative end so a perfect 180° separation is reported as +180 (a single,
 * stable choice rather than an undefined ±180 flip).
 */
export function shortestLonDeltaDeg(lonA: number, lonB: number): number {
  const raw = lonB - lonA;
  // Fold into (-180, 180]: take wrapLonDeg's [-180, 180) then map the -180 case
  // to +180 so the seam difference has one canonical sign.
  const folded = wrapLonDeg(raw);
  return folded === -HALF_TURN ? HALF_TURN : folded;
}

/**
 * Unwrap a sequence of longitudes into a *continuous* run: each longitude is
 * placed so that its step from the previous one is the shortest signed delta.
 * This lets a ring or path that crosses the seam be treated as one continuous
 * polygon / line for shoelace area and length, rather than springing back when
 * it passes ±180.
 *
 * This is the single source of truth for ±360° turn-counting unwrap in the
 * domain (技術方針 R3 / 単一真実源). Ring-level unwrap (`seam.unwrapRing`)
 * delegates here rather than re-deriving the rule, so any fix lives in one place.
 *
 * The first element is kept as given (the absolute base is irrelevant to the
 * shape's area / length, which depend only on differences). Lesson 5.18: an
 * empty input is a true value, returned as an empty array — never short-circuit
 * defaulted.
 *
 * Float discipline (技術方針 R2): each element is placed at
 * `previousUnwrapped + shortestLonDeltaDeg(prev, lon)`. The step is the canonical
 * shortest delta, whose magnitude is bounded at exactly 180° (the antipodal
 * floor). The earlier `lon + turns * 360` formulation is intentionally NOT used:
 * a near-antipodal pair whose raw difference is e.g. -179.99999999999997 has a
 * canonical shortest delta of exactly +180 (the seam's -180→+180 sign
 * convention), yet `lon + 1 * 360` re-adds the float residue
 * (-179.99999999999997 + 360 = 180.00000000000003), spilling the adjacent gap
 * past 180 and breaking the continuity invariant.
 *
 * Adding the clamped step to the running unwrapped value is *necessary but not
 * sufficient* on its own: the addition `prevUnwrapped + step` rounds to the
 * nearest double, and the realised gap `unwrapped - prevUnwrapped` is then NOT
 * generally equal to `step` (subtracting back is not exact when the two operands
 * sit at different binary exponents). Concretely, for the ring [ε, -180, 0] the
 * second vertex lands at 179.99999999999997 and the third at
 * 179.99999999999997 + 180, which rounds *up* to 360, so the measured gap is
 * 360 - 179.99999999999997 = 180.00000000000003 — over the bound by 1 ULP. The
 * geometric step is genuinely ≤ 180; the excess is pure rounding. We therefore
 * snap the accumulated value back toward `prevUnwrapped` by the few ULPs needed
 * to make the realised gap honour the |step| ≤ 180 bound (see {@link clampGapToStep}).
 * The correction is sub-ULP at the value's scale, so it does not perturb the
 * shoelace area/length consumers (which depend only on differences) — it only
 * removes the spurious >180 spill the continuity invariant forbids.
 */
export function unwrapLonSequence(lons: readonly number[]): number[] {
  const out: number[] = [];
  let prevRaw: number | undefined;
  let prevUnwrapped = 0;
  for (const lon of lons) {
    if (prevRaw === undefined) {
      out.push(lon);
      prevRaw = lon;
      prevUnwrapped = lon;
      continue;
    }
    // The continuous step equals the canonical shortest signed delta, whose
    // magnitude is clamped to ≤ 180 by shortestLonDeltaDeg.
    const step = shortestLonDeltaDeg(prevRaw, lon);
    // Correct the float-rounding spill so the realised adjacent gap never exceeds
    // |step| (and therefore never exceeds 180): see clampGapToStep.
    const unwrapped = clampGapToStep(prevUnwrapped, prevUnwrapped + step, Math.abs(step));
    out.push(unwrapped);
    prevRaw = lon;
    prevUnwrapped = unwrapped;
  }
  return out;
}

/**
 * Unwrap a CLOSED ring of longitudes into the continuous run with the SMALLEST
 * longitude span (max − min), making the implicit closing edge (last → first) as
 * continuous as the input topology allows — the start-vertex independence
 * {@link unwrapLonSequence} cannot give on its own (audit root cause B).
 *
 * WHY a separate closed variant (技術方針 R3 / 単一真実源): {@link unwrapLonSequence}
 * anchors the run at the FIRST element and never sees the closing edge. For a SIMPLE
 * (net-winding-zero) ring whose first vertex is not at the seam crossing, the open
 * unwrap can push the crossing into the closing edge and inflate the run's span by a
 * full turn, so a consumer that closes the ring (shoelace area, polygon clipping,
 * bbox) reads a false ~360° horizontal extent and mis-builds the shape. This variant
 * does NOT re-implement the ±360° step rule (that stays in `shortestLonDeltaDeg`): it
 * picks the ROTATION of the cyclic vertex list whose forward unwrap minimizes the
 * span — the rotation that does NOT absorb the crossing into its closing edge — then
 * un-rotates the values back to the original vertex order.
 *
 * SCOPE / HONEST LIMIT (Codex root-cause review #1): for a SIMPLE ring (the sum of
 * cyclic shortest-deltas is ~0) every rotation lifts to the SAME planar polygon up to
 * a whole-turn translation, so the minimal-span rotation is genuinely continuous as a
 * cycle. For a ring with NONZERO net winding (it truly circles a pole; the cyclic
 * shortest-deltas sum to a nonzero multiple of 360°) NO unwrap can make every edge
 * ≤ 180° — that winding is intrinsic and must show up on SOME edge. This variant then
 * just relocates the unavoidable winding to the minimal-span placement; it does not
 * (and cannot) erase it. Such pole-encircling rings are out of the editor's domain
 * (a face is a bounded simple polygon), so minimal-span is the correct, stable choice
 * for every input the geometry pipeline actually produces.
 *
 * VALID DOMAIN (契約, Codex adversarial review): every longitude the domain can
 * legitimately hand this function is bounded by the persisted-coordinate contract —
 * `coordinateSchema` / `createCoordinate` both reject |scalar| >
 * MAX_COORDINATE_MAGNITUDE ≈ 9.0072e8° (domain/coordinate.ts), so contract-interior
 * input is always far below {@link CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD}. Within that
 * contract, the O(n) prefix-sum span measurement below and the old per-rotation
 * measurement differ only by the OLD implementation's own accumulation rounding
 * (a few ULPs at ≤ 9e8 — orders of magnitude under SPAN_EPSILON), and the prefix-sum
 * measurement is the numerically BETTER-conditioned of the two (a sum of small
 * bounded deltas vs accumulation at large absolute value). If a near-tie were ever
 * decided differently, competing minimal-span rotations of a simple ring are
 * whole-turn equivalent, and the caller (`seam.unwrapRingClosed`) re-anchors the run
 * by whole turns anyway — the final geometry is unaffected. Contract-EXTERIOR input
 * (|lon| beyond the threshold, or non-finite) instead falls back to the exhaustive
 * search so the output stays exactly the pre-optimisation behaviour (正確性優先;
 * see {@link CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD}).
 *
 * Degenerate rings (< 3 elements have no closing edge distinct from the open run)
 * delegate straight to {@link unwrapLonSequence}. Pure; input never mutated.
 */
export function unwrapClosedLonSequence(lons: readonly number[]): number[] {
  const n = lons.length;
  if (n < 3) return unwrapLonSequence(lons);

  // DEFENSIVE FALLBACK (Codex HIGH finding): at extreme magnitudes (e.g. 1e18, where
  // one double ULP is 128°) the old search — which measured spans AFTER unwrapping at
  // the large absolute value, clampGapToStep included — can select a different
  // rotation than the exact small prefix sums below, changing the output. Such input
  // is far outside the persistence contract (±MAX_COORDINATE_MAGNITUDE ≈ 9.0072e8),
  // so rather than perturb contract-interior performance we route it to the verbatim
  // pre-optimisation O(n²) search. `!(|v| <= T)` also catches NaN / ±Infinity, so
  // every pathological ring reproduces the old code's output exactly.
  for (const lon of lons) {
    if (!(Math.abs(lon) <= CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD)) {
      return closedUnwrapExhaustiveSearch(lons);
    }
  }

  // Find the rotation whose continuous run has the smallest span (max − min). For a
  // simple ring the minimal-span rotation is the one whose closing edge is NOT a seam
  // jump (a crossing absorbed into an interior edge stays bounded by the shortest-delta
  // rule; absorbed into the closing edge it inflates the span by a full turn). Ties
  // (already-continuous rings) keep the earliest rotation, so rotation 0 — i.e. plain
  // unwrapLonSequence order — wins when nothing crosses.
  //
  // PERF (O(n²) → O(n), derle 99k-vertex world): the previous implementation ran a
  // full `unwrapLonSequence` (+ min/max scan) for EVERY one of the n rotations, so a
  // single ring cost O(n²) — and this runs per ring in the display-resolution unwrap
  // (`geo/seam.unwrapRingClosed` via `alignMultiPolygon`), which dominated the cold
  // display-resolution time (a 9,661-vertex ring alone is ~93M ops). We instead
  // observe that the continuous run for rotation `s` is the prefix sum of the CYCLIC
  // shortest-delta step sequence started at `s`: with `P` the running prefix sum over
  // the doubled step sequence, run value at position k is `P[s+k] − P[s]`, so
  //   span(s) = max_{m∈[s, s+n-1]} P[m] − min_{m∈[s, s+n-1]} P[m]
  // (the −P[s] cancels). All n windows' max and min come from ONE monotonic-deque
  // sliding-window pass — O(n) total. Only the CHOSEN rotation is then materialised
  // via the SAME `unwrapLonSequence` the old loop used, so the returned run is
  // byte-for-byte what the previous implementation produced (the span search is the
  // only thing that changed). Within the contract-bounded domain (see header + the
  // fallback above) the span computed from raw step prefix sums differs from the old
  // per-rotation `unwrapLonSequence` span by at most accumulated-rounding ULPs
  // (≪ SPAN_EPSILON = 1e-6, itself ≪ a seam crossing's ~360° span gap), so the same
  // rotation is selected; a would-be near-tie is anyway whole-turn-equivalent for the
  // simple rings this handles and re-anchored identically by the caller.
  const steps = 2 * n - 1;
  const prefix = new Array<number>(steps);
  prefix[0] = 0;
  for (let m = 1; m < steps; m += 1) {
    const i = (m - 1) % n;
    prefix[m] = prefix[m - 1]! + shortestLonDeltaDeg(lons[i]!, lons[(i + 1) % n]!);
  }
  const winMax = slidingWindowExtrema(prefix, n, true);
  const winMin = slidingWindowExtrema(prefix, n, false);

  let bestStart = 0;
  let bestSpan = winMax[0]! - winMin[0]!;
  for (let s = 1; s < n; s += 1) {
    const span = winMax[s]! - winMin[s]!;
    if (span < bestSpan - SPAN_EPSILON) {
      bestSpan = span;
      bestStart = s;
    }
  }

  // Materialise the winning rotation and un-rotate: place each unwrapped value back at
  // its original index. For a simple ring the run is continuous as a cycle, so rotating
  // the array of values back to original order keeps every edge (the original closing
  // edge included) within the shortest-delta bound; for a winding ring the (intrinsic)
  // winding edge is simply carried to its minimal-span position.
  const rotated = new Array<number>(n);
  for (let k = 0; k < n; k += 1) rotated[k] = lons[(bestStart + k) % n]!;
  const bestRun = unwrapLonSequence(rotated);
  const out = new Array<number>(n);
  for (let k = 0; k < n; k += 1) {
    out[(bestStart + k) % n] = bestRun[k]!;
  }
  return out;
}

/**
 * Longitude magnitude (degrees) above which {@link unwrapClosedLonSequence} abandons
 * the O(n) prefix-sum rotation search and falls back to the exhaustive O(n²) search
 * (the verbatim pre-optimisation algorithm), so contract-EXTERIOR input reproduces
 * the old output exactly (Codex adversarial review, HIGH finding: at e.g. 1e18 the
 * two span measurements can select different rotations).
 *
 * 2^31 ≈ 2.147e9° — more than DOUBLE the persisted-coordinate contract bound
 * (`MAX_COORDINATE_MAGNITUDE` ≈ 9.0072e8°, enforced by both `createCoordinate` and
 * `coordinateSchema`), so no ring the domain can actually store or load ever takes
 * the fallback: contract-interior performance is unchanged, and the quadratic path
 * exists purely as a correctness belt for pathological direct callers.
 */
export const CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD = 2 ** 31;

/**
 * The ORIGINAL (pre-optimisation) closed unwrap: run {@link unwrapLonSequence} for
 * every rotation of the cyclic list, keep the smallest-span run (ties keep the
 * earliest rotation, per SPAN_EPSILON), and un-rotate it back to input order. O(n²).
 * Kept verbatim as the extreme-longitude fallback of {@link unwrapClosedLonSequence}
 * — at magnitudes beyond {@link CLOSED_UNWRAP_EXACT_SEARCH_THRESHOLD} its
 * large-absolute-value span measurement IS the contracted behaviour, so the fallback
 * must reproduce it byte-for-byte (it is also the brute-force reference the unit
 * tests compare the fast path against). Pure; input never mutated.
 */
function closedUnwrapExhaustiveSearch(lons: readonly number[]): number[] {
  const n = lons.length;
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
  for (let k = 0; k < n; k += 1) {
    out[(bestStart + k) % n] = bestRun[k]!;
  }
  return out;
}

/**
 * The per-window maximum (`wantMax`) or minimum of every length-`window` contiguous
 * window of `arr`, returned in window-start order (length `arr.length − window + 1`).
 * A monotonic index deque keeps the running extreme in amortised O(1) per element, so
 * the whole scan is O(arr.length) — the linear core that turns the closed-unwrap
 * rotation search from O(n²) into O(n). A head pointer (not `Array.shift`) drops
 * out-of-window indices so no per-pop reindex sneaks the cost back to O(n²). Pure.
 */
function slidingWindowExtrema(
  arr: readonly number[],
  window: number,
  wantMax: boolean,
): number[] {
  const out: number[] = [];
  const dq: number[] = []; // indices into `arr`, values monotonic (front = extreme)
  let head = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i]!;
    while (dq.length > head) {
      const back = arr[dq[dq.length - 1]!]!;
      if (wantMax ? back <= v : back >= v) dq.pop();
      else break;
    }
    dq.push(i);
    if (dq[head]! <= i - window) head += 1;
    if (i >= window - 1) out.push(arr[dq[head]!]!);
  }
  return out;
}

/** Span improvements below this (in degrees) are ignored, so a rotation is only
 * replaced when it is meaningfully tighter; this keeps the earliest (rotation-0)
 * placement for already-continuous rings and avoids reshuffling on sub-degree float
 * jitter. It does NOT make results input-jitter-invariant (a perturbed input can
 * still cross the threshold) — for identical IEEE inputs the choice is deterministic.
 * 1e-6 is far below any seam crossing's full-turn (360°) span difference. */
const SPAN_EPSILON = 1e-6;

/**
 * The double immediately adjacent to `x` in the direction of `toward`
 * (the IEEE-754 "next representable value"). Used to nudge an accumulated
 * longitude back by the minimum possible amount.
 */
function nextToward(x: number, toward: number): number {
  if (x === toward || Number.isNaN(x) || Number.isNaN(toward)) {
    return x;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  let bits = view.getBigUint64(0);
  if (x === 0) {
    // ±0: step to the smallest subnormal on the `toward` side.
    bits = toward > 0 ? 1n : (1n << 63n) | 1n;
  } else if (x > 0 === toward > x) {
    // Moving away from zero (toward has larger magnitude on the same side).
    bits += 1n;
  } else {
    // Moving toward zero.
    bits -= 1n;
  }
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

/**
 * Given an accumulated value `unwrapped = prev + step` whose *intended* gap from
 * `prev` is `maxGap` (= |step|, ≤ 180), return the closest double to `unwrapped`
 * whose realised gap `|result - prev|` does not exceed `maxGap`. Float rounding of
 * the addition can make the realised gap exceed `maxGap` by a handful of ULPs;
 * we nudge `result` one ULP at a time toward `prev` until the bound holds. The
 * loop is bounded (a sum of two doubles is at most ~1 ULP off, so 1-2 steps
 * suffice; the cap is a safety belt, never a silent give-up — if it were ever
 * hit the value is already the closest representable one under the bound).
 */
function clampGapToStep(prev: number, unwrapped: number, maxGap: number): number {
  let result = unwrapped;
  for (let i = 0; i < 4 && Math.abs(result - prev) > maxGap; i += 1) {
    result = nextToward(result, prev);
  }
  return result;
}
