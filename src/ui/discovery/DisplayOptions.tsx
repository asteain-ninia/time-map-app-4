// 表示の設定（オプションバーの「表示 ▾」ポップオーバー。増分 4 の中身 7 / C7）。
//
// **これが直すもの**: 表示制御パネルは可変長の一覧の**後ろ**に置かれていたので、
// `offsetTop` が 28,546px（63 画面ぶん下）になり、実装済みなのに誰も辿り着けなかった
// （現状分析 C7 / V5 の 36.4 秒）。オプションバーの設定欄へ移すと 1 クリックで開く。
//
// **中身は 4 つ**（設計書 §E.1 の V5(b) / G-6 / G-22）:
//   1. **種別（FR-40 の札）ごとに 1 行**、各行に［隠す］［薄くする］［目立たせる］の 3 トグル
//   2. 点／線／面 の軸（表示と強調。既存の 2 つをそのまま連れてくる）
//   3. **深さの強調**（G-6。`setEmphasizedDepth` は UI の表示条件の状態
//      （`filter-state.ts`）に在るのに呼び出し元が 1 つも無かった＝現状.md R8）
//   4. 不透明度・階層深度で隠す・個別非表示の一括再表示・強調をすべて解除
//
// **［薄くする］は不透明度 0.25 固定・確定不要・もう一度押すと解除・取り消しの対象外**
// （設計書 §E.1 の V5(b)）。データを変えないので取り消しの単位に載せない（§D.7）。
//
// **置き方**（増分 3 の「吸着 ▾」と同じ作法。`src/ui/add/SnapOptions.tsx` が手本）:
//   - `position: fixed` にしてアンカーの矩形から座標を出す（帯は `overflow: hidden`）
//   - `.display-options__panel[hidden] { display: none }` を **必ず書く**（教訓 5.56:
//     クラスの `display` は `[hidden]` に勝つので、閉じているのに 0,0 に居座って
//     下のボタンのクリックを奪う）
//   - **背面を覆う板を置かない**（K-2）。閉じるのは document の pointerdown を聞く形

import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { featureDisplayName } from '../../domain/feature';
import { derivedDepths, isDepthUndefined } from '../../domain/hierarchy';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';

import { featuresAt } from '../live-lookup';
import { resolveDisplayFor } from '../map/display-resolution-cache';
import { hiddenReasonUnderFilter } from '../map/filtered-display';
import type { OptionBarStore } from '../shell/option-bar';
import { OptionPopover } from '../shell/OptionPopover';
import type { SessionStore } from '../state/store';

import { FEATURE_KIND_AXIS, kindAxisOf, type FeatureKindAxis } from './axes';
import {
  KIND_LABEL_TOGGLE,
  emphasisActive,
  kindLabelToggleOn,
  OPACITY_MAX,
  OPACITY_MIN,
  type KindLabelToggle,
} from './filter-state';
import { FILTER_STRINGS } from './strings';
import { validateDepthThreshold, validateOpacity } from './validation';
import { HIDDEN_REASON } from './visibility';

/** 不透明度のつまみの刻み（5%）。 */
const OPACITY_STEP = 0.05;

/** 点 / 線 / 面 の 3 行（既存のパネルと同じ順・同じ testid）。 */
const KIND_ROWS: readonly {
  readonly axis: FeatureKindAxis;
  readonly label: string;
  readonly testid: string;
}[] = [
  { axis: FEATURE_KIND_AXIS.Point, label: FILTER_STRINGS.kindPointLabel, testid: 'point' },
  { axis: FEATURE_KIND_AXIS.Line, label: FILTER_STRINGS.kindLineLabel, testid: 'line' },
  { axis: FEATURE_KIND_AXIS.Area, label: FILTER_STRINGS.kindAreaLabel, testid: 'area' },
];

/** 種別（札）の 3 トグル（並びは 設計書 §E.1 の V5(b) のとおり）。 */
const LABEL_TOGGLES: readonly {
  readonly toggle: KindLabelToggle;
  readonly label: string;
  readonly testid: string;
}[] = [
  { toggle: KIND_LABEL_TOGGLE.Hide, label: FILTER_STRINGS.kindLabelHide, testid: 'hide' },
  { toggle: KIND_LABEL_TOGGLE.Dim, label: FILTER_STRINGS.kindLabelDim, testid: 'dim' },
  {
    toggle: KIND_LABEL_TOGGLE.Emphasize,
    label: FILTER_STRINGS.kindLabelEmphasize,
    testid: 'emphasize',
  },
];

export interface DisplayOptionsProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
}

export function DisplayOptions<S>(props: DisplayOptionsProps<S>): JSX.Element {
  const { store, getRoot, getTime } = props;
  const filter = useStore(store, (s) => s.filter);
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const displayControl = useStore(store, (s) => s.displayControl);
  const activeFeature = useStore(store, (s) => s.activeFeature);
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const projectLoadNonce = useStore(store, (s) => s.projectLoadNonce);

  // 開閉そのものは共通の器（`shell/OptionPopover`）が持つ。ここが `open` を控えるのは
  // **開いている間だけ数え直す**中身（種別の一覧・外れている知らせ）のためで、真実源は
  // 器の側である（教訓 5.29: 二重の真実源を作らないので、書くのは器だけ・読むのはここだけ）。
  const [open, setOpen] = useState(false);

  // いま世界に在る種別（札）を数える。**アプリは札の一覧を持っていない**（利用者が
  // 自由に書く文字列）ので、そのときのデータから数え直すしかない。開いている間だけ
  // 数えれば足りるので、`open` を依存に入れて閉じているあいだは走らせない。
  const kindLabels = useMemo<readonly { label: string; count: number }[]>(() => {
    if (!open) return [];
    const counts = new Map<string, number>();
    for (const f of featuresAt(getRoot(), getTime())) {
      const label = f.kindLabel ?? '';
      // 教訓 5.18: 空かどうかは長さで決める。札の無いものは行を作らない。
      if (label.length === 0) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [open, getRoot, getTime, domain, currentTime]);

  /**
   * 選んでいる地物が表示条件から外れているか（増分 4 の手直し E1 / 設計書 §D.6）。
   *
   * 外れていても「必ず描く」で地図には出る（規則 1）。**それを黙ってやらない**ための
   * 知らせと、緩めるボタンの材料をここで作る。判定は一覧・描画・当たり判定と同じ
   * 1 本（`hiddenReasonUnderFilter`）を通す（教訓 5.29）。
   */
  const hiddenSelection = useMemo(() => {
    if (!open || activeFeature === null) return null;
    const root = getRoot();
    const time = getTime();
    const resolution = resolveDisplayFor(root, time, displayControl);
    const reason = hiddenReasonUnderFilter(resolution, filter, activeFeature);
    if (reason === null) return null;
    const feature =
      resolution.areaFeaturesById.get(activeFeature) ??
      resolution.features.find((f) => f.id === activeFeature);
    if (feature === undefined) return null;
    const rawDepth = derivedDepths(resolution.forest).get(activeFeature);
    const depth =
      rawDepth === undefined || isDepthUndefined(rawDepth) ? null : rawDepth;
    return {
      reason,
      name: featureDisplayName(feature),
      kindLabel: feature.kindLabel ?? '',
      axis: kindAxisOf(feature.kind),
      depth,
    };
  }, [open, activeFeature, getRoot, getTime, domain, currentTime, filter, displayControl]);

  const hiddenCount = useMemo(() => {
    let n = 0;
    for (const override of filter.individual.values()) if (override.hidden) n += 1;
    return n;
  }, [filter.individual]);

  const depthActive = filter.depthThreshold !== null;
  const depthEmphasisActive = filter.emphasizedDepth !== null;
  const anyEmphasis = emphasisActive(filter);

  return (
    <OptionPopover
      label={FILTER_STRINGS.displayMenuLabel}
      buttonTestId="option-display-button"
      panelTestId="option-display-panel"
      buttonClassName="display-options__button"
      panelClassName="display-options__panel"
      ariaLabel={FILTER_STRINGS.displayMenuLabel}
      /* K-5「状態が移ったら閉じる」。旧版はこの 4 つを ref に控えて自分で比べていたが、
         同じ判断が増分 5 で 3 枚に増えるので、器へ渡す 1 本の指紋に畳んだ。 */
      closeKey={`${mode}|${activeTool ?? ''}|${String(currentTime)}|${projectLoadNonce}`}
      /* 中身の行数（種別の一覧）が変わると高さが変わるので、置き場所を測り直す。 */
      measureKey={kindLabels}
      onOpenChange={setOpen}
    >
      {/* 既存の表示制御パネルと **同じ testid** を持ち越す（T-1: 役割で維持する）。
          置き場所が一覧の下からここへ移っただけで、役割は同じである。 */}
      {() => (
        <section className="display-filter" data-testid="display-filter">
          <h3 className="display-filter__title">{FILTER_STRINGS.sectionTitle}</h3>
          <p className="display-filter__help">{FILTER_STRINGS.sectionHelp}</p>

          {/* 選んでいる地物が表示条件から外れているときの知らせ＋緩める導線（E1）。
              **先頭に置く** ―― 開いた理由がまさにこれであることが多いからである。 */}
          {hiddenSelection !== null && (
            <div className="display-filter__hidden-notice" data-testid="display-hidden-notice">
              <p className="display-filter__hidden-title">
                {FILTER_STRINGS.hiddenSelectionTitle}
              </p>
              <p className="display-filter__help">{FILTER_STRINGS.hiddenSelectionBody}</p>
              {hiddenSelection.reason === HIDDEN_REASON.Individual && (
                <button
                  type="button"
                  className="display-filter__relax"
                  data-testid="display-relax-individual"
                  onClick={() => {
                    store.getState().setFeatureHidden(activeFeature!, false);
                  }}
                >
                  {FILTER_STRINGS.relaxIndividualLabel}
                </button>
              )}
              {hiddenSelection.reason === HIDDEN_REASON.KindLabel && (
                <button
                  type="button"
                  className="display-filter__relax"
                  data-testid="display-relax-kind-label"
                  onClick={() => {
                    store
                      .getState()
                      .setKindLabelToggle(
                        hiddenSelection.kindLabel,
                        KIND_LABEL_TOGGLE.Hide,
                        false,
                      );
                  }}
                >
                  {FILTER_STRINGS.relaxKindLabelLabel(hiddenSelection.kindLabel)}
                </button>
              )}
              {hiddenSelection.reason === HIDDEN_REASON.Kind && (
                <button
                  type="button"
                  className="display-filter__relax"
                  data-testid="display-relax-kind"
                  onClick={() => {
                    store.getState().setFilterKindVisible(hiddenSelection.axis, true);
                  }}
                >
                  {FILTER_STRINGS.relaxKindLabel(kindAxisJaLabel(hiddenSelection.axis))}
                </button>
              )}
              {hiddenSelection.reason === HIDDEN_REASON.Depth &&
                hiddenSelection.depth !== null && (
                  <button
                    type="button"
                    className="display-filter__relax"
                    data-testid="display-relax-depth"
                    onClick={() => {
                      store.getState().setFilterDepthThreshold(hiddenSelection.depth);
                    }}
                  >
                    {FILTER_STRINGS.relaxDepthLabel(hiddenSelection.depth)}
                  </button>
                )}
            </div>
          )}

          {/* 種別（FR-40 の札）ごとに 1 行 × 3 トグル（V5(b)）。 */}
          <fieldset className="display-filter__labels" data-testid="display-filter-kind-labels">
            <legend>{FILTER_STRINGS.kindLabelGroupLabel}</legend>
            <p className="display-filter__emphasize-hint">{FILTER_STRINGS.kindLabelGroupHint}</p>
            {kindLabels.length === 0 ? (
              <p className="display-filter__help" data-testid="display-filter-kind-labels-empty">
                {FILTER_STRINGS.kindLabelEmpty}
              </p>
            ) : (
              kindLabels.map((row) => (
                <div
                  key={row.label}
                  className="display-filter__label-row"
                  data-testid={`display-filter-label-row-${row.label}`}
                >
                  <span className="display-filter__label-name" title={row.label}>
                    {row.label}
                  </span>
                  <span className="display-filter__label-count">
                    {FILTER_STRINGS.kindLabelCount(row.count)}
                  </span>
                  {LABEL_TOGGLES.map((t) => (
                    <button
                      key={t.toggle}
                      type="button"
                      className="display-filter__label-toggle"
                      data-testid={`display-filter-label-${t.testid}-${row.label}`}
                      aria-pressed={kindLabelToggleOn(filter, row.label, t.toggle)}
                      onClick={() =>
                        store
                          .getState()
                          .setKindLabelToggle(
                            row.label,
                            t.toggle,
                            !kindLabelToggleOn(filter, row.label, t.toggle),
                          )
                      }
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              ))
            )}
          </fieldset>

          {/* 点 / 線 / 面 の可視軸（既存）。 */}
          <fieldset className="display-filter__kinds">
            <legend>{FILTER_STRINGS.kindGroupLabel}</legend>
            {KIND_ROWS.map((row) => (
              <label
                key={row.axis}
                className="display-filter__kind"
                title={FILTER_STRINGS.kindGroupHint}
              >
                <input
                  type="checkbox"
                  data-testid={`display-filter-kind-${row.testid}`}
                  checked={filter.kindVisible[row.axis]}
                  onChange={(e) =>
                    store.getState().setFilterKindVisible(row.axis, e.target.checked)
                  }
                />
                <span>{FILTER_STRINGS.kindVisibleRowLabel(row.label)}</span>
              </label>
            ))}
          </fieldset>

          {/* 点 / 線 / 面 の強調軸（既存 = G-22）。 */}
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
                <span>{FILTER_STRINGS.kindEmphasizeRowLabel(row.label)}</span>
              </label>
            ))}
            <p className="display-filter__emphasize-hint">{FILTER_STRINGS.emphasizeHint}</p>
          </fieldset>

          {/* 深さの強調（G-6 / R8）。**`filter-state.ts` に在るのに呼び出し元が 1 つも無かった。** */}
          <div className="display-filter__depth">
            <label className="display-filter__depth-toggle">
              <input
                type="checkbox"
                data-testid="display-filter-emphasize-depth-toggle"
                checked={depthEmphasisActive}
                onChange={(e) =>
                  store
                    .getState()
                    .setFilterEmphasizedDepth(
                      e.target.checked ? (filter.emphasizedDepth ?? 0) : null,
                    )
                }
              />
              <span>{FILTER_STRINGS.emphasizeDepthLabel}</span>
            </label>
            <input
              type="number"
              className="display-filter__depth-value"
              data-testid="display-filter-emphasize-depth"
              aria-label={FILTER_STRINGS.emphasizeDepthLabel}
              min={0}
              step={1}
              disabled={!depthEmphasisActive}
              value={filter.emphasizedDepth ?? 0}
              onChange={(e) => {
                const result = validateDepthThreshold(
                  Math.max(0, Math.round(Number(e.target.value))),
                );
                if (result.ok) store.getState().setFilterEmphasizedDepth(result.value);
              }}
            />
            <p className="display-filter__depth-hint">{FILTER_STRINGS.emphasizeDepthHint}</p>
          </div>

          {/* 強調の脱出口（既存）。 */}
          <button
            type="button"
            className="display-filter__clear-emphasis"
            data-testid="display-filter-clear-emphasis"
            disabled={!anyEmphasis}
            onClick={() => store.getState().clearAllEmphasis()}
          >
            {FILTER_STRINGS.emphasizeClearAllLabel}
          </button>

          {/* 不透明度（既存）。 */}
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
              onChange={(e) => {
                const result = validateOpacity(Number(e.target.value));
                if (result.ok) store.getState().setFilterOpacity(result.value);
              }}
            />
          </label>

          {/* 階層深度で隠す（既存。FR-42 の「畳む」とは別概念）。 */}
          <div className="display-filter__depth">
            <label className="display-filter__depth-toggle">
              <input
                type="checkbox"
                data-testid="display-filter-depth-toggle"
                checked={depthActive}
                onChange={(e) =>
                  store
                    .getState()
                    .setFilterDepthThreshold(
                      e.target.checked ? (filter.depthThreshold ?? 0) : null,
                    )
                }
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
              onChange={(e) => {
                const result = validateDepthThreshold(
                  Math.max(0, Math.round(Number(e.target.value))),
                );
                if (result.ok) store.getState().setFilterDepthThreshold(result.value);
              }}
            />
            <p className="display-filter__depth-hint">{FILTER_STRINGS.depthHint}</p>
          </div>

          {/* 個別非表示の一括再表示（既存。👁 と対になる出口）。 */}
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
      )}
    </OptionPopover>
  );
}

/** 点 / 線 / 面 の軸の日本語（緩めるボタンの文言に使う）。 */
function kindAxisJaLabel(axis: FeatureKindAxis): string {
  switch (axis) {
    case FEATURE_KIND_AXIS.Point:
      return FILTER_STRINGS.kindPointLabel;
    case FEATURE_KIND_AXIS.Line:
      return FILTER_STRINGS.kindLineLabel;
    case FEATURE_KIND_AXIS.Area:
      return FILTER_STRINGS.kindAreaLabel;
  }
}

/**
 * 「表示 ▾」をオプションバーの設定欄へ **常設で** 差し込む配線（描画するものは無い）。
 *
 * **常設（`registerPersistentSlot`）にする理由**: 表示の設定は道具の状態ではない。
 * 読むだけのときも、道具を持っていないときも、面を描いている最中も同じように使える
 * 必要がある。道具の枠（`registerOptionSlot`）へ入れると、道具が帯を持ち直した瞬間に
 * 落ちて画面から消える（`option-bar.ts` の `claim` は持った瞬間に中身を空へ戻す）。
 */
export function DisplayOptionsSlot<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly optionBar: OptionBarStore;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
}): null {
  const { store, optionBar, getRoot, getTime } = props;
  useEffect(
    () =>
      optionBar.registerPersistentSlot(
        'display',
        <DisplayOptions<S> store={store} getRoot={getRoot} getTime={getTime} />,
      ),
    [optionBar, store, getRoot, getTime],
  );
  return null;
}
