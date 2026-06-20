// U30 — 合体 (結合) 機能の単体テスト (受け入れ基準 1〜6)。

import { describe, expect, it } from 'vitest';

import { buildForest, hasChildren } from '../hierarchy/forest';
import { transferSharing, createSharedVertexState, sharedVertexIds, type ContainerEntry } from '../shared-vertex';
import { asFeatureId, asRingId, type FeatureId, type VertexId } from '../ids';
import { createVertex, createVertexStore, getVertex } from '../vertex';
import { createCoordinate } from '../coordinate';
import {
  MERGE_KIND,
  MERGE_STATUS,
  buildMergeProposal,
  classifyMerge,
  toMergeEditProposal,
  type MergeProposal,
  type MergeSnapshot,
} from './proposal';
import { createMergeCommand, type MergeState } from './command';
import {
  CONFLICT_KIND,
  PROCESS_STATUS,
  startProcess,
  applyResolutions,
  type Conflict,
  type ConsistencyPorts,
  type EditProposal,
  type Resolution,
} from '../consistency/index';
import { COMPOSITE_COMMAND_KIND, createCompositeCommand, type Command } from '../command/index';
import { timePointYear } from '../time/time-point';
import { createLeafFeature, type Feature } from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import {
  MERGE_REJECT,
  validateMergePreconditions,
} from './precondition';
import {
  allowedMergeParentCandidates,
  propertyInheritCandidates,
} from './candidates';
import {
  parentExisting,
  parentNone,
  parentCreate,
  propertyInherit,
  propertyNew,
} from './decision';
import { MSG_MERGE_TOO_FEW, MSG_MERGE_NOT_PRESENT } from './messages';
import { agg, fid, makeIdPorts, rectLeaf, storeOf, featuresOf, COLOR } from './fixtures';
import { createBasicAttributes } from '../attributes';

function proposalOf(r: ReturnType<typeof buildMergeProposal>): MergeProposal {
  if (r.status !== MERGE_STATUS.Proposal) throw new Error(`expected proposal, got ${JSON.stringify(r)}`);
  return r.proposal;
}

describe('U30 種別判定 (FR-51, 教訓 5.6)', () => {
  it('下位領域の有無 (結果状態) で末端/集約を判定する', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const child = rectLeaf('child', 0, 0, 5, 5, 0, 100, fid('agg1'));
    const aggregate = agg('agg1', ['child']);
    const features = featuresOf([a, b, child], [aggregate]);
    const forest = buildForest(features);

    expect(classifyMerge(forest, [fid('a'), fid('b')])).toBe(MERGE_KIND.LeafOnly);
    expect(classifyMerge(forest, [fid('agg1')])).toBe(MERGE_KIND.AggregateOnly);
    expect(classifyMerge(forest, [fid('a'), fid('agg1')])).toBe(MERGE_KIND.Mixed);
  });
});

describe('受け入れ基準 1: 末端のみ結合', () => {
  it('隣接 2 末端を結合すると論理和の 1 末端が新規生成され元末端は同一性終了', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const r = buildMergeProposal({
      features,
      vertices,
      targetIds: [fid('a'), fid('b')],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts(),
    });
    const p = proposalOf(r);
    expect(p.mergeKind).toBe(MERGE_KIND.LeafOnly);
    // 元末端は消える。
    expect(p.nextFeatures.find((f) => f.id === fid('a'))).toBeUndefined();
    expect(p.nextFeatures.find((f) => f.id === fid('b'))).toBeUndefined();
    expect([...p.deletedIds].sort()).toEqual([fid('a'), fid('b')].sort());
    // 結果地物は新規 ID で 1 件。
    const result = p.nextFeatures.find((f) => f.id === p.resultFeatureId);
    expect(result).toBeDefined();
    expect(result?.kind).toBe('leaf');
    expect(p.resultFeatureId).not.toBe(fid('a'));
    expect(p.resultFeatureId).not.toBe(fid('b'));
    expect(p.createdIds).toContain(p.resultFeatureId);
  });
});

describe('受け入れ基準 1: 集約のみ結合', () => {
  it('2 集約を結合すると下位平坦化統合した 1 集約が新規生成、下位は同一性保持・上位付け替え、元集約は同一性終了', () => {
    const c1 = rectLeaf('c1', 0, 0, 5, 5, 0, 100, fid('A'));
    const c2 = rectLeaf('c2', 5, 0, 10, 5, 0, 100, fid('B'));
    const A = agg('A', ['c1']);
    const B = agg('B', ['c2']);
    const features = featuresOf([c1, c2], [A, B]);
    const vertices = storeOf(c1, c2);
    const r = buildMergeProposal({
      features,
      vertices,
      targetIds: [fid('A'), fid('B')],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('union-agg', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts(),
    });
    const p = proposalOf(r);
    expect(p.mergeKind).toBe(MERGE_KIND.AggregateOnly);
    // 元集約は消える。
    expect(p.nextFeatures.find((f) => f.id === fid('A'))).toBeUndefined();
    expect(p.nextFeatures.find((f) => f.id === fid('B'))).toBeUndefined();
    expect([...p.deletedIds].sort()).toEqual([fid('A'), fid('B')].sort());
    // 結果集約は新規・形状属性なし。
    const result = p.nextFeatures.find((f) => f.id === p.resultFeatureId);
    expect(result?.kind).toBe('aggregate');
    expect(result).not.toHaveProperty('shape');
    // 下位 c1/c2 は同一性保持・親が結果集約へ付け替え。
    const c1Next = p.nextFeatures.find((f) => f.id === fid('c1'));
    const c2Next = p.nextFeatures.find((f) => f.id === fid('c2'));
    expect(c1Next?.parentId).toBe(p.resultFeatureId);
    expect(c2Next?.parentId).toBe(p.resultFeatureId);
    expect(p.survivedTouchedIds).toContain(fid('c1'));
    expect(p.survivedTouchedIds).toContain(fid('c2'));
    // 結果集約の childIds が同期されている。
    if (result?.kind === 'aggregate') {
      expect([...result.childIds].sort()).toEqual([fid('c1'), fid('c2')].sort());
    }
  });
});

describe('受け入れ基準 1: 混在結合', () => {
  it('末端+集約を結合すると集約の下位に末端を加えた 1 集約が新規生成、加えた末端は同一性継続', () => {
    const child = rectLeaf('child', 0, 0, 5, 5, 0, 100, fid('A'));
    const leaf = rectLeaf('leaf', 5, 0, 10, 5);
    const A = agg('A', ['child']);
    const features = featuresOf([child, leaf], [A]);
    const vertices = storeOf(child, leaf);
    const r = buildMergeProposal({
      features,
      vertices,
      targetIds: [fid('A'), fid('leaf')],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('mixed-agg', 0, 100),
        color: COLOR,
      }),
      ids: makeIdPorts(),
    });
    const p = proposalOf(r);
    expect(p.mergeKind).toBe(MERGE_KIND.Mixed);
    // 元集約 A は消える。末端 leaf は継続。
    expect(p.nextFeatures.find((f) => f.id === fid('A'))).toBeUndefined();
    expect(p.deletedIds).toEqual([fid('A')]);
    const leafNext = p.nextFeatures.find((f) => f.id === fid('leaf'));
    expect(leafNext).toBeDefined();
    expect(leafNext?.kind).toBe('leaf');
    expect(leafNext?.parentId).toBe(p.resultFeatureId);
    // child も継続し結果集約へ付け替え。
    const childNext = p.nextFeatures.find((f) => f.id === fid('child'));
    expect(childNext?.parentId).toBe(p.resultFeatureId);
    const result = p.nextFeatures.find((f) => f.id === p.resultFeatureId);
    if (result?.kind === 'aggregate') {
      expect([...result.childIds].sort()).toEqual([fid('child'), fid('leaf')].sort());
    }
  });
});

describe('受け入れ基準 2: 上位領域・プロパティ決定 (FR-52)', () => {
  it('上位領域 3 択 (既存/新規/親なし) を受理する', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const top = agg('top', [], 0, 100);
    const features = featuresOf([a, b], [top]);
    const vertices = storeOf(a, b);
    const base = {
      features,
      vertices,
      targetIds: [fid('a'), fid('b')],
      atTime: 50,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('m', 0, 100),
        color: COLOR,
      }),
    };

    const existing = proposalOf(
      buildMergeProposal({ ...base, parentDecision: parentExisting(fid('top')), ids: makeIdPorts('e') }),
    );
    expect(existing.nextFeatures.find((f) => f.id === existing.resultFeatureId)?.parentId).toBe(fid('top'));

    const none = proposalOf(
      buildMergeProposal({ ...base, parentDecision: parentNone, ids: makeIdPorts('n') }),
    );
    expect(none.nextFeatures.find((f) => f.id === none.resultFeatureId)?.parentId).toBeUndefined();

    const created = proposalOf(
      buildMergeProposal({
        ...base,
        parentDecision: parentCreate({ name: 'new-top' }, parentNone),
        ids: makeIdPorts('c'),
      }),
    );
    const resultParent = created.nextFeatures.find((f) => f.id === created.resultFeatureId)?.parentId;
    expect(resultParent).toBeDefined();
    expect(created.createdIds).toContain(resultParent!);
    // 新規上位領域が地物集合に存在し最上位 (親なし)。
    const newTop = created.nextFeatures.find((f) => f.id === resultParent);
    expect(newTop?.kind).toBe('aggregate');
    expect(newTop?.parentId).toBeUndefined();
  });

  it('プロパティ 2 択 (引き継ぎ/新規) を受理する', () => {
    const a = rectLeaf('a', 0, 0, 10, 10, 0, 100);
    const b = rectLeaf('b', 10, 0, 20, 10, 0, 100);
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);

    const inherited = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyInherit(fid('a')),
        ids: makeIdPorts('i'),
      }),
    );
    const inResult = inherited.nextFeatures.find((f) => f.id === inherited.resultFeatureId);
    expect(inResult?.attributes.name).toBe('a');

    const fresh = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({
          attributes: createBasicAttributes('brand-new', 0, 100),
          color: COLOR,
        }),
        ids: makeIdPorts('f'),
      }),
    );
    expect(fresh.nextFeatures.find((f) => f.id === fresh.resultFeatureId)?.attributes.name).toBe('brand-new');
  });

  it('親候補列挙は結合対象とその下位を除外し対象時間に存在する候補のみ返す', () => {
    const child = rectLeaf('child', 0, 0, 5, 5, 0, 100, fid('A'));
    const A = agg('A', ['child']);
    const b = rectLeaf('b', 10, 0, 20, 10, 0, 100);
    const top = agg('top', [], 0, 100);
    const past = agg('past', [], -500, -400); // 対象時間に存在しない。
    const features = featuresOf([child, b], [A, top, past]);

    const candidates = allowedMergeParentCandidates(features, [fid('A'), fid('b')], 50);
    const ids = candidates.map((c) => c.featureId);
    expect(ids).toContain(fid('top'));
    expect(ids).not.toContain(fid('A')); // 結合対象。
    expect(ids).not.toContain(fid('child')); // 結合対象の下位。
    expect(ids).not.toContain(fid('b')); // 結合対象。
    expect(ids).not.toContain(fid('past')); // 対象時間に非存在。
  });

  it('プロパティ引き継ぎ元候補は結合対象を列挙する', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const features = featuresOf([a, b]);
    const cands = propertyInheritCandidates(features, [fid('a'), fid('b')]);
    expect(cands.map((c) => c.featureId).sort()).toEqual([fid('a'), fid('b')].sort());
  });
});

describe('受け入れ基準 3: 事前条件 (開始前・確定前 同一述語)', () => {
  it('1 件以下は TooFew で拒否 (開始前検証)', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const features = featuresOf([a]);
    const v = validateMergePreconditions(features, [fid('a')], 50);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(MERGE_REJECT.TooFew);
  });

  it('対象時間に存在しない対象は NotPresentAtTime で拒否', () => {
    const a = rectLeaf('a', 0, 0, 10, 10, 0, 100);
    const b = rectLeaf('b', 10, 0, 20, 10, 200, 300);
    const features = featuresOf([a, b]);
    const v = validateMergePreconditions(features, [fid('a'), fid('b')], 50);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe(MERGE_REJECT.NotPresentAtTime);
      expect(v.featureIds).toContain(fid('b'));
    }
  });

  it('縦方向 (上位下位) 関係にある対象は VerticalRelation で拒否', () => {
    const child = rectLeaf('child', 0, 0, 5, 5, 0, 100, fid('A'));
    const A = agg('A', ['child']);
    const features = featuresOf([child], [A]);
    const v = validateMergePreconditions(features, [fid('A'), fid('child')], 50);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(MERGE_REJECT.VerticalRelation);
  });

  it('確定前検証も同一述語で走り、UI を経由しない直接 buildMergeProposal でも拒否し状態不変', () => {
    const a = rectLeaf('a', 0, 0, 10, 10, 0, 100);
    const b = rectLeaf('b', 10, 0, 20, 10, 200, 300);
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const r = buildMergeProposal({
      features,
      vertices,
      targetIds: [fid('a'), fid('b')],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
      ids: makeIdPorts(),
    });
    expect(r.status).toBe(MERGE_STATUS.Rejected);
    if (r.status === MERGE_STATUS.Rejected) {
      expect(r.kind).toBe(MERGE_REJECT.NotPresentAtTime);
      expect(r.message).toBe(MSG_MERGE_NOT_PRESENT);
    }
    // 状態 (入力) は不変。
    expect(features.length).toBe(2);
  });

  it('拒否理由は日本語メッセージと機械可読フィールドの両方を返す', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const features = featuresOf([a]);
    const r = buildMergeProposal({
      features,
      vertices: storeOf(a),
      targetIds: [fid('a')],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
      ids: makeIdPorts(),
    });
    if (r.status === MERGE_STATUS.Rejected) {
      expect(r.kind).toBe(MERGE_REJECT.TooFew);
      expect(r.message).toBe(MSG_MERGE_TOO_FEW);
    } else {
      throw new Error('expected rejection');
    }
  });

  it('縦方向関係判定は循環参照を含む壊れたデータでも有限終了する (教訓 5.28)', () => {
    // A→B→A の循環 (parentId が相互参照)。
    const A = agg('A', ['B'], 0, 100, fid('B'));
    const B = agg('B', ['A'], 0, 100, fid('A'));
    const c = rectLeaf('c', 0, 0, 5, 5);
    const features = featuresOf([c], [A, B]);
    // 無限ループせず判定が返ること (結果値は問わない)。
    const v = validateMergePreconditions(features, [fid('A'), fid('c')], 50);
    expect(typeof v.ok).toBe('boolean');
  });
});

describe('受け入れ基準 4: 非隣接末端は飛び地を持つ単一末端 (FR-51, 教訓 5.1)', () => {
  it('分離した 2 末端の和が複数領土リングの 1 末端になり片落としが起きない', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 100, 100, 110, 110); // 完全に分離。
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const p = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
        ids: makeIdPorts(),
      }),
    );
    const result = p.nextFeatures.find((f) => f.id === p.resultFeatureId);
    expect(result?.kind).toBe('leaf');
    if (result?.kind === 'leaf') {
      const territoryRings = result.shape.rings.filter((r) => r.kind === 'territory');
      // 2 つの分離領土リング (飛び地)。
      expect(territoryRings.length).toBe(2);
    }
  });
});

describe('受け入れ基準 5: 不可分 1 アンドゥ・共有頂点継続', () => {
  it('結合コマンドは composite に割れず 1 回の undo で完全復元、redo で ID 再採番しない', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const p = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
        ids: makeIdPorts(),
      }),
    );
    const baseline = { features, vertices };
    const cmd = createMergeCommand(baseline, p);

    const afterExec = cmd.execute(baseline);
    expect(afterExec.state.features.find((f) => f.id === p.resultFeatureId)).toBeDefined();
    expect(afterExec.result.created.has(p.resultFeatureId)).toBe(true);

    const afterUndo = cmd.undo(afterExec.state);
    expect(afterUndo.state).toBe(baseline); // 完全復元 (同一参照)。

    const afterRedo = cmd.redo(afterUndo.state);
    // redo は同じ結果地物 ID を復元 (再採番しない)。
    expect(afterRedo.state.features.find((f) => f.id === p.resultFeatureId)).toBeDefined();
    expect(afterRedo.state).toBe(afterExec.state);
  });

  it('共有頂点関係が merge の実 vertexRemap 経由で結果地物の対応頂点へ引き継がれる (FR-95, U06→U11 両側契約)', () => {
    // 末端 a (正方 [0,0]-[10,10]) と末端 b (正方 [10,10]-[20,20]) が角 (10,10) で接する。
    // 両末端の領土リングは共有頂点 sc (10,10) を「同一 VertexId」で引用する (真に共有)。
    // 角接合のため和の外周角として残り、量子化座標照合で旧→新写像に必ず現れる
    // (隣接辺の和は共線で落ちるが角接合は残る — 実 remap を使う意義がここにある)。
    const sc = 'shared-corner' as unknown as VertexId; // (10,10)
    const va0 = createVertex('a-v0' as unknown as VertexId, createCoordinate(0, 0));
    const va1 = createVertex('a-v1' as unknown as VertexId, createCoordinate(10, 0));
    const va3 = createVertex('a-v3' as unknown as VertexId, createCoordinate(0, 10));
    const vsc = createVertex(sc, createCoordinate(10, 10));
    const vb1 = createVertex('b-v1' as unknown as VertexId, createCoordinate(20, 10));
    const vb2 = createVertex('b-v2' as unknown as VertexId, createCoordinate(20, 20));
    const vb3 = createVertex('b-v3' as unknown as VertexId, createCoordinate(10, 20));
    const store = createVertexStore([va0, va1, va3, vsc, vb1, vb2, vb3]);

    const aRing = createTerritoryRing(asRingId('a-r0'), [va0.id, va1.id, sc, va3.id]);
    const bRing = createTerritoryRing(asRingId('b-r0'), [sc, vb1.id, vb2.id, vb3.id]);
    const a = createLeafFeature(
      asFeatureId('a'),
      createBasicAttributes('a', 0, 100),
      COLOR,
      createShape([aRing]),
    );
    const b = createLeafFeature(
      asFeatureId('b'),
      createBasicAttributes('b', 0, 100),
      COLOR,
      createShape([bRing]),
    );
    const features: Feature[] = [a, b];

    // 実際の結合編集案を組み、その vertexRemap を取り出す (手書きしない)。
    const p = proposalOf(
      buildMergeProposal({
        features,
        vertices: store,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
        ids: makeIdPorts(),
      }),
    );
    // 旧共有頂点 sc は和の角として残り remap に必ず現れる (U06 後の量子化座標照合)。
    expect(p.vertexRemap.has(sc)).toBe(true);
    const newSc = p.vertexRemap.get(sc)!;

    // U11 コンテナ (a の領土リング, b の領土リング) が共有頂点 sc を引用 = 結合前は共有。
    const containers: ContainerEntry[] = [
      {
        container: { kind: 'ring', featureId: asFeatureId('a'), ringId: 'a-r0' },
        vertexIds: [va0.id, va1.id, sc, va3.id],
      },
      {
        container: { kind: 'ring', featureId: asFeatureId('b'), ringId: 'b-r0' },
        vertexIds: [sc, vb1.id, vb2.id, vb3.id],
      },
    ];
    const sharedState = createSharedVertexState(store, containers);
    expect(sharedVertexIds(sharedState)).toContain(sc);

    // 実 remap を U11 継続規則へ適用 — merge が誤った写像を作れば共有は失われ落ちる。
    const transferred = transferSharing(sharedState, p.vertexRemap);
    // 結果地物の新頂点 ID 体系で共有が維持される (新 sc が両リングから引用される)。
    expect(sharedVertexIds(transferred)).toContain(newSc);
    // 新頂点は座標源 (body) を持ち、ぶら下がり参照にならない (単一真実源)。
    expect(getVertex(transferred.vertices, newSc)).toBeDefined();
    expect(getVertex(transferred.vertices, newSc)?.coordinate).toEqual(createCoordinate(10, 10));
  });
});

// ---------------------------------------------------------------------------
// 受け入れ基準 5 (第3要件): 結合の編集案を U13 の整合性維持プロセスへ渡し、確定後に
// 末端排他・階層整合などの不変条件が維持されること (競合時は U13 競合解決を経て確定)
// を、U13 の startProcess / applyResolutions をスタブ ConsistencyPorts で結合して検証
// する統合テスト。toMergeEditProposal が生む EditProposal<MergeSnapshot> を U13 パイプ
// ラインへ実際に通す (toMergeEditProposal / U13 を一度も通さない手書き検証ではない)。
// ---------------------------------------------------------------------------

/**
 * host の applyProposal ポート相当: 不透明 MergeSnapshot を展開して候補結果状態
 * (面情報集合 + 頂点ストア) を作る。U13 は中身を読まず、このポートだけが展開する。
 * 純粋 (current 非破壊)。
 */
function applyMergeSnapshot(_current: MergeState, proposal: EditProposal<MergeSnapshot>): MergeState {
  const s = proposal.snapshot;
  return { features: s.nextFeatures, vertices: s.nextVertices };
}

/**
 * 確定後の末端排他・階層整合の不変条件を検証する。結合結果状態 (MergeState) を受け、
 * (1) 元末端/集約が同一性終了して残っていない (末端排他: 重なる元末端が同時に生きない)、
 * (2) 結果地物が存在し forest が矛盾なく組める (階層整合)、(3) 親参照が存在地物を指す。
 */
function expectMergeInvariants(state: MergeState, p: MergeProposal): void {
  const byId = new Map(state.features.map((f) => [f.id, f] as const));
  // (1) 同一性終了した元地物は結果状態に存在しない。
  for (const id of p.deletedIds) expect(byId.has(id)).toBe(false);
  // 結果地物は存在する。
  expect(byId.has(p.resultFeatureId)).toBe(true);
  // (2) 階層整合: forest が組め、結果地物がノードとして現れる。
  const forest = buildForest(state.features);
  expect(forest.byId.has(p.resultFeatureId)).toBe(true);
  // (3) 親参照の健全性: すべての parentId が存在する地物を指す (ぶら下がりなし)。
  for (const f of state.features) {
    if (f.parentId !== undefined) expect(byId.has(f.parentId)).toBe(true);
  }
  // 末端排他 (FR-26): 末端のみ結合では結果は単一末端で、元 2 末端は同時に生きない。
  if (p.mergeKind === MERGE_KIND.LeafOnly) {
    const result = byId.get(p.resultFeatureId);
    expect(result?.kind).toBe('leaf');
    expect(hasChildren(forest, p.resultFeatureId)).toBe(false);
  }
}

/** 競合 1 件を組む (末端 a・b の重なり)。overlap は U13 にとって不透明。 */
function terminalConflict(id: string, a: FeatureId, b: FeatureId): Conflict {
  return {
    id,
    kind: CONFLICT_KIND.TerminalOverlap,
    time: { kind: 'point', at: timePointYear(50) },
    a: { featureId: a, displayName: `name-${a}` },
    b: { featureId: b, displayName: `name-${b}` },
    overlap: [[[]]],
  };
}

/**
 * 結合用 ConsistencyPorts を組む。makeCommand は U30 の実 createMergeCommand を用い、
 * 単一の不可分コマンド (merge command) を 1 つだけ鋳造する。他ポートは挙動を上書き可能。
 */
function makeMergePorts(
  baseline: MergeState,
  proposal: MergeProposal,
  overrides: Partial<ConsistencyPorts<MergeState, MergeSnapshot>> = {},
): ConsistencyPorts<MergeState, MergeSnapshot> {
  return {
    applyProposal: applyMergeSnapshot,
    checkTime: () => ({ ok: true }), // 時間整合 OK (スタブ)。
    checkConstraints: () => [], // 制約違反なし (スタブ)。
    detectSpatial: () => [], // 空間競合なし (スタブ)。
    applyResolution: (state) => state, // 既定: 差分なし (上書きで差分を表現)。
    makeCommand: () => createMergeCommand(baseline, proposal), // 単一不可分コマンド (実装)。
    ...overrides,
  };
}

describe('受け入れ基準 5 (U13 結合): 編集案を整合性維持プロセスへ渡し確定後に不変条件維持', () => {
  it('競合なし: toMergeEditProposal → startProcess(時間整合→制約→空間→確定) が末端結合を単一アンドゥ単位で確定し、確定後に末端排他・階層整合が維持される', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const p = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
        ids: makeIdPorts(),
      }),
    );

    const baseline: MergeState = { features, vertices };
    const ports = makeMergePorts(baseline, p);
    const editProposal = toMergeEditProposal(p, timePointYear(50));
    // 錨を打つ地物は結果地物。
    expect(editProposal.featureId).toBe(p.resultFeatureId);

    const result = startProcess(baseline, editProposal, ports);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;

    // 確定後状態に結果地物がある・元末端は同一性終了。
    expect(result.state.features.find((f) => f.id === p.resultFeatureId)).toBeDefined();
    expect(result.state.features.find((f) => f.id === fid('a'))).toBeUndefined();
    expect(result.state.features.find((f) => f.id === fid('b'))).toBeUndefined();
    // 不変条件 (末端排他・階層整合) が維持される。
    expectMergeInvariants(result.state, p);

    // 単一アンドゥ単位: 1 度の undo で結合前へ完全復元する不可分コマンド。
    const undone = result.command.undo(result.state);
    expect(undone.state.features.find((f) => f.id === fid('a'))).toBeDefined();
    expect(undone.state.features.find((f) => f.id === fid('b'))).toBeDefined();
    expect(undone.state.features.find((f) => f.id === p.resultFeatureId)).toBeUndefined();
    // redo は再採番せず同一結果地物 ID を復元。
    const redone = result.command.redo(undone.state);
    expect(redone.state.features.find((f) => f.id === p.resultFeatureId)).toBeDefined();
  });

  it('競合あり: startProcess が conflicts-pending を返し、applyResolutions が U13 競合解決 (U06 差分) を経て確定する', () => {
    // 結合結果地物 R と既存末端 X が重なる想定。差分で X を調整して収束させる。
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const x = rectLeaf('x', 5, 0, 15, 10); // 結合結果に重なる別末端。
    const features = featuresOf([a, b, x]);
    const vertices = storeOf(a, b, x);
    const p = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
        ids: makeIdPorts(),
      }),
    );
    const baseline: MergeState = { features, vertices };
    const conflict = terminalConflict('c-rx', p.resultFeatureId, fid('x'));

    // 初回検出で競合 1 件、差分適用後の再検出では 0 件 (収束)。
    let detected = false;
    let adjusted = false;
    const ports = makeMergePorts(baseline, p, {
      detectSpatial: () => {
        if (!detected) {
          detected = true;
          return [conflict];
        }
        return adjusted ? [] : [conflict];
      },
      applyResolution: (state, _conflict, resolution) => {
        // U06 差分相当: 調整対象 (x) をトリムして状態へ反映 (ここでは x を縮める代理)。
        adjusted = true;
        const trimmed = state.features.map((f) =>
          f.id === resolution.adjustFeatureId && f.kind === 'leaf'
            ? createLeafFeature(
                f.id,
                f.attributes,
                f.color,
                createShape([
                  createTerritoryRing(
                    asRingId('x-trim'),
                    f.shape.rings[0]!.vertexIds,
                  ),
                ]),
              )
            : f,
        );
        return { features: trimmed, vertices: state.vertices };
      },
    });

    const editProposal = toMergeEditProposal(p, timePointYear(50));

    // startProcess: 競合検出で一時停止 (確定しない)。
    const started = startProcess(baseline, editProposal, ports);
    expect(started.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (started.status !== PROCESS_STATUS.ConflictsPending) return;
    expect(started.conflicts.map((c) => c.id)).toEqual([conflict.id]);
    expect(started.unresolvedConflictIds).toEqual([conflict.id]);

    // applyResolutions: 競合に優先/調整方針を与え、U13 競合解決を経て確定。
    const resolution: Resolution = {
      conflictId: conflict.id,
      priorityFeatureId: p.resultFeatureId, // 結合結果を優先 (whole)。
      adjustFeatureId: fid('x'), // x を差分でトリム。
    };
    const resolved = applyResolutions(baseline, editProposal, [resolution], ports);
    expect(resolved.status).toBe(PROCESS_STATUS.Committed);
    if (resolved.status !== PROCESS_STATUS.Committed) return;

    // 確定後: 結合結果地物が確定し、元末端 a/b は同一性終了。差分で x は存続。
    expect(resolved.state.features.find((f) => f.id === p.resultFeatureId)).toBeDefined();
    expect(resolved.state.features.find((f) => f.id === fid('a'))).toBeUndefined();
    expect(resolved.state.features.find((f) => f.id === fid('b'))).toBeUndefined();
    expect(resolved.state.features.find((f) => f.id === fid('x'))).toBeDefined();
    // 不変条件 (末端排他・階層整合) が維持される。
    expectMergeInvariants(resolved.state, p);
  });

  it('時間整合違反: checkTime 拒否で確定せず空間検出に到達しない (固定順序・早期リターン)', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const p = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
        ids: makeIdPorts(),
      }),
    );
    const baseline: MergeState = { features, vertices };
    let spatialCalled = false;
    let commandMade = false;
    const ports = makeMergePorts(baseline, p, {
      checkTime: () => ({ ok: false, reason: { code: 'TIME-X' } }),
      detectSpatial: () => {
        spatialCalled = true;
        return [];
      },
      makeCommand: () => {
        commandMade = true;
        return createMergeCommand(baseline, p);
      },
    });
    const result = startProcess(baseline, toMergeEditProposal(p, timePointYear(50)), ports);
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    expect(spatialCalled).toBe(false); // 早期リターン: 空間検出へ進まない。
    expect(commandMade).toBe(false); // 確定しない (状態不変)。
  });

  it('makeCommand は単一の不可分 (merge) コマンドを 1 つだけ鋳造する (composite に割れない)', () => {
    const a = rectLeaf('a', 0, 0, 10, 10);
    const b = rectLeaf('b', 10, 0, 20, 10);
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const p = proposalOf(
      buildMergeProposal({
        features,
        vertices,
        targetIds: [fid('a'), fid('b')],
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
        ids: makeIdPorts(),
      }),
    );
    const baseline: MergeState = { features, vertices };
    let minted = 0;
    let lastCommand: Command<MergeState> | undefined;
    const ports = makeMergePorts(baseline, p, {
      makeCommand: () => {
        minted += 1;
        lastCommand = createMergeCommand(baseline, p);
        return lastCommand;
      },
    });
    const result = startProcess(baseline, toMergeEditProposal(p, timePointYear(50)), ports);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    expect(minted).toBe(1); // 2 個以上に割れない。
    // 参考: composite 化したい host は同コマンドを 1 要素として包める。
    if (lastCommand !== undefined) {
      const composite = createCompositeCommand('結合 (U13)', [lastCommand]);
      expect(composite.kind).toBe(COMPOSITE_COMMAND_KIND);
    }
  });
});

describe('受け入れ基準 6: domain 純粋性・拒否時の状態不変', () => {
  it('拒否時に入力 features / vertices を破壊しない', () => {
    const a = rectLeaf('a', 0, 0, 10, 10, 0, 100);
    const b = rectLeaf('b', 10, 0, 20, 10, 200, 300); // 非存在で拒否させる。
    const features = featuresOf([a, b]);
    const vertices = storeOf(a, b);
    const snapshot = features.map((f) => f.id);
    buildMergeProposal({
      features,
      vertices,
      targetIds: [fid('a'), fid('b')],
      atTime: 50,
      parentDecision: parentNone,
      propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 100), color: COLOR }),
      ids: makeIdPorts(),
    });
    expect(features.map((f) => f.id)).toEqual(snapshot);
    expect(vertices.byId.size).toBe(8);
  });
});
