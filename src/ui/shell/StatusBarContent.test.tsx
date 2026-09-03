// 状態行 5 枠の描画テスト（設計書 §C.8 / §H.6）。
//
// 「今どうなっているか」を映さず成功を一度も知らせない、が C6（件数では最多の根本原因）
// だった。ここで固定するのは **5 枠が常にあること** と、**それぞれが何を出すか**である。
// 寸法は shell.css の契約テスト（status-bar-layout.test.ts）が読む。

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '../state/store';
import { DEFAULT_PROJECT_SETTINGS } from '../state/settings';

import { StatusBar } from './StatusBar';
import { StatusBarContent } from './StatusBarContent';
import { CursorPositionStore } from './cursor-position';
import { StatusMessageStore } from './status-message';
import { STATUS_STRINGS } from './strings';

function makeStore(zoom = 940 / 360, equatorLengthKm = 42035) {
  return createSessionStore<Record<string, never>>({
    initialDomain: {},
    initial: {
      camera: { centerLon: 0, centerLat: 0, zoom, panX: 0, panY: 0 },
      projectSettings: { ...DEFAULT_PROJECT_SETTINGS, equatorLengthKm },
    },
  });
}

interface RenderOptions {
  readonly canUndo?: boolean;
  readonly lastLabel?: string | null;
  readonly lastSavedAtMs?: number | null;
  readonly autoSaveArmed?: boolean;
}

function renderStatus(opts: RenderOptions = {}) {
  const store = makeStore();
  const cursorStore = new CursorPositionStore();
  const messageStore = new StatusMessageStore();
  render(
    <StatusBar>
      <StatusBarContent
        store={store}
        cursorStore={cursorStore}
        messageStore={messageStore}
        undo={{ canUndo: opts.canUndo ?? false, lastLabel: opts.lastLabel ?? null }}
        lastSavedAtMs={opts.lastSavedAtMs ?? null}
        autoSaveArmed={opts.autoSaveArmed ?? true}
      />
    </StatusBar>,
  );
  return { store, cursorStore, messageStore };
}

describe('状態行の 5 枠（設計書 §C.8）', () => {
  it('5 枠が全部あり、中身が空でも枠は残る', () => {
    renderStatus();
    expect(screen.getByTestId('statusbar')).toBeInTheDocument();
    // 座標: 地図の外なので「—」（枠は残る）。
    expect(screen.getByTestId('statusbar-cursor-coords')).toHaveTextContent(
      STATUS_STRINGS.coordsAway,
    );
    expect(screen.getByTestId('statusbar-scale')).toBeInTheDocument();
    expect(screen.getByTestId('statusbar-result')).toHaveTextContent(STATUS_STRINGS.noResult);
    expect(screen.getByTestId('statusbar-undo')).toHaveTextContent(STATUS_STRINGS.undoUnavailable);
    expect(screen.getByTestId('statusbar-last-saved')).toHaveTextContent(
      STATUS_STRINGS.neverSaved,
    );
  });

  it('カーソルが地図に入ると座標が出る', () => {
    const { cursorStore } = renderStatus();
    act(() => cursorStore.set({ lon: 12.4, lat: 35.2 }));
    const coords = screen.getByTestId('statusbar-cursor-coords');
    expect(coords).not.toHaveTextContent(STATUS_STRINGS.coordsAway);
    expect(coords.textContent ?? '').toMatch(/35\./);
  });

  it('縮尺はズームと赤道長から導く（新しい真実源を作らない）', () => {
    const { store } = renderStatus();
    expect(screen.getByTestId('statusbar-scale')).toHaveTextContent('1:169,000,000');
    // 2 倍に拡大したら分母はおよそ半分。
    act(() => store.getState().setCamera({ ...store.getState().camera, zoom: (940 / 360) * 2 }));
    expect(screen.getByTestId('statusbar-scale')).toHaveTextContent('1:84,500,000');
  });
});

describe('直前の結果（設計書 §H.5 / 教訓 5.12）', () => {
  it('成功も失敗も同じ枠に出る', () => {
    const { messageStore } = renderStatus();
    act(() => messageStore.success('保存しました（a.gimoza）'));
    expect(screen.getByTestId('statusbar-result')).toHaveTextContent('保存しました（a.gimoza）');
    expect(screen.getByTestId('statusbar-result')).toHaveAttribute('data-tone', 'success');

    act(() => messageStore.failure('保存できませんでした。'));
    expect(screen.getByTestId('statusbar-result')).toHaveAttribute('data-tone', 'failure');
  });

  it('明示的に閉じたときだけ消える', () => {
    const { messageStore } = renderStatus();
    act(() => messageStore.success('保存しました（a.gimoza）'));
    fireEvent.click(screen.getByTestId('statusbar-result-dismiss'));
    expect(screen.getByTestId('statusbar-result')).toHaveTextContent(STATUS_STRINGS.noResult);
    expect(messageStore.get()).toBeNull();
  });
});

describe('元に戻す枠（設計書 §C.8）', () => {
  it('戻せないときは「不可」', () => {
    renderStatus({ canUndo: false });
    expect(screen.getByTestId('statusbar-undo')).toHaveTextContent(STATUS_STRINGS.undoUnavailable);
  });

  it('戻せて操作名も分かるときは「何が戻るか」まで出す', () => {
    renderStatus({ canUndo: true, lastLabel: '南ケナ州の改名' });
    expect(screen.getByTestId('statusbar-undo')).toHaveTextContent('元に戻せます: 南ケナ州の改名');
    expect(screen.getByTestId('statusbar-undo')).toHaveTextContent('Ctrl+Z');
  });

  it('操作名が取れないときは可否だけを出す', () => {
    renderStatus({ canUndo: true, lastLabel: null });
    expect(screen.getByTestId('statusbar-undo')).toHaveTextContent(STATUS_STRINGS.undoAvailable);
  });
});

describe('最終保存枠（設計書 §H.6 の表）', () => {
  it('まだ保存していなければ「未保存」', () => {
    renderStatus({ lastSavedAtMs: null });
    expect(screen.getByTestId('statusbar-last-saved')).toHaveTextContent(
      STATUS_STRINGS.neverSaved,
    );
  });

  it('保存できていれば時刻を出す', () => {
    renderStatus({ lastSavedAtMs: new Date(2026, 8, 3, 14, 3, 0).getTime() });
    expect(screen.getByTestId('statusbar-last-saved')).toHaveTextContent('最終保存 14:03');
  });

  it('自動保存が待機中なら、同じ枠に静かに断り書きが出る（A4-a）', () => {
    // **書いていないことを黙っていると**「5 分ごとに保存されているはず」という誤解の
    // まま作業が進む。自動保存は上書きする先を一度確認してから始まる。
    renderStatus({ lastSavedAtMs: null, autoSaveArmed: false });
    const frame = screen.getByTestId('statusbar-last-saved');
    expect(frame).toHaveTextContent(STATUS_STRINGS.neverSaved);
    expect(frame).toHaveTextContent(STATUS_STRINGS.autoSaveHold);
    expect(frame).toHaveAttribute('data-auto-save-armed', 'false');
    expect(frame).toHaveAttribute('title', STATUS_STRINGS.autoSaveHoldDetail);
  });

  it('自動保存が動ける状態なら断り書きは出ない', () => {
    renderStatus({ lastSavedAtMs: new Date(2026, 8, 3, 14, 3, 0).getTime() });
    const frame = screen.getByTestId('statusbar-last-saved');
    expect(frame).not.toHaveTextContent(STATUS_STRINGS.autoSaveHold);
    expect(frame).toHaveAttribute('data-auto-save-armed', 'true');
  });
});
