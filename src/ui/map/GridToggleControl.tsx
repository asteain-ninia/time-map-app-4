// UI layer (U18 / map widgets): the 上部バー グリッド表示 quick-toggle (FR-13 ON/OFF切替).
//
// A store-connected control (SurveyControls と同型): the grid-visibility TRUTH is the
// PROJECT setting `projectSettings.gridVisible` in U16's store (FR-109 / 受け入れ基準 9,
// 単一真実源). This widget renders the live value (aria-pressed) and flips it via
// `updateProjectSetting('gridVisible', …)` — the SAME per-scope action the
// SettingsDialog grid checkbox uses (二重真実源を作らない, 教訓 5.29). The store notifies
// the Canvas, whose gridVisible getter is re-read on the next redraw so the graticule
// appears / disappears immediately (FR-13 即時反映, 教訓 5.35; enabled=false → 明示的空
// フレーム, 教訓 5.18).
//
// 上部バー 不変量 (a4f6be9): this is a FIXED, static control — its occupied width depends
// only on its constant label (nowrap), never on the selection / measurement state — so
// mounting it does NOT make the top-bar row's占有幅 depend on anything but the window
// width. All user-visible text comes from GRID_TOGGLE_STRINGS (教訓 5.19).

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';

/** All user-visible text for the grid toggle (教訓 5.19 表示文言は定数を経由する). */
export const GRID_TOGGLE_STRINGS = {
  /** Button label — short + constant width for the topBar fixed-occupancy invariant. */
  label: 'グリッド',
  /** Accessible name / tooltip (FR-13 グリッド(グラティキュール)表示の ON/OFF). */
  ariaLabel: 'グリッド表示切替',
} as const;

export interface GridToggleControlProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

/**
 * The 上部バー グリッド表示 toggle (FR-13). Reflects `projectSettings.gridVisible` as
 * `aria-pressed` and flips it on click through the store's `updateProjectSetting`
 * (which dirty-marks the project — FR-109 永続プロジェクト設定 — and notifies the Canvas
 * for immediate redraw). A static, fixed-width button (topBar 不変量 a4f6be9).
 */
export function GridToggleControl<S>(props: GridToggleControlProps<S>): JSX.Element {
  const { store } = props;
  const gridVisible = useStore(store, (s) => s.projectSettings.gridVisible);

  return (
    <div className="grid-toggle" data-testid="grid-toggle-control">
      <button
        type="button"
        className="grid-toggle__button"
        data-testid="grid-toggle"
        aria-pressed={gridVisible}
        aria-label={GRID_TOGGLE_STRINGS.ariaLabel}
        title={GRID_TOGGLE_STRINGS.ariaLabel}
        onClick={() => store.getState().updateProjectSetting('gridVisible', !gridVisible)}
      >
        {GRID_TOGGLE_STRINGS.label}
      </button>
    </div>
  );
}
