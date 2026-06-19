// Pure command contract (技術方針 2.6: pure command -> new domain state, Immer
// immutable update, dual-stack undo/redo). U12 defines the *contract* and the
// execution/history infrastructure; individual edit commands are implemented by
// later units against this contract (spec スコープ「やらないこと」).
//
// A command is generic over the opaque domain-state root type `S`. U03 owns the
// concrete state shape; U12 must not reach into it (spec 依存「U03 の具体的な
// 内部表現に踏み込まず、ルート状態を不変に受け渡す純粋関数として閉じる」). The
// command therefore treats `S` as an immutable value it receives and returns,
// using Immer's structural sharing in the implementing command (技術方針 2.6 /
// リスク R4) — never a deep copy of the whole state.

import type { CommandResult } from './result';
import { mergeCommandResults } from './result';

/**
 * The outcome of applying / reverting a command: the new domain state plus the
 * result describing which elements were touched (教訓 5.11 / 5.23).
 */
export interface CommandOutcome<S> {
  readonly state: S;
  readonly result: CommandResult;
}

/**
 * A command is a pure, reversible state transition.
 *
 * `execute`, `undo`, `redo` are all pure: same input state -> same output
 * state and result (決定性, 受け入れ基準 1). They do not mutate the input
 * state. `redo` MUST restore the same element IDs that `execute` first
 * generated — it does not re-mint IDs (教訓 5.20). A command captures whatever
 * undo data (including its first-generation IDs) it needs at construction /
 * execute time so that `undo` and `redo` are deterministic replays.
 *
 * `kind` is a typed discriminator routed through a constant/factory, never a
 * bare display string (教訓 5.19).
 */
export interface Command<S> {
  readonly kind: CommandKind;
  /** Human-meaningful label for menus/history UI. Never used for branching. */
  readonly label: string;
  execute(state: S): CommandOutcome<S>;
  undo(state: S): CommandOutcome<S>;
  redo(state: S): CommandOutcome<S>;
}

/**
 * Command-kind discriminator. Individual units register their kinds as members
 * of this branded string type via {@link defineCommandKind}; branching never
 * uses a raw literal (教訓 5.19).
 */
declare const CommandKindBrand: unique symbol;
export type CommandKind = string & { readonly [CommandKindBrand]: 'CommandKind' };

/**
 * Define a command kind constant. The single place a kind string is minted, so
 * create / execute / undo / redo / search all reference the same value
 * (教訓 5.19 検出: "use the same value on every path").
 */
export function defineCommandKind(raw: string): CommandKind {
  return raw as CommandKind;
}

/** The reserved kind for composite (single-undo-unit) commands. */
export const COMPOSITE_COMMAND_KIND = defineCommandKind('composite');

/**
 * Build a composite command from ordered sub-commands. The composite is a
 * single, indivisible undo unit (FR-73 / FR-94): one execute applies every
 * sub-command in order; one undo reverts every sub-command in reverse order;
 * one redo re-applies them in order. Partial undo/redo of a subset is
 * impossible because the only public operations are over the whole composite
 * (受け入れ基準 3「不可分」).
 *
 * The composite's result aggregates the sub-results (受け入れ基準 4) via
 * {@link mergeCommandResults}, so a transient ID (created then deleted inside
 * the composite) counts as neither created nor survived.
 */
export function createCompositeCommand<S>(
  label: string,
  subCommands: ReadonlyArray<Command<S>>,
): Command<S> {
  return {
    kind: COMPOSITE_COMMAND_KIND,
    label,
    execute(state: S): CommandOutcome<S> {
      let current = state;
      const results: CommandResult[] = [];
      for (const cmd of subCommands) {
        const outcome = cmd.execute(current);
        current = outcome.state;
        results.push(outcome.result);
      }
      return { state: current, result: mergeCommandResults(results) };
    },
    undo(state: S): CommandOutcome<S> {
      let current = state;
      const results: CommandResult[] = [];
      // Reverse order: the last applied sub-command is undone first.
      for (let i = subCommands.length - 1; i >= 0; i -= 1) {
        const cmd = subCommands[i];
        if (cmd === undefined) continue; // unreachable (noUncheckedIndexedAccess)
        const outcome = cmd.undo(current);
        current = outcome.state;
        results.push(outcome.result);
      }
      return { state: current, result: mergeCommandResults(results) };
    },
    redo(state: S): CommandOutcome<S> {
      let current = state;
      const results: CommandResult[] = [];
      for (const cmd of subCommands) {
        const outcome = cmd.redo(current);
        current = outcome.state;
        results.push(outcome.result);
      }
      return { state: current, result: mergeCommandResults(results) };
    },
  };
}

/** True when the command is a composite (single indivisible undo unit). */
export function isCompositeCommand<S>(command: Command<S>): boolean {
  return command.kind === COMPOSITE_COMMAND_KIND;
}
