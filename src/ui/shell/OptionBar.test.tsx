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

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OptionBar } from './OptionBar';
import { OptionBarStore } from './option-bar';
import { OPTION_BAR_STRINGS } from './strings';

/**
 * 設定欄の畳み「≫」を jsdom で試すための **寸法の差し込み**（手直し D3）。
 *
 * jsdom はレイアウトを計算しないので幅は全部 0 になる（開発ガイド §5.49）。ここで
 * 固定したいのは「**測った結果をどう畳むか**」という判断そのものなので、測る側を
 * 差し替えて数字を与える。**「入るかどうか」を jsdom の実測で見ているわけではない**
 * （それは E2E の担当で、`e2e/inc5-shell.spec.ts` が 5 段の窓幅で見る）。
 */
function stubWidths(opts: { bar: number; slot: number; button: number }): () => void {
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  const rect = Element.prototype.getBoundingClientRect;

  // **測るのは帯そのものの内寸**である（設定欄の幅は中身で動くので、そこを測ると
  // 「送る → 器が縮む → もっと送る」の輪になる＝`settingsBudget` の注記）。
  const widthOf = (el: Element): number => {
    if (el.classList.contains('option-bar')) return opts.bar;
    if (el.hasAttribute('data-slot-id')) return opts.slot;
    if (el.classList.contains('option-bar__overflow-button')) return opts.button;
    return 0;
  };

  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return widthOf(this);
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const width = widthOf(this);
    return {
      x: 0,
      y: 0,
      width,
      height: 0,
      top: 0,
      right: width,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  return () => {
    if (clientWidth !== undefined) {
      Object.defineProperty(Element.prototype, 'clientWidth', clientWidth);
    }
    Element.prototype.getBoundingClientRect = rect;
  };
}

let restoreWidths: (() => void) | null = null;
afterEach(() => {
  restoreWidths?.();
  restoreWidths = null;
});

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

// --- 設定欄の畳み「≫」（手直し D3 / 設計書 §B.4）-------------------------------
describe('OptionBar — 設定欄の畳み「≫」', () => {
  function withSlots(store: OptionBarStore, ids: readonly string[]): void {
    act(() => {
      for (const id of ids) {
        store.registerOptionSlot(
          id,
          <button type="button">{id} ▾</button>,
        );
      }
    });
  }

  it('幅が測れないときは全部そのまま出す（「≫」を出さない）', () => {
    // **jsdom は幅が全部 0 になる。0 は「まだ分からない」であって「狭い」ではない**
    // ―― ここを取り違えると、単体テストの世界で部品が全部「≫」の中へ消える
    // （既存のテストが軒並み「部品が無い」で落ちる形になる＝開発ガイド §5.49 の裏面）。
    const store = new OptionBarStore();
    render(<OptionBar store={store} />);
    withSlots(store, ['snap', 'depth', 'display']);

    for (const id of ['snap', 'depth', 'display']) {
      expect(screen.getByTestId(`option-slot-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('option-bar-overflow')).not.toBeInTheDocument();
  });

  it('入り切らないぶんが「≫」へ送られ、開くと同じ testid のまま押せる', () => {
    // 帯の内寸 260px から「次の一手」に残す 160px を引いて、設定欄の予算は 100px。
    // 部品は 60px ずつ、「≫」は 30px。前から詰めると 30 ＋ 6 ＋ 60 = 96 で 1 個しか
    // 入らない（2 個目は 162px で入らない）。
    restoreWidths = stubWidths({ bar: 260, slot: 60, button: 30 });
    const store = new OptionBarStore();
    render(<OptionBar store={store} />);
    withSlots(store, ['snap', 'depth', 'display']);

    const overflow = screen.getByTestId('option-bar-overflow');
    expect(overflow).toBeInTheDocument();
    expect(overflow).toHaveAttribute('aria-expanded', 'false');

    // 帯（設定欄）に残るのは先頭の 1 個だけ。残りは「≫」の中へ移る。
    const settings = screen.getByTestId('option-bar-settings');
    const panel = screen.getByTestId('option-bar-overflow-panel');
    expect(settings).toContainElement(screen.getByTestId('option-slot-snap'));
    expect(settings).not.toContainElement(screen.getByTestId('option-slot-depth'));
    expect(settings).not.toContainElement(screen.getByTestId('option-slot-display'));
    // **閉じているあいだは要素を残したまま `hidden` で閉じる**（`OptionPopover` と同じ
    // 作法。開くたびに矩形の計算をやり直さないため）。`[hidden]` の打ち消しを CSS に
    // 併記してあることは `shell-layout.test.ts` が別に見ている（教訓 5.56）。
    expect(panel).toHaveAttribute('hidden');

    fireEvent.click(overflow);
    expect(overflow).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('hidden');
    // **testid は変わらない**（T-1: 置き場が変わっても役割は同じ）。
    expect(panel).toContainElement(screen.getByTestId('option-slot-depth'));
    expect(panel).toContainElement(screen.getByTestId('option-slot-display'));
  });

  it('Escape で閉じ、そこで止める（大域の Escape と同時に走らない）', () => {
    restoreWidths = stubWidths({ bar: 260, slot: 60, button: 30 });
    const global = vi.fn();
    window.addEventListener('keydown', global);
    try {
      const store = new OptionBarStore();
      render(<OptionBar store={store} />);
      withSlots(store, ['snap', 'depth', 'display']);
      fireEvent.click(screen.getByTestId('option-bar-overflow'));

      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(screen.getByTestId('option-bar-overflow-panel')).toHaveAttribute('hidden');
      expect(global, '「≫」を閉じる Escape が大域まで抜けた').not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', global);
    }
  });

  it('開閉が onOverflowOpenChange で外へ伝わる', () => {
    restoreWidths = stubWidths({ bar: 260, slot: 60, button: 30 });
    const onOverflowOpenChange = vi.fn();
    const store = new OptionBarStore();
    render(<OptionBar store={store} onOverflowOpenChange={onOverflowOpenChange} />);
    expect(onOverflowOpenChange).toHaveBeenLastCalledWith(false);

    withSlots(store, ['snap', 'depth', 'display']);
    fireEvent.click(screen.getByTestId('option-bar-overflow'));
    expect(onOverflowOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('option-bar-overflow'));
    expect(onOverflowOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('全部入る幅なら「≫」は出ない', () => {
    // 帯の内寸 560px − 「次の一手」に残す 160px ＝ 予算 400px。部品 3 個（60px ずつ）は
    // すき間を入れても 192px なので全部入る。
    restoreWidths = stubWidths({ bar: 560, slot: 60, button: 30 });
    const store = new OptionBarStore();
    render(<OptionBar store={store} />);
    withSlots(store, ['snap', 'depth', 'display']);

    expect(screen.queryByTestId('option-bar-overflow')).not.toBeInTheDocument();
    for (const id of ['snap', 'depth', 'display']) {
      expect(screen.getByTestId(`option-slot-${id}`)).toBeInTheDocument();
    }
  });
});
