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
});
