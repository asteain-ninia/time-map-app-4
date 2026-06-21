// U30 結合の世界シーム整列テスト (audit root cause A の横展開).
//
// unionLeafShapes / reparentByContainment.ringContains はいずれも resolveLeafShape の
// RAW representative 座標を消費する。シームをまたいで隣接する 2 末端 (+179 付近 と −179
// 付近) は representative 空間で ~360° 離れて格納され得るため、整列せず U06 union に
// 渡すと「逆回り ~358°」で別片に散らばる。共有ヘルパ alignMultiPolygon /
// referenceLonForMultiPolygon (drill / 集約 union / unwrapShape と同一の単一真実源) で
// 共通 world-turn へ揃えてから演算することを固定する。

import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createLeafFeature, type Feature, type LeafFeature } from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, RING_KIND } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import {
  MERGE_STATUS,
  buildMergeProposal,
  type MergeProposal,
} from './proposal';
import { parentNone, propertyNew } from './decision';
import { makeIdPorts, COLOR } from './fixtures';
import { createBasicAttributes } from '../attributes';

/** A quad leaf from an explicit (possibly seam-folded / reordered) coordinate ring. */
function quadLeaf(
  featureId: string,
  coords: readonly WorldCoordinate[],
): { feature: LeafFeature; vertices: readonly Vertex[] } {
  const vertices: Vertex[] = [];
  const vertexIds: VertexId[] = [];
  coords.forEach((c, i) => {
    const vid = asVertexId(`${featureId}-v${i}`);
    vertices.push(createVertex(vid, c));
    vertexIds.push(vid);
  });
  const ring = createTerritoryRing(asRingId(`${featureId}-r0`), vertexIds);
  const attrs = createBasicAttributes(featureId, 0, 100);
  const feature = createLeafFeature(asFeatureId(featureId), attrs, COLOR, createShape([ring]));
  return { feature, vertices };
}

/**
 * A donut leaf: one outer territory ring with one hole ring inside it (FR-24
 * 領土→穴 交互階層). Both rings are explicit coordinate quads.
 */
function donutLeaf(
  featureId: string,
  outerCoords: readonly WorldCoordinate[],
  holeCoords: readonly WorldCoordinate[],
): { feature: LeafFeature; vertices: readonly Vertex[] } {
  const vertices: Vertex[] = [];
  const mint = (coords: readonly WorldCoordinate[], tag: string): VertexId[] => {
    const ids: VertexId[] = [];
    coords.forEach((c, i) => {
      const vid = asVertexId(`${featureId}-${tag}${i}`);
      vertices.push(createVertex(vid, c));
      ids.push(vid);
    });
    return ids;
  };
  const outerRingId = asRingId(`${featureId}-r0`);
  const outerRing = createTerritoryRing(outerRingId, mint(outerCoords, 'o'));
  const holeRing = createHoleRing(asRingId(`${featureId}-h0`), mint(holeCoords, 'h'), outerRingId);
  const attrs = createBasicAttributes(featureId, 0, 100);
  const feature = createLeafFeature(
    asFeatureId(featureId),
    attrs,
    COLOR,
    createShape([outerRing, holeRing]),
  );
  return { feature, vertices };
}

function storeOf(...leaves: readonly { vertices: readonly Vertex[] }[]): VertexStore {
  const all: Vertex[] = [];
  for (const l of leaves) all.push(...l.vertices);
  return createVertexStore(all);
}

function proposalOf(r: ReturnType<typeof buildMergeProposal>): MergeProposal {
  if (r.status !== MERGE_STATUS.Proposal) {
    throw new Error(`expected proposal, got ${JSON.stringify(r)}`);
  }
  return r.proposal;
}

/** Count distinct territory (outer) rings in a built shape. */
function territoryRingCount(features: readonly Feature[], resultId: FeatureId): number {
  const result = features.find((f) => f.id === resultId);
  if (result === undefined || result.kind !== 'leaf') {
    throw new Error('result leaf not found');
  }
  return result.shape.rings.filter((r) => r.kind === 'territory').length;
}

describe('U30 結合 — 世界シーム整列 (root cause A 横展開)', () => {
  it('シームをまたいで隣接する 2 末端の論理和が 1 連続片へ結合される (~360° に散らばらない)', () => {
    // A: 経度 [170,180]×[0,10] (東端). B: 経度 [-180,-170]×[0,10] (西端, representative).
    // 連続フレームでは 180 == -180 を共有辺として隣接し [170,190]×[0,10] の 1 矩形。
    const a = quadLeaf('a', [
      createCoordinate(170, 0),
      createCoordinate(180, 0),
      createCoordinate(180, 10),
      createCoordinate(170, 10),
    ]);
    const b = quadLeaf('b', [
      createCoordinate(-180, 0),
      createCoordinate(-170, 0),
      createCoordinate(-170, 10),
      createCoordinate(-180, 10),
    ]);
    const features = [a.feature, b.feature];
    const store = storeOf(a, b);

    const result = buildMergeProposal({
      features,
      vertices: store,
      targetIds: [a.feature.id, b.feature.id],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('seam'),
    });

    const proposal = proposalOf(result);
    // Aligned union joins the seam-adjacent rectangles into a SINGLE territory.
    // Without alignment they land ~360° apart and the union yields two disjoint
    // territory rings (the regression this fixes).
    expect(territoryRingCount(proposal.nextFeatures, proposal.resultFeatureId)).toBe(1);
  });

  it('先頭頂点がシーム反対側から始まるだけの 2 末端でも 1 片に結合される', () => {
    // 同じ 2 矩形だが、A の頂点列の開始を東端 (180) に、B の開始を西端 (-180) にずらす。
    // per-ring 独立 unwrap は先頭頂点アンカーなので、整列が無いと別 turn に着地する。
    const a = quadLeaf('a', [
      createCoordinate(180, 0),
      createCoordinate(180, 10),
      createCoordinate(170, 10),
      createCoordinate(170, 0),
    ]);
    const b = quadLeaf('b', [
      createCoordinate(-180, 10),
      createCoordinate(-180, 0),
      createCoordinate(-170, 0),
      createCoordinate(-170, 10),
    ]);
    const features = [a.feature, b.feature];
    const store = storeOf(a, b);

    const result = buildMergeProposal({
      features,
      vertices: store,
      targetIds: [a.feature.id, b.feature.id],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('seam2'),
    });

    const proposal = proposalOf(result);
    expect(territoryRingCount(proposal.nextFeatures, proposal.resultFeatureId)).toBe(1);
  });

  it('シーム結合後の新頂点は representative で格納され FR-95 旧→新対応が周期同一点を取りこぼさない', () => {
    // A の東端頂点 (180) と B の西端頂点 (-180) は周期的に同一点。整列は連続フレーム
    // (>180°) で union するため、整列結果を素朴に minting すると新頂点が 190° のような
    // 非 representative 値で格納され、representative で格納された旧頂点 (-170 等) と
    // coordKey が一致せず remap が取りこぼす (Codex finding 3)。coordKey / 格納を
    // representative へ正規化することで (1) 新頂点は全て |lon|<=180、(2) 共有点を含む
    // 旧頂点が漏れなく remap される。
    const a = quadLeaf('a', [
      createCoordinate(170, 0),
      createCoordinate(180, 0),
      createCoordinate(180, 10),
      createCoordinate(170, 10),
    ]);
    const b = quadLeaf('b', [
      createCoordinate(-180, 0),
      createCoordinate(-170, 0),
      createCoordinate(-170, 10),
      createCoordinate(-180, 10),
    ]);
    const features = [a.feature, b.feature];
    const store = storeOf(a, b);

    const result = buildMergeProposal({
      features,
      vertices: store,
      targetIds: [a.feature.id, b.feature.id],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('remap'),
    });

    const proposal = proposalOf(result);
    // (1) 新頂点は全て representative。
    const newVertices = [...proposal.nextVertices.byId.values()].filter((v) =>
      v.id.startsWith('remap-v'),
    );
    expect(newVertices.length).toBeGreaterThan(0);
    for (const v of newVertices) {
      expect(Math.abs(v.coordinate.lon)).toBeLessThanOrEqual(180);
    }
    // (2) 結合後も角に残る旧頂点 (各矩形の外側 2 角 ×2 = 4) が周期同一の新頂点へ remap
    //     される。整列前は新頂点が 190° で格納され、−170° 角の旧頂点が coordKey 不一致で
    //     取りこぼされ remap が 4 未満になっていた (FR-95 取りこぼし)。
    expect(proposal.vertexRemap.size).toBe(4);
  });

  it('シームから離れた通常 2 末端の結合は不変 (整列は恒等; 非隣接は飛び地で全片採用)', () => {
    // 非隣接 (赤道付近の離れた 2 矩形) は 2 領土リング (飛び地) のまま — 整列が
    // single-branch で恒等変換であり通常系を壊さないことの確認。
    const a = quadLeaf('a', [
      createCoordinate(0, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(0, 10),
    ]);
    const b = quadLeaf('b', [
      createCoordinate(40, 0),
      createCoordinate(50, 0),
      createCoordinate(50, 10),
      createCoordinate(40, 10),
    ]);
    const features = [a.feature, b.feature];
    const store = storeOf(a, b);

    const result = buildMergeProposal({
      features,
      vertices: store,
      targetIds: [a.feature.id, b.feature.id],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('disj'),
    });

    const proposal = proposalOf(result);
    expect(territoryRingCount(proposal.nextFeatures, proposal.resultFeatureId)).toBe(2);
  });

  it('シームをまたぐドーナツ領土の穴が再親付けで外環の下へ正しく階層化される (reparentByContainment 整列巻き上げの回帰)', () => {
    // bughunt2 回帰: reparentByContainment は各リングペアの整列を内側ループから巻き上げ、
    // 全リングを 1 つの共通アンカーへ一度だけ揃えてから素の包含走査を行うよう最適化した。
    // シームをまたぐドーナツ (外環が連続フレームで [170,190]、その内側に穴) を結合すると、
    // 外環と穴は representative 格納で別 turn に着地し得る。整列を正しく巻き上げていれば
    // 包含判定は per-pair 整列と等価で、穴は外環の直接の子 (territory→hole) として階層化
    // される。巻き上げが等価でなければ穴が外環に包含されないと誤判定され、孤立穴が領土へ
    // 降格 (片落とし禁止の分岐) して交互階層が崩れる。
    //
    // 外環: 連続フレーム [170,190]×[0,20] をシーム折り返しで表現 (170,180,-180,-170)。
    // 穴:   連続フレーム [175,185]×[5,15] を同様に表現。union は穴を保つ。
    const donut = donutLeaf(
      'donut',
      [
        createCoordinate(170, 0),
        createCoordinate(180, 0),
        createCoordinate(-180, 0),
        createCoordinate(-170, 0),
        createCoordinate(-170, 20),
        createCoordinate(-180, 20),
        createCoordinate(180, 20),
        createCoordinate(170, 20),
      ],
      [
        createCoordinate(175, 5),
        createCoordinate(180, 5),
        createCoordinate(-180, 5),
        createCoordinate(-175, 5),
        createCoordinate(-175, 15),
        createCoordinate(-180, 15),
        createCoordinate(180, 15),
        createCoordinate(175, 15),
      ],
    );
    // 結合相手: シーム反対側でドーナツ外環に隣接する矩形 (穴へは入らない)。union は外環を
    // 西へ拡張するだけで穴はそのまま残り、再親付け対象の領土→穴ペアが生成される。
    const neighbor = quadLeaf('nb', [
      createCoordinate(-170, 0),
      createCoordinate(-160, 0),
      createCoordinate(-160, 20),
      createCoordinate(-170, 20),
    ]);
    const features = [donut.feature, neighbor.feature];
    const store = storeOf(donut, neighbor);

    const result = buildMergeProposal({
      features,
      vertices: store,
      targetIds: [donut.feature.id, neighbor.feature.id],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('donut'),
    });

    const proposal = proposalOf(result);
    const merged = proposal.nextFeatures.find((f) => f.id === proposal.resultFeatureId);
    if (merged === undefined || merged.kind !== 'leaf') {
      throw new Error('merged result leaf not found');
    }
    // 単一連続外環 1 つ。
    const territories = merged.shape.rings.filter((r) => r.kind === RING_KIND.Territory);
    const holes = merged.shape.rings.filter((r) => r.kind === RING_KIND.Hole);
    expect(territories.length).toBe(1);
    // 穴が 1 つ残り、その親が外環 (孤立穴の領土降格ではない) である。
    expect(holes.length).toBe(1);
    expect(holes[0]!.parentRingId).toBe(territories[0]!.id);
  });
});
