// `npm run e2e:shared` の終わりの集計（scripts/e2e-shared-summary.mjs）。
// 閉じ忘れと終了の失敗が 1 件でもあれば赤にする判定を、Playwright 抜きで確かめる。
import { describe, expect, it } from 'vitest';

import { exitCodeFor, summarizeLaunchLog } from '../../scripts/e2e-shared-summary.mjs';

function logOf(...records: readonly Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify({ run: 'r1', ...r })).join('\n') + '\n';
}

describe('起動の使い回しの集計', () => {
  it('使い回しと起動を数える', () => {
    const summary = summarizeLaunchLog(
      logOf({ ev: 'launch', kind: 'fresh' }, { ev: 'launch', kind: 'reused' }, { ev: 'launch', kind: 'reused' }),
      'r1',
    );
    expect(summary.reused).toBe(2);
    expect(summary.started).toBe(1);
    expect(summary.problemCount).toBe(0);
  });

  it('閉じ忘れと終了の失敗を問題として数え、検査の名前を返す', () => {
    const summary = summarizeLaunchLog(
      logOf(
        { ev: 'not-closed', test: 'A', ownerFailed: false },
        { ev: 'close-failed', test: 'B', error: 'だめ', forced: true, exited: true },
      ),
      'r1',
    );
    expect(summary.notClosed.map((r: { test: string }) => r.test)).toEqual(['A']);
    expect(summary.closeFailed.map((r: { test: string }) => r.test)).toEqual(['B']);
    expect(summary.problemCount).toBe(2);
  });

  it('失敗した検査が閉じられなかった分は数えない（その検査はすでに赤）', () => {
    const summary = summarizeLaunchLog(logOf({ ev: 'not-closed', test: 'A', ownerFailed: true }), 'r1');
    expect(summary.problemCount).toBe(0);
  });

  it('別の実行の記録は数えない（記録の置き場を変えて追記が残っていても赤にしない）', () => {
    const text =
      JSON.stringify({ run: 'old', ev: 'not-closed', test: 'A', ownerFailed: false }) +
      '\n' +
      logOf({ ev: 'launch', kind: 'fresh' });
    const summary = summarizeLaunchLog(text, 'r1');
    expect(summary.problemCount).toBe(0);
    expect(summary.started).toBe(1);
  });

  it('残すものは 1 本につき種類ごとに 1 回数える', () => {
    const summary = summarizeLaunchLog(
      logOf({
        ev: 'checkin',
        left: {
          'main.windows.0.bounds.x': ['1', '2'],
          'main.windows.0.bounds.y': ['1', '2'],
          'driver.stickyCalls.0': ['(無し)', '"page.route"'],
        },
      }),
      'r1',
    );
    expect(summary.leftByGroup).toEqual([
      ['main.windows', 1],
      ['driver.stickyCalls', 1],
    ]);
  });
});

describe('終了コード', () => {
  it('検査が緑で問題が 0 件なら 0', () => {
    expect(exitCodeFor(0, 0)).toBe(0);
  });
  it('検査が緑でも問題が 1 件でもあれば非 0', () => {
    expect(exitCodeFor(0, 1)).toBe(1);
  });
  it('検査が赤ならその終了コードのまま', () => {
    expect(exitCodeFor(3, 0)).toBe(3);
    expect(exitCodeFor(3, 2)).toBe(3);
  });
  it('終了コードが取れなければ赤', () => {
    expect(exitCodeFor(null, 0)).toBe(1);
  });
});
