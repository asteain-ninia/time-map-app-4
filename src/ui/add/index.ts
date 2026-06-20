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
