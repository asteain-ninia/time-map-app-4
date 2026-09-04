// U23 — 追加を確定したあとに出る「新規の姿」の素性欄（設計書 §C.2 の 27 / G-8）。
//
// **この 1 本が守っているもの**: 形を描き終えて素性欄が出た瞬間、**名前の欄に入力の
// 焦点が当たっている**こと（`AddPropertyForm.tsx` の名前欄に付いている `autoFocus`）。
//
// これは飾りではなく、追加の作業の流れの要である。追加は「形を描く → 名前を打つ →
// 保存」で 1 件なので、焦点が当たっていないと **毎回まず名前の欄を押しに行く**ことになり、
// 1 件ごとに操作が 1 つ増える。実データは 775 件あり、その分がそのまま積み上がる。
//
// `autoFocus` は 1 語なので、整理や書き換えのついでに黙って落ちやすい。落ちても画面は
// 何ごともなく出るし、他のどの検査も緑のままなので、**気づけるのはここだけ**にしておく。

/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AddPropertyForm } from './AddPropertyForm';

describe('AddPropertyForm（出たらすぐ名前を打ち始められる）', () => {
  it('素性欄が出た直後、名前の欄に焦点が当たっていて、そのまま打てる', async () => {
    const user = userEvent.setup();
    render(
      <AddPropertyForm
        showParent={false}
        parentCandidates={[]}
        defaultParentId={null}
        currentYear={1200}
        onChooseParent={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const name = screen.getByTestId('add-name');
    // 実際に焦点が当たっているところを見る（属性が書いてあることではなく）。
    expect(document.activeElement).toBe(name);

    // どこも押さずに打った文字が、そのまま名前の欄に入る＝これが守りたい流れ。
    await user.keyboard('バアカ・アルラーク国');
    expect(name).toHaveValue('バアカ・アルラーク国');
  });
});
