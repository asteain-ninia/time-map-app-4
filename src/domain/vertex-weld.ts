// Vertex WELDING — reusing an EXISTING VertexId for a rebuilt boundary coordinate
// that lands on an existing vertex (HB3-10).
//
// WHY THIS MODULE EXISTS
// ----------------------
// Several operations rebuild a feature's boundary from a `GeoMultiPolygon` that a
// U06 boolean op produced (knife split, merge, drill, and — the reason this module
// was extracted — the conflict-resolution `difference` write-back). The naive
// rebuild mints a FRESH vertex for every output coordinate. That is wrong wherever
// the rebuilt boundary runs along ANOTHER feature's existing boundary: the two
// features then carry two coincident-but-unlinked vertices, so the shared edge is
// not shared at all (no FR-30 琥珀 marker, no FR-31 連動移動 — dragging one side
// tears the boundary open and re-opens the very overlap the operation removed).
//
// Sharing in this domain is expressed ONLY by referencing the same `VertexId`
// (技術方針 R6; `shared-vertex.ts` derives "is shared" from the reference count —
// it is never stored). So "weld" here means exactly: cite the existing VertexId and
// carry that vertex's OWN body along, instead of minting a new id.
//
// THE COORDINATE-IDENTITY RULE (no new epsilon — 単一真実源 / 教訓5.30)
// -------------------------------------------------------------------
// Two coordinates are "the same point" iff they land on the SAME U06 quantization
// grid node after the longitude is folded to its representative branch:
//     quantizeCoordinate(normalizeCoordinate(c))
// This is byte-for-byte the rule `knife/proposal.ts`, `merge/proposal.ts` and
// `drill/proposal.ts` each spell out locally as their private `coordKey`; this
// module is the extracted, named statement of it. There is deliberately NO separate
// tolerance constant: `QUANTIZE_SCALE` (geometry/quantize.ts) is the ONE tolerance
// of the system, and every boolean-op output is already snapped onto it.
//   - The QUANTIZE half is load-bearing because a STORED vertex may sit OFF the grid
//     (nothing re-snaps stored coordinates), while a boolean-op output is always ON
//     it — comparing raw-vs-quantized would then never match (the HB4-2 failure
//     mode: a ~5e-8° difference that no exact comparison can see).
//   - The NORMALIZE half is load-bearing across the ±360° seam: a boolean op run in
//     a continuous frame can emit lon 190° for a vertex stored as −170°.
//
// PURITY: every function is pure with respect to its inputs (nothing is mutated).
// `weldRingVertices` calls the caller's id-minting port, which is the caller's own
// effect, exactly as the split/drill/merge builders already do.
//
// KNOWN ASSUMPTION (候補は verticesAt の合成ストア由来): the weld candidates a caller
// feeds {@link buildWeldIndex} come from the effective-time vertex store (the UI's
// `live-lookup.verticesAt`), whose cross-history last-write-wins concat is correct for
// a divergence-free project. In a corrupted project that ALREADY carries a
// `VertexCoordinateDivergence` (two histories citing one id with different bodies), a
// candidate could carry another history's body — the region `persistence/consistency.ts`
// `checkConsistency` detects. This module trusts its inputs and does not re-validate
// them (単一真実源: one consistency authority, not a second copy here).

import type { WorldCoordinate } from './coordinate';
import { normalizeCoordinate } from './geo/seam';
import { quantizeCoordinate } from './geometry/quantize';
import type { VertexId } from './ids';
import { createVertex, type Vertex } from './vertex';

/**
 * The canonical coordinate-identity key: representative longitude, snapped to the
 * U06 quantization grid. Two coordinates weld together iff their keys are equal.
 *
 * Signed zero cannot leak into the key: `createCoordinate` (called by
 * {@link quantizeCoordinate}) normalizes `-0` to `+0`, so `"-0,1"` is unreachable.
 *
 * Throws a `RangeError` on a non-finite coordinate — the same fail-loud stance
 * `normalizeCoordinate` / `quantizeCoordinate` already take (病的入力の落とし穴);
 * a NaN must never silently collapse onto the 0,0 grid node and weld two unrelated
 * boundaries together.
 */
export function vertexCoordKey(coord: WorldCoordinate): string {
  // normalize → quantize → normalize AGAIN. The first normalize folds the ±360° seam
  // onto the [-180,+180) representative; quantize snaps to the U06 grid; the SECOND
  // normalize re-folds a longitude that quantization rounded UP to exactly +180 (a
  // stored 179.99999996 snaps to 180) back onto its −180 representative. Without that
  // re-fold the key is NON-idempotent across the seam — 179.99999996 → "180,…" while
  // 180 / −180 → "−180,…" — so a boundary vertex and the grid node it snaps to would
  // key differently and fail to weld (LOW-1). This reuses U04 `wrapLonDeg`'s single
  // boundary convention (+180 → −180); NO new epsilon and no second tolerance.
  //
  // 申し送り: the private `coordKey` in knife / merge / drill (each unit's proposal.ts)
  // is the same `quantize(normalize(c))` shape and carries the SAME latent seam
  // non-idempotency. They are deliberately NOT touched here — an inherited convention
  // in another unit's regression domain; folding them belongs to the eventual
  // single-source extraction this module anticipates, not to this weld patch.
  const q = normalizeCoordinate(quantizeCoordinate(normalizeCoordinate(coord)));
  return `${q.lon},${q.lat}`;
}

/**
 * A lookup from coordinate key to the EXISTING vertex a rebuilt boundary should
 * cite at that position. Build it with {@link buildWeldIndex}; query it with
 * {@link resolveWeld} or (the usual entry point) {@link weldRingVertices}.
 */
export interface WeldIndex {
  readonly byKey: ReadonlyMap<string, Vertex>;
}

/** The index that welds nothing (every coordinate mints a fresh vertex). */
export const EMPTY_WELD_INDEX: WeldIndex = { byKey: new Map<string, Vertex>() };

/**
 * Build a weld index from ordered candidate GROUPS: an earlier group wins a key
 * contest against a later one, and within a group the first vertex wins. The group
 * order IS the precedence, which is how a caller expresses e.g.「優先地物の頂点を
 * 先に当てる」 — pass `[priorityVertices, adjustVertices]`.
 *
 * Callers MUST keep the candidate set narrow (the operation's own participants).
 * Feeding every feature in the project would manufacture sharing between a rebuilt
 * boundary and an unrelated neighbour that merely happens to touch it — a silent,
 * unrequested linkage the user never asked for.
 */
export function buildWeldIndex(groups: readonly (readonly Vertex[])[]): WeldIndex {
  const byKey = new Map<string, Vertex>();
  for (const group of groups) {
    for (const vertex of group) {
      const key = vertexCoordKey(vertex.coordinate);
      // First writer wins: earlier groups (and earlier vertices) take precedence.
      if (!byKey.has(key)) byKey.set(key, vertex);
    }
  }
  return { byKey };
}

/** The existing vertex `coord` should weld to, or `undefined` when there is none. */
export function resolveWeld(index: WeldIndex, coord: WorldCoordinate): Vertex | undefined {
  return index.byKey.get(vertexCoordKey(coord));
}

/**
 * Materialise ONE rebuilt ring's vertices: for each coordinate, either the existing
 * vertex it welds to (carrying that vertex's OWN body verbatim) or a freshly minted
 * one at the quantized coordinate.
 *
 * Returns one {@link Vertex} per input coordinate, in input order — never fewer, so
 * the caller's ring shape is preserved exactly (片落とし禁止, 教訓5.1).
 *
 * THE BODY IS CARRIED VERBATIM, NOT RE-SNAPPED (教訓 HB4-2 / 5.31): the welded
 * vertex's stored coordinate is returned unchanged so (a) the feature that already
 * owns it does not have its geometry nudged by up to half a grid cell, and (b) the
 * two snapshots that now cite the id hold a byte-identical body, which makes a
 * `VertexCoordinateDivergence` (persistence/consistency.ts) impossible by
 * construction rather than merely unlikely. The caller MUST store the returned
 * bodies alongside the ring, or the reference dangles (a snapshot store is pruned to
 * what it can resolve — `feature.ts pruneVertexStore` DROPS an id with no body, and
 * `resolve-shape.ts` then makes the whole feature unresolvable).
 *
 * PARTICIPATION GUARD (FR-32): a single ring may never cite the same VertexId twice.
 * A ring that pinches back onto a coordinate it already welded therefore mints a
 * fresh vertex for the second visit instead of welding again — which also keeps the
 * zero-length-edge invariant (`shared-vertex.ts zeroLengthEdgeValidator`) intact.
 * The guard is per-ring by design: two DIFFERENT rings (an outer and a hole, a
 * territory and an enclave) legitimately share a vertex.
 */
export function weldRingVertices(
  coords: readonly WorldCoordinate[],
  index: WeldIndex,
  mintVertexId: () => VertexId,
): Vertex[] {
  const out: Vertex[] = [];
  const weldedInThisRing = new Set<VertexId>();
  for (const coord of coords) {
    const existing = resolveWeld(index, coord);
    if (existing !== undefined && !weldedInThisRing.has(existing.id)) {
      weldedInThisRing.add(existing.id);
      out.push(existing);
      continue;
    }
    out.push(createVertex(mintVertexId(), quantizeCoordinate(coord)));
  }
  return out;
}
