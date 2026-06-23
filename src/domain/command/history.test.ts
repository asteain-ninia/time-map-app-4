import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { produce } from 'immer';

import { asFeatureId, type FeatureId } from '../ids';
import { createCommandResult } from './result';
import {
  type Command,
  type CommandOutcome,
  createCompositeCommand,
  defineCommandKind,
} from './command';
import {
  canRedo,
  canUndo,
  clearRedo,
  createHistory,
  DEFAULT_HISTORY_LIMIT,
  execute,
  executeIfChanged,
  redo,
  undo,
  withLimit,
} from './history';

// Reuse the tiny test state from the command contract tests.
interface TestState {
  readonly features: Readonly<Record<string, { readonly name: string }>>;
}
function emptyState(): TestState {
  return { features: {} };
}

const ADD = defineCommandKind('test/add');

function addFeatureCommand(id: FeatureId, name: string): Command<TestState> {
  const apply = (state: TestState): CommandOutcome<TestState> => ({
    state: produce(state, (draft) => {
      draft.features[id] = { name };
    }),
    result: createCommandResult({ created: [id] }),
  });
  const revert = (state: TestState): CommandOutcome<TestState> => ({
    state: produce(state, (draft) => {
      delete draft.features[id];
    }),
    result: createCommandResult({ deleted: [id] }),
  });
  return { kind: ADD, label: name, execute: apply, undo: revert, redo: apply };
}

describe('dual-stack predicates (受け入れ基準 2, FR-74)', () => {
  it('fresh history cannot undo or redo', () => {
    const h = createHistory(emptyState());
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('after execute can undo but not redo; after undo can redo', () => {
    let h = createHistory(emptyState());
    h = execute(h, addFeatureCommand(asFeatureId('f1'), 'A')).history;
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);

    h = undo(h).history;
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);
  });
});

describe('history purity (受け入れ基準 1)', () => {
  it('execute returns a new history value and does not mutate the old one', () => {
    const h0 = createHistory(emptyState());
    const step = execute(h0, addFeatureCommand(asFeatureId('f1'), 'A'));
    expect(step.history).not.toBe(h0);
    expect(h0.undoStack.length).toBe(0); // old value untouched
    expect(step.history.undoStack.length).toBe(1);
  });
});

describe('limit / oldest-eviction / redo clearing (受け入れ基準 2, FR-74)', () => {
  it('default limit is 100', () => {
    const h = createHistory(emptyState());
    expect(h.limit).toBe(DEFAULT_HISTORY_LIMIT);
  });

  it('undo stack never exceeds the limit; oldest entries are evicted', () => {
    let h = createHistory(emptyState(), 3);
    for (let i = 0; i < 10; i += 1) {
      h = execute(h, addFeatureCommand(asFeatureId(`f${i}`), `n${i}`)).history;
    }
    expect(h.undoStack.length).toBe(3);
    // The three retained must be the newest (f7, f8, f9).
    expect(h.undoStack.map((c) => c.label)).toEqual(['n7', 'n8', 'n9']);
  });

  it('withLimit changes the limit and trims immediately', () => {
    let h = createHistory(emptyState(), 100);
    for (let i = 0; i < 5; i += 1) {
      h = execute(h, addFeatureCommand(asFeatureId(`f${i}`), `n${i}`)).history;
    }
    h = withLimit(h, 2);
    expect(h.limit).toBe(2);
    expect(h.undoStack.map((c) => c.label)).toEqual(['n3', 'n4']);
  });

  // FR-74 wiring lock (bughunt): the App composition root drives the configurable
  // undoStackSize setting into the live history via withLimit. This pins the exact
  // task scenario — re-bound to 2, push 3 commands, only 2 remain undoable — so the
  // setting→withLimit seam can never silently revert to the fixed 100 limit again.
  it('after re-bounding the limit to 2, only the newest 2 of 3 pushed commands are undoable', () => {
    // Start at the default limit (the historyRef seed in App.tsx).
    let h = createHistory(emptyState());
    // The undoStackSize setting changes to 2 → the root applies withLimit(h, 2).
    h = withLimit(h, 2);
    for (let i = 0; i < 3; i += 1) {
      h = execute(h, addFeatureCommand(asFeatureId(`f${i}`), `n${i}`)).history;
    }
    // Only 2 undo units survive (the oldest was evicted at push time, FR-74).
    expect(h.undoStack.length).toBe(2);
    expect(h.undoStack.map((c) => c.label)).toEqual(['n1', 'n2']);
    // Exactly 2 successive undos are possible; the third is a no-op (empty stack).
    h = undo(h).history;
    h = undo(h).history;
    expect(canUndo(h)).toBe(false);
    expect(undo(h).history).toBe(h);
  });

  it('limit < 1 is clamped to 1', () => {
    expect(createHistory(emptyState(), 0).limit).toBe(1);
    expect(withLimit(createHistory(emptyState()), -5).limit).toBe(1);
  });

  it('a new execute after undo clears the entire redo stack (FR-74)', () => {
    let h = createHistory(emptyState());
    h = execute(h, addFeatureCommand(asFeatureId('f1'), 'A')).history;
    h = execute(h, addFeatureCommand(asFeatureId('f2'), 'B')).history;
    h = undo(h).history; // f2 -> redo stack
    expect(canRedo(h)).toBe(true);

    h = execute(h, addFeatureCommand(asFeatureId('f3'), 'C')).history;
    expect(canRedo(h)).toBe(false); // redo stack dropped
    expect(h.redoStack.length).toBe(0);
  });

  it('undo/redo on empty stacks are no-ops returning the same value', () => {
    const h = createHistory(emptyState());
    expect(undo(h).history).toBe(h);
    expect(undo(h).result.touched.size).toBe(0);
    expect(redo(h).history).toBe(h);
  });

  it('clearRedo drops redo without touching undo or state', () => {
    let h = createHistory(emptyState());
    h = execute(h, addFeatureCommand(asFeatureId('f1'), 'A')).history;
    h = undo(h).history;
    const cleared = clearRedo(h);
    expect(cleared.redoStack.length).toBe(0);
    expect(cleared.undoStack.length).toBe(h.undoStack.length);
    expect(cleared.state).toBe(h.state);
  });
});

describe('composite is a single undo unit through history (受け入れ基準 3, FR-73/94)', () => {
  it('one undo reverts the whole composite; one redo re-applies it', () => {
    const f1 = asFeatureId('f1');
    const f2 = asFeatureId('f2');
    const composite = createCompositeCommand('Add two', [
      addFeatureCommand(f1, 'One'),
      addFeatureCommand(f2, 'Two'),
    ]);
    let h = createHistory(emptyState());
    const start = h.state;

    h = execute(h, composite).history;
    expect(h.undoStack.length).toBe(1); // single entry
    expect(h.state.features).toEqual({ f1: { name: 'One' }, f2: { name: 'Two' } });

    h = undo(h).history;
    expect(h.state).toEqual(start); // fully reverted in one undo

    h = redo(h).history;
    expect(h.state.features).toEqual({ f1: { name: 'One' }, f2: { name: 'Two' } });
  });
});

describe('no-op guard (教訓 5.24)', () => {
  it('executeIfChanged skips the command and pushes nothing when baseline matches', () => {
    let h = createHistory(emptyState());
    h = execute(h, addFeatureCommand(asFeatureId('f1'), 'A')).history;
    const before = h;

    // baseline check derived from the same state source (here: name unchanged).
    const step = executeIfChanged(
      h,
      addFeatureCommand(asFeatureId('f1'), 'A'),
      (s) => s.features['f1']?.name === 'A',
    );
    expect(step.history).toBe(before); // no ghost entry pushed
    expect(step.result.touched.size).toBe(0);
    expect(step.history.undoStack.length).toBe(1);
  });

  it('executeIfChanged executes when the value actually changes', () => {
    let h = createHistory(emptyState());
    const step = executeIfChanged(
      h,
      addFeatureCommand(asFeatureId('f1'), 'A'),
      (s) => s.features['f1']?.name === 'A',
    );
    expect(step.history.undoStack.length).toBe(1);
    h = step.history;
    expect(h.state.features['f1']).toEqual({ name: 'A' });
  });
});

describe('property: dual-stack invariants under random op sequences (FR-74)', () => {
  type Op = { t: 'exec'; n: number } | { t: 'undo' } | { t: 'redo' };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.integer({ min: 0, max: 1000 }).map((n) => ({ t: 'exec', n }) as Op),
    fc.constant({ t: 'undo' } as Op),
    fc.constant({ t: 'redo' } as Op),
  );

  it('undo stack length never exceeds the limit; predicates match stack emptiness', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(opArb, { maxLength: 60 }),
        (limit, ops) => {
          let h = createHistory(emptyState(), limit);
          let seq = 0;
          for (const op of ops) {
            if (op.t === 'exec') {
              seq += 1;
              h = execute(
                h,
                addFeatureCommand(asFeatureId(`f${seq}`), `n${seq}`),
              ).history;
            } else if (op.t === 'undo') {
              h = undo(h).history;
            } else {
              h = redo(h).history;
            }
            // Invariants after every step:
            expect(h.undoStack.length).toBeLessThanOrEqual(limit);
            expect(canUndo(h)).toBe(h.undoStack.length > 0);
            expect(canRedo(h)).toBe(h.redoStack.length > 0);
          }
          return true;
        },
      ),
    );
  });

  it('property: execute always clears the redo stack', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        let h = createHistory(emptyState(), 100);
        let seq = 0;
        for (const op of ops) {
          if (op.t === 'exec') {
            seq += 1;
            h = execute(
              h,
              addFeatureCommand(asFeatureId(`f${seq}`), `n${seq}`),
            ).history;
            // Immediately after an execute, redo must be empty.
            expect(h.redoStack.length).toBe(0);
          } else if (op.t === 'undo') {
            h = undo(h).history;
          } else {
            h = redo(h).history;
          }
        }
        return true;
      }),
    );
  });

  it('property: execute then undo restores the exact prior state (round-trip)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 4 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (names) => {
          let h = createHistory(emptyState(), 100);
          const snapshots: TestState[] = [h.state];
          names.forEach((name, i) => {
            h = execute(
              h,
              addFeatureCommand(asFeatureId(`f${i}`), name),
            ).history;
            snapshots.push(h.state);
          });
          // Undo all the way back; each step must match the recorded snapshot.
          for (let i = names.length; i > 0; i -= 1) {
            h = undo(h).history;
            expect(h.state).toEqual(snapshots[i - 1]);
          }
          return true;
        },
      ),
    );
  });
});
