// U38 component + hook operation tests (jsdom). Covers: open→edit→confirm /
// cancel; per-scope routing (project dirty + app-level, 受け入れ基準 3); immediate
// reflection through the U16 store subscription (FR-109 / FR-110, 受け入れ基準 1 /
// 2); the no-op guard (教訓 5.24, 受け入れ基準 6); draft discard on cancel + backdrop
// (教訓 5.2, 受け入れ基準 6); persistent rejection message (教訓 5.12 / FR-115,
// 受け入れ基準 7); base-map replace起動点 (受け入れ基準 1).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StoreApi } from 'zustand/vanilla';

import { timePointYear } from '../../domain/time/time-point';
import { createSessionStore, type SessionStore } from '../state/store';
import { TIME_CHANGE_SOURCE } from '../state/store';
import { DEFAULT_PROJECT_SETTINGS } from '../state/settings';

import { SettingsDialog } from './SettingsDialog';
import { type SettingsStorePort, useSettingsDialog, CONFIRM_STATUS } from './useSettingsDialog';
import { REJECTION } from './validation';

interface TestDomain {
  readonly tag: string;
}

afterEach(() => cleanup());

function makeStore(): StoreApi<SessionStore<TestDomain>> {
  return createSessionStore<TestDomain>({ initialDomain: { tag: 'd' } });
}

/** Bind a live U16 store to the dialog's injected port (current values + actions). */
function portFrom(store: StoreApi<SessionStore<TestDomain>>): SettingsStorePort {
  const s = store.getState();
  return {
    projectSettings: s.projectSettings,
    appSettings: s.appSettings,
    updateProjectSetting: s.updateProjectSetting,
    setProjectTimelineRangeYears: s.setProjectTimelineRangeYears,
    updateAppSetting: s.updateAppSetting,
  };
}

describe('SettingsDialog rendering (FR-109 / FR-110, 受け入れ基準 3)', () => {
  it('shows the project + app tabs as separate scopes', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    expect(screen.getByTestId('settings-tab-project')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-app')).toBeInTheDocument();
    // Project tab is shown first.
    expect(screen.getByTestId('settings-project')).toBeInTheDocument();
  });

  it('renders every project field (FR-109 列挙網羅)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    for (const label of [
      'プロジェクト名',
      '説明',
      '赤道長 (km)',
      '扁平率',
      'タイムライン最小年',
      'タイムライン最大年',
      'グリッド間隔',
      'グリッド色',
      'グリッド不透明度',
      '面情報ラベル表示閾値（画面占有率）',
      '既定パレットテーマ',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByTestId('settings-custom-palette')).toBeInTheDocument();
    expect(screen.getByTestId('settings-basemap-replace')).toBeInTheDocument();
  });

  it('renders every app field on the app tab (FR-110)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-tab-app'));
    expect(screen.getByLabelText('共有頂点スナップ距離 (px)')).toBeInTheDocument();
    expect(screen.getByLabelText('描画更新頻度 (FPS)')).toBeInTheDocument();
    expect(screen.getByLabelText('全頂点マーカー表示上限')).toBeInTheDocument();
  });
});

describe('confirm routes to the correct scope (受け入れ基準 3 / 教訓 5.36)', () => {
  it('project edit dirty-marks the project document, not app-level', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '12345' } });
    fireEvent.click(screen.getByTestId('settings-save'));

    const s = store.getState();
    expect(s.projectSettings.equatorLengthKm).toBe(12345);
    expect(s.projectDirty).toBe(true); // 教訓 5.36: project setting marks dirty.
    expect(s.lastSettingsChange?.scope).toBe('project');
  });

  // 回帰 (bughunt: App 設定変更が dirty を立てず無警告で失われる). App settings are
  // persisted ONLY inside the project file (uiSettings; no separate app-settings
  // store), and the unsaved guard reads projectDirty as its single basis. An app
  // edit MUST dirty-mark the project so the change is not silently lost on quit.
  it('app edit dirty-marks the project (so the unsaved guard fires)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('settings-tab-app'));
    fireEvent.change(screen.getByLabelText('共有頂点スナップ距離 (px)'), { target: { value: '80' } });
    fireEvent.click(screen.getByTestId('settings-save'));

    const s = store.getState();
    expect(s.appSettings.snapDistancePx).toBe(80);
    expect(s.projectDirty).toBe(true); // app setting is persisted in the project ⇒ dirty.
    expect(s.lastSettingsChange?.scope).toBe('app');
  });
});

describe('immediate reflection through the store subscription (FR-109 / FR-110)', () => {
  it('a confirmed grid change notifies subscribers (no restart, 受け入れ基準 1)', () => {
    const store = makeStore();
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.projectSettings.gridOpacity));

    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('グリッド不透明度'), { target: { value: '0.2' } });
    fireEvent.click(screen.getByTestId('settings-save'));

    expect(seen).toContain(0.2);
    expect(store.getState().projectSettings.gridOpacity).toBeCloseTo(0.2);
  });

  // 回帰 (bughunt2: 設定ダイアログでタイムライン範囲を前方シフトすると confirm が例外を
  // 投げ、設定が部分適用＋クラッシュ). The confirm loop wrote changed project keys one at a
  // time in PROJECT_SETTING_KEYS order (timelineMinYear BEFORE timelineMaxYear), and the
  // per-key store path derives the timeline state after EACH single write. Shifting the
  // whole range FORWARD ([0,10000]→[20000,30000], both bounds valid, draft min<max) first
  // committed {min:20000, max:10000(old)} — an inverted range that throws in
  // deriveTimelineState — so confirm threw INSIDE the click handler with other keys
  // already partially applied. The fix writes both bounds in ONE transaction, so a
  // forward shift confirms cleanly and reflects the new range immediately.
  it('a forward timeline-range shift confirms without throwing (finding bughunt2)', () => {
    const store = makeStore();
    // Park currentTime inside the OLD default range [0,10000].
    store.getState().setCurrentTime(timePointYear(5000), TIME_CHANGE_SOURCE.Slider);
    // Also change a NON-timeline key that sorts BEFORE the timeline keys, to prove the
    // pre-fix partial-application (equatorLengthKm is written, timelineMaxYear is not).
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '12345' } });
    // Shift the whole window forward: both bounds valid (20000 < 30000).
    fireEvent.change(screen.getByLabelText('タイムライン最小年'), { target: { value: '20000' } });
    fireEvent.change(screen.getByLabelText('タイムライン最大年'), { target: { value: '30000' } });

    // Pre-fix this click threw an uncaught error escaping the handler; it must not now.
    expect(() => fireEvent.click(screen.getByTestId('settings-save'))).not.toThrow();

    const s = store.getState();
    // Both timeline bounds were applied (no partial application).
    expect(s.projectSettings.timelineMinYear).toBe(20000);
    expect(s.projectSettings.timelineMaxYear).toBe(30000);
    // The non-timeline key was applied too.
    expect(s.projectSettings.equatorLengthKm).toBe(12345);
    // The derived slider range reflects the new window…
    expect(s.timelineMin).toEqual(timePointYear(20000));
    expect(s.timelineMax).toEqual(timePointYear(30000));
    // …and currentTime (5000) was outside the new range, clamped to the lower bound.
    expect(s.currentTime).toEqual(timePointYear(20000));
    expect(s.projectDirty).toBe(true);
  });

  it('a confirmed FPS change reflects immediately and is clamped at the store (受け入れ基準 2)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-tab-app'));
    fireEvent.change(screen.getByLabelText('描画更新頻度 (FPS)'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(store.getState().appSettings.renderFps).toBe(30);
  });
});

describe('validation + rejection (FR-115, 教訓 5.12 / 5.26, 受け入れ基準 7)', () => {
  it('rejects out-of-range FPS, shows the Japanese reason, leaves committed value untouched', () => {
    const store = makeStore();
    const onClose = vi.fn();
    render(<SettingsDialog store={portFrom(store)} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('settings-tab-app'));
    fireEvent.change(screen.getByLabelText('描画更新頻度 (FPS)'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('settings-save'));

    expect(screen.getByTestId('settings-errors')).toHaveTextContent(REJECTION.fpsRange);
    expect(store.getState().appSettings.renderFps).toBe(60); // 教訓 5.22: untouched.
    expect(onClose).not.toHaveBeenCalled(); // stays open to fix.
  });

  it('rejects min >= max year (FR-66) with the Japanese reason', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('タイムライン最小年'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('タイムライン最大年'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(screen.getByTestId('settings-errors')).toHaveTextContent(REJECTION.timelineOrder);
  });

  it('the rejection message is NOT cleared by an unrelated edit (教訓 5.12)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(screen.getByTestId('settings-errors')).toBeInTheDocument();

    // An unrelated edit must NOT erase the reason.
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: 'abc' } });
    expect(screen.queryByTestId('settings-errors')).toBeInTheDocument();
  });
});

describe('draft discard + no-op guard (教訓 5.2 / 5.24, 受け入れ基準 6)', () => {
  it('cancel discards the draft: re-opening shows the committed value', () => {
    const store = makeStore();
    const { unmount } = render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '99999' } });
    fireEvent.click(screen.getByTestId('settings-cancel'));
    expect(store.getState().projectSettings.equatorLengthKm).toBe(
      DEFAULT_PROJECT_SETTINGS.equatorLengthKm,
    );
    unmount();

    // Re-open: the draft is fresh from the committed value (no leak, 教訓 5.2).
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    expect(screen.getByLabelText('赤道長 (km)')).toHaveValue(
      DEFAULT_PROJECT_SETTINGS.equatorLengthKm,
    );
  });

  it('a backdrop click discards the draft', () => {
    const store = makeStore();
    const onClose = vi.fn();
    render(<SettingsDialog store={portFrom(store)} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '777' } });
    fireEvent.click(screen.getByTestId('settings-backdrop'));
    expect(store.getState().projectSettings.equatorLengthKm).toBe(
      DEFAULT_PROJECT_SETTINGS.equatorLengthKm,
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('confirming with no change does not dirty-mark or notify (教訓 5.24)', () => {
    const store = makeStore();
    const calls: unknown[] = [];
    store.subscribe(() => calls.push(1));
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(store.getState().projectDirty).toBe(false);
    expect(store.getState().lastSettingsChange).toBeNull();
    expect(calls).toHaveLength(0); // no store write at all.
  });
});

describe('custom palette management (FR-109 / FR-102)', () => {
  it('adds and removes palette colors in the draft, persists on confirm', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-palette-add'));
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(store.getState().projectSettings.customPalette).toHaveLength(1);
  });
});

describe('base-map replace起動点 (受け入れ基準 1)', () => {
  it('invokes the host request handler (U18 does the replacement)', () => {
    const store = makeStore();
    const onRequest = vi.fn();
    render(
      <SettingsDialog
        store={portFrom(store)}
        onClose={() => {}}
        onRequestBasemapReplace={onRequest}
      />,
    );
    fireEvent.click(screen.getByTestId('settings-basemap-replace'));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('disables the control when no handler is provided', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} onClose={() => {}} />);
    expect(screen.getByTestId('settings-basemap-replace')).toBeDisabled();
  });
});

describe('useSettingsDialog confirm outcome (教訓 5.26 テスト可能な戻り値)', () => {
  // A tiny harness component that exposes the hook's confirm() return value.
  function Harness(props: {
    readonly store: SettingsStorePort;
    readonly onResult: (r: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>) => void;
  }): JSX.Element {
    const dialog = useSettingsDialog(props.store);
    return (
      <div>
        <input
          aria-label="eq"
          type="number"
          value={dialog.projectDraft.equatorLengthKm}
          onChange={(e) => dialog.setProjectField('equatorLengthKm', Number(e.target.value))}
        />
        <button type="button" data-testid="harness-confirm" onClick={() => props.onResult(dialog.confirm())}>
          go
        </button>
      </div>
    );
  }

  it('returns NoOp when nothing changed', () => {
    const store = makeStore();
    const results: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>[] = [];
    render(<Harness store={portFrom(store)} onResult={(r) => results.push(r)} />);
    fireEvent.click(screen.getByTestId('harness-confirm'));
    expect(results[0]?.status).toBe(CONFIRM_STATUS.NoOp);
    expect(results[0]?.changedProject).toEqual([]);
  });

  it('returns Applied with the changed keys', () => {
    const store = makeStore();
    const results: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>[] = [];
    render(<Harness store={portFrom(store)} onResult={(r) => results.push(r)} />);
    fireEvent.change(screen.getByLabelText('eq'), { target: { value: '9000' } });
    fireEvent.click(screen.getByTestId('harness-confirm'));
    expect(results[0]?.status).toBe(CONFIRM_STATUS.Applied);
    expect(results[0]?.changedProject).toEqual(['equatorLengthKm']);
  });

  it('returns Rejected with Japanese reasons for an invalid value', () => {
    const store = makeStore();
    const results: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>[] = [];
    render(<Harness store={portFrom(store)} onResult={(r) => results.push(r)} />);
    fireEvent.change(screen.getByLabelText('eq'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('harness-confirm'));
    expect(results[0]?.status).toBe(CONFIRM_STATUS.Rejected);
    expect(results[0]?.errors.some((e) => e.message === REJECTION.equatorNonPositive)).toBe(true);
  });
});
