import { describe, expect, it } from 'vitest';
import { produce } from 'immer';

import { asFeatureId, type DomainId, type FeatureId } from '../ids';
import {
  createCommandResult,
  EMPTY_COMMAND_RESULT,
  mergeCommandResults,
} from './result';
import {
  type Command,
  type CommandOutcome,
  COMPOSITE_COMMAND_KIND,
  createCompositeCommand,
  defineCommandKind,
  isCompositeCommand,
} from './command';

// --- A minimal test domain state -------------------------------------------
// U12 is generic over the opaque root state `S`. For tests we use a tiny
// immutable state and build commands that update it via Immer's `produce`
// (structural sharing, 技術方針 2.6). This stands in for U03's real root.

interface TestState {
  readonly features: Readonly<Record<string, { readonly name: string }>>;
}

function emptyState(): TestState {
  return { features: {} };
}

const ADD_FEATURE = defineCommandKind('test/add-feature');
const RENAME_FEATURE = defineCommandKind('test/rename-feature');
const DELETE_FEATURE = defineCommandKind('test/delete-feature');

/**
 * A command that creates a feature with a *pre-generated* ID captured at
 * construction. Because the ID is data (not minted inside execute), redo
 * restores the same first-generation ID (教訓 5.20).
 */
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
  return {
    kind: ADD_FEATURE,
    label: `Add ${name}`,
    execute: apply,
    undo: revert,
    redo: apply,
  };
}

function renameFeatureCommand(
  id: FeatureId,
  from: string,
  to: string,
): Command<TestState> {
  const setName = (name: string) => (state: TestState): CommandOutcome<TestState> => ({
    state: produce(state, (draft) => {
      const f = draft.features[id];
      if (f !== undefined) f.name = name;
    }),
    result: createCommandResult({ survived: [id] }),
  });
  return {
    kind: RENAME_FEATURE,
    label: `Rename to ${to}`,
    execute: setName(to),
    undo: setName(from),
    redo: setName(to),
  };
}

function deleteFeatureCommand(id: FeatureId, name: string): Command<TestState> {
  return {
    kind: DELETE_FEATURE,
    label: `Delete ${name}`,
    execute: (state) => ({
      state: produce(state, (draft) => {
        delete draft.features[id];
      }),
      result: createCommandResult({ deleted: [id] }),
    }),
    undo: (state) => ({
      state: produce(state, (draft) => {
        draft.features[id] = { name };
      }),
      result: createCommandResult({ created: [id] }),
    }),
    redo: (state) => ({
      state: produce(state, (draft) => {
        delete draft.features[id];
      }),
      result: createCommandResult({ deleted: [id] }),
    }),
  };
}

describe('command purity and determinism (受け入れ基準 1)', () => {
  it('does not mutate the input state (structural sharing, new state returned)', () => {
    const id = asFeatureId('f1');
    const before = emptyState();
    const cmd = addFeatureCommand(id, 'Alpha');
    const after = cmd.execute(before).state;

    expect(after).not.toBe(before); // new reference
    expect(before.features).toEqual({}); // input untouched
    expect(after.features[id]).toEqual({ name: 'Alpha' });
  });

  it('is deterministic: same input -> same new state and same result', () => {
    const id = asFeatureId('f1');
    const base = addFeatureCommand(id, 'Alpha').execute(emptyState()).state;
    const cmd = renameFeatureCommand(id, 'Alpha', 'Beta');

    const a = cmd.execute(base);
    const b = cmd.execute(base);
    expect(a.state).toEqual(b.state);
    expect([...a.result.survived]).toEqual([...b.result.survived]);
    expect([...a.result.touched]).toEqual([...b.result.touched]);
  });

  it('input state -> command -> expected state (Vitest direct comparison)', () => {
    const id = asFeatureId('f1');
    const out = addFeatureCommand(id, 'Alpha').execute(emptyState());
    expect(out.state).toEqual({ features: { f1: { name: 'Alpha' } } });
  });
});

describe('command result reports survived/created/deleted (受け入れ基準 4)', () => {
  it('create reports created; rename reports survived; delete reports deleted', () => {
    const id = asFeatureId('f1');
    const created = addFeatureCommand(id, 'Alpha').execute(emptyState());
    expect([...created.result.created]).toEqual([id]);
    expect(created.result.survived.size).toBe(0);
    expect(created.result.deleted.size).toBe(0);

    const renamed = renameFeatureCommand(id, 'Alpha', 'Beta').execute(
      created.state,
    );
    expect([...renamed.result.survived]).toEqual([id]);

    const deleted = deleteFeatureCommand(id, 'Beta').execute(renamed.state);
    expect([...deleted.result.deleted]).toEqual([id]);
  });

  it('touched defaults to the union of created/survived/deleted', () => {
    const id = asFeatureId('f1');
    const r = createCommandResult({ created: [id] });
    expect([...r.touched]).toEqual([id]);
  });

  it('EMPTY_COMMAND_RESULT has all-empty sets', () => {
    expect(EMPTY_COMMAND_RESULT.created.size).toBe(0);
    expect(EMPTY_COMMAND_RESULT.survived.size).toBe(0);
    expect(EMPTY_COMMAND_RESULT.deleted.size).toBe(0);
    expect(EMPTY_COMMAND_RESULT.touched.size).toBe(0);
  });

  it('lets the UI re-resolve selection from the result (教訓 5.11, no blanket clear)', () => {
    // Simulate a selection of {a, b}; an op deletes a and creates c.
    const a = asFeatureId('a');
    const b = asFeatureId('b');
    const c = asFeatureId('c');
    const selection = new Set<DomainId>([a, b]);
    const result = createCommandResult({
      survived: [b],
      created: [c],
      deleted: [a],
    });

    // Re-resolution rule: keep survivors that were selected, drop deleted,
    // add nothing automatically (UI decides) — here we keep selected survivors.
    const next = new Set<DomainId>();
    for (const id of selection) {
      if (!result.deleted.has(id) && result.survived.has(id)) next.add(id);
    }
    expect([...next]).toEqual([b]); // a dropped (deleted), b kept (survived)
    expect(result.created.has(c)).toBe(true);
  });
});

describe('mergeCommandResults aggregation (受け入れ基準 4 集約規則)', () => {
  it('drops a transient ID created then deleted within the composite', () => {
    const tmp = asFeatureId('tmp');
    const kept = asFeatureId('kept');
    const merged = mergeCommandResults([
      createCommandResult({ created: [tmp, kept] }),
      createCommandResult({ deleted: [tmp], survived: [kept] }),
    ]);
    expect(merged.created.has(tmp)).toBe(false); // transient: not created
    expect(merged.deleted.has(tmp)).toBe(false); // transient: not deleted
    expect(merged.survived.has(tmp)).toBe(false); // transient: not survived
    expect(merged.created.has(kept)).toBe(true); // created within, survives
    // touched still records everything the composite notified on.
    expect(merged.touched.has(tmp)).toBe(true);
    expect(merged.touched.has(kept)).toBe(true);
  });

  it('keeps created/survived/deleted pairwise disjoint', () => {
    const a = asFeatureId('a');
    const b = asFeatureId('b');
    const d = asFeatureId('d');
    const merged = mergeCommandResults([
      createCommandResult({ created: [a], survived: [b], deleted: [d] }),
    ]);
    const inter = (x: ReadonlySet<DomainId>, y: ReadonlySet<DomainId>) =>
      [...x].some((v) => y.has(v));
    expect(inter(merged.created, merged.survived)).toBe(false);
    expect(inter(merged.created, merged.deleted)).toBe(false);
    expect(inter(merged.survived, merged.deleted)).toBe(false);
  });

  it('a pre-existing deleted then re-created ID is net created', () => {
    const x = asFeatureId('x');
    const merged = mergeCommandResults([
      createCommandResult({ deleted: [x] }),
      createCommandResult({ created: [x] }),
    ]);
    expect(merged.created.has(x)).toBe(true);
    expect(merged.deleted.has(x)).toBe(false);
  });
});

describe('composite command is one indivisible undo unit (受け入れ基準 3, FR-94)', () => {
  const f1 = asFeatureId('f1');
  const f2 = asFeatureId('f2');

  function buildComposite(): Command<TestState> {
    return createCompositeCommand('Add two', [
      addFeatureCommand(f1, 'One'),
      addFeatureCommand(f2, 'Two'),
    ]);
  }

  it('has the composite kind and is detected as composite', () => {
    const c = buildComposite();
    expect(c.kind).toBe(COMPOSITE_COMMAND_KIND);
    expect(isCompositeCommand(c)).toBe(true);
  });

  it('one execute applies all sub-commands; one undo reverts all; one redo re-applies all', () => {
    const c = buildComposite();
    const start = emptyState();

    const afterExec = c.execute(start);
    expect(afterExec.state.features).toEqual({
      f1: { name: 'One' },
      f2: { name: 'Two' },
    });

    const afterUndo = c.undo(afterExec.state);
    expect(afterUndo.state).toEqual(start); // fully reverted, not partial

    const afterRedo = c.redo(afterUndo.state);
    expect(afterRedo.state.features).toEqual({
      f1: { name: 'One' },
      f2: { name: 'Two' },
    });
  });

  it('aggregated result reports both created IDs', () => {
    const c = buildComposite();
    const out = c.execute(emptyState());
    expect(new Set(out.result.created)).toEqual(new Set([f1, f2]));
  });
});

describe('redo restores first-generation IDs (受け入れ基準 5, 教訓 5.20)', () => {
  it('execute -> undo -> redo keeps the same ID, not a re-minted one', () => {
    const id = asFeatureId('f-original');
    const cmd = addFeatureCommand(id, 'Alpha');

    const e = cmd.execute(emptyState());
    const u = cmd.undo(e.state);
    const r = cmd.redo(u.state);

    expect(Object.keys(r.state.features)).toEqual(['f-original']);
    expect([...r.result.created]).toEqual([id]);
  });
});

describe('execute/undo/redo symmetric notification (受け入れ基準 5, 教訓 5.23)', () => {
  it('touched sets match exactly across execute/undo/redo (strict equality)', () => {
    const f1 = asFeatureId('f1');
    const f2 = asFeatureId('f2');
    const c = createCompositeCommand('Add two', [
      addFeatureCommand(f1, 'One'),
      addFeatureCommand(f2, 'Two'),
    ]);
    const expected = new Set([f1, f2]);

    const e = c.execute(emptyState());
    const u = c.undo(e.state);
    const r = c.redo(u.state);

    // Strict-equality of the touched set (not containment) — 教訓 5.23 検出.
    expect(new Set(e.result.touched)).toEqual(expected);
    expect(new Set(u.result.touched)).toEqual(expected);
    expect(new Set(r.result.touched)).toEqual(expected);
  });
});
