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

// U40: mode-aware pointer dispatch + pan/zoom for the central map (FR-09).
//
// The pure decision/threshold logic (decideDispatch / drag threshold / pan
// table), the pure pan math, the dependency PORTS, and the imperative
// PointerDispatcher接着層. Camera/zoom math is delegated to U17 and the camera
// truth to U16 — this barrel exposes the dispatch discipline, not a second
// source of either (受け入れ基準 7 / 8).
export {
  POINTER_BUTTON,
  type PointerButton,
  pointerButtonFromCode,
  panStartsFor,
  DISPATCH_TARGET,
  type DispatchTarget,
  type DispatchInput,
  decideDispatch,
  DRAG_THRESHOLD_PX,
  screenDistanceSq,
  exceedsDragThreshold,
} from './dispatch';

export { type PanReference, panCameraTo } from './pan';

export {
  type CameraPort,
  type HitTester,
  type SelectionPort,
  type EditSessionPort,
  type AddPort,
  type ContextMenuPort,
  type PointerModifiers,
  NO_MODIFIERS,
} from './ports';

export {
  type NormalizedPointer,
  type NormalizedWheel,
  type PointerDispatcherOptions,
  PointerDispatcher,
  buttonFromButtonsMask,
} from './PointerDispatcher';

// U24 completion-trigger wiring: the concrete EditSessionPort that drives U24's
// drag-session (beginDrag/updateDrag/confirmRelease) from pointer input so the
// confirm path is reached from the UI (受け入れ基準9 / 教訓5.7).
export {
  type EditSessionAdapterDeps,
  createEditSessionPort,
} from './edit-session-adapter';
