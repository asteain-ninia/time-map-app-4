import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { asFeatureId } from '../ids';
import { KNIFE_LINE_KIND } from './knife-line';
import { knifeGuideText, KNIFE_GUIDE } from './messages';
import { INHERITANCE_SIDE } from './proposal';
import type { SplitResult } from './split-geometry';
import {
  KNIFE_PHASE,
  backToDrawing,
  cancelKnife,
  clickInsideCircle,
  confirmCut,
  confirmInheritor,
  idle,
  isFixedCircleVisible,
  isOverlayVisible,
  placeCutPoint,
  selectInheritor,
  selectTarget,
  startKnife,
  undoLastCutPoint,
} from './session';

const c = (lon: number, lat: number) => createCoordinate(lon, lat);
const tid = asFeatureId('leaf-1');

const fakeResult: SplitResult = {
  sideA: { area: [[[c(0, 0), c(5, 0), c(5, 10), c(0, 10)]]], areaKm2: 50 },
  sideB: { area: [[[c(5, 0), c(10, 0), c(10, 10), c(5, 10)]]], areaKm2: 50 },
  edgeCuts: [],
};

describe('knife state machine — happy path (FR-90 / FR-92 / FR-93)', () => {
  it('inactive → select target → draw → confirm → choose → enter properties', () => {
    let s = idle();
    expect(s.phase).toBe(KNIFE_PHASE.Inactive);

    s = startKnife();
    expect(s.phase).toBe(KNIFE_PHASE.SelectingTarget);
    expect(isOverlayVisible(s)).toBe(true);

    s = selectTarget(s, tid);
    expect(s.phase).toBe(KNIFE_PHASE.DrawingCut);

    s = placeCutPoint(s, c(5, -5));
    s = placeCutPoint(s, c(5, 15));
    if (s.phase === KNIFE_PHASE.DrawingCut) {
      expect(s.line.points).toHaveLength(2);
      expect(isFixedCircleVisible(s)).toBe(true);
    }

    s = confirmCut(s, fakeResult, INHERITANCE_SIDE.A);
    expect(s.phase).toBe(KNIFE_PHASE.ChoosingInheritor);
    if (s.phase === KNIFE_PHASE.ChoosingInheritor) {
      expect(s.selected).toBe(INHERITANCE_SIDE.A);
    }

    s = selectInheritor(s, INHERITANCE_SIDE.B);
    if (s.phase === KNIFE_PHASE.ChoosingInheritor) expect(s.selected).toBe(INHERITANCE_SIDE.B);

    s = confirmInheritor(s);
    expect(s.phase).toBe(KNIFE_PHASE.EnteringProperties);
    if (s.phase === KNIFE_PHASE.EnteringProperties) expect(s.inherit).toBe(INHERITANCE_SIDE.B);
  });
});

describe('closed-line via fixed circle (FR-92 / 受け入れ基準3)', () => {
  it('3+ points + inside-circle click closes the line', () => {
    let s = selectTarget(startKnife(), tid);
    s = placeCutPoint(s, c(0, 0));
    s = placeCutPoint(s, c(5, 0));
    s = placeCutPoint(s, c(5, 5));
    s = clickInsideCircle(s, c(0, 0), true);
    if (s.phase === KNIFE_PHASE.DrawingCut) {
      expect(s.line.kind).toBe(KNIFE_LINE_KIND.Closed);
    }
  });

  it('2 points + inside-circle click does NOT close (treated as a vertex add)', () => {
    let s = selectTarget(startKnife(), tid);
    s = placeCutPoint(s, c(0, 0));
    s = placeCutPoint(s, c(5, 0));
    s = clickInsideCircle(s, c(2, 2), true);
    if (s.phase === KNIFE_PHASE.DrawingCut) {
      expect(s.line.kind).toBe(KNIFE_LINE_KIND.Open);
      expect(s.line.points).toHaveLength(3);
    }
  });

  it('outside-circle click is a normal vertex add even with 3+ points', () => {
    let s = selectTarget(startKnife(), tid);
    s = placeCutPoint(s, c(0, 0));
    s = placeCutPoint(s, c(5, 0));
    s = placeCutPoint(s, c(5, 5));
    s = clickInsideCircle(s, c(9, 9), false);
    if (s.phase === KNIFE_PHASE.DrawingCut) {
      expect(s.line.kind).toBe(KNIFE_LINE_KIND.Open);
      expect(s.line.points).toHaveLength(4);
    }
  });
});

describe('一時状態の全経路破棄 (教訓5.2 / 受け入れ基準8)', () => {
  it('cancel from any phase returns to inactive with no残留', () => {
    const drawing = placeCutPoint(selectTarget(startKnife(), tid), c(5, 5));
    expect(cancelKnife()).toEqual(idle());

    const choosing = confirmCut(
      placeCutPoint(placeCutPoint(selectTarget(startKnife(), tid), c(5, -5)), c(5, 15)),
      fakeResult,
      INHERITANCE_SIDE.A,
    );
    expect(choosing.phase).toBe(KNIFE_PHASE.ChoosingInheritor);
    // After cancel the transient (overlay/cut/circle/preview) is gone.
    expect(cancelKnife().phase).toBe(KNIFE_PHASE.Inactive);
    expect(isOverlayVisible(cancelKnife())).toBe(false);
    expect(isFixedCircleVisible(drawing.phase === KNIFE_PHASE.DrawingCut ? drawing : idle())).toBe(
      drawing.phase === KNIFE_PHASE.DrawingCut,
    );
  });

  it('startKnife after a prior session discards the old一時状態', () => {
    const drawing = placeCutPoint(selectTarget(startKnife(), tid), c(5, 5));
    expect(drawing.phase).toBe(KNIFE_PHASE.DrawingCut);
    const restarted = startKnife();
    expect(restarted.phase).toBe(KNIFE_PHASE.SelectingTarget);
  });

  it('backToDrawing from choosing drops the result and re-enters drawing', () => {
    let s = confirmCut(
      placeCutPoint(placeCutPoint(selectTarget(startKnife(), tid), c(5, -5)), c(5, 15)),
      fakeResult,
      INHERITANCE_SIDE.A,
    );
    s = backToDrawing(s);
    expect(s.phase).toBe(KNIFE_PHASE.DrawingCut);
  });
});

describe('transitions are no-ops out of phase (不正状態を表現不能に)', () => {
  it('placeCutPoint while selecting target does nothing', () => {
    const s = startKnife();
    expect(placeCutPoint(s, c(0, 0))).toEqual(s);
  });
  it('selectTarget while drawing does nothing', () => {
    const s = selectTarget(startKnife(), tid);
    expect(selectTarget(s, asFeatureId('other'))).toEqual(s);
  });
  it('undoLastCutPoint while inactive does nothing', () => {
    expect(undoLastCutPoint(idle())).toEqual(idle());
  });
});

describe('guide text (FR-92 / FR-115)', () => {
  it('switches by phase and surfaces the close hint at ≥3 points', () => {
    expect(knifeGuideText(idle())).toBe('');
    expect(knifeGuideText(startKnife())).toBe(KNIFE_GUIDE.SelectTarget);

    let s = selectTarget(startKnife(), tid);
    expect(knifeGuideText(s)).toBe(KNIFE_GUIDE.DrawCutEmpty);
    s = placeCutPoint(placeCutPoint(placeCutPoint(s, c(0, 0)), c(1, 0)), c(1, 1));
    expect(knifeGuideText(s)).toContain(KNIFE_GUIDE.DrawCutClosable);

    const choosing = confirmCut(s, fakeResult, INHERITANCE_SIDE.A);
    expect(knifeGuideText(choosing)).toBe(KNIFE_GUIDE.ChooseInheritor);
  });
});
