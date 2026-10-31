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
import { alignMultiPolygon, wrapLonDeg } from '../geo/index';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
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
import { MSG_MERGE_LONG_EDGE } from './messages';
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

// --- 1 辺で経度 180 度以上を渡る辺 (N-51 / 技術方針 §6.8) --------------------
//
// 保存形式は「隣り合う頂点は最短方向で繋がっている」と仮定して経度を連続量へ戻すので、
// 1 辺で 180 度以上を渡る形は保存して読み直すと必ず別の形になる。追加の道具では既に
// 断っているので、結合でも同じ関門を通す (増分 3 の手直し / 教訓 5.29 単一真実源)。

describe('U30 結合 — 1 辺で経度 180 度以上を渡る結果は断る (N-51)', () => {
  it('横長の面どうしを結合すると、外周が 1 本の長い辺に化けるので断られる', () => {
    // A は経度 [-170,0]、B は [0,170]。どちらも途中に頂点があるので 1 辺は 90 度以下 ――
    // それぞれ単体では保存できる形である。ところが論理和は一直線上に並ぶ途中の頂点を
    // 落とすので、結合後の下辺・上辺が −170°→170° の「1 本で 340 度」になってしまう。
    const a = quadLeaf('wa', [
      createCoordinate(-170, 0),
      createCoordinate(-90, 0),
      createCoordinate(0, 0),
      createCoordinate(0, 10),
      createCoordinate(-90, 10),
      createCoordinate(-170, 10),
    ]);
    const b = quadLeaf('wb', [
      createCoordinate(0, 0),
      createCoordinate(90, 0),
      createCoordinate(170, 0),
      createCoordinate(170, 10),
      createCoordinate(90, 10),
      createCoordinate(0, 10),
    ]);

    const result = buildMergeProposal({
      features: [a.feature, b.feature],
      vertices: storeOf(a, b),
      targetIds: [a.feature.id, b.feature.id],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('wide'),
    });

    expect(result.status).toBe(MERGE_STATUS.Rejected);
    if (result.status === MERGE_STATUS.Rejected) {
      expect(result.kind).toBe('long-edge');
      expect(result.message).toBe(MSG_MERGE_LONG_EDGE);
    }
  });

  it('日付変更線をまたいで隣り合う面どうしの結合は断られない (誤爆防止)', () => {
    // 代表値では 175° の隣に −175° が来るが、連続経度では [160,190] の幅 30 度の 1 片で、
    // 長い辺は 1 本も無い。畳んだ値のまま数えると 350 度に見えてしまうので、この形が
    // 通ることを固定する (long-edge.ts の「入力は連続経度」の契約)。
    const a = quadLeaf('sa', [
      createCoordinate(160, 0),
      createCoordinate(175, 0),
      createCoordinate(175, 10),
      createCoordinate(160, 10),
    ]);
    const b = quadLeaf('sb', [
      createCoordinate(175, 0),
      createCoordinate(-170, 0),
      createCoordinate(-170, 10),
      createCoordinate(175, 10),
    ]);

    const result = buildMergeProposal({
      features: [a.feature, b.feature],
      vertices: storeOf(a, b),
      targetIds: [a.feature.id, b.feature.id],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('seam-ok'),
    });

    const proposal = proposalOf(result);
    expect(territoryRingCount(proposal.nextFeatures, proposal.resultFeatureId)).toBe(1);
  });
});

describe('B106 離れた片の穴が結合で消えない・領土にならない', () => {
  const box = (w: number, so: number, e: number, n: number): WorldCoordinate[] =>
    [
      [w, so],
      [e, so],
      [e, n],
      [w, n],
    ].map(([lon, lat]) => createCoordinate(wrapLonDeg(lon!), lat!));

  function merge(a: ReturnType<typeof quadLeaf>, b: ReturnType<typeof quadLeaf>): MergeProposal {
    return proposalOf(
      buildMergeProposal({
        features: [a.feature, b.feature],
        vertices: storeOf(a, b),
        targetIds: [a.feature.id, b.feature.id],
        atTime: 0,
        parentDecision: parentNone,
        propertyDecision: propertyNew({
          attributes: createBasicAttributes('結合', 0, 100),
          color: COLOR,
        }),
        ids: makeIdPorts('b106'),
      }),
    );
  }

  function ringCounts(p: MergeProposal): { territories: number; holes: number } {
    const leaf = p.nextFeatures.find((f) => f.id === p.resultFeatureId) as LeafFeature;
    const holes = leaf.shape.rings.filter((r) => r.kind === RING_KIND.Hole).length;
    return { territories: leaf.shape.rings.length - holes, holes };
  }

  it('経度 0 付近の面と、平均 181 の穴を持つ 170..190 の面（和の整列で穴が消えていた）', () => {
    const near = quadLeaf('near', box(-10, 0, 10, 20));
    const far = donutLeaf('far', box(170, 0, 190, 20), box(178, 5, 184, 8));
    expect(ringCounts(merge(near, far))).toEqual({ territories: 2, holes: 1 });
    expect(ringCounts(merge(far, near))).toEqual({ territories: 2, holes: 1 });
  });

  it('外周の平均 179・穴の平均 181（入れ子の組み立ての寄せ直しで穴が領土になっていた）', () => {
    const near = quadLeaf('near', box(-10, 0, 10, 20));
    const far = donutLeaf('far', box(168, 0, 190, 20), box(178, 5, 184, 8));
    expect(ringCounts(merge(near, far))).toEqual({ territories: 2, holes: 1 });
  });
});

describe('B105 途中の和に長い辺ができても、次の和で形が崩れない', () => {
  /** 南北の辺を 40 度ごとにまっすぐ刻んだ帯。 */
  function band(w: number, e: number): WorldCoordinate[] {
    const ring: WorldCoordinate[] = [];
    for (let lon = w; lon < e; lon += 40) ring.push(createCoordinate(lon, 0));
    ring.push(createCoordinate(e, 0), createCoordinate(e, 30));
    for (let lon = e - 40; lon > w; lon -= 40) ring.push(createCoordinate(lon, 30));
    ring.push(createCoordinate(w, 30));
    return ring;
  }

  it('2 つの帯の和（幅 340 度の 1 本の辺）に、辺を南北に断つ 3 つ目を足す', () => {
    const a = quadLeaf('a', band(-170, 0));
    const b = quadLeaf('b', band(0, 170));
    // 経度 -5..5 を南北に貫くので、最後の和の辺はどれも 180 度未満になる。
    const cut = quadLeaf('c', [
      createCoordinate(-5, -20),
      createCoordinate(5, -20),
      createCoordinate(5, 50),
      createCoordinate(-5, 50),
    ]);
    const p = proposalOf(
      buildMergeProposal({
        features: [a.feature, b.feature, cut.feature],
        vertices: storeOf(a, b, cut),
        targetIds: [a.feature.id, b.feature.id, cut.feature.id],
        atTime: 0,
        parentDecision: parentNone,
        propertyDecision: propertyNew({
          attributes: createBasicAttributes('結合', 0, 100),
          color: COLOR,
        }),
        ids: makeIdPorts('b105'),
      }),
    );
    const leaf = p.nextFeatures.find((f) => f.id === p.resultFeatureId) as LeafFeature;
    const mp = alignMultiPolygon(resolveLeafShape(leaf.shape, p.nextVertices)!);
    let doubled = 0;
    mp[0]![0]!.forEach((q, i, ring) => {
      const r = ring[(i + 1) % ring.length]!;
      doubled += q.lon * r.lat - r.lon * q.lat;
    });
    // 340×30 ＋ 10×70 − 重なり 10×30。
    expect(Math.abs(doubled) / 2).toBeCloseTo(10_600, 5);
  });
});

describe('結合の順で結果が変わらない（途中の和の長い辺）', () => {
  const box = (w: number, s: number, e: number, n: number): WorldCoordinate[] => [
    createCoordinate(w, s),
    createCoordinate(e, s),
    createCoordinate(e, n),
    createCoordinate(w, n),
  ];

  it.each([
    ['A B C', ['a', 'b', 'c']],
    ['C A B', ['c', 'a', 'b']],
    ['A C B', ['a', 'c', 'b']],
    ['C B A', ['c', 'b', 'a']],
    ['B C A', ['b', 'c', 'a']],
  ])('順 %s で結合でき、面積が足し算と合う', (_name, order) => {
    const a = quadLeaf('a', box(0, 0, 120, 10));
    const b = quadLeaf('b', box(120, 0, 240, 10));
    const c = quadLeaf('c', box(170, -5, 250, 15));
    const byName = new Map([['a', a], ['b', b], ['c', c]]);
    const result = buildMergeProposal({
      features: [a.feature, b.feature, c.feature],
      vertices: storeOf(a, b, c),
      targetIds: order.map((name) => byName.get(name)!.feature.id),
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts('wide'),
    });
    if (result.status !== MERGE_STATUS.Proposal) throw new Error(result.kind);
    const merged = result.proposal.nextFeatures.find((f) => f.kind === 'leaf');
    if (merged === undefined || merged.kind !== 'leaf') throw new Error('結果の末端が無い');
    const mp = alignMultiPolygon(resolveLeafShape(merged.shape, result.proposal.nextVertices)!);
    let area = 0;
    for (const poly of mp) {
      poly.forEach((ring, r) => {
        let s = 0;
        ring.forEach((p, i) => {
          const q = ring[(i + 1) % ring.length]!;
          s += p.lon * q.lat - q.lon * p.lat;
        });
        area += (r === 0 ? 1 : -1) * Math.abs(s / 2);
      });
    }
    // A 1200 + B 1200 + C 80 × 20 − C と B の重なり 70 × 10。
    expect(area).toBeCloseTo(1200 + 1200 + 1600 - 700, 6);
  });
});
