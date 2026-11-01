// E2E の残った一時フォルダの片付けの判断（`e2e/stale-userdata.ts`。`docs/現状.md` の B122）。

import { describe, expect, it } from 'vitest';

import {
  PROCESS_LISTING_END,
  STALE_USERDATA_AGE_MS,
  parseProcessListing,
  selectStaleUserData,
  staleUserDataSummary,
} from '../../e2e/stale-userdata';

const NOW = 1_800_000_000_000;
const OLD = NOW - STALE_USERDATA_AGE_MS - 1;

describe('消してよい一時フォルダの選び方', () => {
  it('3 つの条件を全部満たすものだけ選ぶ', () => {
    const picked = selectStaleUserData({
      nowMs: NOW,
      electronCommandLines: ['electron.exe . --user-data-dir=C:\\t\\tmap-e2e-userdata-Inuse'],
      entries: [
        { name: 'tmap-e2e-userdata-Stale', mtimeMs: OLD },
        { name: 'tmap-e2e-userdata-Fresh', mtimeMs: NOW - 1000 },
        { name: 'tmap-e2e-userdata-Inuse', mtimeMs: OLD },
        { name: 'tmap-smoke-userdata-Other', mtimeMs: OLD },
        { name: 'x-tmap-e2e-userdata-Other', mtimeMs: OLD },
      ],
    });
    expect(picked).toEqual(['tmap-e2e-userdata-Stale']);
  });

  it('ちょうど 1 日は古いと数えない', () => {
    expect(
      selectStaleUserData({
        nowMs: NOW,
        electronCommandLines: [],
        entries: [{ name: 'tmap-e2e-userdata-A', mtimeMs: NOW - STALE_USERDATA_AGE_MS }],
      }),
    ).toEqual([]);
  });

  it('プロセスの一覧を読めなかったら何も消さない', () => {
    expect(
      selectStaleUserData({
        nowMs: NOW,
        electronCommandLines: null,
        entries: [{ name: 'tmap-e2e-userdata-A', mtimeMs: OLD }],
      }),
    ).toEqual([]);
  });

  it('コマンドラインの大文字と小文字の違いでは消さない', () => {
    expect(
      selectStaleUserData({
        nowMs: NOW,
        electronCommandLines: ['ELECTRON --USER-DATA-DIR=C:\\T\\TMAP-E2E-USERDATA-AB'],
        entries: [{ name: 'tmap-e2e-userdata-ab', mtimeMs: OLD }],
      }),
    ).toEqual([]);
  });
});

describe('プロセスの一覧の出力の解き方', () => {
  it('行に分け、Electron が居なければ空', () => {
    expect(parseProcessListing(`a --x\r\nb --y\r\n${PROCESS_LISTING_END}\r\n`)).toEqual(['a --x', 'b --y']);
    expect(parseProcessListing(`${PROCESS_LISTING_END}\n`)).toEqual([]);
  });

  it('終わりの印が無ければ読めなかった扱い', () => {
    expect(parseProcessListing('a --x\n')).toBeNull();
    expect(parseProcessListing('')).toBeNull();
  });

  it('コマンドラインが空のプロセスがあれば読めなかった扱い（中身を見られないものを見逃さない）', () => {
    expect(parseProcessListing(`a --x\n\n${PROCESS_LISTING_END}\n`)).toBeNull();
  });
});

describe('片付けの結果の 1 行', () => {
  it('消した数と、読めなかったことを言い分ける', () => {
    expect(staleUserDataSummary(3, true)).toContain('3 個');
    expect(staleUserDataSummary(0, false)).toContain('読めなかった');
  });
});
