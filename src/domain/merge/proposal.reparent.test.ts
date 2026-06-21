// U30 結合 — reparentByContainment 境界堅牢包含 (bughunt2 回帰).
//
// バグハント2回目 発見の固定化: merge/proposal.ts の reparentByContainment は
// alignedRingContains という inner[0] の単一頂点プローブで包含を判定していた。量子化後、
// ドーナツ状 union の穴リング先頭頂点はシーム接合や共有辺で外環境界線上へ落ちやすく、そこ
// では pointInPolygon が Boundary (≠ Inside) を返すため、本当に入れ子の穴を「非包含」と
// 誤判定していた。誤判定すると穴が createTerritoryRing で最上位領土へ降格され (片落とし
// 禁止分岐)、交互不変条件 (FR-24 領土→穴→領土→…) が崩れ、isAlternationValid が false に
// なって LeafOnly 結合が kind 'hierarchy' / MSG_MERGE_INTERNAL で不当に拒否されていた。
//
// 修正で alignedRingContains は geometry の境界堅牢な ringStrictlyContains へ委譲する
// (単一の真実源, knife/proposal.ts と promotion/direct-domain.ts と同一)。本テストはまさに
// その「穴の先頭頂点が外環境界線上に乗る」ケースを実証する。boolean-op による頂点再並びに
// 依存しないよう、整列済みリングから直接 Shape を組む段 (__test_buildShapeFromMultiPolygon)
// を呼び出して決定的に検証する (sibling の direct-domain.test.ts が buildDirectDomainShape
// を直接叩くのと同じ構成)。

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import {
  POINT_LOCATION,
  pointInPolygon,
  type GeoMultiPolygon,
} from '../geometry/index';
import { asFeatureId, asRingId, asVertexId, type RingId, type VertexId } from '../ids';
import { isAlternationValid, RING_KIND } from '../ring';

import {
  __test_buildShapeFromMultiPolygon as buildShapeFromMultiPolygon,
  type MergeIdPorts,
} from './proposal';

const c = createCoordinate;

function makeIdPorts(): MergeIdPorts {
  let f = 0;
  let v = 0;
  let r = 0;
  return {
    nextFeatureId: () => asFeatureId(`rp-f-${f++}`),
    nextVertexId: (): VertexId => asVertexId(`rp-v-${v++}`),
    nextRingId: (): RingId => asRingId(`rp-r-${r++}`),
  };
}

describe('U30 結合 — reparentByContainment 境界頂点の穴 (bughunt2 回帰)', () => {
  it('穴の先頭頂点が外環の境界線上に乗っても穴として正しく親付けされ交互階層が保たれる', () => {
    // 20x20 の外環領土に 10x10 の穴。穴の頂点列は先頭 (0,5) が外環の左辺 (x=0) の上に
    // 載るように並べてある (seam/共有辺で起こる「境界載り先頭頂点」を整数度で再現)。整数度
    // 座標は量子化で不変なので境界載りはそのまま保たれる。
    const outer = [c(0, 0), c(20, 0), c(20, 20), c(0, 20)];
    const hole = [c(0, 5), c(10, 5), c(10, 15), c(0, 15)];

    // 前提の固定: 穴の先頭頂点は確かに外環の境界線上にある (Boundary, Inside ではない)。
    // これが旧 inner[0] 単一頂点プローブを騙していた条件そのもの。
    expect(pointInPolygon(hole[0]!, [outer])).toBe(POINT_LOCATION.Boundary);

    // ドーナツ (外環 + 穴) を 1 ポリゴンとして渡す。整列はこの段の内部で共通アンカーへ
    // 巻き上げ済み。
    const mp: GeoMultiPolygon = [[outer, hole]];

    const built = buildShapeFromMultiPolygon(mp, makeIdPorts());
    const rings = built.shape.rings;

    const territories = rings.filter((r) => r.kind === RING_KIND.Territory);
    const holes = rings.filter((r) => r.kind === RING_KIND.Hole);

    // 修正前は穴が top-level 領土へ誤昇格して territories=2 / holes=0 になり、交互不変条件が
    // 崩れていた。修正後はちょうど 領土 1 + 穴 1。
    expect(territories).toHaveLength(1);
    expect(holes).toHaveLength(1);

    // 穴はその外環を親に持つ (孤立穴の領土降格ではない)。
    const territory = territories[0]!;
    const punched = holes[0]!;
    expect(territory.parentRingId).toBeUndefined();
    expect(punched.parentRingId).toBe(territory.id);

    // FR-24 交互不変条件が成立する (= LeafOnly 結合が 'hierarchy'/MSG_MERGE_INTERNAL で
    // 不当に拒否されない)。修正前はここが false になり結合全体が拒否されていた。
    expect(isAlternationValid(built.shape)).toBe(true);
  });

  it('境界堅牢化は正当な「親なし」判定を壊さない: 互いに素な 2 外環は両方 top-level 領土', () => {
    // 包含関係のない 2 つの外環ピースは どちらも親を持たず 2 つの top-level 領土になる
    // (飛び地, 片落とし禁止)。境界堅牢な述語が正当な非包含を保つことの確認。
    const pieceA = [c(0, 0), c(10, 0), c(10, 10), c(0, 10)];
    const pieceB = [c(50, 0), c(60, 0), c(60, 10), c(50, 10)];
    const mp: GeoMultiPolygon = [[pieceA], [pieceB]];

    const built = buildShapeFromMultiPolygon(mp, makeIdPorts());
    const rings = built.shape.rings;

    expect(rings).toHaveLength(2);
    expect(rings.every((r) => r.kind === RING_KIND.Territory)).toBe(true);
    expect(rings.every((r) => r.parentRingId === undefined)).toBe(true);
    expect(isAlternationValid(built.shape)).toBe(true);
  });
});
