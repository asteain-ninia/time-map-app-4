// UI layer (U32 property panel / U33 style section): pure presentation logic for
// the「スタイル」section (FR-102). Framework-free so it is unit-testable in node
// (受け入れ基準5), with the React component (StyleSection.tsx) as a thin shell.
//
// The single permission rule (FR-102 / 教訓 5.13): color VALUE controls
// (fill/selected pickers + transparency sliders) are editable IFF auto-color is
// OFF. This is derived once via the domain's `colorValuesEditable`, then handed
// to every color widget — there is no per-widget permission check, so a
// shortcut / context-menu cannot edit color while auto-color is ON. The palette
// dropdown and the auto-color checkbox stay operable in BOTH states (domain
// `paletteSelectable` / `autoColorToggleable`).
//
// Alpha (透過) is carried alongside the hex color as a 0..1 value; the hex token
// stays a pure `#rrggbb` (domain attribute), so transparency and color value are
// orthogonal — the SAME permission gates both (a slider is a color VALUE edit).

import {
  colorValuesEditable,
  paletteSelectable,
  autoColorToggleable,
} from '../../domain/coloring';
import type { PaletteThemeId } from '../../domain/coloring';

/** U33 style-section Japanese UI strings (NFR 5.7), single-sourced here. */
export const STYLE_STRINGS = {
  sectionTitle: 'スタイル',
  autoColorLabel: '自動配色を許可',
  paletteLabel: '使用パレット',
  fillColorLabel: '通常表示色',
  selectedColorLabel: '選択表示色',
  opacityLabel: '透過',
  autoColorOnNotice: '自動配色 ON のため色は自動決定されます（閲覧のみ）。',
} as const;

/**
 * The resolved edit-permission for every style control, derived from ONE input
 * (the auto-color flag). The component spreads these onto the widgets so the
 * gate is single-sourced (教訓 5.13).
 */
export interface StylePermissions {
  /** Fill/selected pickers + opacity sliders editable (== auto-color OFF). */
  readonly colorValuesEditable: boolean;
  /** Palette dropdown operable (always true). */
  readonly paletteSelectable: boolean;
  /** Auto-color checkbox toggleable (always true). */
  readonly autoColorToggleable: boolean;
}

/** Resolve all style-control permissions from the auto-color flag (教訓 5.13). */
export function resolveStylePermissions(autoColorEnabled: boolean): StylePermissions {
  return {
    colorValuesEditable: colorValuesEditable(autoColorEnabled),
    paletteSelectable: paletteSelectable(),
    autoColorToggleable: autoColorToggleable(),
  };
}

/** The editable style values shown in the section. */
export interface StyleValues {
  readonly autoColorEnabled: boolean;
  readonly paletteTheme: PaletteThemeId;
  readonly fillColor: string;
  /** Fill alpha in [0,1]. */
  readonly fillOpacity: number;
  readonly selectedColor: string;
  /** Selected-color alpha in [0,1]. */
  readonly selectedOpacity: number;
}

/** Clamp an alpha value into [0,1]. Single place the range rule applies. */
export function clampOpacity(value: number): number {
  if (Number.isNaN(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
