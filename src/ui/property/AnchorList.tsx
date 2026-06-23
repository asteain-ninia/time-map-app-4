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
import { timePointYear } from '../../domain/time/time-point';

import { formatTimePoint } from '../timeline/time-display';

import type { AnchorIntervalEditIntent } from './contracts';
import {
  buildChangeStartIntent,
  buildDeleteAnchorIntent,
  buildSetEndIntent,
} from './interval-edit';
import { PROPERTY_STRINGS } from './messages';

export interface AnchorListProps {
  readonly series: AnchorSeries;
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
  const { series, selectedAnchorId, onSelectAnchor, featureId, onEditInterval } = props;

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
              // at mount ONLY (year granularity). A successful changeStart / setEnd /
              // clear-end re-renders this list from the live root with the NEW interval,
              // but the editor's draft would keep showing the PRE-edit value. Key the
              // editor on the entry's current start & end years so an interval change
              // REMOUNTS it — re-seeding the draft from the new stored value (the same
              // "re-seed draft from source" contract the direct-jump field uses). The
              // open-ended end (`null`) is keyed as 'open' so 継続中にする also re-seeds.
              <AnchorIntervalEditor
                key={`${entry.anchor.id}-${entry.start.year}-${
                  entry.end === null ? 'open' : entry.end.year
                }`}
                entry={entry}
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
 * Per-anchor存続期間 editor (HB3-12). Edits the anchor's 開始年 (U09 changeStart) and
 * 終了年 (U09 setEnd, with a 継続中にする to clear it), and offers この錨を削除 (U09
 * deleteAnchor — disabled for the sole anchor so the feature stays resolvable, INV-5).
 * Each control assembles the typed intent and hands it to `onEditInterval`; the U09 op
 * runs in the command base (single truth source). A rejection message is held inline.
 *
 * Year inputs are seeded from the entry's CURRENT start/end (year granularity — the UI
 * edits whole years, consistent with 基本情報's 開始年/終了年). The draft is local UI
 * state; a successful op re-renders the series from the live root so the row reflects the
 * new interval and the editor re-seeds.
 */
function AnchorIntervalEditor(props: {
  readonly entry: AnchorEntry;
  readonly featureId: FeatureId;
  readonly soleAnchor: boolean;
  readonly onEditInterval: (intent: AnchorIntervalEditIntent) => string | null;
}): JSX.Element {
  const { entry, featureId, soleAnchor, onEditInterval } = props;
  const anchorId = entry.anchor.id;

  const [startYear, setStartYear] = useState<number>(entry.start.year);
  const [endYear, setEndYear] = useState<number>(
    entry.end === null ? entry.start.year + 1 : entry.end.year,
  );
  const [message, setMessage] = useState<string | null>(null);

  const run = (intent: AnchorIntervalEditIntent): void => {
    setMessage(onEditInterval(intent));
  };

  return (
    <details className="anchor-interval" data-testid={`anchor-interval-${anchorId}`}>
      <summary>{PROPERTY_STRINGS.intervalEditTitle}</summary>

      <div className="anchor-interval__row">
        <label className="anchor-interval__field">
          <span>{PROPERTY_STRINGS.startYearEditLabel}</span>
          <input
            type="number"
            aria-label={`${PROPERTY_STRINGS.startYearEditLabel} (${anchorId})`}
            data-testid={`anchor-interval-start-${anchorId}`}
            value={startYear}
            onChange={(e) => setStartYear(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          data-testid={`anchor-interval-apply-start-${anchorId}`}
          onClick={() =>
            run(buildChangeStartIntent(featureId, anchorId, timePointYear(startYear)))
          }
        >
          {PROPERTY_STRINGS.intervalApplyLabel}
        </button>
      </div>

      <div className="anchor-interval__row">
        <label className="anchor-interval__field">
          <span>{PROPERTY_STRINGS.endYearEditLabel}</span>
          <input
            type="number"
            aria-label={`${PROPERTY_STRINGS.endYearEditLabel} (${anchorId})`}
            data-testid={`anchor-interval-end-${anchorId}`}
            value={endYear}
            onChange={(e) => setEndYear(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          data-testid={`anchor-interval-apply-end-${anchorId}`}
          onClick={() =>
            run(buildSetEndIntent(featureId, anchorId, timePointYear(endYear)))
          }
        >
          {PROPERTY_STRINGS.intervalApplyLabel}
        </button>
        <button
          type="button"
          data-testid={`anchor-interval-clear-end-${anchorId}`}
          onClick={() => run(buildSetEndIntent(featureId, anchorId, null))}
        >
          {PROPERTY_STRINGS.intervalClearEndLabel}
        </button>
      </div>

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
