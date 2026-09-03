// UI layer (U20 / shell): 編集の結果を **1 か所** で日本語にして状態行へ渡す口（設計書 §H.5）。
//
// これまで状態行の「直前の結果」に届いていたのは **保存の成否だけ** だった。追加・編集・
// 削除・所属変更・結合・分割・穴あけ・スタイル変更・取り消し・やり直しは、すべて
// `recordCommand` という 1 本の漏斗を通っているのに、そこから結果が出ていなかったので、
// 画面は「（まだ何もしていません）」か古い保存結果のままだった（設計書 §H.5 が求める
// 「成功も失敗も映す唯一の常設の場所」になっていない）。
//
// **語彙の混在をここで解く**（開発ガイド §5.51 / 現状.md B7）。`Command.label` は
// 「人が読める名前」と称しているが、実際にはドメイン側の 4 か所が日本語
// （「所属変更」「地物の削除」「自動配色」「結合」）、UI 側の 5 か所が内部の英語
// （`edit` / `delete` / `interval` / `palette` / `unshare`）である。**混ざったまま画面に
// 出すと、たまたま日本語の経路だけ試して「大丈夫」と判断してしまう**（実機に
// 「元に戻せます: edit」と出た）。呼び出し元をいま全部書き換えるのは全コミット経路に
// 触る作業なので、**写像表を 1 か所に置いて出口で直す**。表に無い値は「編集」へ落とす
// （内部の英語を画面へ出すくらいなら、粗い日本語のほうがよい＝U-1）。
//
// 写像表は「ここが唯一の出口」であることに意味がある。新しいコマンドが増えて表に
// 載っていなければ「編集しました」と出るだけで、内部の識別子が画面に漏れることはない。

/**
 * `Command.label` → 画面に出す日本語。**キーは実際に埋められている値**であって、
 * 型やコメントの宣言ではない（§5.51: 値を見る）。
 */
const COMMAND_LABEL_JA: Readonly<Record<string, string>> = {
  // --- UI 側が内部の英語を入れている 5 か所 ---
  edit: '素性の変更',
  delete: '地物の削除',
  interval: '存続期間の変更',
  palette: '配色の変更',
  unshare: '頂点の共有解除',
  // --- ドメイン側が日本語を入れている 4 か所（そのまま通すが、表に載せて所在を示す） ---
  所属変更: '所属変更',
  地物の削除: '地物の削除',
  自動配色: '自動配色',
  結合: '結合',
};

/** 表に無い label のときに出す、粗いが日本語の言い方。 */
const FALLBACK_LABEL_JA = '編集';

/**
 * `Command.label` を画面に出せる日本語にする。**内部の英語は絶対に外へ出さない**
 * （表に無ければ「編集」へ落とす）。
 */
export function commandLabelJa(label: string | null | undefined): string {
  if (label === null || label === undefined) return FALLBACK_LABEL_JA;
  return COMMAND_LABEL_JA[label] ?? FALLBACK_LABEL_JA;
}

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
