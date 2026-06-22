// Basic attributes and color info (FR-97).
//
// Both are immutable value objects with attribute-value equality and full
// `withXxx` coverage (lesson 5.17). Plain shapes for direct mapping to/from
// persisted data (lesson 5.20 / 5.31).

/**
 * Year value. Stored as a plain integer; negative values denote BCE. The time
 * model (ordering, normalization, non-existence periods) is a separate unit;
 * here a year is just a scalar so attributes stay plain-mappable.
 */
export type Year = number;

export interface BasicAttributes {
  readonly name: string;
  readonly startYear: Year;
  readonly endYear: Year;
}

export function createBasicAttributes(
  name: string,
  startYear: Year,
  endYear: Year,
): BasicAttributes {
  return { name, startYear, endYear };
}

export function basicAttributesEqual(a: BasicAttributes, b: BasicAttributes): boolean {
  return a.name === b.name && a.startYear === b.startYear && a.endYear === b.endYear;
}

// withXxx (every attribute: name, startYear, endYear)

export function withName(attrs: BasicAttributes, name: string): BasicAttributes {
  return { name, startYear: attrs.startYear, endYear: attrs.endYear };
}

export function withStartYear(attrs: BasicAttributes, startYear: Year): BasicAttributes {
  return { name: attrs.name, startYear, endYear: attrs.endYear };
}

export function withEndYear(attrs: BasicAttributes, endYear: Year): BasicAttributes {
  return { name: attrs.name, startYear: attrs.startYear, endYear };
}

// --- Color info (FR-97) -----------------------------------------------------

/** A color token (e.g. '#rrggbb'). Kept as an opaque string at this layer. */
export type Color = string;

/**
 * The palette theme identifier carried as a persisted style attribute (FR-100 /
 * U33 AC1). It is the SAME value space as the coloring unit's `PaletteThemeId`
 * (src/domain/coloring/palette.ts) — declared here as a local alias rather than
 * imported so this foundational module stays free of a coloring import cycle
 * (coloring depends on attributes via style-permission). Single-source intent:
 * both names denote the resolved palette theme id, contract-fixed by U33 tests.
 */
export type PaletteTheme = string;

/** The default palette theme id (FR-109 既定パレットテーマ). Mirrors
 * coloring/palette.ts `DEFAULT_PALETTE_THEME`; kept here so a `ColorInfo` minted
 * without an explicit theme defaults to the same value the colorer expands. */
export const DEFAULT_PALETTE_THEME_ID: PaletteTheme = 'default';

/**
 * The default alpha (透過度) for a freshly-minted `ColorInfo` (U33 spec 行23-26 /
 * AC1・AC5): fully opaque. A manifest written before alpha was a persisted style
 * attribute restores to this value (schema optional + this default), so older
 * projects open identical to how they looked. Single source of the "既定値" rule
 * (教訓 5.30): the schema, the factory and the deserializer all defer to it.
 */
export const DEFAULT_OPACITY = 1;

/**
 * The default fill alpha for a FRESHLY-ADDED feature (HB3-13: 新規地物の既定塗り透過度).
 * Distinct from {@link DEFAULT_OPACITY} (=1): that is the DESERIALIZE default — a manifest
 * with no opacity field restores fully opaque — whereas this is the value the add form
 * stamps onto a brand-new feature's `ColorInfo` so newly drawn 面 are slightly translucent
 * (やや透過) and overlapping features remain legible. 全地物一律 (HB3-13 確定). Single source
 * of the "new feature" alpha so the add form and the knife default reference one constant.
 */
export const DEFAULT_NEW_FEATURE_FILL_OPACITY = 0.7;

/** An alpha (透過度) value, constrained at the edit/clamp seams to [0,1]. */
export type Opacity = number;

export interface ColorInfo {
  /** Whether automatic four-color assignment is allowed for this feature. */
  readonly autoColorEnabled: boolean;
  readonly fillColor: Color;
  /**
   * 通常表示色の透過度（アルファ, 0..1）— part of the persisted style attribute
   * (U33 spec 行23-26 「通常表示色（塗り色。透過度＝アルファを含む）」 / AC1・AC5).
   * Anchor-saved so a透過 edit is part of the single anchor edit + undo unit.
   */
  readonly fillOpacity: Opacity;
  readonly selectedColor: Color;
  /**
   * 選択表示色の透過度（アルファ, 0..1）— part of the persisted style attribute
   * (U33 spec 行23-26 「選択表示色（透過度を含む）」 / AC1・AC5). Anchor-saved.
   */
  readonly selectedOpacity: Opacity;
  readonly borderColor: Color;
  /**
   * 使用パレット（テーマ名）— the palette theme this面 is colored from (FR-100 /
   * U33 AC1). Part of the persisted, anchor-saved style attribute so a palette
   * change is part of the single anchor edit + undo unit (FR-59 / FR-73).
   */
  readonly paletteTheme: PaletteTheme;
}

export function createColorInfo(
  autoColorEnabled: boolean,
  fillColor: Color,
  selectedColor: Color,
  borderColor: Color,
  paletteTheme: PaletteTheme = DEFAULT_PALETTE_THEME_ID,
  fillOpacity: Opacity = DEFAULT_OPACITY,
  selectedOpacity: Opacity = DEFAULT_OPACITY,
): ColorInfo {
  return {
    autoColorEnabled,
    fillColor,
    fillOpacity,
    selectedColor,
    selectedOpacity,
    borderColor,
    paletteTheme,
  };
}

export function colorInfoEqual(a: ColorInfo, b: ColorInfo): boolean {
  return (
    a.autoColorEnabled === b.autoColorEnabled &&
    a.fillColor === b.fillColor &&
    a.fillOpacity === b.fillOpacity &&
    a.selectedColor === b.selectedColor &&
    a.selectedOpacity === b.selectedOpacity &&
    a.borderColor === b.borderColor &&
    a.paletteTheme === b.paletteTheme
  );
}

// withXxx (every attribute: autoColorEnabled, fillColor, fillOpacity,
// selectedColor, selectedOpacity, borderColor, paletteTheme). Each preserves
// every OTHER field — including paletteTheme and both opacities — so no withXxx
// can silently drop a style attribute (教訓 5.17 全網羅).

export function withAutoColorEnabled(info: ColorInfo, autoColorEnabled: boolean): ColorInfo {
  return { ...info, autoColorEnabled };
}

export function withFillColor(info: ColorInfo, fillColor: Color): ColorInfo {
  return { ...info, fillColor };
}

export function withFillOpacity(info: ColorInfo, fillOpacity: Opacity): ColorInfo {
  return { ...info, fillOpacity };
}

export function withSelectedColor(info: ColorInfo, selectedColor: Color): ColorInfo {
  return { ...info, selectedColor };
}

export function withSelectedOpacity(info: ColorInfo, selectedOpacity: Opacity): ColorInfo {
  return { ...info, selectedOpacity };
}

export function withBorderColor(info: ColorInfo, borderColor: Color): ColorInfo {
  return { ...info, borderColor };
}

export function withPaletteTheme(info: ColorInfo, paletteTheme: PaletteTheme): ColorInfo {
  return { ...info, paletteTheme };
}
