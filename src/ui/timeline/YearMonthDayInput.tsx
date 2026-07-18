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
  /** Label for the clear button (default 「未設定」; e.g. 「継続中にする」for存続期間 end). */
  readonly clearLabel?: string;
  /**
   * Optional test id root. When set, the wrapper uses it (instead of the default
   * 'ymd-input') and each control gets a derived `${testId}-year|month|day|...`
   * id — needed when several inputs coexist (the per-anchor存続期間 list, FR-70).
   * Omitted for the single timeline jump field, whose DOM is left unchanged.
   */
  readonly testId?: string;
}

/**
 * The shared input. Holds its own transient draft + error message. The draft and
 * error are discarded on confirm/clear (教訓 5.2). The error is NOT cleared by
 * unrelated clicks — only by re-typing in a field or a successful confirm
 * (教訓 5.12).
 */
export function YearMonthDayInput(props: YearMonthDayInputProps): JSX.Element {
  const { title, calendar, initialValue, onConfirm, onClear, confirmLabel, clearLabel, testId } =
    props;

  // Derive a per-control test id when a root is provided (list context), else omit
  // the attribute so the timeline field's DOM stays byte-for-byte unchanged.
  const tid = (suffix: string): string | undefined =>
    testId !== undefined ? `${testId}-${suffix}` : undefined;

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
    <div className="ymd-input" data-testid={testId ?? 'ymd-input'}>
      <div className="ymd-input__title">{title}</div>
      <div className="ymd-input__fields">
        <label className="ymd-input__field">
          <span>年</span>
          <input
            type="number"
            aria-label={`${title} 年`}
            data-testid={tid('year')}
            value={draft.yearText}
            onChange={(e) => patch({ yearText: e.target.value })}
          />
        </label>

        <label className="ymd-input__field">
          <span>月</span>
          <input
            type="number"
            aria-label={`${title} 月`}
            data-testid={tid('month')}
            value={draft.monthText}
            disabled={!draft.monthSpecified}
            onChange={(e) => patch({ monthText: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={!draft.monthSpecified}
            aria-label={`${title} 月 未指定`}
            data-testid={tid('month-toggle')}
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
            data-testid={tid('day')}
            value={draft.dayText}
            disabled={!draft.monthSpecified || !draft.daySpecified}
            onChange={(e) => patch({ dayText: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={!draft.daySpecified}
            aria-label={`${title} 日 未指定`}
            data-testid={tid('day-toggle')}
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
        <div className="ymd-input__error" role="alert" data-testid={tid('error')}>
          {error}
        </div>
      )}

      <div className="ymd-input__actions">
        <button type="button" data-testid={tid('confirm')} onClick={handleConfirm}>
          {confirmLabel ?? '反映'}
        </button>
        {onClear !== undefined && (
          <button type="button" data-testid={tid('clear')} onClick={handleClear}>
            {clearLabel ?? '未設定'}
          </button>
        )}
      </div>
    </div>
  );
}
