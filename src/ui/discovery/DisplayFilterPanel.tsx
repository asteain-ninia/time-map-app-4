// U41 — the FR-113 表示制御フィルタ sidebar panel (ui layer, presentational + store-bound).
//
// The display-filter TRUTH is the U16 session store's `filter` slice (種別 / 階層深度 /
// 個別非表示 / 不透明度). This widget RENDERS the current filter and reports intent through
// the SAME store actions the draw / hit-test / search母集合 read (単一真実源, 教訓 5.29) —
// it re-implements no filter logic. Mounted in the SIDEBAR (NOT the topBar — the topBar
// 占有不変量 a4f6be9 must not depend on filter state).
//
// FR-113 vs FR-42 (ユーザー裁定 — the labels make the distinction explicit): the 階層深度
// control here「隠す」(hides features below the drawn set) is a SEPARATE concept from the
// topBar's FR-42 グローバル深度 which「畳む」(rolls the hierarchy up into aggregates). The
// hint text names the difference so a user is not confused by two depth controls.
//
// All controls funnel their raw input through the U41 validation 入口 (validateOpacity /
// validateDepthThreshold, 技術方針 R8) before touching the store; an invalid value is a
// silent no-op (the bounded slider / number input cannot actually produce one, but the
// 共通入口 discipline is honoured — 教訓 5.26).

import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';

import { FEATURE_KIND_AXIS, type FeatureKindAxis } from './axes';
import { emphasisActive, OPACITY_MAX, OPACITY_MIN } from './filter-state';
import { FILTER_STRINGS } from './strings';
import { validateDepthThreshold, validateOpacity } from './validation';

/** One kind-axis row spec (label + testid suffix), in 点 → 線 → 面 order. */
const KIND_ROWS: readonly {
  readonly axis: FeatureKindAxis;
  readonly label: string;
  readonly testid: string;
}[] = [
  { axis: FEATURE_KIND_AXIS.Point, label: FILTER_STRINGS.kindPointLabel, testid: 'point' },
  { axis: FEATURE_KIND_AXIS.Line, label: FILTER_STRINGS.kindLineLabel, testid: 'line' },
  { axis: FEATURE_KIND_AXIS.Area, label: FILTER_STRINGS.kindAreaLabel, testid: 'area' },
];

/** The opacity slider granularity (5% steps — fine enough, still snappy). */
const OPACITY_STEP = 0.05;

/**
 * The FR-113 表示制御フィルタ panel, bound to the live session store's `filter` slice.
 * Generic over the opaque domain root `S` (it never reaches into the domain — the filter
 * is display-only session state).
 */
export function DisplayFilterPanel<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
}): JSX.Element {
  const { store } = props;
  const filter = useStore(store, (s) => s.filter);

  // 個別非表示 count = overrides that actually force-hide (an emphasized-only override does
  // not count). Drives the「全て再表示」button's label + disabled state.
  const hiddenCount = useMemo(() => {
    let n = 0;
    for (const override of filter.individual.values()) if (override.hidden) n += 1;
    return n;
  }, [filter.individual]);

  const depthActive = filter.depthThreshold !== null;

  // FR-113 Phase 2: whether ANY emphasis (種別 / 個別地物 / 深度) is in effect — the SINGLE
  // predicate from filter-state.ts (the widget re-implements no state logic, 教訓 5.29). It
  // drives the「強調をすべて解除」escape hatch's enablement, so a 強調 set from ANYWHERE
  // (右クリック「この地物を強調」included) is escapable from this panel.
  const anyEmphasis = emphasisActive(filter);

  const onOpacity = (raw: number): void => {
    const result = validateOpacity(raw);
    if (result.ok) store.getState().setFilterOpacity(result.value);
  };

  const onDepthToggle = (on: boolean): void => {
    // Turning the axis ON seeds the CURRENT value (or 0); OFF clears it to null (軸オフ).
    store.getState().setFilterDepthThreshold(on ? filter.depthThreshold ?? 0 : null);
  };

  const onDepthValue = (raw: number): void => {
    const result = validateDepthThreshold(raw);
    if (result.ok) store.getState().setFilterDepthThreshold(result.value);
  };

  return (
    <section className="display-filter" data-testid="display-filter">
      <h3 className="display-filter__title">{FILTER_STRINGS.sectionTitle}</h3>
      <p className="display-filter__help">{FILTER_STRINGS.sectionHelp}</p>

      {/* 種別軸 (FR-113): 点 / 線 / 面 の表示切替 */}
      <fieldset className="display-filter__kinds">
        <legend>{FILTER_STRINGS.kindGroupLabel}</legend>
        {KIND_ROWS.map((row) => (
          <label key={row.axis} className="display-filter__kind" title={FILTER_STRINGS.kindGroupHint}>
            <input
              type="checkbox"
              data-testid={`display-filter-kind-${row.testid}`}
              checked={filter.kindVisible[row.axis]}
              onChange={(e) => store.getState().setFilterKindVisible(row.axis, e.target.checked)}
            />
            <span>{row.label}</span>
          </label>
        ))}
      </fieldset>

      {/* 強調軸 — 種別 (FR-113 Phase 2): 点/線/面 を強調し、それ以外を淡く表示する。
          可視軸 (上) と対称の UI 言語だが独立した軸で、強調は可視性を変えない。
          深度強調 (emphasizedDepth) は Phase 3 のため、ここには出さない。 */}
      <fieldset className="display-filter__emphasize-kinds">
        <legend>{FILTER_STRINGS.emphasizeKindGroupLabel}</legend>
        {KIND_ROWS.map((row) => (
          <label
            key={row.axis}
            className="display-filter__kind"
            title={FILTER_STRINGS.emphasizeKindGroupHint}
          >
            <input
              type="checkbox"
              data-testid={`display-filter-emphasize-${row.testid}`}
              checked={filter.emphasizedKinds.has(row.axis)}
              onChange={(e) =>
                store.getState().setFilterKindEmphasized(row.axis, e.target.checked)
              }
            />
            <span>{row.label}</span>
          </label>
        ))}
        <p className="display-filter__emphasize-hint">{FILTER_STRINGS.emphasizeHint}</p>
      </fieldset>

      {/* 強調の脱出口 (FR-113 Phase 2): どの軸で強調していても1操作で戻れる。強調中のみ活性。 */}
      <button
        type="button"
        className="display-filter__clear-emphasis"
        data-testid="display-filter-clear-emphasis"
        disabled={!anyEmphasis}
        onClick={() => store.getState().clearAllEmphasis()}
      >
        {FILTER_STRINGS.emphasizeClearAllLabel}
      </button>

      {/* 不透明度 (FR-113) */}
      <label className="display-filter__opacity" title={FILTER_STRINGS.opacityHint}>
        <span>
          {FILTER_STRINGS.opacityLabel}: {filter.opacity.toFixed(2)}
        </span>
        <input
          type="range"
          data-testid="display-filter-opacity"
          aria-label={FILTER_STRINGS.opacityLabel}
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_STEP}
          value={filter.opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
        />
      </label>

      {/* 階層深度軸 (FR-38 / FR-113): 「隠す」— FR-42「畳む」とは別概念 */}
      <div className="display-filter__depth">
        <label className="display-filter__depth-toggle">
          <input
            type="checkbox"
            data-testid="display-filter-depth-toggle"
            checked={depthActive}
            onChange={(e) => onDepthToggle(e.target.checked)}
          />
          <span>{FILTER_STRINGS.depthLabel}</span>
        </label>
        <input
          type="number"
          className="display-filter__depth-value"
          data-testid="display-filter-depth"
          aria-label={FILTER_STRINGS.depthLabel}
          min={0}
          step={1}
          disabled={!depthActive}
          value={filter.depthThreshold ?? 0}
          onChange={(e) => onDepthValue(Math.max(0, Math.round(Number(e.target.value))))}
        />
        <p className="display-filter__depth-hint">{FILTER_STRINGS.depthHint}</p>
      </div>

      {/* 個別地物軸 (FR-113): 個別非表示の一括再表示 */}
      <button
        type="button"
        className="display-filter__show-all"
        data-testid="display-filter-show-all"
        disabled={hiddenCount === 0}
        onClick={() => store.getState().showAllHiddenFeatures()}
      >
        {FILTER_STRINGS.showAllHiddenLabel(hiddenCount)}
      </button>
    </section>
  );
}
