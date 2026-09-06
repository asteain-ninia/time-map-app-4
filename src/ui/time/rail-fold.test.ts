// 時刻レールの操作列の畳み（設計書 §B.4 の表の 4 列目）を固定する。
//
// **増分 5 の「≫」の事故を繰り返さない**（教訓 5.74）。あのときは畳みの予算に見込んだ
// 兄弟の幅（160px）と実寸（189〜204px）がずれ、いちばん右の「≫」が欄の外へこぼれた。
// ここでは「段ごとに要する幅」を **見積りの合計**として出し、
//   ①いちばん狭い段が設計書の最小内容幅（672px）を超えないこと
//   ②どの段も、その段が効く **いちばん狭い窓** に収まること
// の 2 つを固定する。実寸の突き合わせは E2E（`e2e/inc6-rail.spec.ts`）が担う。

import { describe, expect, it } from 'vitest';

import {
  RAIL_FOLD,
  RAIL_FOLD_BREAKPOINTS,
  RAIL_GROUP_WIDTH,
  RAIL_MIN_CONTENT_WIDTH,
  RAIL_MIN_WINDOW_WIDTH,
  railContentWidth,
  railFoldOf,
  railGroupsAt,
} from './rail-fold';

describe('窓幅から段を決める（畳みは窓幅だけで決まる）', () => {
  it('設計書 §B.4 の 4 段', () => {
    expect(railFoldOf(1920)).toBe(RAIL_FOLD.Full);
    expect(railFoldOf(1440)).toBe(RAIL_FOLD.Full);
    expect(railFoldOf(1439)).toBe(RAIL_FOLD.NoHundred);
    expect(railFoldOf(1120)).toBe(RAIL_FOLD.NoHundred);
    expect(railFoldOf(1119)).toBe(RAIL_FOLD.ZoomMenu);
    expect(railFoldOf(960)).toBe(RAIL_FOLD.ZoomMenu);
    expect(railFoldOf(959)).toBe(RAIL_FOLD.KeysOnly);
    expect(railFoldOf(800)).toBe(RAIL_FOLD.KeysOnly);
  });
});

describe('段ごとの中身（±1 の送り・年入力・再生は最後まで残す）', () => {
  it('いちばん狭い段でも 送り ±1・年入力・再生 は残る', () => {
    const ids = railGroupsAt(RAIL_FOLD.KeysOnly).map((g) => g.id);
    expect(ids).toContain('step1');
    expect(ids).toContain('year');
    expect(ids).toContain('playMin');
  });

  it('1120px 未満で 100 年送りが落ち、「≫」が出る', () => {
    const full = railGroupsAt(RAIL_FOLD.Full).map((g) => g.id);
    const folded = railGroupsAt(RAIL_FOLD.NoHundred).map((g) => g.id);
    expect(full).toContain('step100');
    expect(folded).not.toContain('step100');
    expect(folded).toContain('overflow');
  });

  it('960px 未満で拡大の 3 ボタンが「拡大 ▾」1 個になり、ステップ単位が落ちる', () => {
    const ids = railGroupsAt(RAIL_FOLD.ZoomMenu).map((g) => g.id);
    expect(ids).toContain('zoomMenu');
    expect(ids).not.toContain('zoomFull');
    expect(ids).not.toContain('unit');
  });

  it('800px 台で錨ジャンプが落ち、再生が「▶」だけになる', () => {
    const ids = railGroupsAt(RAIL_FOLD.KeysOnly).map((g) => g.id);
    expect(ids).not.toContain('anchorJump');
    expect(ids).not.toContain('playFull');
    expect(ids).toContain('playMin');
  });

  it('落としたものは必ず「≫」から開ける（キーだけにして行き止まりにしない）', () => {
    for (const level of [RAIL_FOLD.NoHundred, RAIL_FOLD.ZoomMenu, RAIL_FOLD.KeysOnly]) {
      expect(railGroupsAt(level).map((g) => g.id)).toContain('overflow');
    }
  });
});

describe('幅の見積り（教訓 5.74: 予算を実際に嵌める）', () => {
  it('いちばん狭い段が設計書の最小内容幅（672px）を超えない', () => {
    expect(railContentWidth(RAIL_FOLD.KeysOnly)).toBeLessThanOrEqual(
      RAIL_MIN_CONTENT_WIDTH,
    );
  });

  it('どの段も、その段が効くいちばん狭い窓に収まる', () => {
    const cases: readonly [(typeof RAIL_FOLD)[keyof typeof RAIL_FOLD], number][] = [
      [RAIL_FOLD.Full, RAIL_FOLD_BREAKPOINTS.full],
      [RAIL_FOLD.NoHundred, RAIL_FOLD_BREAKPOINTS.noHundred],
      [RAIL_FOLD.ZoomMenu, RAIL_FOLD_BREAKPOINTS.zoomMenu],
      [RAIL_FOLD.KeysOnly, RAIL_MIN_WINDOW_WIDTH],
    ];
    for (const [level, windowWidth] of cases) {
      expect(railContentWidth(level)).toBeLessThanOrEqual(windowWidth);
    }
  });

  it('U-8 の下限（幅 64px 以上）を ±1 の送りと再生が守る', () => {
    // 2 個ぶんで 128px = 1 個 64px。再生も 64px。
    expect(RAIL_GROUP_WIDTH.step1).toBe(128);
    expect(RAIL_GROUP_WIDTH.playMin).toBe(64);
  });
});
