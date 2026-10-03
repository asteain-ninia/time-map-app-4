// 増分 8E（G-15 / FR-100）: 自動配色を OFF にしたとき、いま塗られている色を手動色として残す。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';

import { styleOnAutoColorToggle } from './auto-color-off';
import type { StyleValues } from './style-section';

/** 自動配色で #aa5500 に塗られている面。 */
const feature = createLeafFeature(
  asFeatureId('f-1'),
  createBasicAttributes('面', 0, 0),
  createColorInfo(true, '#aa5500', '#ffcc00', '#000000', 'default', 0.7, 0.9),
  createShape([
    createTerritoryRing(asRingId('r'), [asVertexId('a'), asVertexId('b'), asVertexId('c')]),
  ]),
);

const onValues: StyleValues = {
  autoColorEnabled: true,
  paletteTheme: 'default',
  fillColor: '#aa5500',
  fillOpacity: 0.7,
  selectedColor: '#ffcc00',
  selectedOpacity: 0.9,
};

describe('styleOnAutoColorToggle（G-15）', () => {
  it('ON → OFF では、地物にいま塗られている色と透過を手動色として残す', () => {
    // 下書きの色が何かの理由で地図とずれていても、残るのは「いま見えている色」。
    const drifted: StyleValues = { ...onValues, fillColor: '#123456', selectedColor: '#654321' };
    const next = styleOnAutoColorToggle(feature, drifted, { ...drifted, autoColorEnabled: false });
    expect(next).toEqual({
      autoColorEnabled: false,
      paletteTheme: 'default',
      fillColor: '#aa5500',
      fillOpacity: 0.7,
      selectedColor: '#ffcc00',
      selectedOpacity: 0.9,
    });
  });

  it('ON → OFF でも、利用者が選んだパレットはそのまま残す', () => {
    const next = styleOnAutoColorToggle(feature, onValues, {
      ...onValues,
      autoColorEnabled: false,
      paletteTheme: 'pastel',
    });
    expect(next.paletteTheme).toBe('pastel');
  });

  it('OFF → ON や、色だけの変更には手を出さない', () => {
    const off: StyleValues = { ...onValues, autoColorEnabled: false };
    const turnedOn = { ...off, autoColorEnabled: true };
    expect(styleOnAutoColorToggle(feature, off, turnedOn)).toBe(turnedOn);
    const recolored = { ...off, fillColor: '#00ff00' };
    expect(styleOnAutoColorToggle(feature, off, recolored)).toBe(recolored);
  });
});
