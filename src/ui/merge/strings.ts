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
  /** Clear-selection button label。「クリア」は §H.1 に無い語（増分 5 の手直し E2）。 */
  clear: '選択を外す',
  /**
   * Cancel button label。確定欄（176px）の語は **5 道具とも「やめる」**に揃える
   * （増分 5 の手直し E2。`ui/add/strings.ts` の `ADD_STRINGS.cancel` が先例）。
   */
  cancel: 'やめる',
  /**
   * 対象欄（240px）の頭に出す段階表示（設計書 §C.4 / バグ狩り #9）。**「手順」の 2 文字を
   * 必ず前に付ける** ―― 「1/2」だけだと「2 件中 1 件」と読み違えられる（§O の B-23）。
   * 結ぶ道具は対象が **複数**なので、この誤読はとくに起こりやすい（対象欄の名前のほうも
   * 「ほか n 件」と件数を出している）。
   *
   * 段は {@link MERGE_STEP_COUNT} 個（1 = 結ぶ地物を 2 つ以上選ぶ / 2 = まとめ方を選ぶ）。
   */
  stage: (step: number): string => `手順 ${String(step)}/${String(MERGE_STEP_COUNT)}`,
} as const;

/** 結ぶ道具の段数（設計書 §C.4 の「手順 n/m」の m）。1 = 地物を選ぶ / 2 = まとめ方を選ぶ。 */
export const MERGE_STEP_COUNT = 2;

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
  /**
   * まとめ方の板の取消（増分 5 の手直し E1）。**「やめる」ではない** ―― この板の取消は
   * 「結ぶのをやめる」ではなく **選んだ地物を保ったまま選び直しへ戻る**ことなので、
   * 確定欄の［やめる］（作業ごとやめる）と同じ語にすると意味が食い違う。
   * §H.1 に無い「キャンセル」というカタカナは使わない。
   */
  cancel: '選び直す',
} as const;

export type MergeOptionsStringKey = keyof typeof MERGE_OPTIONS_STRINGS;
