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
  /** Hint shown under the project tab clarifying the save context (教訓 5.36). */
  projectScopeHint:
    'これらの設定はプロジェクトごとに保存されます（変更すると未保存状態になります）。',
  /** Hint shown under the app tab clarifying the save context (教訓 5.36). */
  appScopeHint: 'これらの設定はアプリ全体に適用され、どのプロジェクトでも共通です。',
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

/** App-wide field labels (FR-110). */
export const APP_FIELD_STRINGS = {
  snapDistancePx: '共有頂点スナップ距離 (px)',
  renderFps: '描画更新頻度 (FPS)',
  vertexMarkerCap: '全頂点マーカー表示上限',
  undoStackSize: 'アンドゥ履歴の上限',
  showConflictGuide: '重なり解決画面の使い方を表示する',
} as const;
