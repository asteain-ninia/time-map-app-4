// Base-map format adequacy, auto-correction試行, and fallback decision (U18 /
// FR-03 / FR-04). Domain layer: pure, framework-free, no Canvas / React / fs.
//
// SCOPE (spec §やること FR-04, §実装方針 ベースマップ差し替え):
//   The base-map differ flow is a FIXED order:
//     1. format adequacy judgment (equirectangular = aspect 2:1),
//     2. (if inadequate) auto-correction試行,
//     3. (if correctable) ADOPT + register project copy,
//     4. (if not correctable) error notify (日本語) + PRESET fallback.
//   This module owns step 1, 2 and the decision of 3/4 as a PURE function over a
//   *validated* image descriptor. It returns a structured result usable BOTH as a
//   user notification (日本語) and a testable return value (教訓 5.26: 拒否理由は
//   通知と戻り値の両方で).
//
// WHAT THIS MODULE DOES NOT DO (spec §やらないこと):
//   - It does not read files / decode images / write the ZIP. The actual bytes
//     are decoded by a boundary adapter; this module receives an ALREADY-VALIDATED
//     descriptor (width/height in pixels) and decides format / correction. The
//     "validated descriptor" type is the boundary contract (FR-116 / NFR 5.5 / R8:
//     未検証の外部入力をドメインへ流入させない — validation happens at the boundary
//     module, this domain logic consumes only the validated shape).
//   - It does not mutate the current displayed base-map (教訓 5.22: 確定まで共有
//     表示状態を破壊的に更新しない). It only RETURNS a decision; the store applies
//     it on confirmation, and on failure the caller falls back to the preset.

/**
 * The equirectangular aspect ratio: longitude 360° spans twice the latitude 180°
 * (spec §プリセット出界図: 縦横比 = 2:1). A base-map image is "format-adequate"
 * when width / height equals this within tolerance.
 */
export const EQUIRECTANGULAR_ASPECT = 2;

/**
 * Relative tolerance on the aspect ratio. A ratio within
 * `EQUIRECTANGULAR_ASPECT ± EQUIRECTANGULAR_ASPECT * ASPECT_TOLERANCE` is treated
 * as already adequate (no correction). 0.5% absorbs rounding in exported images
 * (e.g. 3601×1800) without accepting visibly non-2:1 maps.
 */
export const ASPECT_TOLERANCE = 0.005;

/**
 * The widest aspect departure from 2:1 that auto-correction will still attempt
 * (spec §自動補正を試みる). Beyond this the image is too far from equirectangular
 * to interpret as a world map by reframing — correction is declared impossible and
 * the flow falls back to the preset. Expressed as the allowed ratio of the actual
 * aspect to the target (or its inverse), so both too-wide and too-tall are bounded
 * symmetrically.
 */
export const MAX_CORRECTABLE_ASPECT_FACTOR = 4;

/**
 * Maximum accepted pixel dimension on either axis (NFR 5.1 視野外クリッピング /
 * spec §想定外の巨大寸法でないか). The boundary validator enforces this too; the
 * constant lives here as the single source so the domain decision and the boundary
 * check share one bound (教訓 §4 単一真実源).
 */
export const MAX_IMAGE_DIMENSION_PX = 32768;

/** Minimum accepted pixel dimension (a degenerate 0/1-px image is not a map). */
export const MIN_IMAGE_DIMENSION_PX = 2;

/**
 * Maximum accepted base-map image FILE size in bytes (64 MB). The real project data
 * (a 4096×2048 PNG) is ~2 orders of magnitude below this; anything larger is not a
 * plausible base map. This is the SINGLE SOURCE (教訓 §4 / 5.29 単一真実源) for the
 * byte cap enforced at BOTH boundaries a base-map image crosses: the main process
 * stats a picked file and refuses to read past this before the bytes ever cross IPC
 * (FR-04 / ipc-handlers.handleOpenImage), and the renderer's untrusted-byte guard
 * (base-map-image-guard.checkBaseMapImageBytes, which re-exports this) caps a `.gimoza`
 * base-map entry before decode. Kept in the domain layer so the shell (main) can
 * import it WITHOUT depending on the renderer/ui layer.
 */
export const MAX_BASE_MAP_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * A base-map image descriptor that has ALREADY passed boundary validation
 * (FR-116 / NFR 5.5): finite, positive, in-range integer pixel dimensions. The
 * domain format logic consumes only this validated shape — it never sees raw,
 * unvalidated external input (R8). The `source` is the project-relative reference
 * the persistence unit will use; this module only carries it through.
 */
export interface ValidatedImageDescriptor {
  /** Image width in pixels (validated: integer, in [MIN, MAX]). */
  readonly widthPx: number;
  /** Image height in pixels (validated: integer, in [MIN, MAX]). */
  readonly heightPx: number;
  /** Project-relative source reference (path / id); carried through verbatim. */
  readonly source: string;
}

/** Why a descriptor failed boundary validation (used by the boundary validator). */
export const IMAGE_VALIDATION_ERROR = {
  NotFinite: 'notFinite',
  NotInteger: 'notInteger',
  TooSmall: 'tooSmall',
  TooLarge: 'tooLarge',
} as const;

export type ImageValidationError =
  (typeof IMAGE_VALIDATION_ERROR)[keyof typeof IMAGE_VALIDATION_ERROR];

/**
 * The boundary validator (FR-116 / NFR 5.5 / R8). Raw width/height read from an
 * external image file are validated here BEFORE the domain format logic runs, so
 * NaN / fractional / absurd-sized inputs cannot flow into the renderer or domain.
 *
 * This is a pure decision (no I/O): the file→pixels decode is the adapter's job;
 * this function classifies the resulting raw numbers. Named explicitly as the
 * "validate external input" boundary so the discipline is visible (R8: lint /
 * review can see external input passes through `validateImageDescriptor`).
 *
 * Returns a discriminated result: `ok` carries the typed `ValidatedImageDescriptor`
 * the domain may consume; otherwise a structured error usable for a日本語 notice.
 */
export type ImageValidation =
  | { readonly ok: true; readonly descriptor: ValidatedImageDescriptor }
  | { readonly ok: false; readonly error: ImageValidationError };

export function validateImageDescriptor(
  raw: { readonly widthPx: number; readonly heightPx: number; readonly source: string },
): ImageValidation {
  const { widthPx, heightPx } = raw;
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) {
    return { ok: false, error: IMAGE_VALIDATION_ERROR.NotFinite };
  }
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx)) {
    return { ok: false, error: IMAGE_VALIDATION_ERROR.NotInteger };
  }
  if (widthPx < MIN_IMAGE_DIMENSION_PX || heightPx < MIN_IMAGE_DIMENSION_PX) {
    return { ok: false, error: IMAGE_VALIDATION_ERROR.TooSmall };
  }
  if (widthPx > MAX_IMAGE_DIMENSION_PX || heightPx > MAX_IMAGE_DIMENSION_PX) {
    return { ok: false, error: IMAGE_VALIDATION_ERROR.TooLarge };
  }
  return {
    ok: true,
    descriptor: { widthPx, heightPx, source: raw.source },
  };
}

/**
 * The aspect ratio (width / height) of a validated descriptor. Pure; the
 * descriptor's height is guaranteed positive by validation, so this never divides
 * by zero.
 */
export function aspectRatio(descriptor: ValidatedImageDescriptor): number {
  return descriptor.widthPx / descriptor.heightPx;
}

/** True iff the descriptor's aspect is already 2:1 within tolerance (no correction). */
export function isFormatAdequate(descriptor: ValidatedImageDescriptor): boolean {
  const ratio = aspectRatio(descriptor);
  const tol = EQUIRECTANGULAR_ASPECT * ASPECT_TOLERANCE;
  return Math.abs(ratio - EQUIRECTANGULAR_ASPECT) <= tol;
}

/**
 * True iff an inadequate descriptor is close enough to 2:1 for auto-correction
 * (reframe to 2:1 by padding / cropping) to be attempted. Beyond
 * `MAX_CORRECTABLE_ASPECT_FACTOR` from the target the image is too far from an
 * equirectangular world map to reinterpret, so correction is declared impossible.
 *
 * The departure is measured symmetrically: `factor = max(ratio/target, target/ratio)`
 * so a 8:1 banner and a 1:4 portrait are both judged by the same bound.
 */
export function isCorrectable(descriptor: ValidatedImageDescriptor): boolean {
  const ratio = aspectRatio(descriptor);
  const factor = Math.max(
    ratio / EQUIRECTANGULAR_ASPECT,
    EQUIRECTANGULAR_ASPECT / ratio,
  );
  return factor <= MAX_CORRECTABLE_ASPECT_FACTOR;
}

/**
 * The target pixel dimensions after correcting an inadequate-but-correctable image
 * to a 2:1 frame (spec §自動補正: 縦横比のリサンプル／余白付加・切り抜き). The
 * correction keeps the LARGER of the two axis extents and derives the other from
 * the 2:1 constraint, so no original detail is downscaled away (we pad rather than
 * crop when the image is too tall, and keep width when it is too wide):
 *   - if too wide (ratio > 2): keep width, set height = width / 2 (pad top/bottom),
 *   - if too tall (ratio < 2): keep height, set width = height * 2 (pad left/right).
 * Dimensions are rounded to integers. Pure; only valid for a correctable descriptor.
 */
export interface CorrectedDimensions {
  readonly widthPx: number;
  readonly heightPx: number;
}

export function correctedDimensions(
  descriptor: ValidatedImageDescriptor,
): CorrectedDimensions {
  const ratio = aspectRatio(descriptor);
  if (ratio > EQUIRECTANGULAR_ASPECT) {
    // Too wide: keep width, grow height to halve the aspect.
    return {
      widthPx: descriptor.widthPx,
      heightPx: Math.round(descriptor.widthPx / EQUIRECTANGULAR_ASPECT),
    };
  }
  // Too tall (or already-adequate, which corrects to itself): keep height.
  return {
    widthPx: Math.round(descriptor.heightPx * EQUIRECTANGULAR_ASPECT),
    heightPx: descriptor.heightPx,
  };
}

// --- The differ decision (fixed-order flow, structured result) --------------

/**
 * The kind of outcome of the base-map差し替え flow (spec §差し替えの結果). Each is a
 * stable discriminant so the caller branches once and tests assert on it directly
 * (教訓 5.26 / 5.29: a single decision drives every path):
 *   - Adopted: format adequate, used as-is.
 *   - CorrectedAndAdopted: inadequate but correctable, corrected then used.
 *   - FallbackToPreset: not correctable (or input invalid) → preset fallback.
 */
export const BASEMAP_OUTCOME = {
  Adopted: 'adopted',
  CorrectedAndAdopted: 'correctedAndAdopted',
  FallbackToPreset: 'fallbackToPreset',
} as const;

export type BasemapOutcome =
  (typeof BASEMAP_OUTCOME)[keyof typeof BASEMAP_OUTCOME];

/** Why a差し替え fell back to the preset (drives the日本語 notice). */
export const BASEMAP_FALLBACK_REASON = {
  /** Boundary validation failed (corrupt / absurd dimensions / non-image). */
  InvalidImage: 'invalidImage',
  /** Aspect too far from 2:1 to reinterpret as equirectangular. */
  Uncorrectable: 'uncorrectable',
} as const;

export type BasemapFallbackReason =
  (typeof BASEMAP_FALLBACK_REASON)[keyof typeof BASEMAP_FALLBACK_REASON];

/**
 * The structured decision returned by {@link decideBasemapReplacement}. It is
 * consumed BOTH as a testable value (the discriminant + fields) AND to drive the
 * 日本語 user notice (教訓 5.26). On an adopting outcome it carries the
 * project-copy registration intent (`registerCopy = true`, spec FR-04 §プロジェクト
 * 内コピー保存: the differ marks the asset as save-target; the ZIP write is the
 * persistence unit's job). On fallback `registerCopy` is false — nothing is saved
 * and the current display stays the preset (教訓 5.22).
 */
export type BasemapDecision =
  | {
      readonly outcome: typeof BASEMAP_OUTCOME.Adopted;
      readonly source: string;
      /** Dimensions to use (unchanged from the adopted image). */
      readonly dimensions: CorrectedDimensions;
      /** FR-04: register the adopted map as a project-copy save target. */
      readonly registerCopy: true;
    }
  | {
      readonly outcome: typeof BASEMAP_OUTCOME.CorrectedAndAdopted;
      readonly source: string;
      /** Dimensions after 2:1 correction (spec §自動補正). */
      readonly dimensions: CorrectedDimensions;
      readonly registerCopy: true;
    }
  | {
      readonly outcome: typeof BASEMAP_OUTCOME.FallbackToPreset;
      readonly reason: BasemapFallbackReason;
      /** Nothing adopted, nothing saved (preset stays displayed). */
      readonly registerCopy: false;
    };

/**
 * Decide the base-map差し替え in the FIXED order (spec §実装方針): adequacy →
 * (inadequate) correction試行 → adopt / corrected-adopt / preset-fallback. Pure:
 * takes a boundary `ImageValidation` (so the invalid-input path is one branch, not
 * a thrown error) and returns a structured {@link BasemapDecision}. No display
 * state is touched here (教訓 5.22) — the caller applies the decision on success
 * and keeps the preset on fallback.
 */
export function decideBasemapReplacement(
  validation: ImageValidation,
): BasemapDecision {
  if (!validation.ok) {
    return {
      outcome: BASEMAP_OUTCOME.FallbackToPreset,
      reason: BASEMAP_FALLBACK_REASON.InvalidImage,
      registerCopy: false,
    };
  }
  const descriptor = validation.descriptor;
  if (isFormatAdequate(descriptor)) {
    return {
      outcome: BASEMAP_OUTCOME.Adopted,
      source: descriptor.source,
      dimensions: { widthPx: descriptor.widthPx, heightPx: descriptor.heightPx },
      registerCopy: true,
    };
  }
  if (isCorrectable(descriptor)) {
    return {
      outcome: BASEMAP_OUTCOME.CorrectedAndAdopted,
      source: descriptor.source,
      dimensions: correctedDimensions(descriptor),
      registerCopy: true,
    };
  }
  return {
    outcome: BASEMAP_OUTCOME.FallbackToPreset,
    reason: BASEMAP_FALLBACK_REASON.Uncorrectable,
    registerCopy: false,
  };
}
