import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';

import { FEATURE_KIND_AXIS } from './axes';
import {
  toDisplayMeta,
  toSearchableFeature,
  type FeatureReadModel,
} from './adapters';

const record: FeatureReadModel = {
  id: asFeatureId('A'),
  kind: 'leaf',
  depth: 2,
  name: 'ローマ',
  workingMemo: '  **イタリア**の\n都市  ',
  attributeValues: ['都市', '-27'],
};

describe('toDisplayMeta (U32 → visibility 入力, 教訓 5.33)', () => {
  it('projects id / kind / depth verbatim', () => {
    expect(toDisplayMeta(record)).toEqual({
      id: record.id,
      kind: 'leaf',
      depth: 2,
    });
  });
});

describe('toSearchableFeature (検索コーパス組み立て + 前の整え, FR-116)', () => {
  it('maps the coarse kind-axis and normalizes the作業メモ (書式は解釈しない)', () => {
    const sf = toSearchableFeature(record);
    expect(sf.kind).toBe(FEATURE_KIND_AXIS.Area); // leaf → 面情報
    expect(sf.name).toBe('ローマ');
    // 作業メモはプレーンテキスト。記法の文字は残し、空白の揺れだけを整える。
    expect(sf.description).toBe('**イタリア**の 都市');
    expect(sf.attributes).toEqual(['都市', '-27']);
  });
});
