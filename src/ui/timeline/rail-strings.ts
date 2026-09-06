// UI layer (U21 / 時刻レール): レールの画面の言葉（設計書 §C.7 / §H.4 / §I.2）。
//
// **文言は 1 か所に置く**（教訓 5.64: 画面の言葉を検査に直書きすると、言い換えのたびに
// 検査だけが古い言葉のまま残る）。E2E も単体もここを引く。

/** 表示範囲の読み取り（(a) の右端）。 */
export function railSpanNote(years: number, yearsPerPixel: number): string {
  const span = years >= 10 ? Math.round(years).toLocaleString('ja-JP') : years.toFixed(1);
  const perPx =
    yearsPerPixel >= 1
      ? Math.round(yearsPerPixel).toLocaleString('ja-JP')
      : yearsPerPixel.toFixed(2);
  return `いま画面いっぱいで${span}年ぶん（1px ≒ ${perPx}年）`;
}

export const RAIL_STRINGS = {
  /** レール全体の読み上げ名。 */
  railLabel: '時刻レール',
  /** 錨レーンの読み上げ名。 */
  laneLabel: '選んでいる地物の歴史の錨',
  /** 空状態その 1（何も選んでいない。設計書 §B.4「淡い 1 行」）。 */
  laneEmptyNoSelection: '地物を選ぶと、その歴史がここに出ます',
  /**
   * 空状態その 2（設計書 §H.4。**実データがまさにこれ**）。選んではいるが、
   * 歴史の節目が 0 年にしか無い。
   */
  laneEmptyOnlyOrigin:
    'まだ歴史の節目が 0 年にしかありません。年を動かしてから直すと、その年の記録がここに印で増えます。',
  /** まとめ役の子を選んでいるときの断り（設計書 §C.6）。 */
  laneInheritedPrefix: 'この地物の歴史は親の',
  laneInheritedSuffix: 'が持っています',

  /** 目盛りの単位（U-27。**消さない**）。 */
  ticksUnit: '単位: 年',
  /** つまみ（目盛り行そのもの）の読み上げ名。**既存の名前を変えない**（T-1）。 */
  sliderLabel: '時間軸スライダー',
  /** 再生ヘッドの読み上げ名。 */
  playheadLabel: '現在の年',

  // --- 操作列（(d)） ---
  step100BackLabel: '100年前へ戻る',
  step100ForwardLabel: '100年次へ進む',
  step10BackLabel: '10年前へ戻る',
  step10ForwardLabel: '10年次へ進む',
  jumpLabel: 'ジャンプ',
  jumpFieldTitle: '直接ジャンプ',
  zoomInLabel: 'レールを拡大',
  zoomOutLabel: 'レールを縮小',
  zoomFitLabel: 'レールを全体表示',
  zoomMenuLabel: '拡大',
  prevAnchorLabel: '前の錨へ',
  nextAnchorLabel: '次の錨へ',
  overflowLabel: '≫',
  overflowAriaLabel: '入りきらない時間の操作',

  // --- 状態行へ出す断り（中身 6・7） ---
  /** 範囲外の年を打ったとき（**丸めない**）。 */
  outOfRange: (year: string, min: string, max: string): string =>
    `${year}は時間軸の範囲（${min}〜${max}）の外です。移動していません。範囲を広げるか、範囲の中の年を入れてください。`,
  /** 送りが端に当たったとき。 */
  stepClamped: (edge: string): string =>
    `時間軸の端（${edge}）です。これ以上は動かせません。`,
  /** 前後の錨が無いとき（`[` `]` が端で止まる）。 */
  noPreviousAnchor: 'これより前に錨はありません。',
  noNextAnchor: 'これより後に錨はありません。',
  /** 地物を選んでいないのに錨ジャンプを押したとき。 */
  noSelectionForAnchorJump: '地物を選ぶと、その錨のあいだを移動できます。',

  // --- 束の吹き出し（逃げ道 2） ---
  /** 「1200年付近・12 件」。 */
  bundleTitle: (year: string, count: number): string =>
    `${year}付近・${String(count)} 件`,
  bundleOpenList: 'この範囲の錨を一覧で見る',
  bundleClose: '閉じる',
} as const;
