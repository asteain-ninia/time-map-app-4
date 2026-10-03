// FR-107 終了確認ガードの診断ログの文（`close-guard.ts` が引き、そこから再び公開する）。
//
// 診断ログのファイルにだけ書く文で、画面には出さない。だから文言の表の規則（開発ガイド §5.99）の
// 対象から外してある（`scripts/ui-text-rule.mjs` の除外の一覧）。中身は `close-guard.ts` に
// 置いていたものを一字一句そのまま移した。

/** ログ文言（診断ログに出る単一の真実源）。 */
export const CLOSE_GUARD_LOG = {
  requested: '[close-guard] 終了要求: レンダラへ未保存確認を照会します',
  acked: '[close-guard] 未保存確認の購読者を確認しました（判定を待ちます）',
  duplicate: '[close-guard] 終了要求が重複したため無視しました（未保存確認の応答待ち）',
  allowed: '[close-guard] 未保存確認が許可されたため閉じます',
  blocked: '[close-guard] 未保存確認が中止を選んだため閉じません',
  // 所見1 HIGH: ACK が来ない = 「購読者不在」か「生きているが応答不能（フリーズ）」かは
  // 区別できない。自動では閉じず、ネイティブ確認ダイアログを提示する。
  unresponsivePrompting:
    '[close-guard] レンダラが応答しない（ACK なし）ため終了確認ダイアログを提示します',
  unresponsiveQuit: '[close-guard] 応答なしの確認でユーザーが終了を選んだため閉じます',
  unresponsiveCancelled:
    '[close-guard] 応答なしの終了確認がキャンセルされたため閉じません（次の操作で再照会します）',
  unresponsiveStale:
    '[close-guard] 応答なし確認ダイアログの後着選択を無視しました（ACK 到着 / 状態変化で失効）',
  rendererReloading:
    '[close-guard] 照会中にレンダラが再読み込みを開始したため確認を中止しました（次の操作で再照会します）',
  staleVerdict: '[close-guard] 失効した終了確認の応答を無視しました',
  invalidVerdict: '[close-guard] 不正な形式の終了確認の応答を無視しました',
  rendererGone: '[close-guard] レンダラが応答不能のため未保存確認を省略して閉じます',
  // 所見3: 要求を発行した webContents 以外からの応答（sender 不一致）。単一ウィンドウの
  // 現 app では防御的措置（別 webContents が要求 ID を詐称するのを弾く）。
  senderMismatch:
    '[close-guard] 要求元と異なる webContents からの応答を無視しました（sender 不一致）',
  forceAllowed: '[close-guard] 終了確認を強制的に省略します: ',
} as const;
