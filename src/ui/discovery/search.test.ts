import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../../domain/ids';

import { FEATURE_KIND_AXIS } from './axes';
import {
  evaluateJump,
  highlightIds,
  JUMP_OUTCOME,
  MATCH_FIELD,
  reevaluateResult,
  searchFeatures,
  type SearchableFeature,
} from './search';

const A = asFeatureId('A');
const B = asFeatureId('B');
const C = asFeatureId('C');

function f(
  id: FeatureId,
  name: string,
  description: string,
  attributes: string[],
): SearchableFeature {
  return { id, kind: FEATURE_KIND_AXIS.Area, name, description, attributes };
}

const corpus: SearchableFeature[] = [
  f(A, 'ローマ', 'イタリアの都市', ['都市', '-27']),
  f(B, 'カルタゴ', '北アフリカの港', ['都市']),
  f(C, 'ナイル川', '長い川', ['河川']),
];

describe('searchFeatures over the visible母集合 (FR-113, 教訓 5.3)', () => {
  it('matches by name', () => {
    const result = searchFeatures(corpus, 'ローマ');
    expect(result.hits.map((h) => h.featureId)).toEqual([A]);
    expect(result.hits[0]?.matchedFields).toContain(MATCH_FIELD.Name);
  });

  it('matches by description', () => {
    const result = searchFeatures(corpus, '港');
    expect(result.hits.map((h) => h.featureId)).toEqual([B]);
    expect(result.hits[0]?.matchedFields).toContain(MATCH_FIELD.Description);
  });

  it('matches by attribute value (種別ラベル/年代)', () => {
    const result = searchFeatures(corpus, '都市');
    expect(result.hits.map((h) => h.featureId)).toEqual([A, B]);
    for (const hit of result.hits) {
      expect(hit.matchedFields).toContain(MATCH_FIELD.Attribute);
    }
  });

  it('only searches the supplied corpus — a hidden/absent feature cannot appear', () => {
    // 母集合 excludes C; searching its content yields nothing (教訓 5.3).
    const visibleOnly = corpus.filter((x) => x.id !== C);
    expect(searchFeatures(visibleOnly, '川').hits).toHaveLength(0);
    // …but it DOES appear when present in the母集合.
    expect(searchFeatures(corpus, '川').hits.map((h) => h.featureId)).toEqual([C]);
  });

  it('is case/width-insensitive (NFKC fold)', () => {
    expect(searchFeatures([f(A, 'Rome', 'City', [])], 'rome').hits).toHaveLength(1);
  });
});

describe('reevaluateResult (依存状態変化時の再評価, 教訓 5.5 / 5.6)', () => {
  it('drops hits no longer in the current母集合, regardless of which path changed', () => {
    const result = searchFeatures(corpus, '都市'); // A, B
    // current母集合 shrinks (e.g. time moved / filter hid B) → only A remains.
    const shrunk = corpus.filter((x) => x.id === A);
    const re = reevaluateResult(result, shrunk);
    expect(re.hits.map((h) => h.featureId)).toEqual([A]);
    expect(re.query).toBe('都市');
  });
});

describe('highlightIds', () => {
  it('exposes the hit ids as the highlight set the draw layer subscribes to', () => {
    const ids = highlightIds(searchFeatures(corpus, '都市'));
    expect(ids).toEqual(new Set([A, B]));
  });
});

describe('evaluateJump (結果へジャンプ, 受け入れ基準2, 教訓 5.5)', () => {
  it('selectable when in母集合 and present at time', () => {
    expect(evaluateJump(A, corpus, true)).toBe(JUMP_OUTCOME.Selectable);
  });

  it('present but not selectable → camera only, no selection', () => {
    expect(evaluateJump(A, corpus, false)).toBe(JUMP_OUTCOME.PresentNoSelect);
  });

  it('gone from母集合 → no jump', () => {
    const without = corpus.filter((x) => x.id !== A);
    expect(evaluateJump(A, without, true)).toBe(JUMP_OUTCOME.Gone);
  });
});
