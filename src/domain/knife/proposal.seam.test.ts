// U26 分割の世界シーム整列テスト (バグハント2回目 — root cause A の横展開).
//
// split-geometry は target 外環の参照経度へ全入力を anchor して連続フレーム (>180° を
// 取り得る) で boolean 演算する (targetReferenceLon / anchorMultiPolygon)。外環がシーム
// を跨ぐ leaf ([170,-170,-170,170] など) を分割すると、boolean 出力上シーム側の頂点は
// 190° のような連続値で出てくる。proposal.ts が coordKey / createVertex で
// normalizeCoordinate を欠くと、新頂点は representative (-170°) ではなく 190° のまま
// 格納され、(a) 他地物の representative と別分岐になって save→load/整合性 concat で齟齬、
// (b) buildRemap が representative (-170°) で格納された旧頂点と coordKey 不一致になり
// FR-95 共有頂点継続の旧→新対応をシーム側で取りこぼす。
//
// これは merge/proposal.ts が coordKey=`quantizeCoordinate(normalizeCoordinate(c))` で、
// direct-domain.ts が rewrapRing で既に修正済みの seam alignment ロールアウトの取りこぼし。
// 本テストは knife でも (1) 全新頂点が representative、(2) シーム跨ぎの旧頂点が漏れなく
// remap されることを固定する。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createOpenKnifeLine } from './knife-line';
import {
  INHERITANCE_SIDE,
  assembleSplitProposal,
  createInheritanceChoice,
} from './proposal';
import { executeSplit } from './split-geometry';
import { freshIdPorts, squareLeaf } from './fixtures';

const c = (lon: number, lat: number) => createCoordinate(lon, lat);

describe('U26 分割 — 世界シーム整列 (バグハント2回目 横展開)', () => {
  // 外環がシームを跨ぐ leaf: [170,-170]×[0,10]。連続フレームでは [170,190]×[0,10] の
  // 1 矩形で、−170° の 2 角は anchor 後 190° として boolean に出る。
  function seamLeaf(featureId = 'seam') {
    return squareLeaf(featureId, [
      c(170, 0),
      c(-170, 0),
      c(-170, 10),
      c(170, 10),
    ]);
  }

  it('シームを跨ぐ leaf を分割した新頂点はすべて representative ([-180,180)) で格納される', () => {
    const { feature, store } = seamLeaf('seam-rep');
    // 連続フレーム [170,190] の中央 (連続値 180°、representative -180°) で縦に分割。
    // 縦線は representative 経度系で与える (UI は world 座標を渡す)。180° は wrap で
    // -180° に畳まれるが、cut line も split-geometry 内で target 参照へ anchor される。
    const line = createOpenKnifeLine([c(-180, -5), c(-180, 15)]);
    const result = executeSplit(feature, store, line);
    if (!result) throw new Error('expected splittable seam leaf');
    const proposal = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: {
        attributes: createBasicAttributes('new-seam', 10, 90),
        color: createColorInfo(false, '#abc', '#def', '#123'),
      },
      ids: freshIdPorts(),
    });

    // 修正前: anchor 後の連続値 (190° など) が量子化されてそのまま格納され、|lon|>180 の
    // 頂点が出現した。representative へ正規化することで全頂点が [-180,180) に入る。
    expect(proposal.vertices.length).toBeGreaterThan(0);
    for (const v of proposal.vertices) {
      expect(v.coordinate.lon).toBeGreaterThanOrEqual(-180);
      expect(v.coordinate.lon).toBeLessThan(180);
    }
  });

  it('シーム反対側 (representative -170°) の旧頂点が FR-95 旧→新 remap に取りこぼされない', () => {
    const { feature, store } = seamLeaf('seam-remap');
    const line = createOpenKnifeLine([c(-180, -5), c(-180, 15)]);
    const result = executeSplit(feature, store, line);
    if (!result) throw new Error('expected splittable seam leaf');
    const proposal = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: {
        attributes: createBasicAttributes('new-seam', 10, 90),
        color: createColorInfo(false, '#abc', '#def', '#123'),
      },
      ids: freshIdPorts(),
    });

    // 旧頂点は representative で格納されている: 170° 側 2 角 + −170° 側 (anchor 後 190°)
    // 2 角。分割で 4 角すべてが残るので 4 頂点が remap されねばならない。修正前は
    // −170° 側の旧頂点が coordKey(190°) と一致せず取りこぼされ remap が 4 未満だった。
    const originalIds = feature.shape.rings.flatMap((r) => r.vertexIds);
    const remapped = originalIds.filter((id) => proposal.vertexRemap.has(id));
    expect(remapped.length).toBe(4);

    // 取りこぼしていたのは具体的にシーム反対側 (-170°) の 2 角: それぞれが remap を持つ。
    const seamSideOldIds = feature.shape.rings[0]!.vertexIds.filter((id) => {
      const v = store.byId.get(id);
      return v !== undefined && v.coordinate.lon === -170;
    });
    expect(seamSideOldIds.length).toBe(2);
    for (const id of seamSideOldIds) {
      expect(proposal.vertexRemap.has(id)).toBe(true);
    }
  });
});
