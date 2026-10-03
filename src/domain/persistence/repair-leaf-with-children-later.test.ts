// 子を持つ末端（leaf-with-children）の修復 — B39 前の期待と、再検証 3-1 の直し（2026-10-04）。
//
//   - B39 前の期待: 末端の中に子を 3 人描いた形は、開き直しの修復 1 回で 親 →［子1, 子2, 子3, 直轄領］
//     の平らな形になり、何も消えない。
//   - 再検証 3-1: 親の錨の **始まりの年より後** に子が現れる形（1000 年に親・1100 年に子）は、以前は
//     修復が親の錨の始まりの年にしか子を探さず、何もせずに終わって読み込みが止まった。いまは子の
//     現れる年で親の錨を割ってから見るので解ける。
//   - 解けない形でも親を消さずに開けるよう、「そのまま残す」（記録を変えない）を選べる。
//
// 記録（docs/ui-redesign/審査/B39-手直し2-再検証Opus.md の 3-1）。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, resolveAt } from '../anchor-series';
import { deriveAnchorId } from '../anchor-id';
import {
  FEATURE_KIND,
  createLeafFeature,
  isDirectDomainLeaf,
  type Feature,
  type LeafFeature,
} from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear, type TimePoint } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../vertex';

import { checkConsistency, INCONSISTENCY, SHAPE_DETAIL_LEAF_WITH_CHILDREN } from './consistency';
import { applyRepair, repairOptionsFor, REPAIR_OPTION } from './repair';
import type { DomainProject, FeatureHistory } from './serialize';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const Y = (y: number): TimePoint => timePointYear(y);
const P = asFeatureId('P');

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

/** 正方形の末端。存在期間は画面で描いたときと同じ［描いた年, 描いた年］。 */
function square(
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  year: number,
  parentId?: FeatureId,
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = [
    createVertex(asVertexId(`${id}-0`), createCoordinate(x0, y0)),
    createVertex(asVertexId(`${id}-1`), createCoordinate(x1, y0)),
    createVertex(asVertexId(`${id}-2`), createCoordinate(x1, y1)),
    createVertex(asVertexId(`${id}-3`), createCoordinate(x0, y1)),
  ];
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, year, year),
    COLOR,
    createShape([createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id))]),
    parentId === undefined ? {} : { parentId },
  );
  return { feature, vertices };
}

/** 1 本の錨の系列（追加の確定と同じ形: 描いた年に始まり、終わりなし）。 */
function historyAt(s: { feature: LeafFeature; vertices: Vertex[] }, year: number): FeatureHistory {
  return {
    featureId: s.feature.id,
    series: {
      entries: [
        createAnchorEntry(
          createAnchor(
            deriveAnchorId(s.feature.id, Y(year)),
            createAnchorSnapshot([s.feature], createVertexStore(s.vertices)),
          ),
          Y(year),
          null,
        ),
      ],
    },
  };
}

function featuresAt(root: DomainProject, at: TimePoint): Feature[] {
  const out: Feature[] = [];
  for (const h of root.histories) {
    const r = resolveAt(h.series, at, CAL);
    if (r.kind === 'present') out.push(...r.entry.anchor.snapshot.features);
  }
  return out;
}

/** 勧められる修復（各行の先頭）を、不整合が無くなるまで（最大 4 回）当てる。 */
function repairAsRecommended(root: DomainProject): DomainProject {
  let current = root;
  for (let round = 0; round < 4; round += 1) {
    const report = checkConsistency(current, CAL);
    if (report.inconsistencies.length === 0) return current;
    for (const inc of report.inconsistencies) {
      const first = repairOptionsFor(inc)[0];
      if (first !== undefined) current = applyRepair(current, inc, first.id, CAL);
    }
  }
  return current;
}

describe('子を持つ末端の修復 — B39 前の期待と、年を変えて子を描いた形（再検証 3-1）', () => {
  it('B39 前の期待: 末端の中に子を 3 人 → 子を持つ末端 → 修復 → 親 →［子1, 子2, 子3, 直轄領］で何も消えない', () => {
    const root: DomainProject = {
      ...emptyProject(),
      histories: [
        historyAt(square('P', 0, 0, 100, 100, 0), 0),
        historyAt(square('C1', 10, 10, 30, 30, 0, P), 0),
        historyAt(square('C2', 50, 10, 70, 30, 0, P), 0),
        historyAt(square('C3', 10, 50, 30, 70, 0, P), 0),
      ],
    };
    const before = checkConsistency(root, CAL).inconsistencies;
    expect(before.map((i) => [i.kind, i.detail])).toEqual([
      [INCONSISTENCY.ShapePreservation, SHAPE_DETAIL_LEAF_WITH_CHILDREN],
    ]);
    const repaired = repairAsRecommended(root);
    expect(checkConsistency(repaired, CAL).inconsistencies).toHaveLength(0);
    const at0 = featuresAt(repaired, Y(0));
    expect(at0.find((f) => f.id === P)?.kind).toBe(FEATURE_KIND.Aggregate);
    const dd = at0.filter(isDirectDomainLeaf);
    expect(dd).toHaveLength(1);
    expect(dd[0]!.attributes.name).toBe('P 直轄領');
    expect([...directChildIds(buildForest(at0), P)].sort()).toEqual(
      [asFeatureId('C1'), asFeatureId('C2'), asFeatureId('C3'), dd[0]!.id].sort(),
    );
    // 子 3 人とも残っている。
    for (const id of ['C1', 'C2', 'C3']) expect(at0.some((f) => f.id === asFeatureId(id))).toBe(true);
  });

  it('3-1: 1000 年に親・1100 年に子 → 修復 1 回で解け、1100 年から 親 →［子, 直轄領］、1050 年の親は末端のまま', () => {
    const root: DomainProject = {
      ...emptyProject(),
      histories: [
        historyAt(square('P', 0, 0, 100, 100, 1000), 1000),
        historyAt(square('C', 10, 10, 30, 30, 1100, P), 1100),
      ],
    };
    const incs = checkConsistency(root, CAL).inconsistencies;
    expect(incs.map((i) => i.detail)).toEqual([SHAPE_DETAIL_LEAF_WITH_CHILDREN]);
    // 勧められる修復（分け残しを作る）1 回で全部解ける。
    const repaired = applyRepair(root, incs[0]!, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(repaired).not.toBe(root);
    expect(checkConsistency(repaired, CAL).inconsistencies).toHaveLength(0);
    const at1100 = featuresAt(repaired, Y(1100));
    expect(at1100.find((f) => f.id === P)?.kind).toBe(FEATURE_KIND.Aggregate);
    const dd = at1100.filter(isDirectDomainLeaf);
    expect(dd).toHaveLength(1);
    expect([...directChildIds(buildForest(at1100), P)].sort()).toEqual(
      [asFeatureId('C'), dd[0]!.id].sort(),
    );
    const at1050 = featuresAt(repaired, Y(1050));
    expect(at1050.find((f) => f.id === P)?.kind).toBe(FEATURE_KIND.Leaf);
    expect(at1050.some(isDirectDomainLeaf)).toBe(false);
  });

  it('子を持つ末端には「そのまま残す」を選べ（分け残しを作るの次、除外の前）、記録を何も変えない', () => {
    const root: DomainProject = {
      ...emptyProject(),
      histories: [
        historyAt(square('P', 0, 0, 100, 100, 1000), 1000),
        historyAt(square('C', 10, 10, 30, 30, 1100, P), 1100),
      ],
    };
    const inc = checkConsistency(root, CAL).inconsistencies[0]!;
    expect(repairOptionsFor(inc).map((o) => o.id)).toEqual([
      REPAIR_OPTION.MaterializeDirectDomain,
      REPAIR_OPTION.KeepLeafWithChildren,
      REPAIR_OPTION.DropShapeRoleFeature,
    ]);
    expect(applyRepair(root, inc, REPAIR_OPTION.KeepLeafWithChildren, CAL)).toBe(root);
  });

  // --- 幾何の直し（2026-10-04、B39 の戻しの再検証 3-1・2-1 / B92）---------------------------

  /** 錨の並びから系列を作る（各錨: 年・地物・頂点・書かれた終わり）。 */
  function seriesOf(
    ownerId: string,
    anchors: readonly { year: number; s: { feature: LeafFeature; vertices: Vertex[] }; end?: number }[],
  ): FeatureHistory {
    return {
      featureId: asFeatureId(ownerId),
      series: {
        entries: anchors.map((a) =>
          createAnchorEntry(
            createAnchor(
              deriveAnchorId(asFeatureId(ownerId), Y(a.year)),
              createAnchorSnapshot([a.s.feature], createVertexStore(a.s.vertices)),
            ),
            Y(a.year),
            a.end === undefined ? null : Y(a.end),
          ),
        ),
      },
    };
  }

  it('重 3 の形（0 年に親・100 年に子・300 年に子を終わらせる・500 年に親の東の帯を隣へ）が、分け残しを作る修復 1 回で穴も重なりも無く解ける', () => {
    const p0 = square('P', 0, 0, 100, 100, 0);
    const e1 = createVertex(asVertexId('e1'), createCoordinate(80, 0));
    const e2 = createVertex(asVertexId('e2'), createCoordinate(80, 100));
    const p500 = {
      feature: createLeafFeature(
        P,
        createBasicAttributes('P', 0, 0),
        COLOR,
        createShape([
          createTerritoryRing(asRingId('P-r500'), [p0.vertices[0]!.id, e1.id, e2.id, p0.vertices[3]!.id]),
        ]),
      ),
      vertices: [p0.vertices[0]!, e1, e2, p0.vertices[3]!],
    };
    const q1 = createVertex(asVertexId('q1'), createCoordinate(100, 0));
    const q2 = createVertex(asVertexId('q2'), createCoordinate(100, 100));
    const q = {
      feature: createLeafFeature(
        asFeatureId('Q'),
        createBasicAttributes('Q', 500, 500),
        COLOR,
        createShape([createTerritoryRing(asRingId('Q-r'), [e1.id, q1.id, q2.id, e2.id])]),
      ),
      vertices: [e1, q1, q2, e2],
    };
    const root: DomainProject = {
      ...emptyProject(),
      histories: [
        seriesOf('P', [
          { year: 0, s: p0 },
          { year: 500, s: p500 },
        ]),
        seriesOf('C', [{ year: 100, s: square('C', 10, 10, 30, 30, 100, P), end: 300 }]),
        seriesOf('Q', [{ year: 500, s: q }]),
      ],
    };
    const incs = checkConsistency(root, CAL).inconsistencies;
    expect(incs.map((i) => i.detail)).toEqual([SHAPE_DETAIL_LEAF_WITH_CHILDREN]);
    const repaired = applyRepair(root, incs[0]!, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    // 2 枚目の板が出ない（全部解ける）。
    expect(checkConsistency(repaired, CAL).inconsistencies).toHaveLength(0);
    // 100〜300 年だけ 親 →［子, 直轄領］。
    const at200 = featuresAt(repaired, Y(200));
    expect(at200.find((f) => f.id === P)?.kind).toBe(FEATURE_KIND.Aggregate);
    expect(at200.filter(isDirectDomainLeaf)).toHaveLength(1);
    // 300 年からは元の末端の親（同じもの）に戻り、分け残しは居ない（穴があかない）。
    const at400 = featuresAt(repaired, Y(400));
    expect(at400.find((f) => f.id === P)).toEqual(p0.feature);
    expect(at400.some(isDirectDomainLeaf)).toBe(false);
    // 500 年からの親の境の直し（8,000）も、隣 Q もそのまま。
    const at600 = featuresAt(repaired, Y(600));
    expect(at600.find((f) => f.id === P)).toEqual(p500.feature);
    expect(at600.find((f) => f.id === asFeatureId('Q'))).toEqual(q.feature);
    expect(at600.some(isDirectDomainLeaf)).toBe(false);
  });

  it('重 2 の形（1000 年に親・1100 年に子・子を 1200 年で終わらせる）は、1200 年から親が元の形（穴なし）のまま', () => {
    const p = square('P', 0, 0, 100, 100, 1000);
    const root: DomainProject = {
      ...emptyProject(),
      histories: [
        seriesOf('P', [{ year: 1000, s: p }]),
        seriesOf('C', [{ year: 1100, s: square('C', 10, 10, 30, 30, 1100, P), end: 1200 }]),
      ],
    };
    const inc = checkConsistency(root, CAL).inconsistencies[0]!;
    const repaired = applyRepair(root, inc, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(checkConsistency(repaired, CAL).inconsistencies).toHaveLength(0);
    expect(featuresAt(repaired, Y(1150)).find((f) => f.id === P)?.kind).toBe(FEATURE_KIND.Aggregate);
    const at1300 = featuresAt(repaired, Y(1300));
    expect(at1300.find((f) => f.id === P)).toEqual(p.feature);
    expect(at1300.some(isDirectDomainLeaf)).toBe(false);
  });
});

