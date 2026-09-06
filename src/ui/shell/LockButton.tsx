// UI layer (U20 / shell): 鍵のボタン 1 個（設計書 §C.1 の 4 / §H.2）。
//
// **置き場はアプリバーの右端の 96px の固定枠**である（設計書 §C.1 の「鍵（読むだけ ⇄
// 直せる）／96 固定」）。増分 5b では左のレールの一番上に置いていたが、それが
// **レールが縦にあふれる根**だった ―― 88px のレールに鍵 1 個ぶんの高さと区切り線が
// 足され、道具 12 個が既定の窓（1280×800）でも入りきらなくなっていた。鍵はアプリバーへ
// 戻し、レールは道具だけにする。
//
// **`data-testid="mode-view"` は据え置く**（T-1「役割で維持し、改名しない」）。役割は
// 「編集を止めるトグル」のままで、置き場が変わっただけである。
//
// **ツールチップは付けない**（設計書 §H.2 / U-9 / HB-16）。`Tooltip` で包まないだけでなく、
// **`title` 属性も付けない** ―― 増分 5b の実装には `title` が残っていて、
// 「吹き出しは付けない」という決定と静かにすれ違っていた（ネイティブの吹き出しも
// 押下の邪魔になるし、鍵は 2 状態とも文字そのものが状態を言い切っている）。
//
// 2 状態（`🔒 読むだけ` / `🔓 直せる`）とも **同じ 96px の枠に文字が切れずに収まる**。
// 枠と文字の寸法は `shell.css` の `.app-shell__lock` が単一の真実源として持つ。

import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import { LOCK_LABELS } from './strings';
import { useShell } from './useShell';

export interface LockButtonProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

export function LockButton<S>(props: LockButtonProps<S>): JSX.Element {
  const shell = useShell(props.store);

  return (
    <button
      type="button"
      className="app-shell__lock-button"
      data-testid="mode-view"
      aria-pressed={shell.locked}
      onClick={() => shell.setLocked(!shell.locked)}
    >
      {shell.locked ? LOCK_LABELS.locked : LOCK_LABELS.unlocked}
    </button>
  );
}
