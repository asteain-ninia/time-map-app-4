// HB3-10 — the vertex WELD rule: which rebuilt boundary coordinates reuse an
// EXISTING VertexId, and which mint a fresh one.
//
// These tests pin the two halves of the coordinate-identity key that the live
// conflict-resolution write-back depends on (src/ui/consistency-binding.ts), plus
// the FR-32 same-ring participation guard. They are deliberately at THIS level
// because the ±360° seam half of the key is NOT exercised end-to-end through the
// resolution binding today — but NOT because a seam-crossing pair goes undetected:
// U10 `spatial/overlap.ts` aligns candidates through `alignMultiPolygon` /
// `worldWrapReplicas`, so a genuinely seam-crossing pair IS detected as an overlap
// and IS presented to the user. The gap is one step downstream: `applyResolutionAt`
// feeds `difference` the RAW stored representatives with no ±360° alignment, so a
// seam-crossing resolution reaches a PRE-EXISTING convergence-failure dead-end
// (reproducible without this patch; welding neither worsens nor improves it). The
// key rule is nonetheless written to the same convention knife / merge / drill use
// (whose boolean output IS anchored to a continuous frame and DOES emit e.g. 190°),
// so that when this module becomes the single source those three share its behaviour
// is already correct — and so a future seam fix in the binding cannot silently mis-weld.

import { describe, expect, it } from 'vitest';

import { createCoordinate } from './coordinate';
import { QUANTIZE_SCALE } from './geometry/quantize';
import { asVertexId } from './ids';
import { createVertex, type Vertex } from './vertex';
import {
  buildWeldIndex,
  EMPTY_WELD_INDEX,
  resolveWeld,
  vertexCoordKey,
  weldRingVertices,
  type WeldIndex,
} from './vertex-weld';

const v = (id: string, lon: number, lat: number): Vertex =>
  createVertex(asVertexId(id), createCoordinate(lon, lat));

/** A minting port that hands out r-1, r-2, … so assertions read positionally. */
function minter(): () => ReturnType<typeof asVertexId> {
  let n = 0;
  return () => asVertexId(`r-${(n += 1)}`);
}

const GRID = 1 / QUANTIZE_SCALE; // one grid cell, in degrees (1e-7).

describe('vertexCoordKey — the ONE coordinate-identity rule (no new epsilon)', () => {
  it('equal coordinates share a key; a full grid cell apart does not', () => {
    expect(vertexCoordKey(createCoordinate(12.5, -3.25))).toBe(
      vertexCoordKey(createCoordinate(12.5, -3.25)),
    );
    expect(vertexCoordKey(createCoordinate(12.5, -3.25))).not.toBe(
      vertexCoordKey(createCoordinate(12.5 + GRID, -3.25)),
    );
  });

  it('QUANTIZE half: a sub-half-cell difference collapses onto one key (HB4-2)', () => {
    // A STORED vertex may sit off the grid (nothing re-snaps stored coordinates)
    // while a boolean-op output is always on it. Raw-vs-quantized comparison would
    // never match — the exact failure mode HB4-2 recorded.
    const stored = createCoordinate(2 + GRID * 0.4, 1 - GRID * 0.4);
    const fromBooleanOp = createCoordinate(2, 1);
    expect(stored.lon).not.toBe(fromBooleanOp.lon);
    expect(vertexCoordKey(stored)).toBe(vertexCoordKey(fromBooleanOp));
  });

  it('NORMALIZE half: ±360° apart is the SAME point (seam)', () => {
    expect(vertexCoordKey(createCoordinate(190, 10))).toBe(
      vertexCoordKey(createCoordinate(-170, 10)),
    );
    expect(vertexCoordKey(createCoordinate(-185, -4))).toBe(
      vertexCoordKey(createCoordinate(175, -4)),
    );
    // +180 folds to the -180 representative (U04 wrapLonDeg's boundary convention).
    expect(vertexCoordKey(createCoordinate(180, 0))).toBe(
      vertexCoordKey(createCoordinate(-180, 0)),
    );
    // Latitude is NOT periodic — it must not fold.
    expect(vertexCoordKey(createCoordinate(0, 10))).not.toBe(
      vertexCoordKey(createCoordinate(0, 370)),
    );
  });

  it('is IDEMPOTENT across the +180 seam: a lon that QUANTIZES up to 180 folds to -180 (LOW-1)', () => {
    // 179.99999996 is < 180 (the first normalize leaves it untouched), but the grid
    // snap rounds it UP to exactly 180 — the SAME seam point as a stored 180 / −180,
    // which normalize folds to −180 BEFORE quantizing. All three (and the −180 side)
    // must therefore share ONE key, or a boundary vertex sitting fractionally west of
    // +180 would fail to weld onto the −180 grid node it snaps to.
    const key = vertexCoordKey(createCoordinate(-180, 10));
    expect(vertexCoordKey(createCoordinate(179.99999996, 10))).toBe(key); // rounds UP to 180 → −180
    expect(vertexCoordKey(createCoordinate(180, 10))).toBe(key); // exact +180 folds to −180
    expect(vertexCoordKey(createCoordinate(-179.99999996, 10))).toBe(key); // rounds DOWN to −180
    // And the folded key IS the −180 branch, never a stray "180,…".
    expect(key.startsWith('-180,')).toBe(true);
  });

  it('fails loud on a non-finite coordinate rather than collapsing onto 0,0', () => {
    expect(() => vertexCoordKey({ lon: Number.NaN, lat: 0 })).toThrow(RangeError);
    expect(() => vertexCoordKey({ lon: 0, lat: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe('buildWeldIndex / resolveWeld — candidate precedence', () => {
  it('an EARLIER group wins a key contest against a later one', () => {
    const priority = v('p-0', 5, 5);
    const adjust = v('a-0', 5, 5); // same place, different identity
    const index = buildWeldIndex([[priority], [adjust]]);
    expect(resolveWeld(index, createCoordinate(5, 5))?.id).toBe(priority.id);
    // Reversing the group order reverses the winner (the order IS the precedence).
    const flipped = buildWeldIndex([[adjust], [priority]]);
    expect(resolveWeld(flipped, createCoordinate(5, 5))?.id).toBe(adjust.id);
  });

  it('within one group the FIRST vertex wins, and a miss is undefined', () => {
    const index = buildWeldIndex([[v('a', 1, 1), v('b', 1, 1)]]);
    expect(resolveWeld(index, createCoordinate(1, 1))?.id).toBe(asVertexId('a'));
    expect(resolveWeld(index, createCoordinate(9, 9))).toBeUndefined();
    expect(resolveWeld(EMPTY_WELD_INDEX, createCoordinate(1, 1))).toBeUndefined();
  });

  it('indexes candidates by their key, so a ±360° stored branch still resolves', () => {
    const index = buildWeldIndex([[v('seam', -170, 3)]]);
    expect(resolveWeld(index, createCoordinate(190, 3))?.id).toBe(asVertexId('seam'));
  });
});

describe('weldRingVertices — one Vertex per coordinate, bodies carried verbatim', () => {
  const priority: Vertex[] = [v('p-0', 0, 0), v('p-1', 2, 0), v('p-2', 2, 2), v('p-3', 0, 2)];
  const index: WeldIndex = buildWeldIndex([priority]);

  it('welds matching coordinates and mints the rest, preserving ring order/length', () => {
    const ring = [
      createCoordinate(2, 0), // welds → p-1
      createCoordinate(3, 0), // mints
      createCoordinate(3, 2), // mints
      createCoordinate(2, 2), // welds → p-2
    ];
    const out = weldRingVertices(ring, index, minter());
    expect(out.map((x) => String(x.id))).toEqual(['p-1', 'r-1', 'r-2', 'p-2']);
    expect(out.length).toBe(ring.length);
    // Minted vertices land ON the grid; welded ones keep the candidate's own body.
    expect(out[1]!.coordinate).toEqual(createCoordinate(3, 0));
    expect(out[0]!).toBe(priority[1]!); // the same value object, not a copy
  });

  it('carries an OFF-GRID welded body verbatim (never re-snapped — HB4-2 / 5.31)', () => {
    const off = 2 + GRID * 0.4;
    const idx = buildWeldIndex([[v('p-1', off, 0)]]);
    const out = weldRingVertices(
      [createCoordinate(2, 0), createCoordinate(3, 0), createCoordinate(3, 2)],
      idx,
      minter(),
    );
    // The priority's own geometry must NOT be nudged by up to half a grid cell, and
    // both snapshots that now cite the id must hold a byte-identical body.
    expect(out[0]!.coordinate.lon).toBe(off);
  });

  it('welds nothing when there is no candidate (all fresh ids)', () => {
    const out = weldRingVertices(
      [createCoordinate(7, 7), createCoordinate(8, 7), createCoordinate(8, 8)],
      EMPTY_WELD_INDEX,
      minter(),
    );
    expect(out.map((x) => String(x.id))).toEqual(['r-1', 'r-2', 'r-3']);
  });

  it('FR-32 participation guard: one ring never cites the same id twice', () => {
    // A pinch ring that visits (2,0) twice: the SECOND visit must mint, not weld —
    // citing p-1 twice in one ring would violate the same-ring participation rule
    // (and, for adjacent visits, the zero-length-edge invariant).
    const ring = [
      createCoordinate(2, 0),
      createCoordinate(4, 1),
      createCoordinate(2, 0),
      createCoordinate(4, -1),
    ];
    const out = weldRingVertices(ring, index, minter());
    const ids = out.map((x) => String(x.id));
    expect(ids).toEqual(['p-1', 'r-1', 'r-2', 'r-3']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the guard is PER RING: a second ring may weld the same id again', () => {
    const mint = minter();
    const outer = weldRingVertices(
      [createCoordinate(2, 0), createCoordinate(5, 0), createCoordinate(5, 5)],
      index,
      mint,
    );
    const hole = weldRingVertices(
      [createCoordinate(2, 0), createCoordinate(4, 1), createCoordinate(4, 2)],
      index,
      mint,
    );
    // An outer ring and a hole legitimately share a vertex (教訓 5.25): both weld p-1.
    expect(String(outer[0]!.id)).toBe('p-1');
    expect(String(hole[0]!.id)).toBe('p-1');
  });

  it('an empty ring yields an empty run and mints nothing (教訓 5.18)', () => {
    const mint = minter();
    expect(weldRingVertices([], index, mint)).toEqual([]);
    expect(String(mint())).toBe('r-1'); // the port was never called before now
  });
});
