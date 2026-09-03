// 素性欄のフォームが「ドメインが動いたら追従する」ことを固定する（A9）。
//
// **取り消し（Ctrl+Z）のあとも古い名前が残っていた。** フォームの下書きは 地物 id と
// 錨 id が変わったときだけ作り直していたので、取り消し・やり直し・外部からのドメイン
// 差し替えのように「id はそのままで中身だけ巻き戻る」変化に追従できなかった。その状態で
// もう一度保存すると、**取り消したはずの名前が復活する**（実機で確認）。
//
// 同時に、U32 の初期不具合（親が等しい別オブジェクトを作り直すたびに打鍵が消える）が
// 再発しないことも見る。両方向を 1 本のファイルで見るのは、片方だけ直すと必ずもう片方が
// 壊れる関係にあるからである。

/// <reference types="@testing-library/jest-dom" />

import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import { createPointFeature, type Feature } from '../../domain/feature';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { asAnchorId, asFeatureId, asVertexId } from '../../domain/ids';
import { timePointYear } from '../../domain/time/time-point';

import { BasicInfoForm } from './BasicInfoForm';

afterEach(cleanup);

const color = createColorInfo(true, '#111111', '#222222', '#333333');
const fA = asFeatureId('A');
const vA1 = asVertexId('A-v1');
const anchor = asAnchorId('A-a1');
const editTime = timePointYear(1560);

function featureNamed(name: string): Feature {
  return createPointFeature(fA, createBasicAttributes(name, 1560, 1582), color, vA1);
}

describe('BasicInfoForm の下書きは「ドメインが動いたら」同期する（A9）', () => {
  function renderForm(name: string, onSave: (v: unknown, t: unknown) => string | null) {
    return render(
      <BasicInfoForm
        feature={featureNamed(name)}
        editable
        editTime={editTime}
        anchorId={anchor}
        onSave={onSave as never}
      />,
    );
  }

  it('取り消しで名前が巻き戻ったら、フォームもその名前になる', () => {
    const onSave = vi.fn(() => null);
    const view = renderForm('織田領', onSave);
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '尾張国' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledTimes(1);

    // 確定した状態が親から戻ってくる（フォームは変わらない）。
    view.rerender(
      <BasicInfoForm
        feature={featureNamed('尾張国')}
        editable
        editTime={editTime}
        anchorId={anchor}
        onSave={onSave as never}
      />,
    );
    expect((screen.getByLabelText('名前') as HTMLInputElement).value).toBe('尾張国');

    // Ctrl+Z 相当: 地物 id も錨 id も同じまま、中身だけが元へ戻る。
    // **以前はここでフォームが「尾張国」のまま取り残されていた。**
    view.rerender(
      <BasicInfoForm
        feature={featureNamed('織田領')}
        editable
        editTime={editTime}
        anchorId={anchor}
        onSave={onSave as never}
      />,
    );
    expect((screen.getByLabelText('名前') as HTMLInputElement).value).toBe('織田領');
  });

  it('取り消したあとに保存しても、取り消した名前は復活しない', () => {
    const onSave = vi.fn(() => null);
    const view = renderForm('織田領', onSave);
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '尾張国' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    onSave.mockClear();

    view.rerender(
      <BasicInfoForm
        feature={featureNamed('尾張国')}
        editable
        editTime={editTime}
        anchorId={anchor}
        onSave={onSave as never}
      />,
    );
    view.rerender(
      <BasicInfoForm
        feature={featureNamed('織田領')}
        editable
        editTime={editTime}
        anchorId={anchor}
        onSave={onSave as never}
      />,
    );

    // ここでもう一度「保存」を押しても、下書きは巻き戻った値と同じなので何も起きない
    // （教訓 5.24 の no-op ガード）。**以前は「尾張国」が復活していた。**
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('中身が同じなら、親が別オブジェクトを作り直しても打鍵は消えない（U32 の初期不具合）', () => {
    const onSave = vi.fn(() => null);
    const view = renderForm('織田領', onSave);
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '尾張国' } });
    // 同じ値の **別インスタンス** を渡し直す（選択の再解決で毎回起きる）。
    view.rerender(
      <BasicInfoForm
        feature={featureNamed('織田領')}
        editable
        editTime={editTime}
        anchorId={anchor}
        onSave={onSave as never}
      />,
    );
    expect((screen.getByLabelText('名前') as HTMLInputElement).value).toBe('尾張国');
  });
});
