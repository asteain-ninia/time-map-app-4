// U25 — first-click hole/enclave auto-detection (FR-22, 受け入れ基準 1).

import { describe, expect, it } from 'vitest';
import { RING_ADD_MODE, classifyFirstClick, isPointInSolidFill } from './auto-mode';
import { coord, squareLeaf, squareWithHoleLeaf } from './fixtures';

describe('classifyFirstClick — hole vs enclave (FR-22)', () => {
  it('a click in the solid fill → hole mode', () => {
    const { feature, vertices } = squareLeaf();
    expect(classifyFirstClick(feature.shape, vertices, coord(50, 50))).toBe(RING_ADD_MODE.Hole);
  });

  it('a click OUTSIDE the face → enclave mode', () => {
    const { feature, vertices } = squareLeaf();
    expect(classifyFirstClick(feature.shape, vertices, coord(200, 200))).toBe(
      RING_ADD_MODE.Enclave,
    );
  });

  it('a click INSIDE a hole (void) → enclave mode', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    // (50,50) is inside H0's void, so it is NOT solid → enclave.
    expect(classifyFirstClick(feature.shape, vertices, coord(50, 50))).toBe(
      RING_ADD_MODE.Enclave,
    );
  });

  it('a click in the solid ring (outside the hole) → hole mode', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    // (10,10) is inside T0 but outside H0 → solid → hole.
    expect(classifyFirstClick(feature.shape, vertices, coord(10, 10))).toBe(RING_ADD_MODE.Hole);
  });

  it('isPointInSolidFill agrees with classifyFirstClick (对概念 partition)', () => {
    const { feature, vertices } = squareWithHoleLeaf();
    for (const p of [coord(10, 10), coord(50, 50), coord(200, 0)]) {
      const solid = isPointInSolidFill(feature.shape, vertices, p);
      const mode = classifyFirstClick(feature.shape, vertices, p);
      expect(mode === RING_ADD_MODE.Hole).toBe(solid);
      expect(mode === RING_ADD_MODE.Enclave).toBe(!solid);
    }
  });

  it('empty shape (no territory) → always enclave (教訓 5.18 boundary)', () => {
    const { vertices } = squareLeaf();
    const empty = { rings: [] };
    expect(classifyFirstClick(empty, vertices, coord(50, 50))).toBe(RING_ADD_MODE.Enclave);
    expect(isPointInSolidFill(empty, vertices, coord(50, 50))).toBe(false);
  });
});
