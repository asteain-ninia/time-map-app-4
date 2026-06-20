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
  descriptionMarkdown: '**イタリア**の<script>x</script>都市',
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

describe('toSearchableFeature (検索コーパス組み立て + 前サニタイズ, FR-116)', () => {
  it('maps the coarse kind-axis and sanitizes the description to素テキスト', () => {
    const sf = toSearchableFeature(record);
    expect(sf.kind).toBe(FEATURE_KIND_AXIS.Area); // leaf → 面情報
    expect(sf.name).toBe('ローマ');
    // markdown markup (** **) and HTML tags are stripped to whitespace-separated
    // words before search; whitespace is collapsed.
    expect(sf.description).toBe('イタリア の x 都市');
    expect(sf.description).not.toContain('**');
    expect(sf.description).not.toContain('<');
    expect(sf.attributes).toEqual(['都市', '-27']);
  });
});
