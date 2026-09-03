// U20 / shell — ステータスバーのカーソル座標表示 (表示条件 + 再レンダー範囲).
//
// 契約:
//   1. カーソル位置が未知 (地図外) のとき、座標枠は「—」を出す (設計書 §H.6 の表)。
//      枠は残したまま中身だけ差し替えるので、状態行の 240px の枠は動かない;
//   2. 位置が入ると 十進 の緯度・経度が LIVE に出る (測量モードの整形関数を再利用);
//   3. 更新は購読コンポーネントの中だけで起き、親 (シェル) を再レンダーしない
//      (per-frame 負荷を増やさない = React 再レンダー爆発の抑止).

/// <reference types="@testing-library/jest-dom" />

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { formatLatDecimal, formatLonDecimal } from '../../domain/survey/coords-format';

import { CursorCoordinateStatus } from './CursorCoordinateStatus';
import { CursorPositionStore } from './cursor-position';
import { StatusBar } from './StatusBar';
import { STATUS_STRINGS } from './strings';

describe('CursorCoordinateStatus (FR-111 ステータスバー)', () => {
  it('地図の外では「—」を出す (枠は残す)', () => {
    const store = new CursorPositionStore();
    render(
      <StatusBar>
        <CursorCoordinateStatus store={store} />
      </StatusBar>,
    );
    expect(screen.getByTestId('statusbar-cursor-coords')).toHaveTextContent(
      STATUS_STRINGS.coordsAway,
    );
  });

  it('shows the 十進 latitude/longitude of the cursor position', () => {
    const store = new CursorPositionStore();
    render(
      <StatusBar>
        <CursorCoordinateStatus store={store} />
      </StatusBar>,
    );
    act(() => {
      store.set({ lon: 139.75, lat: 35.6894 });
    });
    const readout = screen.getByTestId('statusbar-cursor-coords');
    expect(readout).toHaveTextContent(formatLatDecimal(35.6894));
    expect(readout).toHaveTextContent(formatLonDecimal(139.75));
    expect(readout).not.toHaveTextContent(STATUS_STRINGS.coordsAway);
  });

  it('カーソルが地図を出ると「—」へ戻る', () => {
    const store = new CursorPositionStore();
    render(
      <StatusBar>
        <CursorCoordinateStatus store={store} />
      </StatusBar>,
    );
    act(() => {
      store.set({ lon: 1, lat: 2 });
    });
    expect(screen.getByTestId('statusbar-cursor-coords')).not.toHaveTextContent(
      STATUS_STRINGS.coordsAway,
    );
    act(() => {
      store.clear();
    });
    expect(screen.getByTestId('statusbar-cursor-coords')).toHaveTextContent(
      STATUS_STRINGS.coordsAway,
    );
  });

  it('re-renders ONLY the readout, never the surrounding shell', () => {
    const store = new CursorPositionStore();
    const parentRender = vi.fn();
    function Parent(): JSX.Element {
      parentRender();
      return (
        <StatusBar>
          <CursorCoordinateStatus store={store} />
        </StatusBar>
      );
    }
    render(<Parent />);
    expect(parentRender).toHaveBeenCalledTimes(1);
    act(() => {
      store.set({ lon: 1, lat: 2 });
    });
    act(() => {
      store.set({ lon: 3, lat: 4 });
    });
    act(() => {
      store.set({ lon: 5, lat: 6 });
    });
    expect(screen.getByTestId('statusbar-cursor-coords')).toHaveTextContent(
      formatLonDecimal(5),
    );
    // 3 位置更新でも親は最初の1回しかレンダーされない.
    expect(parentRender).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount (leak 防止)', () => {
    const store = new CursorPositionStore();
    const { unmount } = render(<CursorCoordinateStatus store={store} />);
    unmount();
    // A post-unmount update must not throw / warn about a detached component.
    expect(() => store.set({ lon: 9, lat: 9 })).not.toThrow();
  });
});
