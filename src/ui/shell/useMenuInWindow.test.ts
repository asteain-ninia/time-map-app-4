// 右クリックメニューの置き場所の計算。実機で窓の中に収まることは `e2e/inc8e-visual-unity.spec.ts` が見る。

import { describe, expect, it } from 'vitest';

import { fitMenuInWindow, MENU_WINDOW_MARGIN, type FitMenuInput } from './useMenuInWindow';

const base: FitMenuInput = {
  x: 100,
  y: 100,
  width: 200,
  height: 300,
  windowWidth: 800,
  windowHeight: 600,
  direction: 'down',
};

describe('fitMenuInWindow', () => {
  it('入るなら押した位置のまま', () => {
    expect(fitMenuInWindow(base)).toEqual({ left: 100, top: 100 });
  });

  it('下へ出るなら上へ寄せる', () => {
    expect(fitMenuInWindow({ ...base, y: 500 })).toEqual({ left: 100, top: 600 - 300 - MENU_WINDOW_MARGIN });
  });

  it('右へ出るなら左へ寄せる', () => {
    expect(fitMenuInWindow({ ...base, x: 790 })).toEqual({ left: 800 - 200 - MENU_WINDOW_MARGIN, top: 100 });
  });

  it('窓より高いなら上端に付ける（先頭の項目を見せ、残りは中でスクロールする）', () => {
    expect(fitMenuInWindow({ ...base, height: 900 }).top).toBe(MENU_WINDOW_MARGIN);
  });

  it('上へ開く向きは、下端を押した位置に合わせる', () => {
    expect(fitMenuInWindow({ ...base, y: 500, direction: 'up' })).toEqual({ left: 100, top: 200 });
  });

  it('上へ開いて上へ出るなら、窓の上端で止める', () => {
    expect(fitMenuInWindow({ ...base, y: 100, direction: 'up' }).top).toBe(MENU_WINDOW_MARGIN);
  });
});
