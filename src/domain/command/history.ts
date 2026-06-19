// Dual-stack undo/redo history (FR-73 / FR-74 / FR-94), implemented as a pure
// immutable value plus pure operations. Each operation takes the current
// history value and returns a new one; the previous value is never mutated, so
// before/after states are directly comparable in tests (受け入れ基準 1 / 2 / 3,
// 技術方針 2.6).
//
// Memory: the history holds commands (which capture structurally-shared state
// or reversible-op data) and the current root state — never a deep copy of the
// whole state per entry (技術方針 リスク R4 / NFR 5.2). Immer's structural
// sharing in the implementing commands keeps the stack cheap at 5,000-object
// scale.

import type { Command, CommandOutcome } from './command';
import type { CommandResult } from './result';
import { EMPTY_COMMAND_RESULT } from './result';

/** Default undo-stack depth limit (FR-74). Configurable via {@link createHistory}. */
export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Immutable dual-stack history value. `state` is the current domain-state root.
 * `undoStack` holds applied commands oldest→newest; `redoStack` holds undone
 * commands ready to be re-applied. `limit` is the max undo-stack depth.
 */
export interface History<S> {
  readonly state: S;
  readonly undoStack: ReadonlyArray<Command<S>>;
  readonly redoStack: ReadonlyArray<Command<S>>;
  readonly limit: number;
}

/** The result of a history transition: new history + the outcome's result. */
export interface HistoryStep<S> {
  readonly history: History<S>;
  /** The command result of the transition (empty when nothing happened). */
  readonly result: CommandResult;
}

/**
 * Create a fresh history rooted at `initialState`. `limit` defaults to
 * {@link DEFAULT_HISTORY_LIMIT} and is configurable (FR-74「設定変更可」). A
 * limit < 1 is clamped to 1.
 */
export function createHistory<S>(
  initialState: S,
  limit: number = DEFAULT_HISTORY_LIMIT,
): History<S> {
  return {
    state: initialState,
    undoStack: [],
    redoStack: [],
    limit: Math.max(1, Math.floor(limit)),
  };
}

/** True when there is at least one command to undo (FR-74 menu/shortcut gating). */
export function canUndo<S>(history: History<S>): boolean {
  return history.undoStack.length > 0;
}

/** True when there is at least one command to redo (FR-74 menu/shortcut gating). */
export function canRedo<S>(history: History<S>): boolean {
  return history.redoStack.length > 0;
}

/**
 * Trim the undo stack from the oldest end so it does not exceed `limit`
 * (FR-74「上限到達時は最古の操作から破棄する」). Pure helper used by push.
 */
function trimUndoStack<S>(
  stack: ReadonlyArray<Command<S>>,
  limit: number,
): ReadonlyArray<Command<S>> {
  if (stack.length <= limit) return stack;
  // Drop the oldest (front) entries.
  return stack.slice(stack.length - limit);
}

/**
 * Execute a new command and push it as one undo unit. Applies the command to
 * the current state, pushes it onto the undo stack (oldest entries trimmed past
 * the limit), and clears the redo stack entirely (FR-74「新しい編集操作実行時は
 * リドゥスタックを全破棄」). A composite command is a single entry, so it is one
 * indivisible undo unit (FR-73 / FR-94).
 */
export function execute<S>(
  history: History<S>,
  command: Command<S>,
): HistoryStep<S> {
  const outcome: CommandOutcome<S> = command.execute(history.state);
  const undoStack = trimUndoStack(
    [...history.undoStack, command],
    history.limit,
  );
  return {
    history: {
      state: outcome.state,
      undoStack,
      redoStack: [], // new edit operation drops the entire redo stack (FR-74)
      limit: history.limit,
    },
    result: outcome.result,
  };
}

/**
 * Undo the most recent command. Pops it off the undo stack, reverts the state,
 * and pushes the command onto the redo stack. When the undo stack is empty this
 * is a no-op (returns the same history value and an empty result), so callers
 * can gate on {@link canUndo} (FR-74).
 */
export function undo<S>(history: History<S>): HistoryStep<S> {
  const command = history.undoStack[history.undoStack.length - 1];
  if (command === undefined) {
    return { history, result: EMPTY_COMMAND_RESULT };
  }
  const outcome = command.undo(history.state);
  return {
    history: {
      state: outcome.state,
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [...history.redoStack, command],
      limit: history.limit,
    },
    result: outcome.result,
  };
}

/**
 * Redo the most recently undone command. Pops it off the redo stack, re-applies
 * the state, and pushes the command back onto the undo stack. `redo` restores
 * first-generation IDs (the command captured them; 教訓 5.20). When the redo
 * stack is empty this is a no-op (FR-74).
 */
export function redo<S>(history: History<S>): HistoryStep<S> {
  const command = history.redoStack[history.redoStack.length - 1];
  if (command === undefined) {
    return { history, result: EMPTY_COMMAND_RESULT };
  }
  const outcome = command.redo(history.state);
  return {
    history: {
      state: outcome.state,
      undoStack: trimUndoStack(
        [...history.undoStack, command],
        history.limit,
      ),
      redoStack: history.redoStack.slice(0, -1),
      limit: history.limit,
    },
    result: outcome.result,
  };
}

/** Drop the redo stack without touching the undo stack or state. Pure. */
export function clearRedo<S>(history: History<S>): History<S> {
  if (history.redoStack.length === 0) return history;
  return { ...history, redoStack: [] };
}

/**
 * Return a history with a new undo-stack depth limit (FR-74「設定で変更可能」).
 * If the new limit is smaller than the current undo stack, the oldest entries
 * are trimmed immediately. A limit < 1 is clamped to 1.
 */
export function withLimit<S>(history: History<S>, limit: number): History<S> {
  const clamped = Math.max(1, Math.floor(limit));
  return {
    ...history,
    limit: clamped,
    undoStack: trimUndoStack(history.undoStack, clamped),
  };
}

/**
 * Execute a command only when it is not a no-op against the current baseline
 * (教訓 5.24: confirm handlers — blur/Enter — must not push "ghost" entries).
 *
 * `isNoOp` is supplied by the caller and derived from the same source as the
 * form sync (教訓 5.24「baseline はフォーム同期と同一ソースから導出する」). When
 * it returns true the history is returned unchanged with an empty result; the
 * command is never executed and no entry is pushed.
 */
export function executeIfChanged<S>(
  history: History<S>,
  command: Command<S>,
  isNoOp: (currentState: S) => boolean,
): HistoryStep<S> {
  if (isNoOp(history.state)) {
    return { history, result: EMPTY_COMMAND_RESULT };
  }
  return execute(history, command);
}
