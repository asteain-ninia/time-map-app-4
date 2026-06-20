// U24 受け入れ基準2 — feature move (FR-88 / FR-30): all vertices by one vector,
// shared vertices deduped (moved once → every citing shape follows via U11).

import { describe, expect, it } from 'vitest';

import { featureVertexIds, moveFeatureVertices, moveVertexSet, moveVertexTo } from './move';
import { coord, leaf, line, point, store, territory, vid } from './fixtures';
import { getVertex } from '../vertex';

describe('featureVertexIds (dedupe shared)', () => {
  it('point → its single vertex', () => {
    expect(featureVertexIds(point('P', 'p0'))).toEqual([vid('p0')]);
  });

  it('leaf with a shared vertex across rings → that id appears once', () => {
    // Two rings citing the same vertex "s" (a shared vertex).
    const f = leaf('F', [territory('r0', ['a', 'b', 's']), territory('r1', ['s', 'c', 'd'], undefined)]);
    const ids = featureVertexIds(f);
    expect(ids.filter((x) => x === vid('s'))).toHaveLength(1);
  });
});

describe('moveFeatureVertices (受け入れ基準2)', () => {
  it('moves every vertex by the same vector', () => {
    const f = line('L', ['a', 'b']);
    const s = store(['a', 0, 0], ['b', 2, 0]);
    const moved = moveFeatureVertices(f, s, { dLon: 10, dLat: 5 });
    expect(moved).toHaveLength(2);
    expect(moved.map((v) => v.coordinate)).toEqual([
      { lon: 10, lat: 5 },
      { lon: 12, lat: 5 },
    ]);
  });

  it('a shared vertex is moved exactly once (FR-30 連動は U11 が一度の更新で波及)', () => {
    const f = leaf('F', [territory('r0', ['a', 's']), territory('r1', ['s', 'b'])]);
    const s = store(['a', 0, 0], ['s', 1, 1], ['b', 2, 2]);
    const moved = moveFeatureVertices(f, s, { dLon: 1, dLat: 0 });
    // a, s, b → 3 distinct bodies (s once), not 4.
    expect(moved).toHaveLength(3);
    expect(moved.filter((v) => v.id === vid('s'))).toHaveLength(1);
  });
});

describe('moveVertexSet (FR-80 simultaneous move as one op)', () => {
  it('moves a selection set by one vector', () => {
    const s = store(['a', 0, 0], ['b', 5, 5], ['c', 9, 9]);
    const moved = moveVertexSet([vid('a'), vid('c')], s, { dLon: -1, dLat: 1 });
    expect(moved.map((v) => v.id)).toEqual([vid('a'), vid('c')]);
    expect(moved[0]!.coordinate).toEqual({ lon: -1, lat: 1 });
  });
});

describe('moveVertexTo (single vertex absolute)', () => {
  it('moves a vertex to an absolute coordinate', () => {
    const s = store(['a', 0, 0]);
    const v = moveVertexTo(vid('a'), s, coord(7, 8))!;
    expect(v.coordinate).toEqual({ lon: 7, lat: 8 });
    // input store unchanged (immutable)
    expect(getVertex(s, vid('a'))!.coordinate).toEqual({ lon: 0, lat: 0 });
  });

  it('returns undefined for an unknown vertex', () => {
    expect(moveVertexTo(vid('nope'), store(), coord(0, 0))).toBeUndefined();
  });
});
