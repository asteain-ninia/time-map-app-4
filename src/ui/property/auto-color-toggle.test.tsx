/// <reference types="@testing-library/jest-dom" />
// 増分 8E の手直し（GPT 重 3 / G-15）と再手直し（再検証 3-1）: 自動配色の切り替えを往復しても、
// 打ち込んだ手動色・透過を失わない。
//
// 「この下書きで 1 度 OFF にしたか」の覚えは **下書きと同じ場所**（素性欄）が持つ。ここでは
// 素性欄の代わりに、下書きと覚えを持つ小さな親を置き、**「見た目」の欄（BasicInfoForm）だけを
// 外して付け直す**（選択を外す・居ない年へ動く →［残す］で戻る、と同じ形）。覚えを欄の中に
// 持っていた版では、付け直したあとの ON → OFF で打った色が塗られている色に戻っていた。

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature, type Feature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';

import { BasicInfoForm } from './BasicInfoForm';
import type { PropertyEditValues } from './contracts';
import { valuesFromFeature } from './edit-intent';

afterEach(cleanup);

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

/** 素性欄の代わりの親を外から動かす口。 */
let api: {
  setMounted: (v: boolean) => void;
  resetDraft: () => void;
  draft: () => PropertyEditValues;
} | null = null;

/** 素性欄の代わり: 下書きと「1 度 OFF にしたか」を持ち、フォームを外したり付けたりできる。 */
function Host(props: { readonly feature: Feature }): JSX.Element {
  const baseline = valuesFromFeature(props.feature);
  const [draft, setDraft] = useState<PropertyEditValues>(baseline);
  const [wentManual, setWentManual] = useState(false);
  const [mounted, setMounted] = useState(true);
  const mark = useCallback(() => setWentManual(true), []);
  api = {
    setMounted,
    resetDraft: () => {
      setDraft(baseline);
      setWentManual(false);
    },
    draft: () => draft,
  };
  return mounted ? (
    <BasicInfoForm
      feature={props.feature}
      editable
      values={draft}
      onChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
      autoColorWentManual={wentManual}
      onAutoColorWentManual={mark}
    />
  ) : (
    <p>外れている</p>
  );
}

const section = (): HTMLElement => screen.getByTestId('style-section');
const autoBox = (): HTMLInputElement =>
  within(section()).getByLabelText('自動配色を許可') as HTMLInputElement;
const fillPicker = (): HTMLInputElement =>
  within(section()).getByLabelText('通常表示色', { exact: true }) as HTMLInputElement;
const fillOpacity = (): HTMLInputElement =>
  within(section()).getByLabelText('通常表示色透過', { exact: true }) as HTMLInputElement;

describe('自動配色の往復（G-15）— 覚えは下書きと同じ場所に持つ', () => {
  it('保存済みが ON: OFF → 色と透過を打つ → 欄が外れて付き直る → ON → OFF でも、打った値が残る', () => {
    render(<Host feature={face(true)} />);
    // 初めての OFF: 地物にいま塗られている色が入る。
    fireEvent.click(autoBox());
    expect(api!.draft().fillColor).toBe('#aa5500');
    fireEvent.change(fillPicker(), { target: { value: '#123456' } });
    fireEvent.change(fillOpacity(), { target: { value: '0.3' } });

    // 選択を外す・居ない年へ動く →［残す］で戻る、と同じ: 欄だけが外れて付き直る。
    act(() => api!.setMounted(false));
    act(() => api!.setMounted(true));

    fireEvent.click(autoBox()); // ON
    fireEvent.click(autoBox()); // OFF
    expect(api!.draft().fillColor).toBe('#123456');
    expect(api!.draft().fillOpacity).toBe(0.3);
    expect(api!.draft().autoColorEnabled).toBe(false);
  });

  it('保存済みが OFF: 色を打つ → ON → OFF で、打った値が残る', () => {
    render(<Host feature={face(false)} />);
    fireEvent.change(fillPicker(), { target: { value: '#abcdef' } });
    fireEvent.click(autoBox()); // ON
    fireEvent.click(autoBox()); // OFF
    expect(api!.draft().fillColor).toBe('#abcdef');
  });

  it('下書きを作り直したら覚えも消え、次の OFF は「初めての OFF」として塗られている色を入れる', () => {
    render(<Host feature={face(true)} />);
    fireEvent.click(autoBox()); // OFF（覚える）
    act(() => api!.resetDraft()); // 捨てる・対象が変わる と同じ
    fireEvent.click(autoBox()); // 初めての OFF
    expect(api!.draft().fillColor).toBe('#aa5500');
    expect(api!.draft().fillOpacity).toBe(0.7);
  });
});
