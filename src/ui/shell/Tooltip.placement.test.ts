// メニューの吹き出しの置き場所の計算。実機で項目を隠さないことは `e2e/inc8e-visual-unity.spec.ts` が見る。

import { describe, expect, it } from 'vitest';

import { bubbleBesideMenu } from './Tooltip';

const item = { left: 0, right: 200, top: 66, bottom: 94 };
const menu = { left: 0, right: 200, top: 32, bottom: 300 };
const windowSize = { width: 800, height: 600 };

describe('bubbleBesideMenu', () => {
  it('右に入るなら器の右で、項目と同じ高さ', () => {
    expect(bubbleBesideMenu(item, menu, { width: 432, height: 20 }, windowSize)).toEqual({ left: 204, top: 66 });
  });

  it('右に入らなければ器の左', () => {
    const right = { left: 500, right: 700, top: 32, bottom: 300 };
    expect(bubbleBesideMenu({ ...item, left: 500, right: 700 }, right, { width: 432, height: 20 }, windowSize)).toEqual({
      left: 64,
      top: 66,
    });
  });

  it('どちらにも入らなければ器の下', () => {
    const middle = { left: 300, right: 500, top: 32, bottom: 300 };
    const placed = bubbleBesideMenu({ ...item, left: 300, right: 500 }, middle, { width: 700, height: 20 }, windowSize);
    expect(placed.top).toBe(304);
    expect(placed.left).toBe(96);
  });

  it('左右に入らず器の下にも入らなければ、窓の中へ寄せる', () => {
    // 窓 800×600、器は左右 300〜500・下端 580、吹き出し 700×40。器の下なら下端 624 で窓を越える。
    const lowMenu = { left: 300, right: 500, top: 300, bottom: 580 };
    const placed = bubbleBesideMenu(
      { left: 300, right: 500, top: 540, bottom: 570 },
      lowMenu,
      { width: 700, height: 40 },
      windowSize,
    );
    expect(placed.left).toBe(96);
    expect(placed.top).toBe(556);
    expect(placed.top + 40).toBeLessThanOrEqual(windowSize.height);
  });

  it('窓の下へ出るなら上へ寄せる', () => {
    const low = { left: 0, right: 200, top: 580, bottom: 600 };
    expect(bubbleBesideMenu(low, menu, { width: 300, height: 40 }, windowSize).top).toBe(556);
  });
});
