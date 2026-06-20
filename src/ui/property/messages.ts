// UI layer (U32 / property panel): Japanese UI strings (NFR 5.7 日本語 UI).
//
// All user-facing text for the property panel lives here in ONE place so the
// selection-display mapping (selection-display.ts) and the components reference
// the same constants — a case's message and its display condition stay
// one-to-one (受け入れ基準 1, 教訓 5.29). Stringly-duplicated copies would let a
// branch drift; the single table prevents it.

export const PROPERTY_STRINGS = {
  // -- selection-display cases (FR-83) ---------------------------------------
  /** 空選択: nothing is selected. */
  emptySelection: '地物が選択されていません。',
  /** 複数検出: vertex selection spans multiple features. */
  multipleFeatures: '複数の地物が選択されています。1件ずつ選択して編集してください。',
  /** 所有者不明: the selected vertices' owner cannot be resolved. */
  unknownOwner: '選択頂点の所有地物を特定できません。',
  /** 表示対象地物が解決できたがデータに存在しない (stale reference). */
  featureMissing: '選択された地物が見つかりません。',

  // -- basic info form (FR-97) -----------------------------------------------
  basicInfoTitle: '基本情報',
  nameLabel: '名前',
  startYearLabel: '開始年',
  endYearLabel: '終了年',
  colorSectionTitle: '色情報',
  autoColorLabel: '自動配色を許可',
  fillColorLabel: '塗り色',
  selectedColorLabel: '選択時色',
  borderColorLabel: '境界色',
  saveButton: '保存',
  viewOnlyNotice: '表示モードです。編集するには編集モードに切り替えてください。',

  // -- anchor list / time bar (FR-84 / FR-60) --------------------------------
  anchorSectionTitle: '歴史の錨',
  anchorListEmpty: 'この地物には歴史の錨がありません。',
  viewModeList: 'リスト表示',
  viewModeTimeBar: '時間バー表示',
  openEndLabel: '継続中',
  editTargetBadge: '編集対象',

  // -- detail panel (FR-99 / FR-98) ------------------------------------------
  openDetailButton: '詳細表示',
  detailPanelTitlePrefix: '詳細: ',
  detailDocumentTitle: '詳細文書',
  detailAttributesTitle: '属性',
  brokenImageAlt: '画像を表示できません',

  // -- decision messages (教訓 5.12) -----------------------------------------
  dismissMessage: '閉じる',
  saveFailedPrefix: '保存に失敗しました: ',
  /**
   * Shown when a property edit is confirmed but no live edit-apply binding is
   * wired yet (the U13/属性編集 apply seam is unassigned new-domain work). The
   * save surfaces this honest error rather than reporting a silent success, so
   * the user is never told an edit landed when it did not (HB-3 Codex P1).
   */
  editNotWired: '属性編集の保存はこのビルドでは未対応です。',
} as const;
