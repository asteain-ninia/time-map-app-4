// U33 recolor-command adapter tests (FR-94 / U33 受け入れ基準1・6 / 教訓 5.6 / 5.20
// / 5.23): a structural change and its auto-recolor are ONE undo unit, the recolor
// fires by RESULT STATE (adjacency change) not call path, and undo reverts color
// AND structure atomically — 配色だけが別アンドゥ単位にならない.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type CommandOutcome,
  defineCommandKind,
  isCompositeCommand,
} from '../command/command';
import { createCommandResult } from '../command/result';
import {
  type ColorInfo,
  createColorInfo,
} from '../attributes';
import { asFeatureId, type FeatureId } from '../ids';

import { buildAdjacencyGraph } from './adjacency';
import { DEFAULT_PALETTE } from './palette';
import {
  type AdjacencyTransition,
  type FeatureColorPort,
  composeWithRecolor,
} from './recolor-command';

// --- a tiny concrete state to exercise the real composite/command machinery ---

interface TestState {
  // feature id (string) -> its color info + a structural marker.
  readonly colors: ReadonlyMap<string, ColorInfo>;
  readonly autoEnabled: ReadonlyMap<string, boolean>;
  /** A structural marker so we can prove the structural step also reverts. */
  readonly structureTag: string;
}

const port: FeatureColorPort<TestState> = {
  colorOf: (s, id) => s.colors.get(id as unknown as string) ?? null,
  withColor: (s, id, color) => {
    const colors = new Map(s.colors);
    colors.set(id as unknown as string, color);
    return { ...s, colors };
  },
  autoColorEnabledById: (s) => {
    const m = new Map<FeatureId, boolean>();
    for (const [k, v] of s.autoEnabled) m.set(asFeatureId(k), v);
    return m;
  },
};

const A = asFeatureId('A');
const B = asFeatureId('B');

function manualColor(): ColorInfo {
  // auto-color ON but a clearly non-plan starting color, so a recolor changes it.
  return createColorInfo(true, '#000000', '#000000', '#000000');
}

function baselineState(): TestState {
  return {
    colors: new Map<string, ColorInfo>([
      ['A', manualColor()],
      ['B', manualColor()],
    ]),
    autoEnabled: new Map<string, boolean>([
      ['A', true],
      ['B', true],
    ]),
    structureTag: 'before',
  };
}

const STRUCT_KIND = defineCommandKind('test-structural');

/** A fake structural command that just flips the structure marker. */
function structuralCommand(): Command<TestState> {
  const apply = (s: TestState): CommandOutcome<TestState> => ({
    state: { ...s, structureTag: 'after' },
    result: createCommandResult({ survived: [A, B] }),
  });
  const revert = (s: TestState): CommandOutcome<TestState> => ({
    state: { ...s, structureTag: 'before' },
    result: createCommandResult({ survived: [A, B] }),
  });
  return { kind: STRUCT_KIND, label: '構造変更', execute: apply, redo: apply, undo: revert };
}

// A become-adjacent transition: before A,B isolated; after they share a boundary.
const adjacent: AdjacencyTransition = {
  previous: buildAdjacencyGraph([A, B], []),
  current: buildAdjacencyGraph([A, B], [{ a: A, b: B }]),
};

// An unchanged transition: same isolated graph before and after.
const unchanged: AdjacencyTransition = {
  previous: buildAdjacencyGraph([A, B], []),
  current: buildAdjacencyGraph([A, B], []),
};

describe('composeWithRecolor — single undo unit (FR-94 / AC6)', () => {
  it('wraps structure + recolor into one composite when adjacency changed', () => {
    const cmd = composeWithRecolor(
      structuralCommand(),
      baselineState(),
      adjacent,
      DEFAULT_PALETTE,
      port,
    );
    expect(isCompositeCommand(cmd)).toBe(true);
  });

  it('execute applies BOTH structure and the recolor; undo reverts BOTH atomically', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, DEFAULT_PALETTE, port);

    const afterExec = cmd.execute(base);
    // structure applied
    expect(afterExec.state.structureTag).toBe('after');
    // recolor applied: adjacent A,B must NOT share a fill color (four-color回避).
    const fillA = afterExec.state.colors.get('A')!.fillColor;
    const fillB = afterExec.state.colors.get('B')!.fillColor;
    expect(fillA).not.toBe(fillB);
    // and they changed from the manual starting color
    expect(fillA).not.toBe('#000000');

    // undo reverts color AND structure in the SAME unit (配色だけが別単位でない).
    const afterUndo = cmd.undo(afterExec.state);
    expect(afterUndo.state.structureTag).toBe('before');
    expect(afterUndo.state.colors.get('A')!.fillColor).toBe('#000000');
    expect(afterUndo.state.colors.get('B')!.fillColor).toBe('#000000');
  });

  it('redo re-applies the SAME colors (deterministic replay, 教訓 5.20)', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, DEFAULT_PALETTE, port);
    const exec = cmd.execute(base);
    const undo = cmd.undo(exec.state);
    const redo = cmd.redo(undo.state);
    expect(redo.state.structureTag).toBe('after');
    expect(redo.state.colors.get('A')!.fillColor).toBe(exec.state.colors.get('A')!.fillColor);
    expect(redo.state.colors.get('B')!.fillColor).toBe(exec.state.colors.get('B')!.fillColor);
  });

  it('the composite touched set covers the recolored features (教訓 5.23)', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, DEFAULT_PALETTE, port);
    const exec = cmd.execute(base);
    expect(exec.result.touched.has(A)).toBe(true);
    expect(exec.result.touched.has(B)).toBe(true);
  });
});

describe('composeWithRecolor — result-state trigger (教訓 5.6 / 5.25)', () => {
  it('does NOT add a recolor unit when adjacency is unchanged', () => {
    const cmd = composeWithRecolor(
      structuralCommand(),
      baselineState(),
      unchanged,
      DEFAULT_PALETTE,
      port,
    );
    // No adjacency change → returned structural command unwrapped (no composite).
    expect(isCompositeCommand(cmd)).toBe(false);
  });

  it('an unchanged-adjacency command leaves colors untouched on execute', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, unchanged, DEFAULT_PALETTE, port);
    const exec = cmd.execute(base);
    expect(exec.state.colors.get('A')!.fillColor).toBe('#000000');
    expect(exec.state.colors.get('B')!.fillColor).toBe('#000000');
  });

  it('does not recolor when no feature is an auto-color target', () => {
    const base: TestState = {
      ...baselineState(),
      autoEnabled: new Map<string, boolean>([
        ['A', false],
        ['B', false],
      ]),
    };
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, DEFAULT_PALETTE, port);
    // Adjacency changed but nothing is colorable → single structural unit.
    expect(isCompositeCommand(cmd)).toBe(false);
  });
});
