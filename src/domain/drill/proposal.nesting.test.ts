// B109 — 穴あけの輪の入れ子は、輪の 1 点でなく輪全体で決める。
//
// 先頭の頂点が外周の上にある穴を 1 点で見ると「外周の中に無い」と読み違え、穴が最上位の領土になる。
// 期待値は手で数えた面積から書く。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature } from '../feature';
import { alignMultiPolygon } from '../geo/index';
import type { GeoRing } from '../geometry/index';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, RING_KIND } from '../ring';
import { validateRingHierarchy } from '../ring-hierarchy';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { executeDrill } from './drill-geometry';
import { freshIdPorts } from './fixtures';
import { assembleDrillProposal } from './proposal';

const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const c = createCoordinate;

function shoelace(ring: GeoRing): number {
  let sum = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    sum += a.lon * b.lat - b.lon * a.lat;
  });
  return Math.abs(sum) / 2;
}

function netArea(mp: readonly (readonly GeoRing[])[]): number {
  let total = 0;
  for (const poly of mp) poly.forEach((r, i) => (total += i === 0 ? shoelace(r) : -shoelace(r)));
  return total;
}

describe('assembleDrillProposal の輪の入れ子（B109）', () => {
  it('先頭の頂点が外周に接する穴を持つ面に穴をあけても、穴は穴のまま', () => {
    const vertices: Vertex[] = [];
    let n = 0;
    const mint = (points: readonly (readonly [number, number])[]) =>
      points.map(([lon, lat]) => {
        n += 1;
        const v = createVertex(asVertexId(`v${n}`), c(lon, lat));
        vertices.push(v);
        return v.id;
      });
    const outerId = asRingId('o');
    // 外周 [0,20]²（400）。穴の三角は左の頂点で西の辺に接する（底 2 × 高さ 3 ÷ 2 = 3）。
    const target = createLeafFeature(
      asFeatureId('T'),
      createBasicAttributes('T', 0, 0),
      COLOR,
      createShape([
        createTerritoryRing(outerId, mint([[0, 0], [20, 0], [20, 20], [0, 20]])),
        createHoleRing(asRingId('h'), mint([[0, 5], [3, 4], [3, 6]]), outerId),
      ]),
    );
    const store = createVertexStore(vertices);
    // 別の所へ 2 × 2 の穴をあける（4）。
    const geometry = executeDrill(target, store, [c(10, 10), c(12, 10), c(12, 12), c(10, 12)]);
    if (geometry === undefined) throw new Error('穴あけが断られた');

    const proposal = assembleDrillProposal({
      target,
      store,
      geometry,
      newProperties: { attributes: createBasicAttributes('N', 0, 0), color: COLOR },
      ids: freshIdPorts(),
    });

    const after = proposal.holedShape;
    expect(after.rings.filter((r) => r.kind === RING_KIND.Territory)).toHaveLength(1);
    expect(after.rings.filter((r) => r.kind === RING_KIND.Hole)).toHaveLength(2);
    const allVertices = createVertexStore([...vertices, ...proposal.vertices]);
    expect(validateRingHierarchy(after, allVertices).violations).toEqual([]);
    expect(netArea(alignMultiPolygon(resolveLeafShape(after, allVertices)!))).toBeCloseTo(400 - 3 - 4, 6);
  });
});
