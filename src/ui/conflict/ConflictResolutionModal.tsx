// UI layer (U35 / conflict): the conflict-resolution modal (FR-62 / FR-63 / 118).
//
// Renders, over a U13 `ConflictsPendingResult`, the paused-confirmation banner,
// the FULL conflict list with per-row policy choice + state, the minimap preview
// for the focused conflict, the first-time guide, and apply/cancel — with the
// overlapping input layers designed alongside the z-order (教訓 5.14).
//
// INPUT-LAYER DESIGN (教訓 5.14 / 受け入れ基準 9):
//   - the BACKDROP is a full-surface layer UNDER the dialog that CAPTURES pointer
//     events (so背面 map/toolbar/timeline cannot be operated while confirmation
//     is paused) — it has `data-testid="conflict-backdrop"` and stops propagation;
//   - the DIALOG sits ABOVE the backdrop; its interactive elements (row buttons,
//     policy radios, the minimap, apply/cancel) receive input directly because no
//     transparent decoration layer is placed over them — every overlay used for
//     highlighting is `pointer-events: none` (the row highlight) so it never
//     steals input;
//   - FOCUS is trapped inside the dialog (Tab/Shift+Tab wrap; focus cannot reach
//     背面). Esc cancels.
//
// State: the draft choices + apply/cancel live in `useConflictResolution`; the
// guide-shown flag is an APP setting passed in (教訓 5.36). This component is
// presentational over those (技術方針 2.3: business UI is React).

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FeatureId } from '../../domain/ids';
import type {
  Conflict,
  ConflictsPendingResult,
  ProcessResult,
} from '../../domain/consistency/index';

import {
  type ApplyResolutions,
  MODAL_PHASE,
  useConflictResolution,
} from './useConflictResolution';
import { type ConflictShapes } from './preview';
import { MinimapPreview } from './MinimapPreview';
import { ROW_STATE } from './model';
import {
  ACTION_STRINGS,
  CONFLICT_STRINGS,
  GUIDE_STRINGS,
  POLICY_STRINGS,
  PREVIEW_STRINGS,
} from './strings';

/** Resolve the two shapes for a conflict (host looks them up from domain state). */
export type ConflictShapesLookup = (conflict: Conflict) => ConflictShapes;

export interface ConflictResolutionModalProps<S> {
  /** The U13 process result that opened the modal (唯一の入力, 教訓 5.3). */
  readonly pending: ConflictsPendingResult;
  /** The U13 apply-and-reevaluate adapter (一括適用, 受け入れ基準 5). */
  readonly applyResolutions: ApplyResolutions<S>;
  /** Host lookup for the two terminal shapes of a conflict (for the preview). */
  readonly shapesFor: ConflictShapesLookup;
  /** Whether the first-time guide should be shown (APP setting, FR-118 / 教訓 5.36). */
  readonly showGuide: boolean;
  /** Persist the guide-suppress choice into the APP setting (教訓 5.36). */
  readonly onSuppressGuide?: (() => void) | undefined;
  /** Called on cancel (host abandons the paused edit, no domain change). */
  readonly onCancel?: (() => void) | undefined;
  /** Called on commit (host closes the modal + records the single undo unit). */
  readonly onCommitted?: ((result: ProcessResult<S>) => void) | undefined;
  /** Preview canvas size (CSS px). Defaults to a compact minimap. */
  readonly previewWidthPx?: number | undefined;
  readonly previewHeightPx?: number | undefined;
  readonly devicePixelRatio?: number | undefined;
}

const DEFAULT_PREVIEW_PX = 220;

export function ConflictResolutionModal<S>(
  props: ConflictResolutionModalProps<S>,
): JSX.Element {
  const {
    pending,
    applyResolutions,
    shapesFor,
    showGuide,
    onSuppressGuide,
    onCancel,
    onCommitted,
  } = props;
  const previewW = props.previewWidthPx ?? DEFAULT_PREVIEW_PX;
  const previewH = props.previewHeightPx ?? DEFAULT_PREVIEW_PX;

  const resolution = useConflictResolution<S>({
    pending,
    applyResolutions,
    onCancel,
    onCommitted,
  });
  const { conflicts, drafts, listVM, phase, rejectionMessage, canApply } = resolution;

  // The conflict whose preview is shown. Defaults to the first; follows the new
  // list when再構成 swaps it out (教訓 5.5: 依存状態変化で再選択).
  const [focusedId, setFocusedId] = useState<string | null>(
    conflicts[0]?.id ?? null,
  );
  useEffect(() => {
    if (focusedId === null || !conflicts.some((c) => c.id === focusedId)) {
      setFocusedId(conflicts[0]?.id ?? null);
    }
  }, [conflicts, focusedId]);

  const [guideOpen, setGuideOpen] = useState(showGuide);

  const dialogRef = useRef<HTMLDivElement | null>(null);

  // --- focus trap (受け入れ基準 9: フォーカスはモーダル内に留まる) --------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolution.cancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (root === null) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [resolution],
  );

  const focusedConflict = conflicts.find((c) => c.id === focusedId) ?? null;

  return (
    <div className="conflict-modal-root" data-testid="conflict-modal-root">
      {/* Backdrop: captures all pointer input so背面 cannot be operated while
          confirmation is paused (教訓 5.14 / 受け入れ基準 9). */}
      <div
        className="conflict-backdrop"
        data-testid="conflict-backdrop"
        aria-hidden="true"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onClickCapture={(e) => e.stopPropagation()}
      />

      <div
        className="conflict-dialog"
        data-testid="conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={CONFLICT_STRINGS.title}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="conflict-dialog__header">
          <h2 className="conflict-dialog__title">{CONFLICT_STRINGS.title}</h2>
        </header>

        {/* Paused-confirmation banner (FR-62). */}
        <p className="conflict-dialog__paused" data-testid="conflict-paused-banner">
          {CONFLICT_STRINGS.pausedBanner}
        </p>

        {/* First-time guide (FR-118). */}
        {guideOpen && (
          <section
            className="conflict-guide"
            data-testid="conflict-guide"
            aria-label={GUIDE_STRINGS.heading}
          >
            <h3>{GUIDE_STRINGS.heading}</h3>
            <ol>
              {GUIDE_STRINGS.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <div className="conflict-guide__actions">
              <button
                type="button"
                onClick={() => {
                  setGuideOpen(false);
                  onSuppressGuide?.();
                }}
              >
                {GUIDE_STRINGS.dismiss}
              </button>
              <button type="button" onClick={() => setGuideOpen(false)}>
                {GUIDE_STRINGS.close}
              </button>
            </div>
          </section>
        )}
        {!guideOpen && (
          <button
            type="button"
            className="conflict-guide__reshow"
            data-testid="conflict-guide-reshow"
            onClick={() => setGuideOpen(true)}
          >
            {GUIDE_STRINGS.reshow}
          </button>
        )}

        {/* Rejection banner (FR-115 / FR-117). Includes a retry affordance so the
            Rejected phase is not a dead-end: the user can re-enter Resolving and
            pick different policies without abandoning the paused edit (cancel). */}
        {phase === MODAL_PHASE.Rejected && rejectionMessage !== null && (
          <div
            className="conflict-dialog__error"
            role="alert"
            data-testid="conflict-rejection"
          >
            <p className="conflict-dialog__error-message">{rejectionMessage}</p>
            <button
              type="button"
              className="conflict-dialog__retry"
              data-testid="conflict-retry"
              onClick={() => resolution.resetToResolving()}
            >
              {ACTION_STRINGS.retry}
            </button>
          </div>
        )}

        <div className="conflict-dialog__body">
          {/* Conflict list (FR-62: 全件). */}
          <section className="conflict-list" aria-label={CONFLICT_STRINGS.listHeading}>
            <div className="conflict-list__heading">
              <h3>{CONFLICT_STRINGS.listHeading}</h3>
              <span data-testid="conflict-remaining">
                {CONFLICT_STRINGS.remainingPrefix}
                {listVM.unresolvedCount}
                {CONFLICT_STRINGS.remainingSuffix}
              </span>
            </div>
            <ul className="conflict-list__rows" data-testid="conflict-rows">
              {listVM.rows.map((row) => {
                const conflict = conflicts.find((c) => c.id === row.conflictId)!;
                const isFocused = row.conflictId === focusedId;
                return (
                  <li
                    key={row.conflictId}
                    className={
                      'conflict-row' +
                      (isFocused ? ' conflict-row--focused' : '') +
                      (row.state === ROW_STATE.Resolved
                        ? ' conflict-row--resolved'
                        : ' conflict-row--unresolved')
                    }
                    data-testid={`conflict-row-${row.conflictId}`}
                    data-state={row.state}
                  >
                    <button
                      type="button"
                      className="conflict-row__select"
                      data-testid={`conflict-row-select-${row.conflictId}`}
                      aria-pressed={isFocused}
                      onClick={() => setFocusedId(row.conflictId)}
                    >
                      <span className="conflict-row__time">{row.timeLabel}</span>
                      <span className="conflict-row__features">
                        {row.featureNames[0]} ／ {row.featureNames[1]}
                      </span>
                      <span className="conflict-row__kind">{row.kindLabel}</span>
                      <span className="conflict-row__state">
                        {row.state === ROW_STATE.Resolved
                          ? CONFLICT_STRINGS.stateResolved
                          : CONFLICT_STRINGS.stateUnresolved}
                      </span>
                    </button>

                    {/* Policy choice (FR-63): pick the priority feature. */}
                    <fieldset className="conflict-row__policy">
                      <legend>{POLICY_STRINGS.prompt}</legend>
                      <PolicyChoice
                        conflict={conflict}
                        priorityFeatureId={drafts.get(row.conflictId)}
                        onChoose={(fid) =>
                          resolution.choosePriority(row.conflictId, fid)
                        }
                      />
                      <p className="conflict-row__adjust-note">
                        {POLICY_STRINGS.adjustNote}
                      </p>
                    </fieldset>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Minimap preview for the focused conflict (FR-62 / FR-63). */}
          <section className="conflict-preview" aria-label={PREVIEW_STRINGS.ariaLabel}>
            {focusedConflict !== null ? (
              <>
                <MinimapPreview
                  conflict={focusedConflict}
                  shapes={shapesFor(focusedConflict)}
                  priorityFeatureId={drafts.get(focusedConflict.id)}
                  widthPx={previewW}
                  heightPx={previewH}
                  devicePixelRatio={props.devicePixelRatio}
                />
                <ul className="conflict-preview__legend">
                  <li>{PREVIEW_STRINGS.legendPriority}</li>
                  <li>{PREVIEW_STRINGS.legendRemaining}</li>
                  <li>{PREVIEW_STRINGS.legendOverlap}</li>
                </ul>
                {drafts.get(focusedConflict.id) === undefined && (
                  <p className="conflict-preview__hint">{PREVIEW_STRINGS.chooseFirst}</p>
                )}
              </>
            ) : null}
          </section>
        </div>

        <footer className="conflict-dialog__footer">
          <span
            className="conflict-dialog__status"
            data-testid="conflict-apply-status"
          >
            {canApply ? CONFLICT_STRINGS.allResolved : ACTION_STRINGS.applyDisabledHint}
          </span>
          <div className="conflict-dialog__actions">
            <button
              type="button"
              className="conflict-dialog__cancel"
              data-testid="conflict-cancel"
              onClick={() => resolution.cancel()}
            >
              {ACTION_STRINGS.cancel}
            </button>
            <button
              type="button"
              className="conflict-dialog__apply"
              data-testid="conflict-apply"
              disabled={!canApply}
              title={canApply ? undefined : ACTION_STRINGS.applyDisabledHint}
              onClick={() => resolution.apply()}
            >
              {ACTION_STRINGS.apply}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** The two priority radios for one conflict (優先＝選択側, 調整対象＝もう一方). */
function PolicyChoice(props: {
  readonly conflict: Conflict;
  readonly priorityFeatureId: FeatureId | undefined;
  readonly onChoose: (priorityFeatureId: FeatureId) => void;
}): JSX.Element {
  const { conflict, priorityFeatureId, onChoose } = props;
  const name = `policy-${conflict.id}`;
  return (
    <div className="policy-choice">
      {[conflict.a, conflict.b].map((p) => (
        <label key={p.featureId} className="policy-choice__option">
          <input
            type="radio"
            name={name}
            data-testid={`policy-${conflict.id}-${p.featureId}`}
            checked={priorityFeatureId === p.featureId}
            onChange={() => onChoose(p.featureId)}
          />
          {POLICY_STRINGS.priorityPrefix}: {p.displayName}
        </label>
      ))}
    </div>
  );
}
