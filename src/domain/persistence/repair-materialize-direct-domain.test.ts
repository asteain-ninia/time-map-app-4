// PERMANENT regression + acceptance suite for the FR-37 直轄領 materialisation repair
// (NON-DESTRUCTIVE leaf-with-children repair). See repair.ts `materializeDirectDomain`.
//
// WHY (実ユーザーデータ損失級バグ): a declared LEAF that has ACQUIRED children (FR-35 末端→集約
// 過渡状態 — resolve-shape / leaf-with-children-footprint pin it as a legitimate mid-state) trips
// ShapePreservation/leaf-with-children at load. Its ONLY prior repair was the DESTRUCTIVE
// DropShapeRoleFeature = delete the parent = 元領域 (元形状 − 子の和) の沈黙損失. This suite pins
// the non-destructive materialisation (直轄領 = 元形状 − 子の和 を実体化し集約化) and 受け入れ基準5
// 「修復後に新たな不整合を作らない」for that case, plus 面積保存 / 地物削除ゼロ / 多錨整合 (FR-55) /
// leaf-empty-shape は drop のみ / 生成 id の disjoint 性 / 決定性.
//
// This is ALSO the Codex 点6 permanent regression: 「leaf-with-children を集約化 → checkConsistency
// == 0」as a domain-layer permanent test (the triage's throwaway probe is replaced here).

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature, type Feature, type LeafFeature } from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId, idToString, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { areasEqualWithinTolerance } from '../hierarchy/validate';
import { getCalendar } from '../time/calendar';
import { timePointYear, type TimePoint } from '../time/time-point';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, resolveAt } from '../anchor-series';
import { createGeoParams } from '../geo/geo-params';
import { applyAddProposal } from '../editing/apply-proposal';
import type { DomainProject, FeatureHistory } from './serialize';
import { projectsEqual } from './serialize';
import { checkConsistency, INCONSISTENCY, type Inconsistency } from './consistency';
import { applyRepair, applyRepairChecked, repairOptionsFor, REPAIR_OPTION } from './repair';

const CAL = getCalendar('gregorian');
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

/** A square leaf [x,x+size]×[y,y+size] with a self-namespaced vertex/ring id set. */
function squareLeaf(
  id: string,
  name: string,
  x: number,
  y: number,
  size: number,
  prefix: string,
  parentId?: string,
): Added {
  const verts = [
    createVertex(asVertexId(`${prefix}0`), createCoordinate(x, y)),
    createVertex(asVertexId(`${prefix}1`), createCoordinate(x + size, y)),
    createVertex(asVertexId(`${prefix}2`), createCoordinate(x + size, y + size)),
    createVertex(asVertexId(`${prefix}3`), createCoordinate(x, y + size)),
  ];
  const ring = createTerritoryRing(asRingId(`${prefix}-rt`), verts.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(name, 0, 1000),
    COLOR,
    createShape([ring]),
    parentId === undefined ? {} : { parentId: asFeatureId(parentId) },
  );
  return { feature, vertices: verts };
}

function addLeaf(root: DomainProject, add: Added, at: TimePoint): DomainProject {
  return applyAddProposal(root, {
    featureId: add.feature.id,
    anchorTime: at,
    snapshot: { feature: add.feature, vertices: [...add.vertices], sharedCandidateIds: new Map() },
  });
}

/** L = [0,10]² with a child C = [3,6]² sitting INSIDE it → a declared leaf-with-children. */
function leafWithChildProject(): { project: DomainProject; lId: FeatureId; cId: FeatureId } {
  const L = squareLeaf('L', '親領域', 0, 0, 10, 'L');
  const C = squareLeaf('C', '子領域', 3, 3, 3, 'C', 'L');
  let root = emptyProject();
  root = addLeaf(root, L, timePointYear(0));
  root = addLeaf(root, C, timePointYear(0));
  return { project: root, lId: L.feature.id, cId: C.feature.id };
}

function shapeInc(project: DomainProject, detail: string): Inconsistency {
  const report = checkConsistency(project, CAL);
  const inc = report.inconsistencies.find(
    (i) => i.kind === INCONSISTENCY.ShapePreservation && i.detail === detail,
  );
  if (inc === undefined) {
    throw new Error(
      `expected ShapePreservation/${detail}; got ${JSON.stringify(report.inconsistencies)}`,
    );
  }
  return inc;
}

/** Every raw feature / vertex / ring id anywhere in the project (for disjointness checks). */
function rawIds(project: DomainProject): Set<string> {
  const ids = new Set<string>();
  for (const h of project.histories) {
    ids.add(idToString(h.featureId));
    for (const e of h.series.entries) {
      for (const v of e.anchor.snapshot.vertices.byId.keys()) ids.add(idToString(v));
      for (const f of e.anchor.snapshot.features) {
        ids.add(idToString(f.id));
        if (f.kind === 'leaf') {
          for (const r of f.shape.rings) {
            ids.add(idToString(r.id));
            for (const vid of r.vertexIds) ids.add(idToString(vid));
          }
        }
      }
    }
  }
  return ids;
}

/** The combined effective feature set + merged store at `at` (the consistency-check view). */
function effectiveAt(project: DomainProject, at: TimePoint): { features: Feature[]; store: VertexStore } {
  const features: Feature[] = [];
  const verts: Vertex[] = [];
  const seen = new Set<string>();
  for (const h of project.histories) {
    const r = resolveAt(h.series, at, CAL);
    if (r.kind !== 'present') continue;
    for (const f of r.entry.anchor.snapshot.features) {
      if (seen.has(idToString(f.id))) continue;
      seen.add(idToString(f.id));
      features.push(f);
    }
    for (const v of r.entry.anchor.snapshot.vertices.byId.values()) verts.push(v);
  }
  return { features, store: createVertexStore(verts) };
}

describe('FR-37 直轄領 materialisation repair — options', () => {
  it('offers 直轄領 materialisation FIRST (recommended) then Drop for leaf-with-children', () => {
    const { project } = leafWithChildProject();
    const inc = shapeInc(project, 'leaf-with-children');
    const opts = repairOptionsFor(inc).map((o) => o.id);
    expect(opts).toEqual([
      REPAIR_OPTION.MaterializeDirectDomain,
      REPAIR_OPTION.DropShapeRoleFeature,
    ]);
  });

  it('keeps leaf-empty-shape DROP-ONLY (no materialisation offered) — regression', () => {
    const emptyLeaf = createLeafFeature(
      asFeatureId('E'),
      createBasicAttributes('空形状', 0, 1000),
      COLOR,
      createShape([]),
    );
    let root = emptyProject();
    root = applyAddProposal(root, {
      featureId: emptyLeaf.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: emptyLeaf, vertices: [], sharedCandidateIds: new Map() },
    });
    const inc = shapeInc(root, 'leaf-empty-shape');
    const opts = repairOptionsFor(inc).map((o) => o.id);
    expect(opts).toEqual([REPAIR_OPTION.DropShapeRoleFeature]);
    expect(opts).not.toContain(REPAIR_OPTION.MaterializeDirectDomain);

    // A forged Materialize against leaf-empty-shape is rejected (guard: option not offered).
    const forged = applyRepair(root, inc, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(projectsEqual(forged, root)).toBe(true);
  });
});

describe('FR-37 直轄領 materialisation repair — single anchor', () => {
  it('leaves the project fully consistent — 受け入れ基準5 / Codex 点6 permanent regression', () => {
    const { project } = leafWithChildProject();
    // Baseline: exactly ONE inconsistency, the leaf-with-children (no collateral overlap:
    // a feature WITH children is excluded from terminals).
    const before = checkConsistency(project, CAL);
    expect(before.inconsistencies.map((i) => `${i.kind}/${i.detail ?? ''}`)).toEqual([
      `${INCONSISTENCY.ShapePreservation}/leaf-with-children`,
    ]);

    const inc = shapeInc(project, 'leaf-with-children');
    const applied = applyRepairChecked(project, inc, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.inconsistencies).toHaveLength(0);
    expect(checkConsistency(applied.project, CAL).inconsistencies).toHaveLength(0);
  });

  it('preserves area, deletes zero features, keeps the parent, creates the 直轄領 as its child', () => {
    const { project, lId, cId } = leafWithChildProject();
    const beforeState = effectiveAt(project, timePointYear(0));
    const areaBefore = resolveFeatureArea(buildForest(beforeState.features), beforeState.store, lId);
    expect(areaBefore.status).toBe('ok');

    const inc = shapeInc(project, 'leaf-with-children');
    const repaired = applyRepair(project, inc, REPAIR_OPTION.MaterializeDirectDomain, CAL);

    const after = effectiveAt(repaired, timePointYear(0));
    // Parent survives (same id) and is now a shapeless aggregate; child survives.
    expect(after.features.find((f) => f.id === lId)?.kind).toBe('aggregate');
    expect(after.features.some((f) => f.id === cId)).toBe(true);

    // 直轄領 is a NEW leaf, a child of the parent, alongside the original child.
    const forest = buildForest(after.features);
    const children = directChildIds(forest, lId);
    expect(children).toContain(cId);
    expect(children).toHaveLength(2);
    const ddId = children.find((id) => id !== cId)!;
    const dd = after.features.find((f) => f.id === ddId);
    expect(dd?.kind).toBe('leaf');
    expect(dd?.parentId).toBe(lId);

    // 面積保存: the parent's derived area is unchanged (元形状 ∪ 子 before == 直轄領 ∪ 子 after).
    const areaAfter = resolveFeatureArea(forest, after.store, lId);
    expect(areaAfter.status).toBe('ok');
    if (areaAfter.status === 'ok' && areaBefore.status === 'ok') {
      expect(areasEqualWithinTolerance(areaAfter.area, areaBefore.area)).toBe(true);
    }

    // 地物削除ゼロ: every original feature id is still present.
    const idsAfter = rawIds(repaired);
    expect(idsAfter.has(idToString(lId))).toBe(true);
    expect(idsAfter.has(idToString(cId))).toBe(true);
  });

  it('mints the 直轄領 feature/vertex/ring ids DISJOINT from every existing id', () => {
    const { project } = leafWithChildProject();
    const idsBefore = rawIds(project);
    const inc = shapeInc(project, 'leaf-with-children');
    const repaired = applyRepair(project, inc, REPAIR_OPTION.MaterializeDirectDomain, CAL);

    // The 直轄領 rides in a brand-new history keyed by an id absent from the original project.
    const ddHistory = repaired.histories.find((h) => !idsBefore.has(idToString(h.featureId)));
    expect(ddHistory).toBeDefined();

    // EVERY id the repair introduced (直轄領 feature + its vertices + rings) is disjoint.
    const introduced = new Set<string>();
    introduced.add(idToString(ddHistory!.featureId));
    for (const e of ddHistory!.series.entries) {
      for (const v of e.anchor.snapshot.vertices.byId.keys()) introduced.add(idToString(v));
      for (const f of e.anchor.snapshot.features) {
        if (f.kind === 'leaf') {
          for (const r of f.shape.rings) {
            introduced.add(idToString(r.id));
            for (const vid of r.vertexIds) introduced.add(idToString(vid));
          }
        }
      }
    }
    expect(introduced.size).toBeGreaterThan(0);
    for (const id of introduced) expect(idsBefore.has(id)).toBe(false);
  });

  it('is deterministic / idempotent (pure function of the input)', () => {
    const a = leafWithChildProject();
    const b = leafWithChildProject();
    const r1 = applyRepair(a.project, shapeInc(a.project, 'leaf-with-children'), REPAIR_OPTION.MaterializeDirectDomain, CAL);
    const r2 = applyRepair(b.project, shapeInc(b.project, 'leaf-with-children'), REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(projectsEqual(r1, r2)).toBe(true);
    // Re-running against the now-consistent project introduces nothing (no leaf-with-children).
    expect(checkConsistency(r1, CAL).inconsistencies).toHaveLength(0);
  });
});

describe('FR-37 直轄領 materialisation repair — multi-anchor (FR-55)', () => {
  /**
   * L exists over TWO anchors ([0,500) and [500,1000)) and is a leaf-with-children at BOTH;
   * child C spans [0,1000); an UNRELATED feature U spans [0,1000). The materialisation must
   * canonicalise BOTH L anchors under ONE 直轄領 identity and leave U's history untouched.
   */
  function multiAnchorProject(): {
    project: DomainProject;
    lId: FeatureId;
    cId: FeatureId;
    uHistory: FeatureHistory;
  } {
    const L = squareLeaf('L', '親領域', 0, 0, 10, 'L');
    const C = squareLeaf('C', '子領域', 3, 3, 3, 'C', 'L');
    const U = squareLeaf('U', '無関係', 50, 50, 5, 'U'); // far away, standalone.
    const lStore = createVertexStore(L.vertices);
    const lHistory: FeatureHistory = {
      featureId: L.feature.id,
      series: {
        entries: [
          createAnchorEntry(
            createAnchor(asAnchorId('L@0'), createAnchorSnapshot([L.feature], lStore)),
            timePointYear(0),
            timePointYear(500),
          ),
          createAnchorEntry(
            createAnchor(asAnchorId('L@500'), createAnchorSnapshot([L.feature], lStore)),
            timePointYear(500),
            timePointYear(1000),
          ),
        ],
      },
    };
    const cHistory: FeatureHistory = {
      featureId: C.feature.id,
      series: {
        entries: [
          createAnchorEntry(
            createAnchor(asAnchorId('C@0'), createAnchorSnapshot([C.feature], createVertexStore(C.vertices))),
            timePointYear(0),
            timePointYear(1000),
          ),
        ],
      },
    };
    const uHistory: FeatureHistory = {
      featureId: U.feature.id,
      series: {
        entries: [
          createAnchorEntry(
            createAnchor(asAnchorId('U@0'), createAnchorSnapshot([U.feature], createVertexStore(U.vertices))),
            timePointYear(0),
            timePointYear(1000),
          ),
        ],
      },
    };
    return {
      project: { ...emptyProject(), histories: [lHistory, cHistory, uHistory] },
      lId: L.feature.id,
      cId: C.feature.id,
      uHistory,
    };
  }

  it('canonicalises every anchor under ONE 直轄領 identity and preserves untouched histories', () => {
    const { project, lId, cId, uHistory } = multiAnchorProject();

    // Baseline: leaf-with-children flagged at BOTH slices (year 0 and year 500).
    const before = checkConsistency(project, CAL);
    const lwc = before.inconsistencies.filter(
      (i) => i.kind === INCONSISTENCY.ShapePreservation && i.detail === 'leaf-with-children',
    );
    expect(lwc.length).toBe(2);

    // ONE repair call (targeting the first slice) canonicalises ALL of L's anchors.
    const applied = applyRepairChecked(project, lwc[0]!, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(applied.resolved).toBe(true);
    expect(checkConsistency(applied.project, CAL).inconsistencies).toHaveLength(0);

    const repaired = applied.project;

    // The 直轄領 is ONE feature (one history) with an anchor per L existence interval.
    const idsBefore = rawIds(project);
    const ddHistory = repaired.histories.find((h) => !idsBefore.has(idToString(h.featureId)));
    expect(ddHistory).toBeDefined();
    expect(ddHistory!.series.entries.length).toBe(2);
    // Same 直轄領 identity across both anchors (single feature through time).
    for (const e of ddHistory!.series.entries) {
      expect(e.anchor.snapshot.features.map((f) => idToString(f.id))).toEqual([
        idToString(ddHistory!.featureId),
      ]);
    }

    // FR-55: the untouched history (U) is preserved BY REFERENCE (its anchors are unchanged).
    expect(repaired.histories.some((h) => h === uHistory)).toBe(true);

    // L is a shapeless aggregate at BOTH slices; area preserved at both; child survives.
    for (const at of [timePointYear(0), timePointYear(500)]) {
      const beforeState = effectiveAt(project, at);
      const afterState = effectiveAt(repaired, at);
      expect(afterState.features.find((f) => f.id === lId)?.kind).toBe('aggregate');
      expect(afterState.features.some((f) => f.id === cId)).toBe(true);
      const ab = resolveFeatureArea(buildForest(beforeState.features), beforeState.store, lId);
      const aa = resolveFeatureArea(buildForest(afterState.features), afterState.store, lId);
      expect(ab.status).toBe('ok');
      expect(aa.status).toBe('ok');
      if (ab.status === 'ok' && aa.status === 'ok') {
        expect(areasEqualWithinTolerance(aa.area, ab.area)).toBe(true);
      }
    }
  });
});
