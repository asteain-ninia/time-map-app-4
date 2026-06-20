// U23 — add-tool UI barrel (FR-76 / FR-77 / FR-78).
//
// The React interaction layer for the add flow: the `useAddTool` hook that wires
// the pure U23 domain core (session machine / shape validation / snap / proposal
// assembly) to the store + the U13 process trigger + the property form, with all
// completion triggers配線 (教訓 5.7) and the single reset契約 on every exit path
// (教訓 5.2). Import direction ui → domain (allowed).

export {
  ADD_PHASE,
  type AddPhase,
  type StartAddProcess,
  type UseAddToolOptions,
  type UseAddToolState,
  type UseAddToolActions,
  type UseAddTool,
  useAddTool,
  PARENT_UNSET,
} from './useAddTool';

export {
  ADD_STRINGS,
  REPORT_HINT,
  withReportHint,
  shapeRejectionMessage,
} from './strings';

// The toolbar-tool ↔ add-tool-kind mapping (single source; 教訓 5.30 / 5.19).
export { addToolKindFor } from './tool-kind';

// The layer-crossing INTEGRATION component: it consumes useAddTool +
// buildAddPrimitives and wires them to the shell store / map input / U13 / render
// sink (教訓 5.7 完了トリガーの明示配線 / 教訓 5.2 全経路で破棄).
export {
  AddToolController,
  NO_DRAW_SINK,
  type AddToolControllerProps,
  type AddDrawSink,
  type ScreenToWorld,
} from './AddToolController';

export { AddPropertyForm, type AddPropertyFormProps } from './AddPropertyForm';

// App-level host ports backed by the live U17 renderer (render接続).
export { createAddHostPorts, type AddHostPorts } from './host-ports';
