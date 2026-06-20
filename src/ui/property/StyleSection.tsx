// UI layer (U32 property panel / U33): the「スタイル」section component (FR-102).
//
// A thin React shell over `style-section.ts`. ONE permission judgment
// (`resolveStylePermissions`) gates every color VALUE control (fill/selected
// pickers + transparency sliders) — when auto-color is ON they are read-only
// (閲覧のみ), when OFF they are released (教訓 5.13). The palette dropdown and the
// auto-color checkbox stay operable in both states. There is no per-widget
// permission branch and no editable shortcut behind a disabled picker (裏口なし).
//
// This component is presentation-only: it reports value changes through `onChange`
// and the parent (U32) builds the edit intent + dispatches the command so the
// style change lands on the anchor edit-confirm flow (FR-59 / FR-73), in the same
// undo unit as any structural change that triggered an auto-recolor (FR-94). It
// never dispatches commands or mutates domain state itself.

import type { PaletteThemeId } from '../../domain/coloring';

import {
  STYLE_STRINGS,
  clampOpacity,
  resolveStylePermissions,
  type StyleValues,
} from './style-section';

export interface StyleSectionProps {
  readonly values: StyleValues;
  /** Available palette themes for the dropdown (from settings, FR-109). */
  readonly paletteThemes: readonly PaletteThemeId[];
  /** Whether the whole section is interactive at all (e.g. edit mode + area). */
  readonly sectionEnabled: boolean;
  readonly onChange: (next: StyleValues) => void;
}

export function StyleSection(props: StyleSectionProps): JSX.Element {
  const { values, paletteThemes, sectionEnabled, onChange } = props;
  const perms = resolveStylePermissions(values.autoColorEnabled);

  // Color-value controls are editable only when the section is enabled AND the
  // single permission allows it (auto-color OFF). One gate, every color widget.
  const colorEditable = sectionEnabled && perms.colorValuesEditable;
  const paletteEditable = sectionEnabled && perms.paletteSelectable;
  const toggleEditable = sectionEnabled && perms.autoColorToggleable;

  function patch(next: Partial<StyleValues>): void {
    onChange({ ...values, ...next });
  }

  return (
    <section className="style-section" data-testid="style-section">
      <h3>{STYLE_STRINGS.sectionTitle}</h3>

      <label className="style-section__field">
        <span>{STYLE_STRINGS.autoColorLabel}</span>
        <input
          type="checkbox"
          aria-label={STYLE_STRINGS.autoColorLabel}
          checked={values.autoColorEnabled}
          disabled={!toggleEditable}
          onChange={(e) => patch({ autoColorEnabled: e.target.checked })}
        />
      </label>

      <label className="style-section__field">
        <span>{STYLE_STRINGS.paletteLabel}</span>
        <select
          aria-label={STYLE_STRINGS.paletteLabel}
          value={values.paletteTheme}
          disabled={!paletteEditable}
          onChange={(e) => patch({ paletteTheme: e.target.value })}
        >
          {paletteThemes.map((theme) => (
            <option key={theme} value={theme}>
              {theme}
            </option>
          ))}
        </select>
      </label>

      {values.autoColorEnabled && (
        <p className="style-section__notice" data-testid="auto-color-notice">
          {STYLE_STRINGS.autoColorOnNotice}
        </p>
      )}

      <fieldset className="style-section__color" disabled={!colorEditable}>
        <legend>{STYLE_STRINGS.fillColorLabel}</legend>
        <input
          type="color"
          aria-label={STYLE_STRINGS.fillColorLabel}
          value={values.fillColor}
          disabled={!colorEditable}
          onChange={(e) => patch({ fillColor: e.target.value })}
        />
        <label className="style-section__opacity">
          <span>{STYLE_STRINGS.opacityLabel}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            aria-label={`${STYLE_STRINGS.fillColorLabel}${STYLE_STRINGS.opacityLabel}`}
            value={values.fillOpacity}
            disabled={!colorEditable}
            onChange={(e) => patch({ fillOpacity: clampOpacity(Number(e.target.value)) })}
          />
        </label>
      </fieldset>

      <fieldset className="style-section__color" disabled={!colorEditable}>
        <legend>{STYLE_STRINGS.selectedColorLabel}</legend>
        <input
          type="color"
          aria-label={STYLE_STRINGS.selectedColorLabel}
          value={values.selectedColor}
          disabled={!colorEditable}
          onChange={(e) => patch({ selectedColor: e.target.value })}
        />
        <label className="style-section__opacity">
          <span>{STYLE_STRINGS.opacityLabel}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            aria-label={`${STYLE_STRINGS.selectedColorLabel}${STYLE_STRINGS.opacityLabel}`}
            value={values.selectedOpacity}
            disabled={!colorEditable}
            onChange={(e) => patch({ selectedOpacity: clampOpacity(Number(e.target.value)) })}
          />
        </label>
      </fieldset>
    </section>
  );
}
