// UI layer (U20 / shell): オプションバーの設定欄へ **常設で** 部品を差し込むだけの配線
// （増分 5a）。描画するものは無い。
//
// **なぜ器を 1 つ作るのか**: 増分 4 の「表示 ▾」は自分専用の `DisplayOptionsSlot` を持って
// いたが、増分 5a で「深さ ▾」「グリッド」「測量の読み取り」の 3 つが同じ形で要るように
// なった。同じ 3 行の `useEffect` を 4 枚書くと、次に誰かが `registerOptionSlot`（道具の枠）
// と取り違えても気づけない（教訓 5.30 / 5.44）。
//
// **`registerPersistentSlot` を使う理由**（`option-bar.ts` の注記と同じ）: 経度・深さ・格子・
// 表示は **道具の状態ではない**。読むだけのときも、道具を持っていないときも、面を描いて
// いる最中も同じように使える必要がある。道具の枠へ入れると、道具が帯を持ち直した瞬間
// （`claim`）に落ちて画面から消える。

import { useEffect, type ReactNode } from 'react';

import type { OptionBarStore } from './option-bar';

export interface PersistentOptionSlotProps {
  readonly optionBar: OptionBarStore;
  /** 並び順を決める id（`option-bar.ts` の並び順キー）。 */
  readonly id: string;
  readonly children: ReactNode;
}

export function PersistentOptionSlot(props: PersistentOptionSlotProps): null {
  const { optionBar, id, children } = props;
  useEffect(
    () => optionBar.registerPersistentSlot(id, children),
    [optionBar, id, children],
  );
  return null;
}
