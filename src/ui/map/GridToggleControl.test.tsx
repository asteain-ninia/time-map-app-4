// FR-13 グリッド ON/OFF — the 上部バー グリッド表示 toggle (component operation test, jsdom).
//
// **このトグルは保存ファイルに書かない**（2026-09-04 の再修正）。書くのは
// セッション限りの上書き `gridVisibleOverride` だけで、`projectSettings.gridVisible`
// （＝`.gimoza` に入る既定値）は動かさず、未保存の印も立てない。
//
// 一度は「実体がプロジェクト設定の書き換えだから読むだけでは押させない」としたが、
// **起動直後は常に読むだけ**なので、開いて眺めるだけの人がグリッドを一度も消せなく
// なった（所有者の裁定「読むだけ＝選べる・**読める**・直せない」の「読める」を損ねる）。
// 保存される既定値を変えられるのは設定ダイアログだけで、そちらは従来どおり編集の権限を
// 要る（その関門は `ui/shell/view-only-gate.test.tsx` の表が受け持つ）。
//
// aria-pressed は **実効値**（上書きがあればそれ、無ければ設定）を映す。描画側
// （`App.tsx` の gridVisible ゲッター）も同じ規則で読む（二重真実源を作らない）。

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EDIT_MODE } from '../state/session';
import { createSessionStore } from '../state/store';

import { GridToggleControl } from './GridToggleControl';

interface TestDomain {
  readonly tag: string;
}

afterEach(() => cleanup());

/** 既定のモードは「読むだけ」（View）。編集モードが要る検査だけ明示的に渡す。 */
function makeStore(mode: (typeof EDIT_MODE)[keyof typeof EDIT_MODE] = EDIT_MODE.View) {
  return createSessionStore<TestDomain>({
    initialDomain: { tag: 'd' },
    initial: { mode },
  });
}

describe('GridToggleControl (FR-13 上部バー グリッド表示トグル)', () => {
  it('実効値を aria-pressed に映す（既定は上書きなし＝設定どおりの可視）', () => {
    const store = makeStore();
    render(<GridToggleControl store={store} />);
    expect(screen.getByTestId('grid-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('「読むだけ」でも押せて、保存ファイルは動かず未保存の印も立たない', () => {
    const store = makeStore(EDIT_MODE.View);
    render(<GridToggleControl store={store} />);
    const btn = screen.getByTestId('grid-toggle');
    expect(btn).toBeEnabled();

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    // セッション限りの上書きだけが動く。
    expect(store.getState().gridVisibleOverride).toBe(false);
    // 保存される既定値は動かない。未保存の印も立たない（ここが再修正の要点）。
    expect(store.getState().projectSettings.gridVisible).toBe(true);
    expect(store.getState().projectDirty).toBe(false);

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(store.getState().gridVisibleOverride).toBe(true);
    expect(store.getState().projectDirty).toBe(false);
  });

  it('編集モードでも同じ（保存ファイルへ書く経路は設定ダイアログだけ）', () => {
    const store = makeStore(EDIT_MODE.Edit);
    render(<GridToggleControl store={store} />);
    fireEvent.click(screen.getByTestId('grid-toggle'));
    expect(store.getState().gridVisibleOverride).toBe(false);
    expect(store.getState().projectSettings.gridVisible).toBe(true);
    expect(store.getState().projectDirty).toBe(false);
  });

  it('上書きが無いあいだは設定の変化を映す（単一真実源 — SettingsDialog と併存）', () => {
    const store = makeStore(EDIT_MODE.Edit);
    render(<GridToggleControl store={store} />);
    // 設定ダイアログ側の変更（保存ファイルへ入るほう）はここにも映る。
    act(() => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    expect(screen.getByTestId('grid-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('上書きは設定より優先し、null で外すと設定へ戻る', () => {
    const store = makeStore(EDIT_MODE.Edit);
    render(<GridToggleControl store={store} />);
    act(() => {
      store.getState().updateProjectSetting('gridVisible', false);
      store.getState().setGridVisibleOverride(true);
    });
    expect(screen.getByTestId('grid-toggle')).toHaveAttribute('aria-pressed', 'true');

    act(() => {
      store.getState().setGridVisibleOverride(null);
    });
    expect(screen.getByTestId('grid-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});
