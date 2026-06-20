// U32: edit-intent + no-op guard tests (FR-97 / FR-84, 教訓 5.24 / 5.15).

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createPointFeature } from '../../domain/feature';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { timePointYearMonthDay } from '../../domain/time/time-point';

import {
  buildEditIntent,
  isNoOpEdit,
  valuesFromFeature,
} from './edit-intent';

const color = createColorInfo(true, '#111111', '#222222', '#333333');
const feature = createPointFeature(
  asFeatureId('F'),
  createBasicAttributes('織田領', 1560, 1582),
  color,
  asVertexId('v'),
);

describe('edit-intent (教訓 5.24 / 5.15)', () => {
  it('valuesFromFeature projects every basic + color field', () => {
    const v = valuesFromFeature(feature);
    expect(v).toEqual({
      name: '織田領',
      startYear: 1560,
      endYear: 1582,
      autoColorEnabled: true,
      fillColor: '#111111',
      selectedColor: '#222222',
      borderColor: '#333333',
    });
  });

  it('isNoOpEdit is true when values equal the feature (no ghost undo, 教訓 5.24)', () => {
    expect(isNoOpEdit(feature, valuesFromFeature(feature))).toBe(true);
  });

  it('isNoOpEdit is false when any field changed', () => {
    const changed = { ...valuesFromFeature(feature), name: '羽柴領' };
    expect(isNoOpEdit(feature, changed)).toBe(false);
  });

  it('isNoOpEdit is false when a color field changed', () => {
    const changed = { ...valuesFromFeature(feature), fillColor: '#ffffff' };
    expect(isNoOpEdit(feature, changed)).toBe(false);
  });

  it('buildEditIntent uses the passed edit time (context上の時刻, never a clock)', () => {
    const editTime = timePointYearMonthDay(1573, 8, 15);
    const intent = buildEditIntent(feature, editTime, valuesFromFeature(feature));
    expect(intent.featureId).toBe(feature.id);
    expect(intent.editTime).toBe(editTime);
  });
});
