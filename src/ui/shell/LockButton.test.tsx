// 鍵のボタン（設計書 §C.1 の 4 / §H.2）の単体テスト。増分 5 の手直し D1 で、
// レールの一番上からアプリバーの 96px 枠へ引っ越した部品である。
//
// **寸法そのものはここでは測らない。** jsdom はレイアウトを計算せず矩形が常に 0 なので、
// px を測ると中身が何であっても一致して「永久に緑」になる（開発ガイド §5.49）。
// 枠が 96px であることは CSS の宣言を読む契約テスト（`shell-layout.test.ts`）が、
// 文字が切れずに収まることは E2E（`e2e/inc5-shell.spec.ts`）が受け持つ。

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE, type EditMode } from '../state/session';
import type { StoreApi } from 'zustand/vanilla';

import { LockButton } from './LockButton';
import { LOCK_LABELS } from './strings';

type S = Record<string, never>;

function makeStore(mode: EditMode = EDIT_MODE.View): StoreApi<SessionStore<S>> {
  return createSessionStore<S>({ initialDomain: {}, initial: { mode } });
}

describe('LockButton（鍵 1 個）', () => {
  it('状態で文字が入れ替わり、押されている印は「閉じている」ときに立つ', () => {
    const store = makeStore(EDIT_MODE.View);
    render(<LockButton store={store} />);
    const btn = screen.getByTestId('mode-view');
    expect(btn).toHaveTextContent(LOCK_LABELS.locked);
    expect(btn).toHaveAttribute('aria-pressed', 'true');

    act(() => store.getState().setMode(EDIT_MODE.Edit));
    expect(btn).toHaveTextContent(LOCK_LABELS.unlocked);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('押すと読むだけ ⇄ 直せるを往復する（K-6 の唯一の判定点）', () => {
    const store = makeStore(EDIT_MODE.View);
    render(<LockButton store={store} />);
    const btn = screen.getByTestId('mode-view');

    fireEvent.click(btn);
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);

    fireEvent.click(btn);
    expect(store.getState().mode).toBe(EDIT_MODE.View);
    // 閉めると道具は外れる（設計書 §D.2）。
    expect(store.getState().activeTool).toBeNull();
  });

  it('ツールチップを一切持たない（設計書 §H.2 / U-9 / HB-16）', () => {
    render(<LockButton store={makeStore()} />);
    const btn = screen.getByTestId('mode-view');
    // 吹き出しの包みも…
    expect(btn.closest('.tooltip')).toBeNull();
    // …ネイティブの吹き出し（`title`）も付けない。増分 5b の実装には `title` が残って
    // いて、設計書 §H.2 とすれ違っていた（手直し D1 で外した）。
    expect(btn).not.toHaveAttribute('title');
  });
});
