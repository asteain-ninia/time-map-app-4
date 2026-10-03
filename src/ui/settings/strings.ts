// UI layer (U38 / settings): Japanese UI text for the settings dialog, centralised
// (FR-115 / NFR 5.7, 技術方針 5.5「i18n 抽象なし方針」).
//
// Every user-visible string the settings dialog shows lives here as a plain
// constant; no component hardcodes a literal inline (教訓 5.19: 表示文言・分岐識別子
// は定数を経由する). Validation rejection messages are produced from a single map so
// the dialog UI and the confirm-entry validation (which can be hit without the UI)
// return the SAME Japanese reason (教訓 5.26). A future localisation unit (FR-7.2)
// forks this single module — there is no i18n abstraction layer.

/** Dialog chrome: title, tab labels, action buttons. */
export const SETTINGS_STRINGS = {
  /** Dialog title. */
  title: '設定',
  /** Tab label for project-specific settings (FR-109). */
  tabProject: 'プロジェクト設定',
  /** Tab label for app-wide settings (FR-110). */
  tabApp: 'アプリ全体設定',
  /** 増分 8D: 保存とバックアップの節（G-5）。 */
  tabBackup: '保存とバックアップ',
  /** Hint shown under the project tab clarifying the save context (教訓 5.36). */
  projectScopeHint:
    'これらの設定はプロジェクトごとに保存されます（変更すると未保存状態になります）。',
  /** Hint shown under the app tab clarifying the save context (教訓 5.36). */
  appScopeHint: 'これらの設定はアプリ全体に適用され、どのプロジェクトでも共通です。',
  /**
   * K-6「読むだけ」の告知（教訓 5.13 / 5.36）。プロジェクト設定は保存ファイルの中身
   * なので、表示専用モードの間は 1 件も変更できない。入力を disabled にするだけだと
   * 「なぜ押せないのか」が画面から読み取れず、利用者は壊れたと受け取る（過去に同じ
   * 形で「押せないボタン」の問い合わせが出ている）ので、理由と戻り方を必ず添える。
   * アプリ全体設定は所有者裁定どおり変更できるので、その旨も同じ 1 文に入れる。
   */
  projectReadOnlyHint:
    '「読むだけ」の間はプロジェクト設定を変更できません（アプリ全体設定は変更できます）。変更するには 追加 か 編集 のモードへ切り替えてください。',
  /** Save / apply button (確定). */
  save: '保存',
  /** Cancel button: discards all draft state (教訓 5.2). */
  cancel: 'キャンセル',
  /** Close (×) button label. */
  close: '閉じる',
} as const;

/** Project-specific field labels (FR-109). */
export const PROJECT_FIELD_STRINGS = {
  projectName: 'プロジェクト名',
  projectDescription: '説明',
  equatorLengthKm: '赤道長 (km)',
  flattening: '扁平率',
  timelineMinYear: 'タイムライン最小年',
  timelineMaxYear: 'タイムライン最大年',
  // FR-13 グリッド ON/OFF切替 (受け入れ基準 9).
  gridVisible: 'グリッドを表示',
  gridSpacingDeg: 'グリッド間隔',
  gridColor: 'グリッド色',
  gridOpacity: 'グリッド不透明度',
  baseMapId: 'ベースマップ',
  areaLabelOccupancyThreshold: '面情報ラベル表示閾値（画面占有率）',
  newAreaAutoColorDefault: '新規面の自動配色を既定で有効にする',
  defaultPaletteTheme: '既定パレットテーマ',
  customPalette: 'カスタムパレット',
  // FR-10 zoom-limit inputs (provided by U39; range 0.1×..10000×, min ≤ max).
  zoomMin: '最小ズーム倍率',
  zoomMax: '最大ズーム倍率',
} as const;

/** Base-map controls (FR-04 / FR-109; replacement runs through the host runner). */
export const BASEMAP_STRINGS = {
  /** Button that hands the replacement request to the host (起動点のみ). */
  replace: 'ベースマップを差し替え…',
  /**
   * Note clarifying the FR-04 contract: only the image is swapped — the current
   * projection / range (正距円筒メタ) is kept, so features stay aligned. Unreadable
   * images are rejected and the current map is kept.
   */
  note: '同一投影・範囲を前提に画像のみを差し替えます（PNG / JPEG）。読み込めない画像は適用されません。',
} as const;

/** Custom-palette management controls (FR-109 / FR-102). */
export const PALETTE_STRINGS = {
  add: '色を追加',
  remove: '削除',
  empty: 'カスタムパレットは空です。',
} as const;

/**
 * 「保存とバックアップ」の節（増分 8D / 設計書 G-5・FR-108、V12 の合格条件④）。
 * 自動保存の間隔と残す世代の数。アプリ全体に効く（どのプロジェクトでも同じ）。
 */
export const BACKUP_SETTINGS_STRINGS = {
  hint: 'これらの設定はアプリ全体に効きます（どのプロジェクトでも共通）。［適用］ですぐに効きます。',
  interval: '自動保存の間隔（分）',
  generations: '残す世代の数',
  apply: '適用',
  applied: '適用しました。',
  intervalInvalid: '自動保存の間隔は 1〜120 分の整数で入れてください。',
  generationsInvalid: '残す世代の数は 1〜100 の整数で入れてください。',
  /** いまの世代の数（V14 の入口）。 */
  generationCount: (sourceName: string, count: number): string =>
    `${sourceName} の世代はいま ${String(count)} 個あります（ファイル →「以前の保存から開く」で戻せます）。`,
  generationNone: '戻せる世代はまだありません。保存するたびに 1 世代ずつ残ります。',
  generationLoading: '世代を数えています…',
  generationUnavailable: '世代の数を読めませんでした。',
  /** 自動保存がいつ動くか（静かに待機していることを先に言う。状態行の断り書きと同じ趣旨）。 */
  autoSaveNote:
    '自動保存は、保存先が決まっていて上書きを一度確かめたファイルにだけ、変更があるときに書きます。',
} as const;

/** App-wide field labels (FR-110). */
export const APP_FIELD_STRINGS = {
  snapDistancePx: '共有頂点スナップ距離 (px)',
  renderFps: '描画更新頻度 (FPS)',
  vertexMarkerCap: '全頂点マーカー表示上限',
  undoStackSize: 'アンドゥ履歴の上限',
  showConflictGuide: '重なり解決画面の使い方を表示する',
  showFirstRunGuide: '起動時にこの画面の使い方を表示する',
} as const;
