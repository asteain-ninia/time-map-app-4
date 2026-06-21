// U29 末端→集約遷移の世界シーム整列テスト (audit root cause A の横展開).
//
// unionChildAreas は獲得下位領域それぞれの派生面積を U06 union で合成し、その結果が
// 「元形状 − 下位領域の和」(直轄領差分) の被演算子になる。子は resolveFeatureArea →
// resolveLeafShape の RAW representative 座標由来なので、シームをまたいで隣接する 2 子
// (+179 付近 と −179 付近) は representative 空間で ~360° 離れて格納され得る。整列せず
// union に渡すと、隙間なくタイルしている子同士が逆回り ~358° で散らばり、childUnion が
// 元形状を覆い切らず偽の直轄領を生む / 遷移が誤拒否される。共有ヘルパ alignMultiPolygon /
// referenceLonForMultiPolygon (drill / 集約 union / unwrapShape と同一の単一真実源) で
// 共通 world-turn へ揃えてから演算することを固定する。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo, type ColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createLeafFeature, type Feature, type LeafFeature } from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../ids';
import { createIdGeneratorState } from '../id-generator';
import {
  PROMOTION_STATUS,
  promoteLeafToAggregate,
  type PromotionCommitted,
  type PromotionResult,
} from './promote';

const COLOR: ColorInfo = createColorInfo(true, '#112233', '#445566', '#778899');
const NOW = () => 1000;

let vSeq = 0;
function vid(): VertexId {
  vSeq += 1;
  return asVertexId(`sv-${vSeq}`);
}

/** Leaf from an explicit coordinate ring (controls seam placement). */
function leafFromRing(
  id: string,
  coords: readonly WorldCoordinate[],
  parentId?: string,
): { leaf: LeafFeature; vertices: ReturnType<typeof createVertex>[] } {
  const vs = coords.map((c) => createVertex(vid(), c));
  const ring = createTerritoryRing(asRingId(`r-${id}`), vs.map((v) => v.id));
  const optional = parentId !== undefined ? { parentId: asFeatureId(parentId) } : {};
  const leaf = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 100),
    COLOR,
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

describe('U29 末端→集約遷移 — 世界シーム整列 (root cause A 横展開)', () => {
  it('シームをまたぐ親を、隙間なくタイルする 2 子で埋めると直轄領なしで確定する', () => {
    // 親 P: 連続フレーム [170,190]×[0,10] を 1 リングで (representative 折り畳み)。
    const parent = leafFromRing('P', [
      createCoordinate(170, 0),
      createCoordinate(-170, 0), // 連続 190
      createCoordinate(-170, 10),
      createCoordinate(170, 10),
    ]);
    // 子 C1: [170,180]×[0,10] (東端), 子 C2: [-180,-170]×[0,10] (西端, 連続 180..190)。
    // 2 子は連続フレームで 180==-180 を共有辺に隙間なく親全体をタイルする。
    const c1 = leafFromRing(
      'C1',
      [
        createCoordinate(170, 0),
        createCoordinate(180, 0),
        createCoordinate(180, 10),
        createCoordinate(170, 10),
      ],
      'P',
    );
    const c2 = leafFromRing(
      'C2',
      [
        createCoordinate(-180, 0),
        createCoordinate(-170, 0),
        createCoordinate(-170, 10),
        createCoordinate(-180, 10),
      ],
      'P',
    );
    const features: Feature[] = [parent.leaf, c1.leaf, c2.leaf];
    const vertices = storeOf(parent.vertices, c1.vertices, c2.vertices);

    const r = committed(
      promoteLeafToAggregate({
        features,
        vertices,
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C1'), asFeatureId('C2')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );

    // 子の和が親全体を覆う ⇒ 直轄領 (差分) は空。整列が無いと childUnion が散らばり
    // 差分に残渣が出て偽の直轄領が生まれる / 遷移が誤拒否される。
    expect(r.outcome.directDomainFeatureId).toBeUndefined();
    // 下位領域は獲得 2 子のみ。
    const promoted = r.nextFeatures.find((f) => f.id === asFeatureId('P'));
    expect(promoted?.kind).toBe('aggregate');
  });

  it('親の頂点列がシーム西側から始まり子が東フレームに整列しても直轄領を誤生成しない', () => {
    // 親 P: 連続フレーム [170,190]×[0,10] だが頂点列を WEST (−170) から開始 (per-ring
    // 独立 unwrap は先頭頂点アンカーなので親が ~−190..−170 フレーム、子の和が +170..+190
    // フレームに着地し、差分が両者を別 turn で見て偽の直轄領を生む — Codex finding 2)。
    const parent = leafFromRing('P', [
      createCoordinate(-170, 0), // 先頭が西側
      createCoordinate(-170, 10),
      createCoordinate(170, 10),
      createCoordinate(170, 0),
    ]);
    const c1 = leafFromRing(
      'C1',
      [
        createCoordinate(170, 0),
        createCoordinate(180, 0),
        createCoordinate(180, 10),
        createCoordinate(170, 10),
      ],
      'P',
    );
    const c2 = leafFromRing(
      'C2',
      [
        createCoordinate(-180, 0),
        createCoordinate(-170, 0),
        createCoordinate(-170, 10),
        createCoordinate(-180, 10),
      ],
      'P',
    );
    const features: Feature[] = [parent.leaf, c1.leaf, c2.leaf];
    const vertices = storeOf(parent.vertices, c1.vertices, c2.vertices);

    const r = committed(
      promoteLeafToAggregate({
        features,
        vertices,
        targetId: asFeatureId('P'),
        acquiredChildIds: [asFeatureId('C1'), asFeatureId('C2')],
        idState: createIdGeneratorState(),
        now: NOW,
      }),
    );
    // 親 = 子の和 ⇒ 差分は空 ⇒ 直轄領なし。整列前は偽の直轄領が出ていた。
    expect(r.outcome.directDomainFeatureId).toBeUndefined();
  });

  it('シームから離れた通常の親+子の遷移は不変 (整列は恒等)', () => {
    // 親 [0,10]×[0,10] を子 [0,5]×[0,10] で半分だけ埋める ⇒ 直轄領 [5,10]×[0,10] が出る。
    const parent = leafFromRing('P', [
      createCoordinate(0, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(0, 10),
    ]);
    const child = leafFromRing(
      'C',
      [
        createCoordinate(0, 0),
        createCoordinate(5, 0),
        createCoordinate(5, 10),
        createCoordinate(0, 10),
      ],
      'P',
    );
    const features: Feature[] = [parent.leaf, child.leaf];
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
    // 残り半分が直轄領として自動生成される。
    expect(r.outcome.directDomainFeatureId).toBeDefined();
  });
});
