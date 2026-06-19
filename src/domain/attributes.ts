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

export interface ColorInfo {
  /** Whether automatic four-color assignment is allowed for this feature. */
  readonly autoColorEnabled: boolean;
  readonly fillColor: Color;
  readonly selectedColor: Color;
  readonly borderColor: Color;
}

export function createColorInfo(
  autoColorEnabled: boolean,
  fillColor: Color,
  selectedColor: Color,
  borderColor: Color,
): ColorInfo {
  return { autoColorEnabled, fillColor, selectedColor, borderColor };
}

export function colorInfoEqual(a: ColorInfo, b: ColorInfo): boolean {
  return (
    a.autoColorEnabled === b.autoColorEnabled &&
    a.fillColor === b.fillColor &&
    a.selectedColor === b.selectedColor &&
    a.borderColor === b.borderColor
  );
}

// withXxx (every attribute: autoColorEnabled, fillColor, selectedColor, borderColor)

export function withAutoColorEnabled(info: ColorInfo, autoColorEnabled: boolean): ColorInfo {
  return {
    autoColorEnabled,
    fillColor: info.fillColor,
    selectedColor: info.selectedColor,
    borderColor: info.borderColor,
  };
}

export function withFillColor(info: ColorInfo, fillColor: Color): ColorInfo {
  return {
    autoColorEnabled: info.autoColorEnabled,
    fillColor,
    selectedColor: info.selectedColor,
    borderColor: info.borderColor,
  };
}

export function withSelectedColor(info: ColorInfo, selectedColor: Color): ColorInfo {
  return {
    autoColorEnabled: info.autoColorEnabled,
    fillColor: info.fillColor,
    selectedColor,
    borderColor: info.borderColor,
  };
}

export function withBorderColor(info: ColorInfo, borderColor: Color): ColorInfo {
  return {
    autoColorEnabled: info.autoColorEnabled,
    fillColor: info.fillColor,
    selectedColor: info.selectedColor,
    borderColor,
  };
}
