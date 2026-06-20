// UI layer (U39): public barrel for the file-operation UI flows + zoom limit.
//
// File operations (保存 / 名前を付けて保存 / 読み込み / D&D), the unsaved-changes
// guard (FR-107), the new-project / save-context initialisation (教訓 5.36 / FR-03),
// the load-time consistency auto-repair flow (FR-106), and the zoom-limit settings
// (FR-10). These are PURE flow/decision modules + thin handlers (受け入れ基準 7);
// the React shell wires them onto U20's menu / shortcuts / modal and U15's typed
// IPC, and supplies the zoom range to U17 via U16's store (spec §依存).

// --- zoom limit (FR-10 / E) -------------------------------------------------
export {
  type ZoomRangeValue,
  type ZoomLimitError,
  type ZoomLimitValidation,
  ZOOM_LIMIT_REJECTION,
  isWithinZoomBoundary,
  validateZoomLimits,
  zoomRangeOf,
} from './zoom-limit';

// --- unsaved-changes guard (FR-107 / B) -------------------------------------
export {
  type UnsavedChoice,
  type GuardAction,
  type UnsavedGuardPorts,
  UNSAVED_CHOICE,
  GUARD_ACTION,
  decideUnsavedGuard,
  decideAfterSave,
  runUnsavedGuard,
} from './unsaved-guard';

// --- save context / new-project (教訓 5.36 / FR-03 / D) ----------------------
export {
  type ProjectMetadata,
  type SaveContext,
  EMPTY_PROJECT_METADATA,
  buildEmptyProject,
  buildNewProjectContext,
  contextForLoadedFile,
  contextAfterSave,
  markDirty,
  needsSaveAs,
} from './save-context';

// --- load-time consistency auto-repair flow (FR-106 / C) --------------------
export {
  type RepairRow,
  type RepairChoices,
  type RepairApplyResult,
  type RepairOutcomeKind,
  REPAIR_OUTCOME,
  EMPTY_REPAIR_CHOICES,
  INCONSISTENCY_LABELS,
  buildRepairRows,
  describeInconsistency,
  setRepairChoice,
  allChoicesMade,
  applyChosenRepairs,
} from './repair-flow';

// --- the single load flow classifier (FR-104 / FR-106 / FR-116 / A) ---------
export {
  type LoadTransport,
  type LoadTransportReason,
  type LoadStep,
  type LoadStepKind,
  LOAD_STEP,
  LOAD_TRANSPORT_REASON,
  classifyLoad,
} from './load-flow';

// --- the U15 LoadResponse → LoadTransport adapter (受け入れ基準 6 / 教訓 5.33) -
export { loadTransportFrom } from './load-adapter';

// --- renderable dialog bodies on U20's modal vessel (FR-106 / FR-107) -------
export {
  type UnsavedWarningDialogProps,
  UnsavedWarningDialog,
} from './UnsavedWarningDialog';
export {
  type RepairDialogProps,
  RepairDialog,
} from './RepairDialog';

// --- the app bridge: live ports + the React controller (受け入れ基準 1 / 6) --
export {
  type FileOpsHost,
  buildFileCommandPorts,
  cameraZoomRange,
} from './bridge';
export {
  type FileOpsControllerProps,
  type SupplyZoomRange,
  type WindowCloseHook,
  type FileDropHandlers,
  type DropTargetHook,
  FileOpsController,
} from './FileOpsController';

// --- file-operation command handlers (FR-105 / A) ---------------------------
export {
  type FileCommandPorts,
  saveCommand,
  saveAsCommand,
  openCommand,
  dropLoadCommand,
  newProjectCommand,
  quitGuard,
} from './file-commands';

// --- centralised Japanese strings (FR-115) ----------------------------------
export {
  UNSAVED_STRINGS,
  REPAIR_STRINGS,
  FILE_OPS_STRINGS,
} from './strings';
