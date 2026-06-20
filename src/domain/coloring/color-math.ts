// U33 color math: the SINGLE source of truth for every color computation the
// auto-coloring uses (教訓 5.30 単一の真実源). Hex <-> HSL parsing, the selection
// color derivation (通常色 -> 明るく鮮やかに) and the deterministic derived-color
// generation all live here so the "same base rule" is never duplicated.
//
// PURITY (受け入れ基準6 / NFR 5.8): every function is pure — same input yields the
// same output, no input is mutated, no randomness / clock / iteration-timing
// dependence (教訓 5.19 決定性).
//
// Colors are 6-digit `#rrggbb` hex tokens (the `Color` opaque string at the
// attribute layer). Alpha (透過) is carried by the attribute layer separately,
// not baked into the hex here (穴 transparency is a rendering concern; spec §やら
// ないこと). This module concerns the RGB color value only.

/** A normalized HSL color. h in [0,360), s/l in [0,1]. */
export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/** Clamp a number into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Wrap a hue into [0, 360). */
function wrapHue(h: number): number {
  const m = h % 360;
  return m < 0 ? m + 360 : m;
}

function channelToHex(value: number): string {
  const clamped = clamp(Math.round(value), 0, 255);
  return clamped.toString(16).padStart(2, '0');
}

/**
 * Parse a `#rgb` / `#rrggbb` hex string to RGB [0,255]. Returns null for any
 * malformed token (surfaced as data, never thrown — 教訓 5.26). Case-insensitive.
 */
export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (m === null) return null;
  const body = m[1];
  if (body === undefined) return null;
  if (body.length === 3) {
    const r = body[0];
    const g = body[1];
    const b = body[2];
    if (r === undefined || g === undefined || b === undefined) return null;
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

/** Format RGB [0,255] as a lowercase `#rrggbb` token. */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

/** Convert RGB [0,255] to normalized HSL. */
export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) {
    return { h: 0, s: 0, l };
  }
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) {
    h = (gn - bn) / delta + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / delta + 2;
  } else {
    h = (rn - gn) / delta + 4;
  }
  return { h: wrapHue(h * 60), s, l };
}

function hueToRgbComponent(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

/** Convert normalized HSL to RGB [0,255]. */
export function hslToRgb(hsl: Hsl): { r: number; g: number; b: number } {
  const h = wrapHue(hsl.h) / 360;
  const s = clamp(hsl.s, 0, 1);
  const l = clamp(hsl.l, 0, 1);
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgbComponent(p, q, h + 1 / 3) * 255,
    g: hueToRgbComponent(p, q, h) * 255,
    b: hueToRgbComponent(p, q, h - 1 / 3) * 255,
  };
}

/** Round-trip a hex through HSL after applying a transform. */
function transformHsl(hex: string, fn: (hsl: Hsl) => Hsl, fallback: string): string {
  const rgb = parseHex(hex);
  if (rgb === null) return fallback;
  const next = fn(rgbToHsl(rgb.r, rgb.g, rgb.b));
  const out = hslToRgb(next);
  return rgbToHex(out.r, out.g, out.b);
}

/**
 * Selection-color derivation (FR-101): the selected fill is the normal fill made
 * BRIGHTER and MORE VIVID. This is the ONE place that rule lives (教訓 5.30) — both
 * auto-coloring and any manual-default helper call it, so "selected is lighter &
 * more saturated than normal" holds by a single deterministic transform.
 *
 * Lightens by a fixed step toward white and raises saturation by a fixed step,
 * each clamped. Deterministic: same fill -> same selected color.
 */
export const SELECTION_LIGHTEN_STEP = 0.18;
export const SELECTION_SATURATE_STEP = 0.2;

export function deriveSelectedColor(fillColor: string): string {
  return transformHsl(
    fillColor,
    (hsl) => ({
      h: hsl.h,
      s: clamp(hsl.s + SELECTION_SATURATE_STEP, 0, 1),
      l: clamp(hsl.l + SELECTION_LIGHTEN_STEP, 0, 1),
    }),
    fillColor,
  );
}

/**
 * Deterministic derived-color generation (FR-101). When the palette's base
 * colors run out, derived colors are generated from a base color by a UNIQUE,
 * reproducible rule: the `step`-th derived color of `baseColor` shifts hue,
 * lightness and saturation by fixed amounts scaled by `step`. Same (baseColor,
 * step) -> same color, every time (no randomness — 教訓 5.19).
 *
 * Hue is the dominant shift so derived colors stay visually distinct; lightness
 * alternates up/down by step parity to widen separation when many are needed.
 */
export const DERIVE_HUE_STEP_DEG = 37;
export const DERIVE_LIGHTNESS_STEP = 0.07;
export const DERIVE_SATURATION_STEP = 0.05;

export function deriveColor(baseColor: string, step: number): string {
  // step 0 would return baseColor unchanged; callers pass step >= 1.
  return transformHsl(
    baseColor,
    (hsl) => {
      const parity = step % 2 === 0 ? 1 : -1;
      return {
        h: wrapHue(hsl.h + DERIVE_HUE_STEP_DEG * step),
        s: clamp(hsl.s + DERIVE_SATURATION_STEP * step, 0.25, 1),
        l: clamp(hsl.l + DERIVE_LIGHTNESS_STEP * step * parity, 0.2, 0.85),
      };
    },
    baseColor,
  );
}
