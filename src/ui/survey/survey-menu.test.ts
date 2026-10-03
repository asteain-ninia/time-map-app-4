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
