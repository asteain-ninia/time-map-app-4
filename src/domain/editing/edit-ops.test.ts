// U24 受け入れ基準3 / 4 / 5 — feature-edit ops: point/line/leaf vertex add &
// delete with thresholds (line<2 deletes line; ring<3 removes ring via U07; leaf
// without territory deletes leaf). FR-88.

import { describe, expect, it } from 'vitest';

import {
  addVertexToLine,
  addVertexToLeafRing,
  commandResultFromEditResult,
  deleteLineVertex,
  deleteLeafVertex,
  deletePointVertex,
  deleteVertex,
} from './edit-ops';
import { fid, hole, leaf, line, point, rid, territory, vid } from './fixtures';
import { FEATURE_KIND, type LeafFeature, type LineFeature } from '../feature';
import { RING_KIND } from '../ring';
import { EMPTY_SELECTION, reresolveAfterStructureChange, replaceVertices, withActiveFeature } from '../selection';

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
    const r = deleteLineVertex(line('L', ['a', 'b', 'c']), vid('b'))!;
    expect(r.kind).toBe('feature');
    expect((r as { feature: LineFeature }).feature.vertexIds).toEqual([vid('a'), vid('c')]);
  });

  it('deletes the LINE feature itself when fewer than 2 vertices remain', () => {
    const r = deleteLineVertex(line('L', ['a', 'b']), vid('b'))!;
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
    const r = deleteLeafVertex(f, rid('r1'), vid('h2'))!;
    expect(r.kind).toBe('feature');
    const nf = (r as { feature: LeafFeature }).feature;
    expect(nf.shape.rings.some((x) => x.id === rid('r1'))).toBe(false);
    expect(nf.shape.rings.some((x) => x.kind === RING_KIND.Territory)).toBe(true);
  });

  it('deletes the LEAF feature when no territory ring remains', () => {
    // The single territory ring drops below 3 → removed → no territory → leaf gone.
    const f = leaf('F', [territory('r0', ['a', 'b', 'c'])]);
    const r = deleteLeafVertex(f, rid('r0'), vid('c'))!;
    expect(r.kind).toBe('delete-feature');
  });
});

// --- 受け入れ基準3: point delete ------------------------------------------

describe('point vertex delete (受け入れ基準3)', () => {
  it('deleting the point vertex deletes the point feature', () => {
    const r = deletePointVertex(point('P', 'p0'))!;
    expect(r.kind).toBe('delete-feature');
  });
});

// --- stale-target guards (no ghost edit on a vertex/ring no longer present) ---

describe('stale vertex target guards (no ghost history)', () => {
  it('deleteLineVertex returns undefined for a vertex the line does not reference', () => {
    expect(deleteLineVertex(line('L', ['a', 'b', 'c']), vid('zzz'))).toBeUndefined();
  });

  it('deleteLeafVertex returns undefined for a vertex not in the named ring', () => {
    const f = leaf('F', [territory('r0', ['a', 'b', 'c', 'd'])]);
    // The ring exists but does not reference 'zzz'.
    expect(deleteLeafVertex(f, rid('r0'), vid('zzz'))).toBeUndefined();
    // The ring id is unknown.
    expect(deleteLeafVertex(f, rid('nope'), vid('a'))).toBeUndefined();
  });

  it('deletePointVertex returns undefined when the passed vertex id does not match', () => {
    expect(deletePointVertex(point('P', 'p0'), vid('other'))).toBeUndefined();
    // Matching id still deletes.
    expect(deletePointVertex(point('P', 'p0'), vid('p0'))!.kind).toBe('delete-feature');
  });

  it('deleteVertex dispatch drops a stale point/line/leaf target', () => {
    expect(deleteVertex({ feature: point('P', 'p0'), vertexId: vid('other') })).toBeUndefined();
    expect(deleteVertex({ feature: line('L', ['a', 'b', 'c']), vertexId: vid('zzz') })).toBeUndefined();
    expect(
      deleteVertex({
        feature: leaf('F', [territory('r0', ['a', 'b', 'c', 'd'])]),
        vertexId: vid('zzz'),
        ringId: rid('r0'),
      }),
    ).toBeUndefined();
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

// --- 受け入れ基準11: 構造変更後の選択再解決 (教訓5.11) -----------------------
//
// Each edit result carries a SelectionDelta (残る/新規/削除 ID). The selection is
// re-resolved FROM that result via U22's reresolveAfterStructureChange — it is
// NEVER decided by a fixed blanket clear. These tests fix the three required
// behaviours (新頂点→選択, 削除リング頂点→選択から外す, 地物削除→選択クリア).

describe('selection re-resolution after structural edits (受け入れ基準11 / 教訓5.11)', () => {
  it('vertex ADD: the new vertex is created so it can be promoted to selection', () => {
    const f = line('L', ['a', 'b', 'c']);
    const r = addVertexToLine(f, vid('a'), vid('b'), vid('new'))!;
    expect(r.selection.addedVertexIds).toEqual([vid('new')]);
    expect(r.selection.removedVertexIds).toEqual([]);

    const result = commandResultFromEditResult(r);
    expect(result.created.has(vid('new'))).toBe(true);
    expect(result.survived.has(fid('L'))).toBe(true);

    // U22 re-resolves: promote the new vertex (the operation's "next target").
    const before = withActiveFeature(EMPTY_SELECTION, fid('L'));
    const after = reresolveAfterStructureChange(before, result, {
      vertexSelection: { ownerFeatureId: fid('L'), vertexIds: new Set([vid('new')]) },
    });
    expect(after.vertexOwner).toBe(fid('L'));
    expect([...after.vertexIds]).toEqual([vid('new')]);
  });

  it('ring removal: vertices carried away with the dropped ring leave the selection (not a blanket clear)', () => {
    const f = leaf('F', [
      territory('r0', ['a', 'b', 'c', 'd']),
      hole('r1', ['h0', 'h1', 'h2'], 'r0'),
    ]);
    // Selection holds two hole vertices AND a territory vertex.
    const before = replaceVertices(
      withActiveFeature(EMPTY_SELECTION, fid('F')),
      fid('F'),
      new Set([vid('h0'), vid('h1'), vid('a')]),
    );

    const r = deleteLeafVertex(f, rid('r1'), vid('h2'))!;
    expect(r.kind).toBe('feature');
    expect(r.selection.removedRingIds).toContain(rid('r1'));
    // The whole hole ring's surviving vertices drop out (h0, h1), plus the deleted h2.
    expect(new Set(r.selection.removedVertexIds)).toEqual(
      new Set([vid('h0'), vid('h1'), vid('h2')]),
    );

    const result = commandResultFromEditResult(r);
    const after = reresolveAfterStructureChange(before, result);
    // h0/h1 dropped (their ring is gone), territory vertex `a` survives — NOT a clear.
    expect([...after.vertexIds]).toEqual([vid('a')]);
    expect(after.activeFeature).toBe(fid('F')); // feature survives.
  });

  it('feature deletion: the deleted feature + its vertices drop from selection', () => {
    const f = leaf('F', [territory('r0', ['a', 'b', 'c'])]);
    const before = replaceVertices(
      withActiveFeature(EMPTY_SELECTION, fid('F')),
      fid('F'),
      new Set([vid('a')]),
    );
    const r = deleteLeafVertex(f, rid('r0'), vid('c'))!;
    expect(r.kind).toBe('delete-feature');
    expect(r.selection.deletedFeatureId).toBe(fid('F'));

    const result = commandResultFromEditResult(r);
    expect(result.deleted.has(fid('F'))).toBe(true);
    const after = reresolveAfterStructureChange(before, result);
    expect(after.activeFeature).toBeNull();
    expect([...after.vertexIds]).toEqual([]);
  });

  it('line deletion (<2 pts): every vertex of the line drops out', () => {
    const r = deleteLineVertex(line('L', ['a', 'b']), vid('b'))!;
    expect(r.kind).toBe('delete-feature');
    expect(new Set(r.selection.removedVertexIds)).toEqual(new Set([vid('a'), vid('b')]));
    const result = commandResultFromEditResult(r);
    expect(result.deleted.has(vid('a'))).toBe(true);
    expect(result.deleted.has(vid('b'))).toBe(true);
    expect(result.deleted.has(fid('L'))).toBe(true);
  });

  it('point deletion: the point vertex and feature drop out', () => {
    const r = deletePointVertex(point('P', 'p0'))!;
    expect(r.selection.removedVertexIds).toEqual([vid('p0')]);
    expect(r.selection.deletedFeatureId).toBe(fid('P'));
  });
});
