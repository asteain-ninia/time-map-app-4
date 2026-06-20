// UI layer (U39): the load-time consistency AUTO-REPAIR DIALOG BODY (FR-106 / §C).
//
// This is the renderable React component the spec §C requires: the per-
// inconsistency repair-option selection UI mounted on U20's DraggablePanel modal
// vessel (spec §依存 U20). It RENDERS `buildRepairRows(report)` — one row per
// detected inconsistency with its kind label, related feature names, 作中時刻 /
// 時間範囲, sub-cause detail, and the per-kind repair OPTIONS (built dynamically
// from U14 per inconsistency, never shared across kinds, 過剰共有の戒め). The user
// picks an option per row via `setRepairChoice`; 「修復して読み込む」is enabled only
// when `allChoicesMade` is true; it resolves the collected {@link RepairChoices}
// back to `promptRepair`. 「読み込みを中止」resolves null (修復せず中止).
//
// The dialog owns NO repair logic — detection / options / apply + re-validation
// all live in U14; this is presentation over the pure flow model (受け入れ基準 7).

import { useCallback, useMemo, useRef, useState } from 'react';

import { DraggablePanel } from '../shell/DraggablePanel';
import { idToString } from '../../domain/ids';
import type {
  ConsistencyReport,
  Inconsistency,
  RepairOptionId,
} from '../../domain/persistence/index';
import {
  EMPTY_REPAIR_CHOICES,
  allChoicesMade,
  buildRepairRows,
  describeInconsistency,
  setRepairChoice,
  type RepairChoices,
} from './repair-flow';
import { REPAIR_STRINGS } from './strings';

export interface RepairDialogProps {
  /** The U14 consistency report to present (non-empty when this dialog is shown). */
  readonly report: ConsistencyReport;
  /**
   * Resolve the user's decision: the per-inconsistency choices to apply, or null
   * to abort the load (読み込みを中止). Wired to `FileCommandPorts.promptRepair`.
   */
  readonly onResolve: (choices: RepairChoices | null) => void;
  /**
   * Optional notice shown above the list when a previous repair attempt did not
   * resolve everything (受け入れ基準 3 末項: re-present the still-broken rows).
   */
  readonly unresolved?: boolean;
  /** Front-most z-index from U20's z-order model (FR-112 前面化). */
  readonly zIndex?: number;
}

const INITIAL_POSITION = { x: 280, y: 120 } as const;

/** Render one inconsistency's 作中時刻 / 時間範囲, when time-scoped (FR-106 一覧項目). */
function timeScopeOf(inc: Inconsistency): string | null {
  if (inc.atTime !== undefined) {
    return `${REPAIR_STRINGS.fieldTime}: ${String(inc.atTime.year)}`;
  }
  if (inc.timeRange !== undefined) {
    const end = inc.timeRange.end === null ? '—' : String(inc.timeRange.end.year);
    return `${REPAIR_STRINGS.fieldRange}: ${String(inc.timeRange.start.year)} 〜 ${end}`;
  }
  return null;
}

/** Feature ids line (always shown so every row is traceable even without names). */
function idsOf(inc: Inconsistency): string {
  return inc.featureIds.map(idToString).join('、');
}

export function RepairDialog(props: RepairDialogProps): JSX.Element {
  const { report, onResolve, unresolved, zIndex } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The rows are derived ONCE from the report (the option lists come from U14 per
  // inconsistency, 動的・種別ごと, 過剰共有しない).
  const rows = useMemo(() => buildRepairRows(report), [report]);
  const [choices, setChoices] = useState<RepairChoices>(EMPTY_REPAIR_CHOICES);

  const complete = allChoicesMade(rows, choices);

  const choose = useCallback((index: number, optionId: RepairOptionId) => {
    setChoices((prev) => setRepairChoice(prev, index, optionId));
  }, []);

  // Esc / 中止 resolve null (修復せず読み込まない): the safe default keeps current state.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onResolve(null);
      }
    },
    [onResolve],
  );

  return (
    <div
      className="repair-modal-root"
      data-testid="repair-modal-root"
      role="dialog"
      aria-modal="true"
      aria-label={REPAIR_STRINGS.title}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <DraggablePanel
        id="repair-dialog"
        title={REPAIR_STRINGS.title}
        initialPosition={INITIAL_POSITION}
        zIndex={zIndex ?? 1000}
        onClose={() => onResolve(null)}
      >
        <div className="repair-dialog" data-testid="repair-dialog">
          <p className="repair-dialog__intro">{REPAIR_STRINGS.intro}</p>
          {unresolved === true && (
            <p className="repair-dialog__unresolved" role="alert" data-testid="repair-unresolved">
              {REPAIR_STRINGS.unresolved}
            </p>
          )}

          <ul className="repair-dialog__list" data-testid="repair-list">
            {rows.map((row) => {
              const scope = timeScopeOf(row.inconsistency);
              return (
                <li
                  key={row.index}
                  className="repair-row"
                  data-testid={`repair-row-${String(row.index)}`}
                >
                  <p className="repair-row__summary">{describeInconsistency(row.inconsistency)}</p>
                  <p className="repair-row__ids">ID: {idsOf(row.inconsistency)}</p>
                  {scope !== null && <p className="repair-row__time">{scope}</p>}
                  {row.inconsistency.detail !== undefined && (
                    <p className="repair-row__detail">{row.inconsistency.detail}</p>
                  )}

                  {/* The per-kind options come from U14 for THIS inconsistency
                      (動的・種別ごと, 過剰共有しない). */}
                  <fieldset className="repair-row__options">
                    <legend className="repair-row__options-legend">
                      {REPAIR_STRINGS.intro}
                    </legend>
                    {row.options.map((option) => (
                      <label key={option.id} className="repair-row__option">
                        <input
                          type="radio"
                          name={`repair-${String(row.index)}`}
                          data-testid={`repair-option-${String(row.index)}-${option.id}`}
                          aria-label={option.label}
                          checked={choices.get(row.index) === option.id}
                          onChange={() => choose(row.index, option.id)}
                        />
                        {option.label}
                      </label>
                    ))}
                  </fieldset>
                </li>
              );
            })}
          </ul>

          <div className="repair-dialog__actions">
            <button
              type="button"
              className="repair-dialog__abort"
              data-testid="repair-abort"
              onClick={() => onResolve(null)}
            >
              {REPAIR_STRINGS.abort}
            </button>
            <button
              type="button"
              className="repair-dialog__apply"
              data-testid="repair-apply"
              disabled={!complete}
              onClick={() => onResolve(choices)}
            >
              {REPAIR_STRINGS.apply}
            </button>
          </div>
        </div>
      </DraggablePanel>
    </div>
  );
}
