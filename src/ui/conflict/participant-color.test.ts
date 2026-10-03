// 増分 8E の手直し（設計適合 S2-4・GPT 重 2）: 色見本で 2 件を見分けられるかの判定。

import { describe, expect, it } from 'vitest';

import { DEFAULT_BASE_COLORS } from '../../domain/coloring/palette';

import { SWATCH_NEAR_DISTANCE, swatchesIndistinguishable } from './participant-color';

describe('swatchesIndistinguishable', () => {
  it('同じ色（大文字・小文字の違いも同じ）は見分けられない', () => {
    expect(swatchesIndistinguishable('#4e79a7', '#4E79A7')).toBe(true);
  });

  it('明るさが 1 段ちがう程度の近い色も見分けられない', () => {
    expect(swatchesIndistinguishable('#2e7d32', '#388e3c')).toBe(true);
  });

  it('色相の違う色は見分けられる', () => {
    expect(swatchesIndistinguishable('#4e79a7', '#f28e2b')).toBe(false);
  });

  it('色が無い・読めないときは、見分けられないとみなす（安全側）', () => {
    expect(swatchesIndistinguishable(undefined, '#4e79a7')).toBe(true);
    expect(swatchesIndistinguishable('red', '#4e79a7')).toBe(true);
  });

  it('自動配色の既定のパレットの色どうしは、近いとみなす幅より離れている', () => {
    const colors = DEFAULT_BASE_COLORS;
    for (let i = 0; i < colors.length; i += 1) {
      for (let j = i + 1; j < colors.length; j += 1) {
        expect(
          swatchesIndistinguishable(colors[i], colors[j]),
          `${colors[i]!} と ${colors[j]!}（幅 ${String(SWATCH_NEAR_DISTANCE)}）`,
        ).toBe(false);
      }
    }
  });
});
