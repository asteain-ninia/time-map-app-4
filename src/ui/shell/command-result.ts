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
 * UI 側が `Command.label` に入れる内部の識別子の **全件**。ここが唯一の定義箇所で、
 * 確定経路（`consistency-binding.ts` の 6 つの束ね・パレット・共有解除・削除・存続期間）が
 * ここから取る。**直書きしない** — 直書きすると下の写像表に載らない値が生まれ、画面に
 * 「編集」としか出なくなる（教訓 5.51 / 5.19）。
 *
 * **なぜ経路ごとに分けるのか**: 以前は追加・分割・穴あけ・結合・所属変更・素性の変更が
 * すべて共通の `makeCommand` を通り、揃って `'edit'` を入れていた。そのため面を 1 つ
 * 追加しただけで状態行に「素性の変更を行いました」と出て、**何をしたのかが読み取れなかった**
 * （実データで確認）。
 */
export const UI_COMMAND_LABEL = {
  /** 素性（名前・年代・色）の変更。 */
  Edit: 'edit',
  /** 地物の追加。 */
  Add: 'add',
  /** ナイフによる分割。 */
  Split: 'split',
  /** 穴あけ（深掘り）。 */
  Drill: 'drill',
  /** 地物どうしの結合。 */
  Merge: 'merge',
  /** 所属（上位領域）の変更。 */
  Affiliation: 'affiliation',
  /** 地物の削除。 */
  Delete: 'delete',
  /** 存続期間（開始年・終了年）の変更。 */
  Interval: 'interval',
  /** 既定配色・カスタムパレットの変更。 */
  Palette: 'palette',
  /** 頂点の共有解除。 */
  Unshare: 'unshare',
  /**
   * 素性の保存が **その年の錨を上書き** したとき（増分 2）。以前は上書きも新設も
   * 同じ「素性の変更」で、**画面の年に何が起きたのか読み取れなかった**。
   */
  EditOverwrite: 'editOverwrite',
  /** 素性の保存が **その年に錨を新しく作った** とき（増分 2）。 */
  EditNewAnchor: 'editNewAnchor',
  /** 値を変えずに「この年に錨を作る」（Ctrl+K, 増分 2 の中身 3）。 */
  CreateAnchor: 'createAnchor',
} as const;

export type UiCommandLabel = (typeof UI_COMMAND_LABEL)[keyof typeof UI_COMMAND_LABEL];

/**
 * `Command.label` → 画面に出す日本語。**キーは実際に埋められている値**であって、
 * 型やコメントの宣言ではない（§5.51: 値を見る）。UI 側は上の
 * {@link UI_COMMAND_LABEL} が全件、ドメイン側は各コマンド module の定数が全件で、
 * `command-result.test.ts` が **両方を走査して** 漏れが無いことを守る。
 */
const COMMAND_LABEL_JA: Readonly<Record<string, string>> = {
  // --- UI 側（内部の英語。UI_COMMAND_LABEL の全件がここに載る） ---
  [UI_COMMAND_LABEL.Edit]: '素性の変更',
  [UI_COMMAND_LABEL.Add]: '地物の追加',
  [UI_COMMAND_LABEL.Split]: '分割',
  [UI_COMMAND_LABEL.Drill]: '穴あけ',
  [UI_COMMAND_LABEL.Merge]: '結合',
  [UI_COMMAND_LABEL.Affiliation]: '所属変更',
  [UI_COMMAND_LABEL.Delete]: '地物の削除',
  [UI_COMMAND_LABEL.Interval]: '存続期間の変更',
  [UI_COMMAND_LABEL.Palette]: '配色の変更',
  [UI_COMMAND_LABEL.Unshare]: '頂点の共有解除',
  // 「◯◯を行いました」に繋いだときに日本語として読める名詞句にする
  // （2026-09-05、増分 4 の手直し F3。旧: 「その年への錨の新設を行いました」
  // 「この年の錨づくりを行いました」＝ §H.5 の「過去形で言い切る」から外れていた）。
  [UI_COMMAND_LABEL.EditOverwrite]: 'その年の錨の書き換え',
  [UI_COMMAND_LABEL.EditNewAnchor]: 'その年に錨を作る記録',
  [UI_COMMAND_LABEL.CreateAnchor]: 'この年に錨を作る記録',
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
