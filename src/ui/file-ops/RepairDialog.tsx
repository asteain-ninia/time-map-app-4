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
//
// 増分 8D（N-22 / 設計書 §E.1 の V14 の手順 (b)）で次のように整理した:
//   - 各行に冒頭の長い説明文を繰り返さない（以前は行ごとの fieldset の見出しに冒頭の
//     説明文をそのまま入れていた）。
//   - **直し方が 1 つしか無い行はラジオを出さず「こう直します: …」と書くだけ**。何種類が
//     1 つきりかは決め打ちせず、U14 が返した方法の数で決める（U14 の側で増減しても崩れない）。
//   - どの行も最初（おすすめ）の方法を選んだ状態から始める ―― 読んで［修復して読み込む］を
//     押すだけで済む（手順 (b) の 6.6 秒）。
//   - 内部の ID（`f-5-4`）・項目名（`childIds` / `parentId`）・機械向けの符号は画面に出さない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DraggablePanel } from '../shell/DraggablePanel';
import { useModalKeydown } from '../a11y/index';
import type {
  ConsistencyReport,
  Inconsistency,
  RepairOptionId,
} from '../../domain/persistence/index';
import {
  allChoicesMade,
  buildRepairRows,
  defaultRepairChoices,
  describeInconsistency,
  describeInconsistencyDetail,
  repairOptionText,
  setRepairChoice,
  type RepairChoices,
  type RepairRowContext,
} from './repair-flow';
import type { RepairNamer } from './repair-names';
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
  /**
   * 対象の地物を名前で呼ぶための引き先（増分 8D の手直し / 設計書 §H.1）。読み込んだ
   * プロジェクトから作る（{@link buildRepairNamer}）。無ければ報告の名前の欄だけで呼ぶ。
   */
  readonly namer?: RepairNamer | undefined;
  /**
   * 選択肢を並べるために見る、読み込んだプロジェクト（2026-10-04、ガード B）。読み込みの流れが
   * 適用に使う行と **同じ context** で並べる。無ければ報告だけで並べる。
   */
  readonly context?: RepairRowContext | undefined;
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

export function RepairDialog(props: RepairDialogProps): JSX.Element {
  const { report, onResolve, unresolved, zIndex, namer, context } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The rows are derived ONCE from the report (the option lists come from U14 per
  // inconsistency, 動的・種別ごと, 過剰共有しない).
  const rows = useMemo(() => buildRepairRows(report, context), [report, context]);
  // どの行も最初（おすすめ）の方法を選んだ状態から始める（増分 8D）。
  const [choices, setChoices] = useState<RepairChoices>(() => defaultRepairChoices(rows));

  const complete = allChoicesMade(rows, choices);

  const choose = useCallback((index: number, optionId: RepairOptionId) => {
    setChoices((prev) => setRepairChoice(prev, index, optionId));
  }, []);

  // Esc / 中止 resolve null (修復せず読み込まない): the safe default keeps current
  // state. Esc + Tab wrap come from the shared trap (教訓 5.13); focus the dialog on
  // mount so the keyboard drives it from the start.
  const abort = useCallback(() => onResolve(null), [onResolve]);
  const onKeyDown = useModalKeydown(rootRef, abort);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

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
              const detail = describeInconsistencyDetail(row.inconsistency);
              const single = row.options.length === 1 ? row.options[0] : undefined;
              return (
                <li
                  key={row.index}
                  className="repair-row"
                  data-testid={`repair-row-${String(row.index)}`}
                >
                  <p className="repair-row__summary">
                    {describeInconsistency(row.inconsistency, namer)}
                  </p>
                  {scope !== null && <p className="repair-row__time">{scope}</p>}
                  {detail !== null && <p className="repair-row__detail">{detail}</p>}
                  {row.note !== undefined && (
                    <p className="repair-row__note" data-testid={`repair-note-${String(row.index)}`}>
                      {row.note}
                    </p>
                  )}

                  {/* The per-kind options come from U14 for THIS inconsistency
                      (動的・種別ごと, 過剰共有しない). 1 つしか無ければ選ばせない（N-22）。 */}
                  {single !== undefined ? (
                    <p
                      className="repair-row__fix"
                      data-testid={`repair-fix-${String(row.index)}`}
                    >
                      {REPAIR_STRINGS.fixLabel}
                      {repairOptionText(single, row.inconsistency, namer)}
                    </p>
                  ) : (
                    <fieldset className="repair-row__options">
                      <legend className="repair-row__options-legend">
                        {REPAIR_STRINGS.chooseLegend}
                      </legend>
                      {row.options.map((option) => (
                        <label key={option.id} className="repair-row__option">
                          <input
                            type="radio"
                            name={`repair-${String(row.index)}`}
                            data-testid={`repair-option-${String(row.index)}-${option.id}`}
                            aria-label={repairOptionText(option, row.inconsistency, namer)}
                            checked={choices.get(row.index) === option.id}
                            onChange={() => choose(row.index, option.id)}
                          />
                          {repairOptionText(option, row.inconsistency, namer)}
                        </label>
                      ))}
                    </fieldset>
                  )}
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
