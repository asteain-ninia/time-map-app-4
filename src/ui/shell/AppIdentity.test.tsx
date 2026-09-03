// アプリバーの素性表示（設計書 §H.6）の描画テスト。V12 の合格条件 ①ファイル名が常に見える
// ②未保存の印がある を、ここと status bar（③最終保存時刻）で分担して固定する。

/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppIdentity } from './AppIdentity';
import { APP_IDENTITY_STRINGS } from './strings';

describe('AppIdentity（設計書 §H.6）', () => {
  it('世界名とファイル名が常に見える', () => {
    render(
      <AppIdentity worldName="デーレ界" fileName="derle-world-2026-08-16.gimoza" dirty={false} />,
    );
    expect(screen.getByTestId('app-identity-world')).toHaveTextContent('デーレ界');
    expect(screen.getByTestId('app-identity-file')).toHaveTextContent(
      'derle-world-2026-08-16.gimoza',
    );
  });

  it('未保存のときだけ印が出る', () => {
    const { rerender } = render(
      <AppIdentity worldName="デーレ界" fileName="a.gimoza" dirty={false} />,
    );
    expect(screen.queryByTestId('app-identity-dirty')).not.toBeInTheDocument();

    rerender(<AppIdentity worldName="デーレ界" fileName="a.gimoza" dirty />);
    expect(screen.getByTestId('app-identity-dirty')).toBeInTheDocument();
    expect(screen.getByTestId('app-identity-dirty')).toHaveAttribute(
      'aria-label',
      APP_IDENTITY_STRINGS.dirtyTitle,
    );
  });

  it('保存先が決まっていない新規は「（未保存の新規）」と出す（空欄にしない）', () => {
    render(<AppIdentity worldName="デーレ界" fileName={null} dirty />);
    expect(screen.getByTestId('app-identity-file')).toHaveTextContent(
      APP_IDENTITY_STRINGS.unsavedNew,
    );
  });

  it('世界名が空なら世界名の段は出さない（空の区切りを見せない）', () => {
    render(<AppIdentity worldName="  " fileName="a.gimoza" dirty={false} />);
    expect(screen.queryByTestId('app-identity-world')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-identity-file')).toHaveTextContent('a.gimoza');
  });
});
