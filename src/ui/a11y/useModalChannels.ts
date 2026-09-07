// UI layer (a11y): **自分の中で開いている板を名前で数え、1 本の口へまとめる**
//（司令塔の決定 (13) の受け皿）。
//
// 板を出す部品が複数ある入れ物（素性欄は「全部の年から消す」の確認と「錨を削除」の
// 確認の 2 枚を持つ）は、上へ report する口が 1 本しかない。真偽値を 2 つ OR すると
// 「板が増えたら OR を書き足す」が戻ってきてしまうので、名前の集合で持つ
//（App の `openToolModals` と同じ形。教訓 5.6: 順序に依らない結果状態で持つ）。
//
// 口は id ごとに 1 個だけ作って使い回す。毎レンダー新しい関数を返すと
// {@link useModalRegistration} の effect が毎回張り直され、名乗りが true/false を
// 往復する。

import { useCallback, useMemo, useRef, useState } from 'react';

export interface ModalChannels {
  /** `id` の板が出ているかを報せる口（同じ id なら常に同じ関数）。 */
  readonly channel: (id: string) => (open: boolean) => void;
  /** どれか 1 枚でも出ているか。 */
  readonly anyOpen: boolean;
}

export function useModalChannels(): ModalChannels {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());
  const cache = useRef(new Map<string, (next: boolean) => void>());
  const channel = useCallback((id: string): ((next: boolean) => void) => {
    const cached = cache.current.get(id);
    if (cached !== undefined) return cached;
    const fn = (next: boolean): void => {
      setOpen((prev) => {
        if (prev.has(id) === next) return prev;
        const updated = new Set(prev);
        if (next) updated.add(id);
        else updated.delete(id);
        return updated;
      });
    };
    cache.current.set(id, fn);
    return fn;
  }, []);
  return useMemo(() => ({ channel, anyOpen: open.size > 0 }), [channel, open]);
}
