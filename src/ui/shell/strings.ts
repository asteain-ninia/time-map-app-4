// UI layer (U20 / shell): Japanese UI text, centralised (FR-115, 技術方針 5.5).
//
// All user-visible shell text lives here as plain constants. There is NO i18n
// abstraction layer (技術方針 5.5「i18n 抽象なし方針」): the constants are
// gathered in one module so a future localisation unit (FR-7.2) has a single
// place to fork. UI components and the menu/tool/shortcut definitions reference
// these constants by key; no component hardcodes a literal string inline
// (教訓 5.19: 分岐識別子・表示文言は定数を経由する).

/** App-level / window title strings. */
export const APP_STRINGS = {
  title: 'time-map-app',
  mapAriaLabel: 'メインマップ領域',
  sidebarAriaLabel: 'サイドバー',
  toolbarAriaLabel: 'ツールバー',
  menubarAriaLabel: 'メニューバー',
  statusbarAriaLabel: 'ステータスバー',
} as const;

/** Top-level menu titles (ファイル・編集・表示・ツール・ヘルプ, FR-111). */
export const MENU_TITLES = {
  file: 'ファイル',
  edit: '編集',
  view: '表示',
  tools: 'ツール',
  help: 'ヘルプ',
} as const;

/** Menu item labels, keyed by command id (see commands.ts). */
export const MENU_ITEM_LABELS = {
  'file.new': '新規作成',
  'file.open': '開く',
  'file.save': '保存',
  'file.saveAs': '名前を付けて保存',
  'edit.undo': '元に戻す',
  'edit.redo': 'やり直し',
  'edit.delete': '削除',
  'edit.deselect': '選択解除',
  'view.toggleViewMode': '表示専用モード切替',
  'view.zoomIn': '拡大',
  'view.zoomOut': '縮小',
  'tools.settings': '設定',
  'tools.search': '地物を検索',
  'help.about': 'バージョン情報',
  'help.shortcuts': 'ショートカット一覧',
  'help.diagnostics': '診断情報',
} as const;

/** Mode toggle labels (FR-75). */
export const MODE_LABELS = {
  add: '追加モード',
  edit: '編集モード',
  view: '表示専用',
} as const;

/** Tool labels, keyed by tool id (see tools.ts). */
export const TOOL_LABELS = {
  // add-mode tools
  'add.point': '点を追加',
  'add.line': '線を追加',
  'add.area': '面を追加',
  // edit-mode tools
  'edit.select': '選択',
  'edit.vertex': '頂点編集',
  'edit.move': '地物移動',
  'edit.knife': 'ナイフ（分割）',
  'edit.reparent': '所属変更',
  'edit.merge': '結合',
  'edit.ring': '穴・飛び地',
  'edit.drill': '穴あけ',
} as const;

/** Sidebar section titles (FR-111). HB3-28: the「イベント一覧」tab is renamed to
 * 「歴史アンカー一覧（年表）」 so it is not confused with the地物一覧 — it lists each
 * feature's history anchors (its 時間軸イベント), not the features themselves. */
export const SIDEBAR_SECTION_TITLES = {
  // HB5-1 / HB5-2: shortened from「歴史アンカー一覧（年表）」and unified to the
  // domain term「錨」(要件定義書 §3.11 歴史の錨). Parallels「地物一覧」as a tab title
  // and stays distinct from the property panel's per-feature「歴史の錨」section.
  events: '錨一覧',
  features: '地物一覧',
  properties: 'プロパティ',
} as const;

/** Status bar placeholder labels. */
export const STATUS_STRINGS = {
  ready: '準備完了',
} as const;

/**
 * Sidebar list content strings (HB-3): empty-state guidance for the 地物一覧 /
 * イベント一覧 sections when the project has no features / anchors yet. Centralised
 * here (FR-115); no inline literals (教訓 5.19).
 */
export const SIDEBAR_CONTENT_STRINGS = {
  featuresEmpty: '地物がありません。地図に地物を追加すると一覧に表示されます。',
  eventsEmpty: '歴史の錨がありません。地物の履歴がここに表示されます。',
  // HB3-28: captions explaining what each list shows + how the two differ (the
  // user asked「イベント一覧と地物一覧の違いは？」). 地物一覧 = features effective at the
  // current year; 歴史アンカー一覧 = every feature's history anchors across time.
  featuresCaption: '現在の年に存在する地物の一覧です。行を選ぶとその地物を選択します。',
  eventsCaption:
    '各地物の歴史の錨（時間軸の節目）の一覧です。行を選ぶとその年へ移動し、地物を選択します。',
} as const;

/**
 * Display-control text (階層深度の集約表示・個別フォーカス, FR-42 / FR-43 / U34).
 * All Japanese, centralised here (FR-115); no inline literals (教訓 5.19).
 */
export const DISPLAY_CONTROL_STRINGS = {
  /** Section title for the depth-focus controls in the sidebar/view menu. */
  sectionTitle: '階層深度表示',
  /** Global depth slider label (FR-42). */
  globalDepthLabel: '階層深度',
  /** Hint shown beside the global depth slider. */
  globalDepthHint: '指定した階層深度までを実形状で表示し、それより下位は集約形状に丸めます',
  /** Individual focus toggle / section label (FR-43). */
  focusLabel: '個別フォーカス',
  /** Per-focus depth slider label (FR-43). */
  focusDepthLabel: 'フォーカス深度',
  /** Emphasis toggle label (FR-43 / FR-82). */
  emphasizeLabel: '縦方向領域を強調',
  /** Clear-focus action label (教訓 5.2). */
  clearFocusLabel: 'フォーカス解除',
} as const;

/** Tooltip text (操作ガイド, FR-112 / FR-115), keyed by command/tool id. */
export const TOOLTIPS: Readonly<Record<string, string>> = {
  'file.new': '新しいプロジェクトを作成します',
  'file.open': 'プロジェクトファイルを開きます',
  'file.save': '現在のプロジェクトを保存します',
  'file.saveAs': '名前を付けて保存します',
  'edit.undo': '直前の操作を取り消します',
  'edit.redo': '取り消した操作をやり直します',
  'edit.delete': '選択中の地物を削除します',
  'edit.deselect': '地物と頂点の選択を解除します',
  'view.toggleViewMode': '編集を無効にして閲覧専用にします',
  'view.zoomIn': '地図を拡大します',
  'view.zoomOut': '地図を縮小します',
  'tools.settings': 'プロジェクト設定を開きます',
  'tools.search': '名前・説明・属性で表示中の地物を検索します',
  'help.about': 'アプリの情報を表示します',
  'help.shortcuts': 'キーボードショートカットの一覧を表示します',
  'help.diagnostics': 'エラーログとアプリ概況の診断情報を表示します',
  'add.point': '地図上に点地物を追加します',
  'add.line': '地図上に線地物を追加します',
  'add.area': '地図上に面地物を追加します',
  'edit.select': '地物を選択します',
  'edit.vertex': '頂点を編集します',
  'edit.move': '地物を移動します',
  'edit.knife': '地物を分割します',
  'edit.reparent': '地物の所属を変更します',
  'edit.merge': '複数の地物を結合します',
  'edit.ring': '面に穴や飛び地を追加、または穴・領土リングを削除します',
  'edit.drill': '末端地物をくり抜いて新しい地物を生成します',
  // HB-16: the mode-toggle tooltips (mode.add / mode.edit) were removed — the
  // left toolbar's mode buttons no longer render a Tooltip (ユーザー決定 2026-06-21).
} as const;

/**
 * バージョン情報 (HB-9 / FR-111 ヘルプ). The version VALUE is injected at build time
 * (`__APP_VERSION__` from package.json) — only the static labels live here (FR-115;
 * no inline literals, 教訓 5.19).
 */
export const ABOUT_STRINGS = {
  title: 'バージョン情報',
  appName: 'time-map-app',
  versionLabel: 'バージョン',
  description: '時系列地図アプリケーション（オフライン完結）。',
  close: '閉じる',
} as const;

/**
 * ショートカット一覧 (HB-9 / FR-111 ヘルプ). The actual key labels are derived from
 * the SAME STANDARD_MENUS accelerators via formatShortcut (§4 単一の真実源) — this
 * holds only the static chrome text (FR-115).
 */
export const SHORTCUTS_STRINGS = {
  title: 'ショートカット一覧',
  commandColumn: '操作',
  keyColumn: 'ショートカット',
  empty: 'ショートカットはありません。',
  close: '閉じる',
} as const;

/** User-facing error message helpers (FR-115 / FR-117, 日本語). */
export const ERROR_STRINGS = {
  /** Generic UI error wrapper; appends the report hint (FR-117). */
  unexpected: (detail: string): string =>
    `予期しないエラーが発生しました: ${detail}\n問題が続く場合は開発者へ報告してください。`,
} as const;
