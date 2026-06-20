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
