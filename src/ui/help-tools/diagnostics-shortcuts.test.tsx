// N-34（診断ログの表示側が未結線）と N-35（ショートカット一覧の重複）の直しを固定する。
//
// どちらも「実装は動いているのに画面に届いていない／読めない」型で、直したあと**元へ戻り
// やすい**（片方は結線を 1 本外すだけ、片方は表示の畳みを外すだけで再発する）。

/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { StoreApi } from 'zustand/vanilla';

import { createSessionStore, type SessionStore } from '../state/store';
import { CommandRegistry, COMMAND_ID, MENU_ITEM_LABELS } from '../shell/index';
import { buildEmptyProject } from '../file-ops/index';
import { DiagnosticLogger, LOG_LEVEL, DIAGNOSTICS_STRINGS } from '../discovery/index';
import type { DomainProject } from '../../domain/persistence/index';

import { HelpToolsController } from './HelpToolsController';

afterEach(() => cleanup());

function makeStore(): StoreApi<SessionStore<DomainProject>> {
  return createSessionStore<DomainProject>({ initialDomain: buildEmptyProject() });
}

function openDiagnostics(logger?: DiagnosticLogger): void {
  const registry = new CommandRegistry();
  render(
    <HelpToolsController
      store={makeStore()}
      registry={registry}
      {...(logger === undefined ? {} : { logger })}
    />,
  );
  act(() => {
    registry.dispatch(COMMAND_ID.HelpDiagnostics);
  });
}

describe('N-34 — 診断情報のエラーログ欄が実際のログを出す（G-19 の表示側）', () => {
  it('記録済みのエラーが本文・種別・文脈つきで出る', () => {
    const logger = new DiagnosticLogger();
    logger.log(LOG_LEVEL.Error, '地図の描画に失敗しました', {
      contextTime: '1500年',
      summary: '面の確定',
      cause: 'TypeError: x is not a function',
    });

    openDiagnostics(logger);

    expect(screen.queryByTestId('diagnostics-empty-log')).not.toBeInTheDocument();
    const entries = screen.getAllByTestId('diagnostics-log-entry');
    expect(entries).toHaveLength(1);
    expect(screen.getByTestId('diagnostics-log-message')).toHaveTextContent(
      '地図の描画に失敗しました',
    );
    // U-1: 種別は内部の英語値ではなく日本語で出す。
    expect(screen.getByTestId('diagnostics-log-level')).toHaveTextContent('エラー');
    // 教訓 5.15: 実時間だけでも作中時刻だけでも「いつ何をしていて起きたか」は復元できない。
    expect(entries[0]!).toHaveTextContent('1500年');
    expect(screen.getByTestId('diagnostics-log-cause')).toHaveTextContent('TypeError');
  });

  it('新しい順に並ぶ（直近のエラーがいちばん上）', () => {
    const logger = new DiagnosticLogger();
    logger.log(LOG_LEVEL.Warning, '古い方');
    logger.log(LOG_LEVEL.Error, '新しい方');

    openDiagnostics(logger);

    const messages = screen.getAllByTestId('diagnostics-log-message');
    expect(messages[0]).toHaveTextContent('新しい方');
    expect(messages[1]).toHaveTextContent('古い方');
  });

  it('ログが 1 件も無ければ従来どおり空文言（嘘の件数を出さない）', () => {
    openDiagnostics(new DiagnosticLogger());
    expect(screen.getByTestId('diagnostics-empty-log')).toHaveTextContent(
      DIAGNOSTICS_STRINGS.emptyLog,
    );
  });

  it('ロガーが渡されていなければ空文言のまま（honest stub）', () => {
    openDiagnostics();
    expect(screen.getByTestId('diagnostics-empty-log')).toBeInTheDocument();
  });
});

describe('N-35 — ショートカット一覧の「拡大」4 行の重複を畳む', () => {
  it('同じ表示になる打鍵は 1 行にまとまる（拡大は 2 行）', () => {
    const registry = new CommandRegistry();
    render(<HelpToolsController store={makeStore()} registry={registry} platform="other" />);
    act(() => {
      registry.dispatch(COMMAND_ID.HelpShortcuts);
    });

    const zoomInLabel = MENU_ITEM_LABELS[COMMAND_ID.ViewZoomIn];
    const rows = screen
      .getAllByTestId('shortcuts-panel-row')
      .filter((row) => (row.textContent ?? '').startsWith(zoomInLabel));

    // dispatch 側には 4 通り登録されている（US 配列と JIS 配列の両方で Ctrl++ を受けるため
    // `=` と `+` × Shift の有無）が、表示では `=` も `+` も「+」になるので 2 通りしかない。
    expect(rows).toHaveLength(2);
    const shown = rows.map((row) => row.querySelector('td:last-child')?.textContent ?? '');
    expect(new Set(shown).size).toBe(2);
  });

  it('別の打鍵に見える別名は残る（やり直しの Ctrl+Y と Ctrl+Shift+Z）', () => {
    // 畳むのは「表示が同じ行」だけで、本当に違う打鍵は落とさない（HB-10 の別名は仕様）。
    const registry = new CommandRegistry();
    render(<HelpToolsController store={makeStore()} registry={registry} platform="other" />);
    act(() => {
      registry.dispatch(COMMAND_ID.HelpShortcuts);
    });

    const redoLabel = MENU_ITEM_LABELS[COMMAND_ID.EditRedo];
    const rows = screen
      .getAllByTestId('shortcuts-panel-row')
      .filter((row) => (row.textContent ?? '').startsWith(redoLabel));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const shown = rows.map((row) => row.querySelector('td:last-child')?.textContent ?? '');
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('どの行の打鍵も、同じコマンドの中で重複しない', () => {
    const registry = new CommandRegistry();
    render(<HelpToolsController store={makeStore()} registry={registry} platform="other" />);
    act(() => {
      registry.dispatch(COMMAND_ID.HelpShortcuts);
    });

    const seen = new Set<string>();
    for (const row of screen.getAllByTestId('shortcuts-panel-row')) {
      const key = row.textContent ?? '';
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
