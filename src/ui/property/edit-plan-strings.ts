// 素性欄の保存の言葉（保存ボタンの出し分け・バッジ・断り）と、保存ファイルの増分の言い方。
//
// 文言の表（開発ガイド §5.99）。`EDIT_PLAN_STRINGS` は `edit-plan.ts` に置いていた表を一字一句
// そのまま移したもので、`edit-plan.ts` から同じ名前で再び公開している（読み込む側は変えない）。
// この表は何も読み込まない。

/** 画面に出す言葉（1 か所に集める、NFR 5.7 / 教訓 5.29）。 */
export const EDIT_PLAN_STRINGS = {
  /** バッジの区切り。 */
  badgeSeparator: '｜',
  noteOverwrite: (year: string): string => `${year}の錨を直します`,
  noteNewAnchor: '錨を新しく作ります',
  /**
   * **実ファイルの増分**で言う（設計書 §N-13 の書き直し）。旧版は圧縮前の JSON の量を
   * 「ファイルが約 270 KB 増えます」と出していたので、実際の 4 倍以上に見えていた。
   */
  noteNewAnchorWithCost: (bytes: string): string =>
    `錨を新しく作ります（保存ファイルが${bytes}増えます）`,
  noteFeatureAbsent: 'この年にはまだありません',
  noteFeatureEnded: 'この年にはもうありません（終わっています）',
  noteNotYearAligned: '月日の付いた年には記録を作れません',
  saveLabelOverwrite: (year: string): string => `${year}の錨を上書き保存`,
  saveLabelNewAnchor: (year: string): string => `${year}に錨を作って保存`,
  /** 押せないときのボタン文言（行き先を約束しない）。 */
  saveLabelDisabled: '保存',
  reasonFeatureAbsent: (year: string): string =>
    `${year}にはこの地物がまだありません。存在する年へ移ると保存できます。`,
  reasonFeatureEnded: (year: string): string =>
    `${year}にはこの地物はもうありません（終わっています）。存在する年へ移ると保存できます。`,
  reasonNotYearAligned: (full: string, year: string): string =>
    `いまは${full}です。錨の開始は年だけで記録するので、${year}へ丸めてから保存してください。`,
  /** 年に丸めるボタン。 */
  roundToYearLabel: (year: string): string => `${year}に丸める`,
  /** この年に錨を作る（Ctrl+K）。 */
  createAnchorHereLabel: (year: string): string => `${year}に錨を作る`,
  createAnchorHereDisabledReason: (year: string): string => `${year}にはすでに錨があります。`,
  /** 対象の地物が決まっていない（鍵盤から押したときに起きる）。 */
  createAnchorHereNoTarget: '記録を作る地物が選ばれていません。地図か一覧で 1 つ選んでください。',
  /**
   * 自分の年表を持たないまとめ役の子で「この年に錨を作る」を押したとき（バグ狩り 2-4）。
   * 記録は上位領域の年表に増えるので、どこに増えたかを言う（子のレーンには印が増えない）。
   */
  createAnchorHereInOwner: (ownerName: string, year: string): string =>
    `上位領域「${ownerName}」の年表に${year}の記録を作りました（この地物は上位領域の年表に記録されています）。`,
  /** 「読むだけ」のとき（教訓 5.13 の一括無効化に、鍵盤経路でも文字を付ける）。 */
  createAnchorHereViewOnly: 'いまは「読むだけ」です。鍵を開けると記録を作れます。',
  /**
   * 引き継ぎの予告（A1）。**押す前に、後ろのどの記録まで同じ値が入るかを見せる。**
   * 数が多いときは先頭 2 件＋残りの本数にする（ボタンの文字が窓からはみ出さない）。
   */
  carryForwardSuffix: (years: readonly string[]): string => {
    if (years.length === 0) return '';
    if (years.length <= 2) return `（${years.join('・')}の記録にも同じ値を入れます）`;
    const head = years.slice(0, 2).join('・');
    return `（${head}ほか ${String(years.length - 2)} 件の記録にも同じ値を入れます）`;
  },
  /**
   * 保存したあと、その姿がいつまで続くか（A1 の「この姿は 1500 年まで」）。
   * **この先ずっと続くときは出さない**（素性欄は幅 280px・縦も狭いので、いつも同じことを
   * 言う行で保存列を太らせない。行き先そのものはボタンの文言が言っている）。
   */
  effectRangeUntil: (year: string): string => `この姿は${year}まで続きます。`,
  /** 値が変わっていないのに保存を押させない（A6 / GPT#6）。 */
  noChangeNote: '値が変わっていません。',
  noChangeNoteWithCreateAnchor: (year: string): string =>
    `値が変わっていません。この年に錨だけ作るなら［${year}に錨を作る］を押してください。`,
} as const;

/** 概算バイト数の言い方（`edit-plan.ts` の `formatApproximateBytes`）。数の整形は呼ぶ側。 */
export const APPROX_BYTES_STRINGS = {
  unknown: '不明',
  underOneKb: '1 KB 未満',
  kb: (amount: string): string => `約 ${amount} KB`,
  mb: (amount: string): string => `約 ${amount} MB`,
} as const;
