// A5 / 実機報告「結合後の .gimoza が 3.5× 肥大 + 操作が重い」の回帰ロック。
//
// ROOT CAUSE (剪定欠落): applyMergeProposal の 3 経路 (step1 removeFeatureAtTime /
// step2 rewriteFeatureSnapshotAtTime / step4 applyVertexRemapToHistories→remapVertexStore)
// が、新しいアンカースナップショットの頂点ストアを referencedVertexIds へ剪定せず、結合の
// 全頂点プール (末端のみ結合では ~95k) を丸ごと焼き込んでいた。結果、参照 3 頂点の leaf が
// 95,517 頂点を保持する等のオーファン肥大が生じ、保存ファイルが 25× に膨れ、以後の全操作の
// コピー/シリアライズを重くしていた (かつ第7波の偽 VertexCoordinateDivergence 温床)。
//
// INVARIANT (単一真実源 波7/10/11・教訓 5.30): 全アンカースナップショットで
//   snapshot.vertices の格納 id 集合 == その features が referencedVertexIds で参照する id 集合
// が成り立つ (オーファンなし かつ dangling なし)。結合の全パターン (末端のみ / 集約のみ /
// 混在 / 集約子の畳み込み / 共有頂点 NEIGHBOUR の張り替え) でこれをロックする。

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { applyAddProposal, applyMergeProposal } from './apply-proposal';
import { MERGE_STATUS, buildMergeProposal, toMergeEditProposal } from '../merge/proposal';
import { parentNone, propertyNew } from '../merge/decision';
import { makeIdPorts } from '../merge/fixtures';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes, createColorInfo } from '../attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  referencedVertexIds,
  type Feature,
} from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry } from '../anchor-series';
import { asAnchorId, asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';
import { createGeoParams } from '../geo/geo-params';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T0 = timePointYear(0);
const TMERGE = timePointYear(500);

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

/**
 * THE invariant: in every anchor snapshot of every history, the stored vertex-id set
 * equals the set of ids the snapshot's features reference. No orphan (肥大), no dangling.
 */
function assertAllSnapshotsLean(project: DomainProject, label: string): void {
  for (const history of project.histories) {
    for (const entry of history.series.entries) {
      const snap = entry.anchor.snapshot;
      const referenced = new Set<string>();
      for (const f of snap.features) for (const id of referencedVertexIds(f)) referenced.add(String(id));
      const stored = new Set<string>();
      for (const id of snap.vertices.byId.keys()) stored.add(String(id));
      // No orphan: every stored vertex is referenced by some feature in the snapshot.
      for (const id of stored) {
        expect(
          referenced.has(id),
          `${label}: history ${String(history.featureId)} stores ORPHAN vertex ${id} (肥大: stored=${stored.size} referenced=${referenced.size})`,
        ).toBe(true);
      }
      // No dangling: every referenced vertex has a body in the store.
      for (const id of referenced) {
        expect(
          stored.has(id),
          `${label}: history ${String(history.featureId)} cites vertex ${id} absent from its store (dangling)`,
        ).toBe(true);
      }
    }
  }
}

/** Seed one leaf's history (lean: store carries only the leaf's own referenced vertices). */
function seedLeaf(root: DomainProject, feature: Feature, allVertices: readonly Vertex[]): DomainProject {
  const refs = new Set(referencedVertexIds(feature).map(String));
  const own = allVertices.filter((v) => refs.has(String(v.id)));
  return applyAddProposal(root, {
    featureId: feature.id,
    anchorTime: T0,
    snapshot: { feature, vertices: own, sharedCandidateIds: new Map() },
  });
}

// ---------------------------------------------------------------------------
// Property: leaf-only merge over a chain of adjacent squares that SHARE their
// touching edge vertices. Merging leaf i + i+1 re-mints the union boundary and must
// repoint the neighbours i-1 / i+2 (which share the outer edges) — the step-4 remap
// path — while dropping every merged-away private vertex. Every resulting snapshot
// must stay lean. (Chain endpoints also exercise step-1 delete of sole-occupant leaves.)
// ---------------------------------------------------------------------------

interface Chain {
  readonly features: Feature[];
  readonly vertices: Vertex[];
}

/** A horizontal chain of `n` unit squares sharing their vertical touching edges. */
function buildAdjacentChain(n: number): Chain {
  // Shared column vertices: col k has lo=(k*10,0), hi=(k*10,10), for k = 0..n.
  const lo: Vertex[] = [];
  const hi: Vertex[] = [];
  for (let k = 0; k <= n; k += 1) {
    lo.push(createVertex(asVertexId(`col${k}-lo`), { lon: k * 10, lat: 0 }));
    hi.push(createVertex(asVertexId(`col${k}-hi`), { lon: k * 10, lat: 10 }));
  }
  const features: Feature[] = [];
  for (let k = 0; k < n; k += 1) {
    const ring = createTerritoryRing(asRingId(`leaf${k}-r0`), [
      lo[k]!.id,
      lo[k + 1]!.id,
      hi[k + 1]!.id,
      hi[k]!.id,
    ]);
    features.push(
      createLeafFeature(
        asFeatureId(`leaf${k}`),
        createBasicAttributes(`leaf${k}`, 0, 1000),
        color,
        createShape([ring]),
      ),
    );
  }
  return { features, vertices: [...lo, ...hi] };
}

describe('A5 merge snapshot prune — leaf-only chain (step-4 neighbour remap + step-1 delete)', () => {
  it('every snapshot stays lean (stored == referenced) after merging two adjacent shared-edge leaves', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 8 }), fc.integer({ min: 0, max: 200 }), (n, pick) => {
        const chain = buildAdjacentChain(n);
        const store = createVertexStore(chain.vertices);
        let root = emptyProject();
        for (const f of chain.features) root = seedLeaf(root, f, chain.vertices);

        const i = pick % (n - 1); // merge leaf i + leaf i+1 (adjacent)
        const targetIds = [asFeatureId(`leaf${i}`), asFeatureId(`leaf${i + 1}`)];
        const built = buildMergeProposal({
          features: chain.features,
          vertices: store,
          targetIds,
          atTime: TMERGE.year,
          parentDecision: parentNone,
          propertyDecision: propertyNew({
            attributes: createBasicAttributes('merged', 0, 1000),
            color,
          }),
          ids: makeIdPorts(`chain${n}-${i}`),
        });
        expect(built.status).toBe(MERGE_STATUS.Proposal);
        if (built.status !== MERGE_STATUS.Proposal) return;

        const next = applyMergeProposal(root, toMergeEditProposal(built.proposal, TMERGE), calendar);
        assertAllSnapshotsLean(next, `chain n=${n} merge leaf${i}+leaf${i + 1}`);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic: merge two child leaves that live INSIDE their aggregate's snapshot
// (step-1 removeFeatureAtTime must drop the folded children's private vertices from the
// aggregate snapshot instead of leaving them as orphans — the exact f170 症状).
// ---------------------------------------------------------------------------

describe('A5 merge snapshot prune — folding aggregate children (step-1 delete orphan)', () => {
  it('the aggregate snapshot loses the merged-away children vertices (no orphan bloat)', () => {
    const va = [
      createVertex(asVertexId('ca-v0'), { lon: 0, lat: 0 }),
      createVertex(asVertexId('ca-v1'), { lon: 10, lat: 0 }),
      createVertex(asVertexId('ca-v2'), { lon: 10, lat: 10 }),
      createVertex(asVertexId('ca-v3'), { lon: 0, lat: 10 }),
    ];
    const vb = [
      createVertex(asVertexId('cb-v0'), { lon: 10, lat: 0 }),
      createVertex(asVertexId('cb-v1'), { lon: 20, lat: 0 }),
      createVertex(asVertexId('cb-v2'), { lon: 20, lat: 10 }),
      createVertex(asVertexId('cb-v3'), { lon: 10, lat: 10 }),
    ];
    const aggId = asFeatureId('agg');
    const childA = createLeafFeature(
      asFeatureId('ca'),
      createBasicAttributes('ca', 0, 1000),
      color,
      createShape([createTerritoryRing(asRingId('ca-r0'), va.map((v) => v.id))]),
      { parentId: aggId },
    );
    const childB = createLeafFeature(
      asFeatureId('cb'),
      createBasicAttributes('cb', 0, 1000),
      color,
      createShape([createTerritoryRing(asRingId('cb-r0'), vb.map((v) => v.id))]),
      { parentId: aggId },
    );
    const aggregate = createAggregateFeature(
      aggId,
      createBasicAttributes('agg', 0, 1000),
      color,
      [childA.id, childB.id],
    );

    // ONE history whose snapshot carries the aggregate AND both children (+ all vertices):
    // this is the persistence shape `[...children, agg]` the merge folds children out of.
    const store = createVertexStore([...va, ...vb]);
    const snap = createAnchorSnapshot([childA, childB, aggregate], store);
    const history: FeatureHistory = {
      featureId: aggId,
      series: { entries: [createAnchorEntry(createAnchor(asAnchorId('agg-anc'), snap), T0, null)] },
    };
    const root: DomainProject = { ...emptyProject(), histories: [history] };
    assertAllSnapshotsLean(root, 'baseline (aggregate + 2 children)');

    const built = buildMergeProposal({
      features: [childA, childB, aggregate],
      vertices: store,
      targetIds: [childA.id, childB.id],
      atTime: TMERGE.year,
      parentDecision: parentNone,
      propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 1000), color }),
      ids: makeIdPorts('fold'),
    });
    expect(built.status).toBe(MERGE_STATUS.Proposal);
    if (built.status !== MERGE_STATUS.Proposal) return;

    const next = applyMergeProposal(root, toMergeEditProposal(built.proposal, TMERGE), calendar);
    assertAllSnapshotsLean(next, 'after folding two aggregate children');
  });
});

// ---------------------------------------------------------------------------
// Deterministic: aggregate-only merge (step-2 rewriteFeatureSnapshotAtTime for the
// reparented survivors + step-1 for the folded aggregates). Survivor child snapshots
// must not bloat.
// ---------------------------------------------------------------------------

describe('A5 merge snapshot prune — aggregate-only merge (step-2 survived rewrite)', () => {
  it('reparented children snapshots stay lean after merging two aggregates', () => {
    function aggWithChild(tag: string, x0: number): {
      readonly features: Feature[];
      readonly vertices: Vertex[];
      readonly aggId: FeatureId;
    } {
      const verts = [
        createVertex(asVertexId(`${tag}-v0`), { lon: x0, lat: 0 }),
        createVertex(asVertexId(`${tag}-v1`), { lon: x0 + 10, lat: 0 }),
        createVertex(asVertexId(`${tag}-v2`), { lon: x0 + 10, lat: 10 }),
        createVertex(asVertexId(`${tag}-v3`), { lon: x0, lat: 10 }),
      ];
      const aggId = asFeatureId(`${tag}-agg`);
      const child = createLeafFeature(
        asFeatureId(`${tag}-child`),
        createBasicAttributes(`${tag}-child`, 0, 1000),
        color,
        createShape([createTerritoryRing(asRingId(`${tag}-r0`), verts.map((v) => v.id))]),
        { parentId: aggId },
      );
      const aggregate = createAggregateFeature(
        aggId,
        createBasicAttributes(`${tag}-agg`, 0, 1000),
        color,
        [child.id],
      );
      return { features: [child, aggregate], vertices: verts, aggId };
    }

    const A = aggWithChild('A', 0);
    const B = aggWithChild('B', 30);
    const allFeatures = [...A.features, ...B.features];
    const allVertices = [...A.vertices, ...B.vertices];
    const store = createVertexStore(allVertices);

    // Seed each aggregate as its own history whose snapshot holds [child, agg] + child verts.
    let root = emptyProject();
    for (const { features, verts, aggId } of [
      { features: A.features, verts: A.vertices, aggId: A.aggId },
      { features: B.features, verts: B.vertices, aggId: B.aggId },
    ]) {
      const snap = createAnchorSnapshot(features, createVertexStore(verts));
      const history: FeatureHistory = {
        featureId: aggId,
        series: { entries: [createAnchorEntry(createAnchor(asAnchorId(`${String(aggId)}-anc`), snap), T0, null)] },
      };
      root = { ...root, histories: [...root.histories, history] };
    }
    assertAllSnapshotsLean(root, 'baseline (two aggregates)');

    const built = buildMergeProposal({
      features: allFeatures,
      vertices: store,
      targetIds: [A.aggId, B.aggId],
      atTime: TMERGE.year,
      parentDecision: parentNone,
      propertyDecision: propertyNew({ attributes: createBasicAttributes('m', 0, 1000), color }),
      ids: makeIdPorts('aggmerge'),
    });
    expect(built.status).toBe(MERGE_STATUS.Proposal);
    if (built.status !== MERGE_STATUS.Proposal) return;

    const next = applyMergeProposal(root, toMergeEditProposal(built.proposal, TMERGE), calendar);
    assertAllSnapshotsLean(next, 'after aggregate-only merge');
  });
});
