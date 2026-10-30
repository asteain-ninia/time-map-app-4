// `.test.tsx` が本当に jsdom で走っているかを見る番兵（開発ガイド §5.52）。
//
// `vitest.config.ts` の `environmentMatchGlobs` は、当たらなくても何も言わない。外れると
// `.test.tsx` が node で走り、`document is not defined` が数十本ばらばらに出て原因が読めない。

import { describe, expect, it } from 'vitest';

describe('テストの実行環境', () => {
  it('`.test.tsx` は jsdom で走る', () => {
    expect(
      typeof document,
      '`.test.tsx` が jsdom で走っていない。vitest.config.ts の environmentMatchGlobs が当たっていない。起動した作業ディレクトリのドライブ文字と dir の設定を確かめる（開発ガイド §5.52）',
    ).toBe('object');
  });
});
