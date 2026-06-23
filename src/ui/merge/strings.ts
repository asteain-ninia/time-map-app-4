// U30 — merge-tool (合体 / 結合) UI strings (FR-50 / FR-52 / FR-92).
//
// All user-facing strings for the merge controller live here so the UI layer never
// embeds bare literals in JSX (教訓 5.19) and the copy is a single source.

export const MERGE_STRINGS = {
  /** Guide while collecting targets (fewer than 2 chosen). */
  guideSelect: '結合する地物を 2 つ以上クリックで選択してください。',
  /** Guide once 2+ targets are chosen (confirm is enabled). */
  guideReady: '「結合を確定」で選択した地物を 1 つに結合します。',
  /** Confirm button label (opens the options dialog, FR-52). */
  confirm: '結合を確定',
  /** Clear-selection button label. */
  clear: '選択をクリア',
  /** Cancel button label. */
  cancel: 'キャンセル',
} as const;

export type MergeStringKey = keyof typeof MERGE_STRINGS;

// --- FR-52 結合オプションダイアログ (上位領域・プロパティ選択) の文言 -----------
//
// All dialog copy lives here so the options modal never embeds bare literals
// (教訓 5.19) and the wording is testable from one source.
export const MERGE_OPTIONS_STRINGS = {
  /** Dialog title (FR-52 共通フロー). */
  title: '結合結果の上位領域とプロパティを選択',
  /** Dialog hint under the title. */
  hint: '結合してできる地物の上位領域と、引き継ぐプロパティを選んでください。',

  /** 上位領域 (parent) section heading. */
  parentHeading: '上位領域',
  /** Parent = 親なし (最上位領域) radio label (the seeded default). */
  parentNone: '親なし（最上位領域）',
  /** Parent = 既存の面情報から選ぶ radio label. */
  parentExisting: '既存の上位領域から選ぶ',
  /** Parent = 新規上位領域を作成する radio label. */
  parentCreate: '新規上位領域を作成する',
  /** aria-label / placeholder for the existing-parent picker. */
  parentExistingPickLabel: '上位領域にする面情報',
  /** Placeholder shown when there are no eligible existing parents. */
  parentExistingEmpty: '選べる既存上位領域がありません',
  /** Label for the new-parent name input. */
  parentCreateNameLabel: '新規上位領域の名称',

  /** プロパティ (property) section heading. */
  propertyHeading: 'プロパティ',
  /** Property = 結合対象から引き継ぐ radio label (the seeded default). */
  propertyInherit: '結合対象のプロパティを引き継ぐ',
  /** Property = 新規入力する radio label. */
  propertyNew: '新規にプロパティを入力する',
  /** aria-label for the inherit-source picker. */
  propertyInheritPickLabel: '引き継ぎ元の地物',
  /** Label for the new-property name input. */
  propertyNewNameLabel: '新規地物の名称',

  /** Confirm (apply the chosen decisions + run the merge) button label. */
  confirm: '結合を実行',
  /** Cancel (back to selecting) button label. */
  cancel: 'キャンセル',
} as const;

export type MergeOptionsStringKey = keyof typeof MERGE_OPTIONS_STRINGS;
