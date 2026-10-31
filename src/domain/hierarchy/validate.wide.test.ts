// 子の和が半周を超えるまとめ役の隙間の判定。
//
// 途中の和に経度 180 度以上の辺があると、次の整列で別の形（裏回り）になり、子の間の隙間が見えなく
// なる。`checkAggregateShapes` は確定前の検査なので、見逃すと隙間のあるまとめ役が確定する。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createAggregateFeature, createLeafFeature, type Feature } from '../feature';
import { wrapLonDeg } from '../geo/index';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';

import { buildForest } from './forest';
import { checkAggregateShapes, HIERARCHY_VIOLATION } from './validate';

const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const AGG = asFeatureId('AGG');
const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const box = (w: number, s: number, e: number, n: number): WorldCoordinate[] => [
  c(w, s),
  c(e, s),
  c(e, n),
  c(w, n),
];

function run(children: readonly { id: string; outer: WorldCoordinate[]; hole?: WorldCoordinate[] }[]) {
  const vertices: Vertex[] = [];
  let n = 0;
  const mint = (ring: WorldCoordinate[]) =>
    ring.map((q) => {
      const v = createVertex(asVertexId(`v${(n += 1)}`), c(wrapLonDeg(q.lon), q.lat));
      vertices.push(v);
      return v.id;
    });
  const features: Feature[] = children.map((k) => {
    const outerId = asRingId(`${k.id}-o`);
    const rings: Ring[] = [createTerritoryRing(outerId, mint(k.outer))];
    if (k.hole !== undefined) rings.push(createHoleRing(asRingId(`${k.id}-h`), mint(k.hole), outerId));
    return createLeafFeature(
      asFeatureId(k.id),
      createBasicAttributes(k.id, 0, 0),
      COLOR,
      createShape(rings),
      { parentId: AGG },
    );
  });
  features.push(
    createAggregateFeature(AGG, createBasicAttributes('AGG', 0, 0), COLOR, children.map((k) => asFeatureId(k.id))),
  );
  return checkAggregateShapes(buildForest(features), createVertexStore(vertices)).map((v) => v.kind);
}

describe('子の和が半周を超えるまとめ役', () => {
  it('子の間に囲まれた隙間があれば、隙間と言う', () => {
    expect(
      run([
        { id: 'south-w', outer: box(0, 0, 120, 2) },
        { id: 'south-e', outer: box(120, 0, 240, 2) },
        { id: 'north-w', outer: box(0, 8, 120, 10) },
        { id: 'north-e', outer: box(120, 8, 240, 10) },
        { id: 'west', outer: box(0, 2, 1, 8) },
        { id: 'east', outer: box(239, 2, 240, 8) },
      ]),
    ).toEqual([HIERARCHY_VIOLATION.AggregateShapeMismatch]);
  });

  it('隙間なく並ぶ子には何も言わない', () => {
    expect(
      run([
        { id: 'a', outer: box(0, 0, 120, 10) },
        { id: 'b', outer: box(120, 0, 240, 10) },
        { id: 'c', outer: box(240, 0, 300, 10) },
      ]),
    ).toEqual([]);
  });

  it('子自身の穴は隙間と言わない', () => {
    expect(
      run([
        { id: 'a', outer: box(0, 0, 120, 10) },
        { id: 'b', outer: box(120, 0, 240, 10), hole: box(200, 2, 210, 8) },
        { id: 'c', outer: box(240, 0, 300, 10) },
      ]),
    ).toEqual([]);
  });
});
