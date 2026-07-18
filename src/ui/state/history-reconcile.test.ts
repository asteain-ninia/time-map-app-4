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
import { graftLiveBaseMap, reconcileHistoryOnExternalDomainSwap } from './history-reconcile';

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

// F2 TRUE FIX (Codex re-review): reconcileHistoryOnExternalDomainSwap only rebases the
// history ROOT state; the undo/redo COMMANDS are whole-state swaps that ignore their
// input and return a CAPTURED route carrying the OLD base map (consistency-binding
// makeCommand). So after replace→undo the captured B0 base map came back and B1 was
// lost — the replace was NOT actually non-undoable. `graftLiveBaseMap` grafts the LIVE
// base map onto each captured undo/redo result so the replaced map survives every
// feature-edit undo/redo (the previous test-suite miss: it asserted stack survival but
// never the base map on the UNDO OUTPUT).
describe('graftLiveBaseMap — replace is truly non-undoable across feature undo/redo (F2)', () => {
  // The reference-typed base map (domain.baseMap is a { source, meta } object; the
  // replace mints a NEW object, so identity distinguishes a replaced map from the
  // captured one). We model it as a tagged object so `===` mirrors the real domain.
  interface RefBaseMap {
    readonly tag: string;
  }
  interface Dom {
    readonly baseMap: RefBaseMap;
    readonly features: number;
  }
  const B0: RefBaseMap = { tag: 'B0' };
  const B1: RefBaseMap = { tag: 'B1' };
  const B2: RefBaseMap = { tag: 'B2' };

  it('UNDO after a replace keeps B1: captured {B0,no-edit} + live {B1,edit} → {B1,no-edit}', () => {
    // The undo command returns its captured pre-edit route {B0, features:0}; the live
    // store domain (after the replace) is {B1, features:1}. The graft must keep the
    // EDIT undo (features:0, from the captured route) but the CURRENT base map (B1).
    const captured: Dom = { baseMap: B0, features: 0 };
    const live: Dom = { baseMap: B1, features: 1 };

    const grafted = graftLiveBaseMap(captured, live);

    expect(grafted.baseMap).toBe(B1); // base map stays B1 — the replace is non-undoable
    expect(grafted.features).toBe(0); // the feature edit IS undone (from the captured route)
  });

  it('REDO after a replace keeps B1: captured {B0,edit} + live {B1,no-edit} → {B1,edit}', () => {
    const captured: Dom = { baseMap: B0, features: 1 };
    const live: Dom = { baseMap: B1, features: 0 };

    const grafted = graftLiveBaseMap(captured, live);

    expect(grafted.baseMap).toBe(B1); // redo re-applies the edit but base map stays B1
    expect(grafted.features).toBe(1);
  });

  it('consecutive replace (B1→B2): every captured route grafts to the LATEST live map', () => {
    // A stale command captured B0; another captured B1; the live map is now B2. Both
    // graft to B2 (常に最新を維持).
    expect(graftLiveBaseMap({ baseMap: B0, features: 0 }, { baseMap: B2, features: 3 }).baseMap).toBe(B2);
    expect(graftLiveBaseMap({ baseMap: B1, features: 1 }, { baseMap: B2, features: 3 }).baseMap).toBe(B2);
  });

  it('NO replace (live base map === captured base map): a genuine no-op — SAME reference', () => {
    // When no replace intervened the captured route already carries the live map
    // (edits preserve baseMap by reference). The graft MUST return the captured object
    // UNCHANGED (identity), so an ordinary undo/redo is byte-for-byte the pre-fix
    // behaviour and no memo/subscription is busted by a value-equal-but-new object.
    const captured: Dom = { baseMap: B0, features: 2 };
    const live: Dom = { baseMap: B0, features: 5 };

    const grafted = graftLiveBaseMap(captured, live);

    expect(grafted).toBe(captured); // identity — no allocation, no change
  });

  it('grafts ONLY the base map — every other field comes from the captured undo/redo route', () => {
    // Proves the graft carries the edit-history target (features) verbatim and swaps
    // exclusively baseMap, so it can never leak the live features into an undo result.
    const captured: Dom = { baseMap: B0, features: 7 };
    const live: Dom = { baseMap: B1, features: 999 };

    const grafted = graftLiveBaseMap(captured, live);

    expect(grafted).toEqual({ baseMap: B1, features: 7 });
    expect(grafted.features).not.toBe(live.features);
  });
});
