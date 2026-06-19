// UI layer (U21 / timeline): the SHARED year/month/day input component.
//
// Reused by BOTH the timeline direct-jump field and the property-panel 存在期間
// input (FR-70 / 教訓 5.30). The input/validation/complete-value-handoff core is
// shared; per-use differences (title, allowing "未設定" for an open-ended end)
// are absorbed via props (過剰共有を避ける). The component is a controlled
// React function component and lives entirely in the `ui` layer.
//
// Contract (教訓 5.16 / 5.33 / 5.34): the confirm callback always delivers the
// COMPLETE TimePoint (year + granularity-resolved month/day). It never emits a
// standalone year/month/day partial. The receiver applies it once.

import { useCallback, useState } from 'react';

import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';
import {
  draftFromTimePoint,
  parseYmdDraft,
  ymdErrorMessage,
  type YmdDraft,
} from './ymd-draft';

export interface YearMonthDayInputProps {
  /** Title shown above the field (per-use, e.g. 「直接ジャンプ」「開始時刻」). */
  readonly title: string;
  /** The calendar used for validation (U02). */
  readonly calendar: Calendar;
  /** Initial value (the field syncs to this when it changes via `key`/remount). */
  readonly initialValue: TimePoint;
  /**
   * Confirm handler. Always receives the COMPLETE TimePoint at the granularity
   * the user specified (教訓 5.16: 完全値で一度だけ受け渡し). Called only when
   * validation passes.
   */
  readonly onConfirm: (point: TimePoint) => void;
  /**
   * When true, an explicit "未設定" choice is offered that confirms `null`
   * (used by the 存在期間 end time, FR-70). When omitted, the field is required.
   */
  readonly onClear?: () => void;
  /** Label for the confirm button (default 「反映」). */
  readonly confirmLabel?: string;
}

/**
 * The shared input. Holds its own transient draft + error message. The draft and
 * error are discarded on confirm/clear (教訓 5.2). The error is NOT cleared by
 * unrelated clicks — only by re-typing in a field or a successful confirm
 * (教訓 5.12).
 */
export function YearMonthDayInput(props: YearMonthDayInputProps): JSX.Element {
  const { title, calendar, initialValue, onConfirm, onClear, confirmLabel } = props;

  const [draft, setDraft] = useState<YmdDraft>(() => draftFromTimePoint(initialValue));
  const [error, setError] = useState<string | null>(null);

  // Re-typing in any field clears the prior error (同種の再入力, 教訓 5.12) but
  // unrelated UI interaction does not call these handlers, so the message
  // persists through clicks elsewhere.
  const patch = useCallback((next: Partial<YmdDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
    setError(null);
  }, []);

  const handleConfirm = useCallback(() => {
    const parsed = parseYmdDraft(draft, calendar);
    if (!parsed.ok) {
      setError(ymdErrorMessage(parsed.error));
      return;
    }
    setError(null);
    onConfirm(parsed.point);
  }, [draft, calendar, onConfirm]);

  const handleClear = useCallback(() => {
    if (onClear === undefined) return;
    setError(null);
    onClear();
  }, [onClear]);

  return (
    <div className="ymd-input" data-testid="ymd-input">
      <div className="ymd-input__title">{title}</div>
      <div className="ymd-input__fields">
        <label className="ymd-input__field">
          <span>年</span>
          <input
            type="number"
            aria-label={`${title} 年`}
            value={draft.yearText}
            onChange={(e) => patch({ yearText: e.target.value })}
          />
        </label>

        <label className="ymd-input__field">
          <span>月</span>
          <input
            type="number"
            aria-label={`${title} 月`}
            value={draft.monthText}
            disabled={!draft.monthSpecified}
            onChange={(e) => patch({ monthText: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={!draft.monthSpecified}
            aria-label={`${title} 月 未指定`}
            onClick={() =>
              patch(
                draft.monthSpecified
                  ? { monthSpecified: false, daySpecified: false }
                  : { monthSpecified: true },
              )
            }
          >
            {draft.monthSpecified ? '指定' : '未指定'}
          </button>
        </label>

        <label className="ymd-input__field">
          <span>日</span>
          <input
            type="number"
            aria-label={`${title} 日`}
            value={draft.dayText}
            disabled={!draft.monthSpecified || !draft.daySpecified}
            onChange={(e) => patch({ dayText: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={!draft.daySpecified}
            aria-label={`${title} 日 未指定`}
            disabled={!draft.monthSpecified}
            onClick={() =>
              patch(draft.daySpecified ? { daySpecified: false } : { daySpecified: true })
            }
          >
            {draft.daySpecified ? '指定' : '未指定'}
          </button>
        </label>
      </div>

      {error !== null && (
        <div className="ymd-input__error" role="alert">
          {error}
        </div>
      )}

      <div className="ymd-input__actions">
        <button type="button" onClick={handleConfirm}>
          {confirmLabel ?? '反映'}
        </button>
        {onClear !== undefined && (
          <button type="button" onClick={handleClear}>
            未設定
          </button>
        )}
      </div>
    </div>
  );
}
