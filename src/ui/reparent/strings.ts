// U28 — 所属変更 (reparent / affiliation-change) UI strings (FR-46〜FR-49 / FR-92).
//
// All user-facing strings for the reparent controller live here so the UI layer never
// embeds bare literals in JSX (教訓 5.19) and the copy is a single source.

export const REPARENT_STRINGS = {
  /** Guide before a target is chosen (the first click). */
  guidePickTarget: '所属を変更する地物をクリックで選択してください。',
  /** Guide once a target is chosen (pick the new上位領域). */
  guidePickParent: '新しい上位領域とする地物をクリックで選択してください。',
  /** Confirm button label. */
  confirm: '所属変更を確定',
  /** Confirm-detach (最上位化 / make-top-level, parentNone) button label (FR-46 独立). */
  confirmNone: '最上位へ (所属を外す)',
  /** Clear-selection button label. */
  clear: '選択をクリア',
  /** Cancel button label. */
  cancel: 'キャンセル',
} as const;

export type ReparentStringKey = keyof typeof REPARENT_STRINGS;
