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
  REPAIR_OPTION,
  checkConsistency,
  type DomainProject,
  type FeatureHistory,
} from '../../domain/persistence/index';

import {
  EMPTY_REPAIR_CHOICES,
  REPAIR_OUTCOME,
  applyChosenRepairs,
  buildRepairRows,
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
