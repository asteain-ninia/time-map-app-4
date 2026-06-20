import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import {
  KNIFE_LINE_KIND,
  MIN_POINTS_TO_CLOSE,
  createClosedKnifeLine,
  createOpenKnifeLine,
  isKnifeLineEmpty,
  shouldCloseOnCircleClick,
  withAppendedPoint,
  withoutLastPoint,
} from './knife-line';

const c = (lon: number, lat: number) => createCoordinate(lon, lat);

describe('KnifeLine value', () => {
  it('open vs closed carry the discriminant', () => {
    expect(createOpenKnifeLine([]).kind).toBe(KNIFE_LINE_KIND.Open);
    expect(createClosedKnifeLine([]).kind).toBe(KNIFE_LINE_KIND.Closed);
  });

  it('emptiness is decided by length (教訓5.18)', () => {
    expect(isKnifeLineEmpty(createOpenKnifeLine([]))).toBe(true);
    expect(isKnifeLineEmpty(createOpenKnifeLine([c(0, 0)]))).toBe(false);
  });

  it('append / undo last preserve immutability', () => {
    const a = createOpenKnifeLine([c(0, 0)]);
    const b = withAppendedPoint(a, c(1, 1));
    expect(a.points).toHaveLength(1);
    expect(b.points).toHaveLength(2);
    const back = withoutLastPoint(b);
    expect(back.points).toHaveLength(1);
    expect(withoutLastPoint(createOpenKnifeLine([])).points).toHaveLength(0);
  });
});

describe('shouldCloseOnCircleClick (FR-92)', () => {
  it('requires ≥3 points AND inside the circle', () => {
    expect(shouldCloseOnCircleClick(MIN_POINTS_TO_CLOSE, true)).toBe(true);
    expect(shouldCloseOnCircleClick(MIN_POINTS_TO_CLOSE, false)).toBe(false);
  });

  it('2 points or fewer never closes even inside the circle (受け入れ基準3)', () => {
    expect(shouldCloseOnCircleClick(2, true)).toBe(false);
    expect(shouldCloseOnCircleClick(0, true)).toBe(false);
  });
});
