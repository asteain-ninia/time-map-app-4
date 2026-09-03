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
//
// K-6「読むだけ」(教訓 5.13 / 所有者裁定「読むだけの間は保存ファイルの中身を書き換える
// 操作をすべて止める」): このボタンは**見え方の切替に見えて、実体はプロジェクト設定
// `gridVisible` の書き換え**である（FR-109 永続プロジェクト設定 = .gimoza に入り、押した
// だけで未保存状態になる）。同じ「表示」でも、右クリックの個別非表示・強調（FR-113）は
// セッション限りでファイルに残らないので「読むだけ」でも使える — 分かれ目は「見え方かどうか」
// ではなく「保存ファイルに書くかどうか」。そこで表示専用モードでは無効化し、押下ハンドラ
// でも同じ canEdit(mode) をもう一度確かめる（見た目だけの封鎖にしない）。

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { canEdit } from '../shell/permissions';
import type { SessionStore } from '../state/store';

/** All user-visible text for the grid toggle (教訓 5.19 表示文言は定数を経由する). */
export const GRID_TOGGLE_STRINGS = {
  /** Button label — short + constant width for the topBar fixed-occupancy invariant. */
  label: 'グリッド',
  /** Accessible name / tooltip (FR-13 グリッド(グラティキュール)表示の ON/OFF). */
  ariaLabel: 'グリッド表示切替',
  /**
   * K-6: 「読むだけ」で無効になっている理由（tooltip）。無効の理由を言わない無効ボタンは
   * 「壊れている」と読まれる（教訓 5.7 の死んだボタンと見分けがつかない）ので必ず出す。
   */
  viewOnlyTitle: 'グリッド表示切替（「読むだけ」の間は変更できません。この設定は保存ファイルに入ります）',
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
  // 権限の判定は shell の canEdit(mode) 1 本（教訓 5.13）。ここで `mode !== View` を
  // 素書きしない — 素書きが散ったせいで K-6 の穴（削除ボタンだけ押せた）が生まれた。
  const editable = useStore(store, (s) => canEdit(s.mode));

  return (
    <div className="grid-toggle" data-testid="grid-toggle-control">
      <button
        type="button"
        className="grid-toggle__button"
        data-testid="grid-toggle"
        aria-pressed={gridVisible}
        aria-label={GRID_TOGGLE_STRINGS.ariaLabel}
        title={editable ? GRID_TOGGLE_STRINGS.ariaLabel : GRID_TOGGLE_STRINGS.viewOnlyTitle}
        disabled={!editable}
        onClick={() => {
          // 見た目（disabled）だけに頼らない: 書き込みの直前でもう一度確かめる（教訓 5.13）。
          if (!editable) return;
          store.getState().updateProjectSetting('gridVisible', !gridVisible);
        }}
      >
        {GRID_TOGGLE_STRINGS.label}
      </button>
    </div>
  );
}
