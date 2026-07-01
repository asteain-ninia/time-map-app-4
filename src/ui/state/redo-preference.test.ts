// 第6波 redo-drops-selection-preference: a redo must recover the selection
// preference (次対象昇格) the original commit promoted. The registry remembers
// the preference by command and hands it back for the command a redo re-applies,
// so runRedo can forward it to applyUndoRedoResult (previously it passed none, so
// the promoted feature was never re-selected after add→undo→redo).

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type CommandOutcome,
  createHistory,
  execute as historyExecute,
  undo as historyUndo,
  defineCommandKind,
  createCommandResult,
} from '../../domain/command/index';
import { asFeatureId } from '../../domain/ids';

import { createRedoPreferenceRegistry } from './redo-preference';

interface D {
  readonly tag: string;
}

const f = (s: string) => asFeatureId(s);

// A trivial command whose result "creates" one feature id, standing in for a
// real add / merge / reparent commit.
function makeCommand(createdId: string): Command<D> {
  const result = createCommandResult({ created: [f(createdId)] });
  const outcome: CommandOutcome<D> = { state: { tag: createdId }, result };
  return {
    kind: defineCommandKind('test'),
    label: 'test',
    execute: () => outcome,
    undo: () => ({ state: { tag: 'd0' }, result }),
    redo: () => outcome,
  };
}

describe('createRedoPreferenceRegistry', () => {
  it('returns the remembered preference for the command a redo will re-apply', () => {
    const registry = createRedoPreferenceRegistry<D>();
    const command = makeCommand('A');
    registry.remember(command, { featureId: f('A') });

    // Execute then undo: the command is now on top of the redo stack.
    let history = historyExecute(createHistory<D>({ tag: 'd0' }), command).history;
    history = historyUndo(history).history;

    expect(registry.preferenceForNextRedo(history)).toEqual({ featureId: f('A') });
  });

  it('returns undefined when the redo stack is empty (nothing to redo)', () => {
    const registry = createRedoPreferenceRegistry<D>();
    const command = makeCommand('A');
    registry.remember(command, { featureId: f('A') });

    const history = historyExecute(createHistory<D>({ tag: 'd0' }), command).history;
    // Not undone: redo stack empty.
    expect(registry.preferenceForNextRedo(history)).toBeUndefined();
  });

  it('returns undefined for a command committed without a preference', () => {
    const registry = createRedoPreferenceRegistry<D>();
    const command = makeCommand('A');
    registry.remember(command, undefined); // e.g. a reparent with no target

    let history = historyExecute(createHistory<D>({ tag: 'd0' }), command).history;
    history = historyUndo(history).history;

    expect(registry.preferenceForNextRedo(history)).toBeUndefined();
  });
});
