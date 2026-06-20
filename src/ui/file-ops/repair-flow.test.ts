import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createPointFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asVertexId } from '../../domain/ids';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import {
  REPAIR_OPTION,
  checkConsistency,
  type ConsistencyReport,
  type DomainProject,
  type FeatureHistory,
} from '../../domain/persistence/index';

import {
  EMPTY_REPAIR_CHOICES,
  REPAIR_OUTCOME,
  allChoicesMade,
  applyChosenRepairs,
  buildRepairRows,
  describeInconsistency,
  setRepairChoice,
} from './repair-flow';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

/** A project whose single point references a vertex absent from its store. */
function projectWithMissingVertex(): DomainProject {
  // The point references `pt-v`, but the store contains a DIFFERENT vertex id, so
  // U14 detects MissingVertexReference (FR-106 a).
  const point = createPointFeature(
    asFeatureId('pt-1'),
    createBasicAttributes('首都', 0, 50),
    COLOR,
    asVertexId('pt-v'),
    { kindLabel: '都市' },
  );
  const otherVertex = createVertex(asVertexId('other-v'), createCoordinate(0, 0));
  const store = createVertexStore([otherVertex]);
  const anchor = createAnchor(asAnchorId('pt-1-anc'), createAnchorSnapshot([point], store));
  const history: FeatureHistory = {
    featureId: asFeatureId('pt-1'),
    series: normalizeSeries([createAnchorEntry(anchor, timePointYear(0), null)], CAL),
  };
  return {
    histories: [history],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: {
      source: '@preset/equirectangular-world',
      meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
    },
  };
}

describe('buildRepairRows + describeInconsistency (FR-106 一覧, 動的選択肢)', () => {
  it('builds one row per inconsistency with per-kind options from U14', () => {
    const project = projectWithMissingVertex();
    const report = checkConsistency(project, CAL);
    expect(report.ok).toBe(false);
    expect(report.inconsistencies.length).toBeGreaterThan(0);

    const rows = buildRepairRows(report);
    expect(rows.length).toBe(report.inconsistencies.length);
    const missingRow = rows.find(
      (r) => r.inconsistency.kind === 'missing-vertex-reference',
    );
    expect(missingRow).toBeDefined();
    // The option list is the U14-supplied list for THIS kind (動的, 過剰共有しない).
    expect(missingRow?.options.map((o) => o.id)).toContain(
      REPAIR_OPTION.DropFeatureWithMissingVertex,
    );
  });

  it('describeInconsistency yields a Japanese summary naming the feature', () => {
    const report = checkConsistency(projectWithMissingVertex(), CAL);
    const text = describeInconsistency(report.inconsistencies[0]!);
    expect(text).toContain('存在しない頂点参照');
    expect(text).toContain('首都');
  });
});

describe('allChoicesMade (受け入れ基準 3 / 教訓 5.18 空は正当値)', () => {
  it('an EMPTY report is trivially complete (no choices needed)', () => {
    expect(allChoicesMade([], EMPTY_REPAIR_CHOICES)).toBe(true);
  });

  it('incomplete until every row has a choice', () => {
    const report = checkConsistency(projectWithMissingVertex(), CAL);
    const rows = buildRepairRows(report);
    expect(allChoicesMade(rows, EMPTY_REPAIR_CHOICES)).toBe(false);
    let choices = EMPTY_REPAIR_CHOICES;
    for (const row of rows) {
      choices = setRepairChoice(choices, row.index, row.options[0]!.id);
    }
    expect(allChoicesMade(rows, choices)).toBe(true);
  });
});

describe('applyChosenRepairs (教訓 5.22 / 受け入れ基準 3)', () => {
  it('returns Incomplete when a row has no chosen option', () => {
    const report = checkConsistency(projectWithMissingVertex(), CAL);
    const rows = buildRepairRows(report);
    const result = applyChosenRepairs(projectWithMissingVertex(), rows, EMPTY_REPAIR_CHOICES, CAL);
    expect(result.outcome).toBe(REPAIR_OUTCOME.Incomplete);
  });

  it('applies the chosen repair, re-validates, and yields a clean project', () => {
    const project = projectWithMissingVertex();
    const report = checkConsistency(project, CAL);
    const rows = buildRepairRows(report);
    let choices = EMPTY_REPAIR_CHOICES;
    for (const row of rows) {
      choices = setRepairChoice(choices, row.index, row.options[0]!.id);
    }
    const result = applyChosenRepairs(project, rows, choices, CAL);
    expect(result.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (result.outcome === REPAIR_OUTCOME.Applied) {
      // The repaired project is a NEW instance and is fully consistent.
      const recheck: ConsistencyReport = checkConsistency(result.project, CAL);
      expect(recheck.ok).toBe(true);
      // The input project was never mutated (教訓 5.22).
      expect(checkConsistency(project, CAL).ok).toBe(false);
    }
  });
});
