// U40 dispatch decision — mode × button × hit MATRIX (受け入れ基準 1 / 3 / 5).

import { describe, it, expect } from 'vitest';

import {
  DISPATCH_TARGET,
  DRAG_THRESHOLD_PX,
  POINTER_BUTTON,
  decideDispatch,
  exceedsDragThreshold,
  panStartsFor,
  pointerButtonFromCode,
  screenDistanceSq,
} from './dispatch';
import { EDIT_MODE, type EditMode } from '../state/session';
import {
  EMPTY_HIT,
  featureBodyHit,
  vertexHit,
  type HitResult,
} from '../../domain/selection';
import { asFeatureId, asVertexId } from '../../domain/ids';

const ALL_MODES: EditMode[] = [EDIT_MODE.View, EDIT_MODE.Add, EDIT_MODE.Edit];
const ALL_BUTTONS = [
  POINTER_BUTTON.Left,
  POINTER_BUTTON.Middle,
  POINTER_BUTTON.Right,
  POINTER_BUTTON.Other,
] as const;

const f = asFeatureId('f1');
const ALL_HITS: HitResult[] = [
  EMPTY_HIT,
  featureBodyHit(f),
  vertexHit(f, asVertexId('v1')),
];

describe('pointerButtonFromCode', () => {
  it('maps 0/1/2 to left/middle/right and others to Other (教訓 5.19)', () => {
    expect(pointerButtonFromCode(0)).toBe(POINTER_BUTTON.Left);
    expect(pointerButtonFromCode(1)).toBe(POINTER_BUTTON.Middle);
    expect(pointerButtonFromCode(2)).toBe(POINTER_BUTTON.Right);
    expect(pointerButtonFromCode(3)).toBe(POINTER_BUTTON.Other);
    expect(pointerButtonFromCode(-1)).toBe(POINTER_BUTTON.Other);
  });
});

describe('panStartsFor — single pan-button table (受け入れ基準 1)', () => {
  it('View pans on left OR middle', () => {
    expect(panStartsFor(EDIT_MODE.View, POINTER_BUTTON.Left)).toBe(true);
    expect(panStartsFor(EDIT_MODE.View, POINTER_BUTTON.Middle)).toBe(true);
  });
  it('Add/Edit pan ONLY on middle (not left)', () => {
    for (const m of [EDIT_MODE.Add, EDIT_MODE.Edit] as const) {
      expect(panStartsFor(m, POINTER_BUTTON.Middle)).toBe(true);
      expect(panStartsFor(m, POINTER_BUTTON.Left)).toBe(false);
    }
  });
  it('right/other never pan in any mode', () => {
    for (const m of ALL_MODES) {
      expect(panStartsFor(m, POINTER_BUTTON.Right)).toBe(false);
      expect(panStartsFor(m, POINTER_BUTTON.Other)).toBe(false);
    }
  });
});

describe('decideDispatch — full matrix (受け入れ基準 3)', () => {
  // Exhaustively assert EVERY mode × button × hit combination resolves to ONE
  // expected destination (条件は組み合わせで網羅, 教訓 5.9).
  const expected = (mode: EditMode, button: (typeof ALL_BUTTONS)[number]) => {
    if (button === POINTER_BUTTON.Right) return DISPATCH_TARGET.ContextMenu;
    if (panStartsFor(mode, button)) return DISPATCH_TARGET.Pan;
    if (button === POINTER_BUTTON.Left && mode === EDIT_MODE.Add) {
      return DISPATCH_TARGET.Add;
    }
    if (button === POINTER_BUTTON.Left && mode === EDIT_MODE.Edit) {
      return DISPATCH_TARGET.SelectEdit;
    }
    return DISPATCH_TARGET.Ignore;
  };

  for (const mode of ALL_MODES) {
    for (const button of ALL_BUTTONS) {
      for (const hit of ALL_HITS) {
        it(`${mode} × ${button} × ${hit.kind} → ${expected(mode, button)}`, () => {
          expect(decideDispatch({ mode, button, hit })).toBe(expected(mode, button));
        });
      }
    }
  }
});

describe('decideDispatch — key non-collision cases (受け入れ基準 5)', () => {
  it('View left drag → Pan (selection not started)', () => {
    expect(
      decideDispatch({ mode: EDIT_MODE.View, button: POINTER_BUTTON.Left, hit: EMPTY_HIT }),
    ).toBe(DISPATCH_TARGET.Pan);
  });
  it('Edit left → SelectEdit (never Pan)', () => {
    expect(
      decideDispatch({
        mode: EDIT_MODE.Edit,
        button: POINTER_BUTTON.Left,
        hit: vertexHit(f, asVertexId('v1')),
      }),
    ).toBe(DISPATCH_TARGET.SelectEdit);
  });
  it('Add left → Add (never Pan)', () => {
    expect(
      decideDispatch({ mode: EDIT_MODE.Add, button: POINTER_BUTTON.Left, hit: EMPTY_HIT }),
    ).toBe(DISPATCH_TARGET.Add);
  });
  it('middle → Pan in EVERY mode (全モード共通)', () => {
    for (const mode of ALL_MODES) {
      expect(
        decideDispatch({ mode, button: POINTER_BUTTON.Middle, hit: EMPTY_HIT }),
      ).toBe(DISPATCH_TARGET.Pan);
    }
  });
  it('right → ContextMenu in EVERY mode', () => {
    for (const mode of ALL_MODES) {
      expect(
        decideDispatch({ mode, button: POINTER_BUTTON.Right, hit: EMPTY_HIT }),
      ).toBe(DISPATCH_TARGET.ContextMenu);
    }
  });
});

describe('drag threshold — shared click/drag judgement (受け入れ基準 4)', () => {
  it('screenDistanceSq is the squared euclidean distance', () => {
    expect(screenDistanceSq(0, 0, 3, 4)).toBe(25);
  });
  it('below threshold → click (no drag)', () => {
    expect(exceedsDragThreshold(10, 10, 11, 11)).toBe(false); // ~1.41px
  });
  it('at/above threshold → drag', () => {
    expect(exceedsDragThreshold(0, 0, DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(exceedsDragThreshold(0, 0, 100, 100)).toBe(true);
  });
  it('non-finite samples never promote a click to a drag', () => {
    expect(exceedsDragThreshold(0, 0, Number.NaN, 0)).toBe(false);
    expect(exceedsDragThreshold(0, 0, Infinity, 0)).toBe(false);
  });
  it('custom threshold is honored', () => {
    expect(exceedsDragThreshold(0, 0, 5, 0, 10)).toBe(false);
    expect(exceedsDragThreshold(0, 0, 10, 0, 10)).toBe(true);
  });
});
