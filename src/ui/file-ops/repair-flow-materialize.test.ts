// FR-37 直轄領 materialisation through the load-time auto-repair FLOW (file-commands /
// completeLoad → applyChosenRepairs). Pins that the non-destructive option surfaces in the
// dialog's row options (buildRepairRows), is selectable, and drives the flow to a fully
// consistent project WITHOUT deleting the parent — the destructive DropShapeRoleFeature is a
// fallback, not the only choice (実ユーザーデータ損失の修復経路).

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature, type LeafFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId, idToString } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import {
  INCONSISTENCY,
  REPAIR_OPTION,
  checkConsistency,
  type DomainProject,
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

function squareLeaf(
  id: string,
  x: number,
  y: number,
  size: number,
  prefix: string,
  parentId?: string,
): { feature: LeafFeature; vertices: Vertex[] } {
  const verts = [
    createVertex(asVertexId(`${prefix}0`), createCoordinate(x, y)),
    createVertex(asVertexId(`${prefix}1`), createCoordinate(x + size, y)),
    createVertex(asVertexId(`${prefix}2`), createCoordinate(x + size, y + size)),
    createVertex(asVertexId(`${prefix}3`), createCoordinate(x, y + size)),
  ];
  const ring = createTerritoryRing(asRingId(`${prefix}-rt`), verts.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 1000),
    COLOR,
    createShape([ring]),
    parentId === undefined ? {} : { parentId: asFeatureId(parentId) },
  );
  return { feature, vertices: verts };
}

function add(root: DomainProject, f: { feature: LeafFeature; vertices: Vertex[] }, at: TimePoint): DomainProject {
  return applyAddProposal(root, {
    featureId: f.feature.id,
    anchorTime: at,
    snapshot: { feature: f.feature, vertices: [...f.vertices], sharedCandidateIds: new Map() },
  });
}

/** L = [0,10]² with a child C = [3,6]² inside → a leaf-with-children at load. */
function leafWithChildProject(): DomainProject {
  let root = emptyProject();
  root = add(root, squareLeaf('L', 0, 0, 10, 'L'), timePointYear(0));
  root = add(root, squareLeaf('C', 3, 3, 3, 'C', 'L'), timePointYear(0));
  return root;
}

describe('load-time auto-repair flow — FR-37 直轄領 materialisation', () => {
  it('surfaces materialisation as the row option and applies it to a clean, parent-preserving project', () => {
    const project = leafWithChildProject();
    const report = checkConsistency(project, CAL);
    const rows = buildRepairRows(report);

    // The leaf-with-children row offers the NON-DESTRUCTIVE option first, Drop as fallback.
    const row = rows.find(
      (r) =>
        r.inconsistency.kind === INCONSISTENCY.ShapePreservation &&
        r.inconsistency.detail === 'leaf-with-children',
    );
    expect(row).toBeDefined();
    expect(row!.options.map((o) => o.id)).toEqual([
      REPAIR_OPTION.MaterializeDirectDomain,
      REPAIR_OPTION.DropShapeRoleFeature,
    ]);

    // Choose materialisation for every row and drive the file-commands apply path.
    let choices = EMPTY_REPAIR_CHOICES;
    for (const r of rows) {
      const materialize = r.options.find((o) => o.id === REPAIR_OPTION.MaterializeDirectDomain);
      choices = setRepairChoice(choices, r.index, (materialize ?? r.options[0]!).id);
    }
    const result = applyChosenRepairs(project, rows, choices, CAL);
    expect(result.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (result.outcome !== REPAIR_OUTCOME.Applied) return;

    // Fully consistent, and the parent leaf 'L' was NOT deleted (non-destructive).
    expect(checkConsistency(result.project, CAL).ok).toBe(true);
    const hasL = result.project.histories.some((h) =>
      h.series.entries.some((e) => e.anchor.snapshot.features.some((f) => idToString(f.id) === 'L')),
    );
    const hasC = result.project.histories.some((h) =>
      h.series.entries.some((e) => e.anchor.snapshot.features.some((f) => idToString(f.id) === 'C')),
    );
    expect(hasL).toBe(true);
    expect(hasC).toBe(true);

    // The input project was never mutated (教訓 5.22).
    expect(checkConsistency(project, CAL).ok).toBe(false);
  });

  it('still offers Drop as a working fallback for the same inconsistency', () => {
    const project = leafWithChildProject();
    const report = checkConsistency(project, CAL);
    const rows = buildRepairRows(report);
    let choices = EMPTY_REPAIR_CHOICES;
    for (const r of rows) {
      choices = setRepairChoice(choices, r.index, REPAIR_OPTION.DropShapeRoleFeature);
    }
    const result = applyChosenRepairs(project, rows, choices, CAL);
    // Drop also converges (destructive, but a valid last-resort — kept, not removed).
    expect(result.outcome).toBe(REPAIR_OUTCOME.Applied);
  });
});
