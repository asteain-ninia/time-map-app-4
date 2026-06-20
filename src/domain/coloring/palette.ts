// U33 palette: a named set of base colors plus the deterministic expansion that
// supplies the Nth color (base colors first, then deterministically derived
// colors when the base set runs out — FR-101).
//
// This unit only CONSUMES a palette's base colors; the persistence/management of
// palette definitions belongs to the settings unit (spec §やらないこと, 契約で整合).
// The settings layer already models `defaultPaletteTheme` + `customPalette`
// (FR-109); a `Palette` here is the resolved base-color list paired with its
// theme id, handed in from that boundary.
//
// PURITY: pure functions, no mutation, deterministic (受け入れ基準2 / 6).

import { deriveColor } from './color-math';

/** A palette theme identifier (matches the settings-layer `PaletteThemeId`). */
export type PaletteThemeId = string;

/**
 * A resolved palette: an ordered, non-empty list of base colors under a theme
 * id. Order is significant and part of the deterministic input (教訓 5.19): the
 * same base-color order always yields the same color assignment.
 */
export interface Palette {
  readonly theme: PaletteThemeId;
  readonly baseColors: readonly string[];
}

/**
 * The built-in default palette (FR-109 既定パレットテーマ). A four-plus color set
 * chosen so four-color assignment usually succeeds with base colors alone. These
 * are the well-separated map-friendly hues.
 */
export const DEFAULT_PALETTE_THEME: PaletteThemeId = 'default';

export const DEFAULT_BASE_COLORS: readonly string[] = [
  '#4e79a7', // blue
  '#f28e2b', // orange
  '#59a14f', // green
  '#e15759', // red
  '#b07aa1', // purple
  '#edc948', // yellow
];

export const DEFAULT_PALETTE: Palette = {
  theme: DEFAULT_PALETTE_THEME,
  baseColors: DEFAULT_BASE_COLORS,
};

/**
 * Build a palette from a theme id + base colors. Falls back to the default base
 * colors when the supplied list is empty so the expansion always has a seed
 * (an empty palette could never color anything — 教訓 5.18 emptiness by length).
 */
export function createPalette(
  theme: PaletteThemeId,
  baseColors: readonly string[],
): Palette {
  return {
    theme,
    baseColors: baseColors.length > 0 ? baseColors : DEFAULT_BASE_COLORS,
  };
}

/** Number of base colors a palette provides before derivation kicks in. */
export function baseColorCount(palette: Palette): number {
  return palette.baseColors.length;
}

/**
 * The color at logical index `index` (0-based). Indices within the base-color
 * range return the base color verbatim. Beyond that, a DETERMINISTIC derived
 * color is generated: index `n` (>= baseCount) derives from base color
 * `n % baseCount` at derivation step `floor(n / baseCount)` (教訓 5.30: the single
 * derived-color rule). Same palette + same index -> same color, always.
 *
 * This is the SINGLE expansion used by the colorer; "不足時に基準色から決定的に
 * 派生" (FR-101) is realised purely by asking for higher indices.
 */
export function colorAtIndex(palette: Palette, index: number): string {
  const baseCount = palette.baseColors.length;
  if (baseCount === 0) {
    // Defensive: createPalette guarantees non-empty, but keep total.
    return deriveColor('#808080', index + 1);
  }
  if (index < baseCount) {
    const c = palette.baseColors[index];
    return c ?? '#808080';
  }
  const baseIndex = index % baseCount;
  const step = Math.floor(index / baseCount);
  const base = palette.baseColors[baseIndex] ?? '#808080';
  return deriveColor(base, step);
}

/**
 * Whether a logical color index is a base color (vs a derived one). Useful for
 * tests/UI to distinguish base from derived (受け入れ基準2 不足時の派生色).
 */
export function isBaseColorIndex(palette: Palette, index: number): boolean {
  return index >= 0 && index < palette.baseColors.length;
}
