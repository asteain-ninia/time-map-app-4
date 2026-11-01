// 集約地物を動かした確定の文と、結果の数え方。
//
//   npx vitest run src/ui/map/aggregate-move.result.test.ts

import { describe, expect, it } from 'vitest';

import { createAnchor } from '../../domain/anchor';
import { createAnchorEntry } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { planAggregateMove } from '../../domain/editing/move';
import { createAggregateFeature, createLeafFeature, withLeafShape, type Feature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/serialize';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { featuresAt } from '../live-lookup';
import { APP_STRINGS } from '../shell/strings';
import { directAggregateMoveResult, editCommitNote, resolvedAggregateMoveResult } from './aggregate-move';

const COLOR = createColorInfo(true, '#111111', '#222222', '#333333');
const T = timePointYear(1000);
const ring = (id: string, ids: readonly string[]) =>
  createShape([createTerritoryRing(asRingId(id), ids.map((v) => asVertexId(v)))]);
const leaf = (id: string, parent: string, ids: readonly string[]) =>
  createLeafFeature(asFeatureId(id), createBasicAttributes(id, 0, 9999), COLOR, ring(`r-${id}`, ids), {
    parentId: asFeatureId(parent),
  });
const project = (entries: ReadonlyArray<{ readonly year: number; readonly features: readonly Feature[] }>): DomainProject => ({
  histories: [
    {
      featureId: asFeatureId('G'),
      series: {
        entries: entries.map((e) =>
          createAnchorEntry(
            createAnchor(asAnchorId(`a-${String(e.year)}`), {
              features: e.features,
              vertices: createVertexStore(
                ['a', 'b', 'c', 'd', 'e', 's', 'f'].map((v, i) => createVertex(asVertexId(v), { lon: i, lat: i * i })),
              ),
            }),
            timePointYear(e.year),
          ),
        ),
      },
    },
    {
      featureId: asFeatureId('隣'),
      series: {
        entries: [
          createAnchorEntry(
            createAnchor(asAnchorId('a-隣'), {
              features: [
                createLeafFeature(asFeatureId('隣'), createBasicAttributes('隣', 0, 9999), COLOR, ring('r-隣', ['s', 'n1', 'n2'])),
              ],
              vertices: createVertexStore(
                [['s', 5, 25], ['n1', 9, 0], ['n2', 9, 9]].map(([v, x, y]) =>
                  createVertex(asVertexId(v as string), { lon: x as number, lat: y as number }),
                ),
              ),
            }),
            T,
          ),
        ],
      },
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
});

const G = createAggregateFeature(asFeatureId('G'), createBasicAttributes('G', 0, 9999), COLOR, [
  asFeatureId('州1'),
  asFeatureId('州2'),
]);
const S1 = leaf('州1', 'G', ['a', 'b', 'c']);
const S2 = leaf('州2', 'G', ['d', 'e', 's']);

describe('集約地物を動かした確定の文', () => {
  const before = project([{ year: 1000, features: [G, S1, S2] }]);
  const plan = planAggregateMove(asFeatureId('G'), featuresAt(before, T));

  it('直接の確定は計画のとおり', () => {
    expect(editCommitNote(directAggregateMoveResult(plan), null)).toBe(APP_STRINGS.moveAggregateDone(2, 1));
  });

  it('頂点が動いただけなら、解決を通っても全部を動かした数に数える', () => {
    const after = project([{ year: 1000, features: [G, S1, S2] }]);
    expect(resolvedAggregateMoveResult(before, { ...after, histories: before.histories }, T, plan)).toEqual({
      movedLeafCount: 2,
      trimmedLeafCount: 0,
      fixedVertexCount: 1,
    });
  });

  it('板で削られた州は動かした数に入れず、削った数を言う', () => {
    const trimmed = withLeafShape(S2, ring('new-r', ['d', 'e', 'f']));
    const after = project([{ year: 1000, features: [G, S1, trimmed] }]);
    const result = resolvedAggregateMoveResult(before, after, T, plan);
    expect(result).toEqual({ movedLeafCount: 1, trimmedLeafCount: 1, fixedVertexCount: 0 });
    expect(editCommitNote(result, null)).toBe(
      `${APP_STRINGS.moveAggregateDone(1, 0)}${APP_STRINGS.moveAggregateTrimmed(1)}`,
    );
  });

  it('後の年の錨だけで削られた州も削った数に入る。押した年の頂点はまだ引いている', () => {
    const later = withLeafShape(S2, ring('new-r', ['d', 'e', 'f']));
    const after = project([
      { year: 1000, features: [G, S1, S2] },
      { year: 1500, features: [G, S1, later] },
    ]);
    expect(resolvedAggregateMoveResult(before, after, T, plan)).toEqual({
      movedLeafCount: 1,
      trimmedLeafCount: 1,
      fixedVertexCount: 1,
    });
  });

  it('後の年へ引き継いだら両方の経路で同じ文を添える', () => {
    const note = editCommitNote(directAggregateMoveResult(plan), { fromYear: 1000, toYear: 1500, anchorCount: 2 });
    expect(note).toContain(APP_STRINGS.vertexCarriedForward(1000, 1500, 2));
    expect(editCommitNote(null, { fromYear: 1000, toYear: 1500, anchorCount: 2 })).toBe(
      APP_STRINGS.vertexCarriedForwardSentence(1000, 1500, 2),
    );
  });
});
