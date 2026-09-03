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
// K-6「読むだけ」— **このボタンは保存ファイルに書かない**（2026-09-04 の再修正）。
//
// 一度は「実体がプロジェクト設定 `gridVisible` の書き換えだから、読むだけでは押させない」
// としたが、それは裁定の片側しか見ていなかった。所有者の裁定は「読むだけ＝**選べる・読める**・
// 直せない」であり、**起動直後は常に読むだけ**なので、開いて眺めるだけの人はグリッドを
// 一度も消せなくなる（「読める」を損ねる）。
//
// そこで置き場を分けた。上部バーのこのトグルは **セッション限りの上書き**
// （`SessionState.gridVisibleOverride`）だけを書く: `.gimoza` には入らず、未保存の印も
// 立たない。保存される既定値を変えられるのは設定ダイアログの項目だけで、そちらは従来どおり
// 編集の権限を要る。描画側は「上書きがあればそれ、無ければプロジェクト設定」で読む
// （`App.tsx` の gridVisible ゲッター）。同じ形の先例が右クリックの個別非表示・強調
// （FR-113、セッション限り）である。

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

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
  // 見せるかどうかの **実効値**: セッション限りの上書きがあればそれ、無ければ
  // プロジェクト設定（描画側 `App.tsx` の gridVisible ゲッターと同じ規則）。
  const gridVisible = useStore(
    store,
    (s) => s.gridVisibleOverride ?? s.projectSettings.gridVisible,
  );

  return (
    <div className="grid-toggle" data-testid="grid-toggle-control">
      <button
        type="button"
        className="grid-toggle__button"
        data-testid="grid-toggle"
        aria-pressed={gridVisible}
        aria-label={GRID_TOGGLE_STRINGS.ariaLabel}
        title={GRID_TOGGLE_STRINGS.ariaLabel}
        onClick={() => {
          // **セッション限りの上書きだけを書く**（K-6）。保存ファイルには入らないので
          // 未保存の印も立たず、「読むだけ」でも押せる。保存される既定値を変えられるのは
          // 設定ダイアログだけで、そちらは従来どおり編集の権限を要る。
          store.getState().setGridVisibleOverride(!gridVisible);
        }}
      >
        {GRID_TOGGLE_STRINGS.label}
      </button>
    </div>
  );
}
