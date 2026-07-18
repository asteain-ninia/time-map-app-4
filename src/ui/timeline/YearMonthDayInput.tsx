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
  EMPTY_YMD_DRAFT,
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
  /**
   * Initial value (the field syncs to this when it changes via `key`/remount).
   *
   * `null` models an OPEN-ENDED value (継続中, FR-70 F2): a CLEARABLE field (one with
   * {@link onClear}) seeded with `null` starts in the OPEN state — the date fields are
   * empty + disabled and a「継続中」indicator shows, so an untouched confirm can never
   * emit a FABRICATED concrete TimePoint. Emitting a concrete value requires the explicit
   * 「終了を指定」action ({@link specifyLabel}). A REQUIRED field (no `onClear`, e.g. the
   * timeline direct-jump) is always seeded with a concrete TimePoint, so its DOM/behaviour
   * is byte-for-byte unchanged (加算的 optional — the `null` path is unreachable there).
   */
  readonly initialValue: TimePoint | null;
  /**
   * Confirm handler. Always receives the COMPLETE TimePoint at the granularity
   * the user specified (教訓 5.16: 完全値で一度だけ受け渡し). Called only when
   * validation passes.
   */
  readonly onConfirm: (point: TimePoint) => void;
  /**
   * When set, an explicit "未設定" choice is offered that confirms `null` (used by the
   * 存在期間 end time, FR-70). Its presence ALSO enables the open-ended (`null`
   * {@link initialValue}) modeling above. When omitted, the field is required.
   */
  readonly onClear?: () => void;
  /** Label for the confirm button (default 「反映」). */
  readonly confirmLabel?: string;
  /** Label for the clear button (default 「未設定」; e.g. 「継続中にする」for存続期間 end). */
  readonly clearLabel?: string;
  /**
   * FR-70 (F2): label for the「開放端を具体日付にする」action shown WHILE the field is
   * open-ended (default 「終了を指定」). Clicking it reveals empty date fields so the user
   * types the end explicitly — a concrete end is emitted ONLY after this deliberate step.
   */
  readonly specifyLabel?: string;
  /** FR-70 (F2): text shown while the field is open-ended (default 「継続中」). */
  readonly openStateLabel?: string;
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
  const {
    title,
    calendar,
    initialValue,
    onConfirm,
    onClear,
    confirmLabel,
    clearLabel,
    specifyLabel,
    openStateLabel,
    testId,
  } = props;

  // Derive a per-control test id when a root is provided (list context), else omit
  // the attribute so the timeline field's DOM stays byte-for-byte unchanged.
  const tid = (suffix: string): string | undefined =>
    testId !== undefined ? `${testId}-${suffix}` : undefined;

  // OPEN-ENDED (継続中) modeling (FR-70 F2): a CLEARABLE field seeded with `null` starts
  // open — the date entry is gated behind an explicit「終了を指定」so an untouched confirm
  // cannot fabricate a concrete end. A required field (no onClear) is always seeded
  // concrete, so `specifying` is true from the start and none of the open-state UI shows —
  // its DOM/behaviour is unchanged.
  const clearable = onClear !== undefined;
  const startsOpen = clearable && initialValue === null;
  const [specifying, setSpecifying] = useState<boolean>(!startsOpen);
  const [draft, setDraft] = useState<YmdDraft>(() =>
    initialValue !== null ? draftFromTimePoint(initialValue) : EMPTY_YMD_DRAFT,
  );
  const [error, setError] = useState<string | null>(null);

  // Re-typing in any field clears the prior error (同種の再入力, 教訓 5.12) but
  // unrelated UI interaction does not call these handlers, so the message
  // persists through clicks elsewhere.
  const patch = useCallback((next: Partial<YmdDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
    setError(null);
  }, []);

  const handleConfirm = useCallback(() => {
    // While OPEN-ENDED (継続中, not yet specifying) confirm must emit NOTHING — the value
    // stays open until the user explicitly chooses「終了を指定」(FR-70 F2 存続期間データ
    // 保護). The button is also disabled in this state; this guard is the invariant.
    if (!specifying) return;
    const parsed = parseYmdDraft(draft, calendar);
    if (!parsed.ok) {
      setError(ymdErrorMessage(parsed.error));
      return;
    }
    setError(null);
    onConfirm(parsed.point);
  }, [specifying, draft, calendar, onConfirm]);

  const handleClear = useCallback(() => {
    if (onClear === undefined) return;
    setError(null);
    // 継続中にする returns the field to the OPEN state (F2). This matters when the value
    // was ALREADY open (open→終了を指定→継続中にする): the caller's keyed remount does not
    // fire (end stays null), so the local `specifying` toggle must reset here too.
    setSpecifying(false);
    onClear();
  }, [onClear]);

  // Reveal the date entry for an open-ended field (FR-70 F2). The draft stays EMPTY so the
  // user types the end explicitly — no fabricated default is ever emitted.
  const handleSpecify = useCallback(() => {
    setError(null);
    setSpecifying(true);
  }, []);

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
            disabled={!specifying}
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
            disabled={!specifying || !draft.monthSpecified}
            onChange={(e) => patch({ monthText: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={!draft.monthSpecified}
            aria-label={`${title} 月 未指定`}
            data-testid={tid('month-toggle')}
            disabled={!specifying}
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
            disabled={!specifying || !draft.monthSpecified || !draft.daySpecified}
            onChange={(e) => patch({ dayText: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={!draft.daySpecified}
            aria-label={`${title} 日 未指定`}
            data-testid={tid('day-toggle')}
            disabled={!specifying || !draft.monthSpecified}
            onClick={() =>
              patch(draft.daySpecified ? { daySpecified: false } : { daySpecified: true })
            }
          >
            {draft.daySpecified ? '指定' : '未指定'}
          </button>
        </label>
      </div>

      {/* FR-70 (F2): while open-ended, an explicit「継続中」indicator makes the empty +
          disabled date fields honest (未指定=値なし, 教訓 5.18) — the field carries NO
          fabricated concrete date. */}
      {!specifying && (
        <div className="ymd-input__open" data-testid={tid('open')}>
          {openStateLabel ?? '継続中'}
        </div>
      )}

      {error !== null && (
        <div className="ymd-input__error" role="alert" data-testid={tid('error')}>
          {error}
        </div>
      )}

      <div className="ymd-input__actions">
        {/* 反映 stays present (stable DOM) but is DISABLED while open-ended so an
            untouched confirm can never emit a fabricated concrete TimePoint (F2). */}
        <button
          type="button"
          data-testid={tid('confirm')}
          disabled={!specifying}
          onClick={handleConfirm}
        >
          {confirmLabel ?? '反映'}
        </button>
        {/* The deliberate「終了を指定」step reveals empty date fields — a concrete end is
            emitted ONLY after the user chooses to give the open interval one (F2). */}
        {!specifying && (
          <button type="button" data-testid={tid('specify')} onClick={handleSpecify}>
            {specifyLabel ?? '終了を指定'}
          </button>
        )}
        {onClear !== undefined && (
          <button type="button" data-testid={tid('clear')} onClick={handleClear}>
            {clearLabel ?? '未設定'}
          </button>
        )}
      </div>
    </div>
  );
}
