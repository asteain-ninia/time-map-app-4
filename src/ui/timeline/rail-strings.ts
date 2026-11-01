// UI layer (U21 / 時刻レール): レールの画面の言葉（設計書 §C.7 / §H.4 / §I.2）。
//
// **文言は 1 か所に置く**（教訓 5.64: 画面の言葉を検査に直書きすると、言い換えのたびに
// 検査だけが古い言葉のまま残る）。E2E も単体もここを引く。
//
// **用語は §H.1 の「画面の第一表記」に揃える**（2026-09-07 の手直し）。錨レーンの
// 第一表記は **歴史の帯**、その中の 1 本の記録が **歴史の錨** である ―― 旧版はレーンの
// 読み上げ名に「歴史の錨」を使っていて、器と中身が同じ名前になっていた。

/** 表示範囲の幅を読める単位で言う（設計書 §C.7 の (a) の右端）。 */
export function railSpanNote(days: number, pixelLength: number): string {
  if (days <= 0 || pixelLength <= 0) return '';
  const perPx = days / pixelLength;
  return `いま画面いっぱいで${spanText(days)}ぶん（1px ≒ ${perPixelText(perPx)}）`;
}

/** 1 年の日数のならし（`rail-ticks.ts` と同じ値）。 */
const DAYS_PER_YEAR = 365.2425;
/** 1 月の日数のならし。 */
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;

/**
 * 幅の文。**深く拡大したら単位を月・日へ落とす**（2026-09-07 の手直し）。
 * 旧版は年に固定していたので、1 年より狭くすると「0年ぶん（1px ≒ 0.00年）」になって
 * 何も読めなかった。
 */
function spanText(days: number): string {
  if (days >= DAYS_PER_YEAR) {
    const years = days / DAYS_PER_YEAR;
    return `${years >= 10 ? Math.round(years).toLocaleString('ja-JP') : years.toFixed(1)}年`;
  }
  if (days >= DAYS_PER_MONTH) return `${(days / DAYS_PER_MONTH).toFixed(1)}か月`;
  return `${days < 10 ? days.toFixed(1) : String(Math.round(days))}日`;
}

/** 1 画素あたりの文（同じく単位を落とす）。 */
function perPixelText(daysPerPx: number): string {
  if (daysPerPx >= DAYS_PER_YEAR) {
    const years = daysPerPx / DAYS_PER_YEAR;
    return `${years >= 1 ? Math.round(years).toLocaleString('ja-JP') : years.toFixed(2)}年`;
  }
  if (daysPerPx >= 1) return `${daysPerPx.toFixed(1)}日`;
  return `${(daysPerPx * 24).toFixed(1)}時間`;
}

export const RAIL_STRINGS = {
  /** レール全体の読み上げ名（§H.1 の第一表記）。 */
  railLabel: '時刻レール',
  /** 錨レーンの読み上げ名。§H.1 の第一表記は **歴史の帯**。 */
  laneLabel: '選んでいる地物の歴史の帯',
  /** 空状態その 1（何も選んでいない。設計書 §B.4「淡い 1 行」）。 */
  laneEmptyNoSelection: '地物を選ぶと、その歴史がここに出ます',
  /**
   * 空状態その 2（設計書 §H.4。**実データがまさにこれ**）。選んではいるが、
   * 歴史の節目が時間軸の左端にしか無い。
   */
  laneEmptyOnlyOrigin:
    'まだ歴史の節目が 0 年にしかありません。年を動かしてから直すと、その年の記録がここに印で増えます。',
  /**
   * 空状態その 3（2026-09-07 の手直し）。選んでいるのに **記録が 1 本も無い**
   * （集約地物の下位領域で、その子に関わる錨が親の系列に 1 本も無いとき）。
   */
  laneEmptyNoAnchors: 'この地物の記録はまだありません',
  /** 集約地物の下位領域を選んでいるときの断り（設計書 §C.6）。 */
  laneInheritedPrefix: 'この地物の歴史は親の',
  laneInheritedSuffix: 'が持っています',

  /** 目盛りの単位（U-27。**消さない**）。 */
  ticksUnit: '単位: 年',
  /** つまみ（目盛り行そのもの）の読み上げ名。**既存の名前を変えない**（T-1）。 */
  sliderLabel: '時間軸スライダー',
  /** 再生ヘッドの読み上げ名。 */
  playheadLabel: '現在の年',

  // --- 操作列（(d)） ---
  /** 送りの読み上げ名。**単位（年・月・日）に追従する**（2026-09-07 の手直し）。 */
  stepBackLabel: (amount: number, unitLabel: string): string =>
    `${String(amount)}${unitLabel}前へ戻る`,
  stepForwardLabel: (amount: number, unitLabel: string): string =>
    `${String(amount)}${unitLabel}次へ進む`,
  jumpLabel: 'ジャンプ',
  jumpFieldTitle: '直接ジャンプ',
  zoomInLabel: 'レールを拡大',
  zoomOutLabel: 'レールを縮小',
  zoomFitLabel: 'レールを全体表示',
  zoomMenuLabel: '拡大',
  prevAnchorLabel: '前の歴史の錨へ',
  nextAnchorLabel: '次の歴史の錨へ',
  overflowLabel: '≫',
  overflowAriaLabel: '入りきらない時間の操作',
  /** 錨ジャンプのボタンの `title`（読み上げ名に、押すキーを添える）。 */
  prevAnchorTitle: (label: string): string => `${label}（[）`,
  nextAnchorTitle: (label: string): string => `${label}（]）`,
  /** 錨ジャンプのボタンの文字。 */
  prevAnchorButton: '◀錨',
  nextAnchorButton: '錨▶',
  /** 拡大 3 ボタンの文字。 */
  zoomOutButton: '−',
  zoomInButton: '＋',
  zoomFitButton: '全体',

  /** ステップ単位（年・月・日）の選択肢の文字。 */
  unitYear: '年',
  unitMonth: '月',
  unitDay: '日',
  unitCaption: 'ステップ単位',
  unitAriaLabel: 'ステップ単位',
  unitTitle: '前へ/次へ で動かす時間の単位',
  /** ±1 の送りの文字。**現行のまま**（HB-13 が固定している）。 */
  stepBackText: '前へ',
  stepForwardText: '次へ',
  /** 年の欄の読み上げ名（「直接ジャンプ 年」）と、欄の右の単位。 */
  jumpFieldYearLabel: (title: string): string => `${title} 年`,
  yearUnit: '年',

  /** 月日 ▾（直接ジャンプの月日）。**読み上げ名は現行のまま**。 */
  ymdLabel: '月日',
  ymdAriaLabel: '直接ジャンプの月日',
  ymdMonthCaption: '月',
  ymdDayCaption: '日',
  jumpFieldMonthLabel: (title: string): string => `${title} 月`,
  jumpFieldMonthUnsetLabel: (title: string): string => `${title} 月 未指定`,
  jumpFieldDayLabel: (title: string): string => `${title} 日`,
  jumpFieldDayUnsetLabel: (title: string): string => `${title} 日 未指定`,
  ymdSpecified: '指定',
  ymdUnspecified: '未指定',

  /** 再生。**可視テキスト「再生」と読み上げ名「再生」を残す**（HB-13）。 */
  playLabel: '再生',
  pauseLabel: '一時停止',
  playTitle: '時間を自動で進めます（Space）',
  pauseTitle: '自動進行を一時停止します（Space）',
  speedCaption: '再生速度',
  speedAriaLabel: '再生速度',
  speedTitle: '自動進行の速さ(1倍 = 1年/秒)',
  /** 速度の選択肢の数のうしろ（「2倍」の「倍」）。 */
  speedTimesSuffix: '倍',

  // --- 状態行へ出す断り（中身 6・7。§H.5「何が起きたか → なぜか → 次に何をするか」） ---
  /** 範囲外の年を打ったとき（**丸めない**）。 */
  outOfRange: (year: string, min: string, max: string): string =>
    `${year}へは移動していません。時刻レールの範囲は${min}〜${max}です。範囲を広げるか、範囲の中の年を入れてください。`,
  /**
   * 送りが端を越えたとき（決定 (4)、2026-09-07）。**端まで動かして、そう言う。**
   * 直接打った年（意図が明確）は動かさずに断るが、送りは「その向きへ進む」意図なので
   * 端で止めるほうが素直である。
   */
  stepClampedTo: (edge: string): string =>
    `時刻レールの端の${edge}へ移動しました。これより先はありません。範囲を広げるには設定を開いてください。`,
  /**
   * **すでに端に居るとき**（2026-09-07 の最終手直し）。旧版はここでも「端の 0 年へ
   * 移動しました」と言っていたが、**1 年も動いていない**ので画面が嘘をつく
   * （教訓 5.18: 値を偽らない）。
   */
  alreadyAtEdge: (edge: string): string =>
    `すでに時刻レールの端の${edge}です。これより先はありません。範囲を広げるには設定を開いてください。`,
  /** 前後の錨が無いとき（`[` `]` が端で止まる）。 */
  noPreviousAnchor:
    'これより前に歴史の錨はありません。次の錨へは ] で移動できます。',
  noNextAnchor: 'これより後に歴史の錨はありません。前の錨へは [ で移動できます。',
  /** 地物を選んでいないのに錨ジャンプを押したとき。 */
  noSelectionForAnchorJump: '地物を選ぶと、その歴史の錨のあいだを移動できます。',
  /** 戻れる年が無いとき（Alt+←）。 */
  noBackHistory: '戻れる年がありません。年を動かすと、ここへ戻れるようになります。',
  /** 年の欄が空のとき。 */
  emptyYear: '年が空です。移動する年を数字で入れてください。',
  /**
   * 移動できたときの知らせ（2026-09-07 の手直し）。**断りを引っ込めるために出す** ――
   * 状態行は時間では消えないので、断りのあとに成功しても断りが残り続けていた。
   */
  movedTo: (label: string): string => `${label}へ移動しました。`,

  // --- 束の吹き出し（逃げ道 2） ---
  /** 「1200年付近・12 件」。 */
  bundleTitle: (year: string, count: number): string =>
    `${year}付近・${String(count)} 件`,
  bundleOpenList: 'この範囲の錨を一覧で見る',
  bundleClose: '閉じる',

  // --- 右クリック（設計書 §I.3 の「時刻レールの錨の印」「時刻レールの空白」） ---
  menuJumpToAnchor: 'この錨へ移動',
  menuChangeAnchorStart: 'この錨の開始年を変える',
  menuDeleteAnchor: 'この錨を消す',
  menuJumpHere: 'この年へ移動',
  menuCreateAnchorHere: 'この年に錨を作る',
  menuMakeLeftEdge: 'ここを表示範囲の左端にする',
  menuFitAll: '全体表示',
  /** 親の系列から借りている印（集約地物の下位領域を選んでいるとき）。 */
  menuReasonInherited: (owner: string): string =>
    `この錨は上位領域「${owner}」の記録です。上位領域を選んでから直してください。`,
  menuReasonSoleAnchor: '最後の 1 本の錨は消せません（地物が年表から消えてしまうため）。',
  menuReasonViewOnly: '読むだけのあいだは直せません。鍵を開けてください。',
  menuReasonNoSelection: '地物を選ぶと、その年に錨を作れます。',
  menuReasonAnchorExists: 'すでにこの年に錨があります。',
} as const;
