// 増分 8E の手直し（GPT 重 3 / G-15）: 自動配色の切り替えを往復しても、打ち込んだ手動色・
// 透過を失わない。部品が覚えておく「この下書きで 1 度 OFF にしたか」の口を回す。

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature, type Feature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';

import { useAutoColorToggle } from './auto-color-off';
import type { StyleValues } from './style-section';

function face(autoColor: boolean): Feature {
  return createLeafFeature(
    asFeatureId('f-1'),
    createBasicAttributes('面', 0, 0),
    createColorInfo(autoColor, '#aa5500', '#ffcc00', '#000000', 'default', 0.7, 0.9),
    createShape([
      createTerritoryRing(asRingId('r'), [asVertexId('a'), asVertexId('b'), asVertexId('c')]),
    ]),
  );
}

const painted: StyleValues = {
  autoColorEnabled: true,
  paletteTheme: 'default',
  fillColor: '#aa5500',
  fillOpacity: 0.7,
  selectedColor: '#ffcc00',
  selectedOpacity: 0.9,
};

describe('useAutoColorToggle（G-15 の往復）', () => {
  it('保存済みが ON: OFF（塗られた色が入る）→ 色と両方の透過を打つ → ON → OFF で、打った値が残る', () => {
    const feature = face(true);
    const { result } = renderHook(() => useAutoColorToggle(feature));
    let draft: StyleValues = painted;
    const step = (next: StyleValues): void => {
      act(() => {
        draft = result.current(draft, next);
      });
    };

    // 初めて OFF: 地物にいま塗られている色が手動色として入る。
    step({ ...draft, autoColorEnabled: false, fillColor: '#999999' });
    expect(draft.fillColor).toBe('#aa5500');
    // 手で打つ（色・選択色・両方の透過）。
    const typed = {
      fillColor: '#123456',
      fillOpacity: 0.3,
      selectedColor: '#654321',
      selectedOpacity: 0.4,
    };
    step({ ...draft, ...typed });
    // ON → OFF と往復する。
    step({ ...draft, autoColorEnabled: true });
    step({ ...draft, autoColorEnabled: false });
    expect(draft).toEqual({ ...painted, autoColorEnabled: false, ...typed });
  });

  it('保存済みが OFF: 色を打つ → ON → OFF で、打った値が残る', () => {
    const feature = face(false);
    const { result } = renderHook(() => useAutoColorToggle(feature));
    let draft: StyleValues = { ...painted, autoColorEnabled: false, fillColor: '#abcdef', fillOpacity: 0.2 };
    act(() => {
      draft = result.current(draft, { ...draft, autoColorEnabled: true });
    });
    act(() => {
      draft = result.current(draft, { ...draft, autoColorEnabled: false });
    });
    expect(draft.fillColor).toBe('#abcdef');
    expect(draft.fillOpacity).toBe(0.2);
  });

  it('地物の色の記録が変わったら（保存・自動配色で塗り直し）覚えを忘れ、初めての OFF として扱う', () => {
    let feature = face(true);
    const { result, rerender } = renderHook(() => useAutoColorToggle(feature));
    act(() => {
      result.current(painted, { ...painted, autoColorEnabled: false });
    });
    // 保存で塗り直された（色の記録が別の参照になった）。
    feature = { ...feature, color: createColorInfo(true, '#00aa00', '#ffcc00', '#000000', 'default', 0.7, 0.9) };
    rerender();
    let out: StyleValues = painted;
    act(() => {
      out = result.current(
        { ...painted, fillColor: '#00aa00' },
        { ...painted, fillColor: '#777777', autoColorEnabled: false },
      );
    });
    expect(out.fillColor).toBe('#00aa00');
  });
});
