// UI layer (U20 / shell): **Escape の階段**（設計書 §D.4。増分 5c）。
//
// 「Esc を連打すれば必ず素の状態に戻れる」という一貫した出口を作る。階段は
// **いま画面のいちばん前にあるものから閉じる**順で、`focusOwner` の順序と同じにして
// ある（2 つの規定が食い違わないように＝設計書 §O の GPT B-04）。
//
//     確認／作業ダイアログ・右クリックメニュー   → 閉じる      （focusOwner = modal）
//       ↓ 無ければ
//     ポップオーバー・頂点の候補一覧             → 閉じる      （popover）
//       ↓ 無ければ
//     文字入力欄・その場編集に焦点               → 欄から抜ける （text）
//       ↓ 無ければ
//     描きかけの頂点がある                       → 1 つ取り消す （tool-drawing）
//       ↓ 無ければ
//     手順の対象を掴んでいる                     → 対象を離す（道具は持ったまま）
//       ↓ 無ければ
//     頂点を選んでいる                           → 頂点の選択を解除
//       ↓ 無ければ
//     地物を選んでいる                           → 選択を解除（U-5）
//       ↓ 無ければ
//     道具が「選ぶ」以外                         → 「選ぶ」道具に戻る
//
// **上の 5 段はそれぞれの部品が自分で受ける**（板・ポップオーバー・入力欄・道具の
// コントローラが捕捉段の Escape を持ち、`stopPropagation` で下へ流さない）。この
// module が決めるのは **残りの 3 段**、つまり大域の `edit.deselect` が押されたときに
// 「頂点を外すのか・地物を外すのか・道具を戻すのか」である。
//
// **なぜ 1 度に全部やらないのか**: 旧実装の `clearSelection()` は頂点と地物を同時に
// 空にしていた。頂点を 3 つ選んで「やっぱり地物だけ選んだ状態に戻したい」ときに
// 戻り道が無く、選び直しになる。階段にすると 1 段ずつ戻れる。
//
// **なぜ純関数なのか**: 「次に何が起きるか」を DOM 無しで固定できるようにするため
// （教訓 5.41）。実際に状態を書き換えるのは呼び出し側（`App.tsx`）である。

/** Escape が次に起こすこと。 */
export const ESCAPE_STEP = {
  /** 頂点の選択だけを外す（地物の選択は残す）。 */
  ClearVertices: 'clear-vertices',
  /** 地物の選択を外す（U-5）。 */
  ClearFeature: 'clear-feature',
  /** 道具を「選ぶ」へ戻す（＝ 何も構えていない状態）。 */
  ResetTool: 'reset-tool',
  /** もう戻るところが無い（素の状態）。 */
  None: 'none',
} as const;

export type EscapeStep = (typeof ESCAPE_STEP)[keyof typeof ESCAPE_STEP];

export interface EscapeLadderInput {
  /** 頂点を 1 つ以上選んでいる。 */
  readonly hasVertexSelection: boolean;
  /** 地物を選んでいる。 */
  readonly hasActiveFeature: boolean;
  /** 「選ぶ」以外の道具を構えている。 */
  readonly hasNonSelectTool: boolean;
}

/**
 * 階段の次の 1 段（設計書 §D.4 の下から 3 段）。**上から順に 1 つだけ**返す。
 */
export function nextEscapeStep(input: EscapeLadderInput): EscapeStep {
  if (input.hasVertexSelection) return ESCAPE_STEP.ClearVertices;
  if (input.hasActiveFeature) return ESCAPE_STEP.ClearFeature;
  if (input.hasNonSelectTool) return ESCAPE_STEP.ResetTool;
  return ESCAPE_STEP.None;
}

/**
 * その状態で Escape に意味があるか（コマンドの `canRun`）。**意味が無いときは
 * 灰色にする** ―― メニューに出ていて押しても何も起きない、を作らない（「出るなら
 * 起きる」）。
 */
export function escapeHasWork(input: EscapeLadderInput): boolean {
  return nextEscapeStep(input) !== ESCAPE_STEP.None;
}
