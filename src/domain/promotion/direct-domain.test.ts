// U29 — buildDirectDomainShape の包含再親付け (reparentByContainment) 回帰テスト。
//
// バグハント2回目 発見の固定化: ringContains が inner[0] の単一頂点プローブだった頃、
// 量子化後に 穴/飛び地 の先頭頂点が候補リングの seam 境界線上に乗ると pointInPolygon が
// Boundary (≠ Inside) を返し『包含なし』と誤判定 → reparentByContainment が穴/飛び地を
// top-level territory へ誤昇格させ、直轄領形状の階層 (FR-24 領土→穴→領土→…) が崩れた。
// 修正で ringContains は geometry の境界堅牢な ringStrictlyContains へ委譲 (単一の真実源,
// knife/proposal.ts と同一)。このテストはまさにその seam 境界頂点ケースを実証する。

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { POINT_LOCATION, pointInPolygon, type GeoMultiPolygon } from '../geometry/index';
import { asRingId, asVertexId, type RingId, type VertexId } from '../ids';
import { RING_KIND } from '../ring';

import { buildDirectDomainShape, type DirectDomainIdPorts } from './direct-domain';

const c = createCoordinate;

function makeIdPorts(): DirectDomainIdPorts {
  let v = 0;
  let r = 0;
  return {
    nextVertexId: (): VertexId => {
      v += 1;
      return asVertexId(`dd-v-${v}`);
    },
    nextRingId: (): RingId => {
      r += 1;
      return asRingId(`dd-r-${r}`);
    },
  };
}

describe('buildDirectDomainShape — reparentByContainment seam-boundary 包含 (回帰)', () => {
  it('穴の先頭頂点が外側領土の境界線上に乗っても穴として正しく親付けされる (top-level 誤昇格しない)', () => {
    // 20x20 の外側領土に 10x10 の穴。穴の先頭頂点 (0,5) は外側領土の左辺 (x=0) の上に
    // 載っている (seam 境界頂点)。pointInPolygon((0,5)) は Boundary を返すため、旧 inner[0]
    // 単一頂点プローブはこの穴を「外側に含まれない」と誤判定し、穴を top-level 領土へ誤昇格
    // していた。整数度座標は量子化で不変なので、境界載りはそのまま保たれる。
    const outer = [c(0, 0), c(20, 0), c(20, 20), c(0, 20)];
    const hole = [c(0, 5), c(10, 5), c(10, 15), c(0, 15)];

    // 前提の固定: 穴の先頭頂点は確かに外側領土の境界上にある。
    expect(pointInPolygon(hole[0]!, [outer])).toBe(POINT_LOCATION.Boundary);

    const difference: GeoMultiPolygon = [[outer, hole]];

    const built = buildDirectDomainShape(difference, makeIdPorts());
    expect(built).toBeDefined();
    const rings = built!.shape.rings;

    // ちょうど 2 リング: 外側領土 1 + 穴 1。
    expect(rings).toHaveLength(2);

    const territories = rings.filter((r) => r.kind === RING_KIND.Territory);
    const holes = rings.filter((r) => r.kind === RING_KIND.Hole);

    // 修正前は穴が top-level 領土へ誤昇格して territories=2 / holes=0 になっていた。
    expect(territories).toHaveLength(1);
    expect(holes).toHaveLength(1);

    // 唯一の領土は top-level (親なし)、穴はその領土を親に持つ (FR-24 交互階層)。
    const territory = territories[0]!;
    const punched = holes[0]!;
    expect(territory.parentRingId).toBeUndefined();
    expect(punched.parentRingId).toBe(territory.id);
  });

  it('seam 越えの飛び地 (互いに素な 2 outer) は両方 top-level 領土として保持される (片落とし禁止)', () => {
    // 包含関係のない 2 つの outer ピースは どちらも親を持たず、同一直轄領の飛び地として
    // 2 つの top-level 領土になる。境界堅牢化が正当な「親なし」判定を壊していないことの確認。
    const pieceA = [c(0, 0), c(10, 0), c(10, 10), c(0, 10)];
    const pieceB = [c(50, 0), c(60, 0), c(60, 10), c(50, 10)];
    const difference: GeoMultiPolygon = [[pieceA], [pieceB]];

    const built = buildDirectDomainShape(difference, makeIdPorts());
    expect(built).toBeDefined();
    const rings = built!.shape.rings;

    expect(rings).toHaveLength(2);
    expect(rings.every((r) => r.kind === RING_KIND.Territory)).toBe(true);
    expect(rings.every((r) => r.parentRingId === undefined)).toBe(true);
  });
});
