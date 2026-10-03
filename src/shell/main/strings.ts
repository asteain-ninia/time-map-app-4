// Electron の本体側（主プロセス）の利用者向けの文（FR-115）。
//
// 文言の表（開発ガイド §5.99）。本体側は画面側（`src/ui/**`）を読み込めないので、本体側の
// 文はここに置く（OS のダイアログ・保存要求の断り・読み込みの断り）。何も読み込まない。
// 数の計算（`Math.floor(...)` など）は呼ぶ側に残し、ここでは埋め込むだけにする。

export const SHELL_MAIN_STRINGS = {
  // --- 応答が無いときの OS の確認ダイアログ（index.ts） ---
  unresponsiveCancel: 'キャンセル',
  unresponsiveQuit: '終了する',
  unresponsiveTitle: 'アプリが応答していません',
  unresponsiveMessage: 'アプリが応答していません。',
  unresponsiveDetail: '未保存の変更があれば失われる可能性があります。終了しますか？',

  // --- 読み込み・世代（ipc-handlers.ts） ---
  readFailed: 'ファイルの読み込みに失敗しました。',
  unknownBackup:
    'その世代は一覧に見つかりませんでした。もう一度「以前の保存から開く」から選んでください。',
  backupGone:
    '選んだ世代のファイルが見つかりませんでした（一覧を出したあとで消されたか、名前が変わったようです）。いま開いている内容はそのままです。',
  fileTooLarge: (mb: number): string => `ファイルが大きすぎます（上限 ${mb} MB）。`,

  // --- 保存要求の点検（ipc-handlers.ts の validateSaveRequest） ---
  saveRequestInvalid: '保存要求の形式が不正です。',
  baseMapTooLarge: '背景地図画像が大きすぎるため保存できません。',
  attachmentNameInvalid: (name: string): string => `添付資産名が不正です: ${name}`,
  attachmentNameTooLong: (head: string): string => `添付資産名が長すぎます: ${head}…`,
  attachmentTooLarge: (name: string): string => `添付資産 ${name} が大きすぎるため保存できません。`,
  saveDataInvalid: '保存データが検証に失敗しました。お手数ですが開発者へ報告してください。',
  manifestTooLarge: 'プロジェクトデータが大きすぎるため保存できません。',
  projectTooLarge: 'プロジェクト全体のサイズが大きすぎるため保存できません。',
  saveFailed: (detail: string): string => `保存に失敗しました: ${detail}`,

  // --- 設定（ipc-handlers.ts） ---
  prefsWriteRefused: '設定を書き込めませんでした。',
} as const;
