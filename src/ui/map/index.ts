// UI layer (U18 / map widgets): public barrel.
//
// The longitude shift widget (FR-12) and the grid settings panel (FR-13 / FR-109).
// Both are presentational + callback-driven React components; the truth (center
// longitude, grid project settings) lives in U16's store, and the zoom-dependent
// shift conversion is applied once in the domain/wiring (教訓 5.16), not here.

export {
  LongitudeShiftControl,
  type LongitudeShiftControlProps,
} from './LongitudeShiftControl';

export {
  GridSettingsPanel,
  type GridSettings,
  type GridSettingsPanelProps,
} from './GridSettingsPanel';
