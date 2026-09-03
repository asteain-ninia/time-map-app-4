// projectStats の単体テスト（教訓 5.41: E2E からしか触れない範囲は純関数化して単体で守る）。
//
// いちばん間違えやすいのは「錨列の数」と「地物の数」の取り違えである（現状分析 §7.1 の
// 申し送り）。集約の子は **親のスナップショットにも入る** ので、id で畳んだ地物の数は
// 錨列の数より多くなる（実データで錨列 689 / 地物 775）。ここではその形を小さく作って
// 数え方を固定する。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, type AnchorSeries } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  createPointFeature,
  type Feature,
} from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import type { DomainProject } from '../../domain/persistence/serialize';

import { projectStats } from './project-stats';

const color = createColorInfo(false, '#111111', '#222222', '#333333');

function ring(id: string, count: number): ReturnType<typeof createTerritoryRing> {
  const ids: VertexId[] = [];
  for (let i = 0; i < count; i += 1) ids.push(asVertexId(`${id}-v${i}`));
  return createTerritoryRing(asRingId(id), ids);
}

function leaf(id: string, name: string, vertexCount: number): Feature {
  return createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(name, 0, 9999),
    color,
    createShape([ring(`${id}-r0`, vertexCount)]),
  );
}

function seriesOf(features: readonly Feature[], anchors: number): AnchorSeries {
  const store = createVertexStore([createVertex(asVertexId('v0'), createCoordinate(0, 0))]);
  const entries = [];
  for (let i = 0; i < anchors; i += 1) {
    entries.push(
      createAnchorEntry(
        createAnchor(asFeatureId(`a${i}`) as unknown as never, createAnchorSnapshot(features, store)),
        timePointYear(i * 100),
        i === anchors - 1 ? null : timePointYear((i + 1) * 100),
      ),
    );
  }
  return { entries };
}

/** 集約 1 + その子 2（子は親のスナップショットにも入る）＋ 単独の点 1。 */
function sampleProject(): DomainProject {
  const childA = leaf('child-a', '???州', 5);
  const childB = leaf('child-b', '???州', 40);
  const parent = createAggregateFeature(
    asFeatureId('parent'),
    createBasicAttributes('デーレ共和国', 0, 9999),
    color,
    [asFeatureId('child-a'), asFeatureId('child-b')],
  );
  const point = createPointFeature(
    asFeatureId('point'),
    createBasicAttributes('灯台', 0, 9999),
    color,
    asVertexId('v0'),
  );

  return {
    histories: [
      // 親の錨列は 2 本の錨を持ち、そのスナップショットに親と子 2 件が入る。
      { featureId: asFeatureId('parent'), series: seriesOf([parent, childA, childB], 2) },
      // 単独の地物の錨列は 1 本。
      { featureId: asFeatureId('point'), series: seriesOf([point], 1) },
    ],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0),
      gridSpacingDeg: 10,
      snapDistancePx: 12,
      autoColorDefault: true,
    },
    baseMap: { source: '', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

describe('projectStats — 実データの規模を数える（T-2 の観測）', () => {
  it('錨列の数と錨の数と地物の数を取り違えない', () => {
    const stats = projectStats(sampleProject());
    // 錨列は 2 本（親と単独の点）。
    expect(stats.historyCount).toBe(2);
    // 錨は 2 + 1 = 3 本。
    expect(stats.anchorCount).toBe(3);
    // 地物は id で畳んで 4 件（親・子 2・点）。**錨列より多い** のが正しい。
    expect(stats.featureCount).toBe(4);
    expect(stats.leafCount).toBe(2);
    expect(stats.aggregateCount).toBe(1);
  });

  it('表示名の重複を、名前ごとの件数と地物の総数の両方で返す', () => {
    const stats = projectStats(sampleProject());
    expect(stats.uniqueNameCount).toBe(3); // ???州 / デーレ共和国 / 灯台
    expect(stats.duplicateNameGroups).toEqual([{ name: '???州', count: 2 }]);
    // 画面上で区別できない地物の数（= 一覧の行が名前しか運ばないせいで取り違える件数）。
    expect(stats.duplicateNamedFeatureCount).toBe(2);
  });

  it('いちばん頂点の多い地物を返す（集約は自前の形を持たないので 0 と数える）', () => {
    const stats = projectStats(sampleProject());
    expect(stats.heaviestFeature).toEqual({
      id: 'child-b',
      name: '???州',
      vertexCount: 40,
      ringCount: 1,
    });
  });

  it('地物が 1 つも無いプロジェクトでは heaviestFeature が null', () => {
    const empty: DomainProject = { ...sampleProject(), histories: [] };
    const stats = projectStats(empty);
    expect(stats).toMatchObject({
      historyCount: 0,
      anchorCount: 0,
      featureCount: 0,
      uniqueNameCount: 0,
      duplicateNameGroups: [],
      duplicateNamedFeatureCount: 0,
      heaviestFeature: null,
    });
  });
});
