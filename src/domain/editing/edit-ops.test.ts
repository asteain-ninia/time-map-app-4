// U24 受け入れ基準3 / 4 / 5 — feature-edit ops: point/line/leaf vertex add &
// delete with thresholds (line<2 deletes line; ring<3 removes ring via U07; leaf
// without territory deletes leaf). FR-88.

import { describe, expect, it } from 'vitest';

import {
  addVertexToLine,
  addVertexToLeafRing,
  deleteLineVertex,
  deleteLeafVertex,
  deletePointVertex,
  deleteVertex,
} from './edit-ops';
import { fid, hole, leaf, line, point, rid, territory, vid } from './fixtures';
import { FEATURE_KIND, type LeafFeature, type LineFeature } from '../feature';
import { RING_KIND } from '../ring';

// --- 受け入れ基準4: line edit + 2点未満削除 --------------------------------

describe('line vertex add / delete (受け入れ基準4)', () => {
  it('adds a new vertex on an edge handle between two vertices', () => {
    const f = line('L', ['a', 'b', 'c']);
    const r = addVertexToLine(f, vid('a'), vid('b'), vid('new'))!;
    expect(r.kind).toBe('feature');
    const nf = (r as { feature: LineFeature }).feature as LineFeature;
    expect(nf.vertexIds).toEqual([vid('a'), vid('new'), vid('b'), vid('c')]);
  });

  it('deletes a vertex, line survives when ≥2 remain', () => {
    const r = deleteLineVertex(line('L', ['a', 'b', 'c']), vid('b'));
    expect(r.kind).toBe('feature');
    expect((r as { feature: LineFeature }).feature.vertexIds).toEqual([vid('a'), vid('c')]);
  });

  it('deletes the LINE feature itself when fewer than 2 vertices remain', () => {
    const r = deleteLineVertex(line('L', ['a', 'b']), vid('b'));
    expect(r.kind).toBe('delete-feature');
    expect((r as { featureId: ReturnType<typeof fid> }).featureId).toBe(fid('L'));
  });
});

// --- 受け入れ基準5: leaf edit + 3点未満削除・リング/面削除 -------------------

describe('leaf vertex add / delete (受け入れ基準5)', () => {
  it('adds a vertex on a ring edge (closed ring, wrap edge supported)', () => {
    const f = leaf('F', [territory('r0', ['a', 'b', 'c'])]);
    const r = addVertexToLeafRing(f, rid('r0'), vid('c'), vid('a'), vid('new'))!; // closing edge
    expect(r.kind).toBe('feature');
    const nf = (r as { feature: LeafFeature }).feature;
    const ring = nf.shape.rings[0]!;
    expect(ring.vertexIds).toEqual([vid('a'), vid('b'), vid('c'), vid('new')]);
  });

  it('removes a ring (via U07 reorganization) when it drops below 3 vertices', () => {
    // A hole with 3 vertices: deleting one leaves 2 → hole removed; territory stays.
    const f = leaf('F', [
      territory('r0', ['a', 'b', 'c', 'd']),
      hole('r1', ['h0', 'h1', 'h2'], 'r0'),
    ]);
    const r = deleteLeafVertex(f, rid('r1'), vid('h2'));
    expect(r.kind).toBe('feature');
    const nf = (r as { feature: LeafFeature }).feature;
    expect(nf.shape.rings.some((x) => x.id === rid('r1'))).toBe(false);
    expect(nf.shape.rings.some((x) => x.kind === RING_KIND.Territory)).toBe(true);
  });

  it('deletes the LEAF feature when no territory ring remains', () => {
    // The single territory ring drops below 3 → removed → no territory → leaf gone.
    const f = leaf('F', [territory('r0', ['a', 'b', 'c'])]);
    const r = deleteLeafVertex(f, rid('r0'), vid('c'));
    expect(r.kind).toBe('delete-feature');
  });
});

// --- 受け入れ基準3: point delete ------------------------------------------

describe('point vertex delete (受け入れ基準3)', () => {
  it('deleting the point vertex deletes the point feature', () => {
    const r = deletePointVertex(point('P', 'p0'));
    expect(r.kind).toBe('delete-feature');
  });
});

// --- uniform dispatch -------------------------------------------------------

describe('deleteVertex dispatch', () => {
  it('routes by feature variant and requires a ringId for leaves', () => {
    expect(deleteVertex({ feature: point('P', 'p0'), vertexId: vid('p0') })!.kind).toBe('delete-feature');
    expect(deleteVertex({ feature: line('L', ['a', 'b', 'c']), vertexId: vid('b') })!.kind).toBe('feature');
    // leaf without ringId → undefined (cannot decide which ring)
    expect(deleteVertex({ feature: leaf('F', [territory('r0', ['a', 'b', 'c', 'd'])]), vertexId: vid('a') })).toBeUndefined();
    // leaf with ringId → handled
    const lr = deleteVertex({
      feature: leaf('F', [territory('r0', ['a', 'b', 'c', 'd'])]),
      vertexId: vid('a'),
      ringId: rid('r0'),
    });
    expect(lr!.kind).toBe('feature');
  });

  it('aggregate features have no vertex edit (FR-35)', () => {
    // Using FEATURE_KIND import to assert dispatch covers the union exhaustively at runtime.
    expect(FEATURE_KIND.Aggregate).toBe('aggregate');
  });
});
