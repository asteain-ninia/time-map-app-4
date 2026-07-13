// Display hierarchy-depth control (U34 / FR-42 グローバル階層深度スライダー + FR-43
// 個別フォーカス). UI layer: a presentational + callback-driven React component
// (技術方針 2.3). The display-control TRUTH lives in U16's session store
// (displayControl: グローバル深度 N + 個別フォーカス M) — this widget renders the
// current N / focus and reports user intent via callbacks; the wiring unit applies
// them through the store's setGlobalDepth / setDisplayFocus / … actions (教訓 5.7:
// これらの setter は実装済みで、欠けていたのは本 UI だけ = 未マウント資産の結線).
//
// FR-42 非干渉: this is a SEPARATE display axis from mode/tool/selection — changing
// the depth or focus never touches edit/add mode or any draft (store slice分離).
// Mounted in the 上部バー beside the 経度シフト so the two view controls 併存する
// (FR-43「グローバル深度スライダーと併存する」).

import { DISPLAY_CONTROL_STRINGS } from '../shell/index';

export interface GlobalDepthControlProps {
  /** The global hierarchy-depth threshold N (FR-42). */
  readonly globalDepth: number;
  /**
   * The maximum derivable depth in the LIVE forest (U08 maxDerivedDepth). The slider
   * upper bound is `max(maxDepth, 1)` so the control stays operable even when the data
   * is entirely top-level (現状のデーレ実データ) — N beyond maxDepth is a harmless no-op
   * (階層深度≤N は N≥maxDepth で全展開) but keeps the widget demonstrably functional.
   */
  readonly maxDepth: number;
  /** Set the global depth N (FR-42) — clamped by the wiring at the store boundary. */
  readonly onGlobalDepth: (depth: number) => void;

  /**
   * The selected feature's short label (name→id fallback), or null when nothing is
   * selected. The 個別フォーカス section (FR-43) is shown ONLY when a feature is
   * selected OR a focus is already active — no dead control (教訓 5.7): 個別フォーカス
   * is「選択中地物の縦方向領域」, so it needs a selection to target.
   */
  readonly activeFeatureLabel: string | null;
  /** Whether an individual focus is currently active in the store (originId !== null). */
  readonly focusActive: boolean;
  /** The per-focus depth threshold M (FR-43). */
  readonly focusDepth: number;
  /** Whether the vertical-region emphasis is on (FR-43 / FR-82). */
  readonly focusEmphasize: boolean;
  /** Apply the individual focus onto the selected feature at depth M (FR-43). */
  readonly onApplyFocus: () => void;
  /** Set the per-focus depth M (FR-43). */
  readonly onFocusDepth: (depth: number) => void;
  /** Toggle the emphasis flag (FR-43 / FR-82). */
  readonly onEmphasize: (on: boolean) => void;
  /** Clear the individual focus — revert to global N only (教訓 5.2). */
  readonly onClearFocus: () => void;
}

/** The lowest slider ceiling so the control is always operable (see maxDepth doc). */
const MIN_SLIDER_MAX = 1;

export function GlobalDepthControl(props: GlobalDepthControlProps): JSX.Element {
  const {
    globalDepth,
    maxDepth,
    onGlobalDepth,
    activeFeatureLabel,
    focusActive,
    focusDepth,
    focusEmphasize,
    onApplyFocus,
    onFocusDepth,
    onEmphasize,
    onClearFocus,
  } = props;

  const sliderMax = Math.max(maxDepth, MIN_SLIDER_MAX);
  const clampN = (n: number): number => Math.min(Math.max(0, Math.round(n)), sliderMax);
  const setN = (n: number): void => {
    const next = clampN(n);
    if (next !== globalDepth) onGlobalDepth(next);
  };

  // 第6工程 (B2 root fix): the 個別フォーカス group is ALWAYS rendered at a CONSTANT
  // width — its controls DISABLE (never disappear) when their precondition is absent.
  // The previous selection-gated render made the 上部バー's occupied width depend on
  // the SELECTION: selecting/deselecting re-wrapped the menu-bar row (auto height)
  // and the whole MAP CELL jumped 28px (depth-control / human-bugs-3 / resize-coord
  // / aggregate-select / edit-drag-preview の共通根 — 5c72420 の測量コントロール追加で
  // 上部バーの余白が尽きて顕在化). Layout may depend on the WINDOW SIZE only, never
  // on the selection. A disabled affordance with an honest hint is not a dead
  // control (教訓 5.7 の趣旨は「配線されず機能しない UI を作らない」— these are fully
  // wired and enable exactly when their precondition holds).
  const canApplyFocus = activeFeatureLabel !== null;

  return (
    <div className="global-depth" data-testid="global-depth">
      <div className="global-depth__readout" data-testid="global-depth-readout">
        {DISPLAY_CONTROL_STRINGS.globalDepthLabel}: {globalDepth}
        <span className="global-depth__max"> / {sliderMax}</span>
      </div>

      <input
        type="range"
        className="global-depth__slider"
        data-testid="global-depth-slider"
        aria-label={DISPLAY_CONTROL_STRINGS.globalDepthLabel}
        title={DISPLAY_CONTROL_STRINGS.globalDepthHint}
        min={0}
        max={sliderMax}
        step={1}
        value={Math.min(globalDepth, sliderMax)}
        onChange={(e) => setN(Number(e.target.value))}
      />

      <div className="global-depth__buttons">
        <button
          type="button"
          aria-label="階層深度を下げる"
          disabled={globalDepth <= 0}
          onClick={() => setN(globalDepth - 1)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="階層深度を上げる"
          disabled={globalDepth >= sliderMax}
          onClick={() => setN(globalDepth + 1)}
        >
          ＋
        </button>
      </div>

      {/* ALWAYS rendered, constant width (B2 invariant — see canApplyFocus note).
          The apply button's label carries the feature name, so it is ellipsized at a
          FIXED width (.global-depth__focus-apply); title= holds the full label. */}
      <div className="global-depth__focus" data-testid="depth-focus">
        <span className="global-depth__focus-label">{DISPLAY_CONTROL_STRINGS.focusLabel}</span>

        <button
          type="button"
          className="global-depth__focus-apply"
          data-testid="depth-focus-apply"
          disabled={!canApplyFocus}
          title={activeFeatureLabel ?? DISPLAY_CONTROL_STRINGS.focusNoTargetHint}
          onClick={onApplyFocus}
        >
          {activeFeatureLabel === null
            ? DISPLAY_CONTROL_STRINGS.focusNoTargetLabel
            : focusActive
              ? `${activeFeatureLabel} に切替`
              : `${activeFeatureLabel} を深掘り`}
        </button>

        {/* The per-focus depth M + emphasis + clear enable only while a focus is
            live — disabled (not hidden) otherwise, so the group's width is constant. */}
        <label className="global-depth__focus-depth">
          <span>{DISPLAY_CONTROL_STRINGS.focusDepthLabel}</span>
          <input
            type="number"
            data-testid="depth-focus-depth"
            aria-label={DISPLAY_CONTROL_STRINGS.focusDepthLabel}
            min={0}
            step={1}
            disabled={!focusActive}
            value={focusDepth}
            onChange={(e) =>
              onFocusDepth(Math.max(0, Math.round(Number(e.target.value))))
            }
          />
        </label>

        <label className="global-depth__focus-emph">
          <input
            type="checkbox"
            data-testid="depth-focus-emphasize"
            disabled={!focusActive}
            checked={focusEmphasize}
            onChange={(e) => onEmphasize(e.target.checked)}
          />
          <span>{DISPLAY_CONTROL_STRINGS.emphasizeLabel}</span>
        </label>

        <button
          type="button"
          data-testid="depth-focus-clear"
          disabled={!focusActive}
          onClick={onClearFocus}
        >
          {DISPLAY_CONTROL_STRINGS.clearFocusLabel}
        </button>
      </div>
    </div>
  );
}
