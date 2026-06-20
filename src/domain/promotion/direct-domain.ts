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

import { type WorldCoordinate } from '../coordinate';
import {
  pointInPolygon,
  POINT_LOCATION,
  quantizeCoordinate,
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

// ---------------------------------------------------------------------------
// 既定名称 (基準 5 / FR-37) — single source of truth
// ---------------------------------------------------------------------------

/** The 直轄領 既定名称 suffix. Centralised so the rule lives in exactly one place. */
export const DIRECT_DOMAIN_NAME_SUFFIX = ' 直轄領';

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

function coordKey(c: WorldCoordinate): string {
  const q = quantizeCoordinate(c);
  return `${q.lon},${q.lat}`;
}

interface RawRing {
  readonly id: RingId;
  readonly vertexIds: readonly VertexId[];
  readonly coords: GeoRing;
  /** True for a polygon piece's index-0 ring (an outer / territory boundary). */
  readonly isOuter: boolean;
}

/** Signed-area magnitude of a coordinate ring (for "smallest enclosing" choice). */
function ringAreaAbs(ring: GeoRing): number {
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

/** True iff `inner`'s representative point lies strictly inside `outer`. */
function ringContains(outer: GeoRing, inner: GeoRing): boolean {
  const probe = inner[0];
  if (probe === undefined) return false;
  return pointInPolygon(probe, [outer]) === POINT_LOCATION.Inside;
}

/**
 * Re-parent raw rings into a valid 領土→穴→領土→… alternating hierarchy (FR-24) by
 * containment. Each ring's parent is the SMALLEST-area ring of the OPPOSITE kind
 * that strictly contains it; a ring with no opposite-kind container is a top-level
 * territory. Disjoint outer pieces with no containing ring all become top-level
 * territories — i.e. 飛び地 of the same 直轄領 (教訓 5.1). Pure; inputs unmutated.
 */
function reparentByContainment(raws: readonly RawRing[]): Ring[] {
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
 * ring per piece-ring, REWRAPPING each coordinate back into the representative
 * [-180,180) interval (技術方針 R3): the difference is computed on seam-unwrapped
 * coordinates, so the stored 直轄領 形状 must be rewrapped to the canonical interval,
 * keeping a seam-straddling 飛び地 whole. EVERY piece / ring is materialised
 * (片落とし禁止, 教訓 5.1).
 *
 * Returns `undefined` only if the input holds no usable ring (an empty difference
 * — the caller decides "no 直轄領" before calling, so this is a defensive guard).
 */
export function buildDirectDomainShape(
  difference: GeoMultiPolygon,
  ids: DirectDomainIdPorts,
): BuiltDirectDomainShape | undefined {
  const vertices: Vertex[] = [];
  const byCoord = new Map<string, VertexId>();

  const mintRingVertices = (ring: GeoRing): { ids: VertexId[]; coords: GeoRing } => {
    const out: VertexId[] = [];
    const rewrapped = rewrapRing([...ring]);
    for (const c of rewrapped) {
      const key = coordKey(c);
      let vid = byCoord.get(key);
      if (vid === undefined) {
        vid = ids.nextVertexId();
        byCoord.set(key, vid);
        vertices.push(createVertex(vid, quantizeCoordinate(c)));
      }
      out.push(vid);
    }
    return { ids: out, coords: rewrapped };
  };

  const raws: RawRing[] = [];
  for (const poly of difference) {
    poly.forEach((ring, index) => {
      const minted = mintRingVertices(ring);
      raws.push({
        id: ids.nextRingId(),
        vertexIds: minted.ids,
        coords: minted.coords,
        isOuter: index === 0,
      });
    });
  }

  if (raws.length === 0) return undefined;

  const rings = reparentByContainment(raws);
  return { shape: createShape(rings), vertices };
}
