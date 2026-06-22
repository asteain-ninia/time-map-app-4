// HB3-15(c) — merge / reparent target-highlight render-batch unit tests.
//
// Asserts the highlight builders turn the picked leaf shapes into emphasis `shape`
// primitives in the TOOL-SPECIFIC colours, that an empty / absent selection is a real
// valid empty frame (教訓 5.18), and that reparent draws the target + new-parent in
// DISTINCT role colours (FR-46〜FR-49). What highlights is the SAME resolved leaf shape
// the commit uses (host passes it in), so the visual target == the committed target
// (単一真実源).

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../domain/coordinate';
import type { GeoMultiPolygon } from '../domain/geometry/types';

import {
  DEFAULT_MERGE_TARGET_STYLE,
  DEFAULT_REPARENT_PARENT_STYLE,
  DEFAULT_REPARENT_TARGET_STYLE,
  buildMergeHighlight,
  buildReparentHighlight,
} from './reaffiliation-batch';
import type { DrawPrimitive, PolygonShapePrimitive } from './map-renderer';

function square(ox: number): GeoMultiPolygon {
  return [
    [
      [
        createCoordinate(ox, 0),
        createCoordinate(ox + 2, 0),
        createCoordinate(ox + 2, 2),
        createCoordinate(ox, 2),
      ],
    ],
  ];
}

function shapes(prims: readonly DrawPrimitive[]): PolygonShapePrimitive[] {
  return prims.filter((p): p is PolygonShapePrimitive => p.kind === 'shape');
}

describe('buildMergeHighlight — 結合ターゲット強調 (HB3-15(c))', () => {
  it('an empty selection draws nothing (教訓 5.18 valid empty frame)', () => {
    expect(buildMergeHighlight({ targetShapes: [] })).toEqual([]);
  });

  it('an all-absent selection still draws nothing (a target whose leaf is gone)', () => {
    expect(buildMergeHighlight({ targetShapes: [undefined, undefined] })).toEqual([]);
  });

  it('draws ONE emphasis shape per present target, in the merge tool colour', () => {
    const prims = buildMergeHighlight({ targetShapes: [square(0), square(2)] });
    const s = shapes(prims);
    expect(s).toHaveLength(2);
    for (const prim of s) {
      expect(prim.fill).toBe(DEFAULT_MERGE_TARGET_STYLE.fill);
      expect(prim.stroke).toBe(DEFAULT_MERGE_TARGET_STYLE.stroke);
      expect(prim.strokeWidthPx).toBe(DEFAULT_MERGE_TARGET_STYLE.strokeWidthPx);
      // The merge colour is translucent so the base map reads through.
      expect(prim.fill).toMatch(/rgba\(.+0\.\d+\)/);
    }
  });

  it('skips absent shapes but keeps the present ones (mixed selection)', () => {
    const prims = buildMergeHighlight({ targetShapes: [square(0), undefined, square(4)] });
    expect(shapes(prims)).toHaveLength(2);
  });

  it('the highlighted geometry is the SAME shape passed in (単一真実源)', () => {
    const shape = square(0);
    const prims = buildMergeHighlight({ targetShapes: [shape] });
    const s = shapes(prims)[0]!;
    // The first piece's outer ring carries the same corner coordinates as the input.
    const ring = s.pieces[0]![0]!;
    expect(ring[0]).toEqual({ lon: 0, lat: 0 });
    expect(ring[1]).toEqual({ lon: 2, lat: 0 });
  });
});

describe('buildReparentHighlight — 所属変更 対象 + 新上位 強調 (HB3-15(c))', () => {
  it('an empty selection draws nothing (教訓 5.18)', () => {
    expect(buildReparentHighlight({ targetShape: undefined, newParentShape: undefined })).toEqual([]);
  });

  it('the target alone draws ONE shape in the reparent TARGET colour', () => {
    const prims = buildReparentHighlight({ targetShape: square(0), newParentShape: undefined });
    const s = shapes(prims);
    expect(s).toHaveLength(1);
    expect(s[0]!.fill).toBe(DEFAULT_REPARENT_TARGET_STYLE.fill);
    expect(s[0]!.stroke).toBe(DEFAULT_REPARENT_TARGET_STYLE.stroke);
  });

  it('target + new parent draw TWO shapes in DISTINCT role colours (target then parent)', () => {
    const prims = buildReparentHighlight({ targetShape: square(0), newParentShape: square(4) });
    const s = shapes(prims);
    expect(s).toHaveLength(2);
    // Back-to-front: target first, new parent on top.
    expect(s[0]!.stroke).toBe(DEFAULT_REPARENT_TARGET_STYLE.stroke);
    expect(s[1]!.stroke).toBe(DEFAULT_REPARENT_PARENT_STYLE.stroke);
    // The two role colours are genuinely different so they read apart on the map.
    expect(s[0]!.stroke).not.toBe(s[1]!.stroke);
    expect(s[0]!.fill).not.toBe(s[1]!.fill);
  });
});

describe('tool colours are distinct across tools (HB3-15(c) ツール専用色)', () => {
  it('merge / reparent-target / reparent-parent strokes are all different', () => {
    const set = new Set([
      DEFAULT_MERGE_TARGET_STYLE.stroke,
      DEFAULT_REPARENT_TARGET_STYLE.stroke,
      DEFAULT_REPARENT_PARENT_STYLE.stroke,
    ]);
    expect(set.size).toBe(3);
  });
});
