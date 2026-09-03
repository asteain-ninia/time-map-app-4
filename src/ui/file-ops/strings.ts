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

/** The load-time consistency auto-repair UI (FR-106). */
export const REPAIR_STRINGS = {
  title: '読み込みデータの不整合',
  /** Intro shown above the per-inconsistency list. */
  intro: '読み込んだデータに次の不整合が見つかりました。各項目の修復方法を選んでください。',
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
  /** Field labels for one inconsistency row. */
  fieldTime: '作中時刻',
  fieldRange: '時間範囲',
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
