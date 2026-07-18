// FR-13 グリッド ON/OFF — the 上部バー グリッド表示 toggle (component operation test, jsdom).
//
// aria-pressed mirrors the live projectSettings.gridVisible (単一真実源 — no local
// draft); a click flips it via updateProjectSetting (which dirty-marks the project and
// the Canvas re-reads on the next redraw, 教訓 5.35). An external store change is
// reflected too (proving the widget holds no second truth).

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { createSessionStore } from '../state/store';

import { GridToggleControl } from './GridToggleControl';

interface TestDomain {
  readonly tag: string;
}

afterEach(() => cleanup());

function makeStore() {
  return createSessionStore<TestDomain>({ initialDomain: { tag: 'd' } });
}

describe('GridToggleControl (FR-13 上部バー グリッド表示トグル)', () => {
  it('reflects the live gridVisible as aria-pressed (default true = 可視)', () => {
    const store = makeStore();
    render(<GridToggleControl store={store} />);
    expect(screen.getByTestId('grid-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a click toggles projectSettings.gridVisible (true→false→true) and dirties the project', () => {
    const store = makeStore();
    render(<GridToggleControl store={store} />);
    const btn = screen.getByTestId('grid-toggle');

    fireEvent.click(btn);
    expect(store.getState().projectSettings.gridVisible).toBe(false);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    // FR-109: a project-setting change dirty-marks the document (代替=セッション表示
    // トグル案はこの dirty を立てない — レビュー俎上の UX 論点).
    expect(store.getState().projectDirty).toBe(true);

    fireEvent.click(btn);
    expect(store.getState().projectSettings.gridVisible).toBe(true);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('reflects an external store change (単一真実源 — SettingsDialog と併存)', () => {
    const store = makeStore();
    render(<GridToggleControl store={store} />);
    // A change from ANOTHER surface (e.g. the SettingsDialog checkbox) reflects here.
    act(() => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    expect(screen.getByTestId('grid-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});
