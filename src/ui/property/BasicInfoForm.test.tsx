// 素性欄のフォームが「渡された値を映して、打鍵を親へ返すだけ」の入れ物であることを固定する。
//
// **下書きの作り直しは増分 2 で PropertyPanel へ移った。** 以前このファイルは、フォーム自身が
// 下書きを持っていた前提で A9（取り消しで素性欄がドメインへ追従する）を見ていたが、いまその
// 責任はパネルにある。したがって **A9 の検査は `PropertyPanel.test.tsx` と
// `e2e/property-sync.spec.ts` が持つ**（同じことを 2 か所で見ない）。
//
// ここで固定するのは、このフォームが **制御された（親が値を持つ）フォーム** であること
// そのものである。理由は 2 つ。
//   1. 保存列は素性欄の下端に 1 本だけ置くと決めた（N-46）。ボタンがフォームの外に出る以上、
//      下書きは親が持つしかない。
//   2. 保存の対象は名前・種別ラベル・見た目・詳細文書の 4 つで、詳細文書は別のセクションが
//      映している。値を親に 1 つ持たせないと、4 つを 1 回の押下で確定できない。
//
// 併せて、初期表示に何を出すか（＝出さないか）も固定する。開始年・終了年は地物がいつ現れて
// いつ消えるかを一切動かさない飾りの属性なので、畳んだ「詳しい属性」の中へ下ろした（裁定
// §N-5 の (A)）。本物の存続期間は錨の並びから出す 1 行のほうである。

/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createPointFeature, withKindLabel, type Feature } from '../../domain/feature';
import { asFeatureId, asVertexId } from '../../domain/ids';

import { BasicInfoForm } from './BasicInfoForm';
import type { PropertyEditValues } from './contracts';
import { valuesFromFeature } from './edit-intent';
import { PROPERTY_STRINGS } from './messages';

afterEach(cleanup);

const color = createColorInfo(true, '#111111', '#222222', '#333333');
const fA = asFeatureId('A');
const vA1 = asVertexId('A-v1');

function featureA(): Feature {
  return withKindLabel(
    createPointFeature(fA, createBasicAttributes('織田領', 1560, 1582), color, vA1),
    '国',
  );
}

/** 確定済みの姿から起こした値（親が下書きの種にするのと同じ経路）。 */
const committedValues: PropertyEditValues = valuesFromFeature(featureA());

interface RenderOptions {
  readonly values?: PropertyEditValues;
  readonly editable?: boolean;
  readonly onChange?: (next: Partial<PropertyEditValues>) => void;
  readonly existenceLabel?: string;
}

function renderForm(options: RenderOptions = {}): {
  onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  render(
    <BasicInfoForm
      feature={featureA()}
      editable={options.editable ?? true}
      values={options.values ?? committedValues}
      onChange={options.onChange ?? onChange}
      {...(options.existenceLabel !== undefined
        ? { existenceLabel: options.existenceLabel }
        : {})}
    />,
  );
  return { onChange };
}

const nameInput = (): HTMLInputElement =>
  screen.getByLabelText(PROPERTY_STRINGS.nameLabel) as HTMLInputElement;
const kindInput = (): HTMLInputElement =>
  screen.getByLabelText(PROPERTY_STRINGS.kindLabelLabel) as HTMLInputElement;
const borderInput = (): HTMLInputElement =>
  screen.getByLabelText(PROPERTY_STRINGS.borderColorLabel) as HTMLInputElement;

describe('素性欄のフォームは親が持つ値を映すだけ（制御されたフォーム）', () => {
  it('入力欄に出るのは渡された値であって、地物そのものではない', () => {
    // 地物は「織田領 / 国 / #333333」のまま、渡す値だけを別のものにする。
    // 画面が地物を直接読んでいたら、ここで食い違いが出る。
    renderForm({
      values: {
        ...committedValues,
        name: '羽柴領',
        kindLabel: '城',
        borderColor: '#abcdef',
      },
    });
    expect(nameInput().value).toBe('羽柴領');
    expect(kindInput().value).toBe('城');
    expect(borderInput().value).toBe('#abcdef');
  });

  it('名前を打つと「名前だけ」を親へ返し、値を渡し直さない限り画面は変わらない', () => {
    const { onChange } = renderForm();
    fireEvent.change(nameInput(), { target: { value: '羽柴領' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ name: '羽柴領' });
    // 親が値を渡し直していないので、入力欄は元のまま。**自分では覚えない**ことが
    // 「制御されている」ということである（覚えていたら親の下書きと二重になる）。
    expect(nameInput().value).toBe('織田領');
  });

  it('種別を打つと「種別だけ」を親へ返す（名前と同じ扱い）', () => {
    const { onChange } = renderForm();
    fireEvent.change(kindInput(), { target: { value: '城' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kindLabel: '城' });
    expect(kindInput().value).toBe('国');
  });
});

describe('素性欄のフォームの表示モード（読むだけのとき）', () => {
  it('読むだけのときは断りが出て、入力欄はひとつ残らず押せない', () => {
    renderForm({ editable: false });

    expect(screen.getByTestId('view-only-notice')).toBeInTheDocument();
    const fields = screen
      .getByTestId('basic-info')
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input, select, textarea',
      );
    // 部品ごとに判定を書いていると、ここで 1 つだけ生き残る（教訓 5.13）。
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toBeDisabled();
    }
  });

  it('編集できるときは断りを出さない', () => {
    renderForm({ editable: true });
    expect(screen.queryByTestId('view-only-notice')).toBeNull();
  });
});

describe('初期表示に何を出すか（裁定 §N-5 の (A)）', () => {
  it('開始年・終了年は畳んだ「詳しい属性」の中にあり、初めから開いてはいない', () => {
    renderForm();

    const advanced = screen.getByTestId('basic-info-advanced') as HTMLDetailsElement;
    // 畳める入れ物そのものであること（見出しだけ別に作って中身は出しっぱなし、を防ぐ）。
    expect(advanced.tagName).toBe('DETAILS');
    expect(advanced.open).toBe(false);

    // 値は捨てていない（U-28: 詳細パネルには全属性を出す）。畳んだ中にある。
    const start = screen.getByLabelText(PROPERTY_STRINGS.startYearLabel);
    const end = screen.getByLabelText(PROPERTY_STRINGS.endYearLabel);
    expect(advanced).toContainElement(start);
    expect(advanced).toContainElement(end);
  });

  it('本物の存続期間は 1 行として出る（渡されたときだけ）', () => {
    renderForm({ existenceLabel: '0年 → 継続中' });
    expect(screen.getByTestId('existence-row')).toBeInTheDocument();
    expect(screen.getByTestId('existence-value')).toHaveTextContent('0年 → 継続中');
  });

  it('存続期間が解けないときは行ごと出ない（読めない値を捏造しない）', () => {
    renderForm();
    expect(screen.queryByTestId('existence-row')).toBeNull();
    expect(screen.queryByTestId('existence-value')).toBeNull();
  });
});
