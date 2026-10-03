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

import { useModalKeydown } from '../a11y/index';
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
import { PREVIEW_COLORS, type ConflictShapes } from './preview';
import { PARTICIPANT_TAGS, swatchesIndistinguishable } from './participant-color';
import { GuidePanel } from '../shell/GuidePanel';
import { MinimapPreview } from './MinimapPreview';
import { ROW_STATE } from './model';
import {
  ACTION_STRINGS,
  CONFLICT_STRINGS,
  GUIDE_STRINGS,
  POLICY_STRINGS,
  PREVIEW_STRINGS,
} from './strings';

/**
 * Resolve the two shapes for a conflict (host looks them up from state). The host
 * receives the INTERMEDIATE trial state the conflict was detected against (the
 * proposal applied + any difference adjustments) so the preview reads the current
 * trial geometry, never the committed/original root — after a resolution round
 * the preview reflects the trimmed shapes (the re-conflict stale-minimap fix).
 * `S` is the opaque domain state; the modal never inspects it.
 */
export type ConflictShapesLookup<S> = (conflict: Conflict, trialState: S) => ConflictShapes;

export interface ConflictResolutionModalProps<S> {
  /** The U13 process result that opened the modal (唯一の入力, 教訓 5.3). */
  readonly pending: ConflictsPendingResult<S>;
  /** The U13 apply-and-reevaluate adapter (一括適用, 受け入れ基準 5). */
  readonly applyResolutions: ApplyResolutions<S>;
  /** Host lookup for the two terminal shapes of a conflict (for the preview). */
  readonly shapesFor: ConflictShapesLookup<S>;
  /** Whether the first-time guide should be shown (APP setting, FR-118 / 教訓 5.36). */
  readonly showGuide: boolean;
  /** Persist the guide-suppress choice into the APP setting (教訓 5.36). */
  readonly onSuppressGuide?: (() => void) | undefined;
  /** Called on cancel (host abandons the paused edit, no domain change). */
  readonly onCancel?: (() => void) | undefined;
  /** Called on commit (host closes the modal + records the single undo unit). */
  readonly onCommitted?: ((result: ProcessResult<S>) => void) | undefined;
  /**
   * 重なりの 2 件それぞれの、地図で塗られている色（増分 8E / V13 ③の色見本）。名前が空の
   * 面どうしは呼び名が同じになりうるので、地図と同じ色で見分けられるようにする。
   * 渡されない宿主（単体試験など）や色が引けない地物では色見本を出さない。
   */
  readonly colorFor?:
    | ((conflict: Conflict, featureId: FeatureId, trialState: S) => string | undefined)
    | undefined;
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
    colorFor,
  } = props;
  const previewW = props.previewWidthPx ?? DEFAULT_PREVIEW_PX;
  const previewH = props.previewHeightPx ?? DEFAULT_PREVIEW_PX;

  const resolution = useConflictResolution<S>({
    pending,
    applyResolutions,
    onCancel,
    onCommitted,
  });
  const { conflicts, trialState, drafts, listVM, phase, rejectionMessage, canApply } =
    resolution;

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
  // The trap (Esc + Tab wrap) is the shared a11y helper (教訓 5.13 単一の真実源).
  const cancel = useCallback(() => resolution.cancel(), [resolution]);
  const onKeyDown = useModalKeydown(dialogRef, cancel);

  // Focus the dialog on mount so Esc / Tab are captured from the start.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

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
        tabIndex={-1}
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
        {/* 冒頭の文の言い換え（増分 8E / §H.1）。冒頭の文そのものは変えずに添える。 */}
        <p className="conflict-dialog__paraphrase" data-testid="conflict-paraphrase">
          {CONFLICT_STRINGS.pausedBannerParaphrase}
        </p>

        {/* First-time guide (FR-118)。器は共有の `GuidePanel`（増分 6）。 */}
        {guideOpen && (
          <GuidePanel
            content={GUIDE_STRINGS}
            className="conflict-guide"
            testId="conflict-guide"
            onClose={() => setGuideOpen(false)}
            onSuppress={onSuppressGuide}
          />
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
                const colorA = colorFor?.(conflict, conflict.a.featureId, trialState);
                const colorB = colorFor?.(conflict, conflict.b.featureId, trialState);
                const tagOf = participantTagsFor(conflict, colorFor !== undefined, colorA, colorB);
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
                      <span className="conflict-row__features" data-testid="conflict-row-features">
                        {/* 色見本（増分 8E / V13 ③）。地図で塗られている色で 2 件を見分ける。 */}
                        <ParticipantSwatch color={colorA} />
                        <ParticipantTag tag={tagOf(conflict.a.featureId)} />
                        {row.featureNames[0]} ／{' '}
                        <ParticipantSwatch color={colorB} />
                        <ParticipantTag tag={tagOf(conflict.b.featureId)} />
                        {row.featureNames[1]}
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
                        colorOf={(fid) => colorFor?.(conflict, fid, trialState)}
                        tagOf={tagOf}
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
                  shapes={shapesFor(focusedConflict, trialState)}
                  priorityFeatureId={drafts.get(focusedConflict.id)}
                  tags={previewTagsFor(focusedConflict, colorFor, trialState)}
                  widthPx={previewW}
                  heightPx={previewH}
                  devicePixelRatio={props.devicePixelRatio}
                />
                {/* 凡例に色見本を付ける（増分 8E / N-17）。色はミニマップが塗るのと同じ
                    `PREVIEW_COLORS` を読む（教訓 5.29: 色の真実源は 1 つ）。選ぶ前は両方の面を
                    灰色で描くので、その間だけ灰色の行も出す。 */}
                <ul className="conflict-preview__legend" data-testid="conflict-legend">
                  {drafts.get(focusedConflict.id) === undefined && (
                    <LegendItem role="neutral" color={PREVIEW_COLORS.neutral}>
                      {PREVIEW_STRINGS.legendNeutral}
                    </LegendItem>
                  )}
                  <LegendItem role="priority" color={PREVIEW_COLORS.priority}>
                    {PREVIEW_STRINGS.legendPriority}
                  </LegendItem>
                  <LegendItem role="remaining" color={PREVIEW_COLORS.remaining}>
                    {PREVIEW_STRINGS.legendRemaining}
                  </LegendItem>
                  <LegendItem role="overlap" color={PREVIEW_COLORS.overlap}>
                    {PREVIEW_STRINGS.legendOverlap}
                  </LegendItem>
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

/**
 * 色見本 1 個（増分 8E）。色が無ければ何も描かない（色の無い四角は「何か壊れている」に
 * 見えるので出さない）。読み上げには不要な飾りなので `aria-hidden`。
 */
function ParticipantSwatch(props: { readonly color: string | undefined }): JSX.Element | null {
  if (props.color === undefined) return null;
  return (
    <span
      className="conflict-swatch"
      data-testid="conflict-participant-swatch"
      data-color={props.color}
      aria-hidden="true"
      style={{ backgroundColor: props.color }}
    />
  );
}

/**
 * 番号札 1 個（増分 8E の手直し。設計適合 S2-4）。2 つの色見本で見分けられないときだけ出る。
 * 地図の下見にも同じ札が描かれるので、行・ラジオ・下見を札で突き合わせられる。
 */
function ParticipantTag(props: { readonly tag: string | undefined }): JSX.Element | null {
  if (props.tag === undefined) return null;
  return (
    <span className="conflict-tag" data-testid="conflict-participant-tag">
      {props.tag}
    </span>
  );
}

/**
 * その重なりの 2 件に番号札を付けるか、付けるなら各地物の札を返す口。色見本を出す宿主
 * （`colorFor` あり）で、2 つの色見本が同じか近いときだけ付ける（`swatchesIndistinguishable`）。
 */
function participantTagsFor(
  conflict: Conflict,
  hasSwatches: boolean,
  colorA: string | undefined,
  colorB: string | undefined,
): (featureId: FeatureId) => string | undefined {
  if (!hasSwatches || !swatchesIndistinguishable(colorA, colorB)) return () => undefined;
  return (featureId) =>
    featureId === conflict.a.featureId
      ? PARTICIPANT_TAGS[0]
      : featureId === conflict.b.featureId
        ? PARTICIPANT_TAGS[1]
        : undefined;
}

/** 地図の下見に描く番号札（札を付けない重なりなら undefined）。 */
function previewTagsFor<S>(
  conflict: Conflict,
  colorFor: ConflictResolutionModalProps<S>['colorFor'],
  trialState: S,
): { readonly a: string; readonly b: string } | undefined {
  if (colorFor === undefined) return undefined;
  const a = colorFor(conflict, conflict.a.featureId, trialState);
  const b = colorFor(conflict, conflict.b.featureId, trialState);
  return swatchesIndistinguishable(a, b) ? { a: PARTICIPANT_TAGS[0], b: PARTICIPANT_TAGS[1] } : undefined;
}

/** 凡例の 1 行（色見本＋説明）。色は `PREVIEW_COLORS` から渡す。 */
function LegendItem(props: {
  readonly role: 'neutral' | 'priority' | 'remaining' | 'overlap';
  readonly color: string;
  readonly children: string;
}): JSX.Element {
  return (
    <li className="conflict-preview__legend-item" data-testid={`conflict-legend-${props.role}`}>
      <span
        className="conflict-swatch"
        data-testid={`conflict-legend-swatch-${props.role}`}
        data-color={props.color}
        aria-hidden="true"
        style={{ backgroundColor: props.color }}
      />
      {props.children}
    </li>
  );
}

/** The two priority radios for one conflict (優先＝選択側, 調整対象＝もう一方). */
function PolicyChoice(props: {
  readonly conflict: Conflict;
  readonly colorOf: (featureId: FeatureId) => string | undefined;
  /** 番号札（見分けられないときだけ。増分 8E の手直し）。 */
  readonly tagOf: (featureId: FeatureId) => string | undefined;
  readonly priorityFeatureId: FeatureId | undefined;
  readonly onChoose: (priorityFeatureId: FeatureId) => void;
}): JSX.Element {
  const { conflict, colorOf, tagOf, priorityFeatureId, onChoose } = props;
  const name = `policy-${conflict.id}`;
  return (
    <div className="policy-choice">
      {[conflict.a, conflict.b].map((p) => (
        <label key={p.featureId} className="policy-choice__option" data-testid="policy-choice-option">
          <input
            type="radio"
            name={name}
            data-testid={`policy-${conflict.id}-${p.featureId}`}
            checked={priorityFeatureId === p.featureId}
            onChange={() => onChoose(p.featureId)}
          />
          {POLICY_STRINGS.priorityPrefix}: <ParticipantSwatch color={colorOf(p.featureId)} />
          <ParticipantTag tag={tagOf(p.featureId)} />
          {p.displayName}
        </label>
      ))}
    </div>
  );
}
