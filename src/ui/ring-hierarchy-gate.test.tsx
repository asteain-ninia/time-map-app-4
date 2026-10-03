// 増分 8E（G-14）: 穴・飛び地の形を **この編集で新しく壊した** ときだけ止める関門。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { PROCESS_STATUS, REJECTION_KIND } from '../domain/consistency/index';
import { createLeafFeature, type LeafFeature } from '../domain/feature';
import { createGeoParams } from '../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../domain/ids';
import type { DomainProject } from '../domain/persistence/index';
import { createHoleRing, createShape, createTerritoryRing } from '../domain/ring';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../domain/vertex';

import {
  RING_HIERARCHY_GATE_KIND,
  RING_HIERARCHY_GATE_STRINGS,
  editRejectionMessage,
  ringHierarchyViolationsIntroduced,
} from './ring-hierarchy-gate';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

type Pt = readonly [number, number];

function ringVertices(prefix: string, pts: readonly Pt[]): Vertex[] {
  return pts.map(([lon, lat], i) => createVertex(asVertexId(`${prefix}-${String(i)}`), { lon, lat }));
}

/** 外周 [0,10]² に穴 2 つ（左 [1,3]×[4,6] の三角・右 [6,9]×[2,8] の四角）を持つ面。 */
function faceWithTwoHoles(holeAPoint: Pt): { feature: LeafFeature; vertices: Vertex[] } {
  const outer = ringVertices('o', [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]);
  const holeA = ringVertices('ha', [[1, 4], holeAPoint, [2, 6]]);
  const holeB = ringVertices('hb', [
    [6, 2],
    [9, 2],
    [9, 8],
    [6, 8],
  ]);
  const territory = createTerritoryRing(asRingId('r-o'), outer.map((v) => v.id));
  const shape = createShape([
    territory,
    createHoleRing(asRingId('r-ha'), holeA.map((v) => v.id), territory.id),
    createHoleRing(asRingId('r-hb'), holeB.map((v) => v.id), territory.id),
  ]);
  const feature = createLeafFeature(asFeatureId('f-face'), createBasicAttributes('面', 0, 0), color, shape);
  return { feature, vertices: [...outer, ...holeA, ...holeB] };
}

function project(face: { feature: LeafFeature; vertices: Vertex[] }, anchor = 'a-1'): DomainProject {
  return {
    histories: [
      {
        featureId: face.feature.id,
        series: normalizeSeries(
          [
            createAnchorEntry(
              createAnchor(
                asAnchorId(anchor),
                createAnchorSnapshot([face.feature], createVertexStore(face.vertices)),
              ),
              timePointYear(1200),
            ),
          ],
          calendar,
        ),
      },
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

describe('ringHierarchyViolationsIntroduced（G-14）', () => {
  it('穴の頂点を隣の穴の中へ入れた形は、新しく壊したので止める', () => {
    const before = project(faceWithTwoHoles([3, 5]));
    const after = project(faceWithTwoHoles([7.5, 5]), 'a-2');
    const found = ringHierarchyViolationsIntroduced(before, after);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe(RING_HIERARCHY_GATE_KIND);
    expect(found[0]!.featureId).toBe(asFeatureId('f-face'));
    expect(found[0]!.violations.length).toBeGreaterThan(0);
  });

  it('穴の中で動かしただけ（整合したまま）なら通す', () => {
    const before = project(faceWithTwoHoles([3, 5]));
    const after = project(faceWithTwoHoles([4, 5]), 'a-2');
    expect(ringHierarchyViolationsIntroduced(before, after)).toEqual([]);
  });

  it('編集の前からもう壊れていた形（古いデータ）は、関係のない編集を止めない', () => {
    const broken = faceWithTwoHoles([7.5, 5]);
    const before = project(broken);
    const renamed: LeafFeature = {
      ...broken.feature,
      attributes: createBasicAttributes('名前を直した', 0, 0),
    };
    const after = project({ feature: renamed, vertices: broken.vertices }, 'a-2');
    expect(ringHierarchyViolationsIntroduced(before, after)).toEqual([]);
  });

  it('何も変わっていなければ（同じ参照）調べない', () => {
    const root = project(faceWithTwoHoles([3, 5]));
    expect(ringHierarchyViolationsIntroduced(root, root)).toEqual([]);
  });
});

describe('editRejectionMessage', () => {
  it('この関門で断ったなら、穴・飛び地の理由を言う', () => {
    expect(
      editRejectionMessage({
        status: PROCESS_STATUS.Rejected,
        kind: REJECTION_KIND.ConstraintViolation,
        message: '一般の文',
        detail: [{ kind: RING_HIERARCHY_GATE_KIND }],
      }),
    ).toBe(RING_HIERARCHY_GATE_STRINGS.refused);
  });

  it('ほかの理由なら、確定の手続きの文をそのまま出す', () => {
    expect(
      editRejectionMessage({
        status: PROCESS_STATUS.Rejected,
        kind: REJECTION_KIND.ConstraintViolation,
        message: '一般の文',
      }),
    ).toBe('一般の文');
  });
});
