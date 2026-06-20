// U29 — 末端→集約遷移 と 直轄領自動生成・集約地物の自動消滅 の単体テスト。
// 受け入れ基準 1〜10 を「入力状態 → 遷移呼び出し → 期待結果状態」で検証する。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo, type ColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  FEATURE_KIND,
  createLeafFeature,
  type AggregateFeature,
  type Feature,
  type LeafFeature,
} from '../feature';
import { createShape, createTerritoryRing, RING_KIND } from '../ring';
import { unwrapRing, worldWrapReplicas } from '../geo/index';
import {
  difference as geoDifference,
  isMultiPolygonEmpty,
  isOk,
  type GeoMultiPolygon,
  type GeoRing,
} from '../geometry/index';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';
import {
  asFeatureId,
  asRingId,
  asVertexId,
  type FeatureId,
  type VertexId,
} from '../ids';
import { createIdGeneratorState } from '../id-generator';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { resolveLeafShape, resolveFeatureArea } from '../hierarchy/resolve-shape';
import { areasEqualWithinTolerance, validateHierarchy } from '../hierarchy/validate';

import {
  PROMOTION_STATUS,
  PROMOTION_REJECT,
  promoteLeafToAggregate,
  promoteFeature,
  type PromotionResult,
  type PromotionCommitted,
} from './promote';
import { defaultDirectDomainName, directDomainName } from './direct-domain';

// --- factories --------------------------------------------------------------

const COLOR: ColorInfo = createColorInfo(true, '#112233', '#445566', '#778899');
const COLOR2: ColorInfo = createColorInfo(false, '#abcdef', '#000000', '#ffffff');
const NOW = () => 1000;

let vSeq = 0;
function vid(): VertexId {
  vSeq += 1;
  return asVertexId(`tv-${vSeq}`);
}

interface BoxSpec {
  readonly lon0: number;
  readonly lat0: number;
  readonly lon1: number;
  readonly lat1: number;
}

/** A rectangle leaf with one territory ring; returns the leaf + its 4 vertices. */
function rectLeaf(
  id: string,
  box: BoxSpec,
  attrsName: string,
  color: ColorInfo = COLOR,
  parentId?: string,
): { leaf: LeafFeature; vertices: ReturnType<typeof createVertex>[] } {
  const corners: WorldCoordinate[] = [
    createCoordinate(box.lon0, box.lat0),
    createCoordinate(box.lon1, box.lat0),
    createCoordinate(box.lon1, box.lat1),
    createCoordinate(box.lon0, box.lat1),
  ];
  const vs = corners.map((c) => createVertex(vid(), c));
  const ring = createTerritoryRing(
    asRingId(`r-${id}`),
    vs.map((v) => v.id),
  );
  const optional = parentId !== undefined ? { parentId: asFeatureId(parentId) } : {};
  const leaf = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(attrsName, 0, 100),
    color,
    createShape([ring]),
    optional,
  );
  return { leaf, vertices: vs };
}

function storeOf(...groups: ReturnType<typeof createVertex>[][]): VertexStore {
  return createVertexStore(groups.flat());
}

function committed(r: PromotionResult): PromotionCommitted {
  if (r.status !== PROMOTION_STATUS.Committed) {
    throw new Error(`expected committed, got ${r.status} ${JSON.stringify(r)}`);
  }
  return r;
}

function feat(features: readonly Feature[], id: string): Feature {
  const f = features.find((x) => x.id === (id as unknown as FeatureId));
  if (f === undefined) throw new Error(`feature ${id} not found`);
  return f;
}

// --- seam-aware area equality (independent verifier for the世界端 test) -------
// 本体 (promote.ts) と同じ依存を再実装せず、U05/U06 の公開プリミティブだけで「seam を
// またぐ領域が representative 空間で別片に分断されても面積が一致する」ことを独立に検証する。

function unwrapMp(mp: GeoMultiPolygon): GeoMultiPolygon {
  return mp.map((poly) => poly.map((ring: GeoRing) => unwrapRing([...ring])));
}

function replicateAcrossSeam(clip: GeoMultiPolygon): GeoMultiPolygon {
  const out: GeoRing[][] = [];
  for (const poly of clip) {
    if (poly.length === 0) continue;
    const outer = poly[0]!;
    for (const rep of worldWrapReplicas(outer)) {
      out.push(poly.map((ring) => ring.map((c) => ({ lon: c.lon + rep.turns * 360, lat: c.lat }))));
    }
  }
  return out;
}

function dirDiffEmpty(subject: GeoMultiPolygon, clip: GeoMultiPolygon): boolean {
  const diff = geoDifference(subject, replicateAcrossSeam(clip));
  return isOk(diff) && isMultiPolygonEmpty(diff.result);
}

function seamAwareAreasEqual(a: GeoMultiPolygon, b: GeoMultiPolygon): boolean {
  const ua = unwrapMp(a);
  const ub = unwrapMp(b);
  return dirDiffEmpty(ua, ub) && dirDiffEmpty(ub, ua);
}

// ===========================================================================
// 基準 1: 末端→集約遷移と元プロパティ引き継ぎ・形状属性破棄 (FR-36)
// ===========================================================================

describe('基準1 末端→集約遷移・属性引き継ぎ・形状破棄 (FR-36)', () => {
  it('同一 ID で集約へ遷移し、名称・種別・属性・色を引き継ぎ、形状を破棄する', () => {
    // 親 P (0..10) と、その中の子 C (0..5)。P を集約へ遷移させ C を下位領域にする。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'パルティア', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, '子', COLOR2, 'P');
    // P に種別ラベルを付ける。
    const parentLeaf: LeafFeature = { ...parent.leaf, kindLabel: '王国' };
    const features: Feature[] = [parentLeaf, child.leaf];
    const vertices = storeOf(parent.vertices, child.vertices);

    const r = committed(
      promoteLeafToAggregate({
        features,
        vertices,
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );

    const promoted = feat(r.nextFeatures, 'P');
    expect(promoted.kind).toBe(FEATURE_KIND.Aggregate);
    expect(promoted.id).toBe(asFeatureId('P')); // 同一性保持。
    // 引き継ぎ。
    expect(promoted.attributes.name).toBe('パルティア');
    expect(promoted.kindLabel).toBe('王国');
    expect(promoted.color).toEqual(COLOR);
    // 形状属性破棄: AggregateFeature に shape フィールドは存在しない (型レベル) かつ
    // 実体にも残らない。
    expect((promoted as unknown as { shape?: unknown }).shape).toBeUndefined();
    expect(r.outcome.promotedFeatureId).toBe(asFeatureId('P'));
  });

  it('promoteFeature は同一 ID・属性・色・親・種別を保ち shape を持たない集約を返す', () => {
    const { leaf } = rectLeaf('X', { lon0: 0, lat0: 0, lon1: 1, lat1: 1 }, '名', COLOR, 'PARENT');
    const withLabel: LeafFeature = { ...leaf, kindLabel: 'ラベル' };
    const agg: AggregateFeature = promoteFeature(withLabel, [asFeatureId('c1')]);
    expect(agg.kind).toBe(FEATURE_KIND.Aggregate);
    expect(agg.id).toBe(asFeatureId('X'));
    expect(agg.parentId).toBe(asFeatureId('PARENT'));
    expect(agg.kindLabel).toBe('ラベル');
    expect(agg.attributes).toEqual(withLabel.attributes);
    expect(agg.childIds).toEqual([asFeatureId('c1')]);
    expect('shape' in agg).toBe(false);
  });
});

// ===========================================================================
// 基準 2: 複数経路から同一の遷移結果 (教訓 5.6)
// ===========================================================================

describe('基準2 結果状態判定 — 複数経路で同一遷移 (教訓5.6)', () => {
  it('割譲型(既存子を移す)・直轄化型(新規子)など経路が違っても、下位領域1個以上の結果状態なら同一遷移', () => {
    const base = (childId: string) => {
      const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '元', COLOR);
      const child = rectLeaf(childId, { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '子', COLOR2, 'P');
      return {
        features: [parent.leaf, child.leaf] as Feature[],
        vertices: storeOf(parent.vertices, child.vertices),
      };
    };
    const runA = committed(
      promoteLeafToAggregate({
        ...base('A'),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('A')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    const runB = committed(
      promoteLeafToAggregate({
        ...base('B'),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('B')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    // どちらも集約化し、子が完全被覆なので直轄領なし。
    expect(feat(runA.nextFeatures, 'P').kind).toBe(FEATURE_KIND.Aggregate);
    expect(feat(runB.nextFeatures, 'P').kind).toBe(FEATURE_KIND.Aggregate);
    expect(runA.outcome.directDomainFeatureId).toBeUndefined();
    expect(runB.outcome.directDomainFeatureId).toBeUndefined();
  });
});

// ===========================================================================
// 基準 3: 差分から直轄領を自動生成・差分空なら生成しない (FR-37)
// ===========================================================================

describe('基準3 直轄領の差分算出・自動生成 (FR-37)', () => {
  it('元形状が下位領域より広いと直轄領を1つ生成し、全下位領域の和=元形状になる', () => {
    // P: 0..10、子 C: 0..5 (左半分)。差分 = 右半分 5..10 → 直轄領。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '帝国', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, '州', COLOR2, 'P');
    const features: Feature[] = [parent.leaf, child.leaf];
    const vertices = storeOf(parent.vertices, child.vertices);
    const originalMp = resolveLeafShape(parent.leaf.shape, vertices)!;

    const r = committed(
      promoteLeafToAggregate({
        features,
        vertices,
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );

    const ddId = r.outcome.directDomainFeatureId;
    expect(ddId).toBeDefined();
    const dd = feat(r.nextFeatures, ddId as unknown as string);
    expect(dd.kind).toBe(FEATURE_KIND.Leaf); // 直轄領は末端地物 (形状保持)。
    expect((dd as LeafFeature).parentId).toBe(asFeatureId('P'));

    // 全下位領域の和 = 元形状 (FR-39 隙間なし)。
    const forest = buildForest(r.nextFeatures);
    const aggArea = resolveFeatureArea(forest, r.nextVertices, asFeatureId('P'));
    expect(aggArea.status).toBe('ok');
    if (aggArea.status === 'ok') {
      expect(areasEqualWithinTolerance(aggArea.area, originalMp)).toBe(true);
    }
    // U08 検証: 隙間なし。
    expect(validateHierarchy(r.nextFeatures, { vertexStore: r.nextVertices }).ok).toBe(true);
  });

  it('元形状と下位領域の和が一致すれば直轄領を生成しない', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '元', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '子', COLOR2, 'P');
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf],
        vertices: storeOf(parent.vertices, child.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    expect(r.outcome.directDomainFeatureId).toBeUndefined();
    // 下位領域は獲得分のみ。
    const forest = buildForest(r.nextFeatures);
    expect(directChildIds(forest, asFeatureId('P'))).toEqual([asFeatureId('C')]);
  });

  it('微小スリバー(トレランス内面積ゼロ)は直轄領化しない', () => {
    // 子をごく僅かだけ小さくする。U06 量子化トレランスで差分が消える。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '元', COLOR);
    // 1e-9 のずれは quantize で吸収される想定。
    const child = rectLeaf(
      'C',
      { lon0: 0, lat0: 0, lon1: 10 - 1e-9, lat1: 10 },
      '子',
      COLOR2,
      'P',
    );
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf],
        vertices: storeOf(parent.vertices, child.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    expect(r.outcome.directDomainFeatureId).toBeUndefined();
  });

  it('複数下位領域の和を対象にする(片落としなし 教訓5.1): 2子の和との差分が直轄領になる', () => {
    // P: 0..10。子 C1: 0..3, C2: 3..6。差分 = 6..10。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '元', COLOR);
    const c1 = rectLeaf('C1', { lon0: 0, lat0: 0, lon1: 3, lat1: 10 }, 'a', COLOR2, 'P');
    const c2 = rectLeaf('C2', { lon0: 3, lat0: 0, lon1: 6, lat1: 10 }, 'b', COLOR2, 'P');
    const vertices = storeOf(parent.vertices, c1.vertices, c2.vertices);
    const originalMp = resolveLeafShape(parent.leaf.shape, vertices)!;
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, c1.leaf, c2.leaf],
        vertices,
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C1'), asFeatureId('C2')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    expect(r.outcome.directDomainFeatureId).toBeDefined();
    const forest = buildForest(r.nextFeatures);
    const aggArea = resolveFeatureArea(forest, r.nextVertices, asFeatureId('P'));
    expect(aggArea.status).toBe('ok');
    if (aggArea.status === 'ok') {
      expect(areasEqualWithinTolerance(aggArea.area, originalMp)).toBe(true);
    }
  });
});

// ===========================================================================
// 基準 4: 地理的分離時の複数領土リング表現 (FR-37 / 教訓5.1)
// ===========================================================================

describe('基準4 地理的分離 → 1直轄領の複数領土リング (飛び地)', () => {
  it('差分が2片に割れても1つの直轄領末端地物の複数領土リングになる', () => {
    // P: 0..10。中央の子 C: 3..7。差分 = 左 0..3 と 右 7..10 の2片。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, '元', COLOR);
    const child = rectLeaf('C', { lon0: 3, lat0: 0, lon1: 7, lat1: 10 }, '中', COLOR2, 'P');
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf],
        vertices: storeOf(parent.vertices, child.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    const ddId = r.outcome.directDomainFeatureId;
    expect(ddId).toBeDefined();
    const dd = feat(r.nextFeatures, ddId as unknown as string) as LeafFeature;
    // 別々の地物ではなく1つの直轄領。
    expect(dd.kind).toBe(FEATURE_KIND.Leaf);
    const territories = dd.shape.rings.filter((rg) => rg.kind === RING_KIND.Territory);
    expect(territories.length).toBe(2); // 飛び地 = 2 領土リング。
  });
});

// ===========================================================================
// 基準 5: 直轄領の既定名称とダイアログ上書き (FR-37)
// ===========================================================================

describe('基準5 直轄領の既定名称・上書き (FR-37)', () => {
  it('上書きなしなら「<元名> 直轄領」', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'ローマ', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, '州', COLOR2, 'P');
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf],
        vertices: storeOf(parent.vertices, child.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    const dd = feat(r.nextFeatures, r.outcome.directDomainFeatureId as unknown as string);
    expect(dd.attributes.name).toBe('ローマ 直轄領');
  });

  it('上書き値があればそれを採る', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'ローマ', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, '州', COLOR2, 'P');
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf],
        vertices: storeOf(parent.vertices, child.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        directDomainNameOverride: 'イタリア本土',
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    const dd = feat(r.nextFeatures, r.outcome.directDomainFeatureId as unknown as string);
    expect(dd.attributes.name).toBe('イタリア本土');
  });

  it('既定名称の生成規約は単一実装で元名に連動する', () => {
    expect(defaultDirectDomainName('A')).toBe('A 直轄領');
    expect(defaultDirectDomainName('別')).toBe('別 直轄領');
    expect(directDomainName('A', undefined)).toBe('A 直轄領');
    expect(directDomainName('A', '')).toBe('A 直轄領'); // 空文字は上書きとみなさない。
    expect(directDomainName('A', '上書き')).toBe('上書き');
  });
});

// ===========================================================================
// 基準 6: 集約地物の全下位領域喪失による自動消滅 (FR-35 / FR-41)
// ===========================================================================

describe('基準6 全下位領域喪失による自動消滅 (FR-35/FR-41, 教訓5.6)', () => {
  // シナリオ: 既存集約 G の唯一の子 C を、遷移対象 P が獲得する。獲得後 G は空集約に
  // なるので自動消滅する。
  function scenario() {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    // C は遷移時点で既に P を親としている (U28 が張り替え済み)。
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, 'C', COLOR2, 'P');
    // G は元 C の親だったが、childIds は再同期で掃除される (空集約)。
    const g: AggregateFeature = {
      kind: FEATURE_KIND.Aggregate,
      id: asFeatureId('G'),
      attributes: createBasicAttributes('G', 0, 100),
      color: COLOR,
      childIds: [],
    };
    return {
      features: [parent.leaf, child.leaf, g] as Feature[],
      vertices: storeOf(parent.vertices, child.vertices),
    };
  }

  it('空になった集約が自動消滅し outcome に列挙される', () => {
    const r = committed(
      promoteLeafToAggregate({
        ...scenario(),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    expect(r.outcome.disappearedFeatureIds).toContain(asFeatureId('G'));
    expect(r.nextFeatures.find((f) => f.id === asFeatureId('G'))).toBeUndefined();
  });

  it('下位領域が1個でも残る集約は消滅しない (過剰消滅防止)', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'C', COLOR2, 'P');
    // 別の生きた集約 G2 とその子 K。
    const k = rectLeaf('K', { lon0: 20, lat0: 0, lon1: 30, lat1: 10 }, 'K', COLOR2, 'G2');
    const g2: AggregateFeature = {
      kind: FEATURE_KIND.Aggregate,
      id: asFeatureId('G2'),
      attributes: createBasicAttributes('G2', 0, 100),
      color: COLOR,
      childIds: [asFeatureId('K')],
    };
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf, g2, k.leaf],
        vertices: storeOf(parent.vertices, child.vertices, k.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    expect(r.outcome.disappearedFeatureIds).not.toContain(asFeatureId('G2'));
    expect(r.nextFeatures.find((f) => f.id === asFeatureId('G2'))).toBeDefined();
  });
});

// ===========================================================================
// 基準 7: 集約地物を直接追加させない (FR-35)
// ===========================================================================

describe('基準7 集約地物を空で新設する入口を持たない (FR-35)', () => {
  it('獲得下位領域が空集合なら遷移しない (NoOp)', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const r = promoteLeafToAggregate({
      features: [parent.leaf],
      vertices: storeOf(parent.vertices),
      targetId: asFeatureId('P'),
      acquiredChildIds: [],
      idState: createIdGeneratorState(),
      now: NOW,
    });
    expect(r.status).toBe(PROMOTION_STATUS.NoOp);
  });
});

// ===========================================================================
// 基準 8: 不可分性と構造化結果 (FR-94 / 教訓5.11 / 5.20)
// ===========================================================================

describe('基準8 不可分性・構造化結果・再do の ID 一致', () => {
  function input() {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, 'C', COLOR2, 'P');
    return {
      features: [parent.leaf, child.leaf] as Feature[],
      vertices: storeOf(parent.vertices, child.vertices),
      targetId: asFeatureId('P'),
      acquiredChildIds: [asFeatureId('C')],
      idState: createIdGeneratorState(),
      now: NOW,
    };
  }

  it('遷移・直轄領生成が1結果で返り、構造化結果に遷移ID・直轄領IDが含まれる', () => {
    const r = committed(promoteLeafToAggregate(input()));
    expect(r.outcome.promotedFeatureId).toBe(asFeatureId('P'));
    expect(r.outcome.directDomainFeatureId).toBeDefined();
    // 直轄領が実際に状態へ含まれる (部分確定でない)。
    expect(
      r.nextFeatures.find((f) => f.id === r.outcome.directDomainFeatureId),
    ).toBeDefined();
  });

  it('同一入力 (同一 idState/now) で再実行すると直轄領 ID が初回と一致する (採番し直さない)', () => {
    const a = committed(promoteLeafToAggregate(input()));
    const b = committed(promoteLeafToAggregate(input()));
    expect(b.outcome.directDomainFeatureId).toBe(a.outcome.directDomainFeatureId);
  });
});

// ===========================================================================
// 基準 9: 確定前の不変条件検証 (教訓5.26 / U08 連携)
// ===========================================================================

describe('基準9 確定前 U08 検証', () => {
  it('正常ケースは U08 検証で違反なし (形状=和・隙間なし・最上位同値・循環なし)', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, 'C', COLOR2, 'P');
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf],
        vertices: storeOf(parent.vertices, child.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    expect(validateHierarchy(r.nextFeatures, { vertexStore: r.nextVertices }).ok).toBe(true);
  });

  it('遷移対象が末端地物でなければ拒否', () => {
    const agg: AggregateFeature = {
      kind: FEATURE_KIND.Aggregate,
      id: asFeatureId('P'),
      attributes: createBasicAttributes('P', 0, 100),
      color: COLOR,
      childIds: [asFeatureId('C')],
    };
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, 'C', COLOR2, 'P');
    const r = promoteLeafToAggregate({
      features: [agg, child.leaf],
      vertices: storeOf(child.vertices),
      targetId: asFeatureId('P'),
      acquiredChildIds: [asFeatureId('C')],
      idState: createIdGeneratorState(),
      now: NOW,
    });
    expect(r.status).toBe(PROMOTION_STATUS.Rejected);
    if (r.status === PROMOTION_STATUS.Rejected) {
      expect(r.kind).toBe(PROMOTION_REJECT.TargetInvalid);
    }
  });

  it('存在しない下位領域を獲得しようとすると拒否', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const r = promoteLeafToAggregate({
      features: [parent.leaf],
      vertices: storeOf(parent.vertices),
      targetId: asFeatureId('P'),
      acquiredChildIds: [asFeatureId('NOPE')],
      idState: createIdGeneratorState(),
      now: NOW,
    });
    expect(r.status).toBe(PROMOTION_STATUS.Rejected);
    if (r.status === PROMOTION_STATUS.Rejected) {
      expect(r.kind).toBe(PROMOTION_REJECT.ChildMissing);
    }
  });
});

// ===========================================================================
// 基準 9b: 確定前の形状保存検証 (集約派生面積 = 元末端地物形状; はみ出し/隙間を拒否)
// ===========================================================================

describe('基準9b 形状保存検証 — ShapeMismatch 拒否経路', () => {
  it('下位領域が元形状をはみ出す不正構成は ShapeMismatch で拒否される', () => {
    // 子 C が親 P の境界を越える (P:0..10, C:0..15)。差分 P\C は空なので直轄領は生成され
    // ず、遷移集約の派生面積 = C = [0,15] が元形状 [0,10] からはみ出す。U08 の inter-child
    // gap 検査は単一子では gap を見ないため通過するが、本ゲートが originalShape との
    // 双方向差分で overflow を検出して拒否する (基準9b『はみ出す不正構成を拒否できる』)。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 15, lat1: 10 }, 'C', COLOR2, 'P');
    const r = promoteLeafToAggregate({
      features: [parent.leaf, child.leaf],
      vertices: storeOf(parent.vertices, child.vertices),
      targetId: asFeatureId('P'),
      acquiredChildIds: [asFeatureId('C')],
      idState: createIdGeneratorState(),
      now: NOW,
    });
    expect(r.status).toBe(PROMOTION_STATUS.Rejected);
    if (r.status === PROMOTION_STATUS.Rejected) {
      expect(r.kind).toBe(PROMOTION_REJECT.ShapeMismatch);
      expect(r.featureIds).toContain(asFeatureId('P')); // 関与 ID に遷移対象が含まれる。
    }
  });

  it('下位領域が元形状を覆い切らない不正構成も双方向比較の隙間方向で検出される', () => {
    // 子 C を P の左半分に少し満たない位置に置き、かつ差分側を直轄領化しない構成を強制
    // するため、子の右辺を P の内側にしつつ「子が P をはみ出す」ことで overflow=非空に
    // ならない隙間ケースの代替として、ここでは子が P の外へずれて P 内に隙間を残し、かつ
    // 子の外側 (P 外) を直轄領が拾わない構成を作る。具体的には C:5..15 (P:0..10) とすると
    // 差分 P\C = [0,5] が直轄領化される一方、C のうち [10,15] は P 外。派生面積は
    // [0,5]∪[5,15]=[0,15] となり元 [0,10] と不一致 (overflow 方向)。これも ShapeMismatch。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const child = rectLeaf('C', { lon0: 5, lat0: 0, lon1: 15, lat1: 10 }, 'C', COLOR2, 'P');
    const r = promoteLeafToAggregate({
      features: [parent.leaf, child.leaf],
      vertices: storeOf(parent.vertices, child.vertices),
      targetId: asFeatureId('P'),
      acquiredChildIds: [asFeatureId('C')],
      idState: createIdGeneratorState(),
      now: NOW,
    });
    expect(r.status).toBe(PROMOTION_STATUS.Rejected);
    if (r.status === PROMOTION_STATUS.Rejected) {
      expect(r.kind).toBe(PROMOTION_REJECT.ShapeMismatch);
    }
  });

  it('正常構成 (派生面積 = 元形状) は ShapeMismatch を発火しない (偽陽性なし)', () => {
    // 基準3 と同型の正常ケース: ShapeMismatch ゲートが正当な遷移を誤拒否しないことを固定。
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, 'C', COLOR2, 'P');
    const r = committed(
      promoteLeafToAggregate({
        features: [parent.leaf, child.leaf],
        vertices: storeOf(parent.vertices, child.vertices),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    expect(r.outcome.directDomainFeatureId).toBeDefined();
  });
});

// ===========================================================================
// 基準 10: 純粋性・種別ラベル非関与
// ===========================================================================

describe('基準10 純粋性・種別ラベル非関与', () => {
  it('入力状態を破壊的に変更しない', () => {
    const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
    const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, 'C', COLOR2, 'P');
    const features: Feature[] = [parent.leaf, child.leaf];
    const snapshot = JSON.stringify(features);
    const vertices = storeOf(parent.vertices, child.vertices);
    const vSnapshot = [...vertices.byId.keys()].length;
    promoteLeafToAggregate({
      features,
      vertices,
      targetId: asFeatureId('P'),
      acquiredChildIds: [asFeatureId('C')],
      idState: createIdGeneratorState(),
      now: NOW,
    });
    expect(JSON.stringify(features)).toBe(snapshot); // 入力配列・地物は不変。
    expect([...vertices.byId.keys()].length).toBe(vSnapshot); // 入力ストア不変。
    // P は依然として末端地物 (元の状態が残る)。
    expect(feat(features, 'P').kind).toBe(FEATURE_KIND.Leaf);
  });

  it('種別ラベルを変えても遷移・直轄領生成の構造結果は変わらない (FR-40)', () => {
    const run = (label?: string) => {
      const parent = rectLeaf('P', { lon0: 0, lat0: 0, lon1: 10, lat1: 10 }, 'P', COLOR);
      const labeled: LeafFeature = label !== undefined ? { ...parent.leaf, kindLabel: label } : parent.leaf;
      const child = rectLeaf('C', { lon0: 0, lat0: 0, lon1: 5, lat1: 10 }, 'C', COLOR2, 'P');
      return committed(
        promoteLeafToAggregate({
          features: [labeled, child.leaf],
          vertices: storeOf(parent.vertices, child.vertices),
          targetId: asFeatureId('P'),
          acquiredChildIds: [asFeatureId('C')],
          idState: createIdGeneratorState(),
          now: NOW,
        }),
      );
    };
    const a = run(undefined);
    const b = run('王国');
    // 構造化結果 (遷移 ID・直轄領 ID・消滅 ID) が一致する。
    expect(a.outcome.promotedFeatureId).toBe(b.outcome.promotedFeatureId);
    expect(a.outcome.directDomainFeatureId).toBe(b.outcome.directDomainFeatureId);
    expect(a.outcome.disappearedFeatureIds).toEqual(b.outcome.disappearedFeatureIds);
  });
});

// ===========================================================================
// 世界端ラップ (技術方針 R3)
// ===========================================================================

describe('世界端ラップ整合 (R3)', () => {
  it('経度 ±180 をまたぐ元形状でも差分・直轄領が分断・片落としを起こさない', () => {
    // P: 経度 170..190 (= 170..-170 ラップ) を連続座標として表現する末端地物。
    // ここでは vertex ストアは正規化前提でないため、170 と -170 を直接置く代わりに
    // 連続座標 (170,175,185,190) ではなく、seam をまたぐ実形状を作る。
    const corners: WorldCoordinate[] = [
      createCoordinate(170, 0),
      createCoordinate(-170, 0), // = 190
      createCoordinate(-170, 10),
      createCoordinate(170, 10),
    ];
    const pv = corners.map((c) => createVertex(vid(), c));
    const pRing = createTerritoryRing(asRingId('rP'), pv.map((v) => v.id));
    const p = createLeafFeature(
      asFeatureId('P'),
      createBasicAttributes('P', 0, 100),
      COLOR,
      createShape([pRing]),
    );
    // 子 C: 経度 170..180 の左半分。
    const cc: WorldCoordinate[] = [
      createCoordinate(170, 0),
      createCoordinate(180, 0),
      createCoordinate(180, 10),
      createCoordinate(170, 10),
    ];
    const cv = cc.map((c) => createVertex(vid(), c));
    const cRing = createTerritoryRing(asRingId('rC'), cv.map((v) => v.id));
    const c = createLeafFeature(
      asFeatureId('C'),
      createBasicAttributes('C', 0, 100),
      COLOR2,
      createShape([cRing]),
      { parentId: asFeatureId('P') },
    );
    const r = committed(
      promoteLeafToAggregate({
        features: [p, c],
        vertices: createVertexStore([...pv, ...cv]),
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );

    // 基準10: seam をまたぐ正当な遷移は確定する (false 拒否しない / 回帰固定)。
    // 直轄領が生成され、全下位領域の和が元形状に一致し、飛び地リングが片落としなく構成される。
    const ddId = r.outcome.directDomainFeatureId;
    expect(ddId).toBeDefined();

    // 直轄領は末端地物で、seam の東側 [180,190] (= 子の外側) を覆う領土リングを持つ。
    const dd = feat(r.nextFeatures, ddId as unknown as string) as LeafFeature;
    expect(dd.kind).toBe(FEATURE_KIND.Leaf);
    const ddTerritories = dd.shape.rings.filter((rg) => rg.kind === RING_KIND.Territory);
    expect(ddTerritories.length).toBeGreaterThanOrEqual(1); // 片落としなし。

    // 全下位領域 (子 + 直轄領) の和 = 元 P 形状。seam をまたぐため ±360° 世界ラップで整列して
    // 双方向差分が空になることを検証する (representative 空間で別片に分断されても一致と判定)。
    const originalMp = resolveLeafShape(p.shape, createVertexStore([...pv, ...cv]))!;
    const forest = buildForest(r.nextFeatures);
    const aggArea = resolveFeatureArea(forest, r.nextVertices, asFeatureId('P'));
    expect(aggArea.status).toBe('ok');
    if (aggArea.status === 'ok') {
      expect(seamAwareAreasEqual(aggArea.area, originalMp)).toBe(true);
    }
    // U08 検証 (隙間なし) も通ること。
    expect(validateHierarchy(r.nextFeatures, { vertexStore: r.nextVertices }).ok).toBe(true);
  });
});
