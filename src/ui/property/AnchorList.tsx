// UI layer (U32 / property panel): the anchor LIST view (FR-84) + per-anchor存続期間
// editor (HB3-12, FR-54〜FR-59).
//
// Displays the target feature's anchor series in start-time ascending order — the series
// is taken AS GIVEN from U09 (single source of truth); this component never re-sorts or
// re-validates it (spec §やらないこと). Each row shows the anchor's start (and end /
// 継続中). The currently-selected edit-target anchor is visually marked. Clicking a row
// routes through the SAME edit-target selection path the time-bar uses (受け入れ基準 7:
// single path) via `onSelectAnchor`.
//
// HB3-12 — when `featureId` + `onEditInterval` are wired (editable mode + host dispatch
// bound), each row also gains a存続期間 editor: 開始年 / 終了年 inputs + 反映, 継続中に
// する (clear end), and この錨を削除. These assemble an {@link AnchorIntervalEditIntent}
// and hand it to `onEditInterval` — the component NEVER runs the U09 op itself (it has no
// series-write authority; the command base owns that single truth source, 教訓 5.30). A
// rejected op's message is surfaced inline (no silent no-op, 教訓 5.7 / 5.26).

import { useState } from 'react';

import type { AnchorEntry, AnchorSeries } from '../../domain/anchor-series';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { Calendar } from '../../domain/time/calendar';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';

import { formatTimePoint } from '../timeline/time-display';
import { YearMonthDayInput } from '../timeline/YearMonthDayInput';

import type { AnchorIntervalEditIntent } from './contracts';
import {
  buildChangeStartIntent,
  buildDeleteAnchorIntent,
  buildSetEndIntent,
} from './interval-edit';
import { PROPERTY_STRINGS } from './messages';

/** A granularity-aware key fragment for a TimePoint (remount/re-seed after an edit). */
function timePointKey(point: TimePoint): string {
  switch (point.granularity) {
    case 'year':
      return `y${point.year}`;
    case 'yearMonth':
      return `ym${point.year}-${point.month}`;
    case 'yearMonthDay':
      return `ymd${point.year}-${point.month}-${point.day}`;
  }
}

export interface AnchorListProps {
  readonly series: AnchorSeries;
  /** Calendar used to validate月日 input in the per-anchor存続期間 editor (FR-70, U02). */
  readonly calendar: Calendar;
  /** The currently selected edit-target anchor id, or null. */
  readonly selectedAnchorId: AnchorId | null;
  /** Select an anchor as the edit target (syncs current time to its start). */
  readonly onSelectAnchor: (entry: AnchorEntry) => void;
  /**
   * HB3-12: the target feature id (routing for存続期間 intents). Present (with
   * {@link onEditInterval}) only when the host wired the dispatch AND the form is
   * editable; its presence switches each row from read-only to editable.
   */
  readonly featureId?: FeatureId;
  /** HB3-12: dispatch a存続期間 edit; returns an error message to show, or null. */
  readonly onEditInterval?: (intent: AnchorIntervalEditIntent) => string | null;
}

export function AnchorList(props: AnchorListProps): JSX.Element {
  const { series, calendar, selectedAnchorId, onSelectAnchor, featureId, onEditInterval } = props;

  if (series.entries.length === 0) {
    return (
      <p className="anchor-list__empty" data-testid="anchor-list-empty">
        {PROPERTY_STRINGS.anchorListEmpty}
      </p>
    );
  }

  const editable = featureId !== undefined && onEditInterval !== undefined;
  const soleAnchor = series.entries.length <= 1;

  return (
    <ul className="anchor-list" data-testid="anchor-list" role="listbox">
      {series.entries.map((entry) => {
        const selected = entry.anchor.id === selectedAnchorId;
        return (
          <li key={entry.anchor.id} className="anchor-list__item">
            <button
              type="button"
              role="option"
              aria-selected={selected}
              data-testid={`anchor-row-${entry.anchor.id}`}
              className={selected ? 'anchor-list__row anchor-list__row--selected' : 'anchor-list__row'}
              onClick={() => onSelectAnchor(entry)}
            >
              <span className="anchor-list__time">{formatTimePoint(entry.start)}</span>
              <span className="anchor-list__sep">→</span>
              <span className="anchor-list__time">
                {entry.end === null ? PROPERTY_STRINGS.openEndLabel : formatTimePoint(entry.end)}
              </span>
              {selected && (
                <span className="anchor-list__badge" data-testid="anchor-edit-badge">
                  {PROPERTY_STRINGS.editTargetBadge}
                </span>
              )}
            </button>

            {editable && (
              // The editor seeds its local draft from the entry's CURRENT start/end
              // at mount ONLY. A successful changeStart / setEnd / clear-end re-renders
              // this list from the live root with the NEW interval, but the editor's
              // draft would keep showing the PRE-edit value. Key the editor on the
              // entry's current start & end (granularity-aware, so a月日-only change
              // also differs) so an interval change REMOUNTS it — re-seeding the draft
              // from the new stored value (the same "re-seed draft from source"
              // contract the direct-jump field uses). The open-ended end (`null`) is
              // keyed as 'open' so 継続中にする also re-seeds.
              <AnchorIntervalEditor
                key={`${entry.anchor.id}-${timePointKey(entry.start)}-${
                  entry.end === null ? 'open' : timePointKey(entry.end)
                }`}
                entry={entry}
                calendar={calendar}
                featureId={featureId}
                soleAnchor={soleAnchor}
                onEditInterval={onEditInterval}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Per-anchor存続期間 editor (HB3-12 / FR-70). Edits the anchor's 開始 (U09 changeStart)
 * and 終了 (U09 setEnd, with 継続中にする to clear it), and offers この錨を削除 (U09
 * deleteAnchor — disabled for the sole anchor so the feature stays resolvable, INV-5).
 * Each control assembles the typed intent and hands it to `onEditInterval`; the U09 op
 * runs in the command base (single truth source). A rejection message is held inline.
 *
 * 開始/終了 both use the SHARED {@link YearMonthDayInput} (the SAME component + pure
 * parse/validate core the timeline direct-jump uses, 教訓 5.30) so年月日粒度が選べる
 * (FR-70): month/day left「未指定」falls back to a coarser TimePoint (year / yearMonth),
 * preserving byte-for-byte the previous 年のみ behaviour (後方互換). Out-of-range /
 * malformed月日 are rejected INSIDE that input (ymdErrorMessage) before any dispatch;
 * a domain-level rejection (start≥end, …) surfaces here (intervalRejectionMessage). The
 * end field's onClear dispatches setEnd(null) = 継続中 (open-ended). The whole editor
 * is seeded from the entry's CURRENT start/end at mount; a successful op remounts it via
 * the granularity-aware key upstream so the draft re-seeds.
 */
function AnchorIntervalEditor(props: {
  readonly entry: AnchorEntry;
  readonly calendar: Calendar;
  readonly featureId: FeatureId;
  readonly soleAnchor: boolean;
  readonly onEditInterval: (intent: AnchorIntervalEditIntent) => string | null;
}): JSX.Element {
  const { entry, calendar, featureId, soleAnchor, onEditInterval } = props;
  const anchorId = entry.anchor.id;

  const [message, setMessage] = useState<string | null>(null);

  const run = (intent: AnchorIntervalEditIntent): void => {
    setMessage(onEditInterval(intent));
  };

  // Seed the 終了 field when the anchor is open-ended: default to one year after the
  // start (the previous editor's default), so 反映 without touching it sets a sane end.
  const endSeed: TimePoint = entry.end ?? timePointYear(entry.start.year + 1);

  return (
    <details className="anchor-interval" data-testid={`anchor-interval-${anchorId}`}>
      <summary>{PROPERTY_STRINGS.intervalEditTitle}</summary>

      <p className="anchor-interval__hint">{PROPERTY_STRINGS.intervalGranularityHint}</p>

      <YearMonthDayInput
        title={PROPERTY_STRINGS.intervalStartTitle}
        calendar={calendar}
        initialValue={entry.start}
        confirmLabel={PROPERTY_STRINGS.intervalApplyLabel}
        testId={`anchor-interval-start-${anchorId}`}
        onConfirm={(point) => run(buildChangeStartIntent(featureId, anchorId, point))}
      />

      <YearMonthDayInput
        title={PROPERTY_STRINGS.intervalEndTitle}
        calendar={calendar}
        initialValue={endSeed}
        confirmLabel={PROPERTY_STRINGS.intervalApplyLabel}
        clearLabel={PROPERTY_STRINGS.intervalClearEndLabel}
        testId={`anchor-interval-end-${anchorId}`}
        onConfirm={(point) => run(buildSetEndIntent(featureId, anchorId, point))}
        onClear={() => run(buildSetEndIntent(featureId, anchorId, null))}
      />

      <button
        type="button"
        className="anchor-interval__delete"
        data-testid={`anchor-interval-delete-${anchorId}`}
        disabled={soleAnchor}
        onClick={() => run(buildDeleteAnchorIntent(featureId, anchorId))}
      >
        {PROPERTY_STRINGS.intervalDeleteLabel}
      </button>

      {message !== null && (
        <p
          className="anchor-interval__message"
          role="alert"
          data-testid={`anchor-interval-message-${anchorId}`}
        >
          {message}
        </p>
      )}
    </details>
  );
}
