// U23 —「吸着 ▾」ポップオーバーの許容値の欄（設計書 §C.4 / §N-6）。
//
// **この検査が生まれた理由**（実機で踏んだ 2 つ）:
//  (a) **打っている途中で値が書き換わる**。欄は設定の値を直に描いていて、`onChange` の
//      たびに店（U16 ストア）が `clampSnapTolerancePx` で丸めた値を返していた。だから
//      「99」と打とうとすると、2 文字目を入れる前に欄の中身が丸めた数に入れ替わり、
//      打ちたい数を打てなかった。**丸めるのは欄から離れたとき（blur）だけ**である。
//  (b) **入れられる範囲が画面のどこにも書いていない**。`min` / `max` は付いていたが、
//      それは目に見えない。外れた値を打つと離れた瞬間に黙って別の数へ変わり、
//      なぜそうなったのかが分からなかった。
//
// 店と同じ丸めを下の `Harness` に持たせてある。ここを省くと (a) の現象が再現しないので、
// 検査としては何も守らない緑になる。

/// <reference types="@testing-library/jest-dom" />

import { useState } from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  clampSnapTolerancePx,
  DEFAULT_SNAP_SETTINGS,
  SNAP_TOLERANCE_MAX_PX,
  SNAP_TOLERANCE_MIN_PX,
  type SnapSettings,
} from '../state/session';

import { SnapOptions } from './SnapOptions';

/**
 * 実機と同じ結線（設定を持ち、受け取った値を **店と同じ規則で丸めて** 返す親）。
 * `AddToolController` → `store.setSnapSettings` がやっていることの写しである。
 */
function Harness(): JSX.Element {
  const [settings, setSettings] = useState<SnapSettings>(DEFAULT_SNAP_SETTINGS);
  return (
    <SnapOptions
      settings={settings}
      onChange={(patch) =>
        setSettings((prev) => ({
          ...prev,
          ...patch,
          tolerancePx:
            patch.tolerancePx === undefined
              ? prev.tolerancePx
              : clampSnapTolerancePx(patch.tolerancePx),
        }))
      }
      gridSnap={undefined}
      onGridSnapChange={() => {}}
      closeKey="add.area"
    />
  );
}

/** ポップオーバーを開いて、許容値の欄を返す。 */
async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLInputElement> {
  await user.click(screen.getByTestId('option-snap-button'));
  return screen.getByTestId('snap-tolerance') as HTMLInputElement;
}

describe('SnapOptions 許容値の欄（打っている間は書き換えない / 範囲を見せる）', () => {
  it('打っている間は打った文字がそのまま残り、範囲へ丸めるのは欄から離れたときだけ', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await openPanel(user);

    await user.clear(input);
    // 上限（50）を超える数を **3 文字かけて** 打つ。丸めが打鍵のたびに効いていた頃は、
    // 2 文字目を入れる前に欄が「50」へ入れ替わり、「999」とは打てなかった。
    await user.type(input, '999');
    expect(input.value).toBe('999');

    // 離れて初めて丸まる。
    await user.tab();
    expect(input.value).toBe(String(SNAP_TOLERANCE_MAX_PX));
  });

  it('下限より小さい数も、離れたときに下限へ丸まる', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await openPanel(user);

    await user.clear(input);
    await user.type(input, '0');
    expect(input.value).toBe('0');

    await user.tab();
    expect(input.value).toBe(String(SNAP_TOLERANCE_MIN_PX));
  });

  it('空にして離れたときは、いまの値へ戻す（既定へ化けさせない）', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await openPanel(user);

    await user.clear(input);
    await user.type(input, '30');
    await user.tab();
    expect(input.value).toBe('30');

    input.focus();
    await user.clear(input);
    expect(input.value).toBe('');
    await user.tab();
    expect(input.value).toBe('30');
  });

  it('入れられる範囲（1〜50px）が画面に出ている', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPanel(user);

    const range = screen.getByTestId('snap-tolerance-range');
    // 目で見える形で出ていること（`min` / `max` 属性だけでは足りない）。
    expect(range).toBeVisible();
    // 文言は `session.ts` の定数から組み立てられていること（数値の二重管理をしない）。
    expect(range).toHaveTextContent(`${SNAP_TOLERANCE_MIN_PX}〜${SNAP_TOLERANCE_MAX_PX}px`);
  });
});
