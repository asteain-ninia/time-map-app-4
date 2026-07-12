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
import { DEFAULT_BASE_COLORS, DEFAULT_PALETTE, createPalette } from './palette';
import {
  type AdjacencyTransition,
  type FeatureColorPort,
  type PaletteTransition,
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

/** No palette change between before/after (the common structural-commit case). */
const samePalette: PaletteTransition = { previous: DEFAULT_PALETTE, current: DEFAULT_PALETTE };

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
      samePalette,
      port,
    );
    expect(isCompositeCommand(cmd)).toBe(true);
  });

  it('execute applies BOTH structure and the recolor; undo reverts BOTH atomically', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, samePalette, port);

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
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, samePalette, port);
    const exec = cmd.execute(base);
    const undo = cmd.undo(exec.state);
    const redo = cmd.redo(undo.state);
    expect(redo.state.structureTag).toBe('after');
    expect(redo.state.colors.get('A')!.fillColor).toBe(exec.state.colors.get('A')!.fillColor);
    expect(redo.state.colors.get('B')!.fillColor).toBe(exec.state.colors.get('B')!.fillColor);
  });

  it('the composite touched set covers the recolored features (教訓 5.23)', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, samePalette, port);
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
      samePalette,
      port,
    );
    // No adjacency change → returned structural command unwrapped (no composite).
    expect(isCompositeCommand(cmd)).toBe(false);
  });

  it('an unchanged-adjacency command leaves colors untouched on execute', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, unchanged, samePalette, port);
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
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, samePalette, port);
    // Adjacency changed but nothing is colorable → single structural unit.
    expect(isCompositeCommand(cmd)).toBe(false);
  });
});

describe('composeWithRecolor — manual neighbour is a fixed-colour constraint (Codex HIGH #1)', () => {
  it('an auto feature avoids a MANUAL neighbour whose fill IS a palette colour', () => {
    // A=auto (first in id order → would greedily take index 0 = palette[0]); B is
    // MANUAL with fillColor === palette[0]. Without pinning, A and B would share
    // that colour despite being adjacent. With pinning, A skips it.
    const base: TestState = {
      colors: new Map<string, ColorInfo>([
        ['A', createColorInfo(true, '#000000', '#000000', '#000000')], // auto, non-plan start
        ['B', createColorInfo(false, DEFAULT_BASE_COLORS[0]!, DEFAULT_BASE_COLORS[0]!, '#000000')],
      ]),
      autoEnabled: new Map<string, boolean>([
        ['A', true],
        ['B', false], // manual: a fixed-colour pin, not recoloured
      ]),
      structureTag: 'before',
    };
    const cmd = composeWithRecolor(structuralCommand(), base, adjacent, samePalette, port);
    const exec = cmd.execute(base);
    const fillA = exec.state.colors.get('A')!.fillColor;
    expect(fillA).not.toBe(DEFAULT_BASE_COLORS[0]); // did NOT collide with manual B
    expect(fillA).toBe(DEFAULT_BASE_COLORS[1]); // took the next palette colour instead
    expect(exec.state.colors.get('B')!.fillColor).toBe(DEFAULT_BASE_COLORS[0]); // B untouched
  });
});

describe('composeWithRecolor — FR-100 type changes fire despite unchanged adjacency (Codex HIGH #2)', () => {
  const isolatedAB: AdjacencyTransition = {
    previous: buildAdjacencyGraph([A, B], []),
    current: buildAdjacencyGraph([A, B], []),
  };

  /** A structural command that toggles A's auto-color OFF→ON (geometry unchanged). */
  function enableAutoOnA(): Command<TestState> {
    const apply = (s: TestState): CommandOutcome<TestState> => ({
      state: {
        ...s,
        autoEnabled: new Map<string, boolean>([...s.autoEnabled, ['A', true]]),
        structureTag: 'after',
      },
      result: createCommandResult({ survived: [A] }),
    });
    const revert = (s: TestState): CommandOutcome<TestState> => ({
      state: {
        ...s,
        autoEnabled: new Map<string, boolean>([...s.autoEnabled, ['A', false]]),
        structureTag: 'before',
      },
      result: createCommandResult({ survived: [A] }),
    });
    return { kind: STRUCT_KIND, label: 'auto ON', execute: apply, redo: apply, undo: revert };
  }

  it('recolors on auto-color OFF→ON even when adjacency is unchanged (FR-100 即再配色)', () => {
    const base: TestState = {
      colors: new Map<string, ColorInfo>([['A', createColorInfo(false, '#000000', '#000000', '#000000')]]),
      autoEnabled: new Map<string, boolean>([['A', false]]),
      structureTag: 'before',
    };
    const single: AdjacencyTransition = {
      previous: buildAdjacencyGraph([A], []),
      current: buildAdjacencyGraph([A], []),
    };
    const cmd = composeWithRecolor(enableAutoOnA(), base, single, samePalette, port);
    expect(isCompositeCommand(cmd)).toBe(true); // OFF→ON fired a recolor
    const exec = cmd.execute(base);
    expect(exec.state.colors.get('A')!.autoColorEnabled).toBe(true);
    expect(exec.state.colors.get('A')!.fillColor).toBe(DEFAULT_BASE_COLORS[0]); // now auto-coloured
  });

  it('recolors on a palette change while ON even when adjacency is unchanged (FR-109)', () => {
    const base = baselineState(); // A,B auto ON at #000000, isolated
    const otherPalette = createPalette('ocean', ['#111111', '#222222', '#333333']);
    const palettes: PaletteTransition = { previous: DEFAULT_PALETTE, current: otherPalette };
    const cmd = composeWithRecolor(structuralCommand(), base, isolatedAB, palettes, port);
    expect(isCompositeCommand(cmd)).toBe(true); // palette change fired a recolor
    const exec = cmd.execute(base);
    // A,B isolated → both index 0 in the NEW palette → its first colour.
    expect(exec.state.colors.get('A')!.fillColor).toBe('#111111');
    expect(exec.state.colors.get('B')!.fillColor).toBe('#111111');
  });

  it('does NOT recolor a pure time-move (adjacency, targets, palette, pins all equal)', () => {
    const base = baselineState();
    const cmd = composeWithRecolor(structuralCommand(), base, isolatedAB, samePalette, port);
    expect(isCompositeCommand(cmd)).toBe(false); // nothing relevant changed (教訓 5.25)
  });
});
