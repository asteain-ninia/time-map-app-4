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
    expect(screen.getByTestId('app-identity-dirty-slot')).toHaveAttribute(
      'aria-label',
      APP_IDENTITY_STRINGS.dirtyTitle,
    );
  });

  it('印の **枠** は付いていないときも残る（K-3 / B1: 印の出し入れで地図をずらさない）', () => {
    // **以前は要素ごと出し入れしていた。** 印が付いた瞬間に素性表示の占有幅が広がり、
    // 上部バーの折り返し段数が 1 つ増えて地図が 34px 飛んだ（窓幅 1340 / 1500 で実測）。
    // 幅は CSS が持つので、ここでは「枠の要素が両方の状態で在る」ことだけを見る
    // （寸法そのものは E2E の K-3 検査が実寸で見る＝開発ガイド §5.49 の二段構え）。
    const { rerender } = render(
      <AppIdentity worldName="デーレ界" fileName="a.gimoza" dirty={false} />,
    );
    const slot = screen.getByTestId('app-identity-dirty-slot');
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveAttribute('data-dirty', 'false');
    // 印そのものは無く、読み上げからも外れている。
    expect(slot).toHaveAttribute('aria-hidden', 'true');

    rerender(<AppIdentity worldName="デーレ界" fileName="a.gimoza" dirty />);
    expect(screen.getByTestId('app-identity-dirty-slot')).toHaveAttribute('data-dirty', 'true');
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

  it('世代から開いて保存先が未確定のときは、元の名前と「世代から復旧・保存先は未確定」を出す（増分 8D）', () => {
    const restoredFrom = {
      sourceName: 'w.gimoza',
      savedAtMs: new Date(2026, 9, 3, 14, 3).getTime(),
    };
    render(
      <AppIdentity worldName="デーレ界" fileName={null} dirty={false} restoredFrom={restoredFrom} />,
    );
    const file = screen.getByTestId('app-identity-file');
    expect(file).toHaveTextContent('w.gimoza（2026-10-03 14:03 の世代から復旧・保存先は未確定）');
    expect(file).toHaveAttribute('data-restored', 'true');
  });
});
