// UI layer (U32 / property panel): the anchor section with view切替 (FR-60 /
// FR-84).
//
// Wraps the anchor LIST view and 時間バー view behind a switch control. The
// switch state is local UI state (transient, reset on selection change via the
// keyed remount upstream). BOTH views share the SAME `onSelectAnchor` callback,
// so selecting an anchor from either view takes the single edit-target-selection
// → current-time-sync path (受け入れ基準 7, 教訓 5.6). The view mode is a typed
// constant, not a bare string (教訓 5.19).

import { useState } from 'react';

import type { AnchorEntry, AnchorSeries } from '../../domain/anchor-series';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import type { AnchorRow } from './anchor-diff';
import { AnchorList } from './AnchorList';
import { AnchorTimeBar } from './AnchorTimeBar';
import type { AnchorIntervalEditIntent } from './contracts';
import { PROPERTY_STRINGS } from './messages';

/** The two anchor-display modes (FR-60). A typed constant (教訓 5.19). */
export const ANCHOR_VIEW_MODE = {
  List: 'list',
  TimeBar: 'timeBar',
} as const;

export type AnchorViewMode = (typeof ANCHOR_VIEW_MODE)[keyof typeof ANCHOR_VIEW_MODE];

export interface AnchorSectionProps {
  /** 錨表に出す行（錨とその「前の錨」の組、B2）。 */
  readonly rows: readonly AnchorRow[];
  /** 時間バー表示に渡す系列（FR-60。増分 6 の時刻レールへ移す予定）。 */
  readonly series: AnchorSeries;
  /**
   * 差分の文を作る相手（増分 2 の中身 5）。まとめ役の子を選んでいるときは **その子の
   * id** で、`series` は親のものになる（設計書 §C.6「まとめ役の子の錨」）。
   */
  readonly featureIdForDiff: FeatureId;
  /** 既定で出す範囲（現在時刻の前後）を決めるための現在時刻。 */
  readonly currentTime: TimePoint;
  readonly calendar: Calendar;
  readonly selectedAnchorId: AnchorId | null;
  readonly onSelectAnchor: (entry: AnchorEntry) => void;
  readonly initialMode?: AnchorViewMode;
  /**
   * HB3-12: the target feature id (routing for存続期間 intents). Present only when the
   * host wired the存続期間 dispatch AND the form is editable; its presence (with
   * {@link onEditInterval}) switches the LIST view from read-only to editable.
   */
  readonly featureId?: FeatureId;
  /** HB3-12: dispatch a存続期間 edit; returns an error message to show, or null. */
  readonly onEditInterval?: (intent: AnchorIntervalEditIntent) => string | null;
}

export function AnchorSection(props: AnchorSectionProps): JSX.Element {
  const {
    rows,
    series,
    featureIdForDiff,
    currentTime,
    calendar,
    selectedAnchorId,
    onSelectAnchor,
    featureId,
    onEditInterval,
  } = props;
  const [mode, setMode] = useState<AnchorViewMode>(
    props.initialMode ?? ANCHOR_VIEW_MODE.List,
  );

  return (
    <section className="anchor-section" data-testid="anchor-section">
      <div className="anchor-section__header">
        <h3>{PROPERTY_STRINGS.anchorSectionTitle}</h3>
        <div className="anchor-section__switch" role="group" aria-label={PROPERTY_STRINGS.anchorSectionTitle}>
          <button
            type="button"
            aria-pressed={mode === ANCHOR_VIEW_MODE.List}
            data-testid="anchor-mode-list"
            onClick={() => setMode(ANCHOR_VIEW_MODE.List)}
          >
            {PROPERTY_STRINGS.viewModeList}
          </button>
          <button
            type="button"
            aria-pressed={mode === ANCHOR_VIEW_MODE.TimeBar}
            data-testid="anchor-mode-timebar"
            onClick={() => setMode(ANCHOR_VIEW_MODE.TimeBar)}
          >
            {PROPERTY_STRINGS.viewModeTimeBar}
          </button>
        </div>
      </div>

      {mode === ANCHOR_VIEW_MODE.List ? (
        <AnchorList
          rows={rows}
          featureIdForDiff={featureIdForDiff}
          currentTime={currentTime}
          calendar={calendar}
          selectedAnchorId={selectedAnchorId}
          onSelectAnchor={onSelectAnchor}
          {...(featureId !== undefined && onEditInterval !== undefined
            ? { featureId, onEditInterval }
            : {})}
        />
      ) : (
        <AnchorTimeBar
          series={series}
          calendar={calendar}
          selectedAnchorId={selectedAnchorId}
          onSelectAnchor={onSelectAnchor}
        />
      )}
    </section>
  );
}
