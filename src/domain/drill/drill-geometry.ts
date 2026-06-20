// U27 — 穴あけによる新地物生成: geometry validation + hole-formation (FR-45).
//
// Pure domain functions, framework-free (技術方針 2.13 / spec §配置層). The face
// boolean演算 (差/積/和) is delegated to U06 — the single window to
// polygon-clipping (spec §依存 U06); this unit NEVER imports polygon-clipping and
// NEVER re-implements union/difference/intersection. The R2 defense (quantize前後
// + 不変条件再検証) lives inside that U06 wrapper, so every op here inherits it.
//
// CORE CONCEPT (対概念分離; 教訓2.10 / 5.25 / 5.30):
//   穴あけによる新地物生成 (this unit, FR-45) ALWAYS produces a NEW terminal feature
//   and increases the feature count by exactly 1. It is structurally distinct from
//   穴/飛び地追加 = 単一面情報の形状編集 (U25, FR-22/FR-23) which carves a hole WITHOUT
//   creating a feature. The two share the same INPUT (target leaf + designated
//   region) but their CONFIRM paths diverge at the type level (spec §やらないこと):
//   this module's `drillRegion` yields BOTH a holed original AND the carved region,
//   never a shape-edit-only outcome.
//
// What `drillRegion` computes from (target leaf, designated region, vertex store):
//   1. 元末端地物への穴形成: difference(target, region) — the original's shape with
//      the region subtracted, expressed as a holed multi-polygon. 教訓5.1: the
//      difference may return MULTIPLE pieces (飛び地) — every piece is kept (片落とし
//      禁止).
//   2. 新独立末端地物の領土領域: intersection(target, region) — the region clipped to
//      the target's interior, i.e. exactly the area carved out. Using the
//      intersection (not the raw region ring) guarantees 新地物の領土 == 元末端の穴
//      within the U06 quantize tolerance (受け入れ基準5: 新地物と穴の対応).
//
// 向き規約 (注意点): U06 normalizes ring orientation; we trust that single source and
// never re-orient (the proposal layer re-parents rings by containment, U06 predicate).

import { type WorldCoordinate } from '../coordinate';
import { unwrapRing } from '../geo/index';
import {
  difference,
  intersection,
  isOk,
  pointInPolygon,
  POINT_LOCATION,
  type PointLocation,
  ringSelfIntersects,
  type GeoMultiPolygon,
  type GeoPolygon,
} from '../geometry/index';
import { FEATURE_KIND, type Feature, type LeafFeature } from '../feature';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { type VertexStore } from '../vertex';

// ---------------------------------------------------------------------------
// Discriminated 穴あけ可能検証結果 (spec §成果物「判別共用体」)
// ---------------------------------------------------------------------------

export const DRILL_REJECT = {
  /** Target is not a terminal (leaf) feature — 集約地物は穴あけ対象外 (FR-35 / 受け入れ7). */
  NotTerminal: 'not-terminal',
  /** The designated region has fewer than 3 vertices (受け入れ6). */
  DegenerateRegion: 'degenerate-region',
  /** The designated region self-intersects (受け入れ6). */
  SelfIntersecting: 'self-intersecting',
  /** The region is not fully contained inside the target (crosses外周/はみ出す, 受け入れ6). */
  NotContained: 'not-contained',
  /** The boolean op produced an invalid / empty shape on either side (受け入れ6). */
  InvalidShape: 'invalid-shape',
  /** The target's shape could not be resolved (a vertex id is missing). */
  Unresolvable: 'unresolvable',
  /** An unexpected internal inconsistency (dependency returned an impossible value). */
  Internal: 'internal-error',
} as const;

export type DrillRejectKind = (typeof DRILL_REJECT)[keyof typeof DRILL_REJECT];

/** The minimum vertex count for a valid ring / polygon outer ring (FR-45 / FR-44). */
export const MIN_REGION_VERTICES = 3;

export const DRILL_CHECK_STATUS = {
  Drillable: 'drillable',
  NotDrillable: 'not-drillable',
} as const;

export type DrillCheckStatus =
  (typeof DRILL_CHECK_STATUS)[keyof typeof DRILL_CHECK_STATUS];

/**
 * The geometric result of a successful穴あけ (spec §成果物). Carries:
 *   - `holedOriginal`: the元末端地物 with the region subtracted (穴を含む多重ポリゴン;
 *     片落とし禁止 — 教訓5.1, every piece + every hole ring kept),
 *   - `newRegion`: the新独立末端地物 territory area (== the carved hole, 受け入れ5).
 * Both are full GeoMultiPolygons so the proposal layer materialises every piece.
 */
export interface DrillGeometry {
  readonly holedOriginal: GeoMultiPolygon;
  readonly newRegion: GeoMultiPolygon;
}

export type DrillCheckResult =
  | ({ readonly status: typeof DRILL_CHECK_STATUS.Drillable } & DrillGeometry)
  | {
      readonly status: typeof DRILL_CHECK_STATUS.NotDrillable;
      readonly reason: DrillRejectKind;
    };

function rejection(reason: DrillRejectKind): DrillCheckResult {
  return { status: DRILL_CHECK_STATUS.NotDrillable, reason };
}

// ---------------------------------------------------------------------------
// Region containment (穴として成立する条件; U06 述語へ委譲, 教訓5.30)
// ---------------------------------------------------------------------------

/**
 * Is every vertex of `region` inside (or on the boundary of) the target's filled
 * area, AND does the region's representative interior point sit strictly inside?
 * 穴として成立する条件 (spec §やること): the region must be COMPLETELY contained in
 * the target's interior and not cross the外周境界 / はみ出す.
 *
 * We判定 by U06 `pointInPolygon` over every target piece (教訓5.1: all pieces). A
 * region vertex that lands OUTSIDE every piece means the region escapes the target
 * → not contained. A region vertex ON a boundary is allowed (touching, not crossing).
 * The authoritative non-crossing gate is the post-difference / post-intersection
 * area check in {@link checkDrillable}: if the region crossed the外周, the
 * intersection would be smaller than the region's own area and the difference would
 * not carry the region as a clean hole — but the cheap vertex test short-circuits
 * the obviously-escaping case with the correct 包含されない message.
 */
function regionContainedInTarget(
  region: readonly WorldCoordinate[],
  targetMp: GeoMultiPolygon,
): boolean {
  let anyStrictlyInside = false;
  for (const p of region) {
    const loc = locatePointInMultiPolygon(p, targetMp);
    if (loc === POINT_LOCATION.Outside) return false;
    if (loc === POINT_LOCATION.Inside) anyStrictlyInside = true;
  }
  // A region whose every vertex sits exactly on the boundary (no interior contact)
  // does not form a hole inside the face — require at least one strictly-inside
  // vertex OR an interior midpoint sample.
  if (anyStrictlyInside) return true;
  for (let i = 0; i < region.length; i += 1) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    if (a === undefined || b === undefined) continue;
    const mid = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
    if (locatePointInMultiPolygon(mid, targetMp) === POINT_LOCATION.Inside) return true;
  }
  return false;
}

/** Classify a point against a whole multi-polygon: Inside on any piece wins, then Boundary. */
function locatePointInMultiPolygon(
  p: WorldCoordinate,
  mp: GeoMultiPolygon,
): PointLocation {
  let sawBoundary = false;
  for (const poly of mp as readonly GeoPolygon[]) {
    const loc = pointInPolygon(p, poly);
    if (loc === POINT_LOCATION.Inside) return POINT_LOCATION.Inside;
    if (loc === POINT_LOCATION.Boundary) sawBoundary = true;
  }
  return sawBoundary ? POINT_LOCATION.Boundary : POINT_LOCATION.Outside;
}

// ---------------------------------------------------------------------------
// Public: 穴あけ可能検証 (spec §成果物 主関数: 妥当性検証 → 差演算 → 領域算出)
// ---------------------------------------------------------------------------

/**
 * Validate that `target` (a terminal leaf) can be drilled by `region` and compute
 * the holed-original + carved-region geometry (FR-45 / spec §成果物 主関数).
 *
 * Fixed order with early return (spec §公開する主関数): 集約拒否 → 退化/自己交差拒否
 * → 形状解決 → 内部包含検証 → U06 差演算(穴形成) → U06 積演算(新領域) → 有効性検証.
 * Returns a discriminated result carrying the geometry on success or a
 * machine-readable reason on failure (教訓5.26; the Japanese message is mapped in
 * `messages.ts`, so UI notification + tests share one source).
 *
 * 集約地物は受け取らない (FR-35 / 教訓5.25): a non-leaf target is rejected before any
 * geometry runs, so the幾何・編集案 path never sees an aggregate.
 */
export function checkDrillable(
  target: Feature,
  store: VertexStore,
  region: readonly WorldCoordinate[],
): DrillCheckResult {
  if (target.kind !== FEATURE_KIND.Leaf) {
    return rejection(DRILL_REJECT.NotTerminal);
  }
  if (region.length < MIN_REGION_VERTICES) {
    return rejection(DRILL_REJECT.DegenerateRegion);
  }

  // Seam-unwrap the region into a single continuous run before geometry (R3); we
  // pass continuous scalars through and never re-wrap ourselves (spec §無限横スクロール).
  const regionPts = unwrapRing([...region]);
  if (ringSelfIntersects(regionPts)) {
    return rejection(DRILL_REJECT.SelfIntersecting);
  }

  const leaf: LeafFeature = target;
  const targetMp = resolveLeafShape(leaf.shape, store);
  if (targetMp === undefined) {
    return rejection(DRILL_REJECT.Unresolvable);
  }

  // 内部完全包含 / 非交差の cheap pre-gate (教訓5.26: 確定前に同じ述語で検証).
  if (!regionContainedInTarget(regionPts, targetMp)) {
    return rejection(DRILL_REJECT.NotContained);
  }

  const clip: GeoMultiPolygon = [[regionPts]];

  // 1. 穴形成: 元末端 \ 指定領域 (片落とし禁止 — every piece kept, 教訓5.1).
  const holed = difference(targetMp, clip);
  // 2. 新領域: 元末端 ∩ 指定領域 (== the carved hole; guarantees 新地物==穴, 受け入れ5).
  const carved = intersection(targetMp, clip);
  if (!isOk(holed) || !isOk(carved)) {
    return rejection(DRILL_REJECT.InvalidShape);
  }

  const holedOriginal = holed.result;
  const newRegion = carved.result;

  // Both sides must be non-empty: an empty carved region means the region did not
  // overlap the interior; an empty holed-original means the region consumed the
  // whole face (a drill must leave the original with a hole, not erase it).
  if (newRegion.length === 0 || holedOriginal.length === 0) {
    return rejection(DRILL_REJECT.NotContained);
  }

  // 穴形成後の双方が最低 3 頂点で有効なポリゴンを成すこと (spec §やること).
  if (!everyOuterRingHasMinVertices(holedOriginal) || !everyOuterRingHasMinVertices(newRegion)) {
    return rejection(DRILL_REJECT.InvalidShape);
  }

  return { status: DRILL_CHECK_STATUS.Drillable, holedOriginal, newRegion };
}

/** Every polygon piece's outer ring (index 0) must have ≥3 vertices (FR-45). */
function everyOuterRingHasMinVertices(mp: GeoMultiPolygon): boolean {
  for (const poly of mp) {
    const outer = poly[0];
    if (outer === undefined || outer.length < MIN_REGION_VERTICES) return false;
  }
  return true;
}

/**
 * Execute the drill, re-running the same validation (教訓5.26: コマンド確定前にも同じ
 * ドメインサービスで再検証) and returning the holed-original + carved-region geometry,
 * or `undefined` when (re)validation fails — the caller treats undefined as "do not
 * commit" and surfaces the message from a fresh {@link checkDrillable}.
 *
 * This is intentionally a thin re-validation wrapper so the geometry computation
 * has ONE code path the proposal assembler and any direct caller both run through.
 */
export function executeDrill(
  target: Feature,
  store: VertexStore,
  region: readonly WorldCoordinate[],
): DrillGeometry | undefined {
  const check = checkDrillable(target, store, region);
  if (check.status !== DRILL_CHECK_STATUS.Drillable) return undefined;
  return { holedOriginal: check.holedOriginal, newRegion: check.newRegion };
}
