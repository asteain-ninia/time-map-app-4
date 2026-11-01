// 「E2E / スモークではウィンドウを出さない（＝ OS のフォーカスを奪わない）」の固定。
// ここが緩むと、テストを回している間 PC で他の作業ができなくなる（実測の困りごと）。
// 本番（旗なし）だけが `show` を返すことも同時に固定する — 製品挙動は 1 ミリも変えない。

import { describe, expect, it } from 'vitest';

import { isHeadlessRun, shouldWatchParentProcess, windowRevealAction, type HeadlessFlags } from './headless-window';

const NO_FLAGS: HeadlessFlags = { e2eTest: false, smokeTest: false, e2eOffscreen: false };

describe('isHeadlessRun — 画面のいらない起動か（オフスクリーン描画の条件）', () => {
  it('旗が 1 つも無ければ偽（本番）', () => {
    expect(isHeadlessRun(NO_FLAGS)).toBe(false);
  });

  it.each([
    ['E2E_TEST', { ...NO_FLAGS, e2eTest: true }],
    ['SMOKE_TEST', { ...NO_FLAGS, smokeTest: true }],
    ['E2E_OFFSCREEN', { ...NO_FLAGS, e2eOffscreen: true }],
  ])('%s だけでも真', (_name, flags) => {
    expect(isHeadlessRun(flags)).toBe(true);
  });

  it('複数立っていても真', () => {
    expect(isHeadlessRun({ e2eTest: true, smokeTest: true, e2eOffscreen: true })).toBe(true);
  });
});

describe('windowRevealAction — 旗があるときは show を呼ばない', () => {
  it.each([
    ['E2E_TEST', { ...NO_FLAGS, e2eTest: true }],
    ['SMOKE_TEST', { ...NO_FLAGS, smokeTest: true }],
    ['E2E_OFFSCREEN', { ...NO_FLAGS, e2eOffscreen: true }],
    ['3 つとも', { e2eTest: true, smokeTest: true, e2eOffscreen: true }],
  ])('%s のときは keep-hidden（show: false のまま = 前面に出ない）', (_name, flags) => {
    expect(windowRevealAction(flags)).toBe('keep-hidden');
  });

  it('本番（旗なし）は show — ready-to-show で表示する従来の経路', () => {
    expect(windowRevealAction(NO_FLAGS)).toBe('show');
  });

  it('オフスクリーン描画とウィンドウ表示は同じ 1 つの条件で決まる（割れない）', () => {
    const cases: readonly HeadlessFlags[] = [
      NO_FLAGS,
      { ...NO_FLAGS, e2eTest: true },
      { ...NO_FLAGS, smokeTest: true },
      { ...NO_FLAGS, e2eOffscreen: true },
      { e2eTest: true, smokeTest: false, e2eOffscreen: true },
      { e2eTest: true, smokeTest: true, e2eOffscreen: true },
    ];
    for (const flags of cases) {
      expect(windowRevealAction(flags) === 'keep-hidden').toBe(isHeadlessRun(flags));
    }
  });
});

describe('shouldWatchParentProcess — 親が消えたら終わる見張りは E2E のときだけ', () => {
  it('E2E_TEST のときだけ真。本番・スモーク・本番の露出を確かめる起動には生えない', () => {
    expect(shouldWatchParentProcess({ ...NO_FLAGS, e2eTest: true })).toBe(true);
    expect(shouldWatchParentProcess(NO_FLAGS)).toBe(false);
    expect(shouldWatchParentProcess({ ...NO_FLAGS, smokeTest: true })).toBe(false);
    expect(shouldWatchParentProcess({ ...NO_FLAGS, e2eOffscreen: true })).toBe(false);
  });
});
