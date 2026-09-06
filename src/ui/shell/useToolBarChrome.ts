// UI layer (U20 / shell): 手順のある道具の「案内・断り・確定の列」をオプションバーへ
// 押し込む配線（増分 5d / 設計書 §C.4・§B.5・E-2 / N-27）。
//
// **これが直すもの**: ナイフ・結合・所属変更・輪郭・穴あけの 5 つは、案内の文・断り文・
// 確定の列を **地図の上に浮かせて**いた（設計書 §B.5 の台帳 #2〜#4）。確定の列は
// 押せる部品なので、地図のクリックを奪う事故（K-2。3 回起きている）の当事者である。
// 「`.tool-controls` に統一した」という記録があったのにクラスは実在せず、実際には
// **6 通りに割れていた**（N-27）。
//
// 置き場は **オプションバーの確定欄 176px**（E-2）。U-10「確定はどの道具でも同じ場所」は
// 守ったまま、位置だけ地図の下端中央から移す。**地図に重ならないので K-2 の事故が
// 構造的に起こり得ない。**
//
// **確定欄は 2 つで満杯**（176px ÷ U-8 の下限 60px）なので、［確定］［やめる］以外は
// 設定欄へ差し込む（増分 3 が［1 つ戻す］でやったのと同じ形）。
//
// **押し込みは持ち主を見ない**（`option-bar.ts` の `claim` 注記 3）。帯の持ち主は
// `ToolOptionBar` のままで、この hook は道具名と対象以外の 3 区画だけを埋める。
// `ToolOptionBar` の `claim` は道具が替わった瞬間に走って帯を空へ戻すので、
// **前の道具の確定ボタンが次の道具に残らない**（教訓 5.2）。
//
// **増分 5 の手直し C1: 追加の道具（面・線・点）もこの hook を通す。** 通していなかった
// ので、手順のある道具から面／線／点へ持ち替えると前の道具の確定欄が残った。器を 1 つに
// すると、押し込みと後片付けの順序も 1 か所で決まる。

import { useEffect, type ReactNode } from 'react';

import type { OptionBarCommitButton, OptionBarStore } from './option-bar';

export interface ToolBarChromeOptions {
  readonly optionBar: OptionBarStore | undefined;
  /** その道具が帯を使ってよい局面か（構えていて、板やモーダルが出ていない）。 */
  readonly active: boolean;
  /** 設定欄へ差し込む部品の id（道具ごとに固有）。 */
  readonly slotId: string;
  /**
   * 「次の一手」（1fr）。**断り文があればそれを出す**（設計書 §C.4: 拒否理由が出たら
   * その文がそのまま次の一手に置き換わる）。呼び出し側で解いてから渡す。
   */
  readonly nextStep: string | null;
  /** 確定欄（176px）。［○○を確定］［やめる］の 2 つまで。 */
  readonly commit: readonly OptionBarCommitButton[];
  /** 設定欄へ差し込む残りの操作（［1 つ戻す］［クリア］など）。無ければ null。 */
  readonly extras: ReactNode;
}

export function useToolBarChrome(options: ToolBarChromeOptions): void {
  const { optionBar, active, slotId, nextStep, commit, extras } = options;

  // **空へ戻すのは「後片付け」でやる。**
  //
  // 5 つの道具のコントローラは **全部が同時にマウントされている**（構えていないものは
  // 何も描かないだけ）。だから「降りているなら空へ戻す」を effect の本体に書くと、
  // **構えていない 4 つが、構えている 1 つの押し込みを踏み消す** ―― effect は木の順に
  // 走るので、あとに置かれた道具ほど強い、という不条理な依存が生まれる（教訓 5.68）。
  //
  // 前の版は「入れた側が印（`pushedRef`）を持ち、自分のぶんだけ戻す」形にした。これは
  // **踏み消しの半分しか塞げていなかった** ―― 印は自分のローカルなので、いま帯を
  // 持っているのが誰かを知らない。木の中で **後ろに居る道具から前に居る道具へ**
  // 持ち替えると、「（後ろの道具の）自分が入れたぶんを戻す」が **前の道具が既に
  // 押し込んだあと**に走り、次の一手と確定欄が空になる（Opus 反証 ② / GPT #7 /
  // Fable E。手順のある道具どうしの 20 通りのうち、後ろ→前の 10 通りで再現した）。
  //
  // **後片付け関数へ移すと順序の問題そのものが消える。** React は 1 つのコミットの中で
  // **全部の後片付け → 全部の再実行** の順に走らせるので、木の位置に関わらず
  // 「前の道具が空へ戻す → 次の道具が押し込む」になる。印はもう要らない。
  useEffect(() => {
    if (optionBar === undefined || !active) return;
    optionBar.setNextStep(nextStep);
    optionBar.setCommit(commit);
    return () => {
      optionBar.setNextStep(null);
      optionBar.setCommit([]);
    };
  }, [optionBar, active, nextStep, commit]);

  useEffect(() => {
    if (optionBar === undefined || !active || extras === null) return;
    return optionBar.registerOptionSlot(slotId, extras);
  }, [optionBar, active, slotId, extras]);
}
