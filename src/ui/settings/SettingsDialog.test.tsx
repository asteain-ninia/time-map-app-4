// U38 component + hook operation tests (jsdom). Covers: open→edit→confirm /
// cancel; per-scope routing (project dirty + app-level, 受け入れ基準 3); immediate
// reflection through the U16 store subscription (FR-109 / FR-110, 受け入れ基準 1 /
// 2); the no-op guard (教訓 5.24, 受け入れ基準 6); draft discard on cancel + backdrop
// (教訓 5.2, 受け入れ基準 6); persistent rejection message (教訓 5.12 / FR-115,
// 受け入れ基準 7); base-map replace起動点 (受け入れ基準 1).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from 'zustand/vanilla';

import { timePointYear } from '../../domain/time/time-point';
import { createSessionStore, type SessionStore } from '../state/store';
import { TIME_CHANGE_SOURCE } from '../state/store';
import { DEFAULT_PROJECT_SETTINGS } from '../state/settings';

import { SettingsDialog } from './SettingsDialog';
import {
  DEFAULT_APP_PREFS,
  type AppPrefs,
  type AppPrefsWriteResult,
  type BackupCount,
} from '../../shell/ipc/contract';
import {
  type BackupSettingsPort,
  generationsToDelete,
  useBackupSettings,
  validateBackupDraft,
} from './useBackupSettings';
import { APP_STRINGS } from '../shell/strings';
import { BACKUP_SETTINGS_STRINGS, PROJECT_FIELD_STRINGS } from './strings';
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
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    expect(screen.getByTestId('settings-tab-project')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-app')).toBeInTheDocument();
    // Project tab is shown first.
    expect(screen.getByTestId('settings-project')).toBeInTheDocument();
  });

  it('renders every project field (FR-109 列挙網羅)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    for (const label of [
      'プロジェクト名',
      '説明',
      '赤道長 (km)',
      '扁平率',
      'タイムライン最小年',
      'タイムライン最大年',
      'グリッドを表示',
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
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-tab-app'));
    expect(screen.getByLabelText('共有頂点スナップ距離 (px)')).toBeInTheDocument();
    expect(screen.getByLabelText('描画更新頻度 (FPS)')).toBeInTheDocument();
    expect(screen.getByLabelText('全頂点マーカー表示上限')).toBeInTheDocument();
  });
});

describe('scope-tab keyboard a11y (WAI-ARIA tablist)', () => {
  it('wires each tab to its panel via id + aria-controls + aria-labelledby', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    const tab = screen.getByTestId('settings-tab-project');
    const panel = screen.getByTestId('settings-project');
    expect(tab).toHaveAttribute('id', 'settings-tab-project');
    expect(tab).toHaveAttribute('aria-controls', 'settings-panel-project');
    expect(panel).toHaveAttribute('id', 'settings-panel-project');
    expect(panel).toHaveAttribute('aria-labelledby', 'settings-tab-project');
  });

  // review #3: BOTH panels are always in the DOM (the inactive one carries `hidden`), so
  // neither tab's aria-controls points at a missing id. The IDREF targets always exist.
  it('renders BOTH panels always; the inactive one is hidden (no dangling aria-controls)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    const projectPanel = screen.getByTestId('settings-project');
    const appPanel = screen.getByTestId('settings-app');
    // Both aria-controls IDREF targets exist in the DOM…
    expect(projectPanel).toHaveAttribute('id', 'settings-panel-project');
    expect(appPanel).toHaveAttribute('id', 'settings-panel-app');
    // …with the project (default) shown and the app panel hidden.
    expect(projectPanel).not.toHaveAttribute('hidden');
    expect(appPanel).toHaveAttribute('hidden');

    // Switching flips which is hidden (still both present).
    fireEvent.click(screen.getByTestId('settings-tab-app'));
    expect(screen.getByTestId('settings-project')).toHaveAttribute('hidden');
    expect(screen.getByTestId('settings-app')).not.toHaveAttribute('hidden');
  });

  // review #2: focus must FOLLOW the arrow (WAI-ARIA tablist). Fire each keyDown on the
  // element that currently HAS focus so the test fails if the dialog only setTab()s
  // without moving DOM focus. Selection is read from aria-selected (both panels are
  // always rendered, review #3, so panel presence alone can no longer prove the switch).
  it('ArrowRight / ArrowLeft move the selected tab AND DOM focus (wrapping)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    const projectTab = screen.getByTestId('settings-tab-project');
    const appTab = screen.getByTestId('settings-tab-app');
    // 増分 8D: 3 つ目のタブ「保存とバックアップ」。
    const backupTab = screen.getByTestId('settings-tab-backup');

    projectTab.focus();
    // project → app on ArrowRight.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(appTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(appTab);

    // app → backup → project on ArrowRight (wrap).
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(backupTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(projectTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(projectTab);

    // project → backup on ArrowLeft (wrap the other way).
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(backupTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(backupTab);
  });
});

describe('confirm routes to the correct scope (受け入れ基準 3 / 教訓 5.36)', () => {
  it('project edit dirty-marks the project document, not app-level', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);

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
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);

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

    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
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
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);

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

  // FR-13 グリッド ON/OFF切替 (受け入れ基準 9): the checkbox reflects the live setting,
  // toggles the draft, and persists through the SAME validate→updateProjectSetting
  // confirm flow — dirty-marking the project like every other project field (FR-109).
  it('toggles gridVisible via the checkbox and persists on confirm', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    const checkbox = screen.getByTestId('settings-grid-visible');
    // Default is 可視 (checked).
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox); // uncheck → hide grid
    fireEvent.click(screen.getByTestId('settings-save'));

    const s = store.getState();
    expect(s.projectSettings.gridVisible).toBe(false);
    expect(s.projectDirty).toBe(true);
    expect(s.lastSettingsChange?.scope).toBe('project');
  });

  it('a confirmed FPS change reflects immediately and is clamped at the store (受け入れ基準 2)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
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
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={onClose} />);
    fireEvent.click(screen.getByTestId('settings-tab-app'));
    fireEvent.change(screen.getByLabelText('描画更新頻度 (FPS)'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('settings-save'));

    expect(screen.getByTestId('settings-errors')).toHaveTextContent(REJECTION.fpsRange);
    expect(store.getState().appSettings.renderFps).toBe(60); // 教訓 5.22: untouched.
    expect(onClose).not.toHaveBeenCalled(); // stays open to fix.
  });

  it('rejects min >= max year (FR-66) with the Japanese reason', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('タイムライン最小年'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('タイムライン最大年'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(screen.getByTestId('settings-errors')).toHaveTextContent(REJECTION.timelineOrder);
  });

  it('the rejection message is NOT cleared by an unrelated edit (教訓 5.12)', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
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
    const { unmount } = render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '99999' } });
    fireEvent.click(screen.getByTestId('settings-cancel'));
    expect(store.getState().projectSettings.equatorLengthKm).toBe(
      DEFAULT_PROJECT_SETTINGS.equatorLengthKm,
    );
    unmount();

    // Re-open: the draft is fresh from the committed value (no leak, 教訓 5.2).
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    expect(screen.getByLabelText('赤道長 (km)')).toHaveValue(
      DEFAULT_PROJECT_SETTINGS.equatorLengthKm,
    );
  });

  it('a backdrop click discards the draft', () => {
    const store = makeStore();
    const onClose = vi.fn();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={onClose} />);
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
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(store.getState().projectDirty).toBe(false);
    expect(store.getState().lastSettingsChange).toBeNull();
    expect(calls).toHaveLength(0); // no store write at all.
  });
});

describe('custom palette management (FR-109 / FR-102)', () => {
  it('adds and removes palette colors in the draft, persists on confirm', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-palette-add'));
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(store.getState().projectSettings.customPalette).toHaveLength(1);
  });
});

// FR-109 follow-up (ユーザー裁定): the palette pair is routed to the UNDOABLE
// commitPaletteChange command, NOT the per-key updateProjectSetting store write — because
// the palette feeds the recolor engine's root.uiSettings source. A non-palette key in the
// SAME confirm still takes the ordinary store path (両方反映).
describe('palette confirm routes to the undoable command seam (FR-109 follow-up)', () => {
  /** A port whose per-key write is spied and whose palette seam is a stub. */
  function spyPort(store: StoreApi<SessionStore<TestDomain>>): {
    port: SettingsStorePort;
    updateProjectSetting: ReturnType<typeof vi.fn>;
    commitPaletteChange: ReturnType<typeof vi.fn>;
  } {
    const s = store.getState();
    const updateProjectSetting = vi.fn(s.updateProjectSetting);
    const commitPaletteChange = vi.fn();
    return {
      port: {
        projectSettings: s.projectSettings,
        appSettings: s.appSettings,
        updateProjectSetting: updateProjectSetting as SettingsStorePort['updateProjectSetting'],
        setProjectTimelineRangeYears: s.setProjectTimelineRangeYears,
        updateAppSetting: s.updateAppSetting,
        commitPaletteChange,
      },
      updateProjectSetting,
      commitPaletteChange,
    };
  }

  it('a palette-only change fires commitPaletteChange ONCE and no palette updateProjectSetting', () => {
    const store = makeStore();
    const { port, updateProjectSetting, commitPaletteChange } = spyPort(store);
    render(<SettingsDialog store={port} canEdit onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('settings-palette-add')); // customPalette draft → ['#000000']
    fireEvent.click(screen.getByTestId('settings-save'));

    expect(commitPaletteChange).toHaveBeenCalledTimes(1);
    expect(commitPaletteChange).toHaveBeenCalledWith({
      defaultPaletteTheme: DEFAULT_PROJECT_SETTINGS.defaultPaletteTheme,
      customPalette: ['#000000'],
    });
    // The palette must NOT also flow through the non-undoable per-key store write.
    const paletteKeyWrites = updateProjectSetting.mock.calls.filter(
      ([key]) => key === 'customPalette' || key === 'defaultPaletteTheme',
    );
    expect(paletteKeyWrites).toHaveLength(0);
  });

  it('palette + a non-palette key: palette→command, the other→updateProjectSetting (両方反映)', () => {
    const store = makeStore();
    const { port, updateProjectSetting, commitPaletteChange } = spyPort(store);
    render(<SettingsDialog store={port} canEdit onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '12345' } });
    fireEvent.click(screen.getByTestId('settings-palette-add'));
    fireEvent.click(screen.getByTestId('settings-save'));

    // Palette → undoable command.
    expect(commitPaletteChange).toHaveBeenCalledTimes(1);
    // The non-palette key → ordinary store path, and it actually reflected.
    expect(updateProjectSetting).toHaveBeenCalledWith('equatorLengthKm', 12345);
    expect(store.getState().projectSettings.equatorLengthKm).toBe(12345);
    // …and no palette key leaked into the per-key path.
    expect(
      updateProjectSetting.mock.calls.some(
        ([key]) => key === 'customPalette' || key === 'defaultPaletteTheme',
      ),
    ).toBe(false);
  });

  it('falls back to updateProjectSetting for the palette when the seam is absent', () => {
    // The default portFrom carries NO commitPaletteChange: the palette persists via the
    // ordinary (non-undoable) per-key path, preserving the pre-existing behaviour.
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-palette-add'));
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(store.getState().projectSettings.customPalette).toEqual(['#000000']);
  });
});

describe('base-map replace起動点 (受け入れ基準 1)', () => {
  it('invokes the host request handler (U18 does the replacement)', () => {
    const store = makeStore();
    const onRequest = vi.fn();
    render(
      <SettingsDialog
        store={portFrom(store)}
        canEdit
        onClose={() => {}}
        onRequestBasemapReplace={onRequest}
      />,
    );
    fireEvent.click(screen.getByTestId('settings-basemap-replace'));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('disables the control when no handler is provided', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    expect(screen.getByTestId('settings-basemap-replace')).toBeDisabled();
  });
});

describe('useSettingsDialog confirm outcome (教訓 5.26 テスト可能な戻り値)', () => {
  // A tiny harness component that exposes the hook's confirm() return value.
  function Harness(props: {
    readonly store: SettingsStorePort;
    /** K-6: 省略時は「直せる」。false を渡すと「読むだけ」の関門を試せる。 */
    readonly canEdit?: boolean;
    readonly onResult: (r: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>) => void;
  }): JSX.Element {
    const dialog = useSettingsDialog(props.store, props.canEdit ?? true);
    return (
      <div>
        <input
          aria-label="eq"
          type="number"
          value={dialog.projectDraft.equatorLengthKm}
          onChange={(e) => dialog.setProjectField('equatorLengthKm', Number(e.target.value))}
        />
        <input
          aria-label="snap"
          type="number"
          value={dialog.appDraft.snapDistancePx}
          onChange={(e) => dialog.setAppField('snapDistancePx', Number(e.target.value))}
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

  // K-6「読むだけ」の関門は**見た目ではなく確定処理**にある（教訓 5.13）。ここでは入力を
  // disabled にしない自前の harness からわざと下書きを汚し、それでも 1 件も書かれない
  // ことを確かめる。画面側の disabled は view-only-gate.test.tsx の表が受け持つ。
  it('「読むだけ」では、下書きを汚してから確定してもプロジェクト設定を 1 件も書かない', () => {
    const store = makeStore();
    const before = store.getState().projectSettings.equatorLengthKm;
    const results: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>[] = [];
    render(
      <Harness store={portFrom(store)} canEdit={false} onResult={(r) => results.push(r)} />,
    );
    fireEvent.change(screen.getByLabelText('eq'), { target: { value: '9000' } });
    fireEvent.click(screen.getByTestId('harness-confirm'));

    expect(results[0]?.changedProject).toEqual([]);
    expect(results[0]?.status).toBe(CONFIRM_STATUS.NoOp);
    expect(store.getState().projectSettings.equatorLengthKm).toBe(before);
    // 保存ファイルの中身を触っていないので「未保存」も立たない（教訓 5.36 の保存文脈）。
    expect(store.getState().projectDirty).toBe(false);
  });

  it('「読むだけ」でもアプリ全体設定は確定できる（所有者裁定: プロジェクトに属さない設定は変更可）', () => {
    const store = makeStore();
    const results: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>[] = [];
    render(
      <Harness store={portFrom(store)} canEdit={false} onResult={(r) => results.push(r)} />,
    );
    fireEvent.change(screen.getByLabelText('snap'), { target: { value: '80' } });
    fireEvent.click(screen.getByTestId('harness-confirm'));

    expect(results[0]?.status).toBe(CONFIRM_STATUS.Applied);
    expect(results[0]?.changedApp).toEqual(['snapDistancePx']);
    expect(store.getState().appSettings.snapDistancePx).toBe(80);
  });

  it('「読むだけ」では、直せないプロジェクト値の巻き添えでアプリ全体設定まで拒否しない', () => {
    // 下書きのプロジェクト値が不正でも、「読むだけ」ではそれを直す手段が画面に無い。
    // ここで確定全体を拒むと、変更してよいはずのアプリ全体設定が永久に保存できなくなる。
    const store = makeStore();
    const results: ReturnType<ReturnType<typeof useSettingsDialog>['confirm']>[] = [];
    render(
      <Harness store={portFrom(store)} canEdit={false} onResult={(r) => results.push(r)} />,
    );
    fireEvent.change(screen.getByLabelText('eq'), { target: { value: '0' } }); // 不正な赤道長
    fireEvent.change(screen.getByLabelText('snap'), { target: { value: '80' } });
    fireEvent.click(screen.getByTestId('harness-confirm'));

    expect(results[0]?.status).toBe(CONFIRM_STATUS.Applied);
    expect(results[0]?.errors).toEqual([]);
    expect(store.getState().appSettings.snapDistancePx).toBe(80);
    // 不正だったプロジェクト値のほうは 1 件も書かれていない。
    expect(results[0]?.changedProject).toEqual([]);
    expect(store.getState().projectSettings.equatorLengthKm).toBe(
      DEFAULT_PROJECT_SETTINGS.equatorLengthKm,
    );
  });
});

// K-6「読むだけ」の画面側（教訓 5.13 / 所有者裁定）。プロジェクト設定タブの部品は 1 つ
// 残らず無効、アプリ全体設定タブは触れるまま、そして「設定を読む」こと自体は止めない。
describe('K-6「読むだけ」ではプロジェクト設定に触れない（教訓 5.13 / 5.36）', () => {
  /** プロジェクト設定タブの入力（＝保存ファイルに入る側）の全件。 */
  const PROJECT_INPUT_LABELS: readonly string[] = [
    'プロジェクト名',
    '説明',
    '赤道長 (km)',
    '扁平率',
    'タイムライン最小年',
    'タイムライン最大年',
    '最小ズーム倍率',
    '最大ズーム倍率',
    'グリッドを表示',
    'グリッド間隔',
    'グリッド色',
    'グリッド不透明度',
    '面情報ラベル表示閾値（画面占有率）',
    '新規面の自動配色を既定で有効にする',
    '既定パレットテーマ',
  ];

  it('プロジェクト設定の入力がすべて無効になり、理由が画面に出る', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit={false} onClose={() => {}} />);
    for (const label of PROJECT_INPUT_LABELS) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByTestId('settings-project-readonly')).toBeInTheDocument();
  });

  it('カスタムパレットの追加・変更・削除がすべて無効になる', () => {
    const store = makeStore();
    // 既存の色が 1 つある状態にして「色の変更」「削除」も見る（空だと行が出ない）。
    store.getState().updateProjectSetting('customPalette', ['#123456']);
    render(<SettingsDialog store={portFrom(store)} canEdit={false} onClose={() => {}} />);
    expect(screen.getByTestId('settings-palette-add')).toBeDisabled();
    expect(screen.getByTestId('settings-palette-remove-0')).toBeDisabled();
    expect(screen.getByLabelText('カスタムパレット色 1')).toBeDisabled();
  });

  it('ベースマップの差し替えは、結線があっても無効で、押しても起動しない', () => {
    const store = makeStore();
    const onRequest = vi.fn();
    render(
      <SettingsDialog
        store={portFrom(store)}
        canEdit={false}
        onClose={() => {}}
        onRequestBasemapReplace={onRequest}
      />,
    );
    const button = screen.getByTestId('settings-basemap-replace');
    expect(button).toBeDisabled();
    // 見た目だけの封鎖になっていないこと（教訓 5.13）: 押下経路でも弾く。
    fireEvent.click(button);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('アプリ全体設定の入力は「読むだけ」でも有効なまま', () => {
    const store = makeStore();
    render(<SettingsDialog store={portFrom(store)} canEdit={false} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-tab-app'));
    for (const label of [
      '共有頂点スナップ距離 (px)',
      '描画更新頻度 (FPS)',
      '全頂点マーカー表示上限',
      'アンドゥ履歴の上限',
      '重なり解決画面の使い方を表示する',
    ]) {
      expect(screen.getByLabelText(label)).toBeEnabled();
    }
  });

  it('「直せる」ときは同じ入力がすべて有効で、理由の表示も出ない（検査が空振りしていない証）', () => {
    const store = makeStore();
    store.getState().updateProjectSetting('customPalette', ['#123456']);
    render(<SettingsDialog store={portFrom(store)} canEdit onClose={() => {}} />);
    for (const label of PROJECT_INPUT_LABELS) {
      expect(screen.getByLabelText(label)).toBeEnabled();
    }
    expect(screen.getByTestId('settings-palette-add')).toBeEnabled();
    expect(screen.getByTestId('settings-palette-remove-0')).toBeEnabled();
    expect(screen.queryByTestId('settings-project-readonly')).toBeNull();
  });
});

// --- 増分 8D: 保存とバックアップ（G-5 / FR-108、V12 の合格条件④）---------------------

describe('保存とバックアップ（増分 8D）', () => {
  function fakePort(
    over: Partial<BackupSettingsPort> = {},
    count: BackupCount = { basis: 'file', sourceName: 'w.gimoza', count: 2 },
  ): BackupSettingsPort & { readonly writes: Partial<AppPrefs>[] } {
    const writes: Partial<AppPrefs>[] = [];
    let current: AppPrefs = DEFAULT_APP_PREFS;
    return {
      writes,
      readAppPrefs: vi.fn(async () => current),
      writeAppPrefs: vi.fn(async (patch: Partial<AppPrefs>): Promise<AppPrefsWriteResult> => {
        writes.push(patch);
        current = { ...current, ...patch };
        return { ok: true, prefs: current };
      }),
      countBackups: vi.fn(async () => count),
      ...over,
    };
  }

  async function openBackupTab(port: BackupSettingsPort, onClose = (): void => {}): Promise<void> {
    const store = makeStore();
    render(
      <SettingsDialog store={portFrom(store)} canEdit onClose={onClose} backupPort={port} />,
    );
    fireEvent.click(screen.getByTestId('settings-tab-backup'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-interval')).toHaveValue(5),
    );
  }

  it('保存してある間隔・世代数を出し、いま溜まっている世代の数も出す', async () => {
    const port = fakePort();
    await openBackupTab(port);
    expect(screen.getByTestId('settings-backup-generations')).toHaveValue(10);
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-generation-count')).toHaveTextContent(
        'w.gimoza の世代はいま 2 個あります',
      ),
    );
  });

  it('［適用］で間隔と世代数をその場で書き、ダイアログは閉じない（V12 の手順 (b)）', async () => {
    const port = fakePort();
    const onClose = vi.fn();
    await openBackupTab(port, onClose);
    fireEvent.change(screen.getByTestId('settings-backup-interval'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    await waitFor(() => expect(screen.getByTestId('settings-backup-applied')).toBeInTheDocument());
    expect(port.writes).toEqual([{ autoSaveIntervalMinutes: 10, backupGenerations: 20 }]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('範囲外は理由を出して書かない（0 分・101 世代・小数・世代 1）', async () => {
    const port = fakePort();
    await openBackupTab(port);
    fireEvent.change(screen.getByTestId('settings-backup-interval'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '101' } });
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-interval-error')).toHaveTextContent(
        BACKUP_SETTINGS_STRINGS.intervalInvalid,
      ),
    );
    expect(screen.getByTestId('settings-backup-generations-error')).toHaveTextContent(
      BACKUP_SETTINGS_STRINGS.generationsInvalid,
    );
    // 手直し: 下限は 2（1 では戻せない）。欄の min も同じ定数から引く。
    fireEvent.change(screen.getByTestId('settings-backup-interval'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-generations-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('settings-backup-generations')).toHaveAttribute('min', '2');
    expect(port.writes).toEqual([]);
  });

  it('［適用］を押さずにダイアログの［保存］を押しても、打った値は書く（黙って捨てない）', async () => {
    const port = fakePort();
    const onClose = vi.fn();
    await openBackupTab(port, onClose);
    fireEvent.change(screen.getByTestId('settings-backup-interval'), { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() =>
      expect(port.writes).toEqual([{ autoSaveIntervalMinutes: 15, backupGenerations: 10 }]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('［保存］でも範囲外なら閉じずにこの節を開いて理由を出す', async () => {
    const port = fakePort();
    const onClose = vi.fn();
    await openBackupTab(port, onClose);
    fireEvent.change(screen.getByTestId('settings-backup-interval'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('settings-tab-project'));
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-tab-backup')).toHaveAttribute('aria-selected', 'true'),
    );
    expect(await screen.findByTestId('settings-backup-interval-error')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(port.writes).toEqual([]);
  });

  it('世代が 0 個なら、まだ無いと言う', async () => {
    const port = fakePort({}, { basis: 'file', sourceName: 'w.gimoza', count: 0 });
    await openBackupTab(port);
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-generation-count')).toHaveTextContent(
        BACKUP_SETTINGS_STRINGS.generationNone,
      ),
    );
  });

  it('どのファイルの世代か分からない（新規など）ときは「無い」と言わない（手直し）', async () => {
    const port = fakePort({}, { basis: 'none' });
    await openBackupTab(port);
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-generation-count')).toHaveTextContent(
        BACKUP_SETTINGS_STRINGS.generationNoBasis,
      ),
    );
    expect(screen.getByTestId('settings-backup-generation-count')).not.toHaveTextContent(
      BACKUP_SETTINGS_STRINGS.generationNone,
    );
    // 下げても数は出せないが、消えることは先に言う。再手直し（司令塔の決定 2-3）: 数が
    // 分からなくても **必ず確認を挟む**（ほかのファイルの世代は次に保存したときに消える）。
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '3' } });
    expect(screen.getByTestId('settings-backup-shrink-generic')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    expect(await screen.findByTestId('settings-backup-shrink-confirm')).toHaveTextContent(
      BACKUP_SETTINGS_STRINGS.shrinkConfirmGeneric(3),
    );
    expect(port.writes).toEqual([]);
    fireEvent.click(screen.getByTestId('settings-backup-shrink-yes'));
    await waitFor(() => expect(port.writes).toEqual([{ autoSaveIntervalMinutes: 5, backupGenerations: 3 }]));
  });

  // --- 手直し: 世代数を下げると、次の保存で古い世代がまとめて黙って消える -----------------

  it('世代数を下げて世代が消えるなら、先に数を出し、［適用］では確認を挟む。やめれば値は戻る', async () => {
    const port = fakePort({}, { basis: 'file', sourceName: 'w.gimoza', count: 10 });
    await openBackupTab(port);
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-generation-count')).toHaveTextContent('10 個'),
    );
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '2' } });
    // 10 個ある → 次の保存で 1 個足して 2 個に減らす → 9 個消える。
    expect(screen.getByTestId('settings-backup-shrink-preview')).toHaveTextContent(
      BACKUP_SETTINGS_STRINGS.shrinkPreview('w.gimoza', 9, 2),
    );
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    const confirm = await screen.findByTestId('settings-backup-shrink-confirm');
    expect(confirm).toHaveTextContent(BACKUP_SETTINGS_STRINGS.shrinkConfirm('w.gimoza', 9));
    expect(port.writes).toEqual([]);

    fireEvent.click(screen.getByTestId('settings-backup-shrink-no'));
    expect(screen.queryByTestId('settings-backup-shrink-confirm')).toBeNull();
    expect(screen.getByTestId('settings-backup-generations')).toHaveValue(10);
    expect(port.writes).toEqual([]);

    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    fireEvent.click(await screen.findByTestId('settings-backup-shrink-yes'));
    await waitFor(() => expect(port.writes).toEqual([{ autoSaveIntervalMinutes: 5, backupGenerations: 2 }]));
    expect(await screen.findByTestId('settings-backup-applied')).toBeInTheDocument();
  });

  it('［保存］でも世代が消えるなら確認を挟んで留まり、「この数にする」で書けたら閉じる', async () => {
    const port = fakePort({}, { basis: 'file', sourceName: 'w.gimoza', count: 10 });
    const onClose = vi.fn();
    await openBackupTab(port, onClose);
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-generation-count')).toHaveTextContent('10 個'),
    );
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('settings-tab-project'));
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(await screen.findByTestId('settings-backup-shrink-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-backup')).toHaveAttribute('aria-selected', 'true');
    expect(onClose).not.toHaveBeenCalled();
    expect(port.writes).toEqual([]);
    fireEvent.click(screen.getByTestId('settings-backup-shrink-yes'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(port.writes).toEqual([{ autoSaveIntervalMinutes: 5, backupGenerations: 5 }]);
  });

  it('このファイルでは消える世代が無くても、下げたら確認を挟む（ほかのファイルの分。司令塔の決定 2-3）', async () => {
    const port = fakePort({}, { basis: 'file', sourceName: 'w.gimoza', count: 2 });
    await openBackupTab(port);
    await waitFor(() =>
      expect(screen.getByTestId('settings-backup-generation-count')).toHaveTextContent('2 個'),
    );
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '5' } });
    expect(screen.queryByTestId('settings-backup-shrink-preview')).toBeNull();
    expect(screen.getByTestId('settings-backup-shrink-generic')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    expect(await screen.findByTestId('settings-backup-shrink-confirm')).toHaveTextContent(
      BACKUP_SETTINGS_STRINGS.shrinkConfirmGeneric(5),
    );
    expect(port.writes).toEqual([]);
    fireEvent.click(screen.getByTestId('settings-backup-shrink-yes'));
    await waitFor(() => expect(port.writes).toEqual([{ autoSaveIntervalMinutes: 5, backupGenerations: 5 }]));
  });

  it('上げたときは確認を挟まない', async () => {
    const port = fakePort({}, { basis: 'none' });
    await openBackupTab(port);
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '30' } });
    expect(screen.queryByTestId('settings-backup-shrink-generic')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    await waitFor(() => expect(port.writes).toEqual([{ autoSaveIntervalMinutes: 5, backupGenerations: 30 }]));
    expect(screen.queryByTestId('settings-backup-shrink-confirm')).toBeNull();
  });

  // --- 手直し: 書き込みの失敗と、応答の競合 ------------------------------------------------

  it('書けなかったら理由を出し、入力は残す。［保存］なら閉じない', async () => {
    const message = '設定をファイルに書き込めませんでした（EACCES）。値は変えていません。';
    const port = fakePort({
      writeAppPrefs: vi.fn(async () => ({ ok: false as const, prefs: DEFAULT_APP_PREFS, message })),
    });
    const onClose = vi.fn();
    await openBackupTab(port, onClose);
    fireEvent.change(screen.getByTestId('settings-backup-generations'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    expect(await screen.findByTestId('settings-backup-write-error')).toHaveTextContent(message);
    expect(screen.queryByTestId('settings-backup-applied')).toBeNull();
    expect(screen.getByTestId('settings-backup-generations')).toHaveValue(20);

    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(port.writeAppPrefs).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('settings-tab-backup')).toHaveAttribute('aria-selected', 'true'),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-backup-generations')).toHaveValue(20);
  });

  it('書き込みの口が例外でも、理由を出して入力を残す', async () => {
    const port = fakePort({
      writeAppPrefs: vi.fn(async () => {
        throw new Error('IPC');
      }),
    });
    await openBackupTab(port);
    fireEvent.change(screen.getByTestId('settings-backup-interval'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('settings-backup-apply'));
    expect(await screen.findByTestId('settings-backup-write-error')).toHaveTextContent('IPC');
    expect(screen.getByTestId('settings-backup-interval')).toHaveValue(30);
  });

  it('書き込み中は欄とボタンを止め、［保存］は書けるまで閉じない', async () => {
    let finish: ((r: AppPrefsWriteResult) => void) | null = null;
    const port = fakePort({
      writeAppPrefs: vi.fn(
        () =>
          new Promise<AppPrefsWriteResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const onClose = vi.fn();
    await openBackupTab(port, onClose);
    fireEvent.change(screen.getByTestId('settings-backup-interval'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(screen.getByTestId('settings-backup-interval')).toBeDisabled());
    expect(screen.getByTestId('settings-backup-generations')).toBeDisabled();
    expect(screen.getByTestId('settings-backup-apply')).toBeDisabled();
    expect(screen.getByTestId('settings-save')).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      finish?.({ ok: true, prefs: { ...DEFAULT_APP_PREFS, autoSaveIntervalMinutes: 10 } });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('下書きの検証は範囲内の整数だけを通す（世代の下限は 2）', () => {
    expect(validateBackupDraft('10', '20')).toEqual({
      ok: true,
      value: { autoSaveIntervalMinutes: 10, backupGenerations: 20 },
    });
    expect(validateBackupDraft('10', '2').ok).toBe(true);
    expect(validateBackupDraft('10', '1').ok).toBe(false);
    expect(validateBackupDraft('121', '2').ok).toBe(false);
    expect(validateBackupDraft('1.5', '2').ok).toBe(false);
    expect(validateBackupDraft('', '2').ok).toBe(false);
  });

  it('下げたときに次の保存で消える数（上げた・同じなら 0）', () => {
    expect(generationsToDelete(10, 10, 2)).toBe(9);
    expect(generationsToDelete(10, 10, 9)).toBe(2);
    expect(generationsToDelete(2, 10, 5)).toBe(0);
    expect(generationsToDelete(10, 10, 10)).toBe(0);
    expect(generationsToDelete(10, 5, 20)).toBe(0);
  });
});

describe('useBackupSettings — 応答が、待っている間に打った値を消さない（増分 8D の手直し）', () => {
  it('頼んだあとで打ち直した下書きは、応答で上書きしない', async () => {
    let finish: ((r: AppPrefsWriteResult) => void) | null = null;
    const port: BackupSettingsPort = {
      readAppPrefs: vi.fn(async () => DEFAULT_APP_PREFS),
      writeAppPrefs: vi.fn(
        () =>
          new Promise<AppPrefsWriteResult>((resolve) => {
            finish = resolve;
          }),
      ),
      countBackups: vi.fn(async (): Promise<BackupCount> => ({ basis: 'none' })),
    };
    const { result } = renderHook(() => useBackupSettings(port));
    await waitFor(() => expect(result.current.intervalDraft).toBe('5'));
    act(() => {
      result.current.setIntervalDraft('10');
    });
    let applying: Promise<unknown> = Promise.resolve();
    act(() => {
      applying = result.current.apply();
    });
    await waitFor(() => expect(result.current.writing).toBe(true));
    // 書き込み中の 2 度目の［適用］は落とす。
    await expect(result.current.apply()).resolves.toBe('busy');
    act(() => {
      result.current.setIntervalDraft('15');
    });
    await act(async () => {
      finish?.({ ok: true, prefs: { ...DEFAULT_APP_PREFS, autoSaveIntervalMinutes: 10 } });
      await applying;
    });
    expect(result.current.saved?.autoSaveIntervalMinutes).toBe(10);
    // 15 は残る（まだ書いていない変更として dirty）。
    expect(result.current.intervalDraft).toBe('15');
    expect(result.current.dirty).toBe(true);
  });
});

describe('読み込みの間の確定（B120）', () => {
  const during = () => {
    const store = makeStore();
    store.getState().setDocumentLoadActive(true);
    const refused = vi.fn();
    store.getState().addLoadRefusalListener(refused);
    const port: SettingsStorePort = {
      ...portFrom(store),
      refuseEditDuringLoad: store.getState().refuseEditDuringLoad,
    };
    return { store, port, refused };
  };

  it('書類を変える鍵を変えて保存しても、板を閉じず、入力を残し、理由を言い、何も書かない', () => {
    const { store, port, refused } = during();
    const onClose = vi.fn();
    render(<SettingsDialog store={port} canEdit onClose={onClose} />);
    const before = store.getState().projectSettings;
    const field = screen.getByLabelText(PROJECT_FIELD_STRINGS.timelineMaxYear);
    fireEvent.change(field, { target: { value: '9000' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(screen.getByTestId('settings-error-documentLoad')).toHaveTextContent(
      APP_STRINGS.editRefusedDuringLoad,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(field).toHaveValue(9000);
    expect(store.getState().projectSettings).toBe(before);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('何も変えていなければ断らずに閉じる', async () => {
    const { port, refused } = during();
    const onClose = vi.fn();
    render(<SettingsDialog store={port} canEdit onClose={onClose} />);
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(refused).not.toHaveBeenCalled();
  });
});
