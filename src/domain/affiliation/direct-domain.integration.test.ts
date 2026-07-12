// FR-37 直轄領自動生成 — 所属変更フロー結線の統合テスト (実機データ損失級バグの本筋修正).
//
// 実機バグ: 形状持ち末端 (例: f11「ラヴィエンド・ウィル同君王国」= 領土1+穴6 の holed leaf)
// の下へ地物を所属変更 (直轄化) すると、旧実装は親を「形状破棄の集約」へ変換し、元領域−子の和
// が地図から沈黙裡に消えていた (checkAggregateShapes は元形状を比較しないため無反応)。
//
// 本テストは「穴あり大 leaf の下へ 小 leaf を直轄化」を FR-37 の正 (元形状 − 子の和 を直轄領
// 末端地物として自動生成し親領域を保存) で end-to-end に検証する:
//   1. 編集案 (buildAffiliationProposal) が直轄領を生成し、親を集約化し、新頂点を運ぶ。
//   2. U13 apply (toAffiliationEditProposal → applyAffiliationProposal) が直轄領 leaf の
//      履歴に新頂点を載せ、適用後の DomainProject が checkConsistency (FR-106) で clean。
//   3. 適用後の実効状態で親 (旧 holed leaf) の面積が元 holed 形状のまま保存される (損失なし)。
//   4. 単一アンドゥ単位 (createAffiliationCommand) の undo で baseline へ完全復帰・redo 再現。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature, type Feature, type LeafFeature } from '../feature';
import { createShape, createHoleRing, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createIdGeneratorState } from '../id-generator';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { areasEqualWithinTolerance } from '../hierarchy/validate';
import { getCalendar } from '../time/calendar';
import { timePointYear, type TimePoint } from '../time/time-point';
import { resolveAt } from '../anchor-series';
import { createGeoParams } from '../geo/geo-params';
import type { DomainProject } from '../persistence/serialize';
import { checkConsistency } from '../persistence/consistency';
import { applyAddProposal } from '../editing/apply-proposal';
import {
  applyAffiliationProposal,
  toAffiliationEditProposal,
} from '../editing/apply-proposal';
import { buildAffiliationProposal } from './proposal';
import { parentExisting } from './decision';
import { createAffiliationCommand } from './command';

const calendar = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function emptyProject(): DomainProject {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

interface Added {
  readonly feature: LeafFeature;
  readonly vertices: readonly Vertex[];
}

/** A large 穴あり (holed) leaf: outer [0,100]² with a lake hole [40,60]². (f11 に相当する形状.) */
function holedLeaf(id: FeatureId): Added {
  const outer = [
    createVertex(asVertexId('L-o0'), createCoordinate(0, 0)),
    createVertex(asVertexId('L-o1'), createCoordinate(100, 0)),
    createVertex(asVertexId('L-o2'), createCoordinate(100, 100)),
    createVertex(asVertexId('L-o3'), createCoordinate(0, 100)),
  ];
  const hole = [
    createVertex(asVertexId('L-h0'), createCoordinate(40, 40)),
    createVertex(asVertexId('L-h1'), createCoordinate(60, 40)),
    createVertex(asVertexId('L-h2'), createCoordinate(60, 60)),
    createVertex(asVertexId('L-h3'), createCoordinate(40, 60)),
  ];
  const tRing = createTerritoryRing(asRingId('L-rt'), outer.map((v) => v.id));
  const hRing = createHoleRing(asRingId('L-rh'), hole.map((v) => v.id), asRingId('L-rt'));
  const feature = createLeafFeature(
    id,
    createBasicAttributes('ラヴィエンド・ウィル同君王国', 0, 1000),
    COLOR,
    createShape([tRing, hRing]),
  );
  return { feature, vertices: [...outer, ...hole] };
}

/** A small leaf [10,20]² sitting INSIDE the large leaf's solid area (away from its lake). */
function smallLeaf(id: FeatureId): Added {
  const verts = [
    createVertex(asVertexId('S-0'), createCoordinate(10, 10)),
    createVertex(asVertexId('S-1'), createCoordinate(20, 10)),
    createVertex(asVertexId('S-2'), createCoordinate(20, 20)),
    createVertex(asVertexId('S-3'), createCoordinate(10, 20)),
  ];
  const ring = createTerritoryRing(asRingId('S-rt'), verts.map((v) => v.id));
  const feature = createLeafFeature(
    id,
    createBasicAttributes('小領', 0, 1000),
    COLOR,
    createShape([ring]),
  );
  return { feature, vertices: verts };
}

/** Collect the effective feature set + merged vertex store of a live project at `at`. */
function effectiveAt(root: DomainProject, at: TimePoint): { features: Feature[]; store: VertexStore } {
  const features: Feature[] = [];
  const verts: Vertex[] = [];
  const seen = new Set<string>();
  for (const h of root.histories) {
    const r = resolveAt(h.series, at, calendar);
    if (r.kind !== 'present') continue;
    for (const f of r.entry.anchor.snapshot.features) {
      if (seen.has(f.id as string)) continue;
      seen.add(f.id as string);
      features.push(f);
    }
    for (const v of r.entry.anchor.snapshot.vertices.byId.values()) verts.push(v);
  }
  return { features, store: createVertexStore(verts) };
}

describe('FR-37 直轄領自動生成 — 穴あり大 leaf の下へ 小 leaf を直轄化 (実機データ損失級バグの本筋修正)', () => {
  it('親領域が直轄領込みで保存され、apply 後 checkConsistency が clean、undo で完全に戻る', () => {
    const lId = asFeatureId('L');
    const sId = asFeatureId('S');
    const L = holedLeaf(lId);
    const S = smallLeaf(sId);

    const baseFeatures: Feature[] = [L.feature, S.feature];
    const baseStore = createVertexStore([...L.vertices, ...S.vertices]);

    // 元の holed L 面積 (領域保存の基準値)。
    const beforeForest = buildForest(baseFeatures);
    const lAreaBefore = resolveFeatureArea(beforeForest, baseStore, lId);
    expect(lAreaBefore.status).toBe('ok');

    // --- 1. 編集案: 直轄化 S under L ------------------------------------------
    const result = buildAffiliationProposal(baseFeatures, sId, parentExisting(lId), {
      idState: createIdGeneratorState(),
      now: () => 1,
      vertexStore: baseStore,
    });
    expect(result.status, JSON.stringify(result)).toBe('proposal');
    if (result.status !== 'proposal') return;
    const proposal = result.proposal;

    // FR-37: 直轄領 leaf が新頂点付きで生成された。
    expect(proposal.newVertices.length).toBeGreaterThan(0);
    const merged = createVertexStore([...baseStore.byId.values(), ...proposal.newVertices]);

    // L は形状なし集約へ。子 = 直轄化した S + 新しい直轄領 leaf。
    expect(proposal.nextFeatures.find((f) => f.id === lId)?.kind).toBe('aggregate');
    const nextForest = buildForest(proposal.nextFeatures);
    const lChildren = directChildIds(nextForest, lId);
    expect(lChildren).toContain(sId);
    expect(lChildren).toHaveLength(2);
    const ddId = lChildren.find((id) => id !== sId)!;
    expect(proposal.createdIds).toContain(ddId);
    expect(proposal.nextFeatures.find((f) => f.id === ddId)?.kind).toBe('leaf');

    // 直轄領 area = 元 holed L − S (穴 [40,60] + S を穴とする holed 形状)。
    // 親 L の派生面積 = union(S, 直轄領) = 元 holed L。領域は 1mm も失われない。
    const lAreaAfter = resolveFeatureArea(nextForest, merged, lId);
    expect(lAreaAfter.status).toBe('ok');
    if (lAreaAfter.status === 'ok' && lAreaBefore.status === 'ok') {
      expect(areasEqualWithinTolerance(lAreaAfter.area, lAreaBefore.area)).toBe(true);
    }

    // --- 2. U13/U44 apply → checkConsistency (FR-106) clean -------------------
    let root = emptyProject();
    for (const add of [L, S]) {
      root = applyAddProposal(root, {
        featureId: add.feature.id,
        anchorTime: timePointYear(0),
        snapshot: { feature: add.feature, vertices: [...add.vertices], sharedCandidateIds: new Map() },
      });
    }
    const editProposal = toAffiliationEditProposal(proposal, timePointYear(0));
    const applied = applyAffiliationProposal(root, editProposal, calendar);

    const report = checkConsistency(applied, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);

    // --- 3. 適用後の実効状態でも親領域が保存されている ------------------------
    const eff = effectiveAt(applied, timePointYear(0));
    const effForest = buildForest(eff.features);
    expect(eff.features.find((f) => f.id === lId)?.kind).toBe('aggregate');
    expect(eff.features.find((f) => f.id === ddId)?.kind).toBe('leaf'); // 直轄領 leaf が実在.
    const lAreaApplied = resolveFeatureArea(effForest, eff.store, lId);
    expect(lAreaApplied.status).toBe('ok');
    if (lAreaApplied.status === 'ok' && lAreaBefore.status === 'ok') {
      expect(areasEqualWithinTolerance(lAreaApplied.area, lAreaBefore.area)).toBe(true);
    }

    // --- 4. 単一アンドゥ単位: undo で baseline へ完全復帰・redo 再現 (FR-94) ----
    const command = createAffiliationCommand(baseFeatures, proposal);
    const afterExec = command.execute(baseFeatures);
    expect(afterExec.state).toBe(proposal.nextFeatures);
    const afterUndo = command.undo(afterExec.state);
    expect(afterUndo.state).toBe(baseFeatures); // 直轄領も含めて完全に元へ戻る.
    const afterRedo = command.redo(afterUndo.state);
    expect(afterRedo.state).toBe(proposal.nextFeatures); // 再採番なし (教訓 5.20).
  });
});
