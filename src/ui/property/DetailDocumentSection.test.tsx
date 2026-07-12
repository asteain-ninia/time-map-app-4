// U32 詳細文書エディタ section tests (FR-98 後段): 閲覧/編集切替 + 明示保存 + WRITE
// ガード (超過拒否 / no-op) + 編集モード外は閲覧のみ.

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  MAX_DETAIL_DOCUMENT_LENGTH,
  createPointFeature,
  withDetailDocument,
} from '../../domain/index';
import { asAnchorId, asFeatureId, asVertexId } from '../../domain/ids';
import { timePointYear } from '../../domain/time/time-point';

import type { AssetResolver } from './contracts';
import { DetailDocumentSection } from './DetailDocumentSection';

const color = createColorInfo(true, '#111111', '#222222', '#333333');
const noAssets: AssetResolver = { resolveAsset: () => null };
const T = timePointYear(100);

function feat(id: string, doc?: string) {
  const base = createPointFeature(
    asFeatureId(id),
    createBasicAttributes('城', 1, 2),
    color,
    asVertexId(`${id}-v`),
  );
  return doc === undefined ? base : withDetailDocument(base, doc);
}

function renderSection(
  overrides: Partial<Parameters<typeof DetailDocumentSection>[0]> = {},
): { onSave: ReturnType<typeof vi.fn> } {
  const onSave = vi.fn().mockReturnValue(null);
  render(
    <DetailDocumentSection
      feature={overrides.feature ?? feat('F', '**太字**の文書')}
      editable={overrides.editable ?? true}
      editTime={'editTime' in overrides ? overrides.editTime! : T}
      anchorId={overrides.anchorId ?? asAnchorId('a1')}
      assetResolver={noAssets}
      onSave={(overrides.onSave as typeof onSave) ?? onSave}
    />,
  );
  return { onSave };
}

describe('DetailDocumentSection — 閲覧/編集切替と明示保存 (FR-98)', () => {
  it('編集モード外 (editable=false) は sanitized 閲覧のみ — textarea/保存/切替なし', () => {
    renderSection({ editable: false });
    // The sanitized preview renders (MarkdownView), nothing editable.
    expect(screen.getByTestId('markdown-view').innerHTML).toContain('<strong>太字</strong>');
    expect(screen.queryByTestId('detail-doc-textarea')).toBeNull();
    expect(screen.queryByTestId('detail-doc-save')).toBeNull();
    expect(screen.queryByTestId('detail-doc-mode-edit')).toBeNull();
  });

  it('editable: 既定は閲覧、編集トグルで textarea+保存が現れ、保存が onSave を呼ぶ', () => {
    const { onSave } = renderSection();
    // Default = 閲覧 (preview), no textarea yet.
    expect(screen.queryByTestId('detail-doc-textarea')).toBeNull();
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    const textarea = screen.getByTestId('detail-doc-textarea');
    expect(textarea).toHaveValue('**太字**の文書');
    fireEvent.change(textarea, { target: { value: '新しい文書' } });
    fireEvent.click(screen.getByTestId('detail-doc-save'));
    expect(onSave).toHaveBeenCalledWith('新しい文書', T);
    expect(screen.queryByTestId('detail-doc-message')).toBeNull(); // success: no message
  });

  it('閲覧トグルは未保存ドラフトを sanitized プレビューする（第二のレンダ経路なし）', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    fireEvent.change(screen.getByTestId('detail-doc-textarea'), {
      target: { value: '**下書き**' },
    });
    fireEvent.click(screen.getByTestId('detail-doc-mode-view'));
    expect(screen.getByTestId('markdown-view').innerHTML).toContain(
      '<strong>下書き</strong>',
    );
  });

  it('超過ドラフトは honest な日本語メッセージを出して dispatch しない (WRITE ガード)', () => {
    const { onSave } = renderSection();
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    fireEvent.change(screen.getByTestId('detail-doc-textarea'), {
      target: { value: 'x'.repeat(MAX_DETAIL_DOCUMENT_LENGTH + 1) },
    });
    fireEvent.click(screen.getByTestId('detail-doc-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('detail-doc-message').textContent).toContain(
      '詳細文書が長すぎるため保存できません',
    );
  });

  it('no-op 保存（ドラフト=現状）は dispatch せずメッセージも出さない (教訓 5.24)', () => {
    const { onSave } = renderSection();
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    fireEvent.click(screen.getByTestId('detail-doc-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByTestId('detail-doc-message')).toBeNull();
  });

  it('onSave のエラー文字列は保存メッセージとして表示され、×で閉じる (教訓 5.12)', () => {
    const onSave = vi.fn().mockReturnValue('保存に失敗しました: XYZ');
    renderSection({ onSave });
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    fireEvent.change(screen.getByTestId('detail-doc-textarea'), {
      target: { value: '別の文書' },
    });
    fireEvent.click(screen.getByTestId('detail-doc-save'));
    const msg = screen.getByTestId('detail-doc-message');
    expect(msg.textContent).toContain('保存に失敗しました: XYZ');
    fireEvent.click(msg.querySelector('button')!);
    expect(screen.queryByTestId('detail-doc-message')).toBeNull();
  });

  it('錨未選択 (editTime=null) の保存は honest に拒否する', () => {
    const { onSave } = renderSection({ editTime: null });
    fireEvent.click(screen.getByTestId('detail-doc-mode-edit'));
    fireEvent.change(screen.getByTestId('detail-doc-textarea'), {
      target: { value: '別の文書' },
    });
    fireEvent.click(screen.getByTestId('detail-doc-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('detail-doc-message').textContent).toContain(
      '編集対象の錨が選択されていません',
    );
  });

  it('空の文書は閲覧でプレースホルダを出す', () => {
    renderSection({ feature: feat('F'), editable: false });
    expect(screen.getByTestId('detail-doc-empty')).toBeInTheDocument();
  });
});
