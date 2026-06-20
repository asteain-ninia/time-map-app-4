// U33 public barrel — area style attributes & automatic four-color assignment
// (FR-100 / FR-101 / FR-102).
//
// Pure domain logic: deterministic color math (hex<->hsl, selection-color &
// derived-color rules), palette expansion (base then deterministic derived),
// adjacency-graph normalization + signature, greedy four-color assignment, the
// auto-coloring orchestration (id -> fill/selected plan), the result-state
// recolor trigger (教訓 5.6), and the auto/manual style-permission rules
// (教訓 5.13). No render / ui / shell imports (依存方向 domain へ内向き).

export {
  type Hsl,
  parseHex,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  deriveSelectedColor,
  deriveColor,
  SELECTION_LIGHTEN_STEP,
  SELECTION_SATURATE_STEP,
  DERIVE_HUE_STEP_DEG,
  DERIVE_LIGHTNESS_STEP,
  DERIVE_SATURATION_STEP,
} from './color-math';

export {
  type PaletteThemeId,
  type Palette,
  DEFAULT_PALETTE_THEME,
  DEFAULT_BASE_COLORS,
  DEFAULT_PALETTE,
  createPalette,
  baseColorCount,
  colorAtIndex,
  isBaseColorIndex,
} from './palette';

export {
  type AdjacencyEdge,
  type AdjacencyGraph,
  buildAdjacencyGraph,
  neighborsOf,
  adjacencySignature,
} from './adjacency';

export {
  type ColorIndexAssignment,
  assignColorIndices,
  findColorConflicts,
  maxColorIndex,
} from './four-color';

export {
  type FeatureColorPlan,
  type ColorPlan,
  computeColorPlan,
  computeColorPlanFor,
} from './auto-color';

export { adjacencyChanged, shouldRecolor } from './recolor-trigger';

export {
  colorValuesEditable,
  paletteSelectable,
  autoColorToggleable,
  manualColorsOnDisable,
  applyAutoColors,
} from './style-permission';

export {
  type FeatureColorPort,
  type AdjacencyTransition,
  RECOLOR_COMMAND_KIND,
  RECOLOR_COMMAND_LABEL,
  composeWithRecolor,
} from './recolor-command';
