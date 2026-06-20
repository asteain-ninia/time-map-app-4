// U30 — 合体 (結合) の不変条件プロパティテスト (受け入れ基準 7, fast-check)。
//
// ランダム生成した面情報集合 (末端・集約・混在、隣接/非隣接) に対し、種別ごとの規則と
// 拒否時の状態不変を生成入力で検証する。

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createBasicAttributes } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { buildForest, hasChildren } from '../hierarchy/forest';
import {
  MERGE_KIND,
  MERGE_STATUS,
  buildMergeProposal,
} from './proposal';
import { makeIdPorts } from './fixtures';
import { parentNone, propertyNew } from './decision';
import { COLOR } from './fixtures';

/** A rectangle leaf feature + its vertices, at a grid position. */
function rectLeafAt(
  id: string,
  gx: number,
  gy: number,
  size: number,
): { feature: Feature; vertices: Vertex[] } {
  const x = gx * 100;
  const y = gy * 100;
  const coords = [
    createCoordinate(x, y),
    createCoordinate(x + size, y),
    createCoordinate(x + size, y + size),
    createCoordinate(x, y + size),
  ];
  const vertices: Vertex[] = coords.map((c, i) => createVertex(asVertexId(`${id}-v${i}`), c));
  const ring = createTerritoryRing(asRingId(`${id}-r0`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 100),
    COLOR,
    createShape([ring]),
  );
  return { feature, vertices };
}

describe('受け入れ基準 7: プロパティ (末端のみ結合)', () => {
  it('成功時、結果は常に 1 件・新規 ID・末端、元末端は全件消滅', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 5 }), (n) => {
        const leaves = Array.from({ length: n }, (_, i) => rectLeafAt(`L${i}`, i * 2, 0, 50));
        const features = leaves.map((l) => l.feature);
        const vertices = createVertexStore(leaves.flatMap((l) => l.vertices));
        const targetIds = features.map((f) => f.id);
        const r = buildMergeProposal({
          features,
          vertices,
          targetIds,
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: propertyNew({
            attributes: createBasicAttributes('m', 0, 100),
            color: COLOR,
          }),
          ids: makeIdPorts(`p${n}`),
        });
        expect(r.status).toBe(MERGE_STATUS.Proposal);
        if (r.status !== MERGE_STATUS.Proposal) return;
        const p = r.proposal;
        expect(p.mergeKind).toBe(MERGE_KIND.LeafOnly);
        // 結果地物 1 件・新規。
        const result = p.nextFeatures.filter((f) => f.id === p.resultFeatureId);
        expect(result.length).toBe(1);
        expect(result[0]?.kind).toBe('leaf');
        expect(targetIds).not.toContain(p.resultFeatureId);
        // 元末端は全件消滅。
        for (const id of targetIds) {
          expect(p.nextFeatures.find((f) => f.id === id)).toBeUndefined();
        }
        expect(new Set(p.deletedIds)).toEqual(new Set(targetIds));
      }),
    );
  });
});

describe('受け入れ基準 7: プロパティ (集約のみ結合)', () => {
  it('成功時、結果は形状属性を持たない 1 集約、下位は平坦化統合され同一性保持', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 4 }), (n) => {
        const aggregates: Feature[] = [];
        const childLeaves: { feature: Feature; vertices: Vertex[] }[] = [];
        const aggIds: FeatureId[] = [];
        for (let i = 0; i < n; i += 1) {
          const aggId = asFeatureId(`A${i}`);
          aggIds.push(aggId);
          const child = rectLeafAt(`c${i}`, i * 2, 0, 50);
          // 子の親を集約へ。
          const childFeature = createLeafFeature(
            child.feature.id,
            createBasicAttributes(`c${i}`, 0, 100),
            COLOR,
            createShape([createTerritoryRing(asRingId(`c${i}-r0`), child.vertices.map((v) => v.id))]),
            { parentId: aggId },
          );
          childLeaves.push({ feature: childFeature, vertices: child.vertices });
          aggregates.push(
            createAggregateFeature(aggId, createBasicAttributes(`A${i}`, 0, 100), COLOR, [child.feature.id]),
          );
        }
        const features = [...childLeaves.map((c) => c.feature), ...aggregates];
        const vertices = createVertexStore(childLeaves.flatMap((c) => c.vertices));
        const r = buildMergeProposal({
          features,
          vertices,
          targetIds: aggIds,
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: propertyNew({
            attributes: createBasicAttributes('agg', 0, 100),
            color: COLOR,
          }),
          ids: makeIdPorts(`a${n}`),
        });
        expect(r.status).toBe(MERGE_STATUS.Proposal);
        if (r.status !== MERGE_STATUS.Proposal) return;
        const p = r.proposal;
        expect(p.mergeKind).toBe(MERGE_KIND.AggregateOnly);
        const result = p.nextFeatures.find((f) => f.id === p.resultFeatureId);
        expect(result?.kind).toBe('aggregate');
        expect(result).not.toHaveProperty('shape');
        // 結果集約は下位を持つ (forest 結果状態)。
        const forest = buildForest(p.nextFeatures);
        expect(hasChildren(forest, p.resultFeatureId)).toBe(true);
        // 元集約は消滅。
        for (const id of aggIds) {
          expect(p.nextFeatures.find((f) => f.id === id)).toBeUndefined();
        }
        // 全下位は同一性保持・結果集約が親。
        for (const c of childLeaves) {
          const next = p.nextFeatures.find((f) => f.id === c.feature.id);
          expect(next).toBeDefined();
          expect(next?.parentId).toBe(p.resultFeatureId);
        }
      }),
    );
  });
});

describe('受け入れ基準 7: プロパティ (混在結合は下位に末端を含む)', () => {
  it('成功時、結果集約の下位に末端対象が含まれ末端は同一性保持', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }), (numAgg, numLeaf) => {
        const features: Feature[] = [];
        const allVerts: Vertex[] = [];
        const targetIds: FeatureId[] = [];
        const leafTargetIds: FeatureId[] = [];
        for (let i = 0; i < numAgg; i += 1) {
          const aggId = asFeatureId(`A${i}`);
          targetIds.push(aggId);
          const child = rectLeafAt(`ac${i}`, i * 2, 5, 50);
          features.push(
            createLeafFeature(
              child.feature.id,
              createBasicAttributes(`ac${i}`, 0, 100),
              COLOR,
              createShape([createTerritoryRing(asRingId(`ac${i}-r0`), child.vertices.map((v) => v.id))]),
              { parentId: aggId },
            ),
          );
          allVerts.push(...child.vertices);
          features.push(
            createAggregateFeature(aggId, createBasicAttributes(`A${i}`, 0, 100), COLOR, [child.feature.id]),
          );
        }
        for (let i = 0; i < numLeaf; i += 1) {
          const leaf = rectLeafAt(`L${i}`, i * 2, 0, 50);
          features.push(leaf.feature);
          allVerts.push(...leaf.vertices);
          targetIds.push(leaf.feature.id);
          leafTargetIds.push(leaf.feature.id);
        }
        const vertices = createVertexStore(allVerts);
        const r = buildMergeProposal({
          features,
          vertices,
          targetIds,
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: propertyNew({
            attributes: createBasicAttributes('mixed', 0, 100),
            color: COLOR,
          }),
          ids: makeIdPorts(`x${numAgg}-${numLeaf}`),
        });
        expect(r.status).toBe(MERGE_STATUS.Proposal);
        if (r.status !== MERGE_STATUS.Proposal) return;
        const p = r.proposal;
        expect(p.mergeKind).toBe(MERGE_KIND.Mixed);
        // 末端対象は同一性保持・結果集約が親 (下位として継続)。
        for (const id of leafTargetIds) {
          const next = p.nextFeatures.find((f) => f.id === id);
          expect(next).toBeDefined();
          expect(next?.parentId).toBe(p.resultFeatureId);
        }
      }),
    );
  });
});

describe('受け入れ基準 7: プロパティ (拒否時は状態完全一致)', () => {
  it('縦方向関係や非存在で拒否されたとき入力地物集合は変化しない', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1 }), (single) => {
        // 1 件のみ (TooFew) または縦方向関係を作る。
        const child = rectLeafAt('child', 0, 0, 50);
        const childWithParent = createLeafFeature(
          child.feature.id,
          createBasicAttributes('child', 0, 100),
          COLOR,
          createShape([createTerritoryRing(asRingId('child-r0'), child.vertices.map((v) => v.id))]),
          { parentId: asFeatureId('A') },
        );
        const A = createAggregateFeature(asFeatureId('A'), createBasicAttributes('A', 0, 100), COLOR, [
          child.feature.id,
        ]);
        const features: Feature[] = [childWithParent, A];
        const vertices = createVertexStore(child.vertices);
        const before = features.map((f) => ({ id: f.id, parentId: f.parentId }));
        const targetIds = single === 0 ? [asFeatureId('A')] : [asFeatureId('A'), child.feature.id];
        const r = buildMergeProposal({
          features,
          vertices,
          targetIds,
          atTime: 50,
          parentDecision: parentNone,
          propertyDecision: propertyNew({
            attributes: createBasicAttributes('m', 0, 100),
            color: COLOR,
          }),
          ids: makeIdPorts('rej'),
        });
        expect(r.status).toBe(MERGE_STATUS.Rejected);
        // 入力は破壊されない。
        const after = features.map((f) => ({ id: f.id, parentId: f.parentId }));
        expect(after).toEqual(before);
      }),
    );
  });
});
