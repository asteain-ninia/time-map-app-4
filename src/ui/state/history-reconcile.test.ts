// F2 unit test (node): the pure edit-history reconciliation for a store DOMAIN swap
// that App observes through its store subscription but did NOT author via a command.
//
// The bug: a base-map REPLACE (FR-04) swaps the store domain reference, and App's
// subscription — which re-roots the history on any unauthored domain change (a file
// LOAD / NEW) — treated the replace as an external swap and REBUILT the history with an
// EMPTY stack, silently destroying the user's edit undo/redo. The fix distinguishes a
// base-map replace (preserve the stacks, rebase only the current root) from a genuine
// external whole-state swap (re-root). This pins that pure decision.

import { describe, expect, it } from 'vitest';

import { createHistory, execute, canUndo, canRedo } from '../../domain/command/history';
import { defineCommandKind } from '../../domain/command/command';
import type { Command, CommandOutcome } from '../../domain/command/command';
import { EMPTY_COMMAND_RESULT } from '../../domain/command/result';
import { reconcileHistoryOnExternalDomainSwap } from './history-reconcile';

interface D {
  readonly baseMap: string;
  readonly features: number;
}

const ADD = defineCommandKind('test/add-feature');

/** A whole-state-swap command capturing before/after — the shape App's edits use. */
function addFeatureCommand(before: D, after: D): Command<D> {
  const outcome = (state: D): CommandOutcome<D> => ({ state, result: EMPTY_COMMAND_RESULT });
  return {
    kind: ADD,
    label: 'add feature',
    execute: () => outcome(after),
    undo: () => outcome(before),
    redo: () => outcome(after),
  };
}

/** A history with ONE committed edit (a non-empty undo stack) at base map "B0". */
function historyWithOneEdit() {
  const root: D = { baseMap: 'B0', features: 0 };
  const edited: D = { baseMap: 'B0', features: 1 };
  const step = execute(createHistory(root, 100), addFeatureCommand(root, edited));
  return step.history; // state = edited, undoStack = [cmd], redoStack = []
}

describe('reconcileHistoryOnExternalDomainSwap — base-map replace preserves edit history (F2)', () => {
  it('a base-map replace KEEPS the undo/redo stacks and only rebases the root state', () => {
    const current = historyWithOneEdit();
    expect(canUndo(current)).toBe(true);

    const replaced: D = { baseMap: 'B1', features: 1 }; // same features, new base map
    const next = reconcileHistoryOnExternalDomainSwap({
      current,
      nextDomain: replaced,
      undoStackSize: 100,
      isBasemapReplace: true,
    });

    // The edit undo stack SURVIVES the replace — the user can still undo the feature add.
    expect(canUndo(next)).toBe(true);
    expect(next.undoStack).toBe(current.undoStack);
    expect(next.redoStack).toBe(current.redoStack);
    // The current root is rebased onto the new (base-map-swapped) domain so a later
    // edit builds on the new base map.
    expect(next.state).toBe(replaced);
    expect(next.limit).toBe(current.limit);
  });

  it('an external whole-state swap (load/new) RE-ROOTS a fresh empty history', () => {
    const current = historyWithOneEdit();
    expect(canUndo(current)).toBe(true);

    const loaded: D = { baseMap: 'BX', features: 9 };
    const next = reconcileHistoryOnExternalDomainSwap({
      current,
      nextDomain: loaded,
      undoStackSize: 100,
      isBasemapReplace: false,
    });

    // A load's old stack is meaningless against the new project — it is dropped.
    expect(canUndo(next)).toBe(false);
    expect(canRedo(next)).toBe(false);
    expect(next.state).toBe(loaded);
  });

  it('re-root honours the configured undo-stack depth limit (FR-74)', () => {
    const current = historyWithOneEdit();
    const next = reconcileHistoryOnExternalDomainSwap({
      current,
      nextDomain: { baseMap: 'BX', features: 9 },
      undoStackSize: 7,
      isBasemapReplace: false,
    });
    expect(next.limit).toBe(7);
  });
});
