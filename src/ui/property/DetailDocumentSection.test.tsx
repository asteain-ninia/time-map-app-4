// 作業メモのセクションが「渡された下書きを映して、打鍵を親へ返すだけ」であることを固定する
// （FR-98）。作業メモはプレーンテキストで、書式・画像・文書内リンクを解釈しない。
//
// **保存ボタンはここから無くなった**（増分 2 / N-46）。以前は素性欄の中に「押さないと保存
// されない」場所が 2 つあり（基本情報の保存と、本文の別の保存）、しかも別々の取り消し
// 単位だった。名前と本文を続けて直すと、戻すのに 2 手かかる。保存の対象は素性欄の下端の
// **1 本の保存列**で確定するようにしたので、このセクションが持つのは入力欄だけである。
//
// したがって、ここから消えた責任は次のとおり（どれも押した先の PropertyPanel が持つ）。
//   - 長すぎる下書きの拒否 …… `planDetailDocumentEdit`（判定の単一の置き場, 教訓 5.29）
//   - 何も変わっていない保存を出さない判定
//   - 保存に失敗したときの言葉
// このファイルは **それらをここでやらないこと** も明示的に固定する。消えた責任が黙って
// 戻ってくると、保存の場所がまた 2 つに増えるからである。

/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  MAX_DETAIL_DOCUMENT_LENGTH,
  createPointFeature,
  withDetailDocument,
} from '../../domain/index';
import type { Feature } from '../../domain/feature';
import { asFeatureId, asVertexId } from '../../domain/ids';

import { DetailDocumentSection } from './DetailDocumentSection';
import { PROPERTY_STRINGS } from './messages';

afterEach(cleanup);

const color = createColorInfo(true, '#111111', '#222222', '#333333');

function feat(id: string, doc?: string): Feature {
  const base = createPointFeature(
    asFeatureId(id),
    createBasicAttributes('城', 1, 2),
    color,
    asVertexId(`${id}-v`),
  );
  return doc === undefined ? base : withDetailDocument(base, doc);
}

interface RenderOptions {
  readonly feature?: Feature;
  readonly editable?: boolean;
  /** 親が持っている下書き。省略時は確定済みの本文（＝パネルが種にするのと同じ値）。 */
  readonly draft?: string;
  readonly onDraftChange?: (next: string) => void;
}

function renderSection(options: RenderOptions = {}): {
  onDraftChange: ReturnType<typeof vi.fn>;
} {
  const feature = options.feature ?? feat('F', '**太字**の文書');
  const onDraftChange = vi.fn();
  render(
    <DetailDocumentSection
      feature={feature}
      editable={options.editable ?? true}
      draft={options.draft ?? feature.detailDocument ?? ''}
      onDraftChange={options.onDraftChange ?? onDraftChange}
    />,
  );
  return { onDraftChange };
}

describe('作業メモのセクション — プレーンテキスト (FR-98)', () => {
  it('読むだけのときは打った文字をそのまま出す（書式は解釈せず、書き込み欄も出さない）', () => {
    renderSection({ editable: false });
    const text = screen.getByTestId('detail-doc-text');
    expect(text).toHaveTextContent('**太字**の文書');
    expect(text.querySelector('strong')).toBeNull();
    expect(screen.queryByTestId('detail-doc-textarea')).toBeNull();
  });

  it('HTML の形をした文字も文字のまま出す（要素として挿入しない）', () => {
    const doc = '<img src=x onerror=alert(1)><a href="feature:F">リンク</a>';
    renderSection({ feature: feat('F', doc), editable: false });
    const text = screen.getByTestId('detail-doc-text');
    expect(text.textContent).toBe(doc);
    expect(text.querySelector('img')).toBeNull();
    expect(text.querySelector('a')).toBeNull();
  });

  it('編集できるときは初めから書き込み欄が出る（閲覧との切替は無い）', () => {
    renderSection();
    expect(screen.getByTestId('detail-doc-textarea')).toHaveValue('**太字**の文書');
    expect(screen.getByTestId('detail-doc-textarea')).toHaveAccessibleName(
      PROPERTY_STRINGS.detailDocTextareaLabel,
    );
    expect(screen.queryByTestId('detail-doc-mode-edit')).toBeNull();
    expect(screen.queryByTestId('detail-doc-mode-view')).toBeNull();
  });

  it('打った文字は親へ返すだけで、自分では覚えない（制御されている証）', () => {
    const { onDraftChange } = renderSection();
    fireEvent.change(screen.getByTestId('detail-doc-textarea'), {
      target: { value: '新しいメモ' },
    });

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledWith('新しいメモ');
    // 親が下書きを渡し直していないので、欄の中身は元のまま。
    expect(screen.getByTestId('detail-doc-textarea')).toHaveValue('**太字**の文書');
  });

  it('見出しは下書きの字数を添える', () => {
    renderSection({ draft: 'あいう' });
    expect(screen.getByTestId('detail-document-summary')).toHaveTextContent(
      PROPERTY_STRINGS.detailDocumentTitleWithLength(3),
    );
  });

  it('メモが無いときは読むだけの表示に「まだ書かれていない」印を出す', () => {
    renderSection({ feature: feat('F'), editable: false });
    expect(screen.getByTestId('detail-doc-empty')).toBeInTheDocument();
  });
});

describe('作業メモのセクションは保存の責任を持たない（N-46 で保存列へ移した）', () => {
  it('このセクションに保存ボタンは無く、下の保存列で確定すると案内する', () => {
    renderSection();

    // 「押さないと保存されない」場所が画面に 2 つある状態へ戻っていないこと。
    expect(screen.queryByTestId('detail-doc-save')).toBeNull();
    expect(
      screen.queryByRole('button', { name: PROPERTY_STRINGS.saveButton }),
    ).toBeNull();
    // 代わりに、どこで確定するのかを書いておく（黙って消さない）。
    expect(screen.getByTestId('detail-doc-save-hint')).toHaveTextContent(
      PROPERTY_STRINGS.detailDocSaveHint,
    );
  });

  it('長すぎる下書きでも、ここでは拒否もメッセージも出さない（判定は保存経路が持つ）', () => {
    const { onDraftChange } = renderSection();
    const tooLong = 'x'.repeat(MAX_DETAIL_DOCUMENT_LENGTH + 1);
    fireEvent.change(screen.getByTestId('detail-doc-textarea'), {
      target: { value: tooLong },
    });

    // 打鍵は素通しで親へ渡る。上限の判定は planDetailDocumentEdit ひとつだけが持ち、
    // 押した瞬間に保存列のメッセージとして出る（二重に判定を書かない、教訓 5.29）。
    expect(onDraftChange).toHaveBeenCalledWith(tooLong);
    expect(screen.queryByTestId('detail-doc-message')).toBeNull();
  });
});
