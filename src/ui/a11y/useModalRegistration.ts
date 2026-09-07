// UI layer (a11y): **板を出す部品が、自分で「板が出ている」と名乗る**ための 1 か所
//（司令塔の決定 (13)。設計書 §D.1 / §D.4、教訓 5.75 の実効化）。
//
// **これが直すもの**: 「板が出ている間は道具や大域の打鍵を通さない」という決まりは、
// これまで **App 側の `modalOwnsKeyboard` に名前を書き足す**ことで守られていた。
// 書き足しは人手なので、増分 7 で新しく足した板 5 枚（素性欄の削除・錨の削除・
// 複数頂点の削除・輪郭の削除・まとめて種別）が **まるごと抜けた**。抜けると、板の上で
// Delete を押すと削除の板が 2 枚重なり、Ctrl+Z が背後で走って世界が巻き戻る。
//
// **直し方**: 名乗るのを板の側の仕事にする。板の部品は `onModalChange` を受け取って
// このフックへ渡すだけでよく、App 側は `toolModalChange('<名前>')` を配線するだけ。
// 「板を出したのに名乗り忘れる」は、板を出す経路そのものに名乗りが埋まっているので
// 起こらない。名乗り漏れが無いことは `modal-registration.test.tsx` が総当たりで見る。

import { useEffect } from 'react';

/**
 * `open` が真の間だけ「板が出ている」と名乗る。閉じたとき・部品が外れたときは必ず
 * 取り消す（名乗りっぱなしで打鍵が永久に止まる事故を作らない）。
 *
 * `onModalChange` を渡さない宿主（単体試験など）では何もしない。
 */
export function useModalRegistration(
  onModalChange: ((open: boolean) => void) | undefined,
  open: boolean,
): void {
  useEffect(() => {
    if (onModalChange === undefined || !open) return undefined;
    onModalChange(true);
    return () => {
      onModalChange(false);
    };
  }, [onModalChange, open]);
}
