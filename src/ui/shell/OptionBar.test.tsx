// オプションバー（設計書 §C.4 / §B.4）の描画テスト。
//
// この増分で作るのは **器と API だけ** なので、テストも器の性質だけを固定する。
//  - 5 区画が常に存在する（対象が 0 件でも、確定の要らない道具でも枠は消えない ＝ K-3）。
//  - 道具が押し込んだ内容が出る（4 本の API のそれぞれ）。
//  - 確定ボタンが押せる／無効にできる。
//
// **寸法そのものは CSS 側の契約テスト（option-bar-layout.test.ts）で固定する。** jsdom は
// レイアウトを持たず `getBoundingClientRect()` が常に 0 を返すので、ここで px を測ると
// 「常に緑のテスト」になる（設計書 §O の B-13 が指摘した失敗の型そのもの）。

/// <reference types="@testing-library/jest-dom" />

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OptionBar } from './OptionBar';
import { OptionBarStore } from './option-bar';
import { OPTION_BAR_STRINGS } from './strings';

describe('OptionBar — 5 区画の器（K-3）', () => {
  it('何も押し込まれていなくても 5 区画が全部ある', () => {
    render(<OptionBar store={new OptionBarStore()} />);
    expect(screen.getByTestId('option-bar')).toBeInTheDocument();
    expect(screen.getByTestId('option-bar-tool')).toBeInTheDocument();
    expect(screen.getByTestId('option-bar-target')).toBeInTheDocument();
    expect(screen.getByTestId('option-bar-next-step')).toBeInTheDocument();
    expect(screen.getByTestId('option-bar-settings')).toBeInTheDocument();
    // 確定欄は「確定の要らない道具」のとき空だが、枠そのものは残る（設計書 §B.4）。
    expect(screen.getByTestId('option-bar-commit')).toBeInTheDocument();
    expect(screen.getByTestId('option-bar-commit')).toBeEmptyDOMElement();
  });

  it('既定の文言が出る（「選ぶ」／「（選んでいません）」／案内文／「（設定なし）」）', () => {
    render(<OptionBar store={new OptionBarStore()} />);
    expect(screen.getByTestId('option-bar-tool')).toHaveTextContent(
      OPTION_BAR_STRINGS.defaultToolName,
    );
    expect(screen.getByTestId('option-bar-target')).toHaveTextContent(OPTION_BAR_STRINGS.noTarget);
    expect(screen.getByTestId('option-bar-next-step')).toHaveTextContent(
      OPTION_BAR_STRINGS.defaultNextStep,
    );
    expect(screen.getByTestId('option-bar-settings')).toHaveTextContent(
      OPTION_BAR_STRINGS.noSettings,
    );
  });

  it('段階表示は「手順 n/m」を持つ道具のときだけ出る（U-1: 内部語を出さない）', () => {
    const store = new OptionBarStore();
    render(<OptionBar store={store} />);
    expect(screen.queryByTestId('option-bar-stage')).not.toBeInTheDocument();

    act(() => store.setTarget('手順 2/3', '南ケナ州 → 親: ?'));
    expect(screen.getByTestId('option-bar-stage')).toHaveTextContent('手順 2/3');
    expect(screen.getByTestId('option-bar-target')).toHaveTextContent('南ケナ州 → 親: ?');
  });
});

describe('OptionBar — 道具が押し込んだ内容が出る', () => {
  it('4 本の API がそれぞれの区画へ反映される', () => {
    const store = new OptionBarStore();
    render(<OptionBar store={store} />);

    act(() => {
      store.setToolName('▱ 面を描く');
      store.setTarget(null, '頂点 4 個（未確定）');
      store.setNextStep('もう 1 点打つか、Enter で閉じます');
      store.setCommit([
        { id: 'commit', label: '閉じて確定', onClick: () => undefined },
        { id: 'cancel', label: 'やめる', onClick: () => undefined },
      ]);
    });

    expect(screen.getByTestId('option-bar-tool')).toHaveTextContent('▱ 面を描く');
    expect(screen.getByTestId('option-bar-target')).toHaveTextContent('頂点 4 個（未確定）');
    expect(screen.getByTestId('option-bar-next-step')).toHaveTextContent(
      'もう 1 点打つか、Enter で閉じます',
    );
    expect(screen.getByTestId('option-bar-commit-commit')).toHaveTextContent('閉じて確定');
    expect(screen.getByTestId('option-bar-commit-cancel')).toHaveTextContent('やめる');
  });

  it('確定ボタンが押せる／無効にできる', () => {
    const store = new OptionBarStore();
    const onClick = vi.fn();
    render(<OptionBar store={store} />);

    act(() => store.setCommit([{ id: 'commit', label: '点を確定', onClick }]));
    screen.getByTestId('option-bar-commit-commit').click();
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => store.setCommit([{ id: 'commit', label: '点を確定', onClick, disabled: true }]));
    expect(screen.getByTestId('option-bar-commit-commit')).toBeDisabled();
  });

  it('registerOptionSlot で設定欄に部品を差し込める', () => {
    const store = new OptionBarStore();
    render(<OptionBar store={store} />);

    let off = (): void => undefined;
    act(() => {
      off = store.registerOptionSlot('snap', <button type="button">吸着 ▾</button>);
    });
    expect(screen.getByTestId('option-slot-snap')).toHaveTextContent('吸着 ▾');
    expect(screen.getByTestId('option-bar-settings')).not.toHaveTextContent(
      OPTION_BAR_STRINGS.noSettings,
    );

    act(() => off());
    expect(screen.queryByTestId('option-slot-snap')).not.toBeInTheDocument();
    expect(screen.getByTestId('option-bar-settings')).toHaveTextContent(
      OPTION_BAR_STRINGS.noSettings,
    );
  });
});
