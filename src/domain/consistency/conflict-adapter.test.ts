// U13 — both-side contract test for the U10 → U13 conflict adapter (教訓5.33).
// Proves U13 consumes U10's real {@link OverlapPair} shape (id pair + overlap
// pieces) and produces a structured {@link Conflict} with display names, time,
// and all overlap pieces preserved (教訓5.1).

import { describe, expect, it } from 'vitest';

import { asFeatureId, idToString, type FeatureId } from '../ids';
import { createCoordinate } from '../coordinate';
import type { GeoMultiPolygon } from '../geometry/types';
import type { OverlapPair } from '../spatial/overlap';
import { timePointYear } from '../time/time-point';
import {
  CONFLICT_KIND,
  conflictFromOverlapPair,
  conflictsFromOverlapPairs,
  conflictIdFor,
  type ConflictTime,
} from './index';

const FA = asFeatureId('a');
const FB = asFeatureId('b');

const TWO_PIECE_OVERLAP: GeoMultiPolygon = [
  [[createCoordinate(0, 0), createCoordinate(1, 0), createCoordinate(1, 1)]],
  [[createCoordinate(5, 5), createCoordinate(6, 5), createCoordinate(6, 6)]],
];

const names = (id: FeatureId): string => `表示-${idToString(id)}`;
const timeAt = (): ConflictTime => ({ kind: 'point', at: timePointYear(800) });

describe('conflict-adapter (U10 OverlapPair → U13 Conflict)', () => {
  it('OverlapPair を構造化 Conflict に写像し、表示名・時間・種類・全片を保持する', () => {
    const pair: OverlapPair = { a: FA, b: FB, overlap: TWO_PIECE_OVERLAP };
    const c = conflictFromOverlapPair(pair, names, timeAt);

    expect(c.id).toBe(conflictIdFor(FA, FB));
    expect(c.kind).toBe(CONFLICT_KIND.TerminalOverlap);
    expect(c.a.displayName).toBe('表示-a');
    expect(c.b.displayName).toBe('表示-b');
    expect(c.time).toEqual({ kind: 'point', at: timePointYear(800) });
    // All overlap pieces preserved (片落としなし).
    expect(c.overlap).toHaveLength(2);
    expect(c.overlap).toBe(TWO_PIECE_OVERLAP);
  });

  it('複数 OverlapPair をまとめて変換する (片落としなし)', () => {
    const pairs: OverlapPair[] = [
      { a: FA, b: FB, overlap: TWO_PIECE_OVERLAP },
      { a: FB, b: asFeatureId('c'), overlap: TWO_PIECE_OVERLAP },
    ];
    const conflicts = conflictsFromOverlapPairs(pairs, names, timeAt);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((x) => x.id)).toEqual([
      conflictIdFor(FA, FB),
      conflictIdFor(FB, asFeatureId('c')),
    ]);
  });
});
