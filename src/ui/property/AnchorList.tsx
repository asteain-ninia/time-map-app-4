// UI layer (U32 / property panel): the anchor LIST view (FR-84).
//
// Displays the target feature's anchor series in start-time ascending order —
// the series is taken AS GIVEN from U09 (single source of truth); this component
// never re-sorts or re-validates it (spec §やらないこと). Each row shows the
// anchor's start (and end / 継続中). The currently-selected edit-target anchor is
// visually marked. Clicking a row routes through the SAME edit-target selection
// path the time-bar uses (受け入れ基準 7: single path) via `onSelectAnchor`.

import type { AnchorEntry, AnchorSeries } from '../../domain/anchor-series';
import type { AnchorId } from '../../domain/ids';

import { formatTimePoint } from '../timeline/time-display';

import { PROPERTY_STRINGS } from './messages';

export interface AnchorListProps {
  readonly series: AnchorSeries;
  /** The currently selected edit-target anchor id, or null. */
  readonly selectedAnchorId: AnchorId | null;
  /** Select an anchor as the edit target (syncs current time to its start). */
  readonly onSelectAnchor: (entry: AnchorEntry) => void;
}

export function AnchorList(props: AnchorListProps): JSX.Element {
  const { series, selectedAnchorId, onSelectAnchor } = props;

  if (series.entries.length === 0) {
    return (
      <p className="anchor-list__empty" data-testid="anchor-list-empty">
        {PROPERTY_STRINGS.anchorListEmpty}
      </p>
    );
  }

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
          </li>
        );
      })}
    </ul>
  );
}
