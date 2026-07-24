// U41 — Japanese UI text for filter / search / errors / diagnostics (FR-115 /
// FR-118, 技術方針 5.5, ui layer).
//
// 機能宣言: 本ユニットが追加する UI 文言 (フィルター/検索の UI ラベル・ヘルプ・例示、
// エラーメッセージ、ツールチップ) を日本語で文言定数モジュールへ集約する。i18n 抽象
// レイヤ (翻訳キー解決・ロケール切替) は設けない (FR-115).
//
// 適用 (教訓 5.30「過少共有と過剰共有の両方を戒める」/ 単一の真実源): 先行ユニット U20 の
// 文言定数モジュール (src/ui/shell/strings.ts) は「シェル骨格・メニュー・ツール・モード」
// の文言を、U13/U37 等の各 messages/strings は各機能の文言を担う。本ユニットの文言は
// U20 の語彙と重複しない「発見・健全性・バリデーション」固有のものに限り、ここへ集約する
// (二重に文言モジュールを作らない)。後続ユニットは同じカテゴリ分け・命名 (XXX_STRINGS の
// const オブジェクト、キーは用途) で文言を追加できる。
//
// すべて日本語。コンポーネント・定数は本モジュールのキーを参照し、インラインのリテラルを
// 持たない (教訓 5.19).

/** Display-control (filter) UI labels, hints and examples (FR-113 / FR-118). */
export const FILTER_STRINGS = {
  /** Section heading for the feature display-control panel (地物一覧区画内)。 */
  sectionTitle: '地物の表示制御',
  sectionHelp:
    '種別・階層深度・個別地物ごとに表示/非表示を切り替え、不透明度や強調を調整できます。これらは見え方だけを変え、地物データそのものは変更しません。',
  // 種別軸 (FR-113)
  kindGroupLabel: '種別で表示',
  kindPointLabel: '点情報',
  kindLineLabel: '線情報',
  kindAreaLabel: '面情報',
  kindGroupHint: '点・線・面のうち地図に表示する種別を選びます。',
  // 階層深度軸 (FR-38)
  depthLabel: '階層深度で表示',
  depthHint:
    '指定した階層深度までの面情報のみ表示します（最上位=0、子は親+1）。空欄ですべての深度を表示します。',
  depthExample: '例: 「2」を指定すると深度0〜2の面情報だけが表示されます。',
  // 個別地物軸 (FR-113)
  individualLabel: '個別地物の表示',
  individualHideLabel: 'この地物を非表示',
  individualHint: '選んだ地物だけを個別に非表示にできます。',
  /** 「個別非表示 n 件を全て再表示」button label (n = 現在の個別非表示件数). */
  showAllHiddenLabel: (count: number): string => `個別非表示 ${count} 件を全て再表示`,
  /** Tooltip on a 通史(錨)一覧 row whose feature is hidden at the current time (FR-113). */
  hiddenListRowTitle:
    '現在の表示制御で非表示のため選択できません。表示フィルタを解除すると選択できます。',
  // 不透明度 (FR-113)
  opacityLabel: '不透明度',
  opacityHint:
    '表示中の地物の不透明度を0〜1で調整します（1で不透明、0で透明）。',
  // 強調 (FR-113)
  emphasizeLabel: '強調表示',
  emphasizeHint:
    '指定した種別・階層・地物集合を強調し、それ以外を減衰（淡く）表示します。強調は一時的な見え方で、保存対象のスタイルは変更しません。',
  /** 右クリック「強調を解除」/ 個別地物の強調解除 (対象1件). */
  emphasizeClearLabel: '強調を解除',
  /** 右クリック「この地物を強調」(individualHideLabel と対称の個別地物操作). */
  emphasizeFeatureLabel: 'この地物を強調',
  /** パネルの種別強調トグル群 (kindGroupLabel と対称). */
  emphasizeKindGroupLabel: '種別を強調',
  emphasizeKindGroupHint:
    '選んだ種別を強調し、それ以外の地物を淡く表示します。表示/非表示とは別の軸です。',
  /** 強調の脱出口 — 種別・地物のどの強調も一括で解除する (強調中のみ活性). */
  emphasizeClearAllLabel: '強調をすべて解除',
} as const;

/** Search UI labels, help and query-format examples (FR-113 / FR-118). */
export const SEARCH_STRINGS = {
  /** Menu/command label for opening search (FR-111 ツール/表示メニュー). */
  commandLabel: '地物を検索',
  panelTitle: '地物検索',
  inputLabel: '検索キーワード',
  inputPlaceholder: '名前・説明・属性で検索',
  searchButtonLabel: '検索',
  help:
    '現在の地図に表示されている地物（現在時刻に存在し、表示制御で表示状態のもの）を、名前・説明・属性値で検索します。表示されていない地物は結果に含まれません。',
  example:
    '例: 「ローマ」で名前/説明に「ローマ」を含む地物を、「都市」で種別ラベルが「都市」の地物を検索します。',
  resultsTitle: '検索結果',
  noResults: '該当する地物は表示中の範囲に見つかりませんでした。',
  /** Result row hint listing where the match was found. */
  matchedInName: '名前に一致',
  matchedInDescription: '説明に一致',
  matchedInAttribute: '属性に一致',
  /** 案内 shown when a jumped-to feature is not selectable at the current time. */
  jumpNotPresent:
    'この地物は現在時刻に存在しないため選択できません。位置のみ表示しました。時刻を変更すると選択できる場合があります。',
  /** 案内 shown when a result is no longer in the visible母集合. */
  jumpGone:
    'この地物は現在表示されていないため移動できません。表示制御や時刻を確認してください。',
} as const;

/** Validation messages — one per machine reason (FR-115 / FR-116, 教訓 5.26). */
export const VALIDATION_STRINGS = {
  emptyQuery: '検索キーワードを入力してください。',
  queryTooLong:
    '検索キーワードが長すぎます。256文字以内で入力してください。',
  opacityOutOfRange:
    '不透明度は0以上1以下の数値で指定してください。',
  depthInvalid:
    '階層深度は0以上の整数で指定してください。',
} as const;

/** Error-handling / report-hint messages (FR-115 / FR-117). */
export const ERROR_HANDLING_STRINGS = {
  /** The boundary error-boundary fallback title. */
  fallbackTitle: '表示中に問題が発生しました',
  /** The boundary error-boundary fallback body (recovery guidance). */
  fallbackBody:
    'この部分の表示を中断しました。操作をやり直しても改善しない場合は、お手数ですが開発者へ報告してください。',
  /** Suffix appended to unrecoverable/unexpected errors (FR-115). */
  reportHint: 'お手数ですが開発者へ報告してください。',
  /** Prefix for a recoverable (user-actionable) error. */
  recoverablePrefix: '入力内容を確認してください: ',
  /** Generic unexpected-error lead-in (FR-117). */
  unexpectedLead: '予期しないエラーが発生しました。',
} as const;

/** Diagnostics-view labels (FR-117 診断情報). */
export const DIAGNOSTICS_STRINGS = {
  /** Menu/command label (ヘルプメニュー). */
  commandLabel: '診断情報を表示',
  panelTitle: '診断情報',
  help:
    'アプリ内部のエラーログとアプリ概況を表示します。情報は端末内にのみ記録され、外部へ送信されません。',
  logSectionTitle: 'エラーログ（直近）',
  summarySectionTitle: 'アプリ概況',
  emptyLog: '記録されたエラーはありません。',
  /** Column / field labels for a log entry. */
  fieldRecordedAt: '記録時刻（実時間）',
  fieldContextTime: '操作時の作中時刻',
  fieldLevel: '種別',
  fieldMessage: 'メッセージ',
  fieldContext: '操作文脈',
  fieldCause: '原因',
  /** Note about privacy (FR-117 / FR-02). */
  privacyNote:
    '診断情報には個人情報やプロジェクトの内容は含めていません。外部送信も行いません。',
} as const;
