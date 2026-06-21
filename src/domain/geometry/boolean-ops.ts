// U06 boolean-op wrappers — THE single window to `polygon-clipping` (spec §目的 /
// 注意点「ラッパが唯一の窓口」). Upper units MUST call union / difference /
// intersection here and never import `polygon-clipping` directly; this is the
// only module in the codebase that imports it, and the layer-direction lint plus
// upper-unit tests keep it that way.
//
// Every op runs the mandatory defense pipeline (R2), with no bypass path:
//   1. quantize all inputs onto the shared integer grid (./quantize),
//   2. call the library kernel,
//   3. re-check the result against domain invariants (./invariants),
//   4. on violation, return a discriminated *rejection* instead of the result.
//
// 教訓5.1 (集合演算は複数片を返す前提): the result is always a GeoMultiPolygon
// holding every piece the kernel returned — we never take only the first
// polygon/ring. An empty result (e.g. a difference that vanishes, or a
// non-overlapping intersection) is a successful empty multi-polygon, NOT a
// rejection (教訓5.18).

// `polygon-clipping`'s ESM build has ONLY a default export — an object carrying
// `.union` / `.difference` / `.intersection` / `.xor` — and ships NO named
// exports. Pulling the kernels in by name (`import { union } ...`) or reaching
// for them on a namespace import (`import * as pc` then `pc.union`) builds to a
// runtime `undefined` and triggers Rollup/Vite "X is not exported" warnings; the
// default import is the only shape that resolves at runtime. Under our
// esModuleInterop config TypeScript already types this synthesized default as the
// module namespace ({ union, difference, intersection, xor } with the correct
// signatures), so no extra typing or cast is needed.
import polygonClipping from 'polygon-clipping';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  checkMultiPolygonInvariants,
  type InvariantViolation,
} from './invariants';
import { quantizeMultiPolygon } from './quantize';
import {
  EMPTY_MULTI_POLYGON,
  type GeoMultiPolygon,
  type GeoRing,
} from './types';

export const BOOLEAN_OP = {
  Union: 'union',
  Difference: 'difference',
  Intersection: 'intersection',
} as const;

export type BooleanOp = (typeof BOOLEAN_OP)[keyof typeof BOOLEAN_OP];

export const BOOLEAN_OP_STATUS = {
  Ok: 'ok',
  Rejected: 'rejected',
} as const;

/**
 * Discriminated result of a boolean op (spec §実装方針「判別共用体」). Either the
 * full multi-polygon result (`ok`, possibly empty) or a `rejected` carrying the
 * invariant violations the defense layer found. No exceptions for the禁止条件
 * path — the caller handles rejection by type (FR-32 / FR-25 / 教訓5.26).
 */
export type BooleanOpResult =
  | { readonly status: typeof BOOLEAN_OP_STATUS.Ok; readonly result: GeoMultiPolygon }
  | {
      readonly status: typeof BOOLEAN_OP_STATUS.Rejected;
      readonly op: BooleanOp;
      readonly violations: readonly InvariantViolation[];
    };

/** True iff the op succeeded (narrow on this for the `result` field). */
export function isOk(
  r: BooleanOpResult,
): r is { status: typeof BOOLEAN_OP_STATUS.Ok; result: GeoMultiPolygon } {
  return r.status === BOOLEAN_OP_STATUS.Ok;
}

// --- library adapter (the ONLY place library tuple shapes appear) -----------

type LibPair = [number, number];
type LibRing = LibPair[];
type LibPolygon = LibRing[];
type LibMultiPolygon = LibPolygon[];

function multiPolygonToLib(mp: readonly WorldCoordinate[][][]): LibMultiPolygon {
  return mp.map((poly) => poly.map((ring) => ring.map((c) => [c.lon, c.lat] as LibPair)));
}

function libRingToRing(ring: LibRing): WorldCoordinate[] {
  const out: WorldCoordinate[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const pair = ring[i];
    if (pair === undefined) continue;
    const coord = createCoordinate(pair[0], pair[1]);
    // Drop polygon-clipping's repeated closing vertex (it returns first===last).
    const first = out[0];
    const isClosingDup =
      i === ring.length - 1 &&
      first !== undefined &&
      first.lon === coord.lon &&
      first.lat === coord.lat;
    if (isClosingDup) continue;
    out.push(coord);
  }
  return out;
}

function libMultiPolygonToGeo(mp: LibMultiPolygon): GeoMultiPolygon {
  // Every piece and every ring is converted — 片落とし禁止 (教訓5.1).
  return mp.map((poly) => poly.map((ring) => libRingToRing(ring)));
}

// --- the pipeline -----------------------------------------------------------

function runKernel(
  op: BooleanOp,
  subjectLib: LibMultiPolygon,
  clipLib: LibMultiPolygon,
): LibMultiPolygon {
  switch (op) {
    case BOOLEAN_OP.Union:
      return polygonClipping.union(subjectLib, clipLib);
    case BOOLEAN_OP.Difference:
      return polygonClipping.difference(subjectLib, clipLib);
    case BOOLEAN_OP.Intersection:
      return polygonClipping.intersection(subjectLib, clipLib);
    default: {
      // Exhaustiveness without importing assertNever's throw path into the happy
      // route; an unknown op is a programming error.
      const never: never = op;
      throw new Error(`Unknown boolean op: ${String(never)}`);
    }
  }
}

/**
 * Run one boolean op through the full defense pipeline. Internal; the three
 * named exports below are the public window. Quantization is unconditional —
 * there is no path to the kernel that skips it (acceptance criterion 2:
 * 量子化を迂回する経路が存在しない).
 */
function runBooleanOp(
  op: BooleanOp,
  subject: GeoMultiPolygon,
  clip: GeoMultiPolygon,
): BooleanOpResult {
  // 1. Quantize (front half of R2 defense).
  const qSubject = quantizeMultiPolygon(subject);
  const qClip = quantizeMultiPolygon(clip);

  // The kernel rejects polygons with empty ring lists; an empty subject means an
  // empty result for every op except where the kernel would throw, so short-out.
  const subjectLib = multiPolygonToLib(qSubject).filter((poly) => poly.length > 0 && poly[0]!.length > 0);
  const clipLib = multiPolygonToLib(qClip).filter((poly) => poly.length > 0 && poly[0]!.length > 0);

  if (subjectLib.length === 0) {
    // Union with empty subject == clip; difference/intersection == empty.
    if (op === BOOLEAN_OP.Union) {
      // The kernel normalize call (normalizeUnion) and the lib->geo conversion
      // can both throw on degenerate clip input — the kernel itself can throw on
      // some degenerate ring lists, and conversion throws (RangeError) if the
      // kernel emits a non-finite vertex (createCoordinate's finite guard). Both
      // must surface as a rejection, never crash the caller (R2). Run them inside
      // the same try/catch as the main kernel path below.
      return runKernelAndConvert(op, () =>
        libMultiPolygonToGeo(normalizeUnion(clipLib)),
      );
    }
    return { status: BOOLEAN_OP_STATUS.Ok, result: EMPTY_MULTI_POLYGON };
  }

  // 2. Kernel + 3/4 conversion: the kernel can throw on degenerate input, and
  // the lib->geo conversion can throw (RangeError) if the kernel emits a
  // non-finite vertex. BOTH are inside the try so neither can escape the R2
  // "never throw, always a discriminated rejection" contract.
  return runKernelAndConvert(op, () =>
    libMultiPolygonToGeo(runKernel(op, subjectLib, clipLib)),
  );
}

/**
 * Run a kernel-call-plus-conversion thunk inside the R2 try/catch and finalize.
 *
 * The entire critical section — calling the `polygon-clipping` kernel AND
 * converting its tuple output back to domain `GeoMultiPolygon` — runs inside one
 * try/catch. The kernel can throw on degenerate input (e.g. an outer ring with
 * an empty hole list), and the conversion can throw a `RangeError` from
 * `createCoordinate`'s finite guard when the kernel emits a NaN/±Infinity vertex
 * on degenerate geometry. Either throw is mapped to a discriminated rejection so
 * the defense layer never propagates an exception to the caller.
 */
function runKernelAndConvert(
  op: BooleanOp,
  produce: () => GeoMultiPolygon,
): BooleanOpResult {
  let geo: GeoMultiPolygon;
  try {
    geo = produce();
  } catch {
    // A kernel throw, or a non-finite vertex tripping createCoordinate's finite
    // guard, is treated as a rejection — never a silent empty success or an
    // escaping exception. The defense layer must surface it (R2).
    return {
      status: BOOLEAN_OP_STATUS.Rejected,
      op,
      violations: [],
    };
  }
  return finalizeOk(op, geo);
}

/**
 * Normalize a single (clip) multi-polygon through the kernel for the empty-subject
 * union branch. A single-argument `union(clip)` is the kernel's idempotent
 * normalize path; passing the same polygon twice (`union(clip, clip)`) only
 * inflates the sweep-line event count and memory for no behavioural gain, so we
 * call it with one argument (Codex perf指摘). An empty clip needs no kernel call.
 */
function normalizeUnion(clip: LibMultiPolygon): LibMultiPolygon {
  if (clip.length === 0) return [];
  return polygonClipping.union(clip);
}

/**
 * 3 + 4: re-quantize the kernel output back onto the shared grid, then re-check
 * invariants; ok or rejected.
 *
 * Re-quantization (Codex指摘) closes the single-truth-source hole: the kernel can
 * return non-grid coordinates (e.g. an oblique intersection point at
 * 0.8888888…), so without re-snapping the stored geometry would drift off the
 * grid and a later op (even `union(result, EMPTY)`) would change shared-vertex
 * identity and the result by op-history order. Snapping the output makes the
 * pipeline idempotent on the grid. A ring that collapses below 3 vertices after
 * re-snapping is a genuine degeneracy and is surfaced by the invariant check as a
 * rejection (TooFewVertices), not silently dropped.
 */
function finalizeOk(op: BooleanOp, raw: GeoMultiPolygon): BooleanOpResult {
  const result: GeoMultiPolygon = quantizeMultiPolygon(raw);
  const violations = checkMultiPolygonInvariants(result);
  if (violations.length > 0) {
    return { status: BOOLEAN_OP_STATUS.Rejected, op, violations };
  }
  return { status: BOOLEAN_OP_STATUS.Ok, result };
}

// --- public window ----------------------------------------------------------

/** Boolean union (A ∪ B). Returns all pieces (教訓5.1). */
export function union(a: GeoMultiPolygon, b: GeoMultiPolygon): BooleanOpResult {
  return runBooleanOp(BOOLEAN_OP.Union, a, b);
}

/** Boolean difference (A \ B). May split into multiple pieces — all are returned. */
export function difference(a: GeoMultiPolygon, b: GeoMultiPolygon): BooleanOpResult {
  return runBooleanOp(BOOLEAN_OP.Difference, a, b);
}

/** Boolean intersection (A ∩ B). May yield multiple disjoint pieces — all returned. */
export function intersection(a: GeoMultiPolygon, b: GeoMultiPolygon): BooleanOpResult {
  return runBooleanOp(BOOLEAN_OP.Intersection, a, b);
}

/**
 * Convenience constructor: wrap a single outer ring (no holes) into a
 * multi-polygon, so callers can build op inputs from raw rings through the
 * factory rather than hand-nesting arrays (lesson 5.39).
 */
export function multiPolygonFromRing(ring: GeoRing): GeoMultiPolygon {
  return [[ring]];
}

/** Convenience: wrap an outer ring plus hole rings into a single-piece multi-polygon. */
export function multiPolygonFromPolygon(outer: GeoRing, ...holes: GeoRing[]): GeoMultiPolygon {
  return [[outer, ...holes]];
}
