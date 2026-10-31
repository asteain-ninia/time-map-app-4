// U29 — 直轄領 (direct-domain) construction helpers (FR-37).
//
// Two pure pieces this unit owns as a SINGLE source of truth (開発ガイド §4):
//   1. The 既定名称 generation rule「<元名> 直轄領」and the override合成 (基準 5).
//   2. Materialising a 差分 GeoMultiPolygon (元形状 − 下位領域の和, computed by U06)
//      into ONE 末端地物 Shape — minting one vertex per distinct quantized grid
//      node and one ring per piece-ring, then RE-PARENTING the rings into a valid
//      領土→穴→領土→… alternating hierarchy (FR-24) by CONTAINMENT.
//
// 教訓 5.1 (片落とし禁止): every piece and every ring of the difference is kept; a
// difference that splits into geographically separate pieces becomes MULTIPLE
// 領土 rings of ONE 直轄領 末端地物 (飛び地), never several features. We never take
// only the first piece.
//
// We do NOT re-implement boolean ops here (FR-37 / spec §やらないこと): the caller
// (promote.ts) computes the difference through U06's wrapper and hands us the
// resulting multi-polygon. Building rings out of a multi-polygon is plain
// geometry assembly, not a boolean op. The containment re-parenting mirrors U26's
// proven split-side builder, kept here as a focused local copy because that one is
// module-private (we share the *idea*, not a leaked private function).

import {
  quantizeCoordinate,
  ringStrictlyContains,
  type GeoMultiPolygon,
  type GeoRing,
} from '../geometry/index';
import { rewrapRing } from '../geo/index';
import type { RingId, VertexId } from '../ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  type Ring,
  type Shape,
} from '../ring';
import { createVertex, type Vertex } from '../vertex';
import { vertexCoordKey } from '../vertex-weld';
import { MSG_DIRECT_DOMAIN_NAME_SUFFIX } from './messages';

// ---------------------------------------------------------------------------
// 既定名称 (基準 5 / FR-37) — single source of truth
// ---------------------------------------------------------------------------

/** The 直轄領 既定名称 suffix. Centralised so the rule lives in exactly one place. */
export const DIRECT_DOMAIN_NAME_SUFFIX = MSG_DIRECT_DOMAIN_NAME_SUFFIX;

/**
 * The 既定名称 of the 直轄領 末端地物 for an aggregate whose name is `originalName`:
 * 「`<元名> 直轄領`」(基準 5 / FR-37). Single 生成規約 — changing the原名 changes the
 * default in lock-step because there is no second copy of this rule.
 */
export function defaultDirectDomainName(originalName: string): string {
  return `${originalName}${DIRECT_DOMAIN_NAME_SUFFIX}`;
}

/**
 * Compose the final 直轄領 名称: the dialog `override` (U28 collects it) when
 * provided and non-empty, else the 既定名称. The override-or-default 合成 lives here
 * only (基準 5 単一の真実源); U28's dialog supplies the override string, never a
 * second naming rule.
 */
export function directDomainName(
  originalName: string,
  override: string | undefined,
): string {
  if (override !== undefined && override.length > 0) return override;
  return defaultDirectDomainName(originalName);
}

// ---------------------------------------------------------------------------
// ID ports (injected; pure & deterministic — NFR 5.8 / 教訓 5.37)
// ---------------------------------------------------------------------------

/** Injected, deterministic id minting so 直轄領 construction stays pure (NFR 5.8). */
export interface DirectDomainIdPorts {
  readonly nextVertexId: () => VertexId;
  readonly nextRingId: () => RingId;
}

// ---------------------------------------------------------------------------
// 差分 GeoMultiPolygon → Shape (mint vertices + rings; 片落とし禁止 教訓 5.1)
// ---------------------------------------------------------------------------

/** The materialised 直轄領 形状 plus every newly-minted vertex it references. */
export interface BuiltDirectDomainShape {
  readonly shape: Shape;
  readonly vertices: readonly Vertex[];
}

/** {@link nestRingsByContainment} へ渡す輪。 */
export interface RawRing {
  readonly id: RingId;
  readonly vertexIds: readonly VertexId[];
  /**
   * 差分の出力のままの、**畳む前の連続の座標**。包含と面積はこれで見る（B90）。保存する頂点の
   * 座標（畳んだ値）を使ってはいけない。経度 180 の頂点は -180 に畳まれるので、畳んだ外周は
   * 「世界を一周する輪」になり、中の穴を含まなくなる。
   */
  readonly coords: GeoRing;
  /** True for a polygon piece's index-0 ring (an outer / territory boundary). */
  readonly isOuter: boolean;
}

/** Signed-area magnitude of a coordinate ring (for "smallest enclosing" choice). */
export function ringAreaAbs(ring: GeoRing): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    sum += a.lon * b.lat - b.lon * a.lat;
  }
  return Math.abs(sum) / 2;
}

/**
 * True iff `inner` ring lies strictly inside `outer` ring.
 *
 * Delegates to the shared {@link ringStrictlyContains} predicate (単一の真実源,
 * the same boundary-robust nesting test that backs U06's hole↔outer invariant and
 * U26 split re-parenting in knife/proposal). A lone `inner[0]` vertex probe was
 * fragile: after quantization a 飛び地/穴's first vertex frequently lands exactly
 * ON a shared seam boundary of the candidate outer/hole, where `pointInPolygon`
 * returns Boundary (not Inside) — so the old probe reported "not contained" for a
 * genuinely nested ring, and {@link nestRingsByContainment} would wrongly promote a
 * 穴/飛び地 to a top-level territory, collapsing the 直轄領 hierarchy (FR-24). The
 * robust predicate tests no-vertex-outside + no-edge-stretch-outside + has-real-
 * interior-inside, so an on-boundary seam vertex no longer fools it.
 */
function ringContains(outer: GeoRing, inner: GeoRing): boolean {
  return ringStrictlyContains(outer, inner);
}

/**
 * Re-parent raw rings into a valid 領土→穴→領土→… alternating hierarchy (FR-24) by
 * containment. Each ring's parent is the SMALLEST-area ring of the OPPOSITE kind
 * that strictly contains it; a ring with no opposite-kind container is a top-level
 * territory. Disjoint outer pieces with no containing ring all become top-level
 * territories — i.e. 飛び地 of the same 直轄領 (教訓 5.1). Pure; inputs unmutated.
 */
export function nestRingsByContainment(raws: readonly RawRing[]): Ring[] {
  const areaOf = new Map<RingId, number>();
  for (const r of raws) areaOf.set(r.id, ringAreaAbs(r.coords));

  const rings: Ring[] = [];
  for (const r of raws) {
    let bestParent: RawRing | undefined;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const cand of raws) {
      if (cand.id === r.id) continue;
      if (cand.isOuter === r.isOuter) continue; // parent must alternate kind.
      if (!ringContains(cand.coords, r.coords)) continue;
      const a = areaOf.get(cand.id) ?? Number.POSITIVE_INFINITY;
      if (a < bestArea) {
        bestArea = a;
        bestParent = cand;
      }
    }

    if (r.isOuter) {
      rings.push(
        bestParent === undefined
          ? createTerritoryRing(r.id, r.vertexIds)
          : createTerritoryRing(r.id, r.vertexIds, bestParent.id),
      );
    } else if (bestParent === undefined) {
      // A hole with no containing territory would be an orphan; promote it to a
      // top-level territory rather than drop it (教訓 5.1 片落とし禁止 + keeps
      // alternation valid). U06 output should not produce this, but we never throw
      // away a piece.
      rings.push(createTerritoryRing(r.id, r.vertexIds));
    } else {
      rings.push(createHoleRing(r.id, r.vertexIds, bestParent.id));
    }
  }
  return rings;
}

/**
 * Build ONE 直轄領 末端地物 形状 from the difference multi-polygon. Mints a vertex per
 * distinct quantized node (shared between rings that meet at the same node) and a
 * ring per piece-ring. EVERY piece / ring is materialised (片落とし禁止, 教訓 5.1).
 *
 * `difference` は 1 つの連続の枠の座標で渡す（`buildDirectDomainForLeaf` が整列して差分した
 * 結果）。**畳むのは保存する頂点だけ**で（代表区間 [-180,180)。技術方針 R3）、輪の入れ子は
 * 渡された連続の座標のまま組む（B90）。
 *
 * Returns `undefined` only if the input holds no usable ring (an empty difference
 * — the caller decides "no 直轄領" before calling, so this is a defensive guard).
 */
export function buildDirectDomainShape(
  difference: GeoMultiPolygon,
  ids: DirectDomainIdPorts,
  reuseVertices: readonly Vertex[] = [],
): BuiltDirectDomainShape | undefined {
  const vertices: Vertex[] = [];
  const byCoord = new Map<string, VertexId>();
  // **同じ座標に居た頂点の id を使い回す**（B39 の手直しで入れた）。分け残しを作るとき
  // （所属変更・細分・読み込みの修復。`promote.ts` の `buildDirectDomainForLeaf`）は元の面の
  // 頂点を渡すので、分け残しの外周は元の頂点 id のまま残り、元の面と境を共有していた隣との
  // 共有が切れない。新しく生まれる角だけを採番する。渡さなければ全部を新しく採番する。
  // 鍵は畳んだ座標で作る（B107。経度 +180 で保存された頂点は、照合の座標 -180 と同じ鍵になる）。
  // 使い回す頂点の体は元のまま返す。同じ id の体が履歴の間で食い違わない（§5.103）。
  const reusable = new Map<string, Vertex>();
  for (const v of reuseVertices) {
    const key = vertexCoordKey(v.coordinate);
    if (!reusable.has(key)) reusable.set(key, v);
  }

  const mintRingVertices = (ring: GeoRing): VertexId[] => {
    const out: VertexId[] = [];
    for (const c of rewrapRing([...ring])) {
      const key = vertexCoordKey(c);
      let vid = byCoord.get(key);
      if (vid === undefined) {
        const reuse = reusable.get(key);
        if (reuse !== undefined) {
          vid = reuse.id;
          vertices.push(reuse);
        } else {
          vid = ids.nextVertexId();
          vertices.push(createVertex(vid, quantizeCoordinate(c)));
        }
        byCoord.set(key, vid);
      }
      out.push(vid);
    }
    return out;
  };

  const raws: RawRing[] = [];
  for (const poly of difference) {
    poly.forEach((ring, index) => {
      raws.push({
        id: ids.nextRingId(),
        vertexIds: mintRingVertices(ring),
        coords: ring,
        isOuter: index === 0,
      });
    });
  }

  if (raws.length === 0) return undefined;

  const rings = nestRingsByContainment(raws);
  return { shape: createShape(rings), vertices };
}
