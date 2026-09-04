// 増分 3 の手直し A1（反証 #1 / GPT #1）— 動かした頂点の座標を「次に本当に動く記録」まで
// 前へ引き継ぐ。
//
// **捕まえる欠陥**: 0 年で隣り合う 2 国の角（同じ頂点 id）を動かしても、片方の国が 1500 年に
// 錨を持っていると、その錨が持つ **移動前の座標** が 1500 年から効いてしまい、境界がまた
// 裂ける。手直し前の `applyMovedVerticesToHistories` は「その時刻に存在しない履歴を読み飛ばす」
// 形だったので、隣が 1500 年から現れる場合は 1 本も直せなかった。
//
// この 1 本だけ走らせる:
//   npx vitest run src/domain/editing/vertex-carry-forward.test.ts

import { describe, expect, it } from 'vitest';

import { applyAddProposal, applyEditProposal } from './apply-proposal';
import { reportVertexCarryForward } from './apply-proposal';
import {
  applyVertexCarryForward,
  movedVertexCarries,
  vertexCarryForwardTargets,
} from './vertex-carry-forward';
import { createEditProposal } from '../consistency/types';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createLeafFeature, type LeafFeature } from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, getVertex, type Vertex } from '../vertex';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../ids';
import { resolveAt } from '../anchor-series';
import type { AddSnapshot } from '../add/proposal';
import type { FeatureSnapshot } from './edit-flow';
import type { DomainProject } from '../persistence/serialize';
import { createGeoParams } from '../geo/geo-params';
import { checkConsistency, INCONSISTENCY } from '../persistence/consistency';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const SHARED: VertexId = asVertexId('sv-shared');
const OLD = { lon: 0, lat: 0 };
const NEW = { lon: 42, lat: 7 };

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

/** 共有の頂点 id を 1 つ目に持つ三角形（2 つ作れば 1 つの角を共有する）。 */
function sharedTriangle(
  idRaw: string,
  privA: string,
  privB: string,
  baseLon: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const shared = createVertex(SHARED, OLD);
  const a = createVertex(asVertexId(privA), { lon: baseLon + 1, lat: 0 });
  const b = createVertex(asVertexId(privB), { lon: baseLon + 1, lat: 1 });
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), [shared.id, a.id, b.id]);
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes('F', 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices: [shared, a, b] };
}

function seedAdd(
  root: DomainProject,
  leaf: ReturnType<typeof sharedTriangle>,
  year: number,
): DomainProject {
  const proposal = createEditProposal(leaf.feature.id, timePointYear(year), {
    feature: leaf.feature,
    vertices: leaf.vertices,
    sharedCandidateIds: new Map(),
  } satisfies AddSnapshot);
  return applyAddProposal(root, proposal);
}

function featureIn(project: DomainProject, featureId: string, year: number): LeafFeature {
  const history = project.histories.find((h) => h.featureId === asFeatureId(featureId));
  const res = resolveAt(history!.series, timePointYear(year), calendar);
  if (res.kind !== 'present') throw new Error('居ない');
  return res.entry.anchor.snapshot.features.find(
    (f) => f.id === asFeatureId(featureId),
  ) as LeafFeature;
}

/** その履歴のその年で、共有頂点がどの座標に解決されるか。 */
function sharedCoordIn(
  project: DomainProject,
  featureId: string,
  year: number,
): { lon: number; lat: number } | undefined {
  const history = project.histories.find((h) => h.featureId === asFeatureId(featureId));
  if (history === undefined) return undefined;
  const res = resolveAt(history.series, timePointYear(year), calendar);
  if (res.kind !== 'present') return undefined;
  return getVertex(res.entry.anchor.snapshot.vertices, SHARED)?.coordinate;
}

/** 共有頂点を `to` へ動かす提案を `featureId` に対して `year` で適用する。 */
function moveShared(
  project: DomainProject,
  featureId: string,
  year: number,
  to: { lon: number; lat: number },
): DomainProject {
  const snapshot: FeatureSnapshot = {
    feature: featureIn(project, featureId, year),
    vertices: [createVertex(SHARED, to)],
  };
  return applyEditProposal(
    project,
    createEditProposal(asFeatureId(featureId), timePointYear(year), snapshot),
    calendar,
  );
}

describe('頂点の引き継ぎ（純粋関数）', () => {
  it('移動していない頂点は材料にならない（座標が同じなら何も引き継がない）', () => {
    const carries = movedVertexCarries(
      [createVertex(SHARED, OLD)],
      new Map([[SHARED, OLD]]),
    );
    expect(carries).toEqual([]);
  });

  it('旧座標が引けない頂点は材料にならない（比べる相手が無い）', () => {
    const carries = movedVertexCarries([createVertex(SHARED, NEW)], new Map());
    expect(carries).toEqual([]);
  });

  it('材料が空なら系列をそのまま返す（同一性を保つ）', () => {
    const seeded = seedAdd(emptyProject(), sharedTriangle('f-a', 'va-1', 'va-2', 0), 0);
    const series = seeded.histories[0]!.series;
    expect(applyVertexCarryForward(series, timePointYear(0), [], calendar)).toBe(series);
  });
});

describe('A1: 年をまたいで共有した頂点が後の年で元に戻らない', () => {
  it('隣が 1500 年から存在する場合でも、0 年の移動が 1500 年の記録に反映される', () => {
    // A は 0 年から、B は 1500 年から存在する。どちらも同じ角（SHARED）を参照する。
    let project = seedAdd(emptyProject(), sharedTriangle('f-a', 'va-1', 'va-2', 0), 0);
    project = seedAdd(project, sharedTriangle('f-b', 'vb-1', 'vb-2', 5), 1500);
    expect(sharedCoordIn(project, 'f-b', 1500)).toEqual(OLD);

    // 0 年で A の角を動かす。B は 0 年には存在しないので、手直し前は 1 本も直らなかった。
    const moved = moveShared(project, 'f-a', 0, NEW);

    expect(sharedCoordIn(moved, 'f-a', 0)).toEqual(NEW);
    // ここが欠陥だった箇所: 1500 年へ進むと B が移動前の座標を復活させていた。
    expect(sharedCoordIn(moved, 'f-b', 1500)).toEqual(NEW);
    // 同じ id が年によって別の場所を指していない（保存し直しても咎められない）。
    const divergence = checkConsistency(moved, calendar).inconsistencies.filter(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence).toHaveLength(0);
  });

  it('自分の履歴が後年に持つ錨にも反映される', () => {
    let project = seedAdd(emptyProject(), sharedTriangle('f-a', 'va-1', 'va-2', 0), 0);
    // 1500 年に錨を立てる（別の頂点だけを動かす＝共有の角は動かさない）。
    const snapshot: FeatureSnapshot = {
      feature: featureIn(project, 'f-a', 0),
      vertices: [createVertex(asVertexId('va-1'), { lon: 3, lat: 3 })],
    };
    project = applyEditProposal(
      project,
      createEditProposal(asFeatureId('f-a'), timePointYear(1500), snapshot),
      calendar,
    );
    expect(sharedCoordIn(project, 'f-a', 1500)).toEqual(OLD);

    const moved = moveShared(project, 'f-a', 0, NEW);
    expect(sharedCoordIn(moved, 'f-a', 1500)).toEqual(NEW);
  });

  it('後年で本当にその頂点が動いている記録は書き換えない（そこで止まる）', () => {
    let project = seedAdd(emptyProject(), sharedTriangle('f-a', 'va-1', 'va-2', 0), 0);
    // 1500 年に共有の角を別の場所へ動かす＝「記録された歴史」。
    const genuine = { lon: -20, lat: -20 };
    project = moveShared(project, 'f-a', 1500, genuine);
    expect(sharedCoordIn(project, 'f-a', 1500)).toEqual(genuine);

    // そのあと 0 年で動かしても、1500 年の記録は残る。
    const moved = moveShared(project, 'f-a', 0, NEW);
    expect(sharedCoordIn(moved, 'f-a', 0)).toEqual(NEW);
    expect(sharedCoordIn(moved, 'f-a', 1500)).toEqual(genuine);
  });

  it('引き継ぎ先の錨は「止まる位置」まで（走査は 1 本の実装を共有する）', () => {
    let project = seedAdd(emptyProject(), sharedTriangle('f-a', 'va-1', 'va-2', 0), 0);
    project = moveShared(project, 'f-a', 2000, { lon: -20, lat: -20 });
    const history = project.histories[0]!;
    const carries = movedVertexCarries([createVertex(SHARED, NEW)], new Map([[SHARED, OLD]]));
    const targets = vertexCarryForwardTargets(
      history.series.entries,
      timePointYear(0),
      carries,
      calendar,
    );
    // 2000 年の錨はその頂点が本当に動いているので対象外（＝書き換え先は 0 本）。
    expect(targets).toHaveLength(0);
  });

  it('状態行の材料（何本の記録に反映したか）は、実際に書き換える範囲と同じ 1 本から出す', () => {
    let project = seedAdd(emptyProject(), sharedTriangle('f-a', 'va-1', 'va-2', 0), 0);
    project = seedAdd(project, sharedTriangle('f-b', 'vb-1', 'vb-2', 5), 1500);
    const proposal = createEditProposal(asFeatureId('f-a'), timePointYear(0), {
      feature: featureIn(project, 'f-a', 0),
      vertices: [createVertex(SHARED, NEW)],
    } satisfies FeatureSnapshot);

    const report = reportVertexCarryForward(project, proposal, calendar);
    expect(report.anchorCount).toBe(1);
    expect(report.firstYear).toBe(1500);

    // 予告した本数と、実際に新座標へ変わった錨の本数が一致する。
    const applied = applyEditProposal(project, proposal, calendar);
    expect(sharedCoordIn(applied, 'f-b', 1500)).toEqual(NEW);
  });

  it('後ろに錨が無ければ何も予告しない', () => {
    const project = seedAdd(emptyProject(), sharedTriangle('f-a', 'va-1', 'va-2', 0), 0);
    const proposal = createEditProposal(asFeatureId('f-a'), timePointYear(0), {
      feature: featureIn(project, 'f-a', 0),
      vertices: [createVertex(SHARED, NEW)],
    } satisfies FeatureSnapshot);
    expect(reportVertexCarryForward(project, proposal, calendar)).toEqual({
      anchorCount: 0,
      firstYear: null,
    });
  });
});
