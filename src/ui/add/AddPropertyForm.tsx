// U23 — the post-shape property-input form (FR-76 / FR-97 / FR-77).
//
// Shown after the shape is confirmed (phase PropertyForm). Captures the new
// feature's basic attributes + color (FR-97) and, for a face, the parent
// selection (FR-77 親なし / 親面). Its SAVE button is the property-form完了
// trigger the spec requires to be wired (教訓 5.7): it calls back with the
// assembled {@link AddProperties}, which the controller hands to the hook's
// `save` → U13. All text is Japanese (NFR 5.7); the strings live in strings.ts.

import { useState } from 'react';

import {
  createBasicAttributes,
  createColorInfo,
  type BasicAttributes,
  type ColorInfo,
} from '../../domain/attributes';
import type { AddProperties, ParentCandidate } from '../../domain/add/index';
import type { FeatureId } from '../../domain/ids';

import { ADD_STRINGS } from './strings';

// A sensible default color for a freshly-added feature (FR-97 auto-color on).
const DEFAULT_COLOR: ColorInfo = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const DEFAULT_START_YEAR = 0;
const DEFAULT_END_YEAR = 0;

export interface AddPropertyFormProps {
  /** Show the parent selector (face only; FR-77). */
  readonly showParent: boolean;
  /** The eligible face parents at the current time (FR-77). */
  readonly parentCandidates: readonly ParentCandidate[];
  /** Choose a parent (null = 親なし / 最上位, FR-39). */
  readonly onChooseParent: (featureId: FeatureId | null) => void;
  /** SAVE — the property-form完了 trigger (教訓 5.7). */
  readonly onSave: (properties: AddProperties) => void;
  /** Cancel the whole add (教訓 5.2). */
  readonly onCancel: () => void;
}

export function AddPropertyForm(props: AddPropertyFormProps): JSX.Element {
  const { showParent, parentCandidates, onChooseParent, onSave, onCancel } = props;
  const [name, setName] = useState('');

  const submit = (): void => {
    const attributes: BasicAttributes = createBasicAttributes(
      name,
      DEFAULT_START_YEAR,
      DEFAULT_END_YEAR,
    );
    const properties: AddProperties = { attributes, color: DEFAULT_COLOR };
    onSave(properties);
  };

  return (
    <form
      className="add-property-form"
      data-testid="add-property-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2>{ADD_STRINGS.formTitle}</h2>

      <label className="add-property-form__field">
        {ADD_STRINGS.fieldName}
        <input
          type="text"
          data-testid="add-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>

      {showParent && (
        <label className="add-property-form__field">
          {ADD_STRINGS.fieldParent}
          <select
            data-testid="add-parent"
            onChange={(e) =>
              onChooseParent(e.target.value === '' ? null : (e.target.value as FeatureId))
            }
            defaultValue=""
          >
            <option value="">{ADD_STRINGS.parentNone}</option>
            {parentCandidates.map((c) => (
              <option key={c.featureId} value={c.featureId}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="add-property-form__actions">
        {/* SAVE — property-form完了 trigger (教訓 5.7). Enter also submits. */}
        <button type="submit" data-testid="add-save">
          {ADD_STRINGS.save}
        </button>
        <button type="button" data-testid="add-form-cancel" onClick={onCancel}>
          {ADD_STRINGS.cancel}
        </button>
      </div>
    </form>
  );
}
