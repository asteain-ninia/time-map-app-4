// UI layer (U20 / shell): Japanese UI text, centralised (FR-115, 技術方針 5.5).
//
// All user-visible shell text lives here as plain constants. There is NO i18n
// abstraction layer (技術方針 5.5「i18n 抽象なし方針」): the constants are
// gathered in one module so a future localisation unit (FR-7.2) has a single
// place to fork. UI components and the menu/tool/shortcut definitions reference
// these constants by key; no component hardcodes a literal string inline
// (教訓 5.19: 分岐識別子・表示文言は定数を経由する).

/**
 * App-level / window title strings. アプリの正式名称は **gimoza**（`time-map-app-4` は
 * 開発時のコードネームで、利用者には見せない — 現状.md B3）。
 *
 * ⚠️ 実際のウィンドウタイトルは `src/ui/index.html` の `<title>` が決める（BrowserWindow に
 * `title` オプションを渡していないため、ページのタイトルがそのまま出る）。この定数を変えても
 * ウィンドウタイトルは動かないので、名前を変えるときは index.html も一緒に直すこと。
 */
export const APP_STRINGS = {
  title: 'gimoza',
  /**
   * 止めている間に押された打鍵の断り文（増分 3 / 現状.md B28）。**押しても何も
   * 起きない**を無くすためのもので、「何が起きたか → なぜか → 次に何をするか」の順
   * （設計書 §H.5）。
   */
  /**
   * 増分 3: 吸着して既存の頂点を共有したときの「直前の結果」（設計書 §H.5）。
   * 「地物を追加した」だけでは、**境界がつながったのかどうか**が読み取れない。
   */
  addedWithSharedVertices: (count: number): string =>
    `地物を追加しました（既存の頂点 ${String(count)} 個を共有し、境界がつながりました）`,
  /**
   * 増分 3 の手直し A1: 共有した頂点を動かすと、**次にその頂点が本当に動く記録まで**
   * 前へ引き継ぐ。何年の記録に効いたかを言わないと、利用者は「この年しか直っていない」と
   * 思い込む（設計書 §H.5 は結果を過去形で言い切り、副次的な結果を丸括弧で添える書式）。
   */
  vertexCarriedForward: (fromYear: number, toYear: number, count: number): string =>
    `${String(fromYear)}年の頂点の移動を、${String(toYear)}年以降の記録 ${String(count)} 件にも反映しました`,
  /**
   * 増分 3 の手直し A5: 1 回の移動で経度を半周以上動かした（技術方針 §6.8 / N-51）。
   * 追加の道具が断るのと同じ規則を、編集にも効かせたときの文。
   */
  editRefusedLongDrag:
    'この移動は世界を半周以上します。もっと小さく動かしてください（1 辺で経度 180 度以上は保存できません）。',
  /** 増分 3 の手直し A6: 緯度 ±90 度の外（北極の上・南極の下）には場所が無い。 */
  editRefusedOutsideWorld:
    'そこは世界の外です（北緯 90 度より上・南緯 90 度より下には置けません）。地図の中へ動かしてください。',
  shortcutBusy: (label: string): string =>
    `「${label}」はいま使えません。確認に答えてから、もう一度押してください。`,
  mapAriaLabel: 'メインマップ領域',
  /**
   * 「必ず描く」が働いたときの知らせ（増分 4 / 設計書 §D.6 の規則 2・§H.5）。
   * **黙って特別扱いしない** ―― 旧版は「一覧から選ぶとカメラは飛ぶのに地図には
   * 何も描かれない」が何も言わずに起きていた（C10）。
   */
  forcedDraw: (name: string, depth: number | null): string =>
    depth === null
      ? `${name}はいまの表示条件では描かれないので、選んでいるあいだだけ地図に描いています。`
      : `${name}は深さ ${String(depth)} にあります。深さを変えずに見えるよう、選んでいるあいだだけ地図に描いています。`,
  sidebarAriaLabel: 'サイドバー',
  /** 右パネルの 2 区画の仕切り（増分 4。掴んで上下に動かせる）。 */
  sidebarSplitterAriaLabel: '地物一覧と選んだ地物の仕切り',
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
  'edit.createAnchorHere': 'この年に錨を作る',
  'view.toggleViewMode': '表示専用モード切替',
  'view.zoomIn': '拡大',
  'view.zoomOut': '縮小',
  'view.fitAll': '全体表示',
  'tools.addFace': '面を描く',
  'tools.settings': '設定',
  // 増分 4 の手直し F3: 行き先が「一覧の絞り込み欄」になったので、名前も実態に合わせる。
  'tools.search': '一覧で絞り込む',
  'tools.jump': 'どこへでも移動',
  'list.bundlePrev': '前のまとまりの地物へ',
  'list.bundleNext': '次のまとまりの地物へ',
  'list.rename': '一覧で名前を直す',
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

/** Sidebar section titles (FR-111). HB6: the former 地物一覧 / 錨一覧 tabs are unified
 * into ONE「一覧」tab with a 現在時刻 / 通史 mode toggle (ユーザー GO 済) — so the sidebar
 * is now「一覧」+「プロパティ」の2タブ構成. The two list modes (現在時刻=現在の年に存在
 * する地物 = 旧地物一覧, 通史=全時刻の錨 = 旧錨一覧) live inside the one list panel. */
export const SIDEBAR_SECTION_TITLES = {
  // 増分 4: 画面の第一表記を設計書 §H.1 に合わせた（台帳 → 地物一覧、素性欄 → 選んだ地物）。
  // 排他タブをやめて上下 2 区画を同時に出すので、見出しは「いま何の区画か」を言い切る。
  list: '地物一覧',
  properties: '選んだ地物',
} as const;

/**
 * 状態行の文言（設計書 §C.8 / §H.6 の 5 枠）。**枠の幅は固定で、中身が空でも枠は残る**
 * ので、「出すものが無い」ときの文字もここに置く（空文字にすると枠が消えたように見える）。
 */
export const STATUS_STRINGS = {
  /** 何も渡されていない状態行の既定（スロット未結線のときだけ出る）。 */
  ready: '準備完了',
  /** 地図の外にカーソルがあるとき（設計書 §H.6 の表）。 */
  coordsAway: '—',
  /** 直前の結果がまだ無いとき。 */
  noResult: '（まだ何もしていません）',
  dismissResult: 'この結果を閉じる',
  /** 元に戻す枠。操作名が取れるときは「元に戻せます: ◯◯（Ctrl+Z）」まで出す。 */
  undoUnavailable: '元に戻す: 不可',
  undoAvailable: '元に戻す: 可 Ctrl+Z',
  undoAvailablePrefix: '元に戻せます: ',
  undoShortcutSuffix: '（Ctrl+Z）',
  /** 最終保存枠。 */
  lastSavedPrefix: '最終保存 ',
  neverSaved: '未保存',
  /**
   * 最終保存枠の断り書き（A4-a）。自動保存は上書きする先を利用者が一度確認するまで
   * 本体ファイルに書かない。**書いていないことを黙っていると**「5 分ごとに保存されて
   * いるはず」という誤解のまま作業が進むので、短く出す（詳しい説明は title 属性）。
   */
  autoSaveHold: '（自動保存は待機中）',
  autoSaveHoldDetail: '自動保存は、上書きする先を一度確認してから始まります。',
} as const;

/**
 * アプリバーの素性表示（設計書 §H.6）: 世界名・ファイル名・未保存の印。
 * どのファイルを開いているのかが **常に見える** ようにするためのもので、
 * 「保存したつもりが別のファイルだった」型の事故を構造的に減らす。
 */
export const APP_IDENTITY_STRINGS = {
  ariaLabel: '開いている世界とファイル',
  /** 保存先が決まっていない新規。 */
  unsavedNew: '（未保存の新規）',
  /**
   * 読み込みは成功したのに、保存先を確定する通信に失敗したとき。**「（未保存の新規）」と
   * 出してはいけない** — 読み込んだはずのファイルが無かったことにされたように見える。
   * 次の 保存 は「名前を付けて保存」になる（行き先を改めて聞く）。
   */
  destinationUndetermined: '保存先: 未確定',
  /** 未保存の印の読み上げ名（見た目は ● の 1 文字）。 */
  dirtyTitle: '未保存の変更があります',
} as const;

/**
 * オプションバー（設計書 §C.4）の既定文言。道具が何も押し込んでいないときに出る。
 * 「（選んでいません）」は対象欄 240px が 0 件でも枠を保つための文字（K-3）。確定欄は
 * 文字を置かず、空の 176px として残す（設計書 §B.4）。
 */
export const OPTION_BAR_STRINGS = {
  ariaLabel: 'オプションバー',
  defaultToolName: '✦ 選ぶ',
  noTarget: '（選んでいません）',
  // 「台帳」は内部語。画面の第一表記は「地物一覧」（設計書 §H.1）。
  defaultNextStep: '地図か地物一覧から選ぶ',
  noSettings: '（設定なし）',
} as const;

/**
 * 編集モードの 8 つの道具の文言（オプションバーの道具名 112px と 対象欄 240px）。
 *
 * **書き方は追加の道具に揃えた**（`ui/add/strings.ts` の `toolNameFace: '▱ 面を描く'`）:
 * 記号 1 文字 ＋ 半角空白 ＋ 短い動詞句。12px の文字なので全角 4 文字＋記号でも
 * 112px（＝全角 9 文字ぶん）に収まる。語そのものは設計書 §C.4 の表の呼び名を使う
 * （「選ぶ」「頂点」「分ける」「所属」「結ぶ」「輪郭」「穴あけ」）。表に載っていない
 * 「地物移動」だけは、同じ調子で「動かす」と名付けた。
 *
 * **文言はここに置き、ToolId との対応表は `tools.ts` に置く**。`tools.ts` は道具の
 * 語彙（`TOOL_ID`）とモードごとの顔ぶれを持つ単一の場所なので、道具を足したときに
 * 名前の付け忘れがコンパイルエラーになる（`ui/property/messages.ts` が
 * `PROPERTY_STRINGS` と `FEATURE_KIND_JA` を分けているのと同じ形）。
 */
export const EDIT_TOOL_STRINGS = {
  /**
   * 「選ぶ」は帯の既定の道具名と同じ語である（道具を持っていないときの帯は
   * 「選ぶ」を出す）。**同じ文言を 2 か所に書かない**ため定数を参照する（教訓 5.29）。
   */
  select: OPTION_BAR_STRINGS.defaultToolName,
  vertex: '◇ 頂点',
  move: '✥ 動かす',
  knife: '✂ 分ける',
  reparent: '⇄ 所属',
  merge: '∪ 結ぶ',
  ring: '◎ 輪郭',
  drill: '⊙ 穴あけ',

  /**
   * 対象欄（240px）。設計書 §C.4 の例「アアウェン州（面・州）」の書式 ―― 名前のうしろに
   * 丸括弧で種類を添える。種類の日本語は素性欄と同じ `featureKindJaLabel` から取る
   * （面＝末端地物／線＝線情報／点＝点情報／集約＝集約地物。写像表を新しく作ると
   * 同じ値の呼び名が画面の 2 か所で割れる＝教訓 5.29）。
   */
  target: (name: string, kind: string): string => `${name}（${kind}）`,
  /**
   * 種別ラベル（FR-40。「州」「島国」など利用者が付ける自由な語）が付いているときは
   * 設計書の例どおり「・」で足す。付いていない地物のほうが多いので、上の 2 項目版と
   * 分けてある（空の「・」が残らない）。
   */
  targetWithKindLabel: (name: string, kind: string, kindLabel: string): string =>
    `${name}（${kind}・${kindLabel}）`,
  /**
   * **複数を相手にする道具**（結ぶ）の対象欄。1 件目の説明のうしろに、残りが何件あるかを
   * 添える（「アアウェン州（末端地物・州） ほか 2 件」）。何件選んだのかが読めないと、
   * 結合してから「1 つ入れ忘れていた」に気づくことになる。
   *
   * 1 件のときはこれを使わず名前だけを出す ―― 「ほか 0 件」は読み手を戸惑わせる
   * （教訓 5.18: 空の枝は文言のほうで畳む）。
   */
  targetWithMore: (first: string, rest: number): string =>
    `${first} ほか ${String(rest)} 件`,
} as const;

/**
 * 右パネルの中身が使う文言。
 *
 * **増分 4 で大半がここから消えた。** 一覧の文言（空状態・見出し・絞り込み・件数・
 * モードの名前・通史の行）は、一覧そのものが `ui/discovery` へ移ったので
 * `LEDGER_STRINGS` が持つ（画面に出ない文言を定数表へ残さない＝`docs/現状.md` B38）。
 * ここに残るのは、素性欄まわりで **shell 側が出す** 3 つだけである。
 */
export const SIDEBAR_CONTENT_STRINGS = {
  /** 系列の持ち主の名前が引けなかったときの言い方（内部 id は画面に出さない、U-1）。 */
  unknownOwnerName: '別の地物',
  /** 一覧のその場編集が対象を解決できないとき（G-23 の共通枠へ出す）。 */
  quickEditNoTarget: 'この年にはその地物が居ないので直せません。',
  /** 一覧のその場編集が、その年には保存できないとき。 */
  quickEditNotSavable: 'この年には保存できません。',
} as const;

/**
 * Display-control text (階層深度の集約表示・個別フォーカス, FR-42 / FR-43 / U34).
 * All Japanese, centralised here (FR-115); no inline literals (教訓 5.19).
 */
export const DISPLAY_CONTROL_STRINGS = {
  /** Section title for the depth-focus controls in the sidebar/view menu. */
  // 用語は設計書 §H.1 に合わせる（2026-09-05、増分 4 の手直し F3）:
  // 階層深度 → 深さ／個別フォーカス・深掘り → この地物の上下だけ見る／
  // 縦方向領域 → 出さない。**内部語をそのまま画面へ出さない**（U-1 / N-30）。
  sectionTitle: '深さの表示',
  /** Global depth slider label (FR-42). */
  globalDepthLabel: '深さ',
  /** Hint shown beside the global depth slider. */
  globalDepthHint: '指定した深さまでを実際の形で表示し、それより下は親にまとめて表示します',
  /** Individual focus toggle / section label (FR-43). */
  focusLabel: 'この地物の上下だけ見る',
  /** Per-focus depth slider label (FR-43). */
  focusDepthLabel: 'この地物の深さ',
  /** Emphasis toggle label (FR-43 / FR-82). */
  emphasizeLabel: '目立たせる',
  /** Clear-focus action label (教訓 5.2). */
  clearFocusLabel: 'やめる',
  /**
   * 深掘り button placeholder while NOTHING is selected (第6工程 B2). The focus group
   * is ALWAYS rendered at a constant width — controls disable, never disappear — so
   * the 上部バー's occupied width cannot depend on the selection (a selection-driven
   * re-wrap of the menu-bar row used to shift the whole map cell 28px).
   */
  focusNoTargetLabel: '地物を選ぶと使えます',
  /** Title/hint for the disabled 深掘り button (why it is disabled). */
  focusNoTargetHint: '地物を選ぶと、その地物の上下だけを別の深さで見られます',
  /** 深さの ＋ / − ボタンの読み上げ名（画面には記号しか出ない）。 */
  globalDepthDownLabel: '深さを下げる',
  globalDepthUpLabel: '深さを上げる',
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
  'view.fitAll': '現在の年に存在する全地物が収まる視点に戻します',
  'tools.settings': 'プロジェクト設定を開きます',
  'tools.search': '地物一覧の絞り込み欄へ移動します（名前・種別で絞り込めます）',
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
  appName: 'gimoza',
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
