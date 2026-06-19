// U12: pure command infrastructure + dual-stack undo/redo.
//
// Public barrel for the command contract (command + result), the composite
// (single-undo-unit) command factory, and the immutable dual-stack history with
// its pure operations. All framework-free and `domain`-local (技術方針 2.13).

export {
  type CommandResult,
  EMPTY_COMMAND_RESULT,
  createCommandResult,
  mergeCommandResults,
} from './result';

export {
  type Command,
  type CommandOutcome,
  type CommandKind,
  defineCommandKind,
  COMPOSITE_COMMAND_KIND,
  createCompositeCommand,
  isCompositeCommand,
} from './command';

export {
  type History,
  type HistoryStep,
  DEFAULT_HISTORY_LIMIT,
  createHistory,
  canUndo,
  canRedo,
  execute,
  undo,
  redo,
  clearRedo,
  withLimit,
  executeIfChanged,
} from './history';
