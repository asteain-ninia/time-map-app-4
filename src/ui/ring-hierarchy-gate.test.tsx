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

import { RING_VIOLATION } from '../domain/ring-hierarchy';

import {
  EDIT_OPERATION,
  RING_BREAK,
  RING_HIERARCHY_GATE_KIND,
  RING_HIERARCHY_GATE_STRINGS,
  editRejectionMessage,
  ringHierarchyViolationsIntroduced,
  tagRejectionOperation,
  violationKey,
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

  it('断った記録に、壊れ方・面の呼び名・年の書き方が入る', () => {
    const before = project(faceWithTwoHoles([3, 5]));
    const after = project(faceWithTwoHoles([7.5, 5]), 'a-2');
    const [found] = ringHierarchyViolationsIntroduced(before, after);
    expect(found!.breaks).toBe(RING_BREAK.HolesCross);
    expect(found!.featureName).toBe('面');
    expect(found!.atLabel).toBe('1200年');
  });
});

// 増分 8E の手直し（GPT 重 3）: もとから壊れていた面でも、**新しい破損** は断る。
describe('ringHierarchyViolationsIntroduced — もとから壊れていた面（違反の集合で比べる）', () => {
  /**
   * 外周 [0,10]² に 3 つの穴を持つ面。
   *   - 穴 P: 右上の頂点が外周の外 (12, 9) へはみ出している（**もとから壊れている**）
   *   - 穴 A: 左下の三角（3 つ目の頂点を `holeAPoint` で動かす）
   *   - 穴 B: 右下の四角 [6,9]×[1,5]
   */
  function brokenFace(
    holeAPoint: Pt,
    pPoint: Pt = [12, 9],
  ): { feature: LeafFeature; vertices: Vertex[] } {
    const outer = ringVertices('o', [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    const holeP = ringVertices('hp', [[6, 7], pPoint, [7, 9.5]]);
    const holeA = ringVertices('ha', [[1, 1], holeAPoint, [2, 3]]);
    const holeB = ringVertices('hb', [
      [6, 1],
      [9, 1],
      [9, 5],
      [6, 5],
    ]);
    const territory = createTerritoryRing(asRingId('r-o'), outer.map((v) => v.id));
    const shape = createShape([
      territory,
      createHoleRing(asRingId('r-hp'), holeP.map((v) => v.id), territory.id),
      createHoleRing(asRingId('r-ha'), holeA.map((v) => v.id), territory.id),
      createHoleRing(asRingId('r-hb'), holeB.map((v) => v.id), territory.id),
    ]);
    const feature = createLeafFeature(asFeatureId('f-face'), createBasicAttributes('古い面', 0, 0), color, shape);
    return { feature, vertices: [...outer, ...holeP, ...holeA, ...holeB] };
  }

  it('前提: 編集の前から壊れている（穴 P が外周をはみ出す）', () => {
    const root = project(brokenFace([3, 2]));
    const empty: DomainProject = { ...root, histories: [] };
    // 何も無い姿から壊れた面を足すと、はみ出しが「新しい違反」として出る＝壊れている。
    const found = ringHierarchyViolationsIntroduced(empty, root);
    expect(found).toHaveLength(1);
    expect(found[0]!.violations.some((v) => String(v.ringId) === 'r-hp' || String(v.relatedRingId) === 'r-hp')).toBe(true);
  });

  it('別の穴を隣の穴へ入れる（新しい違反が増える）と、もとから壊れていても断る', () => {
    const before = project(brokenFace([3, 2]));
    const after = project(brokenFace([7.5, 3]), 'a-2');
    const found = ringHierarchyViolationsIntroduced(before, after);
    expect(found).toHaveLength(1);
    // 記録に入るのは **新しい違反だけ**（もとからある穴 P の違反は入れない）。
    expect(found[0]!.violations.length).toBeGreaterThan(0);
    for (const v of found[0]!.violations) {
      expect([String(v.ringId), String(v.relatedRingId ?? '')]).not.toContain('r-hp');
    }
    expect(found[0]!.breaks).toBe(RING_BREAK.HolesCross);
  });

  it('名前を直しただけ（もとからある違反だけが残る）なら止めない', () => {
    const broken = brokenFace([3, 2]);
    const before = project(broken);
    const renamed: LeafFeature = { ...broken.feature, attributes: createBasicAttributes('直した', 0, 0) };
    const after = project({ feature: renamed, vertices: broken.vertices }, 'a-2');
    expect(ringHierarchyViolationsIntroduced(before, after)).toEqual([]);
  });

  it('もとからある違反の 1 つを直し、別の古い違反が残っていても止めない', () => {
    // 穴 P のはみ出しと、穴 A が穴 B に入っている違反の 2 つを持つ面から、
    // 穴 A を引き戻して 1 つを直す（穴 P のはみ出しは残る）。
    const before = project(brokenFace([7.5, 3]));
    const after = project(brokenFace([3, 2]), 'a-2');
    expect(ringHierarchyViolationsIntroduced(before, after)).toEqual([]);
  });

  it('穴 P のはみ出しを大きくしただけ（同じ種類・同じ環の違反のまま）なら止めない', () => {
    const before = project(brokenFace([3, 2]));
    const after = project(brokenFace([3, 2], [13, 9]), 'a-2');
    expect(ringHierarchyViolationsIntroduced(before, after)).toEqual([]);
  });
});

describe('violationKey', () => {
  it('対称な違反（穴どうしの重なり）は、どちらの環の名で記録されても同じ鍵', () => {
    const a = { kind: RING_VIOLATION.SiblingsOverlap, ringId: asRingId('x'), relatedRingId: asRingId('y') };
    const b = { kind: RING_VIOLATION.SiblingsOverlap, ringId: asRingId('y'), relatedRingId: asRingId('x') };
    expect(violationKey(a)).toBe(violationKey(b));
  });

  it('対称でない違反（穴が外周と交わる）は向きを区別する', () => {
    const a = { kind: RING_VIOLATION.HoleCrossesParent, ringId: asRingId('x'), relatedRingId: asRingId('y') };
    const b = { kind: RING_VIOLATION.HoleCrossesParent, ringId: asRingId('y'), relatedRingId: asRingId('x') };
    expect(violationKey(a)).not.toBe(violationKey(b));
  });
});

describe('editRejectionMessage', () => {
  const gate = {
    kind: RING_HIERARCHY_GATE_KIND,
    featureId: asFeatureId('f-sea'),
    at: timePointYear(1500),
    violations: [],
    breaks: RING_BREAK.HolesCross,
    featureName: 'セクエンロ狭海',
    atLabel: '1500年',
  };
  const rejected = (detail: unknown) => ({
    status: PROCESS_STATUS.Rejected,
    kind: REJECTION_KIND.ConstraintViolation,
    message: '一般の文',
    detail,
  });

  it('動かした形を断ったなら、壊れ方と、どの面のどの年の形かを言う', () => {
    expect(editRejectionMessage(rejected([gate]))).toBe(
      '動かした形を確定しませんでした。穴と穴が交わる形になるためです（「セクエンロ狭海」の1500年の形）。交わらない位置まで動かしてください。',
    );
  });

  it('頂点の削除を断ったなら、「この頂点を消すと…ので消せません」と言う', () => {
    const tagged = tagRejectionOperation(rejected([gate]), EDIT_OPERATION.DeleteVertex, 1);
    expect(editRejectionMessage(tagged)).toBe(
      'この頂点を消すと穴と穴が交わるので消せません（「セクエンロ狭海」の1500年の形）。頂点は消していません。',
    );
    const many = tagRejectionOperation(rejected([gate]), EDIT_OPERATION.DeleteVertex, 3);
    expect(editRejectionMessage(many)).toContain('選んだ頂点を消すと');
  });

  it('壊れ方ごとに言い方を替える（穴が外周からはみ出す）', () => {
    expect(editRejectionMessage(rejected([{ ...gate, breaks: RING_BREAK.HoleLeavesOuter }]))).toContain(
      '穴が外周からはみ出す形になるため',
    );
  });

  it('この関門の違反でない結果には印を付けない', () => {
    const plain = rejected(undefined);
    expect(tagRejectionOperation(plain, EDIT_OPERATION.DeleteVertex, 1)).toBe(plain);
  });

  it('記録の中身が欠けていれば、言い方を選ばない一般の文にする', () => {
    expect(editRejectionMessage(rejected([{ kind: RING_HIERARCHY_GATE_KIND }]))).toBe(
      RING_HIERARCHY_GATE_STRINGS.refused,
    );
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
