// UI layer (U39): centralised Japanese text for the file-operation UI (FR-115 /
// NFR 5.7). Every user-visible string the file-ops flows show lives here as a
// constant; no component / handler hardcodes a literal inline (教訓 5.19). A
// future localisation unit forks this single module (no i18n abstraction layer).

/** The unsaved-changes warning dialog (FR-107, 3 択). */
export const UNSAVED_STRINGS = {
  title: '未保存の変更があります',
  /** Body shown above the three choices. */
  body: '変更が保存されていません。どうしますか？',
  /** 保存: save (necessarily 名前を付けて保存 when no path), then continue on success. */
  save: '保存して続行',
  /** 保存せず続行: discard and continue. */
  discard: '保存せずに続行',
  /** キャンセル: abort, keep current state. */
  cancel: 'キャンセル',
  /**
   * 「保存して続行」で **どのファイルへ書くのか**（A3）。この枝は 開く / 新規 /
   * ドラッグ＆ドロップ / × / Alt+F4 / OS シャットダウン の 6 経路すべてが通るのに、
   * これまで行き先を一度も見せていなかった。上書き確認と同じことを、押す前に見せる。
   */
  destinationLabel: '保存先',
  /** 保存先がまだ決まっていない（押すと「名前を付けて保存」になる）。 */
  destinationUndetermined: '未確定（名前を付けて保存になります）',
} as const;

/**
 * 上書き保存の確認（設計書 §H.6 / 実装計画 増分 1 の中身 3）。
 *
 * **Ctrl+S は確認なく読み込み元を上書きしていた**（V12）。実データのフル版と間引き版を
 * 取り違えたまま保存する事故は、これが原因で起きる（開発ガイド §5.48 の再発防止の UI 側）。
 * このセッションでそのファイルへ初めて上書きするときだけ、行き先の名前を見せて聞く。
 * 2 回目からは聞かない（毎回聞くと確認が儀式になり、読まずに押すようになる）。
 */
export const OVERWRITE_STRINGS = {
  title: '上書き保存の確認',
  /** 行き先のファイル名を必ず含める（何を上書きするのかが分からないと確認の意味がない）。 */
  body: (fileName: string): string => `${fileName} に上書き保存します。よろしいですか？`,
  /** 行き先のフルパス（同名ファイルの取り違えはここでしか見分けられない）。 */
  pathLabel: '保存先',
  confirm: '上書き保存する',
  cancel: 'やめる',
  /** 状態行に出す結果（成功）。 */
  saved: (fileName: string): string => `保存しました（${fileName}）`,
  /** 状態行に出す結果（利用者がやめた）。 */
  cancelled: '保存をやめました。ファイルは変わっていません。',
  /** 状態行に出す結果（保存できなかった）。 */
  failed: '保存できませんでした。書き込み先が使えるか確かめてください。',
  /**
   * 状態行に出す結果（保存できなかった・main が理由を返したとき）。**OS の警告ボックスは
   * 出さない**（同じ失敗を 2 か所で知らせていた＝設計書 §H.5「唯一の常設の場所」に反する）。
   */
  failedWith: (reason: string): string =>
    `保存できませんでした: ${reason} 書き込み先が使えるか確かめてください。`,
  /**
   * 状態行に出す結果（確認の間に保存先が変わったので中止した = A2）。**確認した先と
   * 別のファイルへ書くくらいなら、何もしないほうがよい。**
   */
  destinationChanged:
    '保存先が変わったので中止しました。もう一度 保存 を実行して、行き先を確かめてください。',
  /**
   * 状態行の「最終保存」枠に出す静かな断り書き（A4-a）。自動保存は上書き先を利用者が
   * 確認するまで本体ファイルに書かない。黙って書かないと「5 分ごとに保存されている
   * はず」という誤解のまま作業が進むので、短く出しておく。
   */
  autoSaveHold: '自動保存は待機中',
  /** 上の短い表示に添える説明（吹き出し／title 属性）。 */
  autoSaveHoldDetail: '自動保存は、上書きする先を一度確認してから始まります。',
} as const;

/**
 * 保存の直前に、年をまたぐ所属の食い違いを見せて聞く板（増分 7 の手直し 2 回目 / B67）。
 * **保存を止めて行き止まりにしない**ので、［このまま保存する］で書ける。書いたファイルは
 * 次に開くときに読み込みの修復を聞かれる（それを先に言う）。
 */
export const PRE_SAVE_STRINGS = {
  title: '保存の前の確認',
  intro:
    '次の地物は、年によって所属の記録が食い違っています。このまま保存すると、次に開くときに修復を聞かれます。',
  /** 行が多いときの畳み（先頭の数行だけ見せる）。 */
  more: (count: number): string => `ほか ${String(count)} 件`,
  /**
   * 次に開くと修復の板が出て、各行の先頭（既定）の方法は上の各行の「→」に書いたとおりに
   * その区間だけを直す（増分 7 の手直し 3 回目 1-3。全部の年から消す方法は既定にしていない）。
   */
  confirm: 'このまま保存する（次に開くと、上の「→」のとおりに直せます）',
  cancel: 'やめる',
} as const;

/** The load-time consistency auto-repair UI (FR-106). */
export const REPAIR_STRINGS = {
  title: '読み込みデータの不整合',
  /**
   * Intro shown above the per-inconsistency list.
   *
   * 増分 8D: 直し方が 1 つしか無い行はラジオを出さなくなったので、「各項目の修復方法を
   * 選んでください」は事実と合わなくなった（選ぶ行は一部だけ）。挙動に合わせて直した
   * （言い回しの総点検は増分 8E）。
   */
  intro: '読み込んだデータに次の不整合が見つかりました。それぞれの直し方を確かめてください。',
  /** 直し方が 1 つしか無い行の頭（増分 8D / N-22）。 */
  fixLabel: 'こう直します: ',
  /** 直し方が 2 つ以上ある行の見出し（増分 8D。行ごとに冒頭の説明文を繰り返さない）。 */
  chooseLegend: '直し方を選んでください',
  /** Apply the chosen repairs and continue loading. */
  apply: '修復して読み込む',
  /** Abort: do not load (修復せず読み込まない). */
  abort: '読み込みを中止',
  /** Shown when a repair did not fully resolve the data (受け入れ基準 3 末項). */
  unresolved: '選択した修復ではすべての不整合を解消できませんでした。別の方法を選んでください。',
  /**
   * Final notice when even the SECOND repair attempt could not make the data
   * consistent (or the retry was cancelled): the load is aborted rather than
   * silently loading inconsistent data (FR-106 / 教訓 5.22 確定までドメインを破壊しない).
   */
  abortedUnresolved:
    '不整合を解消できなかったため、読み込みを中止しました。データは変更されていません。',
  /**
   * 「そのまま残す」を選んで読み込んだ（2026-10-04、B39 の再検証 3-1 と戻しの再検証のガード）。
   * 記録は何も変えていない。次に開くときにもう一度聞くことと、子を持つ面の整え方を言う
   * （所属の道具は、存在期間の違う親子では断るので、整え方としては言わない）。
   * `discarded` が 1 以上なら、捨てた記録の件数も同じ 1 文に入れる（状態行は置き換えなので、
   * 2 回に分けると先の知らせが消える）。
   */
  kept: (count: number, discarded = 0): string =>
    `修復して読み込みました。${
      discarded > 0
        ? `同じ年に別の記録があった古い記録 ${String(discarded)} 件は、地物自身の年表の記録を残して捨てました。`
        : ''
    }記録を変えずにそのまま残したもの ${String(count)} 件は、次に開くときにもう一度聞きます（子を持つ面は「直轄領を生成」を選ぶと整えられます）。`,
  /**
   * 修復で捨てた記録の件数（「各地物に自分の年表を作って残す」で、同じ年に自分の年表の記録と
   * 食い違っていた古い記録）。状態行に出す（黙って捨てない）。
   */
  discarded: (count: number): string =>
    `修復して読み込みました。同じ年に別の記録があった古い記録 ${String(count)} 件は、地物自身の年表の記録を残して捨てました。`,
  /** Field labels for one inconsistency row. */
  fieldTime: '作中時刻',
  fieldRange: '時間範囲',
} as const;

/**
 * 「以前の保存から開く」の世代の一覧（増分 8D / 設計書 §E.1 の V14 の手順 (a)）。
 * 保存のたびに保存ファイルの隣へ残る世代を、日時・大きさ・地物数で並べて選ばせる。
 */
export const BACKUP_LIST_STRINGS = {
  title: '以前の保存から開く',
  /** 一覧の上の 1 文。どのファイルの世代かを必ず出す（同名の取り違えを防ぐ）。 */
  intro: (sourceName: string): string =>
    `${sourceName} を保存したときの世代です。選ぶと、その時点の内容を開きます。`,
  /** 開いたあとどうなるかを先に言う（保存先にはならない）。 */
  note: '開いた内容は元のファイルを上書きしません。最初の保存は「名前を付けて保存」になります。',
  /** 世代が 1 つも無いとき。 */
  empty: '戻せる世代はまだありません。保存するたびに 1 世代ずつ残ります。',
  /**
   * どのファイルの世代を見ればよいか分からないとき（増分 8D の手直し）。新規のとき・元の
   * ファイルが壊れて開けなかったとき。「無い」とは言わない（隣に世代が残っていることがある）。
   */
  noBasis: '開いているファイルがありません。元のファイルを選ぶと、その世代を一覧します。',
  /** 元のファイルを主プロセスのダイアログで選ばせるボタン。 */
  pickSource: '元のファイルを選ぶ…',
  /** 一覧が出ているときに、別のファイルの世代へ選び直す（増分 8D の再手直し）。 */
  pickOther: '別のファイルを選ぶ…',
  columnSavedAt: '保存した日時',
  columnSize: '大きさ',
  columnFeatures: '地物数',
  /** 地物数が読めなかった世代。 */
  unknownFeatures: '—',
  /** 地物数をまだ数えている世代（増分 8D の手直し。一覧を先に出し、後から埋める）。 */
  countingFeatures: '…',
  /** 地物数の表示。 */
  features: (count: number): string => `${String(count)} 件`,
  /** 行のボタンの読み上げ名（押すと開く）。 */
  openRow: (savedAt: string): string => `${savedAt} の世代を開く`,
  cancel: 'やめる',
} as const;

/** File-operation rejection / failure notices (FR-115; 通知文言). */
export const FILE_OPS_STRINGS = {
  /** 読み込み失敗 (read/corrupt). 開発者へ報告 suffix per FR-115 where useful. */
  readFailed: 'ファイルの読み込みに失敗しました。',
  corrupt: 'ファイルが壊れているため読み込めませんでした。',
  /** 保存失敗 notice. */
  saveFailed: 'ファイルの保存に失敗しました。',
  /** Generic developer-report suffix (FR-115). */
  reportSuffix: '問題が続く場合は開発者へ報告してください。',
} as const;

/** 件数つきの方法の文（{@link repairOptionText}）。 */
export const REPAIR_OPTION_TEXT = {
  dropOrphanHistoryWithCount: (members: number): string =>
    members === 0
      ? '持ち主の居ない、中身の無い歴史を読み込みから除外します。'
      : `持ち主の居ない歴史（中に ${String(members)} 件の地物の記録）を、中身ごと読み込みから除外します（中の地物も消えます）。`,
} as const;

/** 読み込みの修復の板（`repair-flow.ts`）。対象の呼び方と、細かい理由の組み立て。 */
export const REPAIR_FLOW_TEXT = {
  /** 「種類（対象: …）」。 */
  describe: (label: string, target: string): string => `${label}（対象: ${target}）`,
  /** 対象の名前を並べるときの区切り。 */
  listSeparator: '、',
  historyOf: (label: string): string => `${label}の歴史`,
  unknownNameTarget: '名前の分からない地物',
  orphanEmpty: '持ち主の居ない、中身の無い歴史',
  orphanMore: (rest: string): string => ` ほか ${rest} 件`,
  orphanWithMembers: (shown: string, more: string): string =>
    `持ち主の居ない歴史（中の地物: ${shown}${more}）`,
  unnamedCount: (count: string): string => `名前のない地物 ${count} 件`,
  unknownCount: (count: string): string => `名前の分からない地物 ${count} 件`,
  missingVertices: (count: string): string => `存在しない頂点を ${count} 個参照しています。`,
  vertexDiverges: '同じ頂点の座標が歴史によって違います。',
  duplicateHistories: (count: string): string => `同じ地物の歴史が ${count} 本あります。`,
} as const;

/** 不整合の細かい理由（`repair-flow.ts` の `DETAIL_TEXT`。`detail` の固定の符号ごと）。 */
export const REPAIR_DETAIL_TEXT = {
  topLevelMismatch: '最上位かどうかの印と、親の有無が食い違っています。',
  cycle: '親をたどると自分に戻ってきます。',
  danglingParent: '親として指している地物が見つかりません。',
  childParentMismatch: '下位領域の一覧と、各地物が指している親が食い違っています。',
  duplicateId: '同じ地物が複数あります。',
  leafEmptyShape: '形がありません。',
  aggregateNoChildren: '下位領域が 1 つもありません。',
  leafWithChildren: '末端なのに下位領域を持っています。',
  positiveAreaOverlap: '面積のある重なりがあります。',
  interChildGap: '下位領域どうしのあいだに隙間があります。',
  sameTimeSpatialConflict: '同じ時刻に重なっています。',
  ownerFeatureAbsent: 'この歴史の持ち主の地物が、どの年にも居ません。',
} as const;

/** 不整合の種類の名前（`repair-flow.ts` の `INCONSISTENCY_LABELS`）。 */
export const INCONSISTENCY_LABEL_TEXT = {
  missingVertexReference: '存在しない頂点参照',
  treeTopology: '階層（ツリー）構造の不整合',
  shapePreservation: '形状保持規則の違反',
  ringHierarchyInvalid: 'リング階層（領土と穴の入れ子関係・包含）の不整合',
  terminalExclusion: '末端地物の重なり',
  aggregateSumMismatch: '集約と下位領域の和の不一致',
  timeConflict: '時間（錨列）の矛盾',
  anchorSpatialOverlap: '同時刻の地物どうしの空間的重なり',
  orphanHistory: '所有地物が存在しない孤立した歴史',
  duplicateOwnerHistory: '同一地物を所有する歴史の重複',
  vertexCoordinateDivergence: '共有頂点の座標が歴史間で食い違っている',
} as const;

/** 修復方法の文の言い換え（`repair-flow.ts` の `REPAIR_OPTION_TEXT_OVERRIDES`）。 */
export const REPAIR_OPTION_OVERRIDE_TEXT = {
  reconcileChildIds: '集約地物の下位領域の一覧を、各地物が指している親に合わせて作り直します。',
} as const;

/** 画面に出す言葉（教訓 5.19）。設計書 §F の G-10 の文に合わせる。 */
export const BASEMAP_ASPECT_STRINGS = {
  title: '背景地図の縦横比',
  question: (ratio: string): string => `この画像は ${ratio} です。2:1 に補正しますか、このまま使いますか。`,
  explainCorrectable:
    '地図は横が縦の 2 倍（2:1）で描きます。補正すると、画像の足りない側に余白を足して 2:1 にします（画像そのものは縮めません）。このまま使うと、地図に合わせて引き伸ばされます。',
  questionUncorrectable: (ratio: string): string =>
    `この画像は ${ratio} です。2:1 から離れすぎているため補正できません。このまま使いますか。`,
  explainUncorrectable: '地図は横が縦の 2 倍（2:1）で描くので、このまま使うと大きく歪みます。',
  /**
   * 補正すると地図の上で何が起きるか（増分 8E の手直し。反証 2-4）。余白を足すので、絵は
   * 地図の中で縮んで描かれ、絵に合わせて描いてあった地物とは端へ行くほど合わなくなる。
   * 地物の座標そのものは動かない。`axis` は絵が縮んで見える向き（横に足りない画像なら横）。
   */
  explainCorrectShift: (axis: string): string =>
    `余白を足すので、絵は${axis}方向に縮んで見え、地図の端の地物と合わなくなることがあります。`,
  axisHorizontal: '横',
  axisVertical: '縦',
  correct: '2:1 に補正する',
  keep: 'このまま使う',
  cancel: 'やめる',
  /** 状態行（何が起きたか）。 */
  appliedCorrected: '背景地図を差し替えました（余白を足して 2:1 に補正しました）。',
  appliedKept: (ratio: string): string =>
    `背景地図を差し替えました（縦横比 ${ratio} のまま。地図に合わせて引き伸ばして描きます）。`,
  applied: '背景地図を差し替えました。',
  cancelled: '背景地図の差し替えをやめました。地図は変わっていません。',
  correctFailed: '画像を 2:1 に補正できませんでした。差し替えを中止しました。地図は変わっていません。',
} as const;

/** ズームの上限・下限の断り（`zoom-limit.ts` の `ZOOM_LIMIT_REJECTION`）。数は呼ぶ側で整える。 */
export const ZOOM_LIMIT_TEXT = {
  notANumber: '数値を入力してください。',
  outOfRange: (floor: string, ceil: string): string =>
    `ズーム倍率は ${floor} 倍から ${ceil} 倍の範囲で入力してください。`,
  order: '最小ズーム倍率は最大ズーム倍率以下にしてください。',
} as const;

/** 背景地図に使えない画像を選んだとき（`basemap-replace.ts`）。 */
export const BASEMAP_REPLACE_TEXT = {
  rejectNotice:
    '選択した画像をベースマップとして読み込めませんでした（対応形式は PNG / JPEG、寸法・容量の上限内）。差し替えを中止しました。',
} as const;

/** 以前の保存の一覧（`BackupListDialog.tsx`）。 */
export const BACKUP_LIST_TEXT = {
  bytes: (count: string): string => `${count} バイト`,
} as const;

/** 修復の板の時間の欄（`RepairDialog.tsx`）。 */
export const REPAIR_DIALOG_TEXT = {
  rangeScope: (field: string, start: string, end: string): string => `${field}: ${start} 〜 ${end}`,
} as const;
