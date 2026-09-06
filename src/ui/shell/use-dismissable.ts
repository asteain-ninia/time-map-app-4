// UI layer (U20 / shell): **一時的に開くものを閉じる作法**（設計書 §B.5 の台帳 #5）。
//
// `OptionPopover`（オプションバーの「◯◯ ▾」）と、錨レーンの束の吹き出しが同じ規則で
// 閉じるようにするための 1 か所。**写しを作らない**（教訓 5.44: 共通の手順の写しが
// 残ると、経路によって新旧が混ざる）。
//
// 束の吹き出しは `OptionPopover` そのものには寄せられない ―― 開く契機が canvas の押下で、
// **アンカーのボタンが無い**（器は「アンカーの矩形の下に出す」ことを前提に位置を決める）。
// そこで、器の中で事故を出したぶんの作法（3・4・5）だけをこの hook に抜き、両方が読む。
//
//   3. 背面を覆う板を置かない。閉じるのは文書全体の `pointerdown` の捕捉段と Escape。
//   4. 状態が移ったら閉じる（道具・モード・プロジェクト・選択の指紋 `closeKey`）。
//   5. 開閉を呼び出し側へ報せる（`focusOwner` の `popover` を App が導出する）。

import { useEffect, useRef, type RefObject } from 'react';

export interface DismissableOptions {
  /** いま開いているか。 */
  readonly open: boolean;
  /** 閉じる。 */
  readonly close: () => void;
  /** 状態の指紋。変わったら閉じる（作法 4）。 */
  readonly closeKey: string;
  /** 「中」と見なす要素（ここを押しても閉じない）。 */
  readonly insideRefs: readonly RefObject<HTMLElement | null>[];
  /** 開閉の報せ（作法 5）。 */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /** Escape で閉じたあとにすること（焦点を戻すなど）。 */
  readonly onEscape?: (() => void) | undefined;
}

export function useDismissable(options: DismissableOptions): void {
  // 最新の実体は ref 越しに読む。**依存に関数や配列を入れると、呼び出し側が毎レンダー
  // 新しい値を渡した瞬間に「後片付け → 登録」が毎回走る**（開いているのに false が流れる）。
  const latest = useRef(options);
  latest.current = options;
  const { open, closeKey } = options;

  // 作法 5。**部品ごと消えるときも閉じたことにする** ―― 開いたまま消えると
  // `focusOwner` が `popover` のまま固まって鍵盤が戻らない（K-5）。
  useEffect(() => {
    latest.current.onOpenChange?.(open);
  }, [open]);
  useEffect(
    () => () => {
      latest.current.onOpenChange?.(false);
    },
    [],
  );

  // 作法 3。
  useEffect(() => {
    if (!open) return;
    const isInside = (target: Node): boolean =>
      latest.current.insideRefs.some((r) => r.current?.contains(target) === true);
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (isInside(target)) return;
      latest.current.close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      latest.current.close();
      latest.current.onEscape?.();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  // 作法 4。
  const closeKeyRef = useRef(closeKey);
  useEffect(() => {
    const prev = closeKeyRef.current;
    closeKeyRef.current = closeKey;
    if (!open) return;
    if (prev === closeKey) return;
    latest.current.close();
  }, [open, closeKey]);
}
