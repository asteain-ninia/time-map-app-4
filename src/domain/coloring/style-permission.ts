// U33 style edit-permission + auto/manual transition rules (FR-100 / FR-102 /
// 教訓 5.5 / 5.13). Pure domain logic so the SAME permission judgment drives both
// the UI gating and any command-side guard (no back-door color edit while ON).
//
// The single permission rule (教訓 5.13): color values (fill/selected + alpha) are
// editable IFF auto-color is OFF. When ON, every color-edit path is disabled in
// one place — not per widget — so a shortcut / context-menu cannot edit color
// behind the disabled picker. The palette dropdown and the auto-color checkbox
// stay operable in BOTH states (they are not "color value" edits).
//
// The ON<->OFF transition (教訓 5.5 対概念の整合):
//   - OFF -> ON: colors become system-decided (auto). The caller recolors from
//     adjacency immediately (FR-100); this module only reports the permission.
//   - ON  -> OFF: the just-decided auto colors are PRESERVED as the manual
//     starting values (never discarded / reset to a default — FR-100 / 教訓 5.5),
//     and color editing is released. `manualColorsOnDisable` expresses exactly
//     that: it returns the current (auto) colors unchanged so the command writes
//     them as the new manual values.
//
// PURITY (受け入れ基準6): pure, no mutation.

import type { Color, ColorInfo } from '../attributes';
import { withAutoColorEnabled, withFillColor, withSelectedColor } from '../attributes';

/**
 * Whether color VALUES (fill / selected / alpha) may be edited for a feature
 * with the given auto-color flag. The single source of truth for color-edit
 * permission (教訓 5.13): editable iff auto-color is OFF.
 */
export function colorValuesEditable(autoColorEnabled: boolean): boolean {
  return !autoColorEnabled;
}

/**
 * Whether the palette selector may be operated. Operable in both ON and OFF
 * states: ON => switching palette re-colors with the new base set (一貫規約);
 * OFF => palette is irrelevant to manual colors but the control is not a color
 * VALUE edit, so it is not gated by the color permission.
 */
export function paletteSelectable(): boolean {
  return true;
}

/** Whether the auto-color enable/disable checkbox may be toggled. Always true. */
export function autoColorToggleable(): boolean {
  return true;
}

/**
 * The fill/selected colors to keep when auto-color is turned OFF: the CURRENT
 * (auto-decided) colors, unchanged (FR-100 / 教訓 5.5 — never reset to default).
 * Returned as a `ColorInfo` with `autoColorEnabled` already set to false so the
 * caller can write it straight into the anchor as the new manual baseline.
 */
export function manualColorsOnDisable(current: ColorInfo): ColorInfo {
  return withAutoColorEnabled(current, false);
}

/**
 * Apply an auto-color result (fill + derived selected) onto a feature's color
 * info, marking auto-color ON. Used when OFF->ON or on a recolor while ON. The
 * single place auto colors are written into the attribute value object so the
 * "ON => system-decided color" rule is not duplicated.
 */
export function applyAutoColors(
  current: ColorInfo,
  fillColor: Color,
  selectedColor: Color,
): ColorInfo {
  const withAuto = withAutoColorEnabled(current, true);
  const withFill = withFillColor(withAuto, fillColor);
  return withSelectedColor(withFill, selectedColor);
}
