// 増分 8E（N-18）: 重なり解決の呼び名は **内部 ID を決して出さない**。
//
// 名前があれば名前、空なら「名前のない面（1500年に作成）」。作成の年は、その地物を載せた
// いちばん早い錨の開始（まとめ役の系列に居候している子でも探せる）。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  type Feature,
} from '../../domain/feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { FeatureHistory } from '../../domain/persistence/index';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import {
  PARTICIPANT_NAME_STRINGS,
  createdAtOf,
  participantDisplayName,
} from './participant-name';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function leaf(id: string, name: string): Feature {
  const ring = createTerritoryRing(asRingId(`r-${id}`), [
    asVertexId(`${id}-0`),
    asVertexId(`${id}-1`),
    asVertexId(`${id}-2`),
  ]);
  return createLeafFeature(asFeatureId(id), createBasicAttributes(name, 0, 0), color, createShape([ring]));
}

function history(ownerId: string, entries: readonly [number, readonly Feature[]][]): FeatureHistory {
  return {
    featureId: asFeatureId(ownerId),
    series: normalizeSeries(
      entries.map(([year, features], i) =>
        createAnchorEntry(
          createAnchor(
            asAnchorId(`a-${ownerId}-${String(i)}`),
            createAnchorSnapshot(features, createVertexStore([])),
          ),
          timePointYear(year),
        ),
      ),
      calendar,
    ),
  };
}

describe('participantDisplayName — 内部 ID を出さない（N-18）', () => {
  it('名前があれば名前をそのまま出す', () => {
    expect(participantDisplayName(leaf('f-5-4', 'アルラーク国'), timePointYear(1200))).toBe(
      'アルラーク国',
    );
  });

  it('名前が空なら「名前のない面（1500年に作成）」で、id は含まない', () => {
    const label = participantDisplayName(leaf('f-5-4', ''), timePointYear(1500));
    expect(label).toBe('名前のない面（1500年に作成）');
    expect(label).not.toContain('f-5-4');
  });

  it('見えない文字だけの名前も「名前なし」と読む', () => {
    expect(participantDisplayName(leaf('f-1', '​ ​'), timePointYear(800))).toBe(
      '名前のない面（800年に作成）',
    );
  });

  it('紀元前の年も同じ書き方で出す', () => {
    expect(participantDisplayName(leaf('f-1', ''), timePointYear(-300))).toBe(
      '名前のない面（紀元前300年に作成）',
    );
  });

  it('作成の年が分からなければ年を添えない（id へは落とさない）', () => {
    expect(participantDisplayName(leaf('f-9', ''), undefined)).toBe(
      PARTICIPANT_NAME_STRINGS.unnamed('面'),
    );
  });

  it('面以外の種類でも、その種類の語で呼ぶ', () => {
    const line = createLineFeature(
      asFeatureId('l-1'),
      createBasicAttributes('', 0, 0),
      color,
      [asVertexId('a'), asVertexId('b')],
    );
    expect(participantDisplayName(line, timePointYear(10))).toBe('名前のない線（10年に作成）');
    const agg = createAggregateFeature(
      asFeatureId('g-1'),
      createBasicAttributes('', 0, 0),
      color,
      [],
    );
    expect(participantDisplayName(agg, timePointYear(10))).toBe(
      '名前のないまとめ役の地物（10年に作成）',
    );
  });
});

describe('createdAtOf — いちばん早い錨の開始', () => {
  it('自分の系列のいちばん早い錨を返す', () => {
    const f = leaf('f-a', '');
    const h = history('f-a', [
      [1500, [f]],
      [1200, [f]],
    ]);
    expect(createdAtOf([h], asFeatureId('f-a'), calendar)).toEqual(timePointYear(1200));
  });

  it('まとめ役の系列に居候している子は、その子が初めて載った錨で数える', () => {
    const child = leaf('f-child', '');
    const other = leaf('f-other', '');
    const owner = history('g-owner', [
      [1000, [other]],
      [1300, [other, child]],
    ]);
    expect(createdAtOf([owner], asFeatureId('f-child'), calendar)).toEqual(timePointYear(1300));
  });

  it('複数の系列に載っていれば、全系列でいちばん早いもの', () => {
    const f = leaf('f-x', '');
    const a = history('h-a', [[1400, [f]]]);
    const b = history('h-b', [[900, [f]]]);
    expect(createdAtOf([a, b], asFeatureId('f-x'), calendar)).toEqual(timePointYear(900));
  });

  it('どこにも載っていなければ undefined', () => {
    expect(createdAtOf([], asFeatureId('f-none'), calendar)).toBeUndefined();
  });
});
