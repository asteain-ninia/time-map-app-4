// Redo-time selection-preference recovery (第6波 redo-drops-selection-preference).
//
// A committed edit promotes a "next target" selection preference (the created /
// merged / reparented feature) through applyCommandResult (教訓 5.11 次対象昇格).
// That preference is a UI-layer value the pure Command does NOT carry, so a plain
// redo — which replays the Command back through applyUndoRedoResult — had no way
// to recover it and dropped the promoted selection (metamorphic redo == execute
// broke on the selection sub-state).
//
// The fix keeps the preference OUT of the pure command (単一の真実源: the command
// stays domain-only) by remembering it in a WeakMap keyed by the Command at record
// time and looking it back up for the exact Command a redo is about to re-apply.
// A WeakMap is used so a command dropped from the history (redo stack cleared by a
// new edit, or trimmed past the undo limit) is garbage-collected with its entry.

import type { Command, History } from '../../domain/command/index';
import type { NextTargetPreference } from '../../domain/selection/index';

/**
 * The selection preference a committed edit carried (App-level shape). It is a
 * subset of {@link NextTargetPreference}; the commit callbacks only ever promote
 * a single next-target feature (add / knife inheritor / merge result / reparent
 * target), never a vertex set.
 */
export type CommitPreference = NextTargetPreference;

/**
 * A record→lookup registry mapping a committed {@link Command} to the selection
 * preference the commit promoted, so a later redo of that same command can
 * re-promote it. Backed by a WeakMap so entries vanish with the command.
 */
export interface RedoPreferenceRegistry<S> {
  /** Remember the preference a just-committed command promoted. */
  remember(command: Command<S>, preference: CommitPreference | undefined): void;
  /**
   * The preference for the command a redo of `history` will re-apply — i.e. the
   * command on top of the redo stack (see history.redo). `undefined` when the
   * redo stack is empty (nothing to redo) or the command carried no preference.
   */
  preferenceForNextRedo(history: History<S>): CommitPreference | undefined;
}

/** Create a {@link RedoPreferenceRegistry} backed by a WeakMap. */
export function createRedoPreferenceRegistry<S>(): RedoPreferenceRegistry<S> {
  const byCommand = new WeakMap<Command<S>, CommitPreference>();
  return {
    remember(command, preference): void {
      if (preference !== undefined) byCommand.set(command, preference);
    },
    preferenceForNextRedo(history): CommitPreference | undefined {
      // history.redo re-applies the LAST element of redoStack (its top); mirror
      // that selection so we look up the preference for the exact same command.
      const command = history.redoStack[history.redoStack.length - 1];
      return command === undefined ? undefined : byCommand.get(command);
    },
  };
}
