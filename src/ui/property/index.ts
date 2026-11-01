// Property-panel UI — public barrel.
//
// U31 owns the "地物を削除" button + confirmation dialog (FR-85). U32 owns the
// property panel itself (FR-83 / FR-97), the anchor list + 時間バー切替 (FR-84 /
// FR-60), the draggable・複数同時 modal detail panels (FR-99), and the
// markdown-it + DOMPurify detail-document renderer (FR-98). Both share this
// directory; this barrel re-exports both units' public surface.

// --- U31: delete control (FR-85) -------------------------------------------
export {
  DELETE_BUTTON_LABEL,
  type DeleteFeatureButtonProps,
  DeleteFeatureButton,
} from './DeleteFeatureButton';

// --- U32: property panel + anchor views + detail panels + markdown ---------

// Components
export { PropertyPanel, type PropertyPanelProps } from './PropertyPanel';
// 増分 4: 素性欄の名前欄へ焦点を入れる要求の口（束の第 1 手。設計書 §C.5）。
export { NameFieldFocusStore, type NameFieldFocusListener } from './name-focus';
export { PropertyDraftStatusStore, type DraftStatusListener } from './draft-status';
export { BasicInfoForm, type BasicInfoFormProps } from './BasicInfoForm';
export {
  AnchorSection,
  type AnchorSectionProps,
} from './AnchorSection';
export { AnchorList, type AnchorListProps } from './AnchorList';
export { DetailPanel, type DetailPanelProps } from './DetailPanel';
export {
  DetailDocumentSection,
  type DetailDocumentSectionProps,
} from './DetailDocumentSection';
export {
  DetailPanels,
  type DetailPanelsProps,
  type DetailPanelsController,
  closeDetailPanel,
} from './DetailPanels';
export { MarkdownView, type MarkdownViewProps } from './MarkdownView';

// Contracts (the ports U32 consumes)
export type {
  FeatureLookup,
  AnchorSeriesLookup,
  AssetResolver,
  EditDispatch,
  PropertyEditIntent,
  PropertyEditValues,
  AnchorIntervalEditDispatch,
  AnchorIntervalEditIntent,
  AnchorIntervalOp,
  GoverningAnchorSeries,
} from './contracts';
export { ANCHOR_INTERVAL_OP } from './contracts';

// Pure logic: 詳細文書 edit plan — WRITE guard / no-op / canonical empty (FR-98)
export {
  DETAIL_DOCUMENT_PLAN,
  type DetailDocumentPlan,
  type DetailDocumentPlanKind,
  planDetailDocumentEdit,
} from './detail-document';

// Pure logic: selection-display judgment (FR-83, 教訓 5.10 / 5.29)
export {
  DISPLAY_KIND,
  type DisplayKind,
  type DisplayDecision,
  type RawSelectionInput,
  decideDisplay,
  targetFeatureIdOf,
} from './selection-display';

// Pure logic: object-reference link classification (FR-98, 教訓 5.19)
export {
  OBJECT_LINK_SCHEME,
  LINK_KIND,
  type LinkKind,
  type ClassifiedLink,
  classifyLink,
  objectLinkHref,
} from './object-link';

// Pure logic: markdown render + sanitize (FR-98 / FR-116)
export {
  renderDetailMarkdown,
  type RenderOptions,
  BROKEN_IMAGE_SRC,
} from './markdown';

// Pure logic: 時間バー mapping (FR-60)
export {
  type TimeBarView,
  MIN_VIEW_DAYS,
  ZOOM_STEP,
  viewFromTimePoints,
  viewSpanDays,
  timeToPixel,
  normalizedToPixel,
  pixelToTime,
  viewMinTime,
  viewMaxTime,
  zoomView,
} from '../time/timebar';

// Pure logic: open-detail-panels model (FR-99後段)
export {
  type DetailPanelEntry,
  type DetailPanelsState,
  EMPTY_DETAIL_PANELS,
  DETAIL_PANEL_CASCADE_PX,
  panelIdFor,
  openPanel,
  closePanel,
  isPanelOpen,
} from './detail-panels';

// Pure logic: edit-intent + no-op guard (FR-97 / FR-84, 教訓 5.24 / 5.15)
export {
  valuesFromFeature,
  isNoOpEdit,
  buildEditIntent,
  propertyValuesEqual,
} from './edit-intent';

// Pure logic: 保存の行き先 4 状態（設計書 §D.3 / 増分 2 の中身 2）
export {
  EDIT_PLAN_KIND,
  EDIT_PLAN_STRINGS,
  BYTES_PER_SNAPSHOT_VERTEX,
  BYTES_PER_SNAPSHOT_FEATURE,
  type EditPlan,
  type EditPlanKind,
  type EditPlanInput,
  type AnchorSnapshotSize,
  decideEditPlan,
  estimateAnchorBytes,
  formatApproximateBytes,
  isYearAligned,
  hasAnchorStartingAt,
} from './edit-plan';

// Pure logic: 錨どうしの差分（錨表の文 / まとめ役の子の選り分け、増分 2 の中身 4・5）
export {
  ANCHOR_CHANGE,
  ANCHOR_DIFF_STRINGS,
  type AnchorChange,
  type AnchorChangeKind,
  featureInSnapshot,
  shapeChanged,
  changesBetween,
  changeSentence,
  diffSentence,
  isRelevantAnchor,
  anchorYearLabel,
} from './anchor-diff';

// Pure logic: 存続期間編集 intent assembly + rejection messaging (HB3-12, 教訓 5.26)
export {
  buildChangeStartIntent,
  buildSetEndIntent,
  buildEndHereIntent,
  buildDeleteAnchorIntent,
  intervalRejectionMessage,
} from './interval-edit';

// Strings + 種別の日本語表示ラベル (表示層の単一写像, 要件定義書 §4)
export {
  PROPERTY_STRINGS,
  featureKindJaLabel,
  detailDocumentTooLongMessage,
} from './messages';

// 増分 7: 削除の影響を文にする純関数（設計書 §A.3 / 中身 6）。
export {
  type DeleteImpactView,
  buildDeleteImpactView,
  summarizeNames,
} from './delete-impact';
// 決定 (2): まとめ役を終わらせる前の影響の文。
export { type EndHereImpactView, buildEndHereImpactView } from './end-here-impact';
// 項目 6: 錨を消す前の板の中身（錨表と時刻レールの右クリックで共有）と、開始年の欄を開く口。
export { anchorDeleteImpactView } from './AnchorList';
export { AnchorStartEditStore } from './anchor-start-edit';
