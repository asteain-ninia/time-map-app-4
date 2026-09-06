// UI layer (U20 / shell): 「いま文字を打っているか」を 1 か所で観測する hook（増分 5c）。
//
// 鍵盤の持ち主（`focus-owner.ts`）の入力の 1 つ。**判定は `focus-guard` の 1 本を通す**
// ―― `tagName === 'INPUT'` のような写しを増やすと、`contenteditable` や `select` の
// 扱いが場所ごとに食い違う（教訓 5.13 / 5.44）。
//
// **なぜ hook が要るか**: `document.activeElement` は React の状態ではないので、
// 焦点が動いても再レンダーは起きない。`focusin` / `focusout` を文書全体で 1 回だけ
// 聞いて、変わったときだけ真偽値を更新する。

import { useEffect, useState } from 'react';

import { isTextEntryElement } from './focus-guard';

function textFocusedNow(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  return el instanceof Element && isTextEntryElement(el);
}

export function useTextFocused(): boolean {
  const [focused, setFocused] = useState<boolean>(() => textFocusedNow());

  useEffect(() => {
    const update = (): void => {
      setFocused((prev) => {
        const now = textFocusedNow();
        return prev === now ? prev : now;
      });
    };
    // `focusout` は次の焦点が入る **前** に飛ぶので、そのまま読むと一瞬 false になる。
    // マイクロタスクへ逃がして「移った先」を読む（欄から欄へ移るあいだに持ち主が
    // 地図へ戻ってしまうのを防ぐ）。
    const onFocusOut = (): void => {
      queueMicrotask(update);
    };
    document.addEventListener('focusin', update, true);
    document.addEventListener('focusout', onFocusOut, true);
    update();
    return () => {
      document.removeEventListener('focusin', update, true);
      document.removeEventListener('focusout', onFocusOut, true);
    };
  }, []);

  return focused;
}
