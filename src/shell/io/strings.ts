// Electron の本体側（ファイルの読み書き）の利用者向けの文（FR-115）。
//
// 文言の表（開発ガイド §5.99）。本体側は画面側（`src/ui/**`）を読み込めないので、本体側の
// 文はここに置く。何も読み込まない。数の計算（`Math.floor(...)` など）は呼ぶ側に残す。

export const SHELL_IO_STRINGS = {
  // --- .gimoza の読み取り（tmap.ts） ---
  fileTooLarge: (mb: number): string => `ファイルが大きすぎます（上限 ${mb} MB）。`,
  entryTooLarge: (name: string, mb: number): string =>
    `エントリ ${name} が大きすぎます（上限 ${mb} MB）。`,
  totalTooLarge: (mb: number): string => `展開後の合計サイズが大きすぎます（上限 ${mb} MB）。`,
  missingEntry: (entry: string): string => `必須エントリ ${entry} が見つかりません。`,

  // --- 読み込み（load.ts） ---
  readFailed: 'ファイルの読み込みに失敗しました。',

  // --- 設定のファイル（app-prefs.ts） ---
  prefsWriteFailedDetail: (message: string): string => `（${message}）`,
  prefsWriteFailed: (detail: string): string =>
    `設定をファイルに書き込めませんでした${detail}。値は変えていません。`,
} as const;
