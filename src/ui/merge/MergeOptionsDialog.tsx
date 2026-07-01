// U30 — 結合オプションダイアログ (FR-52: 上位領域・属性継承元の選択, 教訓 5.14 / 5.19).
//
// Shown at the Choosing step (after ≥2 valid merge targets are picked and 確定 is
// pressed). It lets the user choose, BEFORE the merge proposal is built:
//   (1) the result's 上位領域 (parent): 親なし (最上位) / 既存の上位領域から選ぶ /
//       新規上位領域を作成する — populated by `allowedMergeParentCandidates` (FR-52 親候補);
//   (2) the プロパティ inheritance source: 結合対象のいずれかを引き継ぐ (per
//       `propertyInheritCandidates`) / 新規入力 (`propertyNew`).
// On 確定 it assembles the chosen {@link ParentDecision} + {@link PropertyDecision} and
// hands them back; the seeded defaults (親なし + inherit-first) reproduce the prior
// hardcoded behaviour so a plain 確定 still merges (FR-52 既定値).
//
// Before this dialog the UI hardcoded parentNone + propertyInherit(first) and NEVER
// called the candidate functions — the parentCreate / parentExisting / propertyNew
// variants were structurally unreachable from the UI (the FR-52 wiring-gap this closes).
//
// INPUT-LAYER DESIGN (教訓 5.14, mirrors InheritorModal / ConflictResolutionModal): a
// full-surface BACKDROP UNDER the dialog captures pointer events so背面 (map / merge
// target picking) cannot be operated while the dialog is open; the dialog sits ABOVE it
// and its controls receive input directly. The dialog is focused on mount; Esc cancels.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useModalKeydown } from '../a11y/index';
import {
  CREATE_TERMINAL,
  parentCreateWithTerminal,
  parentExisting,
  parentNone,
  propertyInherit,
  type MergeCandidate,
  type ParentDecision,
  type PropertyDecision,
} from '../../domain/merge/index';
import type { FeatureId } from '../../domain/ids';

import { MERGE_OPTIONS_STRINGS } from './strings';

/** The three parent choices the dialog offers (FR-52, 3 択). */
const PARENT_CHOICE = {
  None: 'none',
  Existing: 'existing',
  Create: 'create',
} as const;
type ParentChoice = (typeof PARENT_CHOICE)[keyof typeof PARENT_CHOICE];

/** The two property choices the dialog offers (FR-52, 2 択). */
const PROPERTY_CHOICE = {
  Inherit: 'inherit',
  New: 'new',
} as const;
type PropertyChoice = (typeof PROPERTY_CHOICE)[keyof typeof PROPERTY_CHOICE];

export interface MergeOptionsDialogProps {
  /** 親候補 (allowedMergeParentCandidates). The「既存から選ぶ」picker renders over these. */
  readonly parentCandidates: readonly MergeCandidate[];
  /** プロパティ引き継ぎ元候補 (propertyInheritCandidates). The first is the seeded default. */
  readonly propertyCandidates: readonly MergeCandidate[];
  /**
   * Build a「新規プロパティ」decision from a name only (the host seeds color/period). Keeps
   * this dialog presentational over the domain decision types.
   */
  readonly buildNewProperties: (name: string) => PropertyDecision;
  /** Apply the chosen decisions + run the merge (the COMPLETE trigger, 教訓 5.7). */
  readonly onConfirm: (
    parentDecision: ParentDecision,
    propertyDecision: PropertyDecision,
  ) => void;
  /** Close the dialog without merging (Esc / cancel button) → back to selecting. */
  readonly onCancel: () => void;
}

export function MergeOptionsDialog(props: MergeOptionsDialogProps): JSX.Element {
  const { parentCandidates, propertyCandidates, buildNewProperties, onConfirm, onCancel } =
    props;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Seeded defaults (FR-52 既定値): 親なし + 引き継ぎ (first target) — the prior behaviour.
  const [parentChoice, setParentChoice] = useState<ParentChoice>(PARENT_CHOICE.None);
  const [existingParentId, setExistingParentId] = useState<FeatureId | null>(
    parentCandidates[0]?.featureId ?? null,
  );
  const [newParentName, setNewParentName] = useState<string>('');

  const [propertyChoice, setPropertyChoice] = useState<PropertyChoice>(
    PROPERTY_CHOICE.Inherit,
  );
  const [inheritSourceId, setInheritSourceId] = useState<FeatureId | null>(
    propertyCandidates[0]?.featureId ?? null,
  );
  const [newPropertyName, setNewPropertyName] = useState<string>('');

  // Esc cancels and Tab / Shift+Tab cycle inside the dialog (背面へ抜けない) — the
  // shared trap (教訓 5.13 / 5.14), same as the other 5 modals.
  const onKeyDown = useModalKeydown(dialogRef, onCancel);

  // Focus the dialog on mount so Esc / Tab are captured (教訓 5.14).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // The chosen ParentDecision (memoized for the confirm handler).
  const parentDecision = useMemo<ParentDecision>(() => {
    switch (parentChoice) {
      case PARENT_CHOICE.Existing:
        return existingParentId !== null ? parentExisting(existingParentId) : parentNone;
      case PARENT_CHOICE.Create:
        return parentCreateWithTerminal(
          { name: newParentName },
          { kind: CREATE_TERMINAL.NewTop },
        );
      case PARENT_CHOICE.None:
        return parentNone;
    }
  }, [parentChoice, existingParentId, newParentName]);

  const propertyDecision = useMemo<PropertyDecision | null>(() => {
    if (propertyChoice === PROPERTY_CHOICE.New) {
      return buildNewProperties(newPropertyName);
    }
    return inheritSourceId !== null ? propertyInherit(inheritSourceId) : null;
  }, [propertyChoice, inheritSourceId, newPropertyName, buildNewProperties]);

  // Confirm is blocked only when a chosen mode is missing its required input: an
  // 既存 parent with no candidate selected, a 新規 parent with a blank name, or an
  // 引き継ぎ with no source. None / a valid inherit always allows confirm.
  const canConfirm = useMemo<boolean>(() => {
    if (parentChoice === PARENT_CHOICE.Existing && existingParentId === null) return false;
    if (parentChoice === PARENT_CHOICE.Create && newParentName.trim() === '') return false;
    if (propertyDecision === null) return false;
    return true;
  }, [parentChoice, existingParentId, newParentName, propertyDecision]);

  const confirm = useCallback(() => {
    if (!canConfirm || propertyDecision === null) return;
    onConfirm(parentDecision, propertyDecision);
  }, [canConfirm, parentDecision, propertyDecision, onConfirm]);

  return (
    <div className="merge-options-root" data-testid="merge-options-modal-root">
      {/* Backdrop captures input so背面 cannot be operated (教訓 5.14). */}
      <div
        className="merge-options-backdrop"
        data-testid="merge-options-backdrop"
        aria-hidden="true"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onClickCapture={(e) => e.stopPropagation()}
      />
      <div
        className="merge-options-dialog"
        data-testid="merge-options-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={MERGE_OPTIONS_STRINGS.title}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="merge-options-dialog__header">
          <h2 className="merge-options-dialog__title">{MERGE_OPTIONS_STRINGS.title}</h2>
        </header>
        <p className="merge-options-dialog__hint">{MERGE_OPTIONS_STRINGS.hint}</p>

        {/* --- 上位領域 (parent) — the FR-52 3 択 ----------------------------- */}
        <fieldset className="merge-options-dialog__section" data-testid="merge-options-parent">
          <legend>{MERGE_OPTIONS_STRINGS.parentHeading}</legend>

          <label className="merge-options-dialog__choice">
            <input
              type="radio"
              name="merge-parent"
              data-testid="merge-parent-none"
              checked={parentChoice === PARENT_CHOICE.None}
              onChange={() => setParentChoice(PARENT_CHOICE.None)}
            />
            {MERGE_OPTIONS_STRINGS.parentNone}
          </label>

          <label className="merge-options-dialog__choice">
            <input
              type="radio"
              name="merge-parent"
              data-testid="merge-parent-existing"
              checked={parentChoice === PARENT_CHOICE.Existing}
              onChange={() => setParentChoice(PARENT_CHOICE.Existing)}
            />
            {MERGE_OPTIONS_STRINGS.parentExisting}
          </label>
          {parentChoice === PARENT_CHOICE.Existing && (
            <select
              className="merge-options-dialog__select"
              data-testid="merge-parent-existing-pick"
              aria-label={MERGE_OPTIONS_STRINGS.parentExistingPickLabel}
              value={existingParentId ?? ''}
              disabled={parentCandidates.length === 0}
              onChange={(e) => setExistingParentId(e.target.value as FeatureId)}
            >
              {parentCandidates.length === 0 ? (
                <option value="">{MERGE_OPTIONS_STRINGS.parentExistingEmpty}</option>
              ) : (
                parentCandidates.map((c) => (
                  <option key={c.featureId} value={c.featureId}>
                    {c.displayName}
                  </option>
                ))
              )}
            </select>
          )}

          <label className="merge-options-dialog__choice">
            <input
              type="radio"
              name="merge-parent"
              data-testid="merge-parent-create"
              checked={parentChoice === PARENT_CHOICE.Create}
              onChange={() => setParentChoice(PARENT_CHOICE.Create)}
            />
            {MERGE_OPTIONS_STRINGS.parentCreate}
          </label>
          {parentChoice === PARENT_CHOICE.Create && (
            <input
              type="text"
              className="merge-options-dialog__text"
              data-testid="merge-parent-create-name"
              aria-label={MERGE_OPTIONS_STRINGS.parentCreateNameLabel}
              placeholder={MERGE_OPTIONS_STRINGS.parentCreateNameLabel}
              value={newParentName}
              onChange={(e) => setNewParentName(e.target.value)}
            />
          )}
        </fieldset>

        {/* --- プロパティ (property) — the FR-52 2 択 ------------------------- */}
        <fieldset
          className="merge-options-dialog__section"
          data-testid="merge-options-property"
        >
          <legend>{MERGE_OPTIONS_STRINGS.propertyHeading}</legend>

          <label className="merge-options-dialog__choice">
            <input
              type="radio"
              name="merge-property"
              data-testid="merge-property-inherit"
              checked={propertyChoice === PROPERTY_CHOICE.Inherit}
              onChange={() => setPropertyChoice(PROPERTY_CHOICE.Inherit)}
            />
            {MERGE_OPTIONS_STRINGS.propertyInherit}
          </label>
          {propertyChoice === PROPERTY_CHOICE.Inherit && (
            <select
              className="merge-options-dialog__select"
              data-testid="merge-property-inherit-pick"
              aria-label={MERGE_OPTIONS_STRINGS.propertyInheritPickLabel}
              value={inheritSourceId ?? ''}
              onChange={(e) => setInheritSourceId(e.target.value as FeatureId)}
            >
              {propertyCandidates.map((c) => (
                <option key={c.featureId} value={c.featureId}>
                  {c.displayName}
                </option>
              ))}
            </select>
          )}

          <label className="merge-options-dialog__choice">
            <input
              type="radio"
              name="merge-property"
              data-testid="merge-property-new"
              checked={propertyChoice === PROPERTY_CHOICE.New}
              onChange={() => setPropertyChoice(PROPERTY_CHOICE.New)}
            />
            {MERGE_OPTIONS_STRINGS.propertyNew}
          </label>
          {propertyChoice === PROPERTY_CHOICE.New && (
            <input
              type="text"
              className="merge-options-dialog__text"
              data-testid="merge-property-new-name"
              aria-label={MERGE_OPTIONS_STRINGS.propertyNewNameLabel}
              placeholder={MERGE_OPTIONS_STRINGS.propertyNewNameLabel}
              value={newPropertyName}
              onChange={(e) => setNewPropertyName(e.target.value)}
            />
          )}
        </fieldset>

        <footer className="merge-options-dialog__footer">
          <button
            type="button"
            className="merge-options-dialog__cancel"
            data-testid="merge-options-cancel"
            onClick={() => onCancel()}
          >
            {MERGE_OPTIONS_STRINGS.cancel}
          </button>
          <button
            type="button"
            className="merge-options-dialog__confirm"
            data-testid="merge-options-confirm"
            disabled={!canConfirm}
            onClick={() => confirm()}
          >
            {MERGE_OPTIONS_STRINGS.confirm}
          </button>
        </footer>
      </div>
    </div>
  );
}
