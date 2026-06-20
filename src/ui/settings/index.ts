// UI layer (U38 / settings): public barrel for the settings dialog + confirm flow.
//
// The modal (FR-109 / FR-110), the draft/validate/confirm hook (the調停層), the
// PURE validation + defaults factory + draft→commit diff, and the centralised
// Japanese strings. ui → domain / ui-state only (lint-enforced); the settings
// TRUTH, classification and notification stay in U16's store (技術方針 2.5 /
// 2.13, 教訓 5.19). The new-project path (U39) consumes `defaultProjectSettings`.

export {
  SettingsDialog,
  type SettingsDialogProps,
} from './SettingsDialog';

export {
  useSettingsDialog,
  type UseSettingsDialog,
  type SettingsDialogState,
  type SettingsDialogActions,
  type SettingsStorePort,
  type ConfirmResult,
  type ConfirmStatus,
  CONFIRM_STATUS,
} from './useSettingsDialog';

export {
  type SettingsValidationError,
  type ValidationResult,
  defaultProjectSettings,
  defaultAppSettings,
  validateProjectSettings,
  validateAppSettings,
  REJECTION,
  OPACITY_MIN,
  OPACITY_MAX,
  OCCUPANCY_MIN,
  OCCUPANCY_MAX,
  SNAP_DISTANCE_MIN,
  VERTEX_MARKER_CAP_MIN,
} from './validation';

export {
  changedProjectKeys,
  changedAppKeys,
  isProjectNoOp,
  isAppNoOp,
} from './diff';

export {
  SETTINGS_STRINGS,
  PROJECT_FIELD_STRINGS,
  APP_FIELD_STRINGS,
  BASEMAP_STRINGS,
  PALETTE_STRINGS,
} from './strings';
