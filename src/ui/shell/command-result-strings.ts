// 状態行に出す「何をしたか」の言葉（操作名と、結果の定型文）。
//
// 文言の表（開発ガイド §5.99）。`COMMAND_LABEL_TEXT` は `command-result.ts` の写像表
// （`Command.label` → 日本語）の値、`RESULT_STRINGS` は `command-result.ts` に置いていた表を
// 一字一句そのまま移したもの（`command-result.ts` から同じ名前で再び公開している）。
// この表は何も読み込まない。

/** 操作名（「元に戻せます」「◯◯を行いました」に入る名詞句）。 */
export const COMMAND_LABEL_TEXT = {
  // --- UI 側（`UI_COMMAND_LABEL` の全件） ---
  edit: '素性の変更',
  add: '地物の追加',
  split: '分割',
  drill: '穴あけ',
  merge: '結合',
  affiliation: '所属変更',
  delete: '地物の削除',
  interval: '存続期間の変更',
  palette: '配色の変更',
  unshare: '頂点の共有解除',
  // 「◯◯を行いました」に繋いだときに日本語として読める名詞句にする（増分 4 の手直し F3）。
  editOverwrite: 'その年の錨の書き換え',
  editNewAnchor: 'その年に錨を作る記録',
  createAnchor: 'この年に錨を作る記録',
  // 輪郭の道具（増分 5 の手直し E3）。「リング」は内部語なので §H.1 の第一表記「穴・飛び地」で言う。
  ringAdd: '穴・飛び地の追加',
  ringDelete: '穴・飛び地の削除',
  bulkKindLabel: 'まとめての種別付け',
  // --- ドメイン側が日本語を入れている 4 か所（そのまま通す） ---
  domainAffiliation: '所属変更',
  domainDeleteFeature: '地物の削除',
  domainRecolor: '自動配色',
  domainMerge: '結合',
  /** 表に無い label のときに出す、粗いが日本語の言い方。 */
  fallback: '編集',
} as const;

/** 状態行に出す結果の定型文（「何をしたか」を過去形で言い切る）。 */
export const RESULT_STRINGS = {
  /**
   * 編集が通った。対象の名前が分かるときは添える。**「◯◯を行いました」の形にする**のは、
   * 操作名が名詞（「素性の変更」「地物の削除」）だからで、「◯◯しました」と繋ぐと
   * 「素性の変更しました」のような日本語にならない文になる。
   */
  done: (labelJa: string, targetName?: string | null): string =>
    targetName === null || targetName === undefined || targetName === ''
      ? `${labelJa}を行いました`
      : `${targetName}: ${labelJa}を行いました`,
  /** 取り消した。 */
  undone: (labelJa: string): string => `元に戻しました: ${labelJa}`,
  /** やり直した。 */
  redone: (labelJa: string): string => `やり直しました: ${labelJa}`,
  /** 削除（対象の名前つき）。削除だけは「何を消したか」を必ず名指しする。 */
  deleted: (targetName: string | null): string =>
    targetName === null || targetName === '' ? '削除しました' : `${targetName}を削除しました`,
} as const;
