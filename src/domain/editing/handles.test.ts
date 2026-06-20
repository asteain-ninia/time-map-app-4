// U24 受け入れ基準1 — handle model (FR-87).

import { describe, expect, it } from 'vitest';

import { computeHandles, HANDLE_KIND, EMPTY_HANDLES } from './handles';
import { fid, leaf, line, point, rid, store, territory, hole, vid } from './fixtures';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createAggregateFeature } from '../feature';

describe('computeHandles (FR-87 受け入れ基準1)', () => {
  it('point feature → one vertex handle, no edge handles', () => {
    const h = computeHandles(point('P', 'p0'), store(['p0', 10, 20]));
    expect(h.vertices).toHaveLength(1);
    expect(h.edges).toHaveLength(0);
    const vh = h.vertices[0]!;
    expect(vh.kind).toBe(HANDLE_KIND.Vertex);
    expect(vh.vertexId).toBe(vid('p0'));
    expect(vh.position).toEqual({ lon: 10, lat: 20 });
  });

  it('line feature → a vertex handle per vertex, edge handles between (open path, no wrap)', () => {
    const h = computeHandles(line('L', ['a', 'b', 'c']), store(['a', 0, 0], ['b', 2, 0], ['c', 4, 0]));
    expect(h.vertices).toHaveLength(3);
    // Open path: 3 vertices → 2 edges (NO closing c→a edge).
    expect(h.edges).toHaveLength(2);
    expect(h.edges[0]!.midpoint).toEqual({ lon: 1, lat: 0 });
    expect(h.edges[0]!.startVertexId).toBe(vid('a'));
    expect(h.edges[0]!.endVertexId).toBe(vid('b'));
    expect(h.edges.every((e) => e.kind === HANDLE_KIND.Edge)).toBe(true);
  });

  it('leaf feature → closed ring edge handles (last→first included) with ring origin', () => {
    const t = territory('r0', ['a', 'b', 'c']);
    const h = computeHandles(leaf('F', [t]), store(['a', 0, 0], ['b', 4, 0], ['c', 0, 4]));
    expect(h.vertices).toHaveLength(3);
    // Closed ring: 3 vertices → 3 edges (incl. c→a closing edge).
    expect(h.edges).toHaveLength(3);
    expect(h.vertices.every((v) => v.ringId === rid('r0'))).toBe(true);
    // closing edge c→a present:
    const closing = h.edges.find((e) => e.startVertexId === vid('c') && e.endVertexId === vid('a'));
    expect(closing).toBeDefined();
    expect(closing!.midpoint).toEqual({ lon: 0, lat: 2 });
  });

  it('leaf feature with hole + enclave → every ring gets its own handles (穴/飛び地)', () => {
    const outer = territory('r0', ['a', 'b', 'c', 'd']);
    const theHole = hole('r1', ['h0', 'h1', 'h2'], 'r0');
    const enclave = territory('r2', ['e0', 'e1', 'e2'], 'r1');
    const f = leaf('F', [outer, theHole, enclave]);
    const s = store(
      ['a', 0, 0], ['b', 10, 0], ['c', 10, 10], ['d', 0, 10],
      ['h0', 2, 2], ['h1', 4, 2], ['h2', 3, 4],
      ['e0', 3, 3], ['e1', 3.4, 3], ['e2', 3.2, 3.4],
    );
    const h = computeHandles(f, s);
    // 4 + 3 + 3 vertices, and a closed-edge per ring (4 + 3 + 3).
    expect(h.vertices).toHaveLength(10);
    expect(h.edges).toHaveLength(10);
    // Each ring's vertices carry its own ringId.
    expect(h.vertices.filter((v) => v.ringId === rid('r1'))).toHaveLength(3);
    expect(h.vertices.filter((v) => v.ringId === rid('r2'))).toHaveLength(3);
  });

  it('aggregate feature → no handles (FR-35, 教訓5.25)', () => {
    const agg = createAggregateFeature(
      fid('AGG'),
      createBasicAttributes('agg', 0, 100),
      createColorInfo(true, '#1', '#2', '#3'),
      [fid('child')],
    );
    expect(computeHandles(agg, store())).toEqual(EMPTY_HANDLES);
  });

  it('unresolvable vertices are skipped (noUncheckedIndexedAccess discipline)', () => {
    // vertex "b" missing from store.
    const h = computeHandles(line('L', ['a', 'b']), store(['a', 0, 0]));
    expect(h.vertices).toHaveLength(1);
  });
});
