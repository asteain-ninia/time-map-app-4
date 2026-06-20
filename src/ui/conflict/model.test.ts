// U35 — pure conflict-resolution model tests (受け入れ基準 2 / 4 / 5).
//
// All node-environment (no DOM): time formatting, draft aggregation, the全件
// 指定済みか judgement evaluated against the raw set (教訓 5.10 / 5.18), the
// deterministic drafts→Resolution mapping, and the list view-model (片落としなし,
// 教訓 5.1).

import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';
import { createCoordinate } from '../../domain/coordinate';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import {
  timePointYear,
  timePointYearMonthDay,
} from '../../domain/time/time-point';
import type { Conflict, ConflictTime } from '../../domain/consistency/index';

import {
  EMPTY_DRAFTS,
  ROW_STATE,
  adjustFeatureFor,
  allConflictsResolved,
  buildConflictListVM,
  formatConflictTime,
  pruneDrafts,
  setDraftPriority,
  toResolutions,
  unresolvedConflictIds,
} from './model';

const FA = asFeatureId('feat-a');
const FB = asFeatureId('feat-b');
const FC = asFeatureId('feat-c');
const FD = asFeatureId('feat-d');

const TRI: GeoMultiPolygon = [
  [[createCoordinate(0, 0), createCoordinate(1, 0), createCoordinate(1, 1)]],
];

function conflict(
  id: string,
  a = FA,
  b = FB,
  time: ConflictTime = { kind: 'point', at: timePointYear(800) },
): Conflict {
  return {
    id,
    kind: 'terminal-overlap',
    time,
    a: { featureId: a, displayName: `表示-${String(a)}` },
    b: { featureId: b, displayName: `表示-${String(b)}` },
    overlap: TRI,
  };
}

describe('formatConflictTime (FR-65 / FR-72)', () => {
  it('年のみ・年月日・紀元前を整形する', () => {
    expect(formatConflictTime({ kind: 'point', at: timePointYear(800) })).toBe('800年');
    expect(
      formatConflictTime({ kind: 'point', at: timePointYearMonthDay(800, 3, 5) }),
    ).toBe('800年3月5日');
    expect(formatConflictTime({ kind: 'point', at: timePointYear(-44) })).toBe('紀元前44年');
  });

  it('時間範囲を波ダッシュで結合する', () => {
    expect(
      formatConflictTime({
        kind: 'range',
        from: timePointYear(-100),
        to: timePointYear(50),
      }),
    ).toBe('紀元前100年〜50年');
  });
});

describe('drafts (FR-63, 教訓 5.2)', () => {
  it('setDraftPriority は新しい Map を返し入力を変えない', () => {
    const d0 = EMPTY_DRAFTS;
    const d1 = setDraftPriority(d0, 'c1', FA);
    expect(d0.size).toBe(0);
    expect(d1.get('c1')).toBe(FA);
  });

  it('選び直しは値を置換する', () => {
    const d = setDraftPriority(setDraftPriority(EMPTY_DRAFTS, 'c1', FA), 'c1', FB);
    expect(d.get('c1')).toBe(FB);
    expect(d.size).toBe(1);
  });

  it('pruneDrafts は消えた競合の選択を捨てる (教訓 5.2 / 5.5)', () => {
    const d = setDraftPriority(setDraftPriority(EMPTY_DRAFTS, 'c1', FA), 'c2', FB);
    const pruned = pruneDrafts(d, [conflict('c2')]);
    expect(pruned.has('c1')).toBe(false);
    expect(pruned.get('c2')).toBe(FB);
  });
});

describe('全件指定済みか (受け入れ基準 5, 教訓 5.10 / 5.18)', () => {
  const conflicts = [conflict('c1'), conflict('c2', FC, FD)];

  it('未指定が残る間は unresolvedConflictIds が全件を生の集合から拾う', () => {
    expect(unresolvedConflictIds(conflicts, EMPTY_DRAFTS)).toEqual(['c1', 'c2']);
    const d = setDraftPriority(EMPTY_DRAFTS, 'c1', FA);
    expect(unresolvedConflictIds(conflicts, d)).toEqual(['c2']);
  });

  it('全件指定で allConflictsResolved=true、1件でも欠ければ false', () => {
    let d = setDraftPriority(EMPTY_DRAFTS, 'c1', FA);
    expect(allConflictsResolved(conflicts, d)).toBe(false);
    d = setDraftPriority(d, 'c2', FC);
    expect(allConflictsResolved(conflicts, d)).toBe(true);
  });

  it('空の競合リストは未指定0件 (空配列は真値, 教訓 5.18)', () => {
    expect(unresolvedConflictIds([], EMPTY_DRAFTS)).toEqual([]);
    expect(allConflictsResolved([], EMPTY_DRAFTS)).toBe(true);
  });
});

describe('drafts → Resolution の決定論的写像 (FR-63)', () => {
  it('優先＝選択側・調整対象＝もう一方を導く', () => {
    const c = conflict('c1', FA, FB);
    expect(adjustFeatureFor(c, FA)).toBe(FB);
    expect(adjustFeatureFor(c, FB)).toBe(FA);
    expect(adjustFeatureFor(c, FC)).toBeUndefined();
  });

  it('toResolutions は競合順で全件を一括で写像する (受け入れ基準 5)', () => {
    const conflicts = [conflict('c1', FA, FB), conflict('c2', FC, FD)];
    const d = setDraftPriority(setDraftPriority(EMPTY_DRAFTS, 'c1', FB), 'c2', FC);
    expect(toResolutions(conflicts, d)).toEqual([
      { conflictId: 'c1', priorityFeatureId: FB, adjustFeatureId: FA },
      { conflictId: 'c2', priorityFeatureId: FC, adjustFeatureId: FD },
    ]);
  });

  it('未指定があれば toResolutions は投げる (部分適用の禁止)', () => {
    const conflicts = [conflict('c1', FA, FB)];
    expect(() => toResolutions(conflicts, EMPTY_DRAFTS)).toThrow();
  });
});

describe('list view-model (受け入れ基準 2, 教訓 5.1 片落としなし)', () => {
  it('全競合の行を入力順で生成し、状態と残件数を派生する', () => {
    const conflicts = [conflict('c1', FA, FB), conflict('c2', FC, FD)];
    const d = setDraftPriority(EMPTY_DRAFTS, 'c1', FA);
    const vm = buildConflictListVM(conflicts, d);
    expect(vm.rows.map((r) => r.conflictId)).toEqual(['c1', 'c2']);
    expect(vm.rows[0]!.state).toBe(ROW_STATE.Resolved);
    expect(vm.rows[0]!.priorityFeatureId).toBe(FA);
    expect(vm.rows[1]!.state).toBe(ROW_STATE.Unresolved);
    expect(vm.unresolvedCount).toBe(1);
    expect(vm.allResolved).toBe(false);
    expect(vm.rows[0]!.featureNames).toEqual(['表示-feat-a', '表示-feat-b']);
    expect(vm.rows[0]!.kindLabel).toBe('末端地物の重なり');
  });
});
