// U30 — merge-tool (合体 / 結合) UI strings (FR-50 / FR-52 / FR-92).
//
// All user-facing strings for the merge controller live here so the UI layer never
// embeds bare literals in JSX (教訓 5.19) and the copy is a single source.

export const MERGE_STRINGS = {
  /** Guide while collecting targets (fewer than 2 chosen). */
  guideSelect: '結合する地物を 2 つ以上クリックで選択してください。',
  /** Guide once 2+ targets are chosen (confirm is enabled). */
  guideReady: '「結合を確定」で選択した地物を 1 つに結合します。',
  /** Confirm button label. */
  confirm: '結合を確定',
  /** Clear-selection button label. */
  clear: '選択をクリア',
  /** Cancel button label. */
  cancel: 'キャンセル',
} as const;

export type MergeStringKey = keyof typeof MERGE_STRINGS;
