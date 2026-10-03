// 右クリックの「この線を消す」の項目づくり（増分 8C の中身 3 / 設計書 §E.1 V15）。

import { describe, expect, it } from 'vitest';

import { createGeoParams } from '../../domain/geo/geo-params';
import { measureSurveyPair } from '../../domain/survey/measure';
import type { SurveyLine } from '../../domain/survey/survey-state';

import { SURVEY_STRINGS } from './strings';
import { formatMenuKm, surveyLineMenuItems } from './survey-menu';

const GEO = createGeoParams(40075, 0);
const line = (id: number, a: [number, number], b: [number, number]): SurveyLine => ({
  id,
  start: { lon: a[0], lat: a[1] },
  end: { lon: b[0], lat: b[1] },
});

describe('surveyLineMenuItems', () => {
  const l1 = line(1, [0, 0], [10, 0]);
  const l2 = line(2, [0, 0], [0, 20]);
  const lines = [l1, l2];

  it('当たった線が 1 本なら「この線を消す」1 項目', () => {
    expect(surveyLineMenuItems(lines, [2], GEO)).toEqual([
      { lineId: 2, label: SURVEY_STRINGS.removeThisLine },
    ]);
    expect(SURVEY_STRINGS.removeThisLine).toBe('この線を消す');
  });

  it('2 本以上なら測量ごとに 1 項目ずつ、大円の距離で言い分ける（並びは受け取った順）', () => {
    const items = surveyLineMenuItems(lines, [2, 1], GEO);
    expect(items.map((i) => i.lineId)).toEqual([2, 1]);
    const km2 = measureSurveyPair(l2.start, l2.end, GEO).greatCircleKm;
    const km1 = measureSurveyPair(l1.start, l1.end, GEO).greatCircleKm;
    expect(items[0]!.label).toBe(SURVEY_STRINGS.removeLineOfKm(formatMenuKm(km2)));
    expect(items[1]!.label).toBe(SURVEY_STRINGS.removeLineOfKm(formatMenuKm(km1)));
    expect(items[0]!.label).toBe('2,226km の線を消す');
  });

  it('いまの線に無い id は飛ばす（残りが 1 本なら「この線を消す」）', () => {
    expect(surveyLineMenuItems(lines, [9, 1], GEO)).toEqual([
      { lineId: 1, label: SURVEY_STRINGS.removeThisLine },
    ]);
    expect(surveyLineMenuItems(lines, [9], GEO)).toEqual([]);
    expect(surveyLineMenuItems(lines, [], GEO)).toEqual([]);
  });

  it('同じ id が 2 度来ても 1 項目', () => {
    expect(surveyLineMenuItems(lines, [1, 1], GEO)).toHaveLength(1);
  });
});

describe('formatMenuKm', () => {
  it('整数の km に丸め、3 桁で区切る', () => {
    expect(formatMenuKm(1234.4)).toBe('1,234km');
    expect(formatMenuKm(1234.5)).toBe('1,235km');
    expect(formatMenuKm(0)).toBe('0km');
  });

  it('有限でなければ「—」', () => {
    expect(formatMenuKm(Number.NaN)).toBe(SURVEY_STRINGS.noValue);
  });
});

// 増分 8C の手直し（GPT #1）: 距離を整数 km に丸めるだけなので、形の違う線でも同じ文になり、
// 交差点でどれを消すのか選べなかった。文が衝突した候補だけ端点を添える。
describe('surveyLineMenuItems — 距離の文が同じになった候補', () => {
  // 球（扁平率 0）で、赤道上の東西 20° と、赤道を横切る南北 20° は同じ大円距離。
  const eastWest = line(1, [0, 0], [20, 0]);
  const northSouth = line(2, [10, -10], [10, 10]);
  const other = line(3, [0, 0], [0, 40]);

  it('同じ距離の 2 本は端点の緯度経度で言い分ける（ほかの候補は距離だけのまま）', () => {
    const items = surveyLineMenuItems([eastWest, northSouth, other], [1, 2, 3], GEO);
    const km = formatMenuKm(measureSurveyPair(eastWest.start, eastWest.end, GEO).greatCircleKm);
    expect(formatMenuKm(measureSurveyPair(northSouth.start, northSouth.end, GEO).greatCircleKm)).toBe(km);
    expect(items[0]!.label).toBe(
      SURVEY_STRINGS.removeLineOfKmWithEnds(km, '北緯 0.0° 東経 0.0° → 北緯 0.0° 東経 20.0°'),
    );
    expect(items[1]!.label).toBe(
      SURVEY_STRINGS.removeLineOfKmWithEnds(km, '南緯 10.0° 東経 10.0° → 北緯 10.0° 東経 10.0°'),
    );
    expect(items[0]!.label).not.toBe(items[1]!.label);
    // 衝突していない候補は従来どおり。
    expect(items[2]!.label).toBe(
      SURVEY_STRINGS.removeLineOfKm(
        formatMenuKm(measureSurveyPair(other.start, other.end, GEO).greatCircleKm),
      ),
    );
  });

  it('小数 1 桁で同じなら桁を増やして言い分ける', () => {
    const a = line(1, [0, 0], [20, 0]);
    const b = line(2, [0.01, 0], [20.01, 0]);
    const items = surveyLineMenuItems([a, b], [1, 2], GEO);
    expect(items[0]!.label).toContain('東経 0.00° → 北緯 0.00° 東経 20.00°');
    expect(items[1]!.label).toContain('東経 0.01° → 北緯 0.00° 東経 20.01°');
  });

  it('端点まで同じ（同じ 2 点を 2 回測った）なら測った順を添える', () => {
    const a = line(5, [0, 0], [20, 0]);
    const b = line(7, [0, 0], [20, 0]);
    const items = surveyLineMenuItems([a, b], [7, 5], GEO);
    expect(items.map((i) => i.lineId)).toEqual([7, 5]);
    expect(items[0]!.label).toContain('測った順で 2 本目');
    expect(items[1]!.label).toContain('測った順で 1 本目');
    expect(items[0]!.label).not.toBe(items[1]!.label);
  });

  it('日付変更線ちょうどの端点には東西の語を付けない', () => {
    const a = line(1, [170, 0], [180, 0]);
    const b = line(2, [175, -5], [175, 5]);
    const items = surveyLineMenuItems([a, b], [1, 2], GEO);
    expect(items[0]!.label).toContain('→ 北緯 0.0° 180.0°');
  });
});
