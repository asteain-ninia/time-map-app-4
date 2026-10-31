// 修復の板で「そのまま残す」を選ぶと、子を持つ末端のまま（記録を変えずに）読み込める
// （2026-10-04、B39 の再検証 3-1。分け残しを作る修復で解けない形でも、親を消さずに開ける道）。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry } from '../../domain/anchor-series';
import { deriveAnchorId } from '../../domain/anchor-id';
import { createLeafFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import {
  KEEP_LEAF_WITH_CHILDREN_NOTE,
  REPAIR_OPTION,
  applyRepair,
  checkConsistency,
  repairOptionsInContext,
  type DomainProject,
  type FeatureHistory,
} from '../../domain/persistence/index';

import {
  EMPTY_REPAIR_CHOICES,
  REPAIR_OUTCOME,
  applyChosenRepairs,
  buildRepairRows,
  defaultRepairChoices,
  setRepairChoice,
} from './repair-flow';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function leafHistory(id: string, x0: number, x1: number, year: number, parentId?: FeatureId): FeatureHistory {
  const vs = [
    createVertex(asVertexId(`${id}-0`), createCoordinate(x0, x0)),
    createVertex(asVertexId(`${id}-1`), createCoordinate(x1, x0)),
    createVertex(asVertexId(`${id}-2`), createCoordinate(x1, x1)),
    createVertex(asVertexId(`${id}-3`), createCoordinate(x0, x1)),
  ];
  const f = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, year, year),
    COLOR,
    createShape([createTerritoryRing(asRingId(`${id}-r`), vs.map((v) => v.id))]),
    parentId === undefined ? {} : { parentId },
  );
  const t = timePointYear(year);
  return {
    featureId: f.id,
    series: {
      entries: [
        createAnchorEntry(createAnchor(deriveAnchorId(f.id, t), createAnchorSnapshot([f], createVertexStore(vs))), t, null),
      ],
    },
  };
}

describe('修復の板の「そのまま残す」', () => {
  it('子を持つ末端の行で選ぶと、記録を変えずに Applied（残した行を kept で返す）', () => {
    const project: DomainProject = {
      histories: [leafHistory('P', 0, 100, 0), leafHistory('C', 10, 30, 0, asFeatureId('P'))],
      settings: {
        calendarId: 'gregorian',
        geo: createGeoParams(40000, 0.0034),
        gridSpacingDeg: 10,
        snapDistancePx: 50,
        autoColorDefault: true,
      },
      baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
    };
    const rows = buildRepairRows(checkConsistency(project, CAL));
    expect(rows).toHaveLength(1);
    const choices = setRepairChoice(EMPTY_REPAIR_CHOICES, rows[0]!.index, REPAIR_OPTION.KeepLeafWithChildren);
    const result = applyChosenRepairs(project, rows, choices, CAL);
    expect(result.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (result.outcome !== REPAIR_OUTCOME.Applied) return;
    expect(result.project).toBe(project);
    expect(result.kept?.map((k) => k.featureIds[0])).toEqual([asFeatureId('P')]);
  });
});

// ---------------------------------------------------------------------------
// ガード（2026-10-04、B39 の戻しの再検証）: 勧められるまま押して記録が消えないこと
// ---------------------------------------------------------------------------

/** 系列を錨の並びから作る（各錨: 年・地物・頂点・書かれた終わり）。 */
function seriesHistory(
  ownerId: string,
  anchors: readonly {
    year: number;
    features: ReturnType<typeof createLeafFeature>[];
    vertices: ReturnType<typeof createVertex>[];
    end?: number;
  }[],
): FeatureHistory {
  return {
    featureId: asFeatureId(ownerId),
    series: {
      entries: anchors.map((a) =>
        createAnchorEntry(
          createAnchor(
            deriveAnchorId(asFeatureId(ownerId), timePointYear(a.year)),
            createAnchorSnapshot(a.features, createVertexStore(a.vertices)),
          ),
          timePointYear(a.year),
          a.end === undefined ? null : timePointYear(a.end),
        ),
      ),
    },
  };
}

function rect(id: string, x0: number, y0: number, x1: number, y1: number, ids: readonly string[], parentId?: string) {
  const vs = [
    createVertex(asVertexId(ids[0]!), createCoordinate(x0, y0)),
    createVertex(asVertexId(ids[1]!), createCoordinate(x1, y0)),
    createVertex(asVertexId(ids[2]!), createCoordinate(x1, y1)),
    createVertex(asVertexId(ids[3]!), createCoordinate(x0, y1)),
  ];
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 3000),
    COLOR,
    createShape([createTerritoryRing(asRingId(`${id}-r-${ids[0]!}`), vs.map((v) => v.id))]),
    parentId === undefined ? {} : { parentId: asFeatureId(parentId) },
  );
  return { feature, vertices: vs };
}

/**
 * 再検証の重 3 の形: 0 年に親（100×100）、100 年に親の中へ子、子を 300 年で終わらせる、500 年に
 * 親の東の帯（20×100）を手放し、隣 Q がその帯を受け取る。
 */
function heavy3Project(): DomainProject {
  const p0 = rect('P', 0, 0, 100, 100, ['p0', 'p1', 'p2', 'p3']);
  const p500 = rect('P', 0, 0, 80, 100, ['p0', 'e1', 'e2', 'p3']);
  const q = rect('Q', 80, 0, 100, 100, ['e1', 'q1', 'q2', 'e2']);
  const c = rect('C', 10, 10, 30, 30, ['c0', 'c1', 'c2', 'c3'], 'P');
  return {
    histories: [
      seriesHistory('P', [
        { year: 0, features: [p0.feature], vertices: p0.vertices },
        { year: 500, features: [p500.feature], vertices: p500.vertices },
      ]),
      seriesHistory('C', [{ year: 100, features: [c.feature], vertices: c.vertices, end: 300 }]),
      seriesHistory('Q', [{ year: 500, features: [q.feature], vertices: q.vertices }]),
    ],
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

describe('勧められるまま押して記録が消えない（ガード）', () => {
  it('B93: 解ける形（重 3）は既定が「分け残しを作る」で理由を出さない。勧められるまま押して 1 枚で解け、誰も消えない', () => {
    const project = heavy3Project();
    const report = checkConsistency(project, CAL);
    const rows = buildRepairRows(report, { project, calendar: CAL });
    const lwc = rows.find(
      (r) => r.inconsistency.kind === 'shape-preservation' && r.inconsistency.detail === 'leaf-with-children',
    );
    expect(lwc).toBeDefined();
    expect(lwc!.options.map((o) => o.id)).toEqual([
      REPAIR_OPTION.MaterializeDirectDomain,
      REPAIR_OPTION.KeepLeafWithChildren,
      REPAIR_OPTION.DropShapeRoleFeature,
    ]);
    expect(lwc!.note).toBeUndefined();
    const result = applyChosenRepairs(project, rows, defaultRepairChoices(rows), CAL);
    expect(result.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (result.outcome !== REPAIR_OUTCOME.Applied) return;
    expect(checkConsistency(result.project, CAL).inconsistencies).toEqual([]);
    // 元の地物は 1 つも消えない（隣 Q も、500 年の親の記録も）。分け残しが 1 つ増えるだけ。
    const ids = new Set(result.project.histories.map((h) => String(h.featureId)));
    for (const id of ['P', 'Q', 'C']) expect(ids.has(id)).toBe(true);
    expect(result.project.histories).toHaveLength(project.histories.length + 1);
  });

  it('B93: 修復が何も変えられない形だけ、既定が「そのまま残す」で理由が付く。除外は既定にならない', () => {
    const healthy: DomainProject = {
      ...heavy3Project(),
      histories: [leafHistory('P', 0, 100, 0), leafHistory('C', 10, 30, 0, asFeatureId('P'))],
    };
    const inc = checkConsistency(healthy, CAL).inconsistencies.find(
      (i) => i.kind === 'shape-preservation' && i.detail === 'leaf-with-children',
    )!;
    // 親の頂点の体を 1 つ落とす: 面積が解決できないので、修復は入力をそのまま返す。
    const parent = healthy.histories[0]!;
    const entry = parent.series.entries[0]!;
    const snapshot = entry.anchor.snapshot;
    const broken: DomainProject = {
      ...healthy,
      histories: [
        {
          featureId: parent.featureId,
          series: {
            entries: [
              {
                ...entry,
                anchor: {
                  ...entry.anchor,
                  snapshot: createAnchorSnapshot(
                    snapshot.features,
                    createVertexStore(
                      [...snapshot.vertices.byId.values()].filter((v) => v.id !== asVertexId('P-0')),
                    ),
                  ),
                },
              },
            ],
          },
        },
        healthy.histories[1]!,
      ],
    };
    expect(applyRepair(broken, inc, REPAIR_OPTION.MaterializeDirectDomain, CAL)).toBe(broken);

    const inContext = repairOptionsInContext(inc, broken, CAL);
    expect(inContext.options.map((o) => o.id)).toEqual([
      REPAIR_OPTION.KeepLeafWithChildren,
      REPAIR_OPTION.MaterializeDirectDomain,
      REPAIR_OPTION.DropShapeRoleFeature,
    ]);
    expect(inContext.note).toBe(KEEP_LEAF_WITH_CHILDREN_NOTE);
    // 解ける側でも、既定は記録を消す選択肢にならない。
    expect(repairOptionsInContext(inc, healthy, CAL).options[0]!.id).toBe(
      REPAIR_OPTION.MaterializeDirectDomain,
    );
  });

  it('同じ年に描いた子（居続ける）も、既定は「分け残しを作る」のまま', () => {
    const p = rect('P', 0, 0, 100, 100, ['p0', 'p1', 'p2', 'p3']);
    const c = rect('C', 10, 10, 30, 30, ['c0', 'c1', 'c2', 'c3'], 'P');
    const project: DomainProject = {
      ...heavy3Project(),
      histories: [
        seriesHistory('P', [{ year: 0, features: [p.feature], vertices: p.vertices }]),
        seriesHistory('C', [{ year: 0, features: [c.feature], vertices: c.vertices }]),
      ],
    };
    const rows = buildRepairRows(checkConsistency(project, CAL), { project, calendar: CAL });
    expect(rows[0]!.options[0]!.id).toBe(REPAIR_OPTION.MaterializeDirectDomain);
    expect(rows[0]!.note).toBeUndefined();
  });

  it('ガード A: 重なりの行の既定は「そのまま残す」で、勧められるまま押しても地物が消えない', () => {
    const a = rect('A', 0, 0, 60, 60, ['a0', 'a1', 'a2', 'a3']);
    const b = rect('B', 40, 40, 100, 100, ['b0', 'b1', 'b2', 'b3']);
    const project: DomainProject = {
      ...heavy3Project(),
      histories: [
        seriesHistory('A', [{ year: 0, features: [a.feature], vertices: a.vertices }]),
        seriesHistory('B', [{ year: 0, features: [b.feature], vertices: b.vertices }]),
      ],
    };
    const rows = buildRepairRows(checkConsistency(project, CAL), { project, calendar: CAL });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.options[0]!.id).toBe(REPAIR_OPTION.KeepOverlap);
    const result = applyChosenRepairs(project, rows, defaultRepairChoices(rows), CAL);
    expect(result.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (result.outcome !== REPAIR_OUTCOME.Applied) return;
    expect(result.project).toBe(project);
  });
});
