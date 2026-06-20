// UI layer (U32 / property panel): basic-info display + edit form (FR-97 / FR-99
// 前段, 教訓 5.13 / 5.24 / 5.12).
//
// Shows the target feature's basic attributes (name・開始年・終了年) and color
// info (自動配色許可・塗り色・選択時色・境界色). One `editable` judgment controls
// the WHOLE form (教訓 5.13): in view mode every input is disabled and the save
// button is hidden — there is no per-widget permission check. Saving builds the
// edit intent through edit-intent.ts with the current edit-target anchor's start
// time as the edit time (教訓 5.15) and a no-op guard (教訓 5.24). A save-failure
// / validation message is held in dedicated state and is NOT cleared by unrelated
//操作 (教訓 5.12) — including selecting a DIFFERENT地物 (spec 行188). The only
// three clear契機 are: a同種操作の再試行 (re-save), an explicit閉じる (dismiss),
// or a妥当値での再保存成功 (successful save). A target-feature change re-syncs the
// draft (教訓 5.2 selection boundary) but PRESERVES the held message.

import { useMemo, useState } from 'react';

import type { Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

import type { PropertyEditValues } from './contracts';
import { isNoOpEdit, valuesFromFeature } from './edit-intent';
import { PROPERTY_STRINGS } from './messages';

export interface BasicInfoFormProps {
  /** The feature whose基本情報 is shown/edited (the resolved edit target). */
  readonly feature: Feature;
  /** Whole-form edit gate (教訓 5.13). False = view-only. */
  readonly editable: boolean;
  /** The edit time = current edit-target anchor's start time (教訓 5.15). */
  readonly editTime: TimePoint | null;
  /**
   * Save handler. Receives the new values + edit time; returns an error message
   * to display, or null on success. The PARENT owns dispatch so this component
   * stays a thin form (the no-op guard runs here before calling).
   */
  readonly onSave: (values: PropertyEditValues, editTime: TimePoint) => string | null;
}

export function BasicInfoForm(props: BasicInfoFormProps): JSX.Element {
  const { feature, editable, editTime, onSave } = props;

  // The form syncs to the feature (the single baseline source, 教訓 5.24). A new
  // feature / a changed feature re-syncs the draft.
  const baseline = useMemo(() => valuesFromFeature(feature), [feature]);
  const [draft, setDraft] = useState<PropertyEditValues>(baseline);
  // 教訓 5.12: the save-failure / validation message is dedicated state. It is
  // cleared by ONLY three契機 — a same-operation re-save attempt, an explicit
  // dismiss, or a妥当値での再保存成功. It must NOT be cleared by無関係操作, and
  // selecting a DIFFERENT feature is explicitly one such無関係操作 (spec 行188).
  const [message, setMessage] = useState<string | null>(null);

  // Re-sync the draft to the baseline when the TARGET feature changes (教訓 5.2:
  // the selection-change boundary discards the transient draft). Keyed to the
  // feature ID, not the baseline value object: a re-render that re-resolves the
  // SAME feature to a fresh-but-equal object must NOT reset the draft (root cause
  // of the U32 blocker — see PropertyPanel's memoized feature). Done during
  // render via a key sentinel (no effect) so the first paint already reflects the
  // re-sync. Crucially the held message is PRESERVED across the feature change:
  // 教訓 5.12 does not list "別地物の選択" among the three clear契機.
  const [syncedFeatureId, setSyncedFeatureId] = useState<FeatureId>(feature.id);
  if (syncedFeatureId !== feature.id) {
    setSyncedFeatureId(feature.id);
    setDraft(baseline);
  }

  function patch(next: Partial<PropertyEditValues>): void {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  function handleSave(): void {
    if (editTime === null) {
      setMessage(`${PROPERTY_STRINGS.saveFailedPrefix}編集対象の錨が選択されていません。`);
      return;
    }
    // 教訓 5.24: no-op guard. A confirm whose values equal the baseline does not
    // dispatch (no ghost undo). The save message is cleared (同種操作の再試行).
    if (isNoOpEdit(feature, draft)) {
      setMessage(null);
      return;
    }
    const error = onSave(draft, editTime);
    // 教訓 5.12: a successful save (null) clears the message; a failure replaces
    // it. Either way this is a same-operation outcome, the allowed clear契機.
    setMessage(error);
  }

  return (
    <section className="basic-info" data-testid="basic-info">
      <h3>{PROPERTY_STRINGS.basicInfoTitle}</h3>

      {!editable && (
        <p className="basic-info__notice" data-testid="view-only-notice">
          {PROPERTY_STRINGS.viewOnlyNotice}
        </p>
      )}

      <label className="basic-info__field">
        <span>{PROPERTY_STRINGS.nameLabel}</span>
        <input
          type="text"
          aria-label={PROPERTY_STRINGS.nameLabel}
          value={draft.name}
          disabled={!editable}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>

      <label className="basic-info__field">
        <span>{PROPERTY_STRINGS.startYearLabel}</span>
        <input
          type="number"
          aria-label={PROPERTY_STRINGS.startYearLabel}
          value={draft.startYear}
          disabled={!editable}
          onChange={(e) => patch({ startYear: Number(e.target.value) })}
        />
      </label>

      <label className="basic-info__field">
        <span>{PROPERTY_STRINGS.endYearLabel}</span>
        <input
          type="number"
          aria-label={PROPERTY_STRINGS.endYearLabel}
          value={draft.endYear}
          disabled={!editable}
          onChange={(e) => patch({ endYear: Number(e.target.value) })}
        />
      </label>

      <fieldset className="basic-info__colors" disabled={!editable}>
        <legend>{PROPERTY_STRINGS.colorSectionTitle}</legend>

        <label className="basic-info__field">
          <span>{PROPERTY_STRINGS.autoColorLabel}</span>
          <input
            type="checkbox"
            aria-label={PROPERTY_STRINGS.autoColorLabel}
            checked={draft.autoColorEnabled}
            disabled={!editable}
            onChange={(e) => patch({ autoColorEnabled: e.target.checked })}
          />
        </label>

        <label className="basic-info__field">
          <span>{PROPERTY_STRINGS.fillColorLabel}</span>
          <input
            type="text"
            aria-label={PROPERTY_STRINGS.fillColorLabel}
            value={draft.fillColor}
            disabled={!editable}
            onChange={(e) => patch({ fillColor: e.target.value })}
          />
        </label>

        <label className="basic-info__field">
          <span>{PROPERTY_STRINGS.selectedColorLabel}</span>
          <input
            type="text"
            aria-label={PROPERTY_STRINGS.selectedColorLabel}
            value={draft.selectedColor}
            disabled={!editable}
            onChange={(e) => patch({ selectedColor: e.target.value })}
          />
        </label>

        <label className="basic-info__field">
          <span>{PROPERTY_STRINGS.borderColorLabel}</span>
          <input
            type="text"
            aria-label={PROPERTY_STRINGS.borderColorLabel}
            value={draft.borderColor}
            disabled={!editable}
            onChange={(e) => patch({ borderColor: e.target.value })}
          />
        </label>
      </fieldset>

      {message !== null && (
        <div className="basic-info__message" role="alert" data-testid="save-message">
          <span>{message}</span>
          <button
            type="button"
            aria-label={PROPERTY_STRINGS.dismissMessage}
            onClick={() => setMessage(null)}
          >
            ×
          </button>
        </div>
      )}

      {editable && (
        <button
          type="button"
          className="basic-info__save"
          data-testid="save-button"
          onClick={handleSave}
        >
          {PROPERTY_STRINGS.saveButton}
        </button>
      )}
    </section>
  );
}
