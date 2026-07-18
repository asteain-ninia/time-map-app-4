// Public barrel for the U18 base-map domain logic (FR-03 / FR-04 / FR-12 / FR-13).
// Pure, framework-free: format adequacy / correction / fallback decision (FR-04),
// the preset reference + displayed-base-map resolution (FR-03), the grid model +
// emphasis判定 + label normalization (FR-13), and the zoom-dependent longitude
// shift + center presets (FR-12). Drawing lives in the render layer; widgets in
// the ui layer — both consume these pure values (依存方向 internal→domain).

export {
  EQUIRECTANGULAR_ASPECT,
  ASPECT_TOLERANCE,
  MAX_CORRECTABLE_ASPECT_FACTOR,
  MAX_IMAGE_DIMENSION_PX,
  MIN_IMAGE_DIMENSION_PX,
  MAX_BASE_MAP_IMAGE_BYTES,
  type ValidatedImageDescriptor,
  IMAGE_VALIDATION_ERROR,
  type ImageValidationError,
  type ImageValidation,
  validateImageDescriptor,
  aspectRatio,
  isFormatAdequate,
  isCorrectable,
  type CorrectedDimensions,
  correctedDimensions,
  BASEMAP_OUTCOME,
  type BasemapOutcome,
  BASEMAP_FALLBACK_REASON,
  type BasemapFallbackReason,
  type BasemapDecision,
  decideBasemapReplacement,
} from './format';

export { basemapNotice } from './messages';

export {
  PRESET_BASEMAP_ID,
  type EquirectangularMeta,
  FULL_WORLD_META,
  DISPLAYED_BASEMAP,
  type DisplayedBasemapKind,
  type ResolvedBasemap,
  resolveDisplayedBasemap,
} from './preset';

export {
  GRID_SPACINGS_DEG,
  type GridSpacingDeg,
  DEFAULT_GRID_SPACING_DEG,
  isGridSpacing,
  coerceGridSpacing,
  GRID_EMPHASIS,
  type GridEmphasis,
  latitudeEmphasis,
  longitudeEmphasis,
  isLatitudeEmphasized,
  isLongitudeEmphasized,
  LAT_MIN_DEG,
  LAT_MAX_DEG,
  graticuleLatitudes,
  graticuleLongitudes,
  formatLatitudeLabel,
  formatLongitudeLabel,
} from './grid';

export {
  SHIFT_PX_PER_UNIT,
  shiftToLonDelta,
  applyLongitudeShift,
  CENTER_LON_PRESET,
  type CenterLonPreset,
  CENTER_LON_PRESET_VALUE,
  centerLonForPreset,
  representativeCenterLon,
  formatCenterLonDisplay,
} from './longitude-shift';
