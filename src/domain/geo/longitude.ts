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
 * Degenerate rings (< 3 elements have no closing edge distinct from the open run)
 * delegate straight to {@link unwrapLonSequence}. Pure; input never mutated.
 */
export function unwrapClosedLonSequence(lons: readonly number[]): number[] {
  const n = lons.length;
  if (n < 3) return unwrapLonSequence(lons);

  // Try every rotation; keep the one whose continuous run has the smallest span
  // (max − min). For a simple ring the minimal-span rotation is the one whose closing
  // edge is NOT a seam jump (a crossing absorbed into an interior edge stays bounded
  // by the shortest-delta rule; absorbed into the closing edge it inflates the span
  // by a full turn). Ties (already-continuous rings) keep the earliest rotation, so
  // rotation 0 — i.e. plain unwrapLonSequence order — wins when nothing crosses.
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

  // Un-rotate: place each unwrapped value back at its original index. For a simple
  // ring the run is continuous as a cycle, so rotating the array of values back to
  // original order keeps every edge (the original closing edge included) within the
  // shortest-delta bound; for a winding ring the (intrinsic) winding edge is simply
  // carried to its minimal-span position.
  const out: number[] = new Array<number>(n);
  for (let k = 0; k < n; k += 1) {
    out[(bestStart + k) % n] = bestRun[k]!;
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
